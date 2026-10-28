#!/usr/bin/env node
'use strict';
/**
 * ota-bridge.js — OTA 适配层回归测试，不联网、不碰 submodule、不用任何 key
 *
 * 验证五类容易回归的事：
 *   1. 含税口径：国内「裸价 + 税」、国际「price 已含税」不能混
 *   2. 分组去重：同 (起降时刻, 中转次数) 只留最便宜的一条
 *   3. 截断语义：perDay 取前 N；perTransfer 直飞全留 + 中转取前 N
 *   4. 不覆盖真实飞常准条目（--force 才覆盖）
 *   5. 端到端：写进去的条目，legs.js 真能按同一个键读到
 *
 * 第 5 条是这个文件存在的理由——键一旦跟 legs.js 漂了，前面四条全过也没用，
 * 表现是「抓了一堆数据，报告里一条航班都没有」。
 *
 * 用法：node tests/ota-bridge.js
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const bridge = require(path.join(ROOT, 'scripts', 'ota', 'bridge.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ski-ota-'));

let pass = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    console.error('  FAIL ' + name);
    console.error('       ' + e.message);
    process.exitCode = 1;
  }
}

// ── 合成数据（价格、航班号全是编的）──────────────────────────────────
const D1 = '2027-03-06';
const D2 = '2027-03-08';

/** 国内形态：price 裸价，tax 另给 */
function dom(no, dep, arr, price, tax, segs, via, stop) {
  return { no, dep, arr, price, tax, segs, via: via || '', stop: stop || 0, ch: 'fliggy' };
}

/** 国际形态：price 已含税，fare 才是票面 */
function intl(no, dep, arr, total, tax, segs, via, stop) {
  return { no, dep, arr, price: total, fare: total - tax, tax, segs,
    via: via || '', stop: stop || 0, ch: 'ctrip' };
}

function writeOta(file, obj) {
  const p = path.join(TMP, file);
  fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
  return p;
}

const otaDom = {
  [`AAA|BBB|${D1}`]: {
    fliggy: [
      dom('ZZ100', '08:00', '10:00', 1000, 140, 1),          // 直飞 A
      dom('ZZ100', '08:00', '10:00', 1200, 140, 1),          // 同组更贵 → 应被丢弃
      dom('ZZ200', '12:00', '16:30', 800, 280, 2, '中转城', 150),
      dom('ZZ300', '14:00', '19:00', 700, 280, 2, '中转城', 180),
      dom('ZZ400', '16:00', '21:30', 650, 280, 2, '中转城', 200),
    ],
  },
  [`AAA|BBB|${D2}`]: {
    fliggy: [dom('ZZ101', '09:00', '11:00', 1100, 140, 1)],
  },
  [`BBB|AAA|${D2}`]: {
    fliggy: [dom('ZZ102', '18:00', '20:00', 900, 140, 1)],
  },
};
const otaIntl = {
  [`AAA|BBB|${D1}`]: {
    ctrip: [
      intl('CX800', '09:00', '14:00', 3000, 600, 1),
      intl('CX801', '11:00', '20:00', 1800, 900, 2, '港城', 120),
    ],
  },
};

// ── 1. 含税口径 ────────────────────────────────────────────────────────
check('国内行：总价 = 裸价 + 税', () => {
  const f = dom('ZZ100', '08:00', '10:00', 1000, 140, 1);
  assert.strictEqual(bridge.totalOf(f), 1140);
});

check('国际行：price 已含税，不再加 tax', () => {
  const f = intl('CX800', '09:00', '14:00', 3000, 600, 1);
  assert.strictEqual(bridge.totalOf(f), 3000, '国际行把 tax 再加一次就重复计税了');
});

// ── 2. 分组去重 ────────────────────────────────────────────────────────
check('同 (起降时刻, 中转次数) 只留最便宜的一条', () => {
  const list = [
    dom('ZZ100', '08:00', '10:00', 1000, 140, 1),
    dom('ZZ100', '08:00', '10:00', 1200, 140, 1),
  ];
  const out = bridge.pickPerDay(list, 10);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(bridge.totalOf(out[0]), 1140, '应留下 ¥1,140 那条');
});

// ── 3. 截断语义 ────────────────────────────────────────────────────────
check('perDay：按价格取前 N', () => {
  const list = [
    dom('ZZ100', '08:00', '10:00', 1000, 140, 1),
    dom('ZZ200', '12:00', '16:30', 800, 280, 2, '中', 150),
    dom('ZZ300', '14:00', '19:00', 700, 280, 2, '中', 180),
  ];
  const out = bridge.pickPerDay(list, 2);
  assert.deepStrictEqual(out.map((f) => f.no), ['ZZ300', 'ZZ200']);
});

check('perTransfer：直飞全留（哪怕更贵）+ 中转取前 N', () => {
  const list = [
    dom('ZZ100', '08:00', '10:00', 1000, 140, 1),
    dom('ZZ200', '12:00', '16:30', 800, 280, 2, '中', 150),
    dom('ZZ300', '14:00', '19:00', 700, 280, 2, '中', 180),
    dom('ZZ400', '16:00', '21:30', 650, 280, 2, '中', 200),
  ];
  const out = bridge.pickPerTransfer(list, 1, false);
  const nos = out.map((f) => f.no);
  assert.ok(nos.includes('ZZ100'), '直飞必须留下');
  assert.ok(nos.includes('ZZ400'), '中转只留最便宜的 1 条');
  assert.strictEqual(out.length, 2);
});

