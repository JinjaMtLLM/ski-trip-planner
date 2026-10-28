#!/usr/bin/env node
'use strict';
/**
 * should_run.js — 每日多班次调度的「早退」判定。**确定性，零配额。**
 *
 * 每天调度 3 次（09:00 / 12:00 / 16:00）。任何一次达标成功，后续班次直接退出，
 * 不再消耗问道配额。判定必须由脚本做——LLM 记不住「今天跑过没有」，
 * 也不该靠它记。
 *
 * 退出码：
 *   0  = 需要执行（今日无记录，或已有记录但未达标）
 *   10 = 早退（今日已有达标成功）
 *   2  = 无法判定（runs.jsonl 缺失/损坏）→ 按需要执行处理
 *
 * 达标定义（三者同时满足）：
 *   state = ok 且 schemes ≥ 10 且 coreHit ≥ 4/5
 *
 * 未达标但有数据（部分成功）→ 不早退，后续班次继续尝试补覆盖。
 * 主表里会留下多个时间戳，那是同一天不同时点的快照，不是重复数据。
 *
 * 用法：
 *   node scripts/should_run.js
 *   node scripts/should_run.js --verbose
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'out', 'fare-watch');
const RUNS = path.join(DIR, 'runs.jsonl');

const MIN_SCHEMES = 10;
const MIN_CORE = 4;

const verbose = process.argv.includes('--verbose');

function todayCN() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

(function main() {
  const today = todayCN();

  if (!fs.existsSync(RUNS)) {
    console.log(`[should_run] runs.jsonl 不存在 → 需要执行`);
    process.exit(0);
  }

  let rows;
  try {
    rows = fs.readFileSync(RUNS, 'utf8').trim().split('\n')
      .filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    console.error(`[should_run] runs.jsonl 解析失败：${e.message} → 按需要执行处理`);
    process.exit(2);
  }

  const mine = rows.filter((r) => String(r.at || '').startsWith(today));

  if (!mine.length) {
    console.log(`[should_run] ${today} 无运行记录 → 需要执行`);
    process.exit(0);
  }

  const good = mine.find((r) => {
    const core = parseInt(String(r.coreHit || '0'), 10);
    return r.state === 'ok' && Number(r.schemes) >= MIN_SCHEMES && core >= MIN_CORE;
  });

  if (good) {
    console.log(`[should_run] ${today} 已达标成功：${good.at.slice(11)} / `
      + `${good.schemes} 条 / coreHit ${good.coreHit} / 最低 ¥${good.minTotal}`);
    console.log(`[should_run] → 早退，本次不查询、不消耗配额`);
    process.exit(10);
  }

  // 有记录但都没达标：继续尝试
  if (verbose) {
    console.log(`[should_run] ${today} 已有 ${mine.length} 次运行，均未达标：`);
    for (const r of mine) {
      console.log(`   ${r.at.slice(11)}  ${r.state}  ${r.schemes} 条  coreHit ${r.coreHit || '?'}`);
    }
  } else {
    const last = mine[mine.length - 1];
    console.log(`[should_run] ${today} 已有 ${mine.length} 次运行但未达标`
      + `（最近 ${last.at.slice(11)}：${last.schemes} 条 / coreHit ${last.coreHit || '?'}）→ 需要执行`);
  }
  process.exit(0);
})();
