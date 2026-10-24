# -*- coding: utf-8 -*-
"""生成「雪季对比」页签版：概览 + N 份报告页签 + N 个算例的原始数据。

版式由 shell/style.css + shell/runtime.js 决定（从已交付的对比页里抽出来的）：
  .tabbar（sticky）+ .pane#pane-cmp（概览）+ .pane.rp-pane × N（报告 iframe）
  + <script type="text/plain" data-emb="…"> 惰性载荷 + embed.js 的 data-raw / #raw-manifest。

步骤：build shell → node attach.js（塞原始数据）→ 回填页签载荷 → 校验。
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_season as B                                    # noqa: E402

# 外壳样式与运行时是独立文件，不再从某份已存在的交付页里抠——
# 换一次雪季就找不到那份参考页了，模板也就不可复用了。
SHELL_DIR = os.path.join(HERE, 'shell')

CFG = {}
TABS = []          # [(页签 id, 页签文字, 算例目录（相对仓库根）, 雪场码)]
GROUPS = []        # [(组标签, 从第几个页签开始)]
OUT = None


def configure(cfg=None):
    """cfg 可以是配置 dict、配置文件路径，或 None（读默认 season.config.json）。"""
    global CFG, TABS, GROUPS, OUT
    if isinstance(cfg, str):
        cfg = B.load_cfg(cfg)
    cfg = cfg or B.load_cfg()
    CFG = cfg
    TABS = [(t['id'], t['label'], t['dir'], t['resort']) for t in cfg['tabs']]
    GROUPS = [(g['label'], int(g['at'])) for g in (cfg.get('groups') or [])]
    OUT = os.path.join(cfg['root'], cfg['out'])
    return cfg


MS, ME = '<!--RAW-' + 'DATA-BEGIN-->', '<!--RAW-' + 'DATA-END-->'


# ------------------------------------------------------------------ 转义
def esc_close(s):
    """与 embed.js 的 escClose 同构：先把反斜杠翻倍，再转义脚本结束标记。"""
    return re.sub(r'(?i)</script', lambda m: '<\\/script', s.replace('\\', '\\\\'))


def unesc_close(s):
    """逆运算，必须逆序两步（先还原结束标记，再把双反斜杠折回单反斜杠）。"""
    return s.replace('<\\/script', '</script').replace('\\\\', '\\')


def strip_raw(html):
    a, b = html.find(MS), html.rfind(ME)
    if a < 0 or b < a:
        return html
    return html[:a] + html[b + len(ME):]


# ------------------------------------------------------------------ CSS
def season_css():
    """概览页自带样式，去掉已被参考页覆盖的部分（body / .wrap / h1 / .lead / h2 / footer）。"""
    css = B.CSS
    drop = [r'\*\{[^}]*\}', r'\nbody\{[^}]*\}', r'\n\.wrap\{[^}]*\}',
            r'\nh1\{[^}]*\}', r'\n\.lead\{[^}]*\}', r'\nh2\{[^}]*\}',
            r'\nfooter\{[^}]*\}', r'\nfooter a\{[^}]*\}', r'\nfooter a:hover\{[^}]*\}']
    for d in drop:
        css = re.sub(d, '\n', css)
    # 概览页的表格类改名为 .sgrid：参考页的 table.grid 带 table-layout:fixed 与右对齐，
    # 直接撞车会把路径明细表挤变形。
    css = css.replace('table.grid', 'table.sgrid')
    reset = """
/* 概览页表格自带边框与圆角，别再叠参考页给 table 加的那一层 */
#pane-cmp .tw table{border:0;border-radius:0;background:transparent}
#pane-cmp table.sgrid{border-collapse:collapse;width:100%}
#pane-cmp .tw{border:1px solid #e6e6e3}
/* 14 个页签（1 概览 + 6 窗口 + 7 元旦）：把 .tb 收紧一档，两行内排得下 */
.tabbar{gap:5px;padding:9px 0 10px;margin:-9px 0 16px}
.tb{padding:6px 10px;font-size:12px;gap:5px}
.tb i{width:7px;height:7px}
.tbg{font-size:10.5px;font-weight:700;letter-spacing:.6px;color:#8b98a5;
 padding:0 3px 0 9px;align-self:center;white-space:nowrap}
