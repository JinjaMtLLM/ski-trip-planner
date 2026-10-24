# -*- coding: utf-8 -*-
"""概览页正文生成器：多窗口 × 多雪场的热力表 / 折线图 / 年假档总表。

**换雪季不要改这个文件**，改 `season.config.json`：
  resorts 决定图例与住宿单价，sessions 决定概览的列，texts 是页面上的人话（不写就按数据自动拼）。
数据从 `collect.py` 产出的 season-data.json 读，本文件只做呈现。
"""
import json, os, datetime, html as H

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))          # templates/season-page → 仓库根

# 下面这些由 configure() 从配置与数据里灌进来；模块级留空值只为让 import 不报错
CFG = {}
D = {'resorts': [], 'sessions': [], 'cells': {}}
RES, CODE, COLOR, SESS, CELL = [], {}, {}, [], {}
BUCKETS = ['0', '0.5', '1', '1.5', '2', '2.5', '3', '3.5', '4', '4.5', '5']
LOW, HIGH = 700.0, 1500.0
SESSION_H = 9.5
MIN_DAY_H = 3
LEAVE = {'dayStart': '10:00', 'halfDayAt': '13:30', 'dayEnd': '19:30'}

FALLBACK_COLORS = ['#b91c1c', '#1d4ed8', '#0f766e', '#7c3aed', '#c2410c',
                   '#a21caf', '#4d7c0f', '#0e7490', '#9a3412', '#3f6212']


def load_cfg(path=None):
    p = path or os.path.join(HERE, 'season.config.json')
    with open(p, encoding='utf-8', newline='') as f:
        cfg = json.load(f)
    cfg.setdefault('root', ROOT)
    cfg['root'] = os.path.abspath(cfg['root'])
    return cfg


def configure(cfg=None, data=None):
    """把配置与数据灌进模块全局。build.py 在生成前调一次即可。"""
    global CFG, D, RES, CODE, COLOR, SESS, CELL, BUCKETS, LOW, HIGH
    global SESSION_H, MIN_DAY_H, LEAVE
    cfg = cfg or load_cfg()
    CFG = cfg
    if data is None:
        with open(os.path.join(cfg['root'], cfg['data']), encoding='utf-8', newline='') as f:
            data = json.load(f)
    D = data
    RES = data['resorts']
    CODE = {r['code']: r for r in RES}
    COLOR = dict(cfg.get('colors') or {})
    for i, r in enumerate(RES):                        # 配置里没给色就按顺序兜底
        COLOR.setdefault(r['code'], FALLBACK_COLORS[i % len(FALLBACK_COLORS)])
    SESS = data['sessions']
    CELL = data['cells']
    BUCKETS = cfg.get('buckets') or BUCKETS
    LOW, HIGH = (cfg.get('colorRange') or [LOW, HIGH])[:2]
    SESSION_H = cfg.get('sessionHours', SESSION_H)
    MIN_DAY_H = cfg.get('minDayH', MIN_DAY_H)
    LEAVE = cfg.get('leave') or LEAVE
    return cfg


def cfg_text(key, default=''):
    return (CFG.get('texts') or {}).get(key) or default


def lodge_line():
    """「万龙 ¥283.5 · 松花湖 ¥200 · …」，从 resorts 自动拼，不手写。"""
    return ' · '.join('%s ¥%s' % (r['name'], ('%g' % r['lodge']).rstrip('0').rstrip('.')
                                 if isinstance(r['lodge'], float) else r['lodge'])
                      for r in RES if r.get('lodge') is not None)


def sess_labels():
    return '、'.join(s['label'] for s in SESS)


def leave_line():
    return ' / '.join([LEAVE.get('dayStart', ''), LEAVE.get('halfDayAt', ''), LEAVE.get('dayEnd', '')])


def fdt(a):
    return (datetime.datetime(1970, 1, 1) + datetime.timedelta(minutes=a))


def money(v):
    return format(int(round(v)), ',')


def num(v, nd=0):
    return ('%.*f' % (nd, v))


def num0(v):
    return format(int(round(v)), ',')


def esc(s):
    return H.escape(str(s))


def best(sid, code, b='0'):
    c = CELL.get('%s|%s' % (sid, code))
    if not c:
        return None
    lst = c['buckets'].get(b)
    return lst[0] if lst else None


