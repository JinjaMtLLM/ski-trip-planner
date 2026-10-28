#!/usr/bin/env node
'use strict';
/**
 * verify_fares.js — 主表「证据校验器」。**不解析、不生成数据，只核对。**
 *
 * 回答一个问题：fares.csv 里的每一行，能不能在对应的原文里找到出处？
 * 找不到就是幻觉（编造航班号 / 编造价 / 抄了别的方案的值）。
 *
 * 与旧解析器的区别：
 *   - 解析器：原文 → 数据（会因排版变化而失效）
 *   - 校验器：数据 + 原文 → 有没有证据（不关心排版，只做字符串取证）
 * 所以它不会因为问道换排版而失效，可以长期跑。
 *
 * 用法：
 *   node scripts/verify_fares.js                 # 校验 LLM 期全部批次
 *   node scripts/verify_fares.js --at "2026/10/28 18:53:26"
 *   node scripts/verify_fares.js --all           # 含脚本期
 *   node scripts/verify_fares.js --strict        # 同块证据（默认）
 *   node scripts/verify_fares.js --loose         # 全局证据（仅报告，不判失败）
 *
 * 退出码：0 全通过 / 1 有失败 / 2 无法运行
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'out', 'fare-watch');
const RAW_DIR = path.join(DIR, 'raw');

const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const CSV = argOf('--csv', path.join(DIR, 'fares.csv'));   // 可指向副本做负向测试
const ONLY_AT = argOf('--at', null);
const INCLUDE_LEGACY = argv.includes('--all');
const LOOSE = argv.includes('--loose');
const LLM_EPOCH = '2026/10/28 01:28';   // LLM 判读期起点

// ---------- 工具 ----------

/** 数字在文本中作为独立数值出现（前后不是数字） */
function numIn(text, n) {
  const re = new RegExp('(^|[^0-9])' + String(n) + '([^0-9]|$)', 'g');
  return re.test(text);
}

/** 取航班号在原文中出现的所有位置 */
function positionsOf(text, no) {
  const out = [];
  let i = text.indexOf(no);
  while (i >= 0) {
    out.push(i);
    i = text.indexOf(no, i + 1);
  }
  return out;
}

/**
 * 按 # / ## / ### 级标题切块。`#####` 是链接子块，并入父块——否则
 * 「**票面价**」在子块之前、「- 价格」在子块之内，会被切成两半。
 */
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

/** 紧窗口兜底：只给散文式排版用，容差 ±80 字符（够覆盖「航班号…价格」相邻行） */
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
 * 邻域证据：数字是否与「本方案全部航班号」出现在**同一个方案块**里。
 *
 * ⚠ 不能退化成「任一航班号附近」。AAT→SZX 大量方案共享第一段
 * （9C7142 接 9C7680 / ZH9240 / HU7851 三个第二段），若只看「9C7142 附近」，
 * 把 9C7142+HU7851 的价格换成 9C7142+9C7680 的 2090 也能通过——2026-10-28
 * 负向测试实测漏检。
 *
 * ⚠⚠ 也不能退化成「跨块最小窗口 + 字符容差」。2026-10-28 二次负向测试发现：
 * 9H8380-ZH9206 的价格被换成上一块 9H8380-CZ3794 的 4260 仍能通过，因为
 *   · 航班号在标题行里也出现，递归会把「上一块的首段」和「下一块的首段」配成一对；
 *   · 上一块末尾的「- 价格：**¥4260**」距本块标题只有 12 个字符，±400 容差直接跨过块边界。
 * 正确判据是**块内共现**：存在某个块同时装下全部航班号和该价格。
 * 只有当一个块都装不下全部航班号时（散文式排版），才退回紧窗口。
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

/** 分钟数 → 原文里可能的写法（8h20 / 8h5m / 8小时05分 / 约8小时20分） */
function durationForms(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  const forms = [`${h}h${p2(m)}m`, `${h}h${m}m`];
  if (m === 0) {
    forms.push(`${h}小时`, `约${h}小时`);
  } else {
    // 分钟可能写 5 或 05，前面可能带「约」
    forms.push(`${h}小时${m}分`, `${h}小时${p2(m)}分`);
    forms.push(`约${h}小时${m}分`, `约${h}小时${p2(m)}分`);
  }
  return forms;
}

/**
 * 到达标记 → 原文里可能的写法。
 * 注意：出发日固定是 2027-01-03，所以「次日」= 1/4、「后日/第三天」= 1/5
 * 是确定性换算，不是猜测，可以作为证据。
 */