.tbg:first-of-type{padding-left:0}
/* 两组之间强制换行：页签多了以后挤一行会掉一个孤儿到第二行，不如按组整齐断成两行 */
.tbr{flex:0 0 100%;height:0;margin:0;padding:0}
.tabbar .tbsep{font-size:11px}
"""
    return css.strip() + '\n' + reset


def ref_style():
    """外壳基础样式（表格、卡片、页签、iframe 容器）。"""
    with open(os.path.join(SHELL_DIR, 'style.css'), encoding='utf-8', newline='') as f:
        return f.read().strip()


def ref_runtime():
    """页签切换 + 惰性 iframe 运行时，原样塞进页面。"""
    with open(os.path.join(SHELL_DIR, 'runtime.js'), encoding='utf-8', newline='') as f:
        return f.read().strip()


# ------------------------------------------------------------------ 页
def build_shell():
    frag = '\n'.join(B.sections())
    frag = frag.replace('class="grid', 'class="sgrid')

    tx = CFG.get('texts') or {}
    cells = sum(len(s.get('cases') or {}) for s in (B.D.get('sessions') or []))
    ref = CFG.get('refPage') or ''
    hint = tx.get('hint') or ('本页内嵌了 {tabs} 份完整报告页签和 {cells} 个算例的原始交通数据，'
                             '清单见页尾 <code>#raw-manifest</code>。')
    note = '<p class="hint">%s</p>' % hint.format(tabs=len(TABS), cells=cells, ref=ref)
    k = frag.rfind('<footer>')
    frag = frag[:k] + note + '\n' + frag[k:]

    tb = ['<div class="tabbar">',
          '  <button class="tb on" data-t="cmp">雪季对比</button>']
    for n, (sid, label, _dir, code) in enumerate(TABS):
        for gname, at in GROUPS:
            if at == n:
                if n:
                    tb.append('  <span class="tbr"></span>')
                tb.append('  <span class="tbg">%s</span>' % gname)
        tb.append('  <button class="tb" data-t="%s" style="--c:%s"><i></i>%s</button>'
                  % (sid, B.COLOR[code], label))
    tb.append('  <span class="tbsep">%s</span>' % B.esc(tx.get('tabNote')
              or '%d 份报告已嵌在本页，切页签即可' % len(TABS)))
    tb.append('</div>')

    panes = ''.join('<div id="pane-%s" class="pane rp-pane"></div>\n' % t[0] for t in TABS)

    p = ['<!DOCTYPE html>',
         '<html lang="zh-CN"><head><meta charset="utf-8">',
         '<meta name="viewport" content="width=device-width,initial-scale=1">',
         '<title>%s</title>' % B.esc(CFG.get('pageTitle')
                                   or '%s（含 %d 份报告页签）' % (CFG.get('title') or '雪季对比', len(TABS))),
         '<style>',
         ref_style(),
         season_css(),
         '</style>',
         '</head><body><div class="wrap">',
         '\n'.join(tb),
         '<div id="pane-cmp" class="pane show">',
         frag,
         '</div><!-- /pane-cmp -->',
         panes,
         '<!--EMB-PAYLOADS-->',
         ref_runtime(),
         '</div></body></html>']
    s = '\n'.join(p)
    # 中间产物落 tmp/（gitignored）：attach.js 要读它，回填载荷也在这份文件上做
    keep = os.path.join(CFG['root'], 'tmp', 'season_shell.html')
    os.makedirs(os.path.dirname(keep), exist_ok=True)
    open(keep, 'w', encoding='utf-8', newline='').write(s)
    print('shell →', keep, len(s.encode()), 'bytes')
    return s


def payloads():
    out = []
    for sid, label, d, _code in TABS:
        f = os.path.join(CFG['root'], d, 'report.html')
        raw = open(f, encoding='utf-8', newline='').read()
        body = esc_close(strip_raw(raw))
        assert '</script' not in body.lower(), (d, 'unescaped close tag')
        out.append('<script type="text/plain" data-emb="%s">%s</script>' % (sid, body))
        print('  payload %-9s %-22s %8.2f MB' % (sid, d, len(body.encode()) / 1048576))
    return out


def main():
    if not CFG:                 # 已由 build.py 配过就别再读默认配置
        configure()
    B.configure(CFG)
    build_shell()
    print('payloads:')
    pl = payloads()

    # 原始数据由 node 侧的 embed.js 塞（它还要写 #raw-manifest 与 sha256）
    os.system('cd "%s" && node "%s"' % (CFG['root'].replace('\\', '/'),
                                        os.path.join(HERE, 'attach.js').replace('\\', '/')))

    s = open(OUT, encoding='utf-8', newline='').read()
    assert s.count('<!--EMB-PAYLOADS-->') == 1, 'placeholder 丢了'
    s = s.replace('<!--EMB-PAYLOADS-->', '\n'.join(pl))
    open(OUT, 'w', encoding='utf-8', newline='').write(s)
    print('wrote', OUT, len(s.encode()), 'bytes')


if __name__ == '__main__':
    main()
