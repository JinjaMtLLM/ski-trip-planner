#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""OTA 取数驱动 —— 把 third_party/ticket-monitoring 的爬虫接成「按航线取明细」的 CLI。

为什么要有这一层：第三方仓库是「按航线 + 日期区间轮询 + 落库 + 告警」的完整应用，
我们只要它里面那一小块「给定航线与日期，把航班明细抓回来」。所以这里只做三件事：

  1. 把 submodule 目录塞进 sys.path，`from crawlers import REGISTRY` 取渠道实例；
     **不 import main.py / webui.py / scheduler**，不读它的 config.yaml，不碰它的存储。
  2. 调 `crawler.safe_fetch(from, to, dates)`，把返回的 FlightPrice 里的
     `extra`（JSON 字符串）解析成明细行，归一成引擎能吃的形态。
  3. 按 (航线, 日期) 增量落盘 —— 单渠道单日 19–32s，中断了重跑要能跳过已完成的。

**不修改 submodule 的任何文件**：只 import、只调公开方法。

用法：
    python scripts/ota/fetch.py --from SZX --to AAT \\
        --dates 2027-02-05,2027-02-06 --channels fliggy,ctrip \\
        --out tmp/ota/out/SZX-AAT.json

    # 国际航线（自动识别，走携程 PC 国际列表），按批抓更快
    python scripts/ota/fetch.py --from HKG --to CTS \\
        --dates 2027-02-05 --out tmp/ota/out/HKG-CTS.json --batch 4

    # 只看看会抓什么，不开浏览器
    python scripts/ota/fetch.py --from SZX --to AAT --dates 2027-02-05 --dry

输出（键 = FROM|TO|DATE）：
    { "SZX|AAT|2027-02-05": { "fliggy": [ {no,dep,arr,arrDate,price,tax,via,stop,segs,ch} ] } }

归一字段（两种口径的差别就在 price/tax 的语义上，见下）：
    no      "ZH9415+9C6685"（中转多段用 + 连接）
    dep/arr "HH:MM"；arrDate 落地日期（跨天才有）
    segs    航段数（1 = 直飞/经停，2 = 一次中转，3 = 两次）
    via     中转城市中文名（直飞为空）
    stop    中转停留分钟（渠道直接给，比「时长做差」可靠）
    price   国内＝票面裸价；国际＝**已含税总价**
    tax     国内＝按 140×航段 估的税；国际＝携程给的 adultTax 分项（只作拆分用）
    fare    仅国际行有：票面（= price − tax）

国内三个渠道（fliggy / ctrip / tongcheng）给的是裸价，税按 TAX_PER_SEG 估；
携程国际列表给的是含税总价（adultPrice + adultTax），**绝不能再加一次税**。
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))          # 仓库根
DEFAULT_SUBMODULE = os.path.join(ROOT, "third_party", "ticket-monitoring")

TAX_PER_SEG = 140          # 机建 50 + 燃油 90，与仓库既有口径一致


# ---------------------------------------------------------------- submodule
def submodule_dir(cli_value: str = "") -> str:
    """定位第三方仓库。优先级：--submodule > 环境变量 > third_party/ 默认位置。"""
    cand = (cli_value
            or os.environ.get("SKI_TICKET_MONITORING", "")
            or DEFAULT_SUBMODULE)
    p = os.path.abspath(cand)
    if not os.path.isdir(os.path.join(p, "crawlers")):
        sys.exit("找不到第三方仓库（缺 crawlers/ 目录）：%s\n"
                 "先跑 git submodule update --init --recursive" % p)
    return p


def import_crawlers(sub: str):
    """把 submodule 挂上 sys.path 再 import。返回 (REGISTRY, is_intl_route)。

    只加路径、只 import，**不写它的目录**：
      · 关掉字节码落盘 —— 否则 Python 会在 submodule 里生成 __pycache__，
        `git status` 立刻变脏，「不改第三方仓库」就成了一句空话；
      · debug/user_data 一律落在我们自己的 tmp 下（见 make_cfg）。
    """
    sys.dont_write_bytecode = True
    if sub not in sys.path:
        sys.path.insert(0, sub)
    from crawlers import REGISTRY                       # noqa: E402
    from core.intl import is_intl_route                 # noqa: E402
    return REGISTRY, is_intl_route


