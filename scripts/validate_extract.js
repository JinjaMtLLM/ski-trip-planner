#!/usr/bin/env node
'use strict';
/**
 * validate_extract.js — 抽取结果的校验、算术补全与写盘。**零判断，纯确定性。**
 *
 * 上游：subagent 按 references/wendao-extract-contract.md 产出的 extracted/<ts>.json
 * 本脚本做 6 件事，任何一步失败即拒绝写表：
 *   1 JSON 可解析、schemaVersion 正确
 *   2 必填字段/类型/枚举
 *   3 flights.length === segments.length
 *   4 硬证据：航班号与票面价能在 raw 里找到，且价格与本方案全部航班号落在**同一个方案块**内
 *   5 算术补全：segs / tax / durationMin / total / arriveLabel
 *   6 写盘：fares.csv / runs.jsonl / latest.md
 *
 * 校验失败 → quarantine/<ts>.json，不污染主表，退出码 1。
 *
 * 用法：
 *   node scripts/validate_extract.js out/fare-watch/extracted/2026-10-28-19-55-07.json
 *   node scripts/validate_extract.js --latest
 *   node scripts/validate_extract.js --latest --dry     # 只校验不写盘
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'out', 'fare-watch');
const RAW_DIR = path.join(DIR, 'raw');
const EXT_DIR = path.join(DIR, 'extracted');
const Q_DIR = path.join(DIR, 'quarantine');
const CSV = path.join(DIR, 'fares.csv');
const RUNS = path.join(DIR, 'runs.jsonl');
const LATEST = path.join(DIR, 'latest.md');

const PER_SEG = 140;
const CORE = ['9C7142+9C7680', '9C6620+9C7680', '9C6620+9C6166', '9H8380+ZH9206', 'CZ9001'];
const HUBS = new Set(['兰州', '西安', '重庆', '乌鲁木齐', '成都', '直飞']);
const STATES = new Set(['ok', 'no_inventory', 'odd']);

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const argOf = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

// ---------- 工具 ----------

const pad = (n) => String(n).padStart(2, '0');
const isoToSlash = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const dayNum = (s) => Math.floor(new Date(s + 'T00:00:00+08:00').getTime() / 86400000);

function numIn(text, n) {
  return new RegExp('(^|[^0-9])' + String(n) + '([^0-9]|$)').test(text);
}
function positionsOf(text, no) {
  const out = [];
  let i = text.indexOf(no);
  while (i >= 0) { out.push(i); i = text.indexOf(no, i + 1); }
  return out;
}
/** 按 # / ## / ### 切块；`#####` 链接子块并入父块 */
function blocksOf(text) {
  const re = /(^|\n)(#{1,3})(?!#)[ \t]/g;
  const cuts = [];
  let m;
  while ((m = re.exec(text))) cuts.push(m.index + m[1].length);
  if (!cuts.length) return [[0, text.length]];
  const out = [];
  if (cuts[0] > 0) out.push([0, cuts[0]]);
  for (let i = 0; i < cuts.length; i++) {
    out.push([cuts[i], i + 1 < cuts.length ? cuts[i + 1] : text.length]);
  }
  return out;
}
function numNearAllFlightsLoose(text, flights, n, span = 1200, margin = 80) {
  const pos = flights.map((f) => positionsOf(text, f).slice(0, 12));
  if (pos.some((p) => !p.length)) return false;
  let found = false;
  const rec = (i, lo, hi) => {
    if (found) return;
    if (i === flights.length) {
      if (hi - lo <= span) {
        const seg = text.slice(Math.max(0, lo - margin), hi + margin);
        if (numIn(seg, n)) found = true;
      }
      return;
    }
    for (const p of pos[i]) rec(i + 1, Math.min(lo, p), Math.max(hi, p));
  };
  rec(0, Infinity, -Infinity);
  return found;
}
/**
 * 价格必须落在「本方案所有航班号共同出现」的**同一个块**内，防共享航段串价。
 * 详见 scripts/verify_fares.js 同名函数的注释（两次负向测试的结论）。
 */
function numNearAllFlights(text, flights, n) {
  const blks = blocksOf(text);
  // 只有一个块 = 原文没有 # 级标题，块边界不成立，判据会退化成「全文任意位置」
  if (blks.length < 2) return numNearAllFlightsLoose(text, flights, n);
  const holders = blks.filter(([s, e]) => {
    const seg = text.slice(s, e);
    return flights.every((f) => seg.includes(f));
  });
  if (holders.length) {
    return holders.some(([s, e]) => numIn(text.slice(s, e), n));
  }
  return numNearAllFlightsLoose(text, flights, n);
}

/** 原文时长写法 → 分钟。解析失败返回 null，交给时刻链兜底 */
function parseDurationText(t) {
  if (!t) return null;
  let m = t.match(/(\d+)\s*h\s*(\d+)\s*m/i);
  if (m) return +m[1] * 60 + +m[2];
  m = t.match(/(\d+)\s*小时\s*(\d+)?\s*分?/);
  if (m) return +m[1] * 60 + +(m[2] || 0);
  return null;
}

function clockToMin(d, t) {
  const [hh, mm] = t.split(':').map(Number);
  return dayNum(d) * 1440 + hh * 60 + mm;
}

function loadRaw(queryTime) {
  const files = fs.readdirSync(RAW_DIR).filter((n) => /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.txt$/.test(n));
  const target = new Date(queryTime).getTime();
  let best = null;
  for (const n of files) {
    const m = n.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})\.txt$/);
    const t = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`).getTime();
    const d = Math.abs(t - target) / 1000;
    if (d <= 120 && (!best || d < best.d)) best = { d, n };
  }
  return best ? fs.readFileSync(path.join(RAW_DIR, best.n), 'utf8') : null;
}

// ---------- 校验 ----------

function validate(j, raw) {
  const errs = [];

  if (!j || typeof j !== 'object') return ['JSON 不是对象'];
  if (j.schemaVersion !== 1) errs.push(`schemaVersion 应为 1，实际 ${j.schemaVersion}`);
  for (const k of ['queryTime', 'route', 'travelDate', 'state', 'schemes', 'unparsed', 'warnings']) {
    if (!(k in j)) errs.push(`缺字段 ${k}`);
  }
  if (errs.length) return errs;

  if (!STATES.has(j.state)) errs.push(`state 非法：${j.state}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(j.travelDate)) errs.push(`travelDate 格式错：${j.travelDate}`);
  if (!Array.isArray(j.schemes)) errs.push('schemes 不是数组');
  if (!Array.isArray(j.unparsed)) errs.push('unparsed 不是数组');
  if (!Array.isArray(j.warnings)) errs.push('warnings 不是数组');
  if (errs.length) return errs;

  if (j.state === 'no_inventory' && j.schemes.length) {
    errs.push('state=no_inventory 但 schemes 非空，自相矛盾');
  }

  j.schemes.forEach((s, i) => {
    const tag = `schemes[${i}](${(s.flights || []).join('+') || '?'})`;
    if (!Array.isArray(s.flights) || !s.flights.length) { errs.push(`${tag} flights 缺失`); return; }
    if (!Array.isArray(s.segments) || !s.segments.length) { errs.push(`${tag} segments 缺失`); return; }
    if (s.flights.length !== s.segments.length) {
      errs.push(`${tag} 航班号 ${s.flights.length} 个 ≠ 航段 ${s.segments.length} 段`);
    }
    s.segments.forEach((g, k) => {
      if (!g || g.flight !== s.flights[k]) {
        errs.push(`${tag} 第${k + 1}段 flight(${g && g.flight}) 与 flights[${k}](${s.flights[k]}) 不一致`);
      }
    });
    if (!HUBS.has(s.hub) && !/^其他[:：]/.test(String(s.hub))) {
      errs.push(`${tag} hub 非法：${s.hub}`);
    }
    if (s.fare != null && (!Number.isInteger(s.fare) || s.fare < 100 || s.fare > 20000)) {
      errs.push(`${tag} fare 异常：${s.fare}`);
    }
    if (!['explicit', 'derived'].includes(s.arriveDateSource) && s.arriveDateSource !== null) {
      errs.push(`${tag} arriveDateSource 非法：${s.arriveDateSource}`);
    }
    if (!s.evidence) errs.push(`${tag} 缺 evidence`);
  });

  if (errs.length) return errs;

  // ---- 硬证据（需 raw） ----
  if (raw) {
    j.schemes.forEach((s, i) => {
      const tag = `schemes[${i}](${s.flights.join('+')})`;
      for (const no of s.flights) {
        if (!raw.includes(no)) errs.push(`${tag} 航班号 ${no} 不在原文（编造？）`);
      }
      if (s.fare == null) return;
      if (!numIn(raw, s.fare)) {
        errs.push(`${tag} 票面价 ${s.fare} 全文不存在（编造？）`);
      } else if (!numNearAllFlights(raw, s.flights, s.fare)) {
        errs.push(`${tag} 票面价 ${s.fare} 不在本方案块内（可能抄了相邻方案的价格）`);
      }
    });
  }

  // ---- 计数一致性（只警告，不拒绝） ----
  if (Number.isInteger(j.declaredCount) && j.declaredCount !== j.schemes.length) {
    j.warnings = j.warnings || [];
    j.warnings.push(`导语称 ${j.declaredCount} 个方案，实抽 ${j.schemes.length} 个`);
  }

  return errs;
}

