#!/usr/bin/env node
'use strict';
/**
 * cache.js — 查询结果的本地缓存
 *
 * 为什么需要：飞常准按「唯一 O-D 对」扣积分（100/月），问道按日配额但有延迟。
 * 一次查询的原始结果落盘后，脚本崩了、SQL 报错、或者只是想重跑一次，
 * 都不该再花一次钱。所以：**存原始结果，不存解析后的对象**——解析逻辑以后改了，
 * 老缓存照样能重新解析，不会因为字段变化而失效。
 *
 * 一个条目 = 一次 tools/call，键是 (工具名, 参数) 的 sha256。
 * 参数里含完整 SQL，所以日期、航线、cabin、perTransfer 任一变化都是新键；
 * 同样的命令重跑则命中，这正是「重试不重复扣分」要的行为。
 *
 * 目录解析顺序：SKI_CACHE_DIR → <技能根>/.cache → <系统临时目录>/ski-trip-planner-cache
 * 全部不可写时缓存自动降级为关闭（脚本照常跑，只是每次都真查）。
 *
 * CLI：
 *   node scripts/cache.js path                 打印缓存目录
 *   node scripts/cache.js list                 列出条目（时间、行数、是否截断）
 *   node scripts/cache.js show <key>           打印某条的原始结果
 *   node scripts/cache.js prune [--days 7]     删除过期条目（默认 7 天；失败记录 1 天）
 *   node scripts/cache.js clear                清空
 *   node scripts/cache.js index                打印索引（即 .cache/index.md 的内容）
 *   node scripts/cache.js reindex              从现有条目重建索引（升级后跑一次）
 *
 * 索引（给 LLM agent 读，不是给脚本读）：
 *   每次写入缓存后自动更新 `.cache/index.json`（完整结构化数据）与
 *   `.cache/index.md`（一页总览：覆盖哪些航线 / 城市 / 日期 / 机场、查询时间、指向 key）。
 *   用途：**动手查之前先读它**，判断想查的航线日期是否已经在缓存里，避免白花积分。
 *   两个来源分工不同，读的时候要分开看：
 *     · cities / dates / market / cabin 来自 SQL —— 「想查什么」，权威；
 *     · airports 与 perDate 来自返回行 —— 「实际拿到什么」，按日限额截过，
 *       truncated 的条目尤其要按「不完全」看。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/** 缓存布局版本。改动条目结构时 +1，老条目自动失效而不是被误读。 */
const SCHEMA = 1;

/**
 * 默认新鲜期。24 小时内同一查询直接复用；更早的视为过期，正常模式下重查。
 * 调大的理由：飞常准按次扣分，同一天内反复重跑同一窗口很常见（改报告、补算例），
 * 6 小时常导致「下午跑过一次，晚上再跑又要 1 分」。代价是票价快照可能有一天陈化——
 * 所以 `meta.dataAt` 必须如实写进报告页脚，下单前仍要复核。
 */
const DEFAULT_TTL_MINUTES = 1440;

/** 索引 schema。与条目 schema 分开：改它不会让已有缓存条目失效。 */
const INDEX_SCHEMA = 1;
const INDEX_JSON = 'index.json';
const INDEX_MD = 'index.md';

// ── 中日韩字符按 2 列宽算，否则表格对不齐 ────────────────────────────────
const cw = (ch) => (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1);
const pad = (s, w) => {
  const cur = [...String(s)].reduce((n, ch) => n + cw(ch), 0);
  return s + ' '.repeat(Math.max(0, w - cur));
};

// ── 目录 ────────────────────────────────────────────────────────────────
function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
    fs.accessSync(p, fs.constants.W_OK);
    return p;
  } catch (_) {
    return '';
  }
}

let _dir;
/** 缓存目录；返回空串表示不可用（调用方按「无缓存」处理） */
function cacheDir() {
  if (_dir !== undefined) return _dir;
  const fromEnv = (process.env.SKI_CACHE_DIR || '').trim();
  const candidates = [
    fromEnv ? path.resolve(fromEnv) : '',
    path.join(__dirname, '..', '.cache'),
    path.join(os.tmpdir(), 'ski-trip-planner-cache'),
  ].filter(Boolean);

  _dir = '';
  for (const c of candidates) {
    const ok = ensureDir(c);
    if (ok) { _dir = ok; break; }
  }
  return _dir;
}

