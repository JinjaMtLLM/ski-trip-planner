#!/usr/bin/env node
'use strict';
/**
 * build_baseline.js — 从 fares.csv 生成/更新「方案基线清单」。
 *
 * 作用：每天只跑一次时，最大的风险不是拿不到数据，而是**拿到了却缺几条而不自知**。
 * 基线把「应该有哪些方案」变成显式清单，每次运行后比对，缺席项必须报出来。
 *
 * 它只做聚合，不解析原文——数据来源仍是 LLM 写进 fares.csv 的行。
 *
 * 用法：
 *   node scripts/build_baseline.js              # 重建基线
 *   node scripts/build_baseline.js --check      # 只比对最近一批，不写盘（退出码 1 = 有缺口）
 *   node scripts/build_baseline.js --check --at "2026/10/28 09:30:00"
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'out', 'fare-watch');
const CSV = path.join(DIR, 'fares.csv');
const BASE = path.join(DIR, 'baseline.json');

const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const CHECK = argv.includes('--check');
const ONLY_AT = argOf('--at', null);

const LLM_EPOCH = '2026/10/28 01:28';
// 核心方案：出现频率最高、且覆盖「最便宜 / 当天可接 / 直飞价格锚」三类
const CORE = ['9C7142+9C7680', '9C6620+9C7680', '9C6620+9C6166', '9H8380+ZH9206', 'CZ9001'];
const ACTIVE_RUNS = 3;    // 最近 3 批内出现过 → active
const RETIRE_RUNS = 5;    // 连续 5 批未出现 → retired

function loadRows() {
  if (!fs.existsSync(CSV)) {
    console.error('找不到 ' + CSV);
    process.exit(2);
  }
  const lines = fs.readFileSync(CSV, 'utf8').trim().split('\n');
  return lines.slice(1).map((l) => {
    const c = l.split(',');
    return {
      at: c[0], route: c[1], date: c[2], flights: c[3], hub: c[4],
      segs: Number(c[5]), fare: Number(c[6]), tax: Number(c[7]),
      total: Number(c[8]), dur: Number(c[9]), arrive: c[10],
    };
  }).filter((r) => r.at >= LLM_EPOCH);
}

/** 所有批次时间戳，升序 */
function batchList(rows) {
  return [...new Set(rows.map((r) => r.at))].sort();
}

// ---------- 重建 ----------
function rebuild() {
  const rows = loadRows();
  const batches = batchList(rows);
  const lastIdx = batches.length - 1;

  const schemes = new Map();
  for (const r of rows) {
    const idx = batches.indexOf(r.at);
    if (!schemes.has(r.flights)) {
      schemes.set(r.flights, {
        hub: r.hub, segs: r.segs, fare: r.fare, total: r.total,
        dur: r.dur, arrive: r.arrive,
        firstSeen: r.at, lastSeen: r.at, seen: 0, lastIdx: -1,
        fares: new Set(),
      });
    }
    const e = schemes.get(r.flights);
    e.seen++;
    e.lastSeen = r.at;
    e.lastIdx = idx;
    e.fares.add(r.fare);
    e.hub = r.hub; e.segs = r.segs; e.fare = r.fare; e.total = r.total;
    e.dur = r.dur; e.arrive = r.arrive;
  }

  const out = {};
  for (const [k, e] of schemes) {
    const gap = lastIdx - e.lastIdx;          // 距最近一批隔了几批
    const status = gap < ACTIVE_RUNS ? 'active' : gap < RETIRE_RUNS ? 'stale' : 'retired';
    const priceRange = [...e.fares].sort((a, b) => a - b);
    out[k] = {
      hub: e.hub, segs: e.segs, fare: e.fare, total: e.total,
      dur: e.dur, arrive: e.arrive,
      seen: e.seen, lastSeen: e.lastSeen, gapRuns: gap,
      status,
      priceRange: priceRange.length > 1 ? [priceRange[0], priceRange[priceRange.length - 1]] : [priceRange[0]],
    };
  }

  const active = Object.entries(out).filter(([, v]) => v.status === 'active');
  const minTotal = active.length ? Math.min(...active.map(([, v]) => v.total)) : null;

  const base = {
    generated: new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }),
    route: 'AAT→SZX',
    date: '2027-01-03',
    epoch: LLM_EPOCH,
    runs: batches.length,
    lastBatch: batches[lastIdx],
    core: CORE,
    activeCount: active.length,
    minTotalActive: minTotal,
    schemes: out,
  };
  fs.writeFileSync(BASE, JSON.stringify(base, null, 2) + '\n', 'utf8');

  const cnt = { active: 0, stale: 0, retired: 0 };
  for (const v of Object.values(out)) cnt[v.status]++;
  console.log(`基线已更新　${base.generated}`);
  console.log(`  批次数 ${batches.length}　方案 ${Object.keys(out).length} 个　` +
    `active ${cnt.active} / stale ${cnt.stale} / retired ${cnt.retired}`);
  console.log(`  当前最低含税（active 内）¥${minTotal}`);
  console.log(`  核心方案：${CORE.map((k) => (out[k] ? (out[k].status === 'active' ? '✓' : '·') + k : '✗' + k)).join('  ')}`);
}

// ---------- 比对 ----------
function check() {
  if (!fs.existsSync(BASE)) {
    console.error('基线不存在，先跑 node scripts/build_baseline.js');
    process.exit(2);
  }
  const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  const rows = loadRows();
  const batches = batchList(rows);
  const at = ONLY_AT || batches[batches.length - 1];
  const batch = rows.filter((r) => r.at === at);
  if (!batch.length) {
    console.error(`找不到批次 ${at}`);
    process.exit(2);
  }

  const have = new Set(batch.map((r) => r.flights));
  const activeKeys = Object.entries(base.schemes)
    .filter(([, v]) => v.status === 'active')
    .map(([k]) => k);

  const missing = activeKeys.filter((k) => !have.has(k));
  const coreMissing = CORE.filter((k) => !have.has(k));
  const fresh = batch.map((r) => r.flights).filter((k) => !base.schemes[k]);
  const minTotal = Math.min(...batch.map((r) => r.total));

  console.log(`基线比对　${at}`);
  console.log(`  本次 ${batch.length} 条　基线 active ${activeKeys.length} 个`);
  console.log(`  coreHit ${CORE.length - coreMissing.length}/${CORE.length}` +
    (coreMissing.length ? `　缺：${coreMissing.join(' ')}` : '　核心全到'));
  console.log(`  本次最低含税 ¥${minTotal}` +
    (base.minTotalActive && minTotal > base.minTotalActive
      ? `　⚠ 高于基线最低 ¥${base.minTotalActive}（可能只是缺档，不代表涨价）`
      : ''));

  if (missing.length) {
    console.log(`  ⚠ 缺席 ${missing.length} 个 active 方案：`);
    for (const k of missing) {
      const v = base.schemes[k];
      console.log(`      ${k.padEnd(20)} ${v.hub} ¥${v.fare}（历史出现 ${v.seen} 次，最后 ${v.lastSeen.slice(11)}）`);
    }
  } else {
    console.log('  无缺席');
  }
  if (fresh.length) console.log(`  新增 ${fresh.length} 个基线外方案：${fresh.join(' ')}`);

  const bad = coreMissing.length > 0 || missing.length >= 3;
  console.log(bad ? '\n判定：覆盖不足 → 按每日模式 G3 重试' : '\n判定：覆盖达标');
  process.exit(bad ? 1 : 0);
}

(CHECK ? check : rebuild)();