check('directOnly：只要直飞', () => {
  const list = [
    dom('ZZ100', '08:00', '10:00', 1000, 140, 1),
    dom('ZZ200', '12:00', '16:30', 800, 280, 2, '中', 150),
  ];
  assert.deepStrictEqual(bridge.pickPerTransfer(list, 5, true).map((f) => f.no), ['ZZ100']);
});

// ── 4. 不覆盖真实飞常准条目 ────────────────────────────────────────────
const cacheDir = path.join(TMP, 'cache');
fs.mkdirSync(cacheDir, { recursive: true });
process.env.SKI_CACHE_DIR = cacheDir;      // 必须在 require cache 之前生效

const cache = require(path.join(ROOT, 'scripts', 'cache.js'));
const vf = require(path.join(ROOT, 'scripts', 'variflight.js'));

const cfg = {
  params: { perDay: 10, maxStopMinutes: 960 },
  flightQueries: [{ from: 'AAA', to: 'BBB', dates: [D1, D2] }],
};
const otaFile = writeOta('AAA-BBB.json', otaDom);

function keyOf(c, q) {
  const dates = q.dates;
  const sources = dates.map((d) => ({ from: q.from, to: q.to, date: d }));
  const sql = vf.buildSqlPerDay(sources, c.params.perDay, '', c.params.maxStopMinutes);
  return { sql, key: cache.keyOf('getFlightTicketPrice', { sql }) };
}

check('写进去的条目 cache.read() 能读到（schema/key 正确）', () => {
  const r = bridge.buildEntries({ cfg, otaFiles: [otaFile], log: () => {} });
  assert.strictEqual(r.written.length, 1);
  const { key } = keyOf(cfg, cfg.flightQueries[0]);
  const entry = cache.read(key);
  assert.ok(entry, 'cache.read() 读不到 → schema 或 key 写错了');
  assert.strictEqual(entry.source, 'ota');
  const rows = JSON.parse(entry.raw).item.data.rows;
  // D1：直飞 1 组（重复的那条被丢）+ 中转 3 组 = 4；D2：直飞 1 组
  assert.strictEqual(rows.length, 5, `应写 5 行，实际 ${rows.length}`);
});

check('已存在非 OTA 条目时默认跳过，--force 才覆盖', () => {
  const { key, sql } = keyOf(cfg, cfg.flightQueries[0]);
  const p = path.join(cacheDir, key + '.json');
  // 伪造一条「真实飞常准」条目
  fs.writeFileSync(p, JSON.stringify({
    schema: 1, key, tool: 'getFlightTicketPrice', args: { sql }, sql,
    createdAt: new Date().toISOString(), ok: true,
    raw: JSON.stringify({ item: { data: { rows: [] } } }),
  }), 'utf8');

  const r1 = bridge.buildEntries({ cfg, otaFiles: [otaFile], log: () => {} });
  assert.strictEqual(r1.written.length, 0, '不该覆盖非 OTA 条目');
  assert.strictEqual(r1.skipped.length, 1);

  const r2 = bridge.buildEntries({ cfg, otaFiles: [otaFile], force: true, log: () => {} });
  assert.strictEqual(r2.written.length, 1, '--force 应覆盖');
  assert.strictEqual(cache.read(key).source, 'ota');
});

// ── 5. 端到端：legs.js 能按同一个键读到 ────────────────────────────────
check('端到端：legs.js 读到桥接写入的航班', () => {
  const dir = path.join(TMP, 'case');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'network.json'), JSON.stringify({
    schema: 1,
    nodes: {
      AAA: { name: '起点机场', short: '起点', kind: 'airport', city: '起点城' },
      BBB: { name: '目的机场', short: '目的', kind: 'airport', city: '目的城' },
      RST: { name: '示例雪场', short: '雪场', kind: 'resort', city: '雪镇' },
    },
    modeDefaults: {
      flight: { entryMin: 30, exitMin: 20 },
      taxi: { entryMin: 0, exitMin: 0 },
    },
    airportOfAirline: { ZZ: 'BBB', CX: 'BBB', default: 'BBB' },
    ground: [
      { from: 'BBB', to: 'RST', mode: 'taxi', min: 60, waitMin: 5, cost: 200, km: 50, cls: '打车' },
      { from: 'RST', to: 'BBB', mode: 'taxi', min: 60, waitMin: 5, cost: 200, km: 50, cls: '打车' },
    ],
    rail: [],
    cityCodes: [],
  }), 'utf8');

  fs.writeFileSync(path.join(dir, 'case.json'), JSON.stringify({
    networkFile: 'network.json',
    resort: 'RST',
    dates: { from: D1, to: D2 },
    params: { perDay: 10, maxStopMinutes: 960 },
    flightQueries: [{ from: 'AAA', to: 'BBB', dates: [D1, D2] }],
  }), 'utf8');

  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'legs.js'), path.join(dir, 'case.json'),
    '--out', path.join(dir, 'legs.csv'),
  ], { encoding: 'utf8', env: { ...process.env, SKI_CACHE_DIR: cacheDir } });

  assert.strictEqual(r.status, 0, r.stderr || 'legs.js 非零退出');
  const m = /航班 (\d+) 条/.exec(r.stdout);
  assert.ok(m, '没解析到航班条数：' + r.stdout);
  assert.strictEqual(Number(m[1]), 5, `legs.js 应读到 5 条航班，实际 ${m[1]}\n${r.stdout}`);
  assert.ok(!/缺缓存/.test(r.stdout), '键不一致 → legs.js 报缺缓存：' + r.stdout);
});

console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : ''}`);
fs.rmSync(TMP, { recursive: true, force: true });
