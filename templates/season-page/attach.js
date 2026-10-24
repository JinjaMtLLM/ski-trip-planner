'use strict';
/**
 * attach.js — 把每个算例的原始交通数据塞进雪季页。
 *
 * 只做 embed.js 那一件事：读 tmp/season_shell.html → attach() → 写 cfg.out。
 * 页签载荷（data-emb）由 Python 侧在 attach 之后回填：载荷里含字面量 </body>，
 * 先塞载荷会让 attach() 的 lastIndexOf('</body>') 命中载荷内部，把清单插进别人的数据中间。
 *
 * 用法：node attach.js [season.config.json]
 * 算例目录取自配置的 tabs[].dir（相对 root），标题用 tabs[].label。
 */
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const ROOT = path.dirname(path.dirname(HERE));          // templates/season-page → 仓库根
const cfgPath = process.argv[2] || path.join(HERE, 'season.config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const base = cfg.root ? path.resolve(cfg.root) : ROOT;

const embed = require(path.join(base, 'scripts', 'embed.js'));

const SHELL = path.join(base, 'tmp', 'season_shell.html');
const OUT = path.join(base, cfg.out);

const dirs = (cfg.tabs || []).map((t) => ({
  prefix: t.id,
  dir: path.join(base, t.dir),
  title: t.label + (t.resort ? ' · ' + t.resort : ''),
}));

const missing = dirs.filter((d) => !fs.existsSync(d.dir));
if (missing.length) {
  console.error('算例目录不存在：');
  missing.forEach((d) => console.error('  ' + d.prefix + ' → ' + d.dir));
  process.exit(1);
}

const shell = fs.readFileSync(SHELL, 'utf8');
const out = embed.attach(shell, {
  kind: 'compare',
  title: cfg.attachTitle || (cfg.title || '雪季对比') + '（多窗口 × 多雪场）',
  dirs,
  counts: {
    sessions: (cfg.sessions || []).length,
    resorts: (cfg.resorts || []).length,
    cells: dirs.length,
    cases: dirs.length,
    reports: dirs.length,
  },
  selection: {
    note: (cfg.sessions || []).length + ' 个窗口场次，共 ' + dirs.length + ' 份完整报告页签',
    tabs: dirs.map((d) => d.prefix),
  },
});

fs.writeFileSync(OUT, out, 'utf8');
console.log('attached →', OUT, Buffer.byteLength(out), 'bytes');