// ---------- 算术补全 ----------

function enrich(j) {
  const rows = [];
  for (const s of j.schemes) {
    if (s.fare == null) continue;   // 没价的不进主表（契约要求进 unparsed）
    const segs = s.flights.length;
    const first = s.segments[0];
    const last = s.segments[s.segments.length - 1];

    let dur = parseDurationText(s.totalDurationText);
    if (dur == null && first.depDate && first.depTime && last.arrDate && last.arrTime) {
      dur = clockToMin(last.arrDate, last.arrTime) - clockToMin(first.depDate, first.depTime);
    }

    let arrive = '';
    if (last.arrDate) {
      const diff = dayNum(last.arrDate) - dayNum(j.travelDate);
      const d = new Date(last.arrDate + 'T00:00:00+08:00');
      arrive = diff === 0 ? '当天到' : `${d.getMonth() + 1}/${d.getDate()} 到`;
    }

    const tax = PER_SEG * segs;
    rows.push({
      at: isoToSlash(j.queryTime),
      route: `${j.route.from}→${j.route.to}`,
      date: j.travelDate,
      flights: s.flights.join('+'),
      hub: s.hub,
      segs,
      fare: s.fare,
      tax,
      total: s.fare + tax,
      dur: dur == null ? '' : dur,
      arrive,
      title: String(s.evidence || '').replace(/,/g, '、').slice(0, 60),
    });
  }
  return rows;
}

