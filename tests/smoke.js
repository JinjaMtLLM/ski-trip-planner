#!/usr/bin/env node
'use strict';
/**
 * smoke.js — 回归冒烟测试，不联网、不需要任何 key
 *
 * 只验证四类容易回归的事：
 *   1. 请假口径的三个时刻真的决定各档归属（0 / 0.5 / 1 天的边界）
 *   2. 输出按「元/雪日」升序，且档位不越界
 *   3. 缺字段、三时刻顺序颠倒时能报错退出，而不是静默算错
 *   4. 端到端：年假档来自组合实际值、报告首位是全部年假、趋势图不丢
 *
 * 用法：node tests/smoke.js
 */

const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PLANNER = path.join(ROOT, 'scripts', 'planner.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ski-smoke-'));

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

/** 合成配置：机场、航司、雪场全是虚构的，与真实行程无关 */
function baseConfig() {
  return {
    title: 'TEST → TEST 滑雪行程性价比',
    origin: { code: 'AAA', name: 'AAA 机场' },
    destAirport: { code: 'BBB', name: 'BBB 机场', toResortMinutes: 60, toResortMinutesSource: 'user' },
    resort: {
      name: 'Test Resort',
      dayOpen: '09:00', dayClose: '17:00',
      nightOpen: '18:00', nightClose: '21:00',
      nightWeight: 0.5, nightClosedWeekdays: [1],
    },
    params: {
      preFlightMinutes: 90,
      taxPerSegment: 100,
      lodgingResort: 200,
      lodgingTransit: 50,
      leave: { dayStart: '08:30', halfDayAt: '14:00', dayEnd: '20:00' },
      leaveBuckets: [0, 0.5, 1, 2],
    },
    scenarios: [{
      key: 's1',
      label: 'smoke',
      out: [
        { date: '2027-03-05', dep: '06:00', arr: '09:00', price: 500, tax: 100, no: 'TT1001', tag: '直飞' },
        { date: '2027-03-05', dep: '15:00', arr: '18:00', price: 450, tax: 100, no: 'TT1002', tag: '直飞' },
        { date: '2027-03-05', dep: '20:30', arr: '23:30', price: 400, tax: 100, no: 'TT1003', tag: '直飞' },
      ],
      ret: [
        { date: '2027-03-07', dep: '18:00', arr: '21:00', price: 480, tax: 100, no: 'TT2001', tag: '直飞' },
        { date: '2027-03-08', dep: '06:00', arr: '08:00', price: 420, tax: 100, no: 'TT2002', tag: '直飞' },
      ],
    }],
    output: 'report.html',
  };
}

