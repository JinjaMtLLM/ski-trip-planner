# -*- coding: utf-8 -*-
"""校验雪季页：数字回查、标签闭合、异常串。"""
import json, re, os, html

ROOT = 'D:/Project/other/ski-trip-planner'
p = os.path.join(ROOT, 'dist/雪季对比-2026-27.html')
s = open(p, encoding='utf-8', newline='').read()
D = json.load(open(os.path.join(ROOT, 'tmp/season-data.json'), encoding='utf-8'))
CELL = D['cells']

print('文件 %d 字节 / %d 字符' % (len(s.encode()), len(s)))

bad = []
for tok in ['NaN', 'undefined', 'Infinity', 'None', '{', '}']:
    n = s.count(tok)
    if n:
        bad.append('%s x%d' % (tok, n))
print('异常串:', bad or '无')

# 标签平衡
for tag in ['div', 'table', 'tr', 'td', 'th', 'svg', 'span']:
    o = len(re.findall(r'<%s[\s>]' % tag, s))
    c = s.count('</%s>' % tag)
    flag = '' if o == c else '  <<< 不平衡'
    print('  <%s> %d / </%s> %d%s' % (tag, o, tag, c, flag))

# 数字回查：表 1 的每个 0 天档单元格
t1 = s[s.index('1. 雪季总表'):s.index('2. 雪季总表')]
cells = re.findall(r'<td class="c[^"]*"><b>¥([\d,]+)</b><div class="sub">([\d,]+)/雪日 · ([\d.]+)h</div></td>', t1)
exp = []
for sid in ['w1128', 'w1204', 'w1219', 'w1226', 'ny']:
    for r in D['resorts']:
        c = CELL.get('%s|%s' % (sid, r['code']))
        e = (c or {}).get('buckets', {}).get('0')
        if e:
            exp.append((format(int(round(e[0]['perHour'])), ','), format(int(round(e[0]['perDay'])), ','),
                        '%.1f' % e[0]['hEff']))
print('表1 单元格 %d 个，应为 %d 个' % (len(cells), len(exp)))
mism = [(i, a, b) for i, (a, b) in enumerate(zip(cells, exp)) if tuple(a) != b]
print('  不一致:', mism or '无')

# 元/雪日 全档位表回查
t4 = s[s.index('4. 各场次'):s.index('5. 各场次')]
rows = re.findall(r'<td class="c rc"[^>]*><span class="dot"></span>([^<]+)</td>((?:<td class="c[^"]*">[^<]*</td>)+)', t4)
print('表4 行数', len(rows))
ncell = 0
for name, block in rows:
    vals = re.findall(r'<td class="c[^"]*">([^<]*)</td>', block)
    ncell += sum(1 for v in vals if v != '—')
print('  非空单元格', ncell)

# 表 5 方案明细行数
t5 = s[s.index('5. 各场次'):s.index('6. 每个格子')]
print('表5 行数', len(re.findall(r'<td class="rt">', t5)) // 2)

# 表 6 覆盖行数
t6 = s[s.index('6. 每个格子'):]
print('表6 行数', t6.count('<td class="rt">'))

# 每个 cells 都要在页面里出现（按 0 天档的元/雪日）
miss = []
for key, c in CELL.items():
    e = c['buckets'].get('0')
    if not e:
        continue
    if format(int(round(e[0]['perDay'])), ',') not in s:
        miss.append(key)
print('0 天档元/雪日缺失:', miss or '无')
print('OK')