// ── 键 ──────────────────────────────────────────────────────────────────
/** 稳定序列化：对象键排序，保证同样的参数得到同样的串 */
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

function keyOf(tool, args) {
  return crypto.createHash('sha256')
    .update(canonical({ schema: SCHEMA, tool, args }))
    .digest('hex').slice(0, 32);
}

const entryPath = (key) => (cacheDir() ? path.join(cacheDir(), key + '.json') : '');

// ── 读写 ────────────────────────────────────────────────────────────────
function read(key) {
  const p = entryPath(key);
  if (!p) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!j || j.schema !== SCHEMA || j.key !== key) return null;
    return j;
  } catch (_) {
    return null;                       // 半截文件 / 手改坏了 → 当没有
  }
}

function write(entry) {
  const p = entryPath(entry.key);
  if (!p) return false;
  try {
    const tmp = p + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(entry), 'utf8');
    fs.renameSync(tmp, p);             // 原子替换，避免进程中途退出留下半个文件
    updateIndex(entry);                // 索引跟着走；失败不影响主流程
    return true;
  } catch (_) {
    return false;
  }
}

function remove(key) {
  const p = entryPath(key);
  if (!p) return false;
  try { fs.unlinkSync(p); dropFromIndex(key); return true; } catch (_) { return false; }
}

// ── 判定 ────────────────────────────────────────────────────────────────
function ageMinutes(entry, now = Date.now()) {
  const t = Date.parse((entry && entry.createdAt) || '');
  return Number.isFinite(t) ? (now - t) / 60000 : Infinity;
}

function formatAge(min) {
  if (!Number.isFinite(min)) return '时间未知';
  if (min < 1) return '刚刚';
  if (min < 60) return Math.round(min) + ' 分钟';
  if (min < 1440) return (min / 60).toFixed(1) + ' 小时';
  return (min / 1440).toFixed(1) + ' 天';
}

/**
 * 判断一条缓存能不能直接当数据用。
 *
 * @param {object|null} entry
 * @param {{ttlMinutes?:number, allowStale?:boolean, allowIncomplete?:boolean}} [opts]
 * @returns {{serve:boolean, reason:string, age:number, doc?:object}}
 *   reason: fresh | stale | incomplete | failed | corrupt | empty | miss
 *
 * 规则：
 *   - 上次就失败的条目永不当作数据返回（只留作排查）。
 *   - 被截断的条目算「有缺漏」，正常模式不返回，只有兜底时（allowIncomplete/allowStale）才用。
 *   - 超过 TTL 算过期，正常模式不返回，兜底时可用。
 */
function assess(entry, opts = {}) {
  if (!entry) return { serve: false, reason: 'miss', age: Infinity };

  const ttl = opts.ttlMinutes === undefined ? DEFAULT_TTL_MINUTES : Number(opts.ttlMinutes);
  const allowStale = Boolean(opts.allowStale);
  const allowIncomplete = Boolean(opts.allowIncomplete);
  const age = ageMinutes(entry);

  if (entry.ok === false) return { serve: false, reason: 'failed', age };
  if (!entry.raw) return { serve: false, reason: 'empty', age };

  let doc = null;
  try { doc = JSON.parse(entry.raw); } catch (_) { /* 下面按 corrupt 处理 */ }
  if (!doc) return { serve: false, reason: 'corrupt', age };

  const incomplete = Boolean(entry.truncated);
  if (incomplete && !allowIncomplete && !allowStale) {
    return { serve: false, reason: 'incomplete', age, doc };
  }
  const fresh = age <= ttl;
  if (fresh || allowStale) {
    return { serve: true, reason: incomplete ? 'incomplete' : fresh ? 'fresh' : 'stale', age, doc };
  }
  return { serve: false, reason: 'stale', age, doc };
}

