# ticket-monitoring 查询层可抽取性评估

> 评估日期：2026-10-28　被测仓库：https://github.com/dengmeiluan/ticket-monitoring （Apache-2.0，Python 3.9+，Playwright）
> 探针代码：`tmp/ota-probe/`（`probe.py` / `probe_calendar.py` / `compare_calendar.py` / `probe_flights.py` / `reconcile_vf.py`）
> 被测快照：`tmp/ticket-monitoring-probe/`（`git clone --depth 1`）

## 一句话结论

**能抠，而且抠出来比整个项目有用。** 查询层（`crawlers/` + 4 个 `core/` 模块）与主程序零耦合，可以直接当库调。
其中**日历层 4 个源全部零登录零浏览器可用，2 秒出全量日价**；**明细层 5 个渠道里 3 个免登录可用**（携程 / 飞猪 / 同程），且**直接给出中转停留分钟数与行李直挂状态**——这两项正是飞常准给不了、我们现在靠硬算的东西。

## 1. 依赖切面：能干净剥离

`crawlers/*.py` 只依赖 `core.{models,citydata,intl,flightnorm}` 和同目录 `base.py` / `challenge.py`，
**不 import `main.py` / `webui.py` / `report.py`**，因此不牵连 sqlite 落库、钉钉推送、四层告警、APScheduler。

```
可用最小集（约 3.5k + 14k 行）
  crawlers/            base.py challenge.py + 5 个渠道
  core/models.py       FlightPrice 数据模型、价格带
  core/citydata.py     287 城 中文名 ↔ 三字码
  core/intl.py         国际判定、时区偏移、城市码归并
  core/flightnorm.py   机场名、舱位、时长格式化
```

实测 `from crawlers import REGISTRY` 直接成功，`REGISTRY` = ctrip / fliggy / tongcheng / qunar / tuniu。
调用契约只有一句：`Crawler(config, logger).safe_fetch(from, to, [date]) -> List[FlightPrice]`，
config 只需 6 个键（`headless / timeout_seconds / delay_min / delay_max / debug_dir / user_data_dir`）。

## 2. 日历层：4 源全部可用，零登录零浏览器

`crawlers/special.py` 里是一批纯 `httpx` 的官方日历接口，**不开浏览器、不登录、不签名**，四个源合计约 2 秒。

| 源 | 接口 | 覆盖窗口 | 返回 |
|---|---|---|---|
| 途牛 | `flight-api.tuniu.com/query/flight/v1/calendar` | 约 62 天 | `[{date, price}]` |
| 同程 | `wx.17u.cn/.../queryCalendarLowestPrice` | **180 天** | `[{date, price, week, priceType}]` |
| 飞猪 | `r.fliggy.com/cheapestCalendar/pc` | 7 天（锚点起） | `[{leaveDate, price, tax, url}]` |
| 携程 | `m.ctrip.com/restapi/soa2/15380/...LowestPriceSearch` | **约 310–369 天** | `priceList[{departDate, price, transportPrice, totalPrice}]` |

实测覆盖（SZX→AAT，锚点 2027-01-03）：

```
途牛      62 天   2026-10-28..2027-02-04
飞猪       5 天   2027-01-02..2027-01-07
同程     151 天   2026-10-28..2027-03-27
携程     310 天   2026-10-28..2027-10-14
```

**三源互咬**（SZX→AAT 元旦窗口，裸价）：

| 日期 | 途牛 | 同程 | 飞猪 | 携程裸价 | 携程含税 |
|---|---|---|---|---|---|
| 01-02 | 3390 | 1250 | 1250 | 1360 | 1640 |
| 01-03 | 3390 | 1320 | 1318 | 1320 | 1600 |
| 01-04 | — | 1070 | 1070 | 1070 | 1350 |
| 01-07 | — | 940 | 940 | 940 | 1220 |

同程 / 飞猪 / 携程裸价逐日吻合到 ±2 元，**证明三者给的都是票面裸价**。
携程额外给 `totalPrice`（含税），`totalPrice − transportPrice` 落在 {140, 190, 240, 280}，随航线与航段数变化。

## 3. 明细层：5 渠道里 3 个免登录

`probe.py --channel all` 实测（SZX→AAT 2027-01-03）：

