#!/usr/bin/env node
'use strict';
/**
 * legs.js — 把「航班 / 高铁 / 打车」统一成一张有向边表（路径表）
 *
 * 设计要点：
 *   1. 统一时间基准。所有时刻转成「自 1970-01-01 起的天数 × 1440 + 分钟」的绝对分钟，
 *      跨日航班（落地晚 +1 天）因此不再是特例。
 *   2. 两类边。
 *      · 班期边（scheduled）：航班、高铁。时刻固定，必须先于发车到达并留出进站时间。
 *      · 即到边走（ondemand）：打车、接驳。上一段一到就可以走（含等车时间）。
 *   3. 进出站时间显式建模。航班 entryMin=30（值机安检）、exitMin=20（下机取行李）；
 *      高铁 15 / 5。这样「落地到上车」不再靠一个含糊的总时长估算。
 *
 * 用法：
 *   node legs.js <case.json> [--out legs.csv]
 *
 * case.json 见 references/case-schema.md。核心字段：
 *   networkFile, flightQueries[], params.maxStopMinutes, dates
 *
 * 输出：
 *   legs.csv  列：起点,终点,开始时间,结束时间,花费,方式,班次,段数,备注
 *   legs.json 同上，供 enumerate.js 消费（含绝对分钟）
 */

const fs = require('fs');
const path = require('path');

const cache = require('./cache');
const vf = require('./variflight');

const SKILL_DIR = path.resolve(__dirname, '..');

// ---------------------------------------------------------------- 时间工具
const DAY_MS = 86400000;

function dayNum(dateStr) {
  const d = String(dateStr).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('日期格式应为 YYYY-MM-DD：' + dateStr);
  return Math.floor(Date.parse(d + 'T00:00:00Z') / DAY_MS);
}
const dayStr = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const wdOf = (n) => new Date(n * DAY_MS).getUTCDay();
const WD_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function hhmm(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t));
  if (!m) throw new Error('时间格式应为 HH:MM：' + t);
  return Number(m[1]) * 60 + Number(m[2]);
}
const fmtAbs = (a) => {
  const d = Math.floor(a / 1440);
  const m = a - d * 1440;
  return dayStr(d) + ' ' + String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
};
const fmtDate = (a) => dayStr(Math.floor(a / 1440));
const fmtTime = (a) => {
  const m = a - Math.floor(a / 1440) * 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
};

// ---------------------------------------------------------------- 网络与航司
/**
 * 读路径表。
 *   file      案例目录里的 network.json（相对路径按 baseDir 解析）。不传则回落到
 *             本 skill 的 references/network.json —— 那个文件属于**本地产物**（含具体票价
 *             与抓取时刻），不入库；仓库里只有 network.example.json 讲结构。
 *   resortId  断言雪场节点确实存在，避免路径表与 case.json 的 resort 对不上时静默算出空结果。
 */
function loadNetwork(file, resortId, baseDir) {
  const rel = file ? path.resolve(baseDir || process.cwd(), file) : '';
  const f = rel || path.join(SKILL_DIR, 'references', 'network.json');
  if (!fs.existsSync(f)) {
    throw new Error('找不到网络文件：' + f
      + '\n  路径表是每个案例的本地产物：把 network.json 放进案例目录，并在 case.json 里写 "networkFile": "./network.json"'
      + '\n  结构见 ' + path.join(SKILL_DIR, 'references', 'network.example.json'));
  }
  const net = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!net.nodes || !Object.keys(net.nodes).length) throw new Error('网络文件缺少 nodes：' + f);
  if (resortId && !net.nodes[resortId]) {
    throw new Error('网络文件里没有雪场节点 ' + resortId + '：' + f
      + '\n  已定义节点：' + Object.keys(net.nodes).join(' / '));
  }
  return net;
}

/**
 * 飞常准不再「只能靠航司猜」：`legs[1].segments[]` 里有 dep_airport / arr_airport，
 * buildSql 现在会取出来。这个函数只作为**旧缓存的兜底**——升级前落盘的条目没有机场列，
 * 那时才按航司归属推断。
 *
 * 城市码清单与航司归属都来自路径表，不在代码里写死任何机场：
 *   cityCodes:        ["BJS"]                        会返回城市码而非机场码的那些码
 *   airportOfAirline: { "CA": "PEK", "default": "PKX" }   航司 → 机场，default 兜底
 */
function airportOf(code, airline) {
  const net = airportOf._net;
  const cities = (net && net.cityCodes) || [];
  if (cities.indexOf(code) < 0) return code;
  const map = (net && net.airportOfAirline) || {};
  const hit = map[String(airline).toUpperCase()] || map.default;
  if (!hit) {
    throw new Error('路径表无法把城市码 ' + code + ' 落到具体机场：请在 network.json 里补 '
      + 'cityCodes 或 airportOfAirline（航司 → 机场，另需 default 兜底）');
  }
  return hit;
}