# ---------------------------------------------------------------- 价格配色
# 700 以下不填色（够便宜，不用提示）；700–1500 是真正要比较的区间，用绿→黄→红连续渐变，
# 保证这一段的每一档都能看出差别；1500 以上直接深红实底，和渐变段明确断开。
LOW, HIGH = 700.0, 1500.0


def pcol(v):
    """元/雪日 → (背景色, 文字色)。空串表示不设该属性。"""
    if v is None:
        return ('', '')
    if v >= HIGH:
        return ('', '#b3261e')     # 超预算：深红字、不铺底
    if v < LOW:
        return ('', '')
    t = (v - LOW) / (HIGH - LOW)
    if t <= 0.5:
        h = 145 - 100 * (t / 0.5)          # 145 绿 → 45 黄
    else:
        h = 45 - 43 * ((t - 0.5) / 0.5)    # 45 黄 → 2 红
    return ('hsl(%d,72%%,85%%)' % round(h), '#1c1c1c')


def cell_style(v):
    """热力格的 style 串。生成器和校验器共用这一份，避免两边各写一套判断。"""
    bg, fg = pcol(v)
    parts = []
    if bg:
        parts.append('background:%s' % bg)
    if fg:
        parts.append('color:%s' % fg)
    if v is not None and v >= HIGH:
        parts.append('font-weight:700')
    return (' style="%s"' % ';'.join(parts)) if parts else ''


def clr_legend():
    stops = ','.join(pcol(LOW + (HIGH - LOW) * i / 8.0)[0] + ' %d%%' % round(i * 100 / 8.0)
                     for i in range(9))
    return ('<div class="clr">'
            '<div class="clr-k"><i class="sw0"></i>&lt; 700 不填色</div>'
            '<div class="clr-ramp"><div class="clr-bar" style="background:linear-gradient(90deg,%s)"></div>'
            '<div class="clr-tk"><span>700</span><span>900</span><span>1,100</span>'
            '<span>1,300</span><span>1,500</span></div></div>'
            '<div class="clr-k"><b class="sw1">≥ 1,500</b>深红字</div>'
            '<div class="clr-k2">底色＝该格元/雪日，越红越贵</div>'
            '</div>' % stops)


# ---------------------------------------------------------------- 图：请假天数 × 元/雪日
def days_series():
    """每雪场每假档：跨窗口取最便宜的那一个方案。"""
    out = {}
    for r in RES:
        pts = []
        for i, b in enumerate(BUCKETS):
            vals = []
            for s in SESS:
                c = CELL.get('%s|%s' % (s['id'], r['code']))
                if not c:
                    continue
                lst = c['buckets'].get(b)
                if lst:
                    vals.append((lst[0]['perDay'], s['id'], lst[0]['hEff'], lst[0]['perHour']))
            if vals:
                m = min(vals)
                pts.append((i, float(b), m[0], m[1], m[2], m[3]))
        out[r['code']] = pts
    return out


