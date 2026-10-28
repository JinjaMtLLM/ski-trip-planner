#!/usr/bin/env node
'use strict';
/**
 * enumerate.js — 在路径表上穷举所有可行行程组合，并计算总开销 / 雪时 / 年假
 *
 * 算法（确定性：无随机、无人工挑选）：
 *   1. 建图。节点是机场/车站/雪场，边是 legs.js 产出的路径表。
 *   2. 去程从出发地 DFS 到雪场，返程从雪场 DFS 回出发地。
 *      约束只有三条 —— 时间能接上、不重复经过同一节点、段数不超过 maxLegs。
 *   3. 同键剪枝。按（年假档, 日期, 关键时刻, 夜间状态）保留最低价；
 *      被剪掉的一定被同键更便宜的方案严格支配。
 *   4. 笛卡尔积配对（返程离场晚于去程到场），逐对计算：
 *        交通费 = Σ 边花费
 *        住宿   = 雪场晚 × lodgingResort + 中转晚 × lodgingTransit
 *        雪时   = 到场→离场窗口与日场/夜场营业时间的交集
 *        年假   = 去程端 + 返程端 + 中间整工作日
 *   5. 输出原始组合表 + 每个年假档按「元/雪日」排序的前 N 名。
 *
 * 纯算法在 graphcore.js，本文件只负责读参数、配对、落盘。
 *
 * 用法：
 *   node enumerate.js <case.json> --legs legs.json [--top 30] [--outdir .]
 */

const fs = require('fs');
const path = require('path');

const L = require('./legs');
const G = require('./graphcore');
const H = require('./holidays');

const { fmtAbs } = L;
const { dayOf, hhmm, snowHours, leaveOfOut, leaveOfRet, midWorkdays } = G;

function die(m) { console.error('\u2716 ' + m); process.exit(1); }

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2);
const cfgPath = argv.find((a) => !a.startsWith('--'));
if (!cfgPath) die('用法: node enumerate.js <case.json> --legs legs.json [--top 30]');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

const getArg = (k, d) => { const i = argv.indexOf('--' + k); return i > -1 ? argv[i + 1] : d; };
const legsFile = getArg('legs', path.join(path.dirname(path.resolve(cfgPath)), 'legs.json'));
if (!fs.existsSync(legsFile)) die('找不到边表：' + legsFile + '（先跑 legs.js）');
const legs = JSON.parse(fs.readFileSync(legsFile, 'utf8'));

const TOP = Number(getArg('top', 30));
const OUTDIR = getArg('outdir', path.dirname(path.resolve(cfgPath)));
// 允许 --outdir 指向一个还不存在的目录：复现时通常是先解压到空目录再重跑一遍
fs.mkdirSync(OUTDIR, { recursive: true });

const P = cfg.params;
const RULE = P.leave;
const R = P.resort;
// 用户给的请假天数**只**决定航班查询窗口铺多宽（flight_query --leave-days = 周末 ± (天数+1)），
// 不参与可行性筛选：呈现哪些档由组合里实际出现的年假天数决定（见下方 BUCKETS）。
const QUERY_DAYS = P.leaveDays != null
  ? P.leaveDays
  : (Array.isArray(P.leaveBuckets) ? Math.max.apply(null, P.leaveBuckets) : undefined);
const SESSION_H = (hhmm(R.dayClose) - hhmm(R.dayOpen)) / 60;
const BOUNDARY = hhmm(P.nightBoundary || '03:00');
const FREE_WAIT = P.terminalWaitFreeMin == null ? 240 : P.terminalWaitFreeMin;
// 同行人数：只用来摊「按车计价」的车费（租车日租金），按人头卖的票不受影响。缺省 1。
const PARTY = Math.max(1, Number(P.party || 1));