// ── 索引（给 LLM agent 读） ─────────────────────────────────────────────
const indexPath = () => (cacheDir() ? path.join(cacheDir(), INDEX_JSON) : '');
const indexMdPath = () => (cacheDir() ? path.join(cacheDir(), INDEX_MD) : '');

/** 从 SQL 里取 legs 字面量：dep_city / arr_city / date（buildSql 与 buildSqlPerDay 同格式） */
function parseLegs(sql) {
  const out = [];
  const re = /\{\s*'dep_city'\s*:\s*'([^']*)'\s*,\s*'arr_city'\s*:\s*'([^']*)'\s*,\s*'date'\s*:\s*'([^']*)'\s*\}/g;
  let m;
  while ((m = re.exec(String(sql || '')))) out.push({ from: m[1], to: m[2], date: m[3] });
  return out;
}
const grab = (sql, re) => { const m = re.exec(String(sql || '')); return m ? m[1] : ''; };

/**
 * 一个缓存条目 → 一条索引记录。
 *
 * 覆盖信息有两个来源，可信度不同，索引里分开放：
 *   · coverage.legs / dates / cities / market / cabin  ← SQL 字面量。「想查什么」。
 *   · coverage.airports / perDate                       ← 返回行。「实际拿到什么」。
 *     返回行是按日限额截过的，所以 airports 可能少于实际执飞的机场；
 *     条目被截断（truncated）时尤其要按「不完全」看。
 */
function describeEntry(entry, now = Date.now()) {
  const base = {
    key: entry.key,
    createdAt: entry.createdAt || '',
    ageMinutes: Math.round(ageMinutes(entry, now) * 10) / 10,
    tool: entry.tool || '',
    label: entry.label || '',
    ok: entry.ok !== false,
    truncated: Boolean(entry.truncated),
    rows: entry.rowCount || 0,
    sourceCount: entry.sourceCount || 0,
  };
  if (entry.ok === false) {
    return Object.assign(base, {
      coverage: null,
      note: '失败记录；assess() 永不把它当数据返回，只留作排查',
      error: entry.error || '',
    });
  }
  const sql = entry.sql || (entry.args && entry.args.sql) || '';
  const legs = parseLegs(sql);
  const coverage = {
    market: grab(sql, /market := '([^']*)'/),
    cabin: grab(sql, /cabin := '([^']*)'/),
    legs,
    dates: legs.map((l) => l.date),
    cities: [...new Set(legs.flatMap((l) => [l.from, l.to]))].sort(),
    airports: [],
    perDate: {},
  };
  let doc = null;
  try { doc = JSON.parse(entry.raw); } catch (_) { doc = null; }
  const rows = (doc && doc.item && doc.item.data && doc.item.data.rows) || [];
  const aps = new Set();
  const perDateAps = {};
  for (const r of rows) {
    const date = String(r.tag || '').split('|')[0] || '(无 tag)';
    const d = coverage.perDate[date] || (coverage.perDate[date] = {
      rows: 0, direct: 0, transfer: 0, cheapest: null, airports: [],
    });
    d.rows++;
    if (Number(r.transfers) === 0) d.direct++; else d.transfer++;
    const t = r.adult_total;
    if (typeof t === 'number' && (d.cheapest === null || t < d.cheapest)) d.cheapest = t;
    const set = perDateAps[date] || (perDateAps[date] = new Set());
    for (const ap of [r.dep_ap, r.arr_ap]) { if (ap) { aps.add(ap); set.add(ap); } }
  }
  coverage.airports = [...aps].sort();
  for (const date of Object.keys(coverage.perDate)) {
    coverage.perDate[date].airports = [...(perDateAps[date] || [])].sort();
  }
  if (!rows.length) base.note = '没有返回行（0 行，或不是航班查询）';
  else if (!coverage.airports.length) {
    // 2026-10-22 之前的 SQL 没有取 dep_ap / arr_ap 两列，机场覆盖无从得知。
    // 这不是索引的 bug，是数据本身缺字段，如实标出来。
    base.note = '返回行没有 dep_ap/arr_ap（旧版 SQL 未取机场列），机场覆盖未知';
  }
  return Object.assign(base, { coverage });
}

