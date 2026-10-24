#!/usr/bin/env node
'use strict';
/**
 * embed.js — 把「原始数据 + 算法源码」塞进交付的 HTML 里
 *
 * 为什么：交付物只有 HTML。别人（或另一个 agent）拿到 万龙.html，如果只能看渲染后的表，
 * 就没法验证「这条为什么排第 7」，也没法重跑一遍看是不是同样结果。所以把复现所需的输入
 * 和代码原样嵌进页面：解出来就是可以 `node` 跑的文件，跑完可以和页面上的数字逐格对。
 *
 * 存法：<script type="text/plain" data-raw="文件名">。type 不是可执行类型，浏览器不解析、
 * 不执行、不渲染，对首屏没有开销，但 document.querySelectorAll 能完整取到。
 *
 * 唯一要处理的坑：`<\/script` 在 HTML 里是纯文本匹配，数据里只要出现一次就会提前闭合脚本。
 * 所以写入时把 `<\/script` 转成 `<\/script`，读取时还原。清单里写明了这条规则。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RAW_ATTR = 'data-raw';
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * 转义 / 还原。<script> 的结束标记是纯文本匹配，内容里出现一次 `<\/script` 就会提前闭合。
 *
 * 只把 `<\/script` 换成 `<\/script` 是不够的：待嵌的文件本身可能就含有 `<\/script`
 * （embed.js 就是——它自己就在做转义），还原时会被一起还原掉，长度和 sha 都对不上。
 * 所以先把所有反斜杠翻倍，再转义结束标记；还原时按相反顺序做，两步互为逆运算：
 *
 *   转义：  \  →  \\        然后  <\/script → <\/script
 *   还原：  <\/script → <\/script   然后  \\ → \
 */
const escClose = (s) => String(s).replace(/\\/g, '\\\\').replace(/<\/script/gi, '<\\/script');
const unescClose = (s) => String(s).replace(/<\\\/script/gi, '<\/script').replace(/\\\\/g, '\\');

/** 读一个文件；不存在就返回 null（不同算例缺的文件不一样，不该因此中断） */
function readIf(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
}

/**
 * 生成一批 script 块。
 * @param {Array<{name:string, file:string, note?:string}>} specs
 * @returns {{html:string, entries:Array}}
 */
function pack(specs) {
  const blocks = [];
  const entries = [];
  for (const s of specs) {
    const txt = readIf(s.file);
    if (txt == null) continue;
    const body = txt.replace(/^\uFEFF/, '');
    const h = sha(body);
    blocks.push('<script type="text/plain" ' + RAW_ATTR + '="' + s.name + '"'
      + ' data-bytes="' + Buffer.byteLength(body) + '"'
      + ' data-sha256="' + h + '">' + escClose(body) + '<\/script>');
    entries.push({ name: s.name, bytes: Buffer.byteLength(body), sha256: h, note: s.note || '' });
  }
  return { html: blocks.join('\n'), entries };
}

/**
 * 去掉一页里已经嵌好的原始数据块（说明行 + 清单 + data-raw）。
 *
 * 不能用正则去「找 data-raw 块再删」：待嵌的 embed.js 源码里就写着这些标签长什么样，
 * 正则会从那句话开始一路吃到真正的结束标记，把源码截断（踩过一次）。
 * 改成在写入时用一对注释标记圈起来，删除时按标记切——标记本身用拼字符串生成，
 * 源文件里不出现它的字面量，也就不会被自己误伤。
 */
const MARK_S = '<!--RAW-' + 'DATA-BEGIN-->';
const MARK_E = '<!--RAW-' + 'DATA-END-->';

function strip(html) {
  const s = String(html);
  const a = s.indexOf(MARK_S);
  const b = s.lastIndexOf(MARK_E);
  if (a < 0 || b < a) return s;                 // 老页面没有标记：原样返回
  return s.slice(0, a) + s.slice(b + MARK_E.length);
}