// ---------------------------------------------------------------- 乌鲁木齐加滑（可选）
// 阿勒泰方向的行程几乎都要在乌鲁木齐中转。若「到乌鲁木齐 → 回深圳起飞」这段窗口够长，
// 可以插一个天山（丝绸之路）的日场，把纯等待换成雪时。配置写在 params.urcSki，不写就完全不影响旧结果。
const US = P.urcSki && P.urcSki.enabled !== false ? P.urcSki : null;
const US_R = US ? {
  dayOpen: US.open, dayClose: US.close,
  nightOpen: US.nightOpen || null, nightClose: US.nightClose || null,
  nightWeight: US.nightWeight == null ? 0.5 : US.nightWeight,
  seasonStart: US.seasonStart, seasonEnd: US.seasonEnd,
} : null;
const US_SESSION_H = US ? (hhmm(US.close) - hhmm(US.open)) / 60 : 0;

// 住宿单价。默认口径是「每人每晚」；写 params.lodgingPer = "room" 表示给的是「每间每晚」，
// 要按同行人数折成每人：两人一间 → 每人摊 ⌈party/2⌉/party 间。
// 禾木元旦实价 700 元是两人间的房价，不是一个人的床位费，不折就会把住宿算成两倍。
const ROOM_BASED = String(P.lodgingPer || '') === 'room';
const ROOM_SHARE = Math.ceil(PARTY / 2) / PARTY;
const LODGE_R = ROOM_BASED ? P.lodgingResort * ROOM_SHARE : P.lodgingResort;
const LODGE_T = ROOM_BASED ? P.lodgingTransit * ROOM_SHARE : P.lodgingTransit;
const ORIGIN = cfg.origin, RESORT = cfg.resort;
const WIN_FROM = L.dayNum(cfg.dates.from) * 1440;
const WIN_TO = L.dayNum(cfg.dates.to) * 1440 + 1440;

// ---------------------------------------------------------------- 日历
// 年假只认「这天用不用上班」。法定假与调休由 holidays.js 解析后挂到 RULE.cal 上，
// graphcore 的 isFreeDay 会先判调休上班日、再判法定假日、最后退回周六日。
// 不写 params.calendar 也没有 holidays/workdays 时，日历完全不启用（旧行为）。
const CAL_YEARS = [];
for (let y = Number(String(cfg.dates.from).slice(0, 4)); y <= Number(String(cfg.dates.to).slice(0, 4)); y++) {
  CAL_YEARS.push(y);
}
const CAL = H.resolve({
  years: CAL_YEARS,
  calendar: P.calendar,
  holidays: P.holidays,
  workdays: P.workdays,
  holidaysLabel: P.holidaysLabel,
});
if (CAL.enabled) RULE.cal = CAL.set;

const coreCfg = { boundaryMin: BOUNDARY, freeWaitMin: FREE_WAIT, RULE };

/**
 * 返程尾段能不能插一个天山日场。
 *
 * 只改「到乌鲁木齐 → 回机场」这一段，所以年假档、住宿夜数、去程全部不动：
 *   - 年假只认首末航班时刻，加滑不改变任何一次起降；
 *   - 03:00 采样点仍在机场或路上，不会凭空多出一晚；
 *   - 代价只有两段打车（减去本来就要付的那一段）。
 *
 * 两种接法都要认：
 *   (a) 火车到乌鲁木齐站 → 打车去雪场 → 打车回机场（替换掉「站→机场」那一程）
 *   (b) 飞机直接到地窝堡 → 打车去雪场 → 打车回机场
 */