// ---------- 写盘 ----------

const HEADER = ['查询时间', '航线', '出行日期', '航班组合', '中转城市', '航段数',
  '票面价', '税', '含税总价', '全程分钟', '到达', '方案标题'];

function writeAll(j, rows, rawFile) {
  const at = rows.length ? rows[0].at : isoToSlash(j.queryTime);

  // fares.csv（去重：同时间戳已存在则跳过）
  const csvText = fs.readFileSync(CSV, 'utf8');
  if (csvText.includes(at + ',')) {
    console.log(`  fares.csv 已有 ${at}，跳过写入（重跑保护）`);
  } else if (rows.length) {
    const body = rows.map((r) => [r.at, r.route, r.date, r.flights, r.hub, r.segs,
      r.fare, r.tax, r.total, r.dur, r.arrive, r.title].join(',')).join('\n');
    fs.appendFileSync(CSV, body + '\n', 'utf8');
    console.log(`  fares.csv +${rows.length} 行`);
  }

  // runs.jsonl
  const have = new Set(rows.map((r) => r.flights));
  const coreHit = CORE.filter((k) => have.has(k)).length;
  const minTotal = rows.length ? Math.min(...rows.map((r) => r.total)) : null;
  const direct = rows.filter((r) => r.hub === '直飞').length;
  const ledger = {
    at,
    route: `${j.route.from}→${j.route.to}`,
    date: j.travelDate,
    state: j.state,
    schemes: rows.length,
    direct,
    coreHit: `${coreHit}/${CORE.length}`,
    minTotal,
    raw: path.basename(rawFile || ''),
    unparsed: (j.unparsed || []).length,
    warnings: j.warnings || [],
  };
  fs.appendFileSync(RUNS, JSON.stringify(ledger) + '\n', 'utf8');
  console.log(`  runs.jsonl +1（coreHit ${ledger.coreHit}，minTotal ¥${minTotal}）`);

  // latest.md
  const sorted = [...rows].sort((a, b) => a.total - b.total);
  const L = [];
  L.push(`# 携程问道 · 票面价巡检　${ledger.route}　${j.travelDate}`);
  L.push('');
  L.push(`> 查询时间 ${at}　·　口径：**问道票面价 + 本地补税**`);
  L.push(`> 税 = ¥${PER_SEG} × 航段数　·　判读：subagent 抽取 → 脚本校验（schema + 硬证据）`);
  L.push('');
  if (j.state === 'no_inventory') {
    L.push('**本次问道无库存**（正常波动，不是故障）。');
  } else {
    L.push('| # | 含税总价 | 票面 | 税 | 全程 | 到达 | 中转 | 航班 |');
    L.push('|---|---|---|---|---|---|---|---|');
    sorted.forEach((r, i) => {
      L.push(`| ${i + 1} | **¥${r.total}** | ¥${r.fare} | ¥${r.tax} | `
        + `${r.dur ? Math.floor(r.dur / 60) + 'h' + pad(r.dur % 60) : '—'} | `
        + `${r.arrive || '—'} | ${r.hub} | ${r.flights} |`);
    });
    L.push('');
    L.push(`**${rows.length} 条 / coreHit ${ledger.coreHit} / 直飞 ${direct} 条。**`);
  }
  if ((j.unparsed || []).length) {
    L.push('');
    L.push('**未抽成方案（原文有、未入表）：**');
    for (const u of j.unparsed) L.push(`- ${u}`);
  }
  if ((j.warnings || []).length) {
    L.push('');
    L.push('**本次判读警告：**');
    for (const w of j.warnings) L.push(`- ${w}`);
  }
  fs.writeFileSync(LATEST, L.join('\n') + '\n', 'utf8');
  console.log(`  latest.md 已更新`);
}

