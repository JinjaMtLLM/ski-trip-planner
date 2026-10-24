# -*- coding: utf-8 -*-
"""就地修补一份已生成的交付页：把内嵌的 algo/*.js 换成当前 <root>/scripts/ 的版本，
并重算所有 data-raw 块的 data-bytes / data-sha256 与 #raw-manifest。

    python sync_algo.py                       # 用 season.config.json 的 out
    python sync_algo.py my-season.json
    python sync_algo.py my-season.json --dry  # 只报差异，不写盘

什么时候需要它：
  · 改了 scripts/*.js 之后要回填一份旧页面（不想整页重跑 build.py，23 MB 要几分钟）
  · 只想刷新页面里那几份算法源码

什么时候不需要：
  · 正常交付走 build.py 全量重建，algo 天然是最新的，不用再补一刀。

为什么要做：内嵌的 algo 若落后于 scripts/，别人拿这份页面重跑会得到不同数字；
data-bytes 属性也会和内容脱节，页面自己就自相矛盾。

只处理清单里确实以 algo/ 开头的那几项——scripts/ 下的 doctor.js / planner.js 之类
不进页面，硬按目录遍历会报一堆假的「出现 0 次」。
"""
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_season as B                                     # noqa: E402

MAN_BEGIN = '<!--RAW-DATA-BEGIN-->'


def esc(t):
    """与 embed.js 的 escClose 同构：先翻倍反斜杠，再转义脚本结束标记。"""
    return re.sub(r'(?i)</script', lambda m: '<\\/script', t.replace('\\', '\\\\'))


def unesc(t):
    """逆运算，必须逆序两步（先还原结束标记，再把双反斜杠折回单反斜杠）。"""
    return t.replace('<\\/script', '</script').replace('\\\\', '\\')


def _manifest_span(s):
    b = s.rindex(MAN_BEGIN)
    i = s.index('id="raw-manifest"', b)
    a = s.index('>', i) + 1
    return a, s.index('</script>', a)


def _block(s, name):
    """按 data-raw="<name>" 定位一个原始数据块，返回 (属性起点, 内容起点, 内容终点)。"""
    key = 'data-raw="%s"' % name
    j = s.rfind(key)
    if j < 0:
        raise SystemExit('页面里没有这个块：%s' % name)
    a = s.index('>', j) + 1
    return j, a, s.index('</script>', a)


def sync(page, src, dry=False):
    s = open(page, encoding='utf-8', newline='').read()
    before = len(s.encode())
    if MAN_BEGIN not in s:
        raise SystemExit('页面里没有 RAW-DATA 区，先用 build.py 生成')

    a, e = _manifest_span(s)
    man = json.loads(s[a:e])

    # ------------------------------------------------------------ 1. 换 algo 内容
    changed, missing = [], []
    for f in man['files']:
        name = f['name']
        if not name.startswith('algo/'):
            continue
        fn = name[len('algo/'):]
        sp = os.path.join(src, fn)
        if not os.path.exists(sp):
            missing.append(fn)
            continue
        j, a2, e2 = _block(s, name)
        old = unesc(s[a2:e2])
        with open(sp, encoding='utf-8', newline='') as fh:
            new = fh.read()
        if old == new:
            continue
        s = s[:a2] + esc(new) + s[e2:]
        changed.append((name, len(old.encode()), len(new.encode())))

    print('替换 %d 个算法块：' % len(changed))
    for n, o, w in changed:
        print('  %-22s %7d → %7d' % (n, o, w))
    if missing:
        print('  ⚠ scripts/ 里找不到（保留原样）：%s' % ' '.join(missing))

    # ------------------------------------------------------------ 2. 同步属性与清单
    sync_attr, sync_man = [], []
    for f in man['files']:
        name = f['name']
        j, a2, e2 = _block(s, name)
        c = unesc(s[a2:e2]).encode()
        nb, nh = len(c), hashlib.sha256(c).hexdigest()

        m = re.search(r'data-bytes="(\d+)" data-sha256="([0-9a-f]+)"', s[j:e2])
        if not m:
            raise SystemExit('缺属性：%s' % name)
        if int(m.group(1)) != nb or m.group(2) != nh:
            seg = s[j:e2].replace(
                'data-bytes="%s" data-sha256="%s"' % (m.group(1), m.group(2)),
                'data-bytes="%d" data-sha256="%s"' % (nb, nh), 1)
            s = s[:j] + seg + s[e2:]
            sync_attr.append(name)
        if f['bytes'] != nb or f['sha256'] != nh:
            f['bytes'], f['sha256'] = nb, nh
            sync_man.append(name)

    print('属性同步 %d 条：%s' % (len(sync_attr), sync_attr or '—'))
    print('清单同步 %d 条：%s' % (len(sync_man), sync_man or '—'))

    a, e = _manifest_span(s)                 # 长度已变，重新定位
    body = json.dumps(man, ensure_ascii=False, indent=1).replace('</', '<\\/')
    s = s[:a] + body + s[e:]

    if dry:
        print('[dry] 页面 %d → %d 字节，未写盘' % (before, len(s.encode())))
        return changed
    with open(page, 'w', encoding='utf-8', newline='') as fh:
        fh.write(s)
    print('页面 %d → %d 字节' % (before, len(s.encode())))
    return changed


def main():
    pos = [a for a in sys.argv[1:] if not a.startswith('--')]
    cfg = B.load_cfg(pos[0] if pos else os.path.join(HERE, 'season.config.json'))
    page = os.path.join(cfg['root'], cfg['out'])
    src = os.path.join(cfg['root'], 'scripts')
    if not os.path.exists(page):
        raise SystemExit('找不到页面：%s（先用 build.py 生成）' % page)
    if not os.path.isdir(src):
        raise SystemExit('找不到脚本目录：%s' % src)
    print('页面 →', page)
    print('算法 →', src)
    sync(page, src, dry='--dry' in sys.argv)


if __name__ == '__main__':
    main()