def build_svg_days():
    import math
    W, Hh = 1280, 520
    L, R, T, B = 78, 236, 26, 72
    x0, x1 = L, W - R
    y0, y1 = T, Hh - B
    vmin, vmax = 300.0, 13500.0
    lg = lambda v: (math.log(v) - math.log(vmin)) / (math.log(vmax) - math.log(vmin))
    ypx = lambda v: y1 - lg(max(vmin, min(vmax, v))) * (y1 - y0)
    n = len(BUCKETS)
    xs = [x0 + i * (x1 - x0) / (n - 1) for i in range(n)]

    o = ['<svg viewBox="0 0 %d %d" width="100%%" style="max-width:%dpx;display:block" role="img" '
         'aria-label="请假天数与元每雪日">' % (W, Hh, W)]
    o.append('<rect x="0" y="0" width="%d" height="%d" fill="#fff"/>' % (W, Hh))

    # 关注区间底纹（和上表 700–1500 的配色同一个分界）
    by, ty = ypx(HIGH), ypx(LOW)
    o.append('<rect x="%d" y="%.1f" width="%d" height="%.1f" fill="#f8f5ec"/>' % (x0, by, x1 - x0, ty - by))
    for yy in (by, ty):
        o.append('<line x1="%d" y1="%.1f" x2="%d" y2="%.1f" stroke="#e6dfcd" stroke-width="1" '
                 'stroke-dasharray="3 3"/>' % (x0, yy, x1, yy))

    ticks = [300, 500, 700, 1000, 1500, 2500, 4000, 7000, 13000]
    for t in ticks:
        y = ypx(t)
        emph = t in (700, 1500)
        o.append('<line x1="%d" y1="%.1f" x2="%d" y2="%.1f" stroke="%s" stroke-width="1"/>'
                 % (x0, y, x1, y, '#e4e4e0' if emph else '#f1f1ee'))
        o.append('<text x="%d" y="%.1f" text-anchor="end" font-size="11" fill="%s" '
                 'dominant-baseline="middle">¥%s</text>'
                 % (x0 - 10, y, '#8a8a86' if emph else '#b3b3ae', format(t, ',')))

    for i, b in enumerate(BUCKETS):
        bf = float(b)
        x = xs[i]
        whole = (bf == int(bf))
        o.append('<line x1="%.1f" y1="%d" x2="%.1f" y2="%d" stroke="%s" stroke-width="1"/>'
                 % (x, y0, x, y1, '#efefec' if whole else '#f7f7f5'))
        if whole:
            o.append('<text x="%.1f" y="%d" text-anchor="middle" font-size="11.5" fill="#5a5a5a">%g</text>'
                     % (x, y1 + 20, bf))
    o.append('<text x="%.1f" y="%d" text-anchor="middle" font-size="11.5" fill="#9a9a96">请假天数（天）</text>'
             % ((x0 + x1) / 2.0, y1 + 46))

    ser = days_series()

    # 折线：相邻档才连实线，中间缺档用虚线（缺档是那一档没查，不是价格跳变）
    for r in RES:
        pts = ser[r['code']]
        col = COLOR[r['code']]
        for a, b in zip(pts, pts[1:]):
            dash = '' if b[0] - a[0] == 1 else ' stroke-dasharray="4 4" opacity="0.45"'
            o.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="2.2" '
                     'stroke-linecap="round"%s/>' % (xs[a[0]], ypx(a[2]), xs[b[0]], ypx(b[2]), col, dash))

    # 全场最低（每个假档取 7 个雪场里最便宜的）
    env = []
    for i in range(n):
        cand = [(ser[r['code']][k][2], r) for r in RES for k in range(len(ser[r['code']]))
                if ser[r['code']][k][0] == i]
        if cand:
            env.append((i, min(cand)))
    for a, b in zip(env, env[1:]):
        dash = '' if b[0] - a[0] == 1 else ' stroke-dasharray="4 4" opacity="0.45"'
        o.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="#1f2937" stroke-width="3.4" '
                 'stroke-linecap="round" opacity="0.85"%s/>'
                 % (xs[a[0]], ypx(a[1][0]), xs[b[0]], ypx(b[1][0]), dash))

    for r in RES:
        col = COLOR[r['code']]
        for (i, b, v, sid, h, ph) in ser[r['code']]:
            o.append('<circle cx="%.1f" cy="%.1f" r="4" fill="%s" stroke="#fff" stroke-width="1.5"/>'
                     % (xs[i], ypx(v), col))

    # 右端标签：每条线最后一个点 + 全场最低。先按 y 排序，再往下顶，最后整体夹回绘图区内
    labels = []
    for r in RES:
        pts = ser[r['code']]
        if not pts:
            continue
        i, b, v, sid, h, ph = pts[-1]
        labels.append([ypx(v), '%s ¥%s' % (r['name'], money(v)), COLOR[r['code']], xs[i], 0])
    if env:
        i, (v, r) = env[-1]
        labels.append([ypx(v), '全场最低 ¥%s' % money(v), '#1f2937', xs[i], 1])
    labels.sort()
    prev = y0 - 1e9
    for lb in labels:
        lb[0] = max(lb[0], prev + 16.0)
        prev = lb[0]
    over = labels[-1][0] - (y1 - 4) if labels else 0
    if over > 0:
        for lb in labels:
            lb[0] -= over
    for (y, txt, col, px, bold) in labels:
        o.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="1" '
                 'stroke-dasharray="2 2" opacity="0.5"/>' % (px + 6, y, x1 + 12, y, col))
        o.append('<text x="%.1f" y="%.1f" font-size="11.5" fill="%s" dominant-baseline="middle"%s>%s</text>'
                 % (x1 + 15, y, col, ' font-weight="700"' if bold else '', txt))

    o.append('</svg>')
    return '\n'.join(o)