/**
 * 按 tag 找旧条目。
 * 缓存 key 是 SQL 的哈希，SQL 一改（比如这次加机场列）旧条目就再也命不中。
 * 但旧条目里的数据仍然有效，只是缺机场列，所以按 `'YYYY-MM-DD|起点-终点'` 这种 tag 字面量
 * 反查一遍，避免为了补字段把全部航线重查一遍。
 */
function findEntryByTags(dir, q, dates) {
  if (!dir || !fs.existsSync(dir)) return null;
  const marks = dates.map((d) => `'${d}|${q.from}-${q.to}'`);
  let best = null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let e;
    try { e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
    if (!e.ok || e.tool !== 'getFlightTicketPrice') continue;
    const sql = String(e.sql || '');
    if (!marks.every((m) => sql.includes(m))) continue;
    if (!best || String(e.createdAt) > String(best.createdAt)) best = e;
  }
  return best;
}

// ---------------------------------------------------------------- 读航班缓存
/** "机场→车站 33km" → "车站→机场 33km"（反向边用） */
function flipNote(note) {
  const s = String(note);
  // 只有「一个箭头」的备注才翻得动方向；多段路线（羽田→品川→上野）翻了只会变成乱码，
  // 这种备注请直接写成方向无关的「A ⇄ B」。
  if ((s.match(/\u2192/g) || []).length !== 1) return s;
  const m = /^([^\u2192]+)\u2192([^\s]+)([\s\S]*)$/.exec(s);
  if (!m) return s;
  return m[2] + '\u2192' + m[1] + m[3];
}function readCachedFlights(q, opts) {
  const dates = q.dates && q.dates.length ? q.dates : [q.date];
  const sources = dates.map((d) => ({ from: q.from, to: q.to, date: d }));
  const perDay = opts && Number(opts.perDay) > 0 ? Number(opts.perDay) : 0;
  const sql = perDay
    ? vf.buildSqlPerDay(sources, perDay, q.market || (opts && opts.market),
      opts.maxStopMinutes === undefined ? vf.DEFAULT_MAX_STOP_MIN : opts.maxStopMinutes)
    : vf.buildSql(sources, (opts && opts.perTransfer) || 15, q.market || (opts && opts.market));
  const key = cache.keyOf('getFlightTicketPrice', { sql });
  const dir = opts && opts.cacheDir ? path.resolve(opts.cacheDir) : cache.cacheDir();
  if (!dir) return { key, rows: null, reason: 'no-cache-dir' };
  const p = path.join(dir, key + '.json');
  let entry = null, reason = 'ok', legacy = false;
  if (fs.existsSync(p)) {
    try {
      entry = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      return { key, rows: null, reason: 'bad-cache' };
    }
  } else {
    entry = findEntryByTags(dir, q, dates);        // 旧 SQL 版本落盘的条目
    legacy = Boolean(entry);
    if (!entry) return { key, rows: null, reason: 'no-cache' };
    reason = 'legacy-cache';
  }
  if (!entry.ok) return { key, rows: null, reason: 'cache-error' };
  let doc;
  try {
    doc = typeof entry.raw === 'string' ? JSON.parse(entry.raw) : entry.raw;
  } catch (e) {
    return { key, rows: null, reason: 'bad-raw' };
  }
  const data = (doc && doc.item && doc.item.data) || {};
  const rows = [];
  for (const r of data.rows || []) {
    // 多日期合并查时，行归属哪一天写在 tag 里（"YYYY-MM-DD|起点-终点"）
    const tagDate = String(r.tag || '').split('|')[0];
    const date = dates.includes(tagDate) ? tagDate : dates[0];
    const f = vf.toFlight(r, { from: q.from, to: q.to, date });
    if (f.dep && f.arr) rows.push(f);
  }
  return { key, rows, truncated: Boolean(data.truncated), reason, legacy };
}

