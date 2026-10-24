'use strict';
/**
 * graphcore.js — 行程枚举的纯算法层
 *
 * 这里只做计算，不读文件、不写文件、不打印，所有输入由调用方传入。
 * 这样 tests/smoke.js 可以离线断言「时间可行性」「雪时」「年假」这三类口径，
 * 不必真去查航班。
 *
 * 数据模型：
 *   边（leg）  { mode, from, to, depAbs, arrAbs, cost, entryMin, exitMin, scheduled, ... }
 *             班期边有固定 depAbs/arrAbs；即到即走边有 durMin/waitMin，dep 由到达时刻决定。
 *   路径（path）边的有序数组，相邻边满足「上一段到 + 下一段进站 ≤ 下一段发车」。
 */

const DAY = 1440;

const dayOf = (a) => Math.floor(a / DAY);
const dateDay = (s) => Math.floor(Date.parse(String(s).slice(0, 10) + 'T00:00:00Z') / 86400000);
const wdOf = (d) => new Date(d * 86400000).getUTCDay();
const hhmm = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t));
  if (!m) throw new Error('时间格式应为 HH:MM：' + t);
  return Number(m[1]) * 60 + Number(m[2]);
};

// ---------------------------------------------------------------- 夜间状态
/**
 * 路径在各个「夜间采样点」的状态。
 *   free  = 这个时刻正在车上/机上（不产生住宿费）
 *   hotel = 这个时刻停在某个节点（要订酒店）
 * 两段之间的空档：短于 freeWaitMin 视为候车（不订酒店），否则视为过夜。
 */
function nightStates(pathLegs, startAbs, endAbs, boundaryMin, freeWaitMin) {
  const out = {};
  const firstDay = dayOf(startAbs), lastDay = dayOf(endAbs);
  for (let d = firstDay; d <= lastDay; d++) {
    const b = d * DAY + boundaryMin;
    if (b <= startAbs || b > endAbs) continue;
    let state = 'free';
    for (let i = 0; i < pathLegs.length; i++) {
      const g = pathLegs[i];
      if (b > g.dep && b < g.arr) { state = 'free'; break; }
      if (i + 1 < pathLegs.length && b >= g.arr && b <= pathLegs[i + 1].dep) {
        state = (pathLegs[i + 1].dep - g.arr) < freeWaitMin ? 'free' : 'hotel';
        break;
      }
      if (i === pathLegs.length - 1 && b >= g.arr) { state = 'hotel'; break; }
    }
    out[d] = state;
  }
  return out;
}

// ---------------------------------------------------------------- 雪时
/**
 * 逐日逐场的实际滑行时段（[起, 止, 场]），用于报告里把 26.12h 摊开成
 * 「11/28 09:32-16:30 + 18:30-21:30」这样的明细。
 * 倒闭日（nightClosedWeekdays）与没有交集的日子不出现在结果里。
 */
function snowWindows(startAbs, endAbs, R) {
  const dayOpen = hhmm(R.dayOpen), dayClose = hhmm(R.dayClose);
  const nightOpen = R.nightOpen ? hhmm(R.nightOpen) : null;
  const nightClose = R.nightClose ? hhmm(R.nightClose) : null;
  const closed = new Set(R.nightClosedWeekdays || []);
  // 雪季开板 / 封板：写了就只算这区间内的日子。日本雪场常分区域开板，
  // 不设这条会把「开板前落地」算成一整天雪时，排名直接错。
  const seasonFrom = R.seasonStart ? dateDay(R.seasonStart) : -Infinity;
  const seasonTo = R.seasonEnd ? dateDay(R.seasonEnd) : Infinity;
  const out = [];
  if (!(endAbs > startAbs)) return out;
  // 某一天的日场只捞到一小段，实际不可用：换鞋、存包、热身都不止这个时间。
  // 低于阈值整天记 0（夜场不受影响，夜里上山是另一回事）。默认 3h，可用
  // resort.minDayH 覆盖；写 0 就退回旧口径（有一分钟算一分钟）。
  const minDayH = R.minDayH == null ? 3 : Number(R.minDayH);
  const minDayMin = minDayH * 60;
  for (let d = dayOf(startAbs); d <= dayOf(endAbs); d++) {
    if (d < seasonFrom || d > seasonTo) continue;
    const segs = [];
    const dA = Math.max(d * DAY + dayOpen, startAbs), dB = Math.min(d * DAY + dayClose, endAbs);
    if (dB - dA >= minDayMin) segs.push([dA, dB, 'day']);
    if (nightOpen !== null && !closed.has(wdOf(d))) {
      const nA = Math.max(d * DAY + nightOpen, startAbs), nB = Math.min(d * DAY + nightClose, endAbs);
      if (nB > nA) segs.push([nA, nB, 'night']);
    }
    if (segs.length) out.push({ day: d, segs });
  }
  return out;
}