# ---------------------------------------------------------------- 表 1 总表
def t_main(bucket, title, hint):
    rows = []
    for s in SESS:
        tds = ['<th class="sc"><b>%s</b><div class="sub">%s</div></th>' % (s['label'], esc(s['note']))]
        vals = []
        for r in RES:
            e = best(s['id'], r['code'], bucket)
            vals.append((r, e))
        lo = min([e['perHour'] for _, e in vals if e], default=None)
        for r, e in vals:
            if not e:
                tds.append('<td class="na">—</td>')
                continue
            cls = 'c best' if (lo is not None and abs(e['perHour'] - lo) < 1e-9) else 'c'
            tds.append('<td class="%s"><b>¥%s</b><div class="sub">%s/雪日 · %sh</div></td>'
                       % (cls, num0(e['perHour']), money(e['perDay']), num(e['hEff'], 1)))
        rows.append('<tr>' + ''.join(tds) + '</tr>')
    head = ''.join('<th style="--c:%s"><span class="dot"></span>%s<div class="sub">%s</div></th>'
                   % (COLOR[r['code']], r['name'], r['region']) for r in RES)
    return ('<h2>%s</h2>\n<p class="hint">%s</p>\n<div class="tw"><table class="grid">\n'
            '<thead><tr><th class="sc">出发窗口</th>%s</tr></thead>\n<tbody>\n%s\n</tbody></table></div>\n'
            % (title, hint, head, '\n'.join(rows)))


# ---------------------------------------------------------------- 表 1 全档位热力表
def t_buckets():
    rows = []
    for s in SESS:
        for r in RES:
            c = CELL.get('%s|%s' % (s['id'], r['code']))
            if not c:
                continue
            tds = []
            for b in BUCKETS:
                lst = c['buckets'].get(b)
                if not lst:
                    tds.append('<td class="na">—</td>')
                    continue
                v = lst[0]['perDay']
                tds.append('<td class="hm"%s>%s</td>' % (cell_style(v), money(v)))
            rows.append('<tr><th class="sc sm"><b>%s</b><div class="sub">%s</div></th>'
                        '<td class="c rc" style="--c:%s"><span class="dot"></span>%s</td>%s</tr>'
                        % (s['label'], esc(s['note'].split(' · ')[0]), COLOR[r['code']], r['name'], ''.join(tds)))
    head = ''.join('<th class="c">%g<div class="sub">天</div></th>' % float(b) for b in BUCKETS)
    return ('<h2>1. 各场次 · 全年假档 元/雪日</h2>\n'
            '<p class="hint">每格是该场次该年假档的最优方案，单位元/雪日（＝总花费 ÷ 等效雪日）。'
            '底色按价格上色，700 以下不填色、700–1,500 连续渐变、1,500 以上深红字（不铺底）。'
            '横着看＝多请假能便宜多少，竖着看＝同一档哪个雪场划算。</p>\n'
            + clr_legend() +
            '<div class="tw"><table class="grid tight">\n<thead><tr><th class="sc">窗口</th><th class="c">雪场</th>%s</tr></thead>\n'
            '<tbody>\n%s\n</tbody></table></div>\n' % (head, '\n'.join(rows)))