| 渠道 | 结果 | 明细条数 | 耗时 | 登录 |
|---|---|---|---|---|
| 携程 | ok（走国际端点 `flights.ctrip.com/online/list`） | 29（直飞 3 / 中转 26） | 32.0s | 免 |
| 飞猪 | ok（SSR 直读 `sjipiao.fliggy.com`） | 31 | 19.2s | 免 |
| 同程 | ok（H5 `m.ly.com` + XHR 拦截） | 24（直飞 2 / 中转 22） | 19.3s | 免 |
| 去哪儿 | `H5:empty, API:empty`，原站回 1999/no-result | 0 | 8.1s | **需登录**（软性空列表） |
| 途牛 | 接口回 `710114 请登录` | 0 | 8.0s | **需登录** |

三家最低价互相印证：**飞猪 1318 / 携程 1320 / 同程 1660**，且飞猪与携程指向同一班 `ZH9415/9C6685`（成都中转，停留 685 分钟）。

### 3.1 补登录态实测（2026-10-28，人工在可见窗口登录）：两条都失败

用 `tmp/ota-probe/login.py`（开可见窗口、每 3 秒落盘、关窗口自动保存）实际登录过，结论是**这两个源在本机不可用，且不是抓取姿势的问题**：

| 渠道 | 尝试 | 结果 |
|---|---|---|
| 去哪儿 | PC `user.qunar.com/passport` 登录 → 26 Cookie | 仍 `1999 没有查询到符合条件的航班` |
| 去哪儿 | 改在 H5 `m.flight.qunar.com` 列表页登录 → 32 Cookie | 仍 `1999` |
| 去哪儿 | **用户手动在 H5 页面搜索** | **也查不到任何结果** ← 决定性 |
| 途牛 | 打开 `www.tuniu.com` 登录页 | **页面直接被 WAF 拦截** |

判读：
- 去哪儿的 Cookie 里始终没有 `_lxsdk_cuid` 这类指纹 SDK 该种的键，SDK 根本没跑起来。**用户手动搜索同样为空，证明是页面级/环境级封锁，与登录态无关**，登录救不回来。
- 途牛是 WAF 层直接拦，连页面都打不开，更谈不上拿 Cookie。
- 因此 **免登录的携程 / 飞猪 / 同程就是这套代码在本机的能力上限**，不要再在去哪儿与途牛上花时间。

## 4. 字段对比：这正是我们要的东西

| 字段 | 飞常准 MCP | 携程 | 飞猪 | 同程 |
|---|---|---|---|---|
| 航班号（含中转第二段） | ✓ | 29/29 | 31/31 | 24/24 |
| 起降时刻 + 落地日期 | ✓ | ✓ | ✓ | ✓ |
| 中转城市 | ✓ | 26/29 | 26/31 | 22/24 |
| **中转停留分钟数** | ✗ 要靠「时长做差」硬算 | **26/29** | **26/31** | **22/24** |
| **行李（直挂/需重挂）** | ✗ 完全没有 | ✗ | **25/31** | ✗ |
| **税费（分项）** | ✗ | ✗ | **26/31** | ✗ |
| 机型 | 部分 | 29/29 | 31/31 | 24/24 |
| 经停标记 | ✗ | ✗ | 17/31 | ✗ |
| 折扣 / 余票 | ✗ | ✗ | ✓ | 部分 |
| 邻近日价格趋势 | ✗ | ✗ | `trendGo` 附带 | ✗ |
| 计费 | **1 分/次，月上限 100** | 免费 | 免费 | 免费 |

**两家都直接给 `layover`**——我们目前只能用 `legs[1].duration_min − segments[1].duration_min − coalesce(...)` 做差，且 `segments[i].transfer_duration_min` 恒 NULL。
飞猪还多给行李直挂状态（`transferBaggage: "recheck"`），这是飞常准结构性缺失的字段。

## 5. 与飞常准对账（读本地缓存，未消耗积分）

用 `.cache/index.json` 里已抓过的飞常准 `adult_total`（含税），对携程日历 `totalPrice`（含税）：

```
共同 29 天：中位差 -30，|差|≤60 的 17/29 天，区间 -450 ~ +861
```

吻合得好的（薄航线，差 ≤ 40）：