function runPlanner(cfg, extra = ['--csv']) {
  const dir = fs.mkdtempSync(path.join(TMP, 'case-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 1), 'utf8');
  const r = spawnSync(process.execPath, [PLANNER, cfgPath, ...extra], { cwd: ROOT, encoding: 'utf8' });
  const csvPath = path.join(dir, 'report.csv');
  const csv = fs.existsSync(csvPath) ? fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '') : '';
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', dir, csv };
}

function rows(csv) {
  const lines = csv.trim().split('\n');
  const head = lines[0].split(',');
  return lines.slice(1).map((l) => {
    const cells = l.split(',');
    const o = {};
    head.forEach((h, i) => { o[h] = cells[i]; });
    return o;
  });
}

console.log('ski-trip-planner smoke test');

// ── 1. 正常配置：档位边界 + 排序 ───────────────────────────────────────
const cfg = baseConfig();
const ok = runPlanner(cfg);

check('按合成配置跑通并产出 CSV', () => {
  assert.strictEqual(ok.status, 0, 'planner 退出码 ' + ok.status + '\n' + ok.stderr);
  assert.ok(ok.csv.length > 0, 'CSV 为空');
});

check('档位只落在配置的 bucket 里', () => {
  for (const r of rows(ok.csv)) {
    assert.ok([0, 0.5, 1, 2].includes(Number(r['年假(天)'])), '越界档位 ' + r['年假(天)']);
  }
});

check('出发端按 halfDayAt / dayEnd 判 1 / 0.5 / 0 天', () => {
  const byDep = {};
  for (const r of rows(ok.csv)) byDep[r['起飞']] = Number(r['年假(天)']);
  assert.strictEqual(byDep['06:00'], 1, '早于 halfDayAt 应为 1 天');
  assert.strictEqual(byDep['15:00'], 0.5, 'halfDayAt 与 dayEnd 之间应为 0.5 天');
  assert.strictEqual(byDep['20:30'], 0, '晚于 dayEnd 应为 0 天');
});

check('返程端按 dayStart 判 0 天', () => {
  // 周一 06:00 起飞、08:00 落地（≤ dayStart）不请假，所以三档只由去程决定
  const pairs = {};
  for (const r of rows(ok.csv)) pairs[r['起飞']] = Number(r['年假(天)']);
  assert.strictEqual(Object.keys(pairs).length, 3, '去程组合数不对：' + JSON.stringify(pairs));
  assert.strictEqual(rows(ok.csv).length, 6, '组合数应为 3 去程 × 2 返程');
});

check('返程落在工作日且晚于 dayStart 时计入 1 天', () => {
  // 同一份配置，只把周一的返程改成 12:00 起飞 / 15:00 落地
  const late = baseConfig();
  late.scenarios[0].ret[1] = {
    date: '2027-03-08', dep: '12:00', arr: '15:00', price: 420, tax: 100, no: 'TT2003', tag: '直飞',
  };
  const r = runPlanner(late);
  assert.strictEqual(r.status, 0, 'planner 退出码 ' + r.status + '\n' + r.stderr);
  const list = rows(r.csv);
  assert.ok(list.some((x) => Number(x['年假(天)']) === 2), '应出现 1+1=2 天档');
  // 15:00 去程（0.5）+ 1 天返程 = 1.5 天，不在 bucket 内，应被滤掉
  assert.ok(!list.some((x) => Number(x['年假(天)']) === 1.5), '1.5 天组合不应出现');
});

check('元/日 升序', () => {
  const list = rows(ok.csv).map((r) => Number(r['元每日']));
  for (let i = 1; i < list.length; i++) {
    assert.ok(list[i] >= list[i - 1], '第 ' + (i + 1) + ' 行 ' + list[i] + ' < 上一行 ' + list[i - 1]);
  }
});

check('每个组合都有正的可滑行时数', () => {
  for (const r of rows(ok.csv)) {
    assert.ok(Number(r['总雪时']) > 0, '雪时为 0：' + JSON.stringify(r));
  }
});

// ── 2. 三时刻顺序颠倒必须报错 ─────────────────────────────────────────
const badOrder = baseConfig();
badOrder.params.leave = { dayStart: '20:00', halfDayAt: '14:00', dayEnd: '08:30' };
const bad = runPlanner(badOrder);

check('三时刻顺序颠倒时报错退出', () => {
  assert.notStrictEqual(bad.status, 0, '应当非零退出');
  assert.ok(/dayStart|halfDayAt|dayEnd/.test(bad.stderr + bad.stdout), '错误信息未指明字段');
});

// ── 3. 缺必填字段必须报错，不能静默取默认 ─────────────────────────────
const missing = baseConfig();
delete missing.params.lodgingResort;
const miss = runPlanner(missing);

check('缺 params.lodgingResort 时报错并点名', () => {
  assert.notStrictEqual(miss.status, 0, '应当非零退出');
  assert.ok(/lodgingResort/.test(miss.stderr + miss.stdout), '错误信息未点名字段');
});

const noFlights = baseConfig();
noFlights.scenarios[0].ret = [];
const nf = runPlanner(noFlights);

check('某方向没有航班时报错', () => {
  assert.notStrictEqual(nf.status, 0, '应当非零退出');
});

// ── 4. 图枚举引擎：雪时 / 年假 / 时间可行性 / 重定时 ───────────────────
console.log('\n图枚举引擎');

const G = require(path.join(ROOT, 'scripts', 'graphcore'));
const LK = require(path.join(ROOT, 'scripts', 'legs'));

const day = LK.dayNum;
const at = (dateStr, h, m) => day(dateStr) * 1440 + h * 60 + (m || 0);
const RULE = { dayStart: '10:00', halfDayAt: '13:30', dayEnd: '19:30' };
const RES = {
  dayOpen: '08:30', dayClose: '16:30',
  nightOpen: '18:30', nightClose: '21:30',
  nightWeight: 0.5, nightClosedWeekdays: [],
};

check('雪时 = 窗口与日场交集（同年同日）', () => {
  const h = G.snowHours(at('2026-11-28', 12, 0), at('2026-11-28', 14, 0), RES);
  assert.strictEqual(h.hDay, 2);
  assert.strictEqual(h.hNight, 0);
  assert.strictEqual(h.hEff, 2);
});

check('雪时跨日累计，夜场按权重折算', () => {
  // 周六 09:32 到场 → 周日 16:51 离场
  const h = G.snowHours(at('2026-11-28', 9, 32), at('2026-11-29', 16, 51), RES);
  assert.strictEqual(h.hDay, 14.97, '日场应 6.97 + 8');
  assert.strictEqual(h.hNight, 3, '只有周六夜场');
  assert.strictEqual(h.hEff, 16.47, '14.97 + 3×0.5');
});

check('夜场关闭日不计夜场', () => {
  const closed = { ...RES, nightClosedWeekdays: [6] };
  const h = G.snowHours(at('2026-11-28', 18, 0), at('2026-11-28', 21, 30), closed);
  assert.strictEqual(h.hNight, 0, '周六（wd=6）应关闭');
  assert.strictEqual(h.hEff, 0);
});

check('出发端：早于半天分界记 1 天，分界后 0.5，下班后 0', () => {
  assert.strictEqual(G.leaveOfOut(at('2026-11-27', 6, 0), RULE), 1);
  assert.strictEqual(G.leaveOfOut(at('2026-11-27', 15, 0), RULE), 0.5);
  assert.strictEqual(G.leaveOfOut(at('2026-11-27', 20, 0), RULE), 0);
});

check('出发端：周末出发不计年假', () => {
  assert.strictEqual(G.leaveOfOut(at('2026-11-28', 6, 0), RULE), 0);
});

check('返程端：上班前 0 天、上午 0.5 天、下午 1 天', () => {
  assert.strictEqual(G.leaveOfRet(at('2026-11-30', 9, 0), RULE), 0, '上班前落地不请假');
  assert.strictEqual(G.leaveOfRet(at('2026-11-30', 11, 0), RULE), 0.5, '上午落地只请半天');
  assert.strictEqual(G.leaveOfRet(at('2026-11-30', 13, 30), RULE), 0.5, '半天分界当刻仍算半天');
  assert.strictEqual(G.leaveOfRet(at('2026-11-30', 13, 31), RULE), 1, '过了半天分界算整天');
  assert.strictEqual(G.leaveOfRet(at('2026-11-30', 15, 0), RULE), 1);
  assert.strictEqual(G.leaveOfRet(at('2026-11-29', 20, 0), RULE), 0, '周末落地不请假');
});

check('中途工作日：跨周六日不额外计假', () => {
  assert.strictEqual(G.midWorkdays(at('2026-11-27', 20, 0), at('2026-11-30', 1, 35)), 0);
  assert.strictEqual(G.midWorkdays(at('2026-11-27', 20, 0), at('2026-12-01', 1, 35)), 1);
});

// 合成小图：AAA --航班--> BBB --打车--> RESORT
function tinyLegs(opts) {
  const o = opts || {};
  const legs = [{
    mode: 'flight', from: 'AAA', to: 'BBB', ref: 'TT1',
    depAbs: at('2026-11-28', 8, 0), arrAbs: at('2026-11-28', 11, 0),
    cost: 500, entryMin: 30, exitMin: 20, scheduled: true, stopMinutes: 0,
  }];
  legs.push({
    mode: 'taxi', from: 'BBB', to: 'RESORT', ref: '打车',
    depAbs: null, arrAbs: null, durMin: o.durMin || 60, waitMin: 5,
    cost: 100, entryMin: 0, exitMin: 0, scheduled: false,
  });
  return legs;
}

check('DFS 找到唯一路径，到场时刻 = 落地 + 出站 + 车程', () => {
  const legs = tinyLegs();
  const paths = G.dfsPaths(G.buildGraph(legs), 'AAA', 'RESORT', { minDep: 0, maxDep: Infinity });
  assert.strictEqual(paths.length, 1);
  assert.strictEqual(paths[0][1].dep, at('2026-11-28', 11, 20), '落地 11:00 + 出站 20 分钟即上车');
  assert.strictEqual(paths[0][1].arr, at('2026-11-28', 12, 25), '再 + 等车 5 + 车程 60');
});

check('进站时间不够时该衔接被排除', () => {
  const legs = tinyLegs();
  // 换成一段 10:50 发车的班期交通，进站 30 分钟 → 落地 11:00 已赶不上
  legs[1] = {
    mode: 'rail', from: 'BBB', to: 'RESORT', ref: 'G1',
    depAbs: at('2026-11-28', 10, 50), arrAbs: at('2026-11-28', 12, 0),
    cost: 100, entryMin: 30, exitMin: 5, scheduled: true,
  };
  const paths = G.dfsPaths(G.buildGraph(legs), 'AAA', 'RESORT', { minDep: 0, maxDep: Infinity });
  assert.strictEqual(paths.length, 0, '不该产生不可行路径');
});

check('不重复经过同一节点（不绕圈）', () => {
  const legs = tinyLegs();
  legs.push({
    mode: 'flight', from: 'BBB', to: 'AAA', ref: 'TT2',
    depAbs: at('2026-11-28', 13, 0), arrAbs: at('2026-11-28', 16, 0),
    cost: 500, entryMin: 30, exitMin: 20, scheduled: true,
  });
  const paths = G.dfsPaths(G.buildGraph(legs), 'AAA', 'RESORT', { minDep: 0, maxDep: Infinity, maxLegs: 5 });
  assert.strictEqual(paths.length, 1, '回到 AAA 后不应再展开');
});

check('返程重定时：刚好赶上，而不是提前干等', () => {
  const legs = [
    { mode: 'taxi', from: 'RESORT', to: 'BBB', ref: '打车', depAbs: null, arrAbs: null, durMin: 60, waitMin: 5, cost: 100, entryMin: 0, exitMin: 0, scheduled: false },
    { mode: 'flight', from: 'BBB', to: 'AAA', ref: 'TT3', depAbs: at('2026-11-30', 18, 0), arrAbs: at('2026-11-30', 21, 0), cost: 500, entryMin: 30, exitMin: 0, scheduled: true },
  ];
  // DFS 会给出「窗口一开就打车」，重定时后应改成 16:25 出发
  const raw = G.dfsPaths(G.buildGraph(legs), 'RESORT', 'AAA', { minDep: at('2026-11-28', 0, 0), maxDep: Infinity });
  assert.strictEqual(raw.length, 1);
  assert.strictEqual(raw[0][0].dep, at('2026-11-28', 0, 0), '未重定时是从窗口起点出发');
  const fixed = G.retimeReturn(raw[0].slice());
  assert.strictEqual(fixed[0].dep, at('2026-11-30', 16, 25), '18:00 − 进站30 − 车程60 − 等车5');
});

check('同键剪枝保留最低价，且不误删不同到场时刻', () => {
  const mk = (cost, hr) => [{
    mode: 'flight', from: 'AAA', to: 'RESORT', ref: 'TT' + cost,
    depAbs: at('2026-11-28', 6, 0) + hr * 60, arrAbs: at('2026-11-28', 9, 0) + hr * 60,
    cost, entryMin: 30, exitMin: 0, scheduled: true,
  }];
  const paths = [mk(900, 0), mk(700, 0), mk(800, 3)];
  const kept = G.prunePaths(paths, 'out', { boundaryMin: 180, freeWaitMin: 240, RULE });
  assert.strictEqual(kept.length, 2, '同到场时刻留最低价，另一时刻另算一条');
  assert.ok(kept.some((k) => k.cost === 700), '应保留 700 那条');
  assert.ok(!kept.some((k) => k.cost === 900), '900 应被剪掉');
});

// ── 4b. 端到端：档位由数据决定，报告首位是全部年假 ─────────────────
console.log('\n端到端（枚举 → 汇报）');

const E2E = path.join(TMP, 'e2e');
fs.mkdirSync(E2E, { recursive: true });

// 端到端用例的路径表：节点全是虚构的，与任何真实航线无关
const e2eNet = {
  schema: 1,
  nodes: {
    AAA: { name: '起点机场', short: '起点', kind: 'airport' },
    BBB: { name: '目的机场', short: '目的机场', kind: 'airport' },
    RESORT: { name: '测试雪场', short: '雪场', kind: 'resort' },
  },
  modeDefaults: { flight: { entryMin: 30, exitMin: 20 }, taxi: { entryMin: 0, exitMin: 0 } },
  cityCodes: [],
  airportOfAirline: { default: 'BBB' },
};
fs.writeFileSync(path.join(E2E, 'network.json'), JSON.stringify(e2eNet), 'utf8');

const e2eCase = {
  title: 'E2E → 雪场',
  origin: 'AAA',
  resort: 'RESORT',
  networkFile: './network.json',
  dataAsOf: '2027-02-01',
  dates: { from: '2026-11-26', to: '2026-11-30' },
  params: {
    lodgingResort: 300,
    lodgingTransit: 80,
    nightBoundary: '03:00',
    leave: { dayStart: '10:00', halfDayAt: '13:30', dayEnd: '19:30' },
    leaveDays: 1,   // 故意只声明 1 天：结果档位必须自己长到 0.5 / 1.5
    resort: {
      name: '测试雪场', dayOpen: '08:30', dayClose: '16:30',
      nightOpen: '18:30', nightClose: '21:30', nightWeight: 0.5, nightClosedWeekdays: [],
    },
  },
};

const fl = (from, to, ref, dep, arr, cost) => ({
  mode: 'flight', from, to, ref,
  depAbs: at(dep[0], dep[1], dep[2]), arrAbs: at(arr[0], arr[1], arr[2]),
  cost, entryMin: 30, exitMin: 20, scheduled: true, stopMinutes: 0,
});
// o.km 决定是结构化字段还是「备注里带里程」的老数据，两条路都要能标出里程
const tx = (from, to, o) => ({
  mode: 'taxi', from, to, ref: '打车', depAbs: null, arrAbs: null,
  durMin: 120, waitMin: 0, cost: 300, entryMin: 0, exitMin: 0, scheduled: false,
  km: (o || {}).km == null ? null : o.km,
  note: (o || {}).note || '',
});

fs.writeFileSync(path.join(E2E, 'legs.json'), JSON.stringify([
  fl('AAA', 'BBB', 'T1', ['2026-11-27', 19, 0], ['2026-11-27', 22, 0], 800),
  fl('AAA', 'BBB', 'T2', ['2026-11-28', 8, 0], ['2026-11-28', 11, 0], 700),
  tx('BBB', 'RESORT', { km: 48.5 }),                 // 结构化 km
  tx('RESORT', 'BBB', { note: '测试段 48.5km' }),    // 老数据：只能从备注里抠
  fl('BBB', 'AAA', 'T3', ['2026-11-29', 18, 0], ['2026-11-29', 21, 0], 800),
  fl('BBB', 'AAA', 'T4', ['2026-11-30', 15, 0], ['2026-11-30', 18, 0], 900),
]), 'utf8');
fs.writeFileSync(path.join(E2E, 'case.json'), JSON.stringify(e2eCase), 'utf8');

const enumRun = spawnSync(process.execPath, [
  path.join(ROOT, 'scripts', 'enumerate.js'), path.join(E2E, 'case.json'),
  '--legs', path.join(E2E, 'legs.json'),
], { encoding: 'utf8' });
const topPath = path.join(E2E, 'top.json');
const e2eTop = fs.existsSync(topPath) ? JSON.parse(fs.readFileSync(topPath, 'utf8')) : null;

check('档位由组合实际算出的年假决定，不按 leaveDays 裁剪', () => {
  assert.strictEqual(enumRun.status, 0, '应正常退出：' + String(enumRun.stderr).slice(0, 300));
  assert.deepStrictEqual(e2eTop.buckets, [0, 0.5, 1, 1.5], '实际 ' + (e2eTop && e2eTop.buckets));
  assert.strictEqual(e2eTop.counts.queryDays, 1, 'leaveDays 只用于查询窗口，应原样带出');
});

check('每档 1–30 条且不混入别档', () => {
  for (const b of e2eTop.buckets) {
    const list = e2eTop.top[b] || [];
    assert.ok(list.length >= 1 && list.length <= 30, b + ' 天档条数异常：' + list.length);
    assert.ok(list.every((x) => x.leave === b), b + ' 天档混入了别的档位');
  }
});

const renderRun = spawnSync(process.execPath, [
  path.join(ROOT, 'scripts', 'render.js'), path.join(E2E, 'case.json'),
  '--top', topPath, '--legs', path.join(E2E, 'legs.json'), '--out', path.join(E2E, 'report.html'),
], { encoding: 'utf8' });

check('汇报页：全部年假在首位、各档最优横排、含趋势折线图', () => {
  assert.strictEqual(renderRun.status, 0, '应正常退出：' + String(renderRun.stderr).slice(0, 300));
  const html = fs.readFileSync(path.join(E2E, 'report.html'), 'utf8');
  assert.ok(html.indexOf('全部年假') > -1, '缺「全部年假」页');
  assert.ok(html.indexOf('各档最优') > -1, '缺「各档最优」区块');
  assert.ok(/<svg[\s\S]*元\/雪日/.test(html), '缺趋势折线图');
  const plainTabs = (html.match(/class="tab"/g) || []).length;
  assert.strictEqual(plainTabs, e2eTop.buckets.length, 'Tab 数应等于档位数（首位那个带 on）');
});

check('hover 明细里的打车段标出里程（结构化 km 与备注兜底都要认）', () => {
  const html = fs.readFileSync(path.join(E2E, 'report.html'), 'utf8');
  const m = /var TIPS=(\[[\s\S]*?\]);/.exec(html);
  assert.ok(m, '页面里找不到 TIPS 数据');
  const rows = JSON.parse(m[1]).filter((t) => t.k === 'legs').flatMap((t) => t.rows || []);
  const taxi = rows.filter((r) => /^\u6253\u8f66/.test(r[2]));
  assert.ok(taxi.length > 0, 'hover 明细里没有打车段');
  const bad = taxi.filter((r) => !/^\u6253\u8f66 [\d.]+km$/.test(r[2]));
  assert.strictEqual(bad.length, 0, '打车段缺里程：' + JSON.stringify(bad.slice(0, 3)));
  assert.ok(taxi.some((r) => r[2] === '\u6253\u8f66 48.5km'), '里程数值不对：' + JSON.stringify(taxi.slice(0, 3)));
});

check('雪时 hover 摊开成逐日逐场时段，加权合计与单元格里的一致', () => {
  const html = fs.readFileSync(path.join(E2E, 'report.html'), 'utf8');
  const tips = JSON.parse(/var TIPS=(\[[\s\S]*?\]);/.exec(html)[1]);
  const snow = tips.filter((t) => t.k === 'snow');
  assert.ok(snow.length > 0, '页面里没有雪时 tooltip');
  for (const t of snow) {
    const rows = t.rows || [];
    assert.ok(rows.length >= 2, '雪时明细至少要有 1 天 + 合计行');
    const sum = rows[rows.length - 1];
    assert.strictEqual(sum[3], 'sum', '末行应为合计行：' + JSON.stringify(sum));
    const per = rows.slice(0, -1).reduce((a, r) => a + parseFloat(r[2]), 0);
    assert.ok(Math.abs(per - parseFloat(sum[2])) <= 0.4, '逐日小时合计与总雪时对不上：' + per + ' vs ' + sum[2]);
    for (const r of rows.slice(0, -1)) {
      assert.ok(/^\d{1,2}\/\d{1,2} 周[一二三四五六日]$/.test(r[0]), '日期列格式不对：' + r[0]);
      const seg = '\\d{2}:\\d{2}-\\d{2}:\\d{2}( 夜)?';
      assert.ok(new RegExp('^' + seg + '( · ' + seg + ')?$').test(r[1]), '时段列格式不对：' + r[1]);
    }
  }
});

check('逐日时段与雪时同源：加权利求和等于 snowHours', () => {
  const R = { dayOpen: '08:30', dayClose: '16:30', nightOpen: '18:30', nightClose: '21:30', nightWeight: 0.5 };
  const from = at('2026-11-27', 13, 24), to = at('2026-11-30', 18, 23);
  let day = 0, night = 0;
  for (const dw of G.snowWindows(from, to, R)) {
    for (const [a, b, kind] of dw.segs) { if (kind === 'day') day += b - a; else night += b - a; }
  }
  assert.deepStrictEqual(G.snowHours(from, to, R), { hDay: day / 60, hNight: night / 60, hEff: day / 60 + (night / 60) * 0.5 });
  // 没有交集的日子不该出现在明细里
  assert.strictEqual(G.snowWindows(to, to, R).length, 0, '零交集应返回空数组');
});

// ── 5. 积分口径：合并日期才是省分手段 ─────────────────────────────────
console.log('\n积分口径');

const vf = require(path.join(ROOT, 'scripts', 'variflight'));
const FQ = path.join(ROOT, 'scripts', 'flight_query.js');
const days = ['2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02'];
const oneWay = days.map((d) => ({ from: 'SZX', to: 'BJS', date: d }));

// ── 6. SQL 取数口径：机场代码与同时刻去重 ───────────────────────────
console.log('\n取数口径');

check('SQL 显式取机场代码（dep_ap / arr_ap），不再只取 10 个扁平列', () => {
  const sql = vf.buildSql([{ from: 'SZX', to: 'BJS', date: '2026-11-27' }], 15);
  assert.ok(/segments\[1\]\.dep_airport/.test(sql), '缺出发机场字段');
  assert.ok(/len\(o\.legs\[1\]\.segments\)\]\.arr_airport/.test(sql), '缺到达机场字段');
  assert.ok(/dep_ap AS|AS dep_ap/.test(sql), '缺别名 dep_ap');
});