# ---------------------------------------------------------------- 页
CSS = """
*{box-sizing:border-box}
body{margin:0;background:#f6f6f4;color:#1c1c1c;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  font-size:14px;line-height:1.6;-webkit-font-smoothing:antialiased}
.wrap{max-width:1340px;margin:0 auto;padding:44px 30px 90px}
h1{font-size:27px;margin:0 0 6px;letter-spacing:-.4px;font-weight:700}
.lead{color:#6b6b6b;font-size:14.5px;margin:0 0 26px;max-width:900px}
h2{font-size:18px;margin:52px 0 6px;padding-bottom:9px;border-bottom:1px solid #e2e2e0;font-weight:650;letter-spacing:-.2px}
.hint{color:#7a7a7a;font-size:12.8px;margin:0 0 14px;max-width:960px}
.meta{background:#fff;border:1px solid #e6e6e3;border-radius:10px;padding:16px 20px;margin:0 0 8px;
  font-size:12.9px;color:#4a4a4a;display:grid;grid-template-columns:repeat(4,1fr);gap:14px 22px}
.meta b{display:block;font-size:11px;color:#9a9a9a;font-weight:500;letter-spacing:.4px;margin-bottom:2px}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch;background:#fff;border:1px solid #e6e6e3;border-radius:10px}
table{border-collapse:collapse;width:100%}
table.grid{font-size:13px}
table.grid th,table.grid td{padding:11px 12px;border-bottom:1px solid #efefec;text-align:left;vertical-align:middle}
table.grid thead th{background:#fafaf8;font-weight:600;font-size:12px;color:#5a5a5a;white-space:nowrap;
  border-bottom:1px solid #e4e4e1}
table.grid thead th .sub{font-weight:400;color:#a0a0a0;font-size:10.5px;margin-top:1px}
table.grid tbody tr:hover{background:#fcfcfa}
table.grid tbody tr:last-child td,table.grid tbody tr:last-child th{border-bottom:none}
table.tight th,table.tight td{padding:8px 9px;font-size:12.4px}
th.sc{background:#fafaf8;font-weight:600;white-space:nowrap;border-right:1px solid #efefec}
th.sc.sm{font-size:12.2px}
th.sc .sub,td .sub{font-weight:400;color:#9a9a9a;font-size:10.5px;line-height:1.35;margin-top:1px}
td.c,th.c{text-align:center;white-space:nowrap}
td.na{color:#c9c9c7;text-align:center}
td.hm{text-align:center;white-space:nowrap;font-variant-numeric:tabular-nums;
  font-size:12.2px;border-left:1px solid #fff;border-bottom:1px solid #fff}
td.best,td.best b{color:#0b7a45}
td.best{background:#f2faf5}
.clr{display:flex;align-items:center;gap:14px;margin:0 0 12px;font-size:11.6px;color:#7a7a7a;flex-wrap:wrap}
.clr-k{display:flex;align-items:center;gap:5px;white-space:nowrap}
.clr-k i{width:12px;height:12px;border-radius:3px;border:1px solid #e2e2e0;display:inline-block}
.clr-k .sw1{color:#b3261e;font-weight:700;font-variant-numeric:tabular-nums}
.clr-k2{color:#a5a5a0}
.clr-ramp{flex:0 0 300px}
.clr-bar{height:9px;border-radius:5px;border:1px solid #e6e6e3}
.clr-tk{display:flex;justify-content:space-between;font-size:10.4px;color:#a5a5a0;margin-top:2px}
td.rc{white-space:nowrap;font-weight:600}
td.rt{font-size:11.4px;color:#555;line-height:1.5;max-width:268px;min-width:190px}
td.nw{white-space:nowrap}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--c);margin-right:6px;vertical-align:1px}
.chart{background:#fff;border:1px solid #e6e6e3;border-radius:10px;padding:14px 8px 4px;margin-bottom:8px}
.legend{display:flex;flex-wrap:wrap;gap:14px;padding:4px 16px 14px;font-size:12px;color:#555}
.legend i{display:inline-block;width:14px;height:3px;border-radius:2px;margin-right:6px;vertical-align:3px}
footer{margin-top:64px;padding-top:18px;border-top:1px solid #e2e2e0;color:#9a9a9a;font-size:11.8px}
footer a{color:#1d4ed8;text-decoration:none}footer a:hover{text-decoration:underline}
"""