function urcSkiBlock(r) {
  const legs = r.legs;
  if (!US || !legs || legs.length < 2) return null;
  const n = legs.length;
  const last = legs[n - 1];
  if (last.to !== ORIGIN || last.from !== US.toNode) return null;
  const prev = legs[n - 2];
  let base, transferMin, replaced = 0;
  if (prev.from === US.fromNode && prev.to === US.toNode) {
    base = prev.dep; transferMin = US.toResortMin; replaced = prev.cost || 0;
  } else if (prev.to === US.toNode) {
    base = prev.arr; transferMin = US.fromAirportMin;
  } else {
    return null;
  }
  const arrive = base + transferMin;
  const latest = last.dep - US.checkinMin - US.toAirportMin;
  const d0 = dayOf(arrive);
  const start = Math.max(arrive, d0 * 1440 + hhmm(US.open));
  const end = Math.min(latest, d0 * 1440 + hhmm(US.close));
  if (end - start < (US.minBlockMin || 180)) return null;
  const sh = snowHours(start, end, US_R);
  if (sh.hEff <= 0) return null;
  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    hDay: sh.hDay, hNight: sh.hNight, hEff: sh.hEff, start, end,
    costDelta: r1(US.costToResort + US.costToAirport - replaced),
    from: US.fromNode, via: prev.from === US.fromNode ? 'rail' : 'air',
  };
}

/**
 * 去程尾段同理：飞机到地窝堡 → 雪场 → 乌鲁木齐站赶硬卧。
 * 这段的价值往往更高——0 天档去程在乌鲁木齐有 11 小时空等（12:20 落地、23:40 发车）。
 * 只有 params.urcSki.outbound 打开时才启用。
 */
function urcSkiBlockOut(o) {
  const legs = o.legs;
  if (!US || !US.outbound || !legs || legs.length < 3) return null;
  const n = legs.length;
  let idx = -1;
  for (let k = 0; k < n - 1; k++) {
    if (legs[k].from === US.toNode && legs[k].to === US.fromNode) idx = k;
  }
  if (idx < 0) return null;
  const taxi = legs[idx], next = legs[idx + 1];
  if (!next || next.dep == null) return null;
  const arrive = taxi.dep + US.fromAirportMin;
  const latest = next.dep - US.toStationMin - (US.minGapMin || 20);
  const d0 = dayOf(arrive);
  const start = Math.max(arrive, d0 * 1440 + hhmm(US.open));
  const end = Math.min(latest, d0 * 1440 + hhmm(US.close));
  if (end - start < (US.minBlockMin || 180)) return null;
  const sh = snowHours(start, end, US_R);
  if (sh.hEff <= 0) return null;
  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    hDay: sh.hDay, hNight: sh.hNight, hEff: sh.hEff, start, end,
    costDelta: r1(US.costToResort + US.costToStation - (taxi.cost || 0)),
    from: US.fromNode, via: 'air',
  };
}

/** 一条路径 → 报告用的逐段明细（只保留渲染要用的字段，避免 top.json 膨胀） */
const slim = (p) => p.legs.map((g) => ({
  from: g.from, to: g.to,
  fromName: g.fromName || '', toName: g.toName || '',
  mode: g.mode, ref: g.ref,
  dep: g.dep, arr: g.arr,
  cost: g.cost || 0,
  stop: g.stopMinutes || 0,
  seg: g.seg || 1,
  km: g.km || null,          // 打车/接驳的里程，hover 里要标出来
  label: g.label || null,    // 车种标签（「特急 33km」），路径表里给 cls + km 时才有
  note: g.note || '',
}));

// ---------------------------------------------------------------- 1. 枚举
const t0 = Date.now();
const adj = G.buildGraph(legs);

// 单节点最长候车，默认不限。只在路径表里有很多「班期边」（高铁时刻表）时才需要设，
// 否则 DFS 会把「在车站干等两天」也算成一条路径。日本案例把电车改成即到即走估算后，
// 返程必然要在机场等好几天（那几天就是滑雪日），设了反而会把整批返程砍光。
const MAX_GAP = P.maxGapMinutes == null ? Infinity : P.maxGapMinutes;
const outRaw = G.dfsPaths(adj, ORIGIN, RESORT, { maxLegs: 5, minDep: WIN_FROM, maxDep: WIN_TO, maxGapMin: MAX_GAP });
const retRaw = G.dfsPaths(adj, RESORT, ORIGIN, { maxLegs: 5, minDep: WIN_FROM, maxDep: WIN_TO, maxGapMin: MAX_GAP })
  .map((p) => G.retimeReturn(p.slice()));