check('同一 (起飞, 到达, 中转次数) 只留最低价，避免代码共享重复吃满 200 行', () => {
  const sql = vf.buildSql([{ from: 'SZX', to: 'BJS', date: '2026-11-27' }], 15);
  assert.ok(/QUALIFY ROW_NUMBER\(\)/.test(sql), '缺 QUALIFY 去重');
  assert.ok(/PARTITION BY o\.legs\[1\]\.dep_time, o\.legs\[1\]\.arr_time, o\.transfers/.test(sql), '分区键不对');
});

check('toFlight 把真实机场带出来，缺字段时留空交给航司兜底', () => {
  const summary = '深圳-北京，国航 CA1358，2026-11-27 20:00:00 出发、2026-11-27 23:15:00 到达，直飞，总耗时 3 小时 15 分钟，成人票面价 CNY 1000，余票 9 张。';
  const withAp = vf.toFlight({ summary, transfers: 0, flight_nos: ['CA1358'], adult_fare: 1000, dep_ap: 'SZX', arr_ap: 'PEK' }, { date: '2026-11-27' });
  assert.strictEqual(withAp.depAp, 'SZX');
  assert.strictEqual(withAp.arrAp, 'PEK');
  const noAp = vf.toFlight({ summary, transfers: 0, flight_nos: ['CA1358'], adult_fare: 1000 }, { date: '2026-11-27' });
  assert.strictEqual(noAp.arrAp, undefined, '旧缓存没有机场列时不应瞎填');
});

