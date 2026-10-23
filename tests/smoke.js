#!/usr/bin/env node
'use strict';
/**
 * smoke.js — 回归冒烟测试，不联网、不需要任何 key
 *
 * 只验证三件容易回归的事：
 *   1. 请假口径的三个时刻真的决定各档归属（0 / 0.5 / 1 天的边界）
 *   2. 输出按「元/日」升序，且档位不越界
 *   3. 缺字段、三时刻顺序颠倒时能报错退出，而不是静默算错
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
      redEyeArrivalBefore: '05:00',
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

fs.rmSync(TMP, { recursive: true, force: true });
console.log(process.exitCode ? '\n失败' : '\n全部通过（' + pass + ' 项）');