/**
 * 算法源码清单：从入口脚本出发，按 require('./x') 递归收集依赖闭包。
 *
 * 手写清单一定会漏——enumerate.js 还要 holidays.js，legs.js 还要 cache.js / variflight.js，
 * 少一个解压出来就 `Cannot find module`。这里让代码自己算，加了新依赖也不会忘。
 */
const ALGO_NOTE = {
  'graphcore.js': '图与 DFS：走边、服务窗、雪时窗口',
  'legs.js': '建路径表：航班/铁路/地面边展开成 legs.json，并写 legs.csv',
  'cache.js': 'legs.js 的航班缓存读写（复现只读 legs.json，不会真的联网）',
  'variflight.js': '航班查询客户端（仅 legs.js 需要）',
  'mcp_json.js': 'variflight.js 的 JSON-RPC 封装（仅 legs.js 需要）',
  'holidays.js': '年假口径：法定节假日与调休判定',
  'enumerate.js': '穷举 + 剪枝 + 配对 + 排序，产出 top.csv / top.json',
  'design.js': '页面视觉与组件（渲染层）',
  'embed.js': '把原始数据与源码嵌回 HTML（渲染层）',
  'render.js': '本页的渲染脚本',
};

function closureOf(entries) {
  const out = [];
  const seen = new Set();
  const walk = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const file = path.join(__dirname, name);
    if (!fs.existsSync(file)) return;
    out.push(name);
    const src = fs.readFileSync(file, 'utf8');
    const re = /require\((['"])\.\/([A-Za-z0-9_.\/-]+)\1\)/g;
    let m;
    while ((m = re.exec(src))) walk(m[2].endsWith('.js') ? m[2] : m[2] + '.js');
  };
  entries.forEach(walk);
  return out;
}

const ALGO = closureOf(['enumerate.js', 'render.js']).map((n) => ({
  name: 'algo/' + n,
  file: path.join(__dirname, n),
  note: ALGO_NOTE[n] || '',
}));

const HOWTO = [
  '1. 取出所有 <script type="text/plain" data-raw="…"> 的 textContent，做两步还原：先把 "<\\/script" 换回 "<\/script"，再把每两个连续反斜杠 "\\\\" 换成一个 "\\"。两步缺一不可（顺序也不能反），否则含反斜杠的源码会差字节。',
  '2. 得到 case.json / network.json / legs.json / legs.csv / top.csv 与 algo/*.js。',
  '3. 把 algo/*.js 和 case.json、legs.json 放进同一个目录——脚本之间用 ./x 互相引用，分开放会找不到模块。',
  '4. 验算：在该目录跑 `node enumerate.js case.json --outdir out`，产出的 out/top.csv 应与本页内嵌的 top.csv 逐行一致（页面内嵌版去掉了 UTF-8 BOM，其余逐字相同）。',
  '5. 页面上的每个数字都只来自 top.csv（元/雪日 = 总费用 ÷（有效雪时 ÷ 单场时长）；元/小时 = 总费用 ÷ 有效雪时），没有手工写入的结论。',
  '6. 不要求从头重建路径表；若要重建，跑 `node legs.js case.json`——它会读 network.json 与航班缓存（飞常准快照，不在本页），所以航班边可能随查询日期变化，铁路与地面边完全由 network.json 决定、可逐字复现。',
];

/**
 * 把原始数据块插到 </body> 之前。
 * @param {string} html
 * @param {object} o
 * @param {string}   o.dir   算例目录（case.json 所在）
 * @param {string}   o.title
 * @param {string[]} o.algo  额外要嵌的算法文件（绝对路径），跑在 ALGO 之后
 * @param {string[]} o.extra 额外要嵌的数据文件（绝对路径）
 * @param {string}   o.kind  'resort' | 'compare'
 */
function attach(html, o) {
  // 对比页要把六个算例全嵌进来，所以支持多目录；单页只传 dir。
  const groups = o.dirs && o.dirs.length
    ? o.dirs.map((d) => ({ prefix: 'raw/' + d.prefix + '/', dir: d.dir, title: d.title }))
    : [{ prefix: '', dir: o.dir, title: o.title }];

  const specs = [];
  for (const g of groups) {
    const dir = g.dir;
    specs.push(
      { name: g.prefix + 'case.json', file: path.join(dir, 'case.json'), note: (g.title || '') + ' 算例参数：窗口、住宿单价、请假分界、雪场营业时间' },
      { name: g.prefix + 'network.json', file: path.join(dir, 'network.json'), note: (g.title || '') + ' 路径表：节点、航班/铁路/地面边、服务窗' },
      { name: g.prefix + 'legs.csv', file: path.join(dir, 'legs.csv'), note: (g.title || '') + ' 交通分段总表（人读版）：每条边的起止、花费、通行窗' },
      { name: g.prefix + 'legs.json', file: path.join(dir, 'legs.json'), note: (g.title || '') + ' 交通分段总表（机读版）：枚举真正消费的边表' },
      { name: g.prefix + 'top.csv', file: path.join(dir, 'top.csv'), note: (g.title || '') + ' 组合表：各档前 30 名，页面上每个数字都出自这里' },
    );
  }
  for (const f of (o.extra || [])) specs.push({ name: path.basename(f), file: f, note: '' });
  for (const f of (o.extraJson || [])) specs.push({ name: path.basename(f), file: f, note: '' });

  const algoSpecs = ALGO.map((a) => ({ name: a.name, file: a.file, note: a.note }));
  for (const extra of (o.algoExtra || [])) {
    algoSpecs.push({ name: 'algo/' + path.basename(extra), file: extra, note: '对比页渲染脚本' });
  }

  const data = pack(specs);
  const algo = pack(algoSpecs);

  const manifest = {
    schema: 'ski-trip-repro/1',
    kind: o.kind || 'resort',
    title: o.title || '',
    generatedAt: new Date().toISOString(),
    caseDir: groups.length === 1 ? path.basename(groups[0].dir) : null,
    cases: groups.map((g) => ({ prefix: g.prefix ? g.prefix.replace(/\/$/, '') : '.', dir: path.basename(g.dir), title: g.title || '' })),
    session: o.session || null,
    counts: o.counts || null,
    selection: o.selection || null,
    files: data.entries.concat(algo.entries),
    unescape: '两步，缺一不可：① 把 "<\\/script" 换回 "<\/script"；② 把每个 "\\\\"（两个反斜杠）换成一个 "\\"',
    howto: HOWTO,
  };

  const block = '<script type="application/json" id="raw-manifest">'
    // 清单是 JSON，不能走 escClose（那会把 JSON 自己的 \ 转义再翻一倍，JSON.parse 直接报错）。
    // 只需要挡住会让 <script> 提前闭合的 "</"：换成 JSON 里合法的 "<\/"。
    + JSON.stringify(manifest, null, 1).replace(/<\//g, '<\\/')
    + '<\/script>\n' + data.html + '\n' + algo.html;

  const note = '<div class="rawdata-note sub" style="margin-top:18px">'
    + '本页内嵌了原始数据与算法源码（交通分段总表、路径表、组合表、枚举脚本），'
    + '只拿这一个文件就能验算页面上每个数字。在源码里检索 <code>data-raw</code> 可取到，'
    + '清单见 <code>#raw-manifest</code>。</div>\n';

  // 插到最后一个 </body> 之前：嵌进来的原文里也可能出现这个结束标记（比如被嵌页的源码），
  // 用第一个匹配就会插到别人的数据中间去。
  const close = html.lastIndexOf('</body>');
  const payload = MARK_S + '\n' + note + block + '\n' + MARK_E + '\n';
  return close < 0 ? html + '\n' + payload : html.slice(0, close) + payload + html.slice(close);
}

module.exports = { attach, strip, pack, escClose, unescClose, HOWTO, ALGO };