def make_cfg(timeout: int, workdir: str) -> dict:
    """爬虫配置。headless + 限速与之前实测一致；user_data 放在我们自己的
    tmp 下而不是 submodule 里，登录态与缓存都不污染第三方仓库。"""
    return {
        "headless": True,
        "timeout_seconds": timeout,
        "delay_min": 1,
        "delay_max": 2,
        "debug": False,
        "debug_dir": os.path.join(workdir, "debug"),
        "user_data_dir": os.path.join(workdir, "user_data"),
    }


# ---------------------------------------------------------------- 归一
def _code_list(code: str) -> list:
    return [s.strip() for s in str(code).replace("/", "+").split("+") if s.strip()]


def norm_domestic(row: dict, ch: str) -> dict | None:
    """国内明细行 → 统一形态。price 是裸价，tax 优先用渠道给的整程税，
    缺失按 140 × 航段数估（实测与三源票面吻合 ±2 元）。"""
    code = str(row.get("code") or "").strip()
    dep = str(row.get("depTime") or "").strip()
    arr = str(row.get("arrTime") or "").strip()
    try:
        price = float(row.get("price") or 0)
    except (TypeError, ValueError):
        return None
    if not (code and dep and arr) or price <= 0:
        return None

    nos = _code_list(code)
    via = str(row.get("transCity") or "").strip()
    segs = 2 if (via and len(nos) >= 2) else 1

    try:
        tax = float(row.get("transferTax") or 0)
    except (TypeError, ValueError):
        tax = 0.0
    if tax <= 0:
        tax = TAX_PER_SEG * segs

    out = {"no": "+".join(nos), "dep": dep, "arr": arr,
           "price": price, "tax": tax, "via": via,
           "stop": int(row.get("layover") or 0), "segs": segs, "ch": ch}
    ad = str(row.get("arrDate") or "").strip()
    if ad:
        out["arrDate"] = ad
    if row.get("transferBaggage"):
        out["bag"] = row["transferBaggage"]
    if row.get("plane"):
        out["plane"] = row["plane"]
    if row.get("stopover"):
        out["stopover"] = True
    return out


def norm_intl(row: dict, ch: str) -> dict | None:
    """国际明细行 → 统一形态。携程的 price 已经是含税总价（ctrip.py:555
    adultPrice + adultTax），所以 price 直接当总价，tax 只留作分项拆分。"""
    code = str(row.get("code") or "").strip()
    dep = str(row.get("depTime") or "").strip()
    arr = str(row.get("arrTime") or "").strip()
    try:
        total = float(row.get("price") or 0)
    except (TypeError, ValueError):
        return None
    if not (code and dep and arr) or total <= 0:
        return None

    nos = _code_list(code)
    via = str(row.get("transCity") or "").strip()
    # 航段数以航班号个数为准：A/B/C 是两次中转。只按「有中转城市 → 2 段」
    # 会把两次中转错记成一次，停留时长随之算错。
    segs = max(2, len(nos)) if via else 1

    try:
        tax = float(row.get("tax") or 0)
    except (TypeError, ValueError):
        tax = 0.0
    if tax <= 0 or tax > total:          # 脏值：宁可不拆，也不让总价失真
        tax = 0.0

    out = {"no": "+".join(nos), "dep": dep, "arr": arr,
           "price": total, "fare": round(total - tax, 2),
           "tax": round(tax, 2), "via": via,
           "stop": int(row.get("layover") or 0), "segs": segs, "ch": ch}
    ad = str(row.get("arrDate") or "").strip()
    if ad:
        out["arrDate"] = ad
    for src, dst in (("baggage", "bag"), ("plane", "plane"), ("cabin", "cabin")):
        if row.get(src):
            out[dst] = row[src]
    if row.get("depTerminal") or row.get("arrTerminal"):
        out["terminal"] = ("%s-%s" % (row.get("depTerminal") or "",
                                      row.get("arrTerminal") or "")).strip("-")
    return out