def sections():
    """概览页正文（不含 doctype/style/wrap）——独立页与页签版共用这一份。"""
    parts = []
    parts.append('<h1>%s</h1>' % esc(CFG.get('title') or '雪季对比'))
    lead = cfg_text('lead') or ('%d 个出发窗口 × %d 个雪场。全部用同一套口径重算：'
                                '住宿按每人每晚计（%s），日场不足 %g 小时记 0，'
                                '连续同模式地面接驳合并成一段。'
                                % (len(SESS), len(RES), lodge_line(), MIN_DAY_H))
    parts.append('<p class="lead">%s</p>' % lead)

    # 1) 全年假档热力表置顶
    parts.append(t_buckets())

    # 2) 请假天数 × 元/雪日
    parts.append('<h2>2. 请假天数 × 元/雪日</h2>')
    parts.append('<p class="hint">横轴请假天数，纵轴元/雪日（越低越划算）。每个点＝该雪场在该假档下'
                 '<b>所有窗口里最便宜</b>的那个方案，所以一条线就是「这个雪场最多能做到多便宜」。'
                 '锯齿上翘的几处不是「请假越多越贵」，是那一档只有更贵的窗口查过（例如志贺 4 天以上只有 12/04 开板周）。'
                 '虚线＝中间缺档没查。粗黑线＝该档七个雪场里的最低价。浅色带是 ¥700–1,500 关注区间，和上表配色一致。</p>')
    parts.append('<div class="chart">%s</div>' % build_svg_days())
    parts.append('<div class="legend">%s<span><i style="background:#1f2937;height:4px"></i>全场最低</span>'
                 '<span><i style="background:#f8f5ec;border:1px solid #e6dfcd;height:11px;width:14px"></i>'
                 '¥700–1,500 关注区间</span></div>'
                 % ''.join('<span><i style="background:%s"></i>%s</span>' % (COLOR[r['code']], r['name'])
                           for r in RES))

    # 3) 0 / 1 / 2 天年假档总表
    parts.append(t_main('0', '3. 雪季总表 · 0 天年假档',
                        '0 天年假 = 不用请假：工作日 %s 之后出发，周末全天出发。'
                        '主数值是元/小时（跨窗口、跨雪场唯一可比的指标），下方小字是元/雪日与等效雪时。'
                        '绿色＝该行最便宜。' % LEAVE.get('dayEnd', '19:30')))
    parts.append(t_main('1', '4. 雪季总表 · 1 天年假档',
                        '1 天年假 = 周五请一整天，可以坐上午的航班。'))
    parts.append(t_main('2', '5. 雪季总表 · 2 天年假档',
                        '2 天年假 = 提前两个工作日出发，接上周六日可以凑出 4–5 天雪期。'))

    meta = CFG.get('texts', {}).get('meta')
    if not meta:
        meta = ['<div><b>窗口</b>%d 个：%s</div>' % (len(SESS), esc(sess_labels())),
                '<div><b>雪场</b>%d 个：%s</div>' % (len(RES), '、'.join(r['name'] for r in RES)),
                '<div><b>指标</b>元/雪日＝总花费 ÷（等效雪时 ÷ %g）；元/小时＝总花费 ÷ 等效雪时</div>'
                % SESSION_H,
                '<div><b>雪时口径</b>夜场 ×0.5；日场交集不足 %g 小时整天记 0；年假按 %s 三段判定</div>'
                % (MIN_DAY_H, leave_line())]
    parts.append('<div class="meta">%s</div>' % ''.join(meta))

    parts.append('<footer>%s</footer>' % (cfg_text('footer') or
                 '引擎：ski-trip-planner（DFS 全枚举 + 同键剪枝 + 笛卡尔配对）。'
                 '本页所有数字均由 <code>%s</code> 生成，未手工改写。' % esc(CFG.get('data', ''))))
    return parts


def main():
    if not RES:
        configure()
    parts = ['<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">',
             '<meta name="viewport" content="width=device-width,initial-scale=1">',
             '<title>%s</title>' % esc(CFG.get('title') or '雪季对比'),
             '<style>%s</style></head><body><div class="wrap">' % CSS]
    parts.extend(sections())
    parts.append('</div></body></html>')
    s = '\n'.join(parts)
    # 独立版只是调试用的中间产物：正式交付物是 build_season_all.py 出的页签版，
    # 这里绝不能写 dist/，否则会把 12 MB 的页签版覆盖成这个 37 KB 的裸表。
    out = os.path.join(ROOT, 'tmp/season-standalone.html')
    open(out, 'w', encoding='utf-8', newline='').write(s)
    print('wrote', out, len(s.encode()), 'bytes')


if __name__ == '__main__':
    main()