function emptyIndex() {
  return { indexSchema: INDEX_SCHEMA, updatedAt: new Date().toISOString(), entries: {}, byRoute: {} };
}

function readIndex() {
  const p = indexPath();
  if (!p) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!j || j.indexSchema !== INDEX_SCHEMA) return null;
    return j;
  } catch (_) {
    return null;                       // 半截 / 手改坏 → 重建即可
  }
}

/** 写文本文件，原子替换 */
function writeTextAtomic(p, text) {
  try {
    const tmp = p + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch (_) {
    return false;
  }
}

/** 按航线汇总：SZX->CGQ → { dates:{...}, dateCount, keys:[...] } */
function rebuildSummary(idx) {
  const byRoute = {};
  for (const e of Object.values(idx.entries)) {
    for (const l of (e.coverage && e.coverage.legs) || []) {
      const r = l.from + '->' + l.to;
      const b = byRoute[r] || (byRoute[r] = { dates: {}, keys: [] });
      b.dates[l.date] = (b.dates[l.date] || 0) + 1;
      if (!b.keys.includes(e.key)) b.keys.push(e.key);
    }
  }
  for (const b of Object.values(byRoute)) {
    b.dates = Object.fromEntries(Object.entries(b.dates).sort());
    b.dateCount = Object.keys(b.dates).length;
  }
  idx.byRoute = byRoute;
  return idx;
}

/** 写入（或更新）一个条目的索引记录，并重算总览。任何失败都不抛异常。 */
function updateIndex(entry) {
  try {
    const idx = readIndex() || emptyIndex();
    idx.entries[entry.key] = describeEntry(entry);
    rebuildSummary(idx);
    return writeIndex(idx);
  } catch (_) {
    return false;
  }
}

function dropFromIndex(key) {
  try {
    const idx = readIndex();
    if (!idx || !idx.entries[key]) return false;
    delete idx.entries[key];
    rebuildSummary(idx);
    return writeIndex(idx);
  } catch (_) {
    return false;
  }
}

function writeIndex(idx) {
  const p = indexPath();
  if (!p) return false;
  idx.updatedAt = new Date().toISOString();
  const okJson = writeTextAtomic(p, JSON.stringify(idx, null, 1));
  const okMd = writeTextAtomic(indexMdPath(), renderIndexMd(idx));
  return okJson && okMd;
}

/** 从目录里现有条目重建索引。用于升级后补一次，或索引文件损坏时。 */
function reindex() {
  const d = cacheDir();
  if (!d) return null;
  const idx = emptyIndex();
  let names = [];
  try { names = fs.readdirSync(d); } catch (_) { return null; }
  for (const n of names) {
    if (!n.endsWith('.json') || n === INDEX_JSON) continue;
    let e;
    try { e = JSON.parse(fs.readFileSync(path.join(d, n), 'utf8')); } catch (_) { continue; }
    if (!e || e.schema !== SCHEMA || !e.key) continue;
    idx.entries[e.key] = describeEntry(e);
  }
  rebuildSummary(idx);
  return writeIndex(idx) ? idx : null;
}

/** 一页总览（Markdown）。给 LLM agent 直接读，脚本不读。 */
function renderIndexMd(idx) {
  const L = [];
  const es = Object.values(idx.entries)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const shortDate = (d) => String(d).slice(5);
  const stateOf = (e) => (e.ok === false ? '失败' : e.truncated ? '截断' : '完整');
  const apsOf = (e) => {
    const aps = (e.coverage && e.coverage.airports) || [];
    return aps.length ? aps.join(' ') : '—（无机场字段）';
  };

  L.push('# 飞常准查询缓存索引');
  L.push('');
  L.push('> 由 `scripts/cache.js` 在每次写入缓存后自动生成，**给 LLM agent 读，脚本不读它**。');
  L.push('> 更新于 ' + idx.updatedAt + '　条目 ' + es.length + ' 条　目录 `' + (cacheDir() || '(不可用)') + '`');
  L.push('> 用法：先看「覆盖总览」判断想查的航线/日期在不在缓存里，再 `show <key>` 取原文。');
  L.push('');
  if (!es.length) { L.push('（缓存为空）'); L.push(''); return L.join('\n'); }

  L.push('## 覆盖总览');
  L.push('');
  L.push('| 航线 | 日期 | 机场 | 条目 |');
  L.push('|---|---|---|---|');
  for (const route of Object.keys(idx.byRoute).sort()) {
    const b = idx.byRoute[route];
    const aps = new Set();
    for (const k of b.keys) {
      const e = idx.entries[k];
      for (const ap of (e && e.coverage && e.coverage.airports) || []) aps.add(ap);
    }
    L.push('| ' + route + ' | ' + Object.keys(b.dates).map(shortDate).join(' ') + ' | '
      + ([...aps].sort().join(' ') || '—（无机场字段）') + ' | ' + b.keys.length + ' |');
  }
  L.push('');

  L.push('## 明细');
  L.push('');
  L.push('| 查询时间 | 航线 | 日期 | 机场 | 行/候选 | 状态 | key |');
  L.push('|---|---|---|---|---|---|---|');
  for (const e of es) {
    const legs = (e.coverage && e.coverage.legs) || [];
    const od = legs.length ? legs[0].from + '→' + legs[0].to : (e.label || '(无 legs)');
    const dates = legs.length ? [...new Set(legs.map((l) => l.date))].map(shortDate).join(' ') : '—';
    L.push('| ' + String(e.createdAt).replace('T', ' ').slice(0, 16) + ' | ' + od + ' | ' + dates + ' | '
      + apsOf(e) + ' | ' + e.rows + '/' + e.sourceCount + ' | ' + stateOf(e) + ' | `' + e.key + '` |');
  }
  L.push('');

  const noted = es.filter((e) => e.note);
  if (noted.length) {
    const byNote = new Map();
    for (const e of noted) {
      if (!byNote.has(e.note)) byNote.set(e.note, []);
      byNote.get(e.note).push('`' + e.key + '`');
    }
    L.push('### 备注');
    L.push('');
    for (const [note, keys] of byNote) L.push('- ' + note + '：' + keys.join('、'));
    L.push('');
  }

  L.push('## 读这份索引要记住的四件事');
  L.push('');
  L.push('1. **`cities` / `dates` 来自 SQL，是「想查什么」；`airports` / `perDate` 来自返回行，是「实际拿到什么」。** '
    + '返回行按日限额截过，所以机场数可能少于实际执飞；截断的条目尤其不完整。');
  L.push('2. **截断的条目不会被查询路径复用**（`assess()` 直接判 `incomplete`），重跑同一条命令会再扣 1 分。');
  L.push('3. **新鲜期 24 小时**（`--cache-ttl` 可调）。超期的条目查询路径会重查，但 `legs.js` 出报告时不看 TTL，有就吃。');
  L.push('4. **`sourceCount` 是未过滤的候选池总量**，`rows` 是实际拿到的行数，两者的差就是被限额/截断吃掉的。');
  L.push('');
  L.push('维护：`node scripts/cache.js list` / `show <key>` / `prune` / `reindex`。');
  L.push('');
  return L.join('\n');
}

// ── 维护 ────────────────────────────────────────────────────────────────
/** 列出全部条目，按时间倒序 */
function list() {
  const d = cacheDir();
  if (!d) return [];
  let names = [];
  try { names = fs.readdirSync(d).filter((n) => n.endsWith('.json') && n !== INDEX_JSON); } catch (_) { return []; }

  const out = [];
  for (const n of names) {
    const p = path.join(d, n);
    let j;
    try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { continue; }
    if (!j || j.schema !== SCHEMA) continue;
    let size = 0;
    try { size = fs.statSync(p).size; } catch (_) { /* ignore */ }
    out.push({ ...j, bytes: size, age: ageMinutes(j) });
  }
  return out.sort((a, b) => a.age - b.age);
}

/** 删除过期条目：失败记录留 1 天，正常记录留 days 天 */
function prune(days = 7) {
  const normalCut = Number(days) * 1440;
  const failCut = 1440;
  let removed = 0;
  for (const e of list()) {
    const cut = e.ok === false ? failCut : normalCut;
    if (e.age > cut) { if (remove(e.key)) removed++; }
  }
  return removed;
}

function clear() {
  let removed = 0;
  for (const e of list()) { if (remove(e.key)) removed++; }
  return removed;
}

// ── CLI ─────────────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'list';
  const flag = (name, dflt) => {
    const i = argv.indexOf('--' + name);
    return i > -1 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
  };

  const kb = (n) => (n < 1024 ? n + 'B' : n < 1048576 ? (n / 1024).toFixed(1) + 'K' : (n / 1048576).toFixed(1) + 'M');

  if (cmd === 'path') {
    console.log(cacheDir() || '(不可写，缓存已关闭)');
  } else if (cmd === 'list') {
    const rows = list();
    console.log('缓存目录 ' + (cacheDir() || '(不可写)'));
    if (!rows.length) { console.log('（空）'); process.exit(0); }
    console.log('');
    for (const e of rows) {
      const state = e.ok === false ? '失败' : e.truncated ? '截断' : '完整';
      console.log([
        pad(formatAge(e.age), 10),
        pad(state, 6),
        pad(String(e.rowCount || 0) + ' 行', 8),
        pad(kb(e.bytes), 8),
        pad(e.label || '(无标签)', 22),
        '  ' + e.key,
      ].join(''));
    }
    console.log('\n共 ' + rows.length + ' 条');
    const idx = readIndex();
    if (idx) console.log('索引 ' + (idx.updatedAt || '').replace('T', ' ').slice(0, 19)
      + ' 生成，覆盖 ' + Object.keys(idx.byRoute).length + ' 条航线');
    else console.log('⚠ 还没有索引，跑 node scripts/cache.js reindex 生成');
  } else if (cmd === 'show') {
    const key = argv[1];
    if (!key) { console.error('用法：node scripts/cache.js show <key>'); process.exit(1); }
    const e = read(key);
    if (!e) { console.error('没有这条缓存：' + key); process.exit(1); }
    // args 里的 sql 与顶层重复，展示时去掉，省得刷屏
    console.log(JSON.stringify({ ...e, args: undefined, raw: undefined, rawBytes: (e.raw || '').length }, null, 2));
    console.log('\n── 原始结果 ──');
    console.log(e.raw || '(空)');
  } else if (cmd === 'prune') {
    const n = prune(flag('days', 7));
    console.log('删除 ' + n + ' 条');
  } else if (cmd === 'clear') {
    const n = clear();
    console.log('清空 ' + n + ' 条');
  } else if (cmd === 'index') {
    const p = indexMdPath();
    const idx = readIndex();
    if (!idx || !fs.existsSync(p)) {
      console.log('索引不存在，正在从现有条目重建…');
      const fresh = reindex();
      if (!fresh) { console.error('重建失败（缓存目录不可写？）'); process.exit(1); }
    }
    console.log(fs.readFileSync(indexMdPath(), 'utf8').trimEnd());
    console.log('\n（文件位置：' + indexMdPath() + ' / ' + indexPath() + '）');
  } else if (cmd === 'reindex') {
    const idx = reindex();
    if (!idx) { console.error('重建失败（缓存目录不可写？）'); process.exit(1); }
    console.log('索引已重建：' + Object.keys(idx.entries).length + ' 条条目，'
      + Object.keys(idx.byRoute).length + ' 条航线');
    console.log('  ' + indexMdPath());
    console.log('  ' + indexPath());
  } else {
    console.error('未知命令：' + cmd
      + '\n可用：path | list | show <key> | prune [--days n] | clear | index | reindex');
    process.exit(1);
  }
}

module.exports = {
  SCHEMA, DEFAULT_TTL_MINUTES, INDEX_SCHEMA, INDEX_JSON, INDEX_MD,
  cacheDir, canonical, keyOf, read, write, remove,
  ageMinutes, formatAge, assess, list, prune, clear,
  parseLegs, describeEntry,
  indexPath, indexMdPath, readIndex, writeIndex, updateIndex, dropFromIndex,
  reindex, renderIndexMd,
};