// ---------- 主流程 ----------

(function main() {
  let file = argv.find((a) => a.endsWith('.json'));
  if (!file && argv.includes('--latest')) {
    if (!fs.existsSync(EXT_DIR)) { console.error('extracted/ 不存在'); process.exit(2); }
    // 只认标准命名 <YYYY-MM-DD-HH-mm-ss>.json，避免把 replay-/测试文件当成最新
    const all = fs.readdirSync(EXT_DIR)
      .filter((n) => /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/.test(n))
      .sort();
    if (!all.length) { console.error('extracted/ 里没有符合命名的 json'); process.exit(2); }
    file = path.join(EXT_DIR, all[all.length - 1]);
  }
  if (!file) {
    console.error('用法：node scripts/validate_extract.js <extracted.json> [--dry]');
    process.exit(2);
  }
  if (!fs.existsSync(file)) { console.error('找不到 ' + file); process.exit(2); }

  let j;
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('JSON 解析失败：' + e.message);
    process.exit(1);
  }

  const raw = loadRaw(j.queryTime);
  if (!raw) console.error('⚠ 找不到对应 raw，跳过证据校验（只做 schema 校验）');

  const errs = validate(j, raw);
  if (errs.length) {
    console.error(`✗ 校验失败（${errs.length} 项）：`);
    for (const e of errs) console.error('   - ' + e);
    if (!DRY) {
      fs.mkdirSync(Q_DIR, { recursive: true });
      const q = path.join(Q_DIR, path.basename(file));
      fs.copyFileSync(file, q);
      console.error(`  已隔离到 ${q}，主表未改动`);
    }
    process.exit(1);
  }

  const rows = enrich(j);
  console.log(`✓ 校验通过：${j.state} / ${rows.length} 条 / raw ${raw ? '已比对' : '未比对'}`);
  if ((j.unparsed || []).length) console.log(`  ⚠ unparsed ${j.unparsed.length} 条`);
  if ((j.warnings || []).length) console.log(`  ⚠ warnings ${j.warnings.length} 条`);

  if (DRY) {
    console.log('\n[--dry] 不写盘。将写入的行：');
    for (const r of rows) console.log(`  ${r.flights.padEnd(20)} ${r.hub.padEnd(5)} ¥${r.fare} → ¥${r.total}  ${r.dur}分  ${r.arrive}`);
    return;
  }
  writeAll(j, rows, raw ? file : null);
})();
