# -*- coding: utf-8 -*-
"""按新住宿单价重建交付页的「对比」面板（pane-cmp）。

所有数字都从 tmp/rerun/<slug>/top.json + itineraries.csv 里读，不手写。
静态事实（机场/车程、长白山五个住宿选项、将军山去程四种走法）原样沿用旧面板。
"""
import json, math, os, re, csv

ROOT = r"D:/Project/other/ski-trip-planner"
PAGE = os.path.join(ROOT, "dist/七雪场对比-2027元旦.html")
RUN = os.path.join(ROOT, "tmp/rerun")
BUCKETS = ["0", "0.5", "1", "1.5", "2", "2.5", "3", "3.5", "4"]

# slug, 显示名, 图例短名, 颜色, 卡片副标题, 住宿单价, 依据
RES = [
    ("ny-wl",   "万龙",         "万龙",   "#c2410c", "张家口 / 北京 · 高铁",   283.5, "盛龙公寓（万龙店）¥567/间 ÷ 2"),
    ("ny-shl",  "松花湖",       "松花湖", "#1d6fa5", "长春龙嘉 · 108km",       200.0, "指定价；青山公寓实查 ¥569/间（¥284.5/人）"),
    ("ny-bdh",  "北大湖",       "北大湖", "#0f8a7a", "长春龙嘉 · 139km",       449.0, "盈辉酒店（J 索缆车站店）¥898/间 ÷ 2"),
    ("ny-cbs",  "长白山万达",   "长白山", "#7c3aed", "长白山 / 延吉 · 中转",   184.5, "松果里度假俱乐部 ¥369/间 ÷ 2"),
    ("ny-hemu", "禾木吉克普林", "禾木",   "#be185d", "新疆 · 租车 / 硬卧",     197.0, "云住山居（落日观景台店）¥394/间 ÷ 2"),
    ("jjs",     "将军山",       "将军山", "#b45309", "阿勒泰市区 · 机场 15km", 300.0, "指定价；山水商旅 ¥110/间、泰熙金陵 ¥576/间"),
    ("shiga",   "志贺高原",     "志贺",   "#4d7c0f", "香港出发 · 日本长野",    218.0, "高地酒店 ¥436/间 ÷ 2"),
]


# ---------------------------------------------------------------- 读数
def fmt(v):
    v = float(v)
    return "{:,}".format(int(round(v))) if abs(v - round(v)) < 1e-6 else "{:,.1f}".format(v)


def r0(v):
    return "{:,}".format(int(round(float(v))))


