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
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/** 缓存布局版本。改动条目结构时 +1，老条目自动失效而不是被误读。 */
const SCHEMA = 1;

/** 默认新鲜期。6 小时内同一查询直接复用；更早的视为过期，正常模式下重查。 */
const DEFAULT_TTL_MINUTES = 360;

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
    return true;
  } catch (_) {
    return false;
  }
}

function remove(key) {
  const p = entryPath(key);
  if (!p) return false;
  try { fs.unlinkSync(p); return true; } catch (_) { return false; }
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

// ── 维护 ────────────────────────────────────────────────────────────────
/** 列出全部条目，按时间倒序 */
function list() {
  const d = cacheDir();
  if (!d) return [];
  let names = [];
  try { names = fs.readdirSync(d).filter((n) => n.endsWith('.json')); } catch (_) { return []; }

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
  // 中日韩字符按 2 列宽算，否则列表对不齐
  const cw = (ch) => (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1);
  const pad = (s, w) => {
    const cur = [...String(s)].reduce((n, ch) => n + cw(ch), 0);
    return s + ' '.repeat(Math.max(0, w - cur));
  };

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
  } else {
    console.error('未知命令：' + cmd + '\n可用：path | list | show <key> | prune [--days n] | clear');
    process.exit(1);
  }
}

module.exports = {
  SCHEMA, DEFAULT_TTL_MINUTES,
  cacheDir, canonical, keyOf, read, write, remove,
  ageMinutes, formatAge, assess, list, prune, clear,
};
