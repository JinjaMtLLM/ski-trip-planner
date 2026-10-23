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
/** 到场→离场窗口与日场/夜场营业时间的交集，夜色按 nightWeight 折算 */
function snowHours(startAbs, endAbs, R) {
  const dayOpen = hhmm(R.dayOpen), dayClose = hhmm(R.dayClose);
  const nightOpen = R.nightOpen ? hhmm(R.nightOpen) : null;
  const nightClose = R.nightClose ? hhmm(R.nightClose) : null;
  const w = R.nightWeight == null ? 0.5 : R.nightWeight;
  const closed = new Set(R.nightClosedWeekdays || []);
  let day = 0, night = 0, eff = 0;
  if (endAbs > startAbs) {
    for (let d = dayOf(startAbs); d <= dayOf(endAbs); d++) {
      const ovD = Math.max(0, Math.min(d * DAY + dayClose, endAbs) - Math.max(d * DAY + dayOpen, startAbs));
      day += ovD; eff += ovD / 60;
      if (nightOpen !== null && !closed.has(wdOf(d))) {
        const ovN = Math.max(0, Math.min(d * DAY + nightClose, endAbs) - Math.max(d * DAY + nightOpen, startAbs));
        night += ovN; eff += (ovN / 60) * w;
      }
    }
  }
  return { hDay: +(day / 60).toFixed(2), hNight: +(night / 60).toFixed(2), hEff: +eff.toFixed(2) };
}

// ---------------------------------------------------------------- 年假
/** 出发端：工作日「下班后起飞不算、半天分界后算半天、否则一整天」 */
function leaveOfOut(firstDepAbs, RULE) {
  const d = dayOf(firstDepAbs), t = firstDepAbs - d * DAY;
  if (wdOf(d) === 0 || wdOf(d) === 6) return 0;
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
  if (wdOf(d) === 0 || wdOf(d) === 6) return 0;
  if (t <= hhmm(RULE.dayStart)) return 0;
  if (t <= hhmm(RULE.halfDayAt)) return 0.5;
  return 1;
}
/** 中间被整段占掉的工作日 */
function midWorkdays(outAbs, retAbs) {
  let c = 0;
  for (let d = dayOf(outAbs) + 1; d < dayOf(retAbs); d++) {
    const w = wdOf(d);
    if (w >= 1 && w <= 5) c++;
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
 * 从 src 到 dst 枚举所有可行路径。
 * startT = 最早可出发时刻；maxLegs 限制段数（防止绕路），不重复经过节点。
 */
function dfsPaths(adj, src, dst, opts) {
  const o = opts || {};
  const maxLegs = o.maxLegs || 5;
  const maxPaths = o.maxPaths || 400000;
  const startT = o.minDep || 0;
  const maxDep = o.maxDep == null ? Infinity : o.maxDep;
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
        // 即到即走：dep 记「叫车/上车时刻」，等车时间算在行程里
        dep = t; arr = t + (g.waitMin || 0) + g.durMin;
      }
      if (dep < startT || dep > maxDep) continue;
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
  let t = legs[k].dep - legs[k].entryMin;
  for (let i = k - 1; i >= 0; i--) {
    const g = legs[i];
    t = t - g.durMin - (g.waitMin || 0);
    legs[i] = { ...g, dep: t, arr: t + (g.waitMin || 0) + g.durMin };
  }
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
    route: legs.map((g) => g.from + '\u2192' + g.to + ' ' + g.ref).join(' | '),
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
  DAY, dayOf, wdOf, hhmm,
  nightStates, snowHours, leaveOfOut, leaveOfRet, midWorkdays,
  buildGraph, dfsPaths, retimeReturn, summarize, prunePaths,
};