check('默认把同一方向的全部日期合并成 1 次调用', () => {
  assert.strictEqual(vf.planBatches(oneWay, undefined).batches.length, 1);
  assert.strictEqual(vf.planBatches(oneWay, 0).batches.length, 1);
  assert.strictEqual(vf.planBatches(oneWay, '0').batches.length, 1);
});

check('往返 6 天只发 2 次调用（1 分/次 → 2 分）', () => {
  const both = [...oneWay, ...oneWay.map((s) => ({ from: 'BJS', to: 'SZX', date: s.date }))];
  const b = vf.planBatches(both, undefined).batches;
  assert.strictEqual(b.length, 2, '应为 2 次（去 1 + 回 1），实际 ' + b.length);
});

check('--chunk 1 才是「一天一次」，且不再被当作默认', () => {
  assert.strictEqual(vf.planBatches(oneWay, 1).batches.length, 6);
});

check('请假天数只铺查询窗口：周末 ± (天数+1)，不再缩窗口', () => {
  const d0 = vf.leaveWindow('2027-03-05', 0);
  assert.deepStrictEqual(d0.out, ['2027-03-04', '2027-03-05', '2027-03-06'], '请假 0 去程应为 周四…周六');
  assert.deepStrictEqual(d0.ret, ['2027-03-07', '2027-03-08'], '请假 0 返程应为 周日、周一');
  const d1 = vf.leaveWindow('2027-03-05', 1);
  assert.deepStrictEqual(d1.out, ['2027-03-03', '2027-03-04', '2027-03-05', '2027-03-06'], '请假 1 去程应为 周三…周六');
  assert.deepStrictEqual(d1.ret, ['2027-03-07', '2027-03-08', '2027-03-09'], '请假 1 返程应为 周日…周二');
});

