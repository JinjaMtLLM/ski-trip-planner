# -*- coding: utf-8 -*-
"""把各算例的 top.json 汇总成概览页要用的 season-data.json。

输入只有算例目录（每个目录里要有 enumerate.js 产出的 top.json），
不读任何 HTML、不重算价格——数字全部原样搬运，避免第二套口径。

用法：
    python collect.py [season.config.json] [--out <season-data.json>]

配置里的 sessions[].cases 是 {雪场码: 算例目录}，目录相对配置里的 root。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CFG = os.path.join(HERE, 'season.config.json')

# top.json 里每条行程要保留的字段：概览页的表格与图表只认这些
KEEP = ('perDay', 'perHour', 'hEff', 'total', 'transport', 'lodge', 'days',
        'resortN', 'hotelN', 'arriveResort', 'leaveResort',
        'outRoute', 'retRoute', 'outRefs', 'retRefs', 'tms', 'tmsOut')


def load_cfg(path):
    with open(path, encoding='utf-8', newline='') as f:
        cfg = json.load(f)
    root = cfg.get('root') or os.path.dirname(os.path.dirname(HERE))
    cfg['root'] = os.path.abspath(root)
    return cfg


def cell_of(top_path):
    """一个算例 → 概览页的一个格子。"""
    with open(top_path, encoding='utf-8', newline='') as f:
        T = json.load(f)
    if 'top' not in T:
        raise SystemExit('%s 不像 top.json（缺 top 键）' % top_path)
    buckets = {}
    for b in T.get('buckets') or []:
        rows = T['top'].get(str(b)) or []
        if not rows:
            continue
        buckets[str(b)] = [{k: it.get(k) for k in KEEP} for it in rows]
    return {
        'buckets': buckets,
        'counts': T.get('counts'),
        'legsCount': T.get('legsCount'),
        'rawItineraries': T.get('rawItineraries'),
    }


def collect(cfg, top_n=None):
    root = cfg['root']
    cells, missing = {}, []
    for s in cfg['sessions']:
        for code, rel in (s.get('cases') or {}).items():
            d = os.path.join(root, rel)
            tp = os.path.join(d, 'top.json')
            if not os.path.exists(tp):
                missing.append('%s|%s → %s' % (s['id'], code, rel))
                continue
            c = cell_of(tp)
            if top_n:
                c['buckets'] = {k: v[:top_n] for k, v in c['buckets'].items()}
            cells['%s|%s' % (s['id'], code)] = c
    if missing:
        print('⚠ 缺 top.json 的格子（已跳过）：')
        for m in missing:
            print('   ', m)
    return {
        'resorts': cfg['resorts'],
        'sessions': [{'id': s['id'], 'label': s['label'],
                      'note': s.get('note', ''), 'cases': s.get('cases') or {}}
                     for s in cfg['sessions']],
        'cells': cells,
    }


def main():
    args = [a for a in sys.argv[1:]]
    cfg_path = DEFAULT_CFG
    out = None
    if '--out' in args:
        i = args.index('--out')
        out = args[i + 1]
        del args[i:i + 2]
    if args and not args[0].startswith('-'):
        cfg_path = args[0]
    cfg = load_cfg(cfg_path)
    data = collect(cfg)
    out = out or os.path.join(cfg['root'], cfg['data'])
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'w', encoding='utf-8', newline='') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    nb = sum(len(c['buckets']) for c in data['cells'].values())
    print('data → %s（%d 个格子 / %d 个假档 / %d 字节）'
          % (out, len(data['cells']), nb, os.path.getsize(out)))


if __name__ == '__main__':
    main()