// ---------------------------------------------------------------- 建边
function buildLegs(caseCfg, opts) {
  const o = opts || {};
  const net = loadNetwork(caseCfg.networkFile, caseCfg.resort, o.baseDir);
  airportOf._net = net;
  // 中转停留上限默认 960（16h）。480 会把「落地睡一晚、次日早上到雪场」整类方案
  // 全部丢掉——实测每天贵 ¥30–290。见 references/variflight-query-plan.md 第 6 节。
  const maxStop = caseCfg.params && caseCfg.params.maxStopMinutes
    ? caseCfg.params.maxStopMinutes : vf.DEFAULT_MAX_STOP_MIN;
  const modeDef = net.modeDefaults || {};

  const legs = [];
  const stats = {
    flightRows: 0, flightKept: 0, flightDroppedLongStop: 0, flightDroppedNoAirport: 0,
    airportReal: 0, airportGuessed: 0, legacy: [],
    railRows: 0, groundRows: 0, cacheMiss: [], truncated: [],
  };

  // ── 航班 ──
  for (const q of caseCfg.flightQueries || []) {
    const r = readCachedFlights(q, {
      ...o,
      perTransfer: caseCfg.params && caseCfg.params.perTransfer,
      perDay: caseCfg.params && caseCfg.params.perDay,
      maxStopMinutes: maxStop,
      market: q.market || (caseCfg.params && caseCfg.params.market),
    });
    // 一个 query 可能带 dates[] 而不是单个 date，日志里两种都拼得出来
    const when = q.date || (q.dates || []).join('+');
    if (!r.rows) { stats.cacheMiss.push(q.from + '→' + q.to + ' ' + when + ' (' + r.reason + ')'); continue; }
    if (r.truncated) stats.truncated.push(q.from + '→' + q.to + ' ' + when);
    if (r.legacy) stats.legacy.push(q.from + '→' + q.to + ' ' + when);
    stats.flightRows += r.rows.length;

    for (const f of r.rows) {
      if (typeof f.stopMinutes === 'number' && f.stopMinutes > maxStop) { stats.flightDroppedLongStop++; continue; }
      const airline = String((f.no || '').split('+')[0]).slice(0, 2);
      // 真实机场优先；旧缓存没有这两列时才按航司推断
      const from = f.depAp || airportOf(q.from, airline);
      const to = f.arrAp || airportOf(q.to, airline);
      if (f.depAp && f.arrAp) stats.airportReal++;
      else stats.airportGuessed++;
      if (from === to) { stats.flightDroppedNoAirport++; continue; }

      const depDate = f.date;
      const arrDate = f.arrDate || f.date;
      const depAbs = dayNum(depDate) * 1440 + hhmm(f.dep);
      let arrAbs = dayNum(arrDate) * 1440 + hhmm(f.arr);
      if (arrAbs <= depAbs) arrAbs += 1440;              // 数据缺 arrDate 时的兜底

      legs.push({
        mode: 'flight',
        from, to,
        fromName: f.depApName || '',
        toName: f.arrApName || '',
        depAbs, arrAbs,
        cost: (f.price || 0) + (f.tax || 0),
        fare: f.price || 0,
        tax: f.tax || 0,
        ref: f.no || '—',
        airline,
        seg: typeof f.seg === 'number' ? f.seg : (f.tag === '直飞' || !f.tag ? 1 : 2),
        seats: typeof f.seats === 'number' ? f.seats : null,
        stopMinutes: f.stopMinutes || 0,
        entryMin: (modeDef.flight || {}).entryMin || 30,
        exitMin: (modeDef.flight || {}).exitMin || 20,
        note: f.tag || '',
        scheduled: true,
      });
      stats.flightKept++;
    }
  }

  // ── 高铁（时刻表是每日班次，按 case 的日期范围展开） ──
  const win = caseCfg.dates || {};
  const railFrom = dayNum(win.from), railTo = dayNum(win.to);
  for (const r of net.rail || []) {
    stats.railRows++;
    for (let d = railFrom; d <= railTo; d++) {
      const depAbs = d * 1440 + hhmm(r.dep);
      let arrAbs = d * 1440 + hhmm(r.arr);
      if (arrAbs <= depAbs) arrAbs += 1440;
      legs.push({
        mode: 'rail',
        from: r.from, to: r.to,
        fromName: (net.nodes[r.from] || {}).name || '',
        toName: (net.nodes[r.to] || {}).name || '',
        depAbs, arrAbs,
        cost: r.cost || 0,
        fare: r.cost || 0,
        tax: 0,
        ref: r.no,
        airline: null,
        seg: 1,
        seats: null,
        entryMin: (modeDef.rail || {}).entryMin || 15,
        exitMin: (modeDef.rail || {}).exitMin || 5,
        note: r.note || '',
        scheduled: true,
      });
    }
  }

  // ── 打车 / 接驳（双向，即到即走） ──
  for (const g of net.ground || []) {
    stats.groundRows += 2;
    for (const [a, b] of [[g.from, g.to], [g.to, g.from]]) {
      // 备注按里程/车费写的，方向要跟着反过来，否则 hover 里会出现「机场→车站」贴在反向边的位置上
      const note = g.note && a !== g.from ? flipNote(g.note) : (g.note || '');
      // 车种标签：路径表里给 cls（电车 / 特急 / 新干线 / 巴士），没给才用方式兜底。
      // 标签带里程——「特急 33km」比「雪场接驳」有用得多，能一眼看出这段路值不值这个价。
      const km = g.km || null;
      const cls = g.cls || (g.mode === 'shuttle' ? '接驳' : g.mode === 'taxi' ? '打车' : g.mode === 'rail' ? '电车' : g.mode);
      const label = km == null ? cls : cls + ' ' + (Math.round(km * 10) / 10) + 'km';
      legs.push({
        mode: g.mode,
        from: a, to: b,
        fromName: (net.nodes[a] || {}).name || '',
        toName: (net.nodes[b] || {}).name || '',
        depAbs: null, arrAbs: null,
        durMin: g.min,
        waitMin: g.waitMin || 0,
        // 服务时间窗（当日分钟数）。给了就表示「只在首末班之间可乘」：
        // 到了太晚就等次日首班，太早就等当日首班。日本电车按平均候车估算时靠它兜住末班。
        serviceFrom: g.serviceFrom == null ? null : Number(g.serviceFrom),
        serviceTo: g.serviceTo == null ? null : Number(g.serviceTo),
        cost: g.cost || 0,
        fare: g.cost || 0,
        tax: 0,
        // service 由路径表显式给（如「スカイライナー」「京急+JR」）；没给才用通用名。
        // 一个案例里有多条接驳时，全叫「雪场接驳」会把机场快线也标成雪场接驳。
        ref: g.service || (g.mode === 'shuttle' ? '雪场接驳' : '打车'),
        cls,
        label,
        airline: null,
        seg: 1,
        seats: null,
        km,
        entryMin: (modeDef[g.mode] || {}).entryMin || 0,
        exitMin: (modeDef[g.mode] || {}).exitMin || 0,
        note,
        scheduled: false,
      });
    }
  }

  return { legs, stats, net };
}