// ---------------------------------------------------------------- 2. 剪枝
const outs = G.prunePaths(outRaw, 'out', coreCfg);
const rets = G.prunePaths(retRaw, 'ret', coreCfg);

// ---------------------------------------------------------------- 3. 配对
const itineraries = [];
let pairs = 0, skippedTime = 0, skippedZero = 0;

for (const o of outs) {
  const arriveResort = o.lastArr;
  const leaveOutDays = leaveOfOut(o.firstDep, RULE);
  for (const r of rets) {
    const leaveResort = r.firstDep;
    if (leaveResort <= arriveResort) { skippedTime++; continue; }
    pairs++;

    const leave = leaveOutDays + leaveOfRet(r.lastArr, RULE) + midWorkdays(o.firstDep, r.lastArr, RULE);

    const h = snowHours(arriveResort, leaveResort, R);
    if (h.hEff <= 0.05) { skippedZero++; continue; }

    // 返程尾段的乌鲁木齐加滑。h 只加雪时，钱只加两段打车（在下面 transport 里），
    // 年假档与住宿夜数一个都不动 —— 这条边界必须守住，否则「加滑」会变成「偷改档位」。
    const tms = urcSkiBlock(r);
    const tmsOut = urcSkiBlockOut(o);
    for (const blk of [tms, tmsOut]) {
      if (!blk) continue;
      h.hDay = +(h.hDay + blk.hDay).toFixed(2);
      h.hNight = +(h.hNight + blk.hNight).toFixed(2);
      h.hEff = +(h.hEff + blk.hEff).toFixed(2);
    }
    const tmsH = (tms ? tms.hEff : 0) + (tmsOut ? tmsOut.hEff : 0);

    // 住宿：逐个夜间采样点判定人在哪 —— 雪场 / 某个节点 / 正在路上
    let resortN = 0, hotelN = 0;
    const firstDay = dayOf(o.firstDep), lastDay = dayOf(r.lastArr);
    for (let d = firstDay; d <= lastDay; d++) {
      const b = d * 1440 + BOUNDARY;
      if (b <= o.firstDep || b > r.lastArr) continue;
      if (b <= arriveResort) {
        if (o.ns[d] === 'hotel') hotelN++;
      } else if (b >= leaveResort) {
        if (r.ns[d] === 'hotel') hotelN++;
      } else {
        resortN++;
      }
    }

    // 逐段票价可能带一位小数（日元折算），累加会攒出 5435.799999999999 这种尾巴
    const r1 = (v) => Math.round(v * 10) / 10;

    // 租车按天计价：租金 = 日租金 × 实际取还车天数，整趟只收一次。
    // 静态 cost 表达不了它（租期随行程浮动），所以路径表里只给 dayRate + 取还车附加时间，
    // 到这里拿到 arriveResort / leaveResort 才算得准。取车 = 到场 − 附加，还车 = 离场 + 附加。
    // 去程返程各有租车边时取 max 的日租金，绝不相加——那是同一辆车。
    const carLegs = (o.legs || []).concat(r.legs || []).filter((g) => g.dayRate);
    let rental = 0, rentalDays = 0;
    if (carLegs.length) {
      const rate = Math.max.apply(null, carLegs.map((g) => g.dayRate));
      const pad = Math.max.apply(null, carLegs.map((g) => g.pickupPad || 0));
      rentalDays = Math.max(1, Math.ceil((leaveResort + pad - (arriveResort - pad)) / 1440));
      rental = r1((rate * rentalDays) / PARTY);
    }

    const transport = r1(o.cost + r.cost + rental + (tms ? tms.costDelta : 0) + (tmsOut ? tmsOut.costDelta : 0));
    const lodge = r1(resortN * LODGE_R + hotelN * LODGE_T);
    const total = r1(transport + lodge);
    // 「雪日」按各场自己的日场时长折算：将军山 9h、天山 8h。
    // 直接拿总雪时除以 9 会把天山的 8 小时一天算成 0.89 个将军山雪日，两边都不准。
    // 必须判 tmsH > 0：没启用 urcSki 的算例 US_SESSION_H = 0，写成 tmsH / US_SESSION_H
    // 就是 0/0 = NaN，days 变 NaN → perDay 变 Infinity，整张表全废（禾木算例踩过）。
    const days = (h.hEff - tmsH) / SESSION_H
      + (tmsH > 0 && US_SESSION_H > 0 ? tmsH / US_SESSION_H : 0);

    // 纯「元/雪日」排序会漏掉「便宜但难受」的坑，单独打标
    const allLegs = o.legs.concat(r.legs);
    const maxStop = Math.max(0, ...allLegs.filter((g) => g.mode === 'flight').map((g) => g.stopMinutes || 0));
    const flags = [];
    if (maxStop > 180) flags.push('长中转 ' + (Math.round(maxStop / 6) / 10) + 'h');
    if (hotelN > 0) flags.push('中转过夜 ' + hotelN + ' 晚');
    if (rentalDays > 0) flags.push('租车 ' + rentalDays + ' 天');
    if (tms) flags.push('返程天山加滑 ' + tms.hEff + 'h');
    if (tmsOut) flags.push('去程天山加滑 ' + tmsOut.hEff + 'h');

    itineraries.push({
      leave,
      outFirst: o.firstDep,
      arriveResort,
      leaveResort,
      backHome: r.lastArr,
      outRoute: o.route,
      retRoute: r.route,
      // 结构化逐段明细：报告用它拼首行节点链（机场码✈机场码🚝车站）与次行班次（ZH9101+G1234），
      // hover 出逐段起止时刻、票价与停留
      outLegs: slim(o),
      retLegs: slim(r),
      outRefs: o.refs,
      retRefs: r.refs,
      legs: allLegs.length,
      transport, lodge, total,
      resortN, hotelN, maxStop, flags,
      hDay: h.hDay, hNight: h.hNight, hEff: h.hEff,
      tms: tms ? {
        h: tms.hEff, day: tms.hDay, night: tms.hNight,
        start: fmtAbs(tms.start), end: fmtAbs(tms.end),
        cost: tms.costDelta, via: tms.via,
      } : null,
      tmsOut: tmsOut ? {
        h: tmsOut.hEff, day: tmsOut.hDay, night: tmsOut.hNight,
        start: fmtAbs(tmsOut.start), end: fmtAbs(tmsOut.end),
        cost: tmsOut.costDelta, via: tmsOut.via,
      } : null,
      days: +days.toFixed(2),
      perDay: days > 0 ? Math.round(total / days) : Infinity,
      perHour: h.hEff > 0 ? +(total / h.hEff).toFixed(1) : Infinity,
    });
  }
}