def rows_of(flights, norm) -> dict:
    """[FlightPrice] → {日期: [归一明细]}。明细藏在 FlightPrice.extra 里（JSON 串）。

    `norm` 是已绑好渠道名的单参函数（每个渠道的 price/tax 语义不同）。
    """
    by_date = {}
    for fp in flights or []:
        d = str(getattr(fp, "depart_date", "") or "")[:10]
        try:
            detail = json.loads(getattr(fp, "extra", None) or "[]")
        except (TypeError, ValueError):
            detail = []
        got = [g for g in (norm(r) for r in detail) if g]
        # 同一日期可能来多条 FlightPrice（不同航司批次），累加而不是覆盖
        by_date.setdefault(d, []).extend(got)
    return by_date


def pick_date(by_date: dict, date: str) -> list:
    """取某天的明细。渠道偶尔不回 depart_date，只有一组结果时就直接认它——
    否则明明抓到 160 条却因为键是空串被记成「空日期」。"""
    if date in by_date:
        return by_date[date]
    if len(by_date) == 1:
        return next(iter(by_date.values()))
    return []


# ---------------------------------------------------------------- 抓取
def fetch_domestic(REGISTRY, cfg, log, fc, tc, dates, channels, store, out):
    """逐 (日期, 渠道) 抓。单条 19–32s，每完成一条立刻落盘。"""
    done = skipped = 0
    for date in dates:
        slot = store.setdefault("%s|%s|%s" % (fc, tc, date), {})
        for ch in channels:
            if slot.get(ch) is not None:
                skipped += 1
                continue
            t0 = time.time()
            try:
                c = REGISTRY[ch](cfg, log)
                got = pick_date(rows_of(c.safe_fetch(fc, tc, [date]),
                                        lambda r: norm_domestic(r, ch)), date)
            except Exception as e:                       # 渠道挂了不该拖垮整批
                log.warning("[%s] %s %s→%s 失败 %s: %s", ch, date, fc, tc,
                            type(e).__name__, e)
                got = []
            slot[ch] = got
            done += 1
            log.info("%s→%s %s [%s] %d 条 / %.0fs", fc, tc, date, ch, len(got),
                     time.time() - t0)
            _save(store, out)
    return done, skipped


def fetch_intl(REGISTRY, cfg, log, fc, tc, dates, channels, store, out, batch):
    """国际航线：一个渠道一次开浏览器，内部按日开 page，按批调用比逐日新建快得多。"""
    done = skipped = 0
    for ch in channels:
        todo = [d for d in dates if store.get("%s|%s|%s" % (fc, tc, d), {}).get(ch) is None]
        skipped += len(dates) - len(todo)
        if not todo:
            continue
        log.info("%s→%s [%s] 待抓 %d/%d 天", fc, tc, ch, len(todo), len(dates))
        for i in range(0, len(todo), max(1, batch)):
            grp = todo[i:i + max(1, batch)]
            t0 = time.time()
            try:
                c = REGISTRY[ch](cfg, log)
                got = rows_of(c.safe_fetch(fc, tc, grp), lambda r: norm_intl(r, ch))
            except Exception as e:
                log.warning("[%s] 批次 %s 失败 %s: %s", ch, ",".join(grp),
                            type(e).__name__, e)
                got = {}
            for d in grp:
                rows = pick_date(got, d)
                store.setdefault("%s|%s|%s" % (fc, tc, d), {})[ch] = rows
                done += 1
                log.info("  %s→%s %s [%s] %d 条", fc, tc, d, ch, len(rows))
            _save(store, out)
            log.info("批次 %s 用时 %.0fs", ",".join(grp), time.time() - t0)
    return done, skipped