check('请假上限放宽到 3 天，4 天仍报错', () => {
  const d3 = vf.leaveWindow('2027-03-05', 3);
  assert.deepStrictEqual(d3.out, ['2027-03-01', '2027-03-02', '2027-03-03', '2027-03-04', '2027-03-05', '2027-03-06'],
    '请假 3 去程应为 周一…周六');
  assert.deepStrictEqual(d3.ret, ['2027-03-07', '2027-03-08', '2027-03-09', '2027-03-10', '2027-03-11'],
    '请假 3 返程应为 周日…周四');
  assert.throws(() => vf.leaveWindow('2027-03-05', 4), /0 \/ 0\.5 \/ 1 \/ 2 \/ 3/, '4 天应报错并给出合法取值');
});

check('住宿 = 雪场晚 × lodgingResort + 转机晚 × lodgingTransit', () => {
  for (const r of rows(ok.csv)) {
    const expect = Number(r['雪场晚']) * 200 + Number(r['转机晚']) * 50;
    assert.strictEqual(Number(r['住宿']), expect,
      '住宿与晚数不一致：' + r['出发日期'] + ' ' + r['起飞'] + ' 雪场' + r['雪场晚'] + ' 转机' + r['转机晚']);
  }
});

check('夜间采样：跨夜直飞在机上过夜，不收转机住宿', () => {
  const cfg = baseConfig();
  cfg.scenarios = [{
    key: 'redeye',
    label: 'cross-midnight direct',
    // 23:00 起飞、次日 07:00 落地：整晚在飞机上 → 不该有转机晚（旧「跨日即转机」口径会误收一晚）
    out: [{ date: '2027-03-05', dep: '23:00', arr: '07:00', arrDate: '2027-03-06', price: 500, tax: 100, no: 'TT3001', tag: '直飞' }],
    ret: [{ date: '2027-03-07', dep: '18:00', arr: '21:00', price: 500, tax: 100, no: 'TT3002', tag: '直飞' }],
  }];
  const r = runPlanner(cfg);
  assert.strictEqual(r.status, 0, '应正常退出，stderr: ' + String(r.stderr).slice(0, 300));
  const x = rows(r.csv)[0];
  assert.strictEqual(Number(x['转机晚']), 0, '在机上过夜不应记转机晚');
  assert.strictEqual(Number(x['雪场晚']), 1, '只在雪场住 1 晚（3/6 深夜到场不算，3/7 离场）');
});