/** 到场→离场窗口与日场/夜场营业时间的交集，夜色按 nightWeight 折算 */
function snowHours(startAbs, endAbs, R) {
  const w = R.nightWeight == null ? 0.5 : R.nightWeight;
  let day = 0, night = 0, eff = 0;
  for (const dw of snowWindows(startAbs, endAbs, R)) {
    for (const [a, b, kind] of dw.segs) {
      const m = b - a;
      if (kind === 'day') { day += m; eff += m / 60; } else { night += m; eff += (m / 60) * w; }
    }
  }
  return { hDay: +(day / 60).toFixed(2), hNight: +(night / 60).toFixed(2), hEff: +eff.toFixed(2) };
}

// ---------------------------------------------------------------- 年假
/**
 * 这一天对上班族来说上不上班。
 *
 * CAL = { holidays:Set<dayNum>, workdays:Set<dayNum> }，由 holidays.js 解析后
 * 挂在 RULE.cal 上传进来。两处判断顺序不能反：
 *   1. workdays 先判 —— 调休上班日可能本来落在周六日，必须先盖掉「周末免假」；
 *   2. holidays 次判 —— 法定假可能落在工作日，要盖掉「工作日要请假」。
 * 不传 CAL 时退回「只有周六日免假」的旧口径，老案例（如日本雪场）行为不变。
 */
function isFreeDay(d, CAL) {
  if (CAL) {
    if (CAL.workdays && CAL.workdays.has(d)) return false;
    if (CAL.holidays && CAL.holidays.has(d)) return true;
  }
  const w = wdOf(d);
  return w === 0 || w === 6;
}

/** 出发端：工作日「下班后起飞不算、半天分界后算半天、否则一整天」 */
function leaveOfOut(firstDepAbs, RULE) {
  const d = dayOf(firstDepAbs), t = firstDepAbs - d * DAY;
  if (isFreeDay(d, RULE && RULE.cal)) return 0;
  if (t >= hhmm(RULE.dayEnd)) return 0;
  if (t >= hhmm(RULE.halfDayAt)) return 0.5;
  return 1;
}
/**
 * 返程端：工作日按落地时刻分三段
 *   ≤ dayStart   → 0   还能赶上上班
 *   ≤ halfDayAt  → 0.5 上午落地，只请半天就能回工位
 *   其余         → 1   下午才落地，全天搭进去
 */
function leaveOfRet(lastArrAbs, RULE) {
  const d = dayOf(lastArrAbs), t = lastArrAbs - d * DAY;
  if (isFreeDay(d, RULE && RULE.cal)) return 0;
  if (t <= hhmm(RULE.dayStart)) return 0;
  if (t <= hhmm(RULE.halfDayAt)) return 0.5;
  return 1;
}
/** 中间被整段占掉的工作日（含被调休占用的周末） */
function midWorkdays(outAbs, retAbs, RULE) {
  let c = 0;
  for (let d = dayOf(outAbs) + 1; d < dayOf(retAbs); d++) {
    if (!isFreeDay(d, RULE && RULE.cal)) c++;
  }
  return c;
}

// ---------------------------------------------------------------- 图
function buildGraph(legs) {
  const adj = new Map();
  for (const l of legs) {
    if (!adj.has(l.from)) adj.set(l.from, []);
    adj.get(l.from).push(l);
  }
  for (const [, list] of adj) list.sort((a, b) => (a.depAbs || 0) - (b.depAbs || 0) || a.cost - b.cost);
  return adj;
}

/**
 * 合并同类接驳：连续两段「同模式的即到即走地面段」在现实里就是一趟车。
 * 拆成两条边参与搜索，会把「阿勒泰站 → 机场 → 雪场」这种绕行当成一条合法路径，
 * 而它严格被「站 → 雪场」的直连边支配（多 23km、多 55 分、多 ¥15，雪时还少 0.5h），
 * 于是每一条正常方案旁边都会长出一个「+¥15 / −0.5h」的双胞胎，把 top30 挤满。
 *
 * 规则：
 *   ① 两段模式相同且都不是班期段 → 合成一段（耗时与代价相加，记 via 说明途经）；
 *   ② 若网络里本来就有起讫相同的直连地面段，且它既不更慢也不更贵 → 这条链严格被支配，整条丢掉；
 *   ③ 有服务时间窗的一律不合并（窗口的先后关系不能简单相加）。
 * 注意「同模式」这个限定很重要：禾木那种「打车到机场 + 机场坐巴士上山」是**不同模式**，
 * 属于真换乘（巴士只从机场发车），不能被合并掉。
 * 返回 { merged } 或 { drop: true }。
 */