def _save(store: dict, out: str):
    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
    tmp = out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(store, f, ensure_ascii=False, indent=0)
    os.replace(tmp, out)             # 原子替换：中途被杀也不会留下半个文件


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="OTA 机票明细取数（接 third_party/ticket-monitoring）")
    ap.add_argument("--from", dest="fc", required=True)
    ap.add_argument("--to", dest="tc", required=True)
    ap.add_argument("--dates", required=True, help="逗号分隔 YYYY-MM-DD")
    ap.add_argument("--out", default="", help="输出 JSON（键 = FROM|TO|DATE），默认 tmp/ota/out/FROM-TO.json")
    ap.add_argument("--channels", default="", help="默认国内 fliggy,ctrip / 国际 ctrip")
    ap.add_argument("--mode", default="auto", choices=["auto", "domestic", "intl"])
    ap.add_argument("--batch", type=int, default=4, help="国际按批调用，每批几个日期")
    ap.add_argument("--timeout", type=int, default=45)
    ap.add_argument("--submodule", default="")
    ap.add_argument("--workdir", default="", help="debug/user_data 落盘目录（默认 tmp/ota）")
    ap.add_argument("--dry", action="store_true", help="只打印计划，不开浏览器")
    ap.add_argument("--json", action="store_true", help="最后一行输出机器可读摘要")
    args = ap.parse_args()

    log = logging.getLogger("ota")
    log.setLevel(logging.INFO)
    h = logging.StreamHandler(sys.stderr)
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%H:%M:%S"))
    log.addHandler(h)
    logging.getLogger("httpx").setLevel(logging.WARNING)

    sub = submodule_dir(args.submodule)
    REGISTRY, is_intl_route = import_crawlers(sub)

    fc, tc = args.fc.upper(), args.tc.upper()
    dates = [d.strip() for d in args.dates.split(",") if d.strip()]
    if not dates:
        sys.exit("--dates 为空")

    intl = (args.mode == "intl") or (args.mode == "auto" and is_intl_route(fc, tc))
    channels = [c.strip() for c in (args.channels or ("ctrip" if intl else "fliggy,ctrip")).split(",") if c.strip()]
    for ch in channels:
        if ch not in REGISTRY:
            sys.exit("未知渠道 %s（可选：%s）" % (ch, ", ".join(sorted(REGISTRY))))

    workdir = os.path.abspath(args.workdir or os.path.join(ROOT, "tmp", "ota"))
    cfg = make_cfg(args.timeout, workdir)
    out = os.path.abspath(args.out or os.path.join(workdir, "out", "%s-%s.json" % (fc, tc)))

    log.info("%s→%s %d 天 [%s] %s，submodule=%s", fc, tc, len(dates),
             "国际" if intl else "国内", ",".join(channels), sub)
    if args.dry:
        for d in dates:
            log.info("  计划抓取 %s %s→%s [%s]", d, fc, tc, ",".join(channels))
        print(json.dumps({"ok": True, "dry": True, "route": "%s-%s" % (fc, tc),
                          "mode": "intl" if intl else "domestic", "dates": dates,
                          "channels": channels}, ensure_ascii=False))
        return 0

    store = {}
    if os.path.isfile(out):
        try:
            with open(out, encoding="utf-8") as f:
                store = json.load(f)
        except (ValueError, OSError):
            store = {}
    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)

    t_all = time.time()
    if intl:
        done, skipped = fetch_intl(REGISTRY, cfg, log, fc, tc, dates, channels, store, out, args.batch)
    else:
        done, skipped = fetch_domestic(REGISTRY, cfg, log, fc, tc, dates, channels, store, out)

    per_date = {}
    for d in dates:
        slot = store.get("%s|%s|%s" % (fc, tc, d), {})
        per_date[d] = sum(len(v or []) for v in slot.values())
    total = sum(per_date.values())
    empty = [d for d, n in per_date.items() if not n]

    summary = {"ok": True, "route": "%s-%s" % (fc, tc),
               "mode": "intl" if intl else "domestic", "channels": channels,
               "done": done, "skipped": skipped, "rows": total,
               "perDate": per_date, "emptyDates": empty,
               "minutes": round((time.time() - t_all) / 60, 1), "out": out}
    if args.json:
        print(json.dumps(summary, ensure_ascii=False))
    else:
        print("\n%s→%s 合计 %d 条明细，用时 %.1f 分钟"
              % (fc, tc, total, summary["minutes"]))
        if empty:
            print("空日期（%d）：%s" % (len(empty), ",".join(sorted(empty))))
        print("输出 %s" % out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