// ---------------------------------------------------------------- 4. 输出
const esc = (v) => {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

const HEAD = ['编号', '年假(天)', '出发', '到场', '雪场晚', '中转晚', '离场', '回到起点', '去程', '返程', '段数',
  '交通费', '住宿费', '总费用', '日场h', '夜场h', '有效雪时', '元每雪日', '元每小时', '标记'];

function rowOf(it, i) {
  return [i + 1, it.leave, fmtAbs(it.outFirst), fmtAbs(it.arriveResort), it.resortN, it.hotelN,
    fmtAbs(it.leaveResort), fmtAbs(it.backHome),
    it.outRoute, it.retRoute, it.legs, it.transport, it.lodge, it.total, it.hDay, it.hNight, it.hEff, it.perDay, it.perHour,
    it.flags.join('；')];
}

itineraries.sort((a, b) => a.perDay - b.perDay || a.total - b.total);

const rawCsv = path.join(OUTDIR, 'itineraries.csv');
fs.writeFileSync(rawCsv, '\uFEFF' + [HEAD.join(',')].concat(
  itineraries.map((it, i) => rowOf(it, i).map(esc).join(','))).join('\n'), 'utf8');

const top = {};
// 档位来自数据本身：组合里出现过的年假天数全部保留，每档各取前 TOP 名（默认 30）。
// 这样用户不必事先猜「我最多能请几天」，也不会因为配置写窄了而丢掉整档结果。
const BUCKETS = Array.from(new Set(itineraries.map((x) => x.leave))).sort((a, b) => a - b);
// 并列去重：同一档里「去程一样、到场一样、总价与雪时也一样，只是返程晚了半小时」的条目
// 会成串占据前排（离场 16:00 / 17:00 / 18:00 三连），把真正不同的方案挤下去。
// 这类并列保留离场最晚的一条——同价同雪时，留的余量最大。
const tieKey = (x) => [x.leave, x.outRefs.join('+'), x.arriveResort, x.total, x.hEff,
  x.resortN, x.hotelN].join('|');
for (const b of BUCKETS) {
  const seen = new Map();
  for (const it of itineraries.filter((x) => x.leave === b)) {
    const k = tieKey(it);
    const prev = seen.get(k);
    if (!prev || it.leaveResort > prev.leaveResort) seen.set(k, it);
  }
  top[b] = [...seen.values()].sort((a, c) => a.perDay - c.perDay || a.total - c.total).slice(0, TOP);
}

fs.writeFileSync(path.join(OUTDIR, 'top.json'), JSON.stringify({
  buckets: BUCKETS,
  sessionHours: SESSION_H,
  rawItineraries: itineraries.length,
  legsCount: legs.length,
  counts: {
    outRaw: outRaw.length, outPruned: outs.length,
    retRaw: retRaw.length, retPruned: rets.length,
    pairs, skippedTime, skippedZero,
    queryDays: QUERY_DAYS,
  },
  // 年假口径的日历来源，渲染时写进报告「口径与已知局限」
  calendar: CAL.enabled ? {
    enabled: true,
    inWindow: H.describe(CAL, cfg.dates.from, cfg.dates.to),
    sources: CAL.sources,
    warnings: CAL.warnings,
  } : { enabled: false },
  top,
}, null, 1), 'utf8');

const topLines = [HEAD.join(',')];
for (const b of BUCKETS) top[b].forEach((it, i) => topLines.push(rowOf(it, i).map(esc).join(',')));
fs.writeFileSync(path.join(OUTDIR, 'top.csv'), '\uFEFF' + topLines.join('\n'), 'utf8');

// ---------------------------------------------------------------- 5. 摘要
console.log('图枚举');
console.log('  边 ' + legs.length + ' 条｜去程路径 ' + outRaw.length + ' → 剪枝后 ' + outs.length
  + '｜返程路径 ' + retRaw.length + ' → 剪枝后 ' + rets.length);
console.log('  配对 ' + pairs + ' 次 → 可行组合 ' + itineraries.length
  + '（时间冲突 ' + skippedTime + '，零雪时 ' + skippedZero + '）');
console.log('  年假档 ' + BUCKETS.join(' / ') + ' 天' + (QUERY_DAYS == null ? '' : '（查询窗口按 ' + QUERY_DAYS + ' 天铺）'));
console.log('  耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
if (CAL.enabled) {
  const d = H.describe(CAL, cfg.dates.from, cfg.dates.to);
  console.log('  日历 ' + (d.holidays.length ? d.holidays.join('、') : '窗口内无法定假')
    + '｜' + (d.workdays.length ? '调休上班 ' + d.workdays.join('、') : '无调休上班'));
  for (const w of CAL.warnings) console.log('  \u26A0 ' + w);
}
for (const b of BUCKETS) {
  const n = itineraries.filter((x) => x.leave === b).length;
  const best = top[b][0];
  console.log('  ' + b + ' 天档：' + n + ' 个组合'
    + (best ? '｜最优 ¥' + best.perDay + '/雪日 · ' + best.hEff + 'h · 交通¥' + best.transport + '+住宿¥' + best.lodge : ''));
}
console.log('CSV  →', rawCsv);
console.log('TOP  →', path.join(OUTDIR, 'top.csv'));