function mergeGround(last, g, arr, adj) {
  const km = Math.round(((last.km || 0) + (g.km || 0)) * 10) / 10;
  const via = (last.via || []).concat([last.to]);
  // 合并后的名字要跟实际模式走，不能写死「打车」——接驳/城际同样可能被合并
  const cn = { taxi: '打车', shuttle: '雪场接驳', rail: '高铁', flight: '航班' }[last.mode] || last.mode;
  const merged = {
    ...last,
    to: g.to,
    toName: g.toName,
    dep: last.dep,
    arr,
    durMin: arr - last.dep,
    waitMin: 0,
    entryMin: last.entryMin,
    exitMin: g.exitMin,
    cost: last.cost + g.cost,
    wholeCar: (last.wholeCar || 0) + (g.wholeCar || 0),
    km,
    via,
    ref: '合并' + cn,
    label: '合并' + cn + ' 经' + via.join('+') + (km > 0 ? ' ' + km + 'km' : ''),
    merged: true,
  };
  const direct = (adj.get(last.from) || []).some((e) => e.to === g.to && !e.scheduled
    && e.mode === merged.mode
    && (e.durMin + (e.waitMin || 0)) <= merged.durMin + 1e-9
    && e.cost <= merged.cost + 1e-9);
  return direct ? { drop: true } : { merged };
}

/**
 * 从 src 到 dst 枚举所有可行路径。
 * startT = 最早可出发时刻；maxLegs 限制段数（防止绕路），不重复经过节点。
 */
function dfsPaths(adj, src, dst, opts) {
  const o = opts || {};
  const maxLegs = o.maxLegs || 5;
  const maxPaths = o.maxPaths || 400000;
  const startT = o.minDep || 0;
  const maxDep = o.maxDep == null ? Infinity : o.maxDep;
  // 单节点最长候车：不加这条，DFS 会在 7 天窗口里把「在长野干等三天再走」也算成一条路径，
  // 分支数直接爆炸、撞满 maxPaths 后整批结果被截断（实测全变成 0 条可行）。
  const maxGapMin = o.maxGapMin == null ? Infinity : o.maxGapMin;
  const results = [];

  function walk(node, t, legs, visited) {
    if (results.length >= maxPaths) return;
    if (node === dst && legs.length) { results.push(legs.slice()); return; }
    if (legs.length >= maxLegs) return;
    for (const g of adj.get(node) || []) {
      if (visited.has(g.to)) continue;
      let dep, arr;
      if (g.scheduled) {
        if (t + g.entryMin > g.depAbs) continue;
        dep = g.depAbs; arr = g.arrAbs;
      } else {
        // 即到即走：dep 记「到站时刻」，等车时间算在行程里。
        // 带服务时间窗的（日本电车按平均候车估算）：上车时刻落在窗外就顺延到首班/末班。
        // windowHard=true 表示「整段都得跑在窗口内」——阿勒泰那种白天限行的山路用这个，
        // 否则会出现「18:15 出发、夜里跑 5 小时」这种名义合规、实际违规的解。
        let ready = t;
        const wait = g.waitMin || 0;
        if (g.serviceFrom != null || g.serviceTo != null) {
          const from = g.serviceFrom == null ? 0 : g.serviceFrom;
          const to = g.serviceTo == null ? DAY : g.serviceTo;
          const tail = g.windowHard ? wait + g.durMin : 0;
          const b = ready + wait;
          const bd = Math.floor(b / DAY), bt = b - bd * DAY;
          if (bt > to - tail) ready = (bd + 1) * DAY + from - wait;       // 跑不完 / 已收班：等次日首班
          else if (bt < from) ready = bd * DAY + from - wait;             // 首班未开：等当日首班
        }
        dep = ready; arr = ready + wait + g.durMin;
      }
      if (dep < startT || dep > maxDep) continue;
      // 起点不设候车上限（否则「周三、周六飞」会被当成候车超时全砍掉）
      if (legs.length && dep - t > maxGapMin) continue;
      const last = legs.length ? legs[legs.length - 1] : null;
      if (last && !last.scheduled && !g.scheduled && last.mode === g.mode
        && last.serviceFrom == null && last.serviceTo == null
        && g.serviceFrom == null && g.serviceTo == null) {
        const r = mergeGround(last, g, arr, adj);
        if (r.drop) continue;
        visited.add(g.to);
        legs.pop();
        legs.push(r.merged);
        walk(g.to, arr + g.exitMin, legs, visited);
        legs.pop();
        legs.push(last);
        visited.delete(g.to);
        continue;
      }
      visited.add(g.to);
      legs.push({ ...g, dep, arr });
      walk(g.to, arr + g.exitMin, legs, visited);
      legs.pop();
      visited.delete(g.to);
    }
  }

  walk(src, startT, [], new Set([src]));
  return results;
}

