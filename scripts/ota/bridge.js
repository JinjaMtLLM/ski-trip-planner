#!/usr/bin/env node
/**
 * bridge.js —— OTA 明细 → 「飞常准格式的缓存条目」
 *
 * 为什么是「伪造缓存」而不是改 legs.js：legs.js 除了航班还要建高铁边、打车边、
 * 做同类接驳合并，复刻一遍容易出错。只要把缓存条目做成它本来就认的形状，
 * legs → enumerate → render 一行都不用动，两种数据源也就天然可切换。
 *
 * 关键约束（踩过坑的地方，改之前先读）：
 *   1. **缓存键不能手拼**。必须用 legs.js 里 readCachedFlights() 那套
 *      `cache.keyOf('getFlightTicketPrice', { sql: vf.buildSql*() })`，
 *      否则键差一个字符就是「缓存未命中」，白抓一遍。
 *   2. **不能覆盖真实的飞常准条目**。真实条目是花积分换的，OTA 条目只是补充。
 *      已存在且 source !== 'ota' 时默认跳过，要覆盖必须显式 --force。
 *   3. **SQL 的筛选语义要复刻**。buildSqlPerDay 只回前 N 行、buildSql 是
 *      「直飞全留 + 中转前 N」，不筛的话每天 100+ 条全进图，枚举规模翻几倍，
 *      结果也跟真跑 SQL 对不上。
 *   4. **含税口径**。国内行 price 是裸价（+tax）；国际行 price 已含税、
 *      fare 才是票面，此时 tax 只是分项，再加一次就重复计税。
 *
 * 用法（一般由 cli.js 调，也可单独跑）：
 *   node scripts/ota/bridge.js --case cases/jjs-cny/case.json \
 *        --ota tmp/ota/out/SZX-AAT.json [--ota ...] [--cache-dir tmp/ota-cache] [--dry]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function repoRequire(rel) { return require(path.join(ROOT, rel)); }

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : dflt;
}
function args(name) {
  const out = [];
  process.argv.forEach((a, i) => {
    if (a === '--' + name && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
      out.push(process.argv[i + 1]);
    }
  });
  return out;
}

// ── 明细合并与筛选 ─────────────────────────────────────────────────────
/** 含税总价。国内渠道给裸价 price + 税 tax；国际（携程）把含税价放在
 *  price 里、另给 fare 票面，此时 tax 只是分项，不能再加。 */
function totalOf(f) {
  return f.fare != null ? f.price : f.price + (f.tax || 0);
}

/** 同班次多源去重：航班号 + 起降时刻 + 落地日为键，取含税最低；
 *  同价时优先飞猪（它的税是实测值，其余是 140×航段 估的）。 */
function mergeFlights(list) {
  const best = new Map();
  for (const f of list) {
    const key = [f.no, f.dep, f.arr, f.arrDate || ''].join('|');
    const cur = best.get(key);
    if (!cur) { best.set(key, f); continue; }
    const a = totalOf(f);
    const b = totalOf(cur);
    const better = a < b
      || (a === b && f.ch === 'fliggy' && cur.ch !== 'fliggy')
      || (a === b && (f.stop || 0) > 0 && !(cur.stop || 0));
    if (better) best.set(key, f);
  }
  return [...best.values()];
}

/** 同一 (起降时刻, 中转次数) 只留最便宜的一条 —— 对应 SQL 的 GROUP BY。 */
function groupCheapest(list) {
  const byGroup = new Map();
  for (const f of list) {
    const k = [f.dep, f.arr, (f.segs || 1) - 1].join('|');
    const cur = byGroup.get(k);
    if (!cur || totalOf(f) < totalOf(cur)) byGroup.set(k, f);
  }
  return [...byGroup.values()];
}