def md(a):
    d = (int(a) // 1440) * 86400000
    import datetime
    x = datetime.datetime(1970, 1, 1) + datetime.timedelta(milliseconds=d)
    return "%d/%d" % (x.month, x.day)


def hm(a):
    m = int(a) % 1440
    return "%02d:%02d" % (m // 60, m % 60)


def wd(a):
    import datetime
    d = (int(a) // 1440) * 86400000
    x = datetime.datetime(1970, 1, 1) + datetime.timedelta(milliseconds=d)
    return "周" + "一二三四五六日"[x.weekday()]


def abs_min(s):
    import datetime
    d = datetime.datetime.strptime(s, "%Y-%m-%d %H:%M")
    return int((d - datetime.datetime(1970, 1, 1)).total_seconds() // 60)


DATA = {}
for slug, name, short, color, tag, lodge, basis in RES:
    d = os.path.join(RUN, slug)
    top = json.load(open(os.path.join(d, "top.json"), encoding="utf-8"))
    DATA[slug] = {"top": top["top"], "counts": top.get("counts"),
                  "sess": top.get("sessionHours"), "lodge": lodge}
    miss = [b for b in BUCKETS if b not in top["top"]]
    if miss:
        print("  %-8s 缺档 %s" % (slug, miss))

# 日场阈值：七个算例写的是同一个值，取第一个；没写就按 graphcore 默认 2.5
MINDAY = json.load(open(os.path.join(RUN, "ny-wl", "case.json"), encoding="utf-8"))["params"]["resort"].get("minDayH", 2.5)

OLD = open(os.path.join(ROOT, "tmp/cmp_pane.html"), encoding="utf-8", newline="").read()


def cut(start, end):
    i = OLD.index(start)
    j = OLD.index(end, i)
    return OLD[i:j]


STATIC_CBS = cut('<h3 class="sub3">长白山如果不住雪场里', '<h2>将军山（阿勒泰')
STATIC_ROUTE = cut('<div style="font-size:15.5px;font-weight:600;margin:28px 0 10px">将军山 · 去程四种走法', '<h2>七份雪场报告')
STATIC_REPORTS = cut('<h2>七份雪场报告</h2>', '</div><!-- /pane-cmp -->')

H = []
A = H.append

# ---------------------------------------------------------------- 抬头
A('<div id="pane-cmp" class="pane show">\n')
A('<h1>2027 元旦 · 深圳出发 · 万龙 / 松花湖 / 北大湖 / 长白山 / 禾木 / 将军山 ／ 香港 · 志贺高原</h1>\n')
A('<div class="chips">\n')
A('  <span class="chip">窗口 <b>2026-12-30 → 2027-01-05</b></span>\n')
A('  <span class="chip">住宿（人/晚 · 2 人一间折算）<b>将军山 ¥300</b> · 松花湖 ¥200 · 万龙 ¥283.5 · '
  '北大湖 ¥449 · 长白山 ¥184.5 · 禾木 ¥197 · 志贺 ¥218</span>\n')
A('  <span class="chip">住宿价 <b>携程 2026-10-24 实查</b>（经济型房 ÷ 2）</span>\n')
A('  <span class="chip">请假分界 <b>10:00 / 13:30 / 19:30</b></span>\n')
A('  <span class="chip">机场→雪场 <b>含 30% 冬季预留</b></span>\n')
A('  <span class="chip">打车 <b>按 4 人分摊</b></span>\n')
A('  <span class="chip">机票 <b>2026-10-23 快照</b></span>\n')
A('  <span class="chip">禾木 <b>4 人摊车费</b>（包车 ¥1,200/车 ÷ 4）</span>\n')
A('  <span class="chip">将军山 <b>落地 45 分上雪</b> · 返程加滑天山</span>\n')
A('</div>\n\n')

# ---------------------------------------------------------------- 卡片
A('<h2>各雪场 · 1 天年假档</h2>\n<div class="cards">')
for slug, name, short, color, tag, lodge, basis in RES:
    e = DATA[slug]["top"]["1"][0]
    A('<div class="card" style="--c:%s">\n' % color)
    A('      <div class="card-h"><span class="dot"></span>%s<span class="tag">%s</span></div>\n' % (name, tag))
    A('      <div class="big">¥%s<span class="unit">/雪日</span></div>\n' % fmt(e["perDay"]))
    A('      <div class="meta">1 天年假 · %.1fh 等效雪时 · <b>¥%s/h</b></div>\n' % (e["hEff"], r0(e["perHour"])))
    A('      <div class="meta">总花费 ¥%s（交通 ¥%s + 住 ¥%s）</div>\n'
      % (fmt(e["total"]), fmt(e["transport"]), fmt(e["lodge"])))
    A('      <div class="timeline">%s %s 出发 → %s %s 入场<br>\n      %s %s 离场 → %s %s 到家'
      % (md(e["outFirst"]), hm(e["outFirst"]), md(e["arriveResort"]), hm(e["arriveResort"]),
         md(e["leaveResort"]), hm(e["leaveResort"]), md(e["backHome"]), hm(e["backHome"])))
    if e.get("tms"):
        t = e["tms"]
        A('<br>\n      <span class="dim">＋%s 天山 %s–%s（%gh）</span>'
          % (md(abs_min(t["start"])), t["start"][11:], t["end"][11:], t["h"]))
    A('</div>\n    </div>')
A('</div>\n\n')


# ---------------------------------------------------------------- 九档网格
A('<h2>各年假档最优：元/雪日</h2>\n<div class="tw"><table class="grid">\n<thead><tr><th>年假</th>')
for slug, name, short, color, tag, lodge, basis in RES:
    A('<th style="text-align:right">%s</th>' % name)
A('</tr></thead>\n<tbody>')
for b in BUCKETS:
    best = None
    for slug, *_ in RES:
        e = DATA[slug]["top"].get(b,[None])[0]
        if e and (best is None or e["perDay"] < best):
            best = e["perDay"]
    A('<tr><th class="bk">%s 天</th>' % b)
    for slug, name, short, color, tag, lodge, basis in RES:
        e = DATA[slug]["top"].get(b,[None])[0]
        if not e:
            A('<td class="na">—</td>')
            continue
        cls = "win" if abs(e["perDay"] - best) < 1e-6 else ""
        A('<td class="%s"><b>¥%s</b><span class="sub">%.1fh · ¥%s/h</span><span class="sub">总 ¥%s</span></td>'
          % (cls, fmt(e["perDay"]), e["hEff"], r0(e["perHour"]), fmt(e["total"])))
    A('</tr>')
A('</tbody>\n</table></div>\n\n')

# ---------------------------------------------------------------- 折线图
V_MIN, V_MAX = 45.0, 1500.0
Y_TOP, Y_BOT = 26.0, 304.0
X0, X1 = 62.0, 818.0
XS = (X1 - X0) / (len(BUCKETS) - 1)
TICKS = [50, 70, 100, 150, 220, 320, 470, 700, 1000, 1500]


def ypos(v):
    return Y_BOT - (math.log(v) - math.log(V_MIN)) / (math.log(V_MAX) - math.log(V_MIN)) * (Y_BOT - Y_TOP)


A('<h2>趋势：每小时滑雪成本随年假变化</h2>\n<svg viewBox="0 0 940 350" class="chart" role="img">')
for t in TICKS:
    y = ypos(t)
    A('<line x1="%g" x2="%g" y1="%r" y2="%r" class="gl"/>' % (X0, X1, y, y))
    A('<text x="52" y="%r" class="ax" text-anchor="end">¥%d</text>' % (y + 4, t))
for i, b in enumerate(BUCKETS):
    x = X0 + i * XS
    A('<line x1="%r" x2="%r" y1="%g" y2="%g" class="gl"/>' % (x, x, Y_TOP, Y_BOT))
    A('<text x="%r" y="326" class="ax" text-anchor="middle">%s天</text>' % (x, b))
labels = []
for slug, name, short, color, tag, lodge, basis in RES:
    pts = []
    for i, b in enumerate(BUCKETS):
        e = DATA[slug]["top"].get(b,[None])[0]
        if not e:
            continue
        pts.append((X0 + i * XS, ypos(e["perHour"]), e["perHour"]))
    d = "M" + " L".join("%.1f,%.1f" % (x, y) for x, y, _ in pts)
    A('<path d="%s" fill="none" stroke="%s" stroke-width="2.4" stroke-linejoin="round"/>' % (d, color))
    for x, y, v in pts:
        A('<circle cx="%g" cy="%r" r="4" fill="#fff" stroke="%s" stroke-width="2.4"/>' % (x, y, color))
    labels.append([pts[-1][1], pts[-1][2], color, short])
labels.sort(key=lambda t: t[0])
prev = -1e9
for lb in labels:
    lb.append(max(lb[0], prev + 11.0))
    prev = lb[-1]
for y0, v, color, short, y1 in labels:
    A('<line x1="819" x2="825" y1="%.2f" y2="%.2f" stroke="%s" stroke-width="1" opacity=".4"/>' % (y0, y1, color))
    A('<text x="827" y="%.2f" class="lbl" fill="%s">%s ¥%s/h</text>' % (y1, color, short, r0(v)))
A('</svg>\n\n')

# ---------------------------------------------------------------- 禾木进山
HEM = DATA["ny-hemu"]["top"]
rows = []
for b in BUCKETS:
    for e in [HEM.get(b,[None])[0]]:
        if e:
            rows.append(e)
# top.json 的 top 只存每档前 30 名
def road(s):
    if "包车 298.4km" in s:
        return "老路"
    if "包车 209.5km" in s:
        return "阿禾"
    if "租车 190.3km" in s:
        return "自驾"
    if "巴士 296km" in s:
        return "巴士"
    return "其他"


cnt = {"老路": [0, 0], "阿禾": [0, 0]}
for b in BUCKETS:
    for e in HEM.get(b, []):
        o, r = road(e["outRoute"]), road(e["retRoute"])
        if o in cnt:
            cnt[o][0] += 1
        if r in cnt:
            cnt[r][1] += 1

A('<h2>禾木 · 进山两条路对比</h2>\n<div class="tw"><table class="evi">\n')
A('<thead><tr><th>进山走法</th><th>里程 / 车程</th><th>冬季可通行（登车时段）</th><th>在每档前 30 名里出现</th></tr></thead><tbody>')
for key, km, mins, win in [("老路", "298.4km", "6h37", "08:00–12:33"), ("阿禾", "209.45km", "5h15", "10:00–13:55")]:
    a, r = cnt[key]
    A('<tr><td><b>%s</b><div class="sub">包车 ¥1,200／车</div></td>\n'
      '      <td class="c">%s<div class="sub">净车程 %s</div></td>\n'
      '      <td class="c">%s<div class="sub">19:30 前跑完</div></td>\n'
      '      <td class="c">%d 次<div class="sub">去程 %d · 回程 %d</div></td></tr>'
      % ("经布尔津老路" if key == "老路" else "阿禾公路", km, mins, win, a + r, a, r))
A('</tbody></table></div>\n')
A('<h3 class="sub3">每档选中的方案：钱花在哪、走哪条路</h3>\n<div class="tw"><table class="evi">\n')
A('<thead><tr><th>年假</th><th>元/小时</th><th>交通</th><th>住宿</th><th>去程 / 回程</th><th>走哪条路</th></tr></thead>\n<tbody>')
for b in BUCKETS:
    e = HEM.get(b,[None])[0]
    if not e:
        continue
    A('<tr><th class="res" style="--c:#be185d"><span class="dot"></span>%s 天</th>\n' % b)
    A('      <td class="c"><b>¥%s/h</b><div class="sub">%.2fh · 总 ¥%s</div></td>\n'
      % (r0(e["perHour"]), e["hEff"], fmt(e["total"])))
    A('      <td class="c">¥%s<div class="sub">%d 晚场内</div></td>\n' % (fmt(e["transport"]), e["resortN"]))
    A('      <td class="c">¥%s<div class="sub">其中中转 %d 晚</div></td>\n' % (fmt(e["lodge"]), e["hotelN"]))
    A('      <td>%s<div class="sub">回程 %s</div></td>\n'
      % (e["outRoute"].replace(" | ", " → "), e["retRoute"].replace(" | ", " → ")))
    A('      <td class="c">%s<div class="sub">回程 %s</div></td></tr>'
      % ({"老路": "经布尔津老路", "阿禾": "阿禾公路", "自驾": "自驾", "巴士": "机场巴士"}.get(road(e["outRoute"]), "—"),
         {"老路": "经布尔津老路", "阿禾": "阿禾公路", "自驾": "自驾", "巴士": "机场巴士"}.get(road(e["retRoute"]), "—")))
A('</tbody></table></div>\n')

# ---------------------------------------------------------------- 1 天档最优方案
A('<h2>各雪场 · 1 天档最优方案</h2>\n<div class="plans">')
for slug, name, short, color, tag, lodge, basis in RES:
    if slug == "jjs":
        continue
    e = DATA[slug]["top"]["1"][0]
    A('<div class="plan" style="--c:%s">\n' % color)
    A('      <div class="plan-l">\n')
    A('        <div class="plan-h"><span class="dot"></span>%s</div>\n' % name)
    A('        <div class="plan-num">¥%s<span class="unit">/雪日</span></div>\n' % fmt(e["perDay"]))
    A('        <div class="meta">¥%s/h · %.1fh 等效雪时</div>\n' % (r0(e["perHour"]), e["hEff"]))
    A('        <div class="meta">日 %.1f · 夜 %.1f（×0.5）</div>\n' % (e["hDay"], e["hNight"]))
    A('        <div class="meta">总 ¥%s ＝ 交通 %s + 住 %s</div>\n' % (fmt(e["total"]), fmt(e["transport"]), fmt(e["lodge"])))
    A('      </div>\n      <div class="plan-r">\n        <div class="steps">\n')
    A('          <span class="st"><b>%s %s</b>%s 起飞</span>\n          <span class="ar">→</span>\n'
      % (md(e["outFirst"]), hm(e["outFirst"]), wd(e["outFirst"])))
    A('          <span class="st"><b>%s %s</b>入场 · %d 晚雪场</span>\n          <span class="ar">→</span>\n'
      % (md(e["arriveResort"]), hm(e["arriveResort"]), e["resortN"]))
    A('          <span class="st"><b>%s %s</b>离场</span>\n          <span class="ar">→</span>\n'
      % (md(e["leaveResort"]), hm(e["leaveResort"])))
    A('          <span class="st"><b>%s %s</b>到家</span>\n        </div>\n'
      % (md(e["backHome"]), hm(e["backHome"])))
    A('        <div class="route"><span class="rl">去程</span><b>%s</b></div>\n'
      % e["outRoute"].replace(" | ", " → "))
    A('        <div class="route"><span class="rl">返程</span><b>%s</b></div>\n'
      % e["retRoute"].replace(" | ", " → "))
    A('      </div>\n    </div>')
A('</div>\n\n')

# ---------------------------------------------------------------- 住宿敏感性
A('<h2>住宿单价敏感性</h2>\n<div class="tw"><table class="evi">\n')
A('<thead><tr><th>雪场</th><th>本版用价</th><th>折算自</th><th>这个价住哪</th><th>来源</th></tr></thead>\n<tbody>\n')
# 第三列写清「这个人均价是怎么来的」：实查房 ÷ 2，还是用户指定价（旁边附实查值供对照）
WHERE = {
    "ny-wl":   ("盛龙公寓（万龙店）¥567/间 ÷ 2", "崇礼城区快捷 / 民宿，车 10 分钟", "携程问道 2026-10-24"),
    "ny-shl":  ("指定价（青山公寓实查 ¥569/间 = ¥284.5/人）", "青山公寓 / 瞻云 SALOMON，步行或摆渡 5 分", "用户指定 + 携程问道"),
    "ny-bdh":  ("盈辉酒店（J 索缆车站店）¥898/间 ÷ 2", "冬奥村 / 浪漫雪郡民宿群，步行 750–950m 上雪道", "携程问道 2026-10-24"),
    "ny-cbs":  ("松果里度假俱乐部 ¥369/间 ÷ 2", "度假区内非滑进滑出（松果里 / 郝力克）", "携程问道 2026-10-24"),
    "ny-hemu": ("云住山居（落日观景台店）¥394/间 ÷ 2", "禾木村民宿，部分无地暖", "携程问道 2026-10-24"),
    "jjs":     ("指定价（山水商旅 ¥110/间 = ¥55/人；泰熙金陵 ¥576/间 = ¥288/人）",
                "阿勒泰市区四星 / 精品，打车到雪道 10–15 分钟", "用户指定 + 携程问道"),
    "shiga":   ("高地酒店 ¥436/间 ÷ 2", "一の瀬 / 高之原 民宿，含早餐", "携程问道 2026-10-24"),
}
for slug, name, short, color, tag, lodge, basis in RES:
    how, w, src = WHERE[slug]
    A('<tr><th class="res" style="--c:%s"><span class="dot"></span>%s</th>\n' % (color, name))
    A('  <td class="c"><b>¥%s</b><div class="sub">人/晚</div></td>\n' % fmt(lodge))
    A('  <td>%s</td>\n' % how)
    A('  <td>%s</td>\n' % w)
    A('  <td class="src">%s</td></tr>\n' % src)
A('</tbody></table></div>\n\n')

A('<div class="tw"><table class="lodging"><thead><tr><th>雪场</th><th style="text-align:center">本版采用</th>'
  '<th style="text-align:center">本版 元/小时</th><th style="text-align:center">若一律 ¥700</th>'
  '<th style="text-align:center">住宿这一项的影响</th></tr></thead><tbody>')
for slug, name, short, color, tag, lodge, basis in RES:
    e = DATA[slug]["top"]["1"][0]
    nights = e["lodge"] / lodge if lodge else 0
    t700 = e["transport"] + 700 * nights
    h700 = t700 / e["hEff"]
    A('<tr>\n      <th class="res" style="--c:%s"><span class="dot"></span>%s</th>\n' % (color, name))
    A('      <td class="c"><b>¥%s</b></td>\n' % fmt(lodge))
    A('      <td class="c hi"><b>¥%s</b>/h<span class="sub">%.1fh · 总 ¥%s</span></td>\n'
      % (r0(e["perHour"]), e["hEff"], fmt(e["total"])))
    A('      <td class="c">¥%s/h<span class="sub">%.1fh · 总 ¥%s</span></td>\n' % (r0(h700), e["hEff"], fmt(t700)))
    pct = (h700 / e["perHour"] - 1) * 100
    if abs(pct) < 0.5:
        A('      <td class="c"><span class="sub">无变化</span></td>\n')
    else:
        A('      <td class="c">%s <em class="up">%+.0f%%</em><span class="sub">¥700 比 ¥%s 每晚%s ¥%s</span></td>\n'
          % ("贵" if pct > 0 else "省", pct, fmt(lodge), "多花" if pct > 0 else "少花",
             fmt(abs(700 - lodge) * nights)))
    A('    </tr>')
A('</tbody></table></div>\n')

A('<h3 class="sub3">长白山如果不住雪场里：五个选项</h3>\n<div class="tw"><table class="evi">\n')
A('<thead><tr><th>住哪</th><th>到雪场</th><th>当前可订价（间/晚含税）</th><th>说明</th></tr></thead>\n<tbody>')
for row in [
    ("度假区内滑进滑出", "0（出门即雪道）", "¥570–658",
     "喜来登 ¥570、瑞士 ¥658，含自助早餐；威斯汀 / 柏悦 / 凯悦 暂无可订房型，旺季参考价 ¥1,999"),
    ("度假区内非滑进滑出", "摆渡车 5–10 分", "¥410–489",
     "汉拿山 ¥410（含早）、锦华 ¥489（含早）；房费不含雪票"),
    ("华美胜地（鲁能）", "摆渡车", "¥369–458",
     "松果里 ¥369（本版取此价，早餐未明）、郝力克 ¥458（一价全包含滑雪）"),
    ("南门果松村民宿", "车 5 分", "¥450–700",
     "同程口径：小洋楼美宿 ¥451 起、玺麓民宿；房源少，元旦早满"),
    ("松江河镇", "驾车 12.6km / 20 分", "¥250–350",
     "同程口径：汉庭 ¥190、桔子 ¥200、如家 ¥134 起；民宿 ¥100–220"),
]:
    A('<tr><th class="res" style="--c:#7c3aed"><span class="dot"></span>%s</th><td>%s</td>'
      '<td class="c"><b>%s</b></td><td>%s</td></tr>\n' % row)
A('</tbody></table></div>\n\n')

# ---------------------------------------------------------------- 将军山
A('<h2>将军山（阿勒泰 · 机场 15km）</h2>\n<div class="tw"><table class="evi">\n')
A('<thead><tr><th>雪场</th><th>到达机场</th><th>落地 → 上雪</th><th>每天可滑</th><th>1 天档雪时</th><th>1 天档 元/小时</th></tr></thead>\n<tbody>')
GEO = {
    "ny-wl": ("张家口宁远 / 北京首都", "62.7km（张家口）· 205km（北京）", "9.5h 日场 + 夜场"),
    "jjs": ("阿勒泰雪都 AAT", "<b>15km · 45 分</b>（打车 ¥50/车）", "<b>9h 日场 + 3h 夜场 = 12h</b>"),
    "ny-shl": ("长春龙嘉", "108km（城际 78 + 打车 25）", "7.5h 日场"),
    "ny-bdh": ("长春龙嘉", "139km 打车", "7h 日场"),
    "shiga": ("羽田 → 长野", "电车 22 + 新干线 222 + 巴士 42km", "8h 日场"),
    "ny-cbs": ("长白山 / 延吉", "236km 打车（延吉）", "7.5h 日场 + 夜场"),
    "ny-hemu": ("阿勒泰雪都 AAT", "296km · 6h36（中巴 ¥135）", "8h 日场，无夜场"),
}
order = ["ny-wl", "jjs", "ny-shl", "ny-bdh", "shiga", "ny-cbs", "ny-hemu"]
byname = {s: (n, c) for s, n, _, c, _, _, _ in RES}
for slug in order:
    name, color = byname[slug]
    e = DATA[slug]["top"]["1"][0]
    ap, leg, day = GEO[slug]
    style = ' style="background:#fffdf5"' if slug == "jjs" else ""
    A('<tr%s><td><b>%s</b></td><td>%s</td><td>%s</td><td>%s</td><td>%.1fh</td><td>¥%s/h</td></tr>'
      % (style, short, ap, leg, day, e["hEff"], r0(e["perHour"])))
A('</tbody></table></div>\n')

A('<h2>将军山 · 各年假档最优</h2>\n<div class="tw"><table class="evi">\n')
A('<thead><tr><th>年假</th><th>元/小时</th><th>总花费</th><th>天山加滑</th><th>去程</th><th>返程</th></tr></thead>\n<tbody>')
J = DATA["jjs"]["top"]
for b in BUCKETS:
    e = J.get(b,[None])[0]
    if not e:
        continue

    def rts(legs):
        return " → ".join(l["ref"] + (" 硬卧" if l["mode"] == "rail" else "")
                          for l in legs if l["mode"] in ("flight", "rail"))
    t = e.get("tms")
    tms = ("<b>%s %sh</b>" % ("去" if e.get("tmsOut") else "返", ("%g" % (t or e.get("tmsOut"))["h"]))) if (t or e.get("tmsOut")) else "—"
    style = ' style="background:#fffdf5"' if b == "1" else ""
    A('<tr%s><td><b>%s 天</b></td><td>¥%s/h<div class="sub">%.2fh · 总 ¥%s</div></td>'
      '<td>¥%s<div class="sub">住宿 ¥%s</div></td><td>%s</td><td>%s</td><td>%s</td></tr>'
      % (style, b, r0(e["perHour"]), e["hEff"], fmt(e["total"]), fmt(e["total"]), fmt(e["lodge"]),
         tms, rts(e["outLegs"]), rts(e["retLegs"])))
A('</tbody></table></div>\n')

# 全直飞往返 vs 九档最优
it = list(csv.DictReader(open(os.path.join(RUN, "jjs", "itineraries.csv"), encoding="utf-8-sig")))
direct = {}
for r in it:
    if "SZX→AAT" in r["去程"] and "AAT→SZX" in r["返程"]:
        k = r["年假(天)"]
        if k not in direct or float(r["元每雪日"]) < float(direct[k]["元每雪日"]):
            direct[k] = r
A('<div style="font-size:15.5px;font-weight:600;margin:28px 0 10px">将军山 · 全直飞往返 vs 各档最优</div>\n')
A('<div class="tw"><table class="evi">\n<thead><tr><th>年假</th><th>全直飞往返（去回都 SZX↔AAT）</th>'
  '<th>九档最优</th><th>直飞贵</th></tr></thead>\n<tbody>')
for b in BUCKETS:
    d = direct.get(b)
    e = J.get(b,[None])[0]
    if not d or not e:
        continue
    A('<tr><td><b>%s 天</b></td><td>¥%s<div class="sub">¥%s/h · %sh · 总 ¥%s</div></td>'
      '<td>¥%s<div class="sub">¥%s/h · %.2fh · 总 ¥%s</div></td><td class="num">%+.0f%%</td></tr>'
      % (b, fmt(d["元每雪日"]), r0(d["元每小时"]), d["有效雪时"], fmt(d["总费用"]),
         fmt(e["perDay"]), r0(e["perHour"]), e["hEff"], fmt(e["total"]),
         (float(d["元每雪日"]) / e["perDay"] - 1) * 100))
A('</tbody></table></div>\n')

A(STATIC_ROUTE)
A(STATIC_REPORTS)

# ---------------------------------------------------------------- 页脚
A('<footer>\n')
A('口径：住宿按夜间 03:00 采样点判定（在雪场记雪场晚、在节点久留记中转晚、在机上记 0）；'
  '夜场按 0.5 权重折算成等效雪时；<b>某一天的日场不足 %g 小时按 0 计</b>（换鞋存包热身都不够，'
  '夜场不受此限）；年假按起飞/落地时刻三段判定，元旦 1/1–1/3 免假。<br>\n' % MINDAY)
A('住宿单价一律按「每人每晚」；将军山 ¥300、松花湖 ¥200 为指定价，其余五场取携程 2026-10-24 实查的'
  '经济型房价 ÷ 2（2 人一间）。该价是当日可订价，不是元旦价。<br>\n')
A('数据来源：航班为飞常准 MCP 2026-10-23 快照（含机建 + 燃油），车程为高德实测加 30% 冬季预留，'
  '铁路时刻经 12306 逐站校验，雪场营业时间以官方公示/问道为准。<b>下单前必须复核票价与班次。</b><br>\n')
A('生成：ski-trip-planner · legs → enumerate → render → compare。<br>\n')
A('单独分发用（每份都能脱离本页打开）：\n')
A('<div class="files"><a href="万龙.html">万龙.html</a><a href="松花湖.html">松花湖.html</a>'
  '<a href="北大湖.html">北大湖.html</a><a href="长白山.html">长白山.html</a><a href="禾木.html">禾木.html</a>'
  '<a href="将军山.html">将军山.html</a><a href="志贺高原.html">志贺高原.html</a></div>\n')
A('</footer>\n')
A('</div><!-- /pane-cmp -->\n')

new = "".join(H)
open(os.path.join(ROOT, "tmp/cmp_pane_new.html"), "w", encoding="utf-8", newline="").write(new)
print("新面板 %d 字符（旧 %d）" % (len(new), len(OLD)))
print("九档：")
for b in BUCKETS:
    line = "  %-4s" % b
    for slug, name, *_ in RES:
        e = DATA[slug]["top"].get(b,[None])[0]
        line += " %s=%-7s" % (name[:3], fmt(e["perDay"]) if e else "—")
    print(line)