/**
 * 返程重定时：把开头连续的「即到即走」边改成「刚好赶上第一段班期交通」。
 * DFS 只能按最早时刻铺边，不重定时的话每条返程路径都会以「窗口第一天就打车去机场干等」开头，
 * 所有路径的离场时刻退化成同一个值。对返程而言离场越晚雪时越长、花费不变，
 * 所以「刚好赶上」严格最优，不会漏掉更优解。
 */
function retimeReturn(legs) {
  let k = 0;
  while (k < legs.length && !legs[k].scheduled) k++;
  if (k === 0 || k >= legs.length) return legs;
  const orig = legs.slice();
  let t = legs[k].dep - legs[k].entryMin;
  for (let i = k - 1; i >= 0; i--) {
    const g = legs[i];
    const wait = g.waitMin || 0;
    let dep = t - g.durMin - wait;
    // 有服务时间窗时取「不晚于目标时刻的最后一班」：目标在末班之后 → 当日末班；
    // 目标在首班之前 → 前一日末班。这样后推出来的离场时刻仍是可执行的。
    if (g.serviceFrom != null || g.serviceTo != null) {
      const from = g.serviceFrom == null ? 0 : g.serviceFrom;
      const to = g.serviceTo == null ? DAY : g.serviceTo;
      const tail = g.windowHard ? wait + g.durMin : 0;
      const b = dep + wait;
      const bd = Math.floor(b / DAY), bt = b - bd * DAY;
      if (bt > to - tail) dep = bd * DAY + (to - tail) - wait;
      else if (bt < from) dep = (bd - 1) * DAY + (to - tail) - wait;
    }
    legs[i] = { ...g, dep, arr: dep + wait + g.durMin };
    t = dep;
  }
  // 窗口裁剪可能把前一段推得太早、导致与后一段脱节（理论上不该发生，发生就退回原始时刻）
  for (let i = 0; i + 1 < k; i++) {
    if (legs[i].arr + legs[i].exitMin > legs[i + 1].dep + 1e-9) return orig;
  }
  if (legs[k - 1].arr + legs[k - 1].exitMin > legs[k].dep + 1e-9) return orig;
  return legs;
}

/** 把一条路径折叠成配对用的摘要 */
function summarize(pathLegs, boundaryMin, freeWaitMin, RULE) {
  // 兼容两种输入：DFS 产出的（已带 dep/arr）与直接喂进来的（只有 depAbs/arrAbs）
  const legs = pathLegs.map((g) => ({
    ...g,
    dep: g.dep != null ? g.dep : g.depAbs,
    arr: g.arr != null ? g.arr : g.arrAbs,
  }));
  const firstDep = legs[0].dep;
  const lastArr = legs[legs.length - 1].arr;
  const ns = nightStates(legs, firstDep, lastArr, boundaryMin, freeWaitMin);
  return {
    legs,
    cost: legs.reduce((s, g) => s + g.cost, 0),
    firstDep,
    lastArr,
    ns,
    route: legs.map((g) => g.from + '\u2192' + g.to + ' ' + (g.label || g.ref)).join(' | '),
    refs: legs.map((g) => g.ref),
    modes: legs.map((g) => g.mode),
  };
}

/**
 * 同键剪枝：同一（年假档, 日期, 关键时刻, 夜间状态）下只留最便宜的一条。
 * 被剪掉的方案与保留者的下游代价完全相同，因此严格被支配，剪掉不影响最优解。
 */
function prunePaths(paths, dir, cfg) {
  const { boundaryMin, freeWaitMin, RULE } = cfg;
  const map = new Map();
  for (const p of paths) {
    const s = summarize(p, boundaryMin, freeWaitMin, RULE);
    const nsig = Object.values(s.ns).join('');
    const key = dir === 'out'
      ? [leaveOfOut(s.firstDep, RULE), dayOf(s.firstDep), s.lastArr, nsig].join('|')
      : [leaveOfRet(s.lastArr, RULE), dayOf(s.lastArr), s.firstDep, nsig].join('|');
    const prev = map.get(key);
    if (!prev || s.cost < prev.cost || (s.cost === prev.cost && s.legs.length < prev.legs.length)) map.set(key, s);
  }
  return [...map.values()];
}

module.exports = {
  DAY, dayOf, wdOf, hhmm, isFreeDay,
  nightStates, snowHours, snowWindows, leaveOfOut, leaveOfRet, midWorkdays,
  buildGraph, dfsPaths, retimeReturn, summarize, prunePaths, mergeGround,
};
