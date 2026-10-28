# -*- coding: utf-8 -*-
"""校验交付页：清单三方一致、载荷可逆、结构完整、表格可回溯。页面与数据路径取自配置。"""
import hashlib, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_season as B                                      # noqa: E402
import build_season_all as BA                                 # noqa: E402

CFG = BA.configure(next((a for a in sys.argv[1:] if not a.startswith('-')), None)
                   or (os.path.join(HERE, 'season.config.json')
                       if os.path.exists(os.path.join(HERE, 'season.config.json')) else None))
B.configure(CFG)
ROOT = CFG['root']
PAGE = os.path.join(ROOT, CFG['out'])
if not os.path.exists(PAGE):
    raise SystemExit('找不到交付页：%s（先跑 build.py）' % PAGE)
s = open(PAGE, encoding='utf-8', newline='').read()
ok = True


def bad(msg):
    global ok
    ok = False
    print('  ✗', msg)


def good(msg):
    print('  ✓', msg)


# ---------------------------------------------------------------- 1. data-raw 三方一致
print('1. data-raw 块 vs #raw-manifest')
blocks = {}
pat = re.compile(r'<script type="text/plain" data-raw="([^"]+)" data-bytes="(\d+)" data-sha256="([0-9a-f]{64})">(.*?)</script>', re.S)
for m in pat.finditer(s):
    name, nb, sha, body = m.group(1), int(m.group(2)), m.group(3), m.group(4)
    blocks[name] = (nb, sha, body)

man_m = re.search(r'<script type="application/json" id="raw-manifest">(.*?)</script>', s, re.S)
man = json.loads(man_m.group(1).replace('<\\/', '</'))
print('   manifest entries: %d, blocks on page: %d' % (len(man['files']), len(blocks)))
if len(man['files']) != len(blocks):
    bad('条目数不一致 %d vs %d' % (len(man['files']), len(blocks)))

for f in man['files']:
    n = f['name']
    if n not in blocks:
        bad('清单有、页面无：' + n)
        continue
    nb, sha, body = blocks[n]
    txt = BA.unesc_close(body)
    real_b = len(txt.encode())
    real_h = hashlib.sha256(txt.encode()).hexdigest()
    if (nb, sha) != (f['bytes'], f['sha256']):
        bad('%s 属性与清单不符' % n)
    elif (real_b, real_h) != (f['bytes'], f['sha256']):
        bad('%s 内容与清单不符（%d vs %d 字节）' % (n, real_b, f['bytes']))
for n in blocks:
    if n not in {f['name'] for f in man['files']}:
        bad('页面有、清单无：' + n)
_b = ok
if _b:
    good('%d 个块三方一致（内容 ↔ data-bytes/sha256 ↔ 清单）' % len(blocks))

# 清单里的算例目录都要真实存在，且个数与配置里的页签数一致
cases = [c['prefix'] for c in man['cases']]
print('   cases: %d → %s' % (len(cases), ', '.join(cases)))
if len(cases) != len(BA.TABS):
    bad('算例数应为 %d（= 页签数），实际 %d' % (len(BA.TABS), len(cases)))

# ---------------------------------------------------------------- 2. 没有裸结束标记
print('2. text/plain / application/json 块内没有裸 </script')
naked = 0
for m in re.finditer(r'<script type="(?:text/plain|application/json)"[^>]*>(.*?)</script>', s, re.S):
    if '</script' in m.group(1).lower():
        naked += 1
if naked:
    bad('%d 个块含裸结束标记' % naked)
else:
    good('全部安全')

# ---------------------------------------------------------------- 3. 页签载荷可逆
print('3. data-emb 载荷 ↔ 原始报告')
embs = {}
for m in re.finditer(r'<script type="text/plain" data-emb="([^"]+)">(.*?)</script>', s, re.S):
    embs[m.group(1)] = m.group(2)
want = {t[0]: t[2] for t in BA.TABS}
if set(embs) != set(want):
    bad('页签集合不符：%s vs %s' % (sorted(embs), sorted(want)))