// ---------------------------------------------------------------- CSV
function toRows(legs) {
  return legs.map((l) => ({
    from: l.from,
    to: l.to,
    start: l.scheduled ? fmtAbs(l.depAbs) : '即到即走',
    end: l.scheduled ? fmtAbs(l.arrAbs) : '—',
    cost: l.cost,
    mode: l.mode,
    ref: l.label || l.ref,
    seg: l.seg,
    note: l.note,
  }));
}

function writeCsv(legs, file) {
  const head = ['起点', '终点', '开始时间', '结束时间', '花费', '方式', '班次', '段数', '备注'];
  const lines = [head.join(',')];
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  for (const r of toRows(legs)) {
    lines.push([r.from, r.to, r.start, r.end, r.cost, r.mode, r.ref, r.seg, r.note].map(esc).join(','));
  }
  fs.writeFileSync(file, '\uFEFF' + lines.join('\n'), 'utf8');
}

module.exports = {
  buildLegs, loadNetwork, writeCsv, toRows,
  dayNum, dayStr, wdOf, WD_CN, hhmm, fmtAbs, fmtDate, fmtTime, airportOf,
};

// ---------------------------------------------------------------- CLI
if (require.main === module) {
  const argv = process.argv.slice(2);
  const cfgPath = argv.find((a) => !a.startsWith('--'));
  if (!cfgPath) { console.error('用法: node legs.js <case.json> [--out legs.csv]'); process.exit(1); }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const { legs, stats } = buildLegs(cfg, { baseDir: path.dirname(path.resolve(cfgPath)) });
  const oi = argv.indexOf('--out');
  const out = oi > -1 ? argv[oi + 1] : path.join(path.dirname(path.resolve(cfgPath)), 'legs.csv');
  writeCsv(legs, out);
  fs.writeFileSync(out.replace(/\.csv$/, '') + '.json', JSON.stringify(legs), 'utf8');

  const by = {};
  for (const l of legs) by[l.mode] = (by[l.mode] || 0) + 1;
  console.log('网络边表');
  console.log('  航班 ' + (by.flight || 0) + ' 条（读入 ' + stats.flightRows + ' 行，剔除长中转 ' + stats.flightDroppedLongStop + ' 条）');
  console.log('    机场来源：真实 ' + stats.airportReal + ' 条 / 按航司推断 ' + stats.airportGuessed + ' 条');
  console.log('  高铁 ' + (by.rail || 0) + ' 条　打车 ' + (by.taxi || 0) + ' 条　接驳 ' + (by.shuttle || 0) + ' 条');
  if (stats.legacy.length) console.log('  · 缓存按 tag 复用（SQL 升级后 key 变了）：' + stats.legacy.join('；'));
  if (stats.cacheMiss.length) console.log('  ⚠ 缺缓存：' + stats.cacheMiss.join('；'));
  if (stats.truncated.length) console.log('  ⚠ 结果被截断：' + stats.truncated.join('；'));
  console.log('CSV  →', out);
}