function arriveForms(label) {
  if (!label) return [];
  const p2 = (n) => String(n).padStart(2, '0');
  const m = label.match(/^(\d+)\/(\d+)\s*到$/);
  if (m) {
    const mo = Number(m[1]), d = Number(m[2]);
    const forms = [`${p2(mo)}-${p2(d)}`, `${mo}月${d}日`, `${mo}/${d}`, `${mo}-${d}`];
    // 相对日写法：出发 01-03，故 01-04=次日，01-05=后日/第三天
    if (mo === 1 && d === 4) forms.push('次日', '第二天', '第2天', '第二日');
    if (mo === 1 && d === 5) forms.push('后日', '第三天', '第3天', '第三日', '后天');
    return forms;
  }
  if (label === '当天到') return ['当天', '当日', '同日', '01-03', '1月3日'];
  if (label === '次日到') return ['次日', '第二天', '第2天', '01-04', '1月4日'];
  return [label];
}

// ---------- 校验 ----------

function loadRaw(at) {
  // 查询时间 "2026/10/28 18:53:26" → 文件名 "2026-10-28-18-53-26.txt"
  // 注意：CSV 记的是「运行开始时刻」，raw 文件名是「落盘时刻」，可能差几十秒
  // 甚至跨分钟（10:34:41 对应 10-35-01），所以按时间最近匹配，容差 90 秒。
  const files = fs.readdirSync(RAW_DIR).filter((n) => /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.txt$/.test(n));
  const target = new Date(at.replace(/\//g, '-').replace(' ', 'T') + '+08:00').getTime();
  let best = null;
  for (const n of files) {
    const m = n.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})\.txt$/);
    const t = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`).getTime();
    const d = Math.abs(t - target) / 1000;
    if (d <= 90 && (!best || d < best.d)) best = { d, n };
  }
  if (!best) return null;
  const f = path.join(RAW_DIR, best.n);
  return { file: f, text: fs.readFileSync(f, 'utf8'), offsetSec: best.d };
}

/**
 * 校验分两级，这是本脚本最重要的设计决策：
 *
 *   硬证据（FAIL，阻断写表）：航班号存在、票面价存在、算术自洽。
 *     —— 全是离散值，不存在「表达多样性」，误报率为 0。
 *
 *   软证据（WARN，只报告）：全程耗时、到达日、城市名。
 *     —— 原文写法无穷（8h5m / 8小时05分 / 约八小时五分 / 第三日 / 后日），
 *        任何变体表都会漏。把它当 FAIL 会因排版变化误杀整批（2026-10-28
 *        实测：软证据当 FAIL 时假失败 38 行，改 WARN 后硬证据 100% 通过）。
 *
 * 换句话说：脚本只断言它真正能断言的东西。
 */
function checkRow(row, raw) {
  const fail = [];   // 硬证据缺失 → 阻断
  const warn = [];   // 软证据缺失 → 只报告
  const flights = row.flights.split('+').filter(Boolean);
  const fare = Number(row.fare);
  const segs = Number(row.segs);
  const tax = Number(row.tax);
  const total = Number(row.total);

  // --- 硬：结构不变量（无需原文） ---
  if (flights.length !== segs) fail.push(`段数 ${segs} ≠ 航班号个数 ${flights.length}`);
  if (tax !== 140 * segs) fail.push(`税 ${tax} ≠ 140×${segs}`);
  if (total !== fare + tax) fail.push(`含税 ${total} ≠ 票面 ${fare} + 税 ${tax}`);

  // --- 硬：航班号必须在原文出现 ---
  for (const no of flights) {
    if (!raw.includes(no)) fail.push(`航班号 ${no} 不在原文（编造？）`);
  }

  // --- 硬：票面价必须在原文出现 ---
  if (!numIn(raw, fare)) {
    fail.push(`票面价 ${fare} 全文不存在（编造？）`);
  } else if (!LOOSE) {
    // 同块证据：价格应出现在「本方案全部航班号共现的那个方案块」内，否则可能是抄了相邻方案
    if (!numNearAllFlights(raw, flights, fare)) {
      fail.push(`票面价 ${fare} 全文有，但不在 ${flights.join('/')} 所在的方案块内（可能抄了相邻方案）`);
    }
  }

  // --- 软：全程耗时 ---
  if (row.dur) {
    const mins = Number(row.dur);
    const forms = durationForms(mins);
    if (!forms.some((f) => raw.includes(f))) {
      warn.push(`全程 ${mins} 分（${forms[0]}）在原文找不到对应写法`);
    }
  }

  // --- 软：中转城市 ---
  if (row.hub && row.hub !== '直飞' && !raw.includes(row.hub)) {
    warn.push(`城市 ${row.hub} 不在原文`);
  }

  // --- 软：到达标记 ---
  if (row.arrive) {
    const forms = arriveForms(row.arrive);
    if (!forms.some((f) => raw.includes(f))) {
      warn.push(`到达「${row.arrive}」在原文找不到对应日期`);
    }
  }

  return { fail, warn };
}

// ---------- 主流程 ----------

(function main() {
  if (!fs.existsSync(CSV)) {
    console.error('找不到 ' + CSV);
    process.exit(2);
  }
  const lines = fs.readFileSync(CSV, 'utf8').trim().split('\n');
  const header = lines[0].split(',');
  if (header.length !== 12) {
    console.error('表头列数异常：' + header.length);
    process.exit(2);
  }

  const rows = lines.slice(1).map((l) => {
    const c = l.split(',');
    return {
      at: c[0], route: c[1], date: c[2], flights: c[3], hub: c[4],
      segs: c[5], fare: c[6], tax: c[7], total: c[8],
      dur: c[9], arrive: c[10], title: c[11],
    };
  }).filter((r) => INCLUDE_LEGACY || r.at >= LLM_EPOCH)
    .filter((r) => !ONLY_AT || r.at === ONLY_AT);

  if (!rows.length) {
    console.error('没有符合条件的行');
    process.exit(2);
  }

  const byAt = new Map();
  for (const r of rows) {
    if (!byAt.has(r.at)) byAt.set(r.at, []);
    byAt.get(r.at).push(r);
  }

  let totalRows = 0, passRows = 0, noRaw = 0;
  const failed = [];      // 硬证据失败
  const warned = [];      // 软证据缺失
  const perBatch = [];

  for (const at of [...byAt.keys()].sort()) {
    const raw = loadRaw(at);
    const batch = byAt.get(at);
    totalRows += batch.length;
    if (!raw) {
      noRaw += batch.length;
      perBatch.push({ at, n: batch.length, ok: 0, bad: batch.length, warn: 0, note: '无对应 raw' });
      continue;
    }
    let ok = 0, wn = 0;
    for (const r of batch) {
      const { fail, warn } = checkRow(r, raw.text);
      if (fail.length) {
        failed.push({ at, r, issues: fail });
      } else {
        ok++; passRows++;
        if (warn.length) { wn++; warned.push({ at, r, issues: warn }); }
      }
    }
    perBatch.push({ at, n: batch.length, ok, bad: batch.length - ok, warn: wn, note: '' });
  }

  // ---------- 报告 ----------
  console.log(`证据校验　${INCLUDE_LEGACY ? '含脚本期' : '仅 LLM 期'}　${LOOSE ? '全局证据' : '同块证据'}`);
  console.log('硬证据 = 航班号/票面价/算术（失败即阻断）；软证据 = 耗时/城市/到达（仅警告）\n');
  console.log('时间'.padEnd(19), '行数', '硬通过', '硬失败', '软警告', '  备注');
  for (const b of perBatch) {
    const mark = b.bad ? ' ✗' : ' ✓';
    console.log(b.at.padEnd(19), String(b.n).padStart(4), String(b.ok).padStart(6),
      String(b.bad).padStart(6), String(b.warn).padStart(6), mark, b.note);
  }

  const rate = ((passRows / totalRows) * 100).toFixed(1);
  console.log(`\n合计 ${totalRows} 行：硬证据通过 ${passRows}（${rate}%），硬失败 ${failed.length}，软警告 ${warned.length}，无原文 ${noRaw}`);

  if (failed.length) {
    console.log('\n硬失败明细（编造或抄错，前 25 条）：');
    for (const f of failed.slice(0, 25)) {
      console.log(`  ${f.at} | ${f.r.flights} | ¥${f.r.fare}`);
      for (const i of f.issues) console.log('      - ' + i);
    }
    if (failed.length > 25) console.log(`  … 另有 ${failed.length - 25} 条`);
  }

  if (warned.length) {
    console.log('\n软警告明细（不影响写表，但需人看一眼，前 10 条）：');
    for (const w of warned.slice(0, 10)) {
      console.log(`  ${w.at} | ${w.r.flights}`);
      for (const i of w.issues) console.log('      - ' + i);
    }
    if (warned.length > 10) console.log(`  … 另有 ${warned.length - 10} 条`);
  }

  process.exit(failed.length ? 1 : 0);
})();