_e = True
SORT_COLS = ['out', 'arr', 'leave', 'back', 'h', 'lodge', 'total', 'perday']
for sid, d in want.items():
    if sid not in embs:
        continue
    got = BA.unesc_close(embs[sid])
    _f = BA.TABFILES.get(sid) or os.path.join(ROOT, d, 'report.html')
    src = BA.strip_raw(open(_f, encoding='utf-8', newline='').read())
    if got != src:
        bad('%s 还原后与 %s 不一致（%d vs %d 字符）'
            % (sid, os.path.basename(_f), len(got), len(src)))
        _e = False
    elif '<!DOCTYPE html>' not in got:
        bad('%s 还原后不像一份完整报告' % sid)
        _e = False
    # 明细表的八列排序能力是交付契约的一部分，缺一个就说明渲染器退化了
    miss = [c for c in SORT_COLS if ('data-col="%s"' % c) not in src]
    if miss:
        bad('%s 明细表缺可排序列：%s' % (sid, ', '.join(miss)))
        _e = False
if _e:
    good('%d 份载荷逐字还原一致（%.1f MB）' % (len(embs), sum(len(v.encode()) for v in embs.values()) / 1048576))

# 3b 与另一份交付页交叉核对：同一个算例在两页里不能各说一套数
# 配置里给了 crossCheck.page 才做（alias 用来对齐两页不同的页签 id）
print('3b. 载荷 ↔ 交叉核对页')
CC = CFG.get('crossCheck') or {}
if not CC.get('page'):
    print('   — 未配置 crossCheck.page，跳过')
elif not os.path.exists(os.path.join(ROOT, CC['page'])):
    bad('交叉核对页不存在：%s' % CC['page'])
else:
    rs = open(os.path.join(ROOT, CC['page']), encoding='utf-8', newline='').read()
    remb = {}
    for m in re.finditer(r'<script type="text/plain" data-emb="([^"]+)">(.*?)</script>', rs, re.S):
        remb[m.group(1)] = m.group(2)
    alias = CC.get('alias') or {}
    miss, n = [], 0
    for sid in [t[0] for t in BA.TABS]:
        key = alias.get(sid, sid)
        if key not in remb:
            continue                      # 参考页没有这份，不比
        n += 1
        if BA.unesc_close(remb[key]) != BA.unesc_close(embs[sid]):
            miss.append(sid + '(内容不同)')
    if not n:
        bad('交叉核对页里没有任何可比对的载荷（检查 crossCheck.alias）')
    elif miss:
        bad('载荷与 %s 不一致：%s' % (CC['page'], ', '.join(miss)))
    else:
        good('%d 份载荷与 %s 逐字一致' % (n, os.path.basename(CC['page'])))

# ---------------------------------------------------------------- 4. 结构
print('4. 页签 / 面板 / 运行时')
tabs = re.findall(r'<button class="tb[^"]*" data-t="([^"]+)"', s)
panes = re.findall(r'<div id="pane-([^"]+)" class="pane[^"]*"', s)
if tabs != ['cmp'] + [t[0] for t in BA.TABS]:
    bad('页签顺序不符：%s' % tabs)
if panes != ['cmp'] + [t[0] for t in BA.TABS]:
    bad('面板不符：%s' % panes)
_t = True
if s.count('var panes = document.querySelectorAll') != 1:
    bad('惰性 iframe 运行时不唯一')
if s.count('iframe.rp{') != 1:
    bad('iframe 样式缺失')
if _t and ok:
    good('1 个概览 + %d 个报告页签，面板一一对应，运行时唯一' % len(BA.TABS))

# ---------------------------------------------------------------- 5. 标签配平（只算概览正文）
print('5. 概览正文标签配平')
_g = True
OPEN = '<div id="pane-cmp" class="pane show">'
i = s.index(OPEN) + len(OPEN)
j = s.index('</div><!-- /pane-cmp -->')
frag = s[i:j]
for tag in ['div', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'svg', 'span', 'p', 'footer', 'code']:
    a = len(re.findall(r'<%s[\s>]' % tag, frag))
    b = len(re.findall(r'</%s>' % tag, frag))
    if a != b:
        bad('<%s> %d 开 / %d 闭' % (tag, a, b))
        _g = False
if _g:
    good('全部配平')

