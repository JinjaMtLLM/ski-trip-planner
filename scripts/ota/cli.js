#!/usr/bin/env node
/**
 * cli.js —— OTA 补数的唯一入口。
 *
 *   node scripts/ota/cli.js cases/jjs-cny/case.json              # 只桥接已有明细
 *   node scripts/ota/cli.js cases/jjs-cny/case.json --fetch       # 先抓再桥接
 *   node scripts/ota/cli.js cases/jjs-cny/case.json --check       # 只体检环境
 *
 * 干的事：读 case.json 的 flightQueries → （可选）调 fetch.py 抓 OTA 明细
 * → 写成 legs.js 认识的缓存条目。之后 `node scripts/legs.js <case.json>`
 * 一行都不用改，它会照常从缓存里读航班。
 *
 * 为什么要这一层：飞常准 1 分/次、100 分/月，且没有退改与行李额；OTA 免费、
 * 给中转停留分钟，但不给时刻表结构、也没有「按 SQL 筛选」的概念。
 * 两边都归一到「飞常准缓存条目」这一种形态，下游引擎就只认一种输入。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SUBMODULE = path.join(ROOT, 'third_party', 'ticket-monitoring');
const DEFAULT_OUT = path.join(ROOT, 'tmp', 'ota', 'out');

// ── 参数 ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { _: [], ota: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ota') { o.ota.push(argv[++i]); continue; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      o[k] = v;
      continue;
    }
    o._.push(a);
  }
  return o;
}

// ── 环境体检 ───────────────────────────────────────────────────────────
function submoduleInfo() {
  if (!fs.existsSync(path.join(SUBMODULE, 'crawlers'))) {
    return { ok: false, reason: 'submodule 未初始化（git submodule update --init --recursive）' };
  }
  const r = spawnSync('git', ['-C', SUBMODULE, 'rev-parse', '--short', 'HEAD'],
    { encoding: 'utf8' });
  const commit = (r.stdout || '').trim();
  const dirty = (spawnSync('git', ['-C', SUBMODULE, 'status', '--porcelain'],
    { encoding: 'utf8' }).stdout || '').trim();
  return { ok: true, commit, dirty: Boolean(dirty) };
}

/** 找一个能 `import httpx, playwright` 的解释器。子模块的爬虫只要这两个包。
 *
 * 顺序：显式指定 → 仓库内 .venv-ota → PATH 上的 python → WorkBuddy 托管环境。
 * 托管环境放最后：本机装了就直接能用，换台机器自动跳过，不写死路径。 */
function findPython() {
  const win = process.platform === 'win32';
  const exe = win ? 'Scripts/python.exe' : 'bin/python';
  const cands = [];
  if (process.env.SKI_OTA_PYTHON) cands.push([process.env.SKI_OTA_PYTHON, []]);
  cands.push([path.join(ROOT, '.venv-ota', exe), []]);
  cands.push([win ? 'python' : 'python3', []]);
  cands.push(['python3', []]);
  if (win) cands.push(['py', ['-3']]);
  const envs = path.join(require('os').homedir(), '.workbuddy-ai', 'binaries', 'python', 'envs');
  try {
    for (const d of fs.readdirSync(envs)) cands.push([path.join(envs, d, exe), []]);
  } catch (_) { /* 没有就算了 */ }

  for (const [cmd, pre] of cands) {
    if (cmd.includes(path.sep) && !fs.existsSync(cmd)) continue;
    const r = spawnSync(cmd, [...pre, '-c', 'import httpx, playwright'], { encoding: 'utf8' });
    if (r.status === 0) {
      const v = spawnSync(cmd, [...pre, '-c', 'import sys;print(sys.version.split()[0])'],
        { encoding: 'utf8' });
      return { cmd, pre, version: (v.stdout || '').trim() };
    }
  }
  return null;
}