/** 复刻 buildSql 的语义：直飞全留 + 中转按价格取前 N。 */
function pickPerTransfer(list, n, directOnly) {
  const all = groupCheapest(list);
  const direct = all.filter((f) => (f.segs || 1) === 1);
  if (directOnly) return direct;
  const trans = all.filter((f) => (f.segs || 1) > 1)
    .sort((a, b) => totalOf(a) - totalOf(b)).slice(0, n);
  return direct.concat(trans);
}

/** 复刻 buildSqlPerDay 的语义：分组去重后按价格取前 N（不区分直飞）。 */
function pickPerDay(list, n) {
  return groupCheapest(list).sort((a, b) => totalOf(a) - totalOf(b)).slice(0, n);
}

/** 归一明细 → 飞常准行（vf.toFlight 靠 summary 正则取时刻，格式必须对得上）。 */
function toRow(f, from, to, date) {
  const arrDate = f.arrDate || date;
  const cities = [from, f.via || '', to].filter(Boolean).join('-');
  const summary = `${cities}，${date} ${f.dep}:00 出发、`
    + `${arrDate} ${f.arr}:00 到达`
    + (f.stop ? `，中转停留约 ${f.stop} 分钟` : '');
  return {
    // 多日期合并查时靠 tag 认日期，readCachedFlights 会据此过滤
    tag: `${date}|${from}-${to}`,
    summary,
    transfers: Math.max(0, (f.segs || 1) - 1),
    // toFlight 用 adult_total − adult_fare 反推税费，两个数必须与含税总价自洽
    adult_fare: f.fare != null ? f.fare : f.price,
    // 机建/燃油分项留空，让 toFlight 走差额兜底，不会再叠一次
    adult_total: totalOf(f),
    flight_nos: String(f.no).split('+').filter(Boolean),
    stop_min: f.stop || 0,
    dep_ap: from,
    arr_ap: to,
  };
}

// ── 主流程 ─────────────────────────────────────────────────────────────
/**
 * @param {object} opts
 * @param {object} opts.cfg           case.json
 * @param {string[]} opts.otaFiles    OTA 明细 JSON（键 = FROM|TO|DATE）
 * @param {boolean} [opts.dry]        只算不写
 * @param {boolean} [opts.force]      允许覆盖非 OTA 来源的缓存条目
 * @param {function} [opts.log]
 * @returns {{written:number, skipped:object[], queries:object[]}}
 */