# ---------------------------------------------------------------- 6. 表格可回溯
print('6. 概览表格 vs season-data.json')
D = json.load(open(os.path.join(ROOT, CFG['data']), encoding='utf-8', newline=''))
CELL = D['cells']
SESS = D['sessions']
RES = D['resorts']
# 档位必须跟 build_season 用同一份（来自配置），写死会把 17 档的页面判成 11 档
BUCKETS = BA.B.BUCKETS

# 6a 异常串（只扫概览正文，运行时的 { } 不算）
for tok in ['NaN', 'undefined', 'Infinity', 'None']:
    n = frag.count(tok)
    if n:
        bad('概览正文出现 %s x%d' % (tok, n))

# 6b 热力表（置顶）：逐格回查数值 + 底色 + 文字色
# 章节名跟着配置走（texts.bucketTitle），写死会在改名后找不到切分点
_BT = CFG.get('texts', {}).get('bucketTitle') or '各场次'
t1 = frag[frag.index('1. %s' % _BT):frag.index('2. 请假天数')]
got = re.findall(r'<td class="hm"( style="[^"]*")?>([\d,]+)</td>', t1)
exp = []
for s_ in SESS:
    for r_ in RES:
        c = CELL.get('%s|%s' % (s_['id'], r_['code']))
        if not c:
            continue
        for b in BUCKETS:
            lst = c['buckets'].get(b)
            if not lst:
                continue
            exp.append((BA.B.cell_style(lst[0]['perDay']), BA.B.money(lst[0]['perDay'])))
if len(got) != len(exp):
    bad('热力表 %d 格，应为 %d 格' % (len(got), len(exp)))
mis = [(i, a, b) for i, (a, b) in enumerate(zip(got, exp)) if tuple(a) != b]
if mis:
    bad('热力表 %d 处不一致，首个：%s' % (len(mis), mis[0]))
elif len(got) == len(exp):
    nd = len(re.findall(r'<td class="na">—</td>', t1))
    good('热力表 %d 格逐格一致（数值 + 底色 + 字色 + 字重），另有 %d 格空档' % (len(got), nd))

# 6c 0/1/2 天三张总表：元/小时 + 元/雪日 + 等效雪时
# 表名跟着配置走（texts.tableLabel），写死会在改名后找不到切分点
_TL = CFG.get('texts', {}).get('tableLabel') or '雪季总表'
SPLIT = [('0', '3. %s · 0 天' % _TL, '4. %s · 1 天' % _TL),
         ('1', '4. %s · 1 天' % _TL, '5. %s · 2 天' % _TL),
         ('2', '5. %s · 2 天' % _TL, '<div class="meta">')]
for b, a0, a1 in SPLIT:
    seg = frag[frag.index(a0):frag.index(a1)]
    got = re.findall(r'<td class="c[^"]*"><b>¥([\d,]+)</b><div class="sub">([\d,]+)/雪日 · ([\d.]+)h</div></td>', seg)
    exp = []
    for s_ in SESS:
        for r_ in RES:
            c = CELL.get('%s|%s' % (s_['id'], r_['code']))
            e = (c or {}).get('buckets', {}).get(b)
            if e:
                exp.append((format(int(round(e[0]['perHour'])), ','),
                            format(int(round(e[0]['perDay'])), ','),
                            '%.1f' % e[0]['hEff']))
    m = [(i, x, y) for i, (x, y) in enumerate(zip(got, exp)) if tuple(x) != y]
    if len(got) != len(exp) or m:
        bad('%s 天档：%d 格 vs 应 %d 格，%d 处不一致%s' % (b, len(got), len(exp), len(m), m[:1]))
    else:
        good('%s 天档总表 %d 格一致（元/小时 · 元/雪日 · 雪时）' % (b, len(got)))

# 6d 折线图：每个雪场每个假档一个点
svg = frag[frag.index('<svg'):frag.index('</svg>')]
ser = BA.B.days_series()
npts = sum(len(v) for v in ser.values())
ncirc = len(re.findall(r'<circle ', svg))
if ncirc != npts:
    bad('折线图 %d 个点，应为 %d 个' % (ncirc, npts))
elif '全场最低' not in svg:
    bad('折线图缺全场最低线')
else:
    good('折线图 %d 个点 = 有数据的雪场×假档组合，含全场最低包络' % ncirc)

print('\n%s' % ('ALL PASS' if ok else 'FAILED'))
sys.exit(0 if ok else 1)
