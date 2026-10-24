# -*- coding: utf-8 -*-
"""一条命令出「多场次对比」交付页。

    python build.py                          # 用 season.config.json
    python build.py my-season.json           # 换一份配置
    python build.py --no-collect             # 跳过重算 season-data.json（已有数据时更快）
    python build.py --no-verify              # 不跑校验（只出页面）

做四件事，顺序不能换：
  1. collect  —— 各算例的 top.json → season-data.json（概览页唯一的数源）
  2. shell    —— 概览正文 + 页签 + 空面板 → tmp/season_shell.html
  3. attach   —— embed.js 把原始交通数据与 algo 源码塞进去，写 #raw-manifest
  4. payload  —— 回填页签载荷（必须在 attach 之后，见 build_season_all.py 的注释）
最后跑 verify_season_all.py 六节校验。

前置：每份报告已经用 render.js 生成好（<tabs[].dir>/report.html），
     每份 top.json 已经用 enumerate.js 生成好。
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import build_season as B            # noqa: E402
import build_season_all as BA       # noqa: E402
import collect as C                 # noqa: E402


def main():
    argv = sys.argv[1:]
    cfg_path = next((a for a in argv if not a.startswith('-')),
                    os.path.join(HERE, 'season.config.json'))
    if not os.path.exists(cfg_path):
        raise SystemExit('找不到配置：%s' % cfg_path)

    cfg = B.load_cfg(cfg_path)
    print('配置 →', cfg_path)

    if '--no-collect' not in argv:
        data = C.collect(cfg)
        dp = os.path.join(cfg['root'], cfg['data'])
        os.makedirs(os.path.dirname(dp), exist_ok=True)
        with open(dp, 'w', encoding='utf-8', newline='') as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        print('data → %s（%d 个格子）' % (dp, len(data['cells'])))
    elif not os.path.exists(os.path.join(cfg['root'], cfg['data'])):
        raise SystemExit('--no-collect 但 %s 不存在' % cfg['data'])

    BA.configure(cfg)
    B.configure(cfg)
    BA.main()

    if '--no-verify' not in argv:
        print('\n校验：')
        r = subprocess.run([sys.executable, os.path.join(HERE, 'verify_season_all.py')],
                           cwd=cfg['root'])
        if r.returncode != 0:
            raise SystemExit('校验未通过')


if __name__ == '__main__':
    main()