function buildEntries(opts) {
  const log = opts.log || ((s) => console.log(s));
  const vf = repoRequire('scripts/variflight.js');
  const cache = repoRequire('scripts/cache.js');
  const cfg = opts.cfg;
  const dir = cache.cacheDir();
  if (!dir) throw new Error('缓存目录不可用（检查 SKI_CACHE_DIR）');

  // 汇总所有 OTA 文件：{ "SZX|AAT|2027-02-05": { fliggy: [...], ctrip: [...] } }
  const ota = {};
  for (const f of opts.otaFiles || []) {
    if (!fs.existsSync(f)) { log(`  ⚠ 找不到 ${f}`); continue; }
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const [k, slot] of Object.entries(doc)) {
      if (!slot || typeof slot !== 'object' || !/^[A-Z]{3}\|[A-Z]{3}\|\d{4}-\d{2}-\d{2}$/.test(k)) continue;
      ota[k] = ota[k] || {};
      for (const [ch, rows] of Object.entries(slot)) {
        if (Array.isArray(rows)) ota[k][ch] = rows;
      }
    }
  }

  const P = cfg.params || {};
  const maxStop = P.maxStopMinutes || vf.DEFAULT_MAX_STOP_MIN;
  const perDay = Number(P.perDay) > 0 ? Number(P.perDay) : 0;
  const perTransfer = Number(P.perTransfer) > 0 ? Number(P.perTransfer) : 15;
  const market = P.market || '';

  const written = [];
  const skipped = [];
  const queries = [];

  for (const q of cfg.flightQueries || []) {
    const dates = q.dates && q.dates.length ? q.dates : [q.date];
    const qm = q.market || market;
    const sources = dates.map((d) => ({ from: q.from, to: q.to, date: d }));
    const sql = perDay
      ? vf.buildSqlPerDay(sources, perDay, qm, maxStop)
      : vf.buildSql(sources, perTransfer, qm);
    const key = cache.keyOf('getFlightTicketPrice', { sql });

    const rows = [];
    const missing = [];
    let pool = 0;
    for (const d of dates) {
      const slot = ota[`${q.from}|${q.to}|${d}`];
      const all = slot ? Object.values(slot).flat() : [];
      if (!all.length) { missing.push(d); continue; }
      const merged = mergeFlights(all);
      pool += merged.length;
      const picked = perDay ? pickPerDay(merged, perDay)
        : pickPerTransfer(merged, perTransfer, P.directOnly);
      for (const f of picked) rows.push(toRow(f, q.from, q.to, d));
    }

    const label = `${q.from}→${q.to} ${dates.length} 天`;
    const info = { from: q.from, to: q.to, dates: dates.length, rows: rows.length,
      pool, missing, key, label };
    queries.push(info);

    if (!rows.length) {
      log(`✗ ${label}  没有任何 OTA 明细${missing.length ? `（缺 ${missing.join(',')}）` : ''}`);
      continue;
    }

    // 已有条目：OTA 的可以刷新，真实飞常准的不能动
    const p = path.join(dir, key + '.json');
    if (fs.existsSync(p)) {
      let old = null;
      try { old = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { old = null; }
      const src = (old && old.source) || 'variflight';
      if (src !== 'ota' && !opts.force) {
        skipped.push({ ...info, reason: `已有 ${src} 条目，未覆盖（--force 可强制）` });
        log(`↷ ${label}  已有 ${src} 条目，跳过（要覆盖加 --force）`);
        continue;
      }
    }

    const entry = {
      schema: 1,
      key,
      tool: 'getFlightTicketPrice',
      args: { sql },
      sql,
      createdAt: new Date().toISOString(),
      ok: true,
      source: 'ota',              // 标记来源：别与真实飞常准快照混淆
      label,
      rowCount: rows.length,
      sourceCount: pool,          // 未筛选的候选池总量，与 rowCount 的差即被限额吃掉的
      truncated: false,
      raw: JSON.stringify({ item: { data: { rows, truncated: false } } }),
    };

    if (!opts.dry) {
      if (!cache.write(entry)) throw new Error(`写缓存失败：${p}`);
    }
    written.push(info);
    log(`✓ ${label}  ${rows.length}/${pool} 行`
      + (missing.length ? `  ⚠ 缺 ${missing.join(',')}` : '')
      + `  key=${key}`);
  }

  if (written.length && !opts.dry && typeof cache.reindex === 'function') {
    try { cache.reindex(); } catch (_) { /* 索引失败不影响主流程 */ }
  }
  return { written, skipped, queries, dir };
}

module.exports = { buildEntries, mergeFlights, pickPerDay, pickPerTransfer, totalOf, toRow };

// ── 单独跑 ─────────────────────────────────────────────────────────────
if (require.main === module) {
  const cacheDir = arg('cache-dir', '');
  if (cacheDir) process.env.SKI_CACHE_DIR = path.resolve(cacheDir);   // 必须在 require cache 之前
  const casePath = arg('case', '');
  if (!casePath) { console.error('需要 --case <case.json>'); process.exit(2); }
  const cfg = JSON.parse(fs.readFileSync(casePath, 'utf8'));
  const r = buildEntries({
    cfg,
    otaFiles: args('ota'),
    dry: process.argv.includes('--dry'),
    force: process.argv.includes('--force'),
  });
  console.log(`\n写入 ${r.written.length} 条 OTA 缓存 → ${r.dir}`
    + (r.skipped.length ? `，跳过 ${r.skipped.length} 条` : ''));
  const empty = r.queries.filter((q) => !q.rows);
  if (empty.length) {
    console.log('以下查询没有任何 OTA 数据：');
    for (const q of empty) console.log(`  ${q.label}`);
    process.exitCode = 1;
  }
}