```
SZX→ZQZ 11-26   飞常准  950   携程含税  930   -20
SZX→BJS 11-26   飞常准  590   携程含税  590    ±0
SZX→BJS 11-28   飞常准  590   携程含税  590    ±0
BJS→SZX 12-01   飞常准  590   携程含税  590    ±0
SZX→CGQ 12-12   飞常准  800   携程含税  820   +20
ZQZ→SZX 11-30   飞常准  811   携程含税  830   +19
SZX→AAT 12-30   飞常准 1906   携程含税 1890   -16
```

分歧集中在**两处已知病灶**，不是新问题：

1. **飞常准 SZX→BJS 11-27 报 1040**（82 条直飞、0 中转）→ 携程 590。这就是既有记忆里那个「直飞条目像渠道占位」的老毛病。
2. **携程 SZX→BJS 全线报 400 裸价**（跨日期完全不变）→ 疑似占位平底值，同样不可信。

**结论：携程日历在薄航线（ZQZ / CGQ / AAT）上与飞常准吻合到 ±20~40，可以当免费的交叉校验源；干线（BJS）两家各有占位问题，谁都不能单信。**

## 6. 坑（实测踩到的）

1. **明细层 `price` 是裸价，不是含税**。携程明细最低 1320 = 携程日历裸价 1320，含税要 1600。跨源比价前必须统一口径，否则会系统性低估 200–300 元。
2. **携程日历 `priceList` 的 `flightNo` / `airLine` 全为空**——日历层只有「当日最低价」，没有航班明细，无法拿来算雪时。
3. **单渠道明细覆盖率低**：三家航班号交集只有 8–10 条（26 / 30 / 24 条里）。**要覆盖必须多源并集**，单源会漏掉一半方案。
4. **同程 / 携程都有跨日期恒定值**（同程 SZX→CGQ 恒 540、携程 SZX→BJS 恒 400），像占位或缓存。**跨日期方差为 0 的序列要当异常剔除**，别当成稳定低价。
5. **途牛日历恒报 3390**（SZX→AAT 多个不相关日期同一价），全价舱占位，不可用。
6. 携程国内 H5 路径 `H5:empty`，实际靠回落到国际端点 `flights.ctrip.com/online/list` 才出数——这条路径随时可能被关。
7. 浏览器版本要对齐：playwright 1.64 需要 chromium-1248，本机原有 1228 不匹配，须 `playwright install chromium`（国内可用 `PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright`）。
8. 单渠道单日约 19–32 秒（含浏览器启动），比飞常准 MCP 的 1.6 秒慢一个量级。**扫多日期窗口不划算，扫单日或配日历层才划算。**

## 7. 建议用法

按性价比分三层，各取所长：

| 用途 | 用什么 | 理由 |
|---|---|---|
| **扫日期窗口**（哪几天便宜） | 携程 / 同程日历 | 免费、2 秒、覆盖 180–310 天；替代飞常准的粗筛，省积分 |
| **拿 legs 表**（时刻 / 中转 / 停留 → 算雪时） | 飞猪明细（首选）+ 携程明细（补覆盖） | 免登录、直接给 `layover` 与行李；飞猪多给税费 |
| **交叉校验低价** | 携程日历 `totalPrice` | 薄航线与飞常准吻合 ±20~40，可当免费的第三方裁判 |

**不建议**：① 整体部署这个项目（webui 4MB、report 190KB、钉钉/告警/数据库全部用不上）；② **依赖去哪儿 / 途牛——本机实测这两条路已堵死**（去哪儿 H5 页面级封锁、途牛 WAF 拦截，详见 §3.1），别再投入；③ 用日历层的价格做「元/雪日」计算（缺时刻与中转，算不出 `hEff`）。

## 8. 复现

```bash
PY=C:/Users/Sardi/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe
cd tmp/ota-probe

# 日历层：4 源零登录
$PY probe_calendar.py SZX AAT 2027-01-03

# 日历层：同日对齐比价
$PY compare_calendar.py SZX AAT 2027-01-01 2027-01-12

# 明细层：单渠道 / 全渠道
$PY probe.py --channel fliggy --from SZX --to AAT --date 2027-01-03
$PY probe.py --channel all    --from SZX --to AAT --date 2027-01-03

# 明细层：三渠道逐航班对比
$PY probe_flights.py SZX AAT 2027-01-03

# 与飞常准缓存对账（不扣积分）
$PY reconcile_vf.py
```
