#!/usr/bin/env node
'use strict';
/**
 * negtest_gate.js — 校验门的**自我回归测试**。零配额、零网络。
 *
 * 为什么需要它：校验器报告「100% 通过」本身不能证明它有用——一个什么都不查的
 * 校验器也是 100% 通过。只有「注入已知错误，看它是否必然失败」才能证明。
 * 每次改动 validate_extract.js / verify_fares.js 的证据逻辑后必须跑这个。
 *
 * 做法：取最新一份真实抽取结果，逐类注入错误，每类都必须被拒绝（exit 1）。
 * 任何一类漏过 = 校验门有洞。
 *
 * 用例从真实数据现场生成，不硬编码航班号——换航线、换日期后照样能跑。
 *
 * 用法：
 *   node scripts/negtest_gate.js
 *   node scripts/negtest_gate.js --keep     # 保留注入文件便于人工检查
 *
 * 退出码：0 全部拦住 / 1 有漏过 / 2 没有可用的抽取结果
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'out', 'fare-watch');
const EXT = path.join(DIR, 'extracted');
const OUT = path.join(DIR, 'negtest');
const KEEP = process.argv.includes('--keep');

function latestExtract() {
  if (!fs.existsSync(EXT)) return null;
  const all = fs.readdirSync(EXT)
    .filter((n) => /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/.test(n)).sort();
  return all.length ? path.join(EXT, all[all.length - 1]) : null;
}

const src = latestExtract();
if (!src) {
  console.error('✗ extracted/ 里没有标准命名的抽取结果，无法做负向测试');
  process.exit(2);
}

const base = JSON.parse(fs.readFileSync(src, 'utf8'));
const clone = () => JSON.parse(JSON.stringify(base));
fs.mkdirSync(OUT, { recursive: true });

const firstWithFare = (j) => j.schemes.findIndex((s) => Number.isInteger(s.fare));
const multiSeg = (j) => j.schemes.findIndex((s) => s.flights.length >= 2);

/** 找一对共享首段、但票价不同的方案——跨方案串价的最小复现 */
function sharedFirstPair(j) {
  for (let i = 0; i < j.schemes.length; i++) {
    for (let k = 0; k < j.schemes.length; k++) {
      if (i === k) continue;
      const a = j.schemes[i], b = j.schemes[k];
      if (a.flights[0] === b.flights[0] && Number.isInteger(a.fare)
        && Number.isInteger(b.fare) && a.fare !== b.fare) {
        return { victim: k, donor: i };
      }
    }
  }
  return null;
}

const cases = [];
const push = (name, desc, mutate) => cases.push({ name, desc, mutate });

push('01-fare-fabricated', '票面价编造为原文不存在的 9999', (j) => {
  j.schemes[firstWithFare(j)].fare = 9999;
});
push('02-flight-fabricated', '航班号编造为 ZZ9999', (j) => {
  const i = multiSeg(j) >= 0 ? multiSeg(j) : 0;
  const s = j.schemes[i];
  s.flights[s.flights.length - 1] = 'ZZ9999';
  s.segments[s.segments.length - 1].flight = 'ZZ9999';
});
push('03-len-mismatch', '航班号 2 个但只有 1 段', (j) => {
  const i = multiSeg(j);
  if (i < 0) return false;
  j.schemes[i].segments.pop();
  return true;
});
push('04-cross-price', '串价：抄同一首段另一方案的票价', (j) => {
  const p = sharedFirstPair(j);
  if (!p) return false;
  j.schemes[p.victim].fare = j.schemes[p.donor].fare;
  j.__crossNote = `${j.schemes[p.victim].flights.join('+')} ← ${j.schemes[p.donor].flights.join('+')} 的 ¥${j.schemes[p.donor].fare}`;
  return true;
});
push('05-hub-dirty', '中转城市写成散文片段（旧脚本期的病）', (j) => {
  j.schemes[0].hub = '等待约25小';
});
push('06-arrsrc-bad', 'arriveDateSource 用了枚举外的值', (j) => {
  j.schemes[0].arriveDateSource = 'guessed';
});
push('07-noninv-conflict', 'state=no_inventory 但 schemes 非空', (j) => {
  j.state = 'no_inventory';
});
push('08-schema-bad', 'schemaVersion 不是 1', (j) => {
  j.schemaVersion = 2;
});
push('09-fare-out-of-range', '票面价 99（低于合理下限）', (j) => {
  j.schemes[firstWithFare(j)].fare = 99;
});
push('10-missing-field', '删掉必需字段 warnings', (j) => {
  delete j.warnings;
});

let pass = 0, skip = 0, fail = 0;
const missed = [];
console.log(`负向测试　源：${path.basename(src)}\n`);

for (const c of cases) {
  const j = clone();
  if (c.mutate(j) === false) {
    console.log(`– 跳过    ${c.name.padEnd(22)} ${c.desc}（当前数据无适用样本）`);
    skip++;
    continue;
  }
  const f = path.join(OUT, c.name + '.json');
  fs.writeFileSync(f, JSON.stringify(j, null, 2), 'utf8');

  let code = 0, err = '';
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'validate_extract.js'), f, '--dry'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    code = e.status;
    err = String(e.stderr || '');
  }
  const caught = code === 1;
  const line = (err.split('\n').map((s) => s.trim()).find((s) => s.startsWith('- ')) || '')
    .replace(/^- /, '');
  if (caught) pass++; else { fail++; missed.push(c.name); }
  console.log(`${caught ? '✓ 拦住' : '✗ 漏过'}    ${c.name.padEnd(22)} ${c.desc}`);
  if (caught && line) console.log(`           └ ${line}`);
  if (!caught && j.__crossNote) console.log(`           └ 注入内容：${j.__crossNote}`);
}

if (!KEEP) {
  for (const f of fs.readdirSync(OUT)) fs.unlinkSync(path.join(OUT, f));
  fs.rmdirSync(OUT);
}

console.log(`\n${pass} 拦住 / ${fail} 漏过 / ${skip} 跳过`);
if (fail) {
  console.error(`\n✗ 校验门有洞：${missed.join(', ')}`);
  process.exit(1);
}
console.log('✓ 校验门自证通过');