check('旧配置里的 redEyeArrivalBefore 已被忽略但不报错', () => {
  const cfg = baseConfig();
  cfg.params.redEyeArrivalBefore = '05:00';
  const r = runPlanner(cfg);
  assert.strictEqual(r.status, 0, '应为兼容旧配置而正常退出，stderr: ' + String(r.stderr).slice(0, 300));
});

check('不写 leaveBuckets 也能跑：档位由组合里出现的天数决定', () => {
  const cfg = baseConfig();
  delete cfg.params.leaveBuckets;
  const r = runPlanner(cfg);
  assert.strictEqual(r.status, 0, '应正常退出，stderr: ' + String(r.stderr).slice(0, 300));
  const body = r.csv.trim().split('\n').slice(1).filter(Boolean);
  assert.ok(body.length > 0, '应至少产出 1 行组合');
  const days = [...new Set(body.map((l) => l.split(',')[1]))];
  assert.ok(days.every((d) => Number.isFinite(Number(d))), '年假列应为数字，实际 ' + days.join('/'));
});

check('--date 已被移除并给出 --dates 迁移写法', () => {
  const r = spawnSync(process.execPath, [FQ, '--from', 'SZX', '--to', 'BJS', '--date', '2026-11-27'],
    { cwd: ROOT, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0, '应当非零退出');
  assert.ok(/--date 已移除/.test(r.stderr + r.stdout), '未提示已移除');
  assert.ok(/--dates/.test(r.stderr + r.stdout), '未给出替代写法');
});

check('不给日期时报错，不静默连网', () => {
  const r = spawnSync(process.execPath, [FQ, '--from', 'SZX', '--to', 'BJS'], { cwd: ROOT, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.ok(/缺少日期/.test(r.stderr + r.stdout));
});

// 离线验证「截断后只补被砍到的日期」，全程不打网络
function fakeCall(truncatedOnFirstCall) {
  const seen = [];
  let first = true;
  const fn = async (name, args) => {
    const dates = [...String(args.sql).matchAll(/'date':'(\d{4}-\d{2}-\d{2})'/g)].map((m) => m[1]);
    seen.push(dates);
    const truncated = truncatedOnFirstCall && first;
    first = false;
    // 模拟：合并查被砍到只剩前两天，剩下的日期整段没回来
    const keep = truncated ? dates.slice(0, Math.max(1, dates.length - 1)) : dates;
    const rows = [];
    for (const d of keep) {
      rows.push({
        tag: d + '|SZX-BJS',
        transfers: 0,
        flight_nos: ['TT1001'],
        adult_fare: 500,
        adult_construction_fee: 50,
        adult_fuel: 40,
        seats: 5,
        summary: '深圳-北京，国航 TT1001，' + d + ' 08:00:00 出发、' + d + ' 11:00:00 到达，直飞，'
          + '总耗时 3 小时 0 分钟，成人票面价 CNY 500，余票 5 张。',
      });
    }
    return {
      doc: { item: { data: { rows, row_count: rows.length, source_count: dates.length, truncated } } },
      cached: false, key: 'fake', sessionId: 'x',
    };
  };
  fn.seen = seen;
  return fn;
}

(async () => {
  const okRun = await vf.queryFlights({
    sources: oneWay.slice(0, 3), cache: { mode: 'off' }, callTool: fakeCall(false),
  });
  check('不截断时 3 天只发 1 次调用、扣 1 分', () => {
    assert.strictEqual(okRun.meta.calls, 1);
    assert.strictEqual(okRun.meta.credits, 1);
    assert.strictEqual(okRun.meta.refills, 0);
    assert.strictEqual(okRun.flights.length, 3);
  });

  const trunc = await vf.queryFlights({
    sources: oneWay.slice(0, 3), cache: { mode: 'off' }, callTool: fakeCall(true),
  });
  check('截断后只补被砍到的日期，不重跑整批', () => {
    assert.strictEqual(trunc.meta.calls, 3, '应为 1 次合并 + 2 次补查，实际 ' + trunc.meta.calls);
    assert.strictEqual(trunc.meta.refills, 2, '补查次数应为 2，实际 ' + trunc.meta.refills);
    assert.strictEqual(trunc.meta.credits, 3, '积分应按调用次数计，实际 ' + trunc.meta.credits);
    const dates = [...new Set(trunc.flights.map((f) => f.date))].sort();
    assert.strictEqual(dates.length, 3, '三个日期都应补齐，实际 ' + dates.join(','));
  });

  const noRefill = await vf.queryFlights({
    sources: oneWay.slice(0, 3), cache: { mode: 'off' }, refill: false, callTool: fakeCall(true),
  });
  check('--no-refill 时只发 1 次调用', () => {
    assert.strictEqual(noRefill.meta.calls, 1);
    assert.strictEqual(noRefill.meta.refills, 0);
  });

  // ── 7. 日本电车口径：特急 / 普通两档，按首末班窗口即到即走 ──────────
  console.log('\n铁路接驳（估算口径）');

  const onDemand = (from, to, o) => ({
    mode: 'rail', from, to, ref: o.ref || '列车',
    depAbs: null, arrAbs: null,
    durMin: o.durMin, waitMin: o.waitMin || 0, cost: o.cost || 0,
    entryMin: 0, exitMin: 0, scheduled: false,
    serviceFrom: o.serviceFrom == null ? null : o.serviceFrom,
    serviceTo: o.serviceTo == null ? null : o.serviceTo,
  });
  const oneHop = (legs, h, m) => G.dfsPaths(G.buildGraph(legs), 'A', 'B',
    { maxLegs: 2, minDep: at('2026-12-05', h || 0, m || 0) });

  check('服务窗内：即到即走 + 平均候车', () => {
    const r = oneHop([onDemand('A', 'B', { durMin: 45, waitMin: 30, serviceFrom: 420, serviceTo: 1260 })], 8, 0);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0][0].dep, at('2026-12-05', 8, 0), '应原样从 08:00 出发');
    assert.strictEqual(r[0][0].arr, at('2026-12-05', 9, 15), '08:00 + 候车 30 + 车程 45');
  });

  check('末班之后：顺延到次日首班', () => {
    const late = oneHop([onDemand('A', 'B', { durMin: 45, waitMin: 30, serviceFrom: 420, serviceTo: 1260 })], 23, 0);
    assert.strictEqual(late[0][0].dep, at('2026-12-06', 6, 30), '23:00 已收班，应等次日首班 07:00（提前 30 分候车）');
    assert.strictEqual(late[0][0].arr, at('2026-12-06', 7, 45), '次日 07:00 发车 + 45 分');
  });

  check('首班之前：等当日首班', () => {
    const early = oneHop([onDemand('A', 'B', { durMin: 45, waitMin: 30, serviceFrom: 420, serviceTo: 1260 })], 4, 0);
    assert.strictEqual(early[0][0].dep, at('2026-12-05', 6, 30), '04:00 到站，首班 07:00，等待 30 分');
  });

  check('雪季开板前不算雪时', () => {
    const R = Object.assign({}, RES, { seasonStart: '2026-12-05', seasonEnd: '2027-05-05' });
    const before = G.snowHours(at('2026-12-04', 8, 0), at('2026-12-04', 16, 30), R);
    assert.strictEqual(before.hEff, 0, '开板前一天应为 0，实际 ' + before.hEff);
    const onDay = G.snowHours(at('2026-12-05', 8, 0), at('2026-12-05', 16, 30), R);
    assert.ok(onDay.hEff > 7, '开板当天应满算，实际 ' + onDay.hEff);
  });

  check('国际航线：market 默认 domestic，显式传 international 才进 SQL', () => {
    const dom = vf.buildSql([{ from: 'HKG', to: 'TYO', date: '2026-12-04' }], 15);
    assert.ok(/market := 'domestic'/.test(dom), '默认应为 domestic');
    const intl = vf.buildSql([{ from: 'HKG', to: 'TYO', date: '2026-12-04' }], 15, 'international');
    assert.ok(/market := 'international'/.test(intl), '传了 international 应写进 SQL');
  });

  check('国际航线税费：机建燃油缺失时用 含税总价 - 票面价 兜底', () => {
    const row = {
      summary: '香港-东京，大湾区航空 HB320，2026-12-04 09:05:00 出发、2026-12-04 14:10:00 到达，直飞，'
        + '总耗时 4 小时 5 分钟，成人票面价 CNY 641，余票 9 张。',
      flight_nos: ['HB320'], adult_fare: 641, adult_total: 1234, adult_fuel: 0,
      transfers: 0, dep_ap: 'HKG', arr_ap: 'NRT', dur_min: 245,
    };
    const f = vf.toFlight(row, { from: 'HKG', to: 'TYO', date: '2026-12-04' });
    assert.strictEqual(f.tax, 593, '税费应为 1234 - 641，实际 ' + f.tax);
    assert.strictEqual(f.price, 641, 'price 仍是裸票价');
  });

  check('地面段的车种标签：特急 / 电车 / 新干线 + 里程（双向都要带）', () => {
    const dir = path.join(TMP, 'label');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'network.json'), JSON.stringify({
      schema: 1,
      nodes: {
        A: { name: 'A', short: 'A', kind: 'airport' },
        B: { name: 'B', short: 'B', kind: 'rail' },
        R: { name: 'R', short: 'R', kind: 'resort' },
      },
      modeDefaults: { rail: { entryMin: 15, exitMin: 5 } },
      ground: [
        { from: 'A', to: 'B', mode: 'rail', cls: '特急', service: 'X', min: 45, waitMin: 30,
          cost: 57.9, km: 33, serviceFrom: 420, serviceTo: 1260, note: 'n' },
        { from: 'B', to: 'R', mode: 'shuttle', cls: '巴士', service: 'Y', min: 40, waitMin: 20,
          cost: 50, km: 18, serviceFrom: 420, serviceTo: 1200, note: 'n' },
      ],
      rail: [], cityCodes: [], airportOfAirline: { default: 'A' },
    }), 'utf8');
    const built = LK.buildLegs({
      origin: 'A', resort: 'R', networkFile: './network.json',
      dates: { from: '2026-12-05', to: '2026-12-05' }, flightQueries: [],
      params: {
        lodgingResort: 1, lodgingTransit: 1,
        leave: { dayStart: '09:00', halfDayAt: '14:30', dayEnd: '20:30' }, leaveDays: 0,
        resort: { name: 'R', dayOpen: '08:30', dayClose: '16:00' },
      },
    }, { baseDir: dir, cacheDir: path.join(dir, 'c') });
    const by = (f, t) => built.legs.find((l) => l.from === f && l.to === t);
    assert.strictEqual(by('A', 'B').label, '特急 33km', '去程标签不对：' + by('A', 'B').label);
    assert.strictEqual(by('B', 'A').label, '特急 33km', '反向边也要带标签');
    assert.strictEqual(by('B', 'R').label, '巴士 18km', '巴士标签不对');
    assert.strictEqual(by('A', 'B').ref, 'X', '具体车次仍留在 ref，供 hover 明细用');
    assert.strictEqual(by('A', 'B').serviceFrom, 420, '首末班窗口要传到边上');
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(process.exitCode ? '\n失败' : '\n全部通过（' + pass + ' 项）');
})();