// ── 抓取 ───────────────────────────────────────────────────────────────
function runFetch(py, q, opts) {
  const dates = q.dates && q.dates.length ? q.dates : [q.date];
  const out = path.join(opts.out, `${q.from}-${q.to}.json`);
  const argv = [
    path.join(__dirname, 'fetch.py'),
    '--from', q.from, '--to', q.to,
    '--dates', dates.join(','),
    '--out', out,
    '--json',
  ];
  if (q.market || (opts.market)) argv.push('--mode', 'intl');
  if (opts.channels) argv.push('--channels', opts.channels);
  if (opts.batch) argv.push('--batch', String(opts.batch));
  if (opts.submodule) argv.push('--submodule', opts.submodule);

  console.log(`\n$ ${py.cmd} ${argv.slice(1).join(' ')}`);
  const r = spawnSync(py.cmd, [...py.pre, ...argv], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
  let summary = null;
  try { summary = JSON.parse(line); } catch (_) { /* 非 --json 输出 */ }
  if (r.status !== 0) {
    console.error(`✗ 抓取失败（退出码 ${r.status}）：${q.from}→${q.to}`);
    return { ok: false, out };
  }
  return { ok: true, out, summary };
}

// ── main ───────────────────────────────────────────────────────────────
function main() {
  const a = parseArgs(process.argv.slice(2));
  const casePath = a._[0];
  if (!casePath) {
    console.error('用法：node scripts/ota/cli.js <case.json> [--fetch] [--check] [--out dir] [--cache-dir dir] [--dry] [--force]');
    process.exit(2);
  }
  const absCase = path.resolve(casePath);
  const cfg = JSON.parse(fs.readFileSync(absCase, 'utf8'));
  const outDir = path.resolve(a.out || DEFAULT_OUT);

  if (a['cache-dir']) process.env.SKI_CACHE_DIR = path.resolve(a['cache-dir']);

  const sub = submoduleInfo();
  const py = a.fetch ? findPython() : null;

  if (a.check) {
    console.log('── OTA 环境体检 ──');
    console.log(`submodule : ${sub.ok ? `${SUBMODULE} @ ${sub.commit}${sub.dirty ? '  ⚠ 工作区有改动（不该出现）' : '  ✓ 干净'}` : `✗ ${sub.reason}`}`);
    const p = py || findPython();
    console.log(`python    : ${p ? `${p.cmd} (${p.version})  ✓ httpx + playwright` : '✗ 找不到能 import httpx 的解释器'}`);
    console.log(`明细目录  : ${outDir}`);
    if (!p) {
      console.log('\n装依赖：');
      console.log(`  python -m venv .venv-ota`);
      console.log(`  .venv-ota/Scripts/pip install -r third_party/ticket-monitoring/requirements.txt`);
    }
    if (!sub.ok || !p) process.exitCode = 1;
    return;
  }

  // 1) 抓（可选）
  const fetched = [];
  if (a.fetch) {
    if (!sub.ok) { console.error(`✗ ${sub.reason}`); process.exit(2); }
    if (!py) {
      console.error('✗ 找不到能 import httpx 的解释器。用 --check 看装法，或设 SKI_OTA_PYTHON。');
      process.exit(2);
    }
    const only = a.only ? String(a.only).toUpperCase().split('-') : null;
    for (const q of cfg.flightQueries || []) {
      if (only && !(q.from === only[0] && q.to === only[1])) continue;
      const r = runFetch(py, q, { out: outDir, channels: a.channels, batch: a.batch,
        submodule: a.submodule, market: cfg.params && cfg.params.market });
      fetched.push({ q, ...r });
    }
  }

  // 2) 桥接
  const bridge = require('./bridge');
  const files = (a.ota && a.ota.length)
    ? a.ota.map((f) => path.resolve(f))
    : (fs.existsSync(outDir)
      ? fs.readdirSync(outDir).filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json'))
        .map((f) => path.join(outDir, f))
      : []);

  if (!files.length) {
    console.error(`✗ ${outDir} 下没有 OTA 明细，先跑 --fetch`);
    process.exit(2);
  }

  console.log(`\n── 桥接 ${files.length} 份 OTA 明细 → 缓存条目 ──`);
  for (const f of files) console.log(`  · ${path.relative(ROOT, f)}`);
  console.log('');

  const r = bridge.buildEntries({
    cfg, otaFiles: files,
    dry: Boolean(a.dry), force: Boolean(a.force),
  });

  // 3) 汇总
  const covered = r.queries.filter((q) => q.rows).length;
  console.log(`\n${'查询'.padEnd(16)} 天数  行/池    缺日`);
  for (const q of r.queries) {
    console.log(`${(q.from + '→' + q.to).padEnd(16)} ${String(q.dates).padStart(3)}  `
      + `${String(q.rows).padStart(3)}/${String(q.pool).padEnd(5)} ${q.missing.length ? q.missing.join(',') : '—'}`);
  }
  console.log(`\n${covered}/${r.queries.length} 个查询有数据，`
    + `${a.dry ? '将' : '已'}写 ${r.written.length} 条缓存`
    + (r.skipped.length ? `，跳过 ${r.skipped.length} 条（已有真实飞常准条目）` : '')
    + `\n缓存目录 ${r.dir}`);

  if (a.fetch) {
    const bad = fetched.filter((x) => !x.ok || !(x.summary && x.summary.rows));
    if (bad.length) {
      console.log('\n抓取无结果的查询：');
      for (const b of bad) console.log(`  ${b.q.from}→${b.q.to}`);
    }
  }

  if (covered < r.queries.length) {
    console.log('\n下一步：补齐缺的查询后重跑；或用飞常准补（先问用户，1 分/次）。');
    process.exitCode = 1;
  } else {
    console.log(`\n下一步：node scripts/legs.js ${path.relative(ROOT, absCase)}`);
  }
}

main();
