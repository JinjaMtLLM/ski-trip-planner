#!/usr/bin/env node
'use strict';
/**
 * planner.js — 滑雪行程性价比测算引擎
 *
 * 本文件不含任何具体地点、日期或价格。所有参数由 config.json 提供，
 * 缺失必填项时直接报错退出，不做静默兜底。
 *
 * 用法：
 *   node planner.js <config.json> [--out <report.html>] [--csv]
 *
 * 输出：
 *   HTML 报告（默认与 config 同目录，文件名取自 output，否则 report.html）
 *   --csv 时额外输出同名 .csv
 */

const fs = require('fs');
const path = require('path');

function die(msg) {
  console.error('\u2716 ' + msg);
  process.exit(1);
}

function need(obj, key, label) {
  const v = obj ? obj[key] : undefined;
  if (v === undefined || v === null || v === '') die('config 缺少必填字段：' + label);
  return v;
}

function needNum(obj, key, label) {
  const v = need(obj, key, label);
  if (typeof v !== 'number' || !isFinite(v)) die('字段必须是数字：' + label + '（当前值 ' + JSON.stringify(v) + '）');
  return v;
}

function hhmm(t, label) {
  if (!/^\d{1,2}:\d{2}$/.test(String(t))) die('时间格式应为 HH:MM：' + label + '（当前值 ' + JSON.stringify(t) + '）');
  const [h, mi] = String(t).split(':').map(Number);
  if (h > 23 || mi > 59) die('时间越界：' + label);
  return h * 60 + mi;
}

// ---------------------------------------------------------------- 读取配置
const argv = process.argv.slice(2);
const cfgPath = argv.find((a) => !a.startsWith('--'));
if (!cfgPath) die('用法: node planner.js <config.json> [--out report.html] [--csv]');
if (!fs.existsSync(cfgPath)) die('找不到 config 文件：' + cfgPath);
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
} catch (e) {
  die('config 不是合法 JSON：' + e.message);
}

const TITLE = need(cfg, 'title', 'title');
const ORIGIN = need(cfg, 'origin', 'origin');
const DEST = need(cfg, 'destAirport', 'destAirport');
const RESORT = need(cfg, 'resort', 'resort');
const P = need(cfg, 'params', 'params');
const SCENARIOS = need(cfg, 'scenarios', 'scenarios');

const ORIGIN_NAME = need(ORIGIN, 'name', 'origin.name');
const ORIGIN_CODE = need(ORIGIN, 'code', 'origin.code');
const DEST_NAME = need(DEST, 'name', 'destAirport.name');
const DEST_CODE = need(DEST, 'code', 'destAirport.code');
const RESORT_NAME = need(RESORT, 'name', 'resort.name');

// 雪场营业时间
const DAY_OPEN = hhmm(need(RESORT, 'dayOpen', 'resort.dayOpen'), 'resort.dayOpen');
const DAY_CLOSE = hhmm(need(RESORT, 'dayClose', 'resort.dayClose'), 'resort.dayClose');
if (DAY_CLOSE <= DAY_OPEN) die('resort.dayClose 必须晚于 dayOpen');
const SESSION_H = (DAY_CLOSE - DAY_OPEN) / 60;

let NIGHT_OPEN = null, NIGHT_CLOSE = null, NIGHT_WEIGHT = 0;
if (RESORT.nightOpen) {
  NIGHT_OPEN = hhmm(RESORT.nightOpen, 'resort.nightOpen');
  NIGHT_CLOSE = hhmm(need(RESORT, 'nightClose', 'resort.nightClose'), 'resort.nightClose');
  NIGHT_WEIGHT = needNum(RESORT, 'nightWeight', 'resort.nightWeight（夜场折半请填 0.5）');
  if (NIGHT_WEIGHT <= 0 || NIGHT_WEIGHT > 1) die('resort.nightWeight 应在 (0,1] 区间');
  if (NIGHT_CLOSE <= NIGHT_OPEN) die('resort.nightClose 必须晚于 nightOpen');
}
const NIGHT_CLOSED = new Set(RESORT.nightClosedWeekdays || []);

// 交通与提前量
const TO_RESORT = needNum(DEST, 'toResortMinutes', 'destAirport.toResortMinutes');
const PRE_FLIGHT = needNum(P, 'preFlightMinutes', 'params.preFlightMinutes');

// 费用参数
const TAX_SEG = needNum(P, 'taxPerSegment', 'params.taxPerSegment');
const LODGE_RESORT = needNum(P, 'lodgingResort', 'params.lodgingResort');
const LODGE_TRANS = needNum(P, 'lodgingTransit', 'params.lodgingTransit');
const RED_EYE = hhmm(P.redEyeArrivalBefore || need(P, 'redEyeArrivalBefore', 'params.redEyeArrivalBefore'), 'params.redEyeArrivalBefore');

// 请假规则：上班时刻 / 半天分界 / 下班时刻，三段各自独立
const RULE = need(P, 'leave', 'params.leave（含 dayStart / halfDayAt / dayEnd）');
const DAY_START = hhmm(need(RULE, 'dayStart', 'params.leave.dayStart（上班时刻）'), 'params.leave.dayStart');
const HALF_AT = hhmm(need(RULE, 'halfDayAt', 'params.leave.halfDayAt（半天分界）'), 'params.leave.halfDayAt');
const DAY_END = hhmm(need(RULE, 'dayEnd', 'params.leave.dayEnd（下班时刻）'), 'params.leave.dayEnd');
if (!(DAY_START < HALF_AT && HALF_AT < DAY_END)) {
  die('params.leave 三个时刻需满足 dayStart < halfDayAt < dayEnd（当前 '
    + RULE.dayStart + ' / ' + RULE.halfDayAt + ' / ' + RULE.dayEnd + '）');
}
const BUCKETS = need(P, 'leaveBuckets', 'params.leaveBuckets');
if (!Array.isArray(BUCKETS) || !BUCKETS.length) die('params.leaveBuckets 应为非空数组，如 [0,0.5,1,2]');

const SOURCE_NOTE = cfg.sourceNote || '';

// 车程来源：高德实测 / 问道估算 / 用户口述。写进报告副标题，避免把估算当实测。
const DRIVE_SRC_LABEL = { amap: '高德实测', wendao: '问道估算', user: '用户口述' };
const DRIVE_SRC = DRIVE_SRC_LABEL[String(DEST.toResortMinutesSource || '').toLowerCase()] || '';

// ---------------------------------------------------------------- 工具函数
const wdStr = (s) => String(s).slice(0, 10);
const dayNum = (s) => Math.floor(Date.parse(wdStr(s) + 'T00:00:00Z') / 86400000);
const wd = (s) => new Date(wdStr(s) + 'T00:00:00Z').getUTCDay();
const isWeekend = (s) => { const d = wd(s); return d === 0 || d === 6; };
const WD_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const dn = (s) => wdStr(s).slice(5).replace('-', '/');
const pad2 = (n) => String(n).padStart(2, '0');

// 航段数：显式 seg 优先，否则按 tag 推断
function segsOf(f) {
  if (typeof f.seg === 'number') return f.seg;
  return f.tag === '直飞' || !f.tag ? 1 : 2;
}

// 税费：优先用航班自带的实际机建 + 燃油（flight_query.js 会写 tax），否则按每航段默认值估
function taxOf(f) {
  if (typeof f.tax === 'number' && f.tax >= 0) return f.tax;
  return TAX_SEG * segsOf(f);
}

// 请假：出发端看起飞，返程端看落地；途中工作日整天计入
function outLeave(f) {
  if (isWeekend(f.date)) return 0;
  const t = hhmm(f.dep, 'out.dep');
  if (t >= DAY_END) return 0;
  if (t >= HALF_AT) return 0.5;
  return 1;
}
function returnLeave(f) {
  const ad = f.arrDate || f.date;
  if (isWeekend(ad)) return 0;
  return hhmm(f.arr, 'ret.arr') <= DAY_START ? 0 : 1;
}
function midWorkdays(outD, retArrD) {
  let c = 0;
  for (let t = dayNum(outD) + 1; t < dayNum(retArrD); t++) {
    const d = new Date(t * 86400000).getUTCDay();
    if (d >= 1 && d <= 5) c++;
  }
  return c;
}

// 在场窗口内逐日累计日场 / 夜场
function computeTrip(o, r) {
  const oAd = o.arrDate || o.date;
  const startAbs = dayNum(oAd) * 1440 + hhmm(o.arr, 'out.arr') + TO_RESORT;
  const endAbs = dayNum(r.date) * 1440 + hhmm(r.dep, 'ret.dep') - PRE_FLIGHT - TO_RESORT;
  let day = 0, night = 0, eff = 0;
  if (endAbs > startAbs) {
    const t0 = Math.floor(startAbs / 1440), t1 = Math.floor(endAbs / 1440);
    for (let t = t0; t <= t1; t++) {
      const ds = t * 1440 + DAY_OPEN, de = t * 1440 + DAY_CLOSE;
      const ovD = Math.max(0, Math.min(de, endAbs) - Math.max(ds, startAbs));
      day += ovD; eff += ovD / 60;
      if (NIGHT_OPEN !== null && !NIGHT_CLOSED.has(new Date(t * 86400000).getUTCDay())) {
        const ns = t * 1440 + NIGHT_OPEN, ne = t * 1440 + NIGHT_CLOSE;
        const ovN = Math.max(0, Math.min(ne, endAbs) - Math.max(ns, startAbs));
        night += ovN; eff += (ovN / 60) * NIGHT_WEIGHT;
      }
    }
  }
  return { hDay: +(day / 60).toFixed(2), hNight: +(night / 60).toFixed(2), hEff: +eff.toFixed(2) };
}

// 住宿：总晚数 = 返程落地日 − 出发日；转机过夜按跨日航段判定，红眼落地不计
function nightsOf(o, r) {
  const oAd = o.arrDate || o.date;
  const rAd = r.arrDate || r.date;
  const total = Math.max(0, dayNum(rAd) - dayNum(o.date));
  const redEye = (t) => hhmm(t, 'arr') < RED_EYE;
  const transOut = redEye(o.arr) ? 0 : Math.max(0, dayNum(oAd) - dayNum(o.date));
  const transRet = redEye(r.arr) ? 0 : Math.max(0, dayNum(rAd) - dayNum(r.date));
  const resort = Math.max(0, total - transOut - transRet);
  return { total, resort, transOut, transRet, trans: transOut + transRet };
}

// ---------------------------------------------------------------- 主计算
function compute(sc) {
  const outs = need(sc, 'out', 'scenarios[].out');
  const rets = need(sc, 'ret', 'scenarios[].ret');
  if (!outs.length || !rets.length) die('场景 ' + (sc.label || sc.key) + ' 的 out/ret 不能为空');
  const rows = [];
  for (const o of outs) {
    for (const r of rets) {
      if (dayNum(r.date) <= dayNum(o.date)) continue;
      const leave = outLeave(o) + returnLeave(r) + midWorkdays(o.date, r.arrDate || r.date);
      if (!BUCKETS.includes(leave)) continue;
      const h = computeTrip(o, r);
      if (h.hEff <= 0.05) continue;
      const days = h.hEff / SESSION_H;
      const tax = taxOf(o) + taxOf(r);
      const fare = o.price + r.price + tax;
      const n = nightsOf(o, r);
      const lodge = n.resort * LODGE_RESORT + n.trans * LODGE_TRANS;
      rows.push({
        leave,
        outDate: o.date, outAd: o.arrDate || o.date, outNo: o.no || '—', outAir: o.airport || '', outTag: o.tag || '直飞', outDep: o.dep, outArr: o.arr,
        retDate: r.date, retAd: r.arrDate || r.date, retNo: r.no || '—', retAir: r.airport || '', retTag: r.tag || '直飞', retDep: r.dep, retArr: r.arr,
        fare, tax, lodge, cost: fare + lodge,
        nResort: n.resort, nTrans: n.trans, nights: n.total,
        hDay: h.hDay, hNight: h.hNight, totalH: h.hEff, days: +days.toFixed(2),
        perDay: Math.round((fare + lodge) / days),
      });
    }
  }
  // 相同「请假档 + 雪时 + 总成本」的去重，保留出发更晚（更省睡眠）的一条
  const map = new Map();
  for (const r of rows) {
    const k = r.leave + '|' + r.totalH + '|' + r.cost;
    const prev = map.get(k);
    if (!prev || r.outDep > prev.outDep) map.set(k, r);
  }
  return [...map.values()].sort((a, b) => a.perDay - b.perDay || a.fare - b.fare);
}

const SC = SCENARIOS.map((s, i) => ({
  key: (s.key || 's' + (i + 1)).replace(/[^A-Za-z0-9_-]/g, ''),
  label: s.label || '场景 ' + (i + 1),
  rows: compute(s),
}));

// ---------------------------------------------------------------- 渲染工具
const badge = (L) => '<span class="badge b' + String(L).replace('.', 'h') + '">' + L + ' 天</span>';
const tagSpan = (t) => (t === '直飞' ? '<span class="t-d">直飞</span>' : '<span class="t-t">' + t + '</span>');
const airSpan = (c) => (c ? '<span class="air">' + c + '</span>' : '');
const plus = (d, ad) => { const n = dayNum(ad) - dayNum(d); return n > 0 ? '<sup class="p1">+' + n + '</sup>' : ''; };
const fmtHm = (mins) => { const t = ((mins % 1440) + 1440) % 1440; return pad2(Math.floor(t / 60)) + ':' + pad2(t % 60); };
const resortIn = (arr) => fmtHm(hhmm(arr, 'arr') + TO_RESORT);
function resortOut(dep) {
  const t = hhmm(dep, 'dep') - PRE_FLIGHT - TO_RESORT;
  if (t <= DAY_OPEN) return '—';
  return fmtHm(Math.min(t, DAY_CLOSE));
}

const bestOf = (rows, L) => rows.filter((r) => r.leave === L).sort((a, b) => a.perDay - b.perDay)[0];

function cards(rows) {
  return BUCKETS.map((L) => {
    const b = bestOf(rows, L);
    if (!b) return '<div class="card empty"><div class="card-top">' + badge(L) + '</div><div class="card-meta">该档无可行组合</div></div>';
    const nightLine = NIGHT_OPEN !== null
      ? '日场 ' + b.hDay + 'h + 夜场 ' + b.hNight + 'h×' + NIGHT_WEIGHT + ' = <b>' + b.totalH + 'h</b>'
      : '日场 <b>' + b.totalH + 'h</b>';
    return '<div class="card">'
      + '<div class="card-top">' + badge(L) + '<span class="card-rank">最优</span></div>'
      + '<div class="card-price">¥' + b.perDay + '<span class="unit">/日 机+宿</span></div>'
      + '<div class="card-line">去 ' + dn(b.outDate) + ' ' + b.outNo + airSpan(b.outAir) + ' ' + b.outDep + ' ' + tagSpan(b.outTag) + '</div>'
      + '<div class="card-line">回 ' + dn(b.retDate) + ' ' + b.retNo + airSpan(b.retAir) + ' ' + b.retDep + ' ' + tagSpan(b.retTag) + '</div>'
      + '<div class="card-meta">' + nightLine + ' · 雪场 ' + b.nResort + ' 晚<br>机票 ¥' + b.fare + ' + 住宿 ¥' + b.lodge + '</div>'
      + '</div>';
  }).join('');
}

function table(rows) {
  return rows.map((r, i) => '<tr data-leave="' + r.leave + '" data-perday="' + r.perDay + '">'
    + '<td class="num">' + (i + 1) + '</td>'
    + '<td>' + badge(r.leave) + '</td>'
    + '<td class="mono">' + dn(r.outDate) + ' <span class="dim">' + WD_CN[wd(r.outDate)] + '</span></td>'
    + '<td class="mono">' + r.outNo + airSpan(r.outAir) + ' ' + r.outDep + '→' + r.outArr + plus(r.outDate, r.outAd) + ' ' + tagSpan(r.outTag) + '</td>'
    + '<td class="mono dim">' + resortIn(r.outArr) + '</td>'
    + '<td class="mono">' + dn(r.retDate) + ' <span class="dim">' + WD_CN[wd(r.retDate)] + '</span></td>'
    + '<td class="mono">' + r.retNo + airSpan(r.retAir) + ' ' + r.retDep + '→' + r.retArr + plus(r.retDate, r.retAd) + ' ' + tagSpan(r.retTag) + '</td>'
    + '<td class="mono dim">' + resortOut(r.retDep) + '</td>'
    + '<td class="num">' + r.nResort + '</td>'
    + '<td class="num">' + r.hDay + '</td>'
    + '<td class="num night">' + (r.hNight || '—') + '</td>'
    + '<td class="num"><b>' + r.totalH + '</b></td>'
    + '<td class="num">¥' + r.fare + '</td>'
    + '<td class="num">¥' + r.lodge + '</td>'
    + '<td class="num price">¥' + r.perDay + '</td>'
    + '</tr>').join('');
}

function cmpTable() {
  if (SC.length < 2) return '';
  const head = '<tr><th style="width:70px">年假</th>' + SC.map((s) => '<th>' + s.label + '</th>').join('') + '<th class="num">极差</th></tr>';
  const body = BUCKETS.map((L) => {
    const best = SC.map((s) => bestOf(s.rows, L));
    if (best.some((b) => !b)) return '';
    const vals = best.map((b) => b.perDay);
    const spread = Math.max.apply(null, vals) - Math.min.apply(null, vals);
    const cells = best.map((b) => '<td class="mono">¥' + b.perDay + '<span class="dim"> · 机 ¥' + b.fare + ' + 宿 ¥' + b.lodge + '</span></td>').join('');
    return '<tr><td>' + badge(L) + '</td>' + cells + '<td class="num mono">¥' + spread + '</td></tr>';
  }).join('');
  return '<h2>场景横向对比（各档最优，元/日）</h2><table class="cmp"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
}

function maxHourTable() {
  const head = '<tr><th style="width:70px">年假</th>' + SC.map((s) => '<th>' + s.label + '</th>').join('') + '</tr>';
  const body = BUCKETS.map((L) => {
    const cells = SC.map((s) => {
      const x = s.rows.filter((r) => r.leave === L).sort((a, b) => b.totalH - a.totalH)[0];
      if (!x) return '<td class="mono dim">—</td>';
      return '<td class="mono"><b>' + x.totalH + 'h</b><span class="dim"> · ¥' + x.perDay + '/日 · 机¥' + x.fare + '+宿¥' + x.lodge + '</span></td>';
    }).join('');
    return '<tr><td>' + badge(L) + '</td>' + cells + '</tr>';
  }).join('');
  return '<h2>换个维度：各档「总雪时最长」的方案</h2><table class="cmp"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>'
    + '<div class="sub" style="margin-top:8px">单位成本最优 ≠ 玩得最久。上表为同一请假档下把雪时榨到极限的方案，通常比「元/日」冠军多滑数小时，代价是票价或住宿更高。</div>';
}

// ---------------------------------------------------------------- HTML
const tabs = SC.map((s, i) => '<button class="tab ' + (i === 0 ? 'on' : '') + '" data-k="' + s.key + '">' + s.label + '</button>').join('');

const panels = SC.map((s, i) => {
  const fbtns = ['<button class="fbtn on" data-k="' + s.key + '" data-f="all">全部</button>']
    .concat(BUCKETS.map((L) => '<button class="fbtn" data-k="' + s.key + '" data-f="' + L + '">' + L + ' 天</button>'))
    .join('');
  return '<div class="panel ' + (i === 0 ? 'on' : '') + '" id="p-' + s.key + '">'
    + '<h2>' + s.label + ' 各档请假最优解</h2>'
    + '<div class="cards">' + cards(s.rows) + '</div>'
    + '<h2>全部出行组合 <span class="h2sub">按元/日升序 · ' + s.rows.length + ' 个非重复组合'
    + (NIGHT_OPEN !== null ? ' · 总雪时 = 日场 + 夜场 × ' + NIGHT_WEIGHT : '') + '</span></h2>'
    + '<div class="toolbar">'
    + '<button class="sbtn on" data-k="' + s.key + '" data-dir="asc">元/日 升序</button>'
    + '<button class="sbtn" data-k="' + s.key + '" data-dir="desc">元/日 降序</button>'
    + '<span class="sep"></span><span class="flabel">年假</span>' + fbtns
    + '<span class="sep"></span><span class="flabel">航班</span>'
    + '<button class="tbtn on" data-k="' + s.key + '" data-t="all">全部</button>'
    + '<button class="tbtn" data-k="' + s.key + '" data-t="direct">仅直飞</button>'
    + '<button class="tbtn" data-k="' + s.key + '" data-t="transfer">仅中转</button>'
    + '<span class="cnt" id="c-' + s.key + '"></span>'
    + '</div>'
    + '<table class="tbl" id="t-' + s.key + '"><thead><tr>'
    + '<th class="num" style="width:38px">#</th><th style="width:64px">年假</th>'
    + '<th>出发日</th><th>去程</th><th>进场</th><th>回程日</th><th>回程</th><th>离场</th>'
    + '<th class="num">雪场晚</th><th class="num">日场h</th><th class="num">夜场h</th><th class="num">总雪时h</th>'
    + '<th class="num">机票含税</th><th class="num">住宿</th><th class="num">元/日</th>'
    + '</tr></thead><tbody>' + table(s.rows) + '</tbody></table>'
    + '</div>';
}).join('');

const nightDesc = NIGHT_OPEN !== null
  ? '夜场 <b>' + RESORT.nightOpen + '–' + RESORT.nightClose + '</b>（按 <b>' + NIGHT_WEIGHT + '</b> 权重折算计）'
    + (NIGHT_CLOSED.size ? '　|　<b>' + [...NIGHT_CLOSED].map((d) => WD_CN[d]).join('、') + '无夜场</b>' : '')
  : '该雪场无夜场';

const html = '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8">'
  + '<title>' + TITLE + '</title>\n<style>'
  + '*{box-sizing:border-box}'
  + 'body{margin:0;padding:30px 26px 60px;font-family:-apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;background:#f6f7f9;color:#17181a;-webkit-font-smoothing:antialiased}'
  + '.wrap{max-width:1300px;margin:0 auto}'
  + 'h1{font-size:24px;margin:0 0 6px;letter-spacing:-.3px}'
  + '.sub{color:#6b7280;font-size:13.5px;line-height:1.75}'
  + '.sub b{color:#17181a;font-weight:600}'
  + '.rule{height:1px;background:#e5e7eb;margin:20px 0}'
  + 'h2{font-size:15px;margin:24px 0 12px;display:flex;align-items:center;gap:8px}'
  + 'h2::before{content:"";width:3px;height:14px;background:#2f6fed;border-radius:2px}'
  + '.h2sub{font-size:11.5px;color:#9ca3af;font-weight:400}'
  + '.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:18px 0 4px}'
  + '.tab{font:inherit;font-size:13px;padding:8px 18px;border-radius:8px;border:1px solid #d7dae0;background:#fff;color:#374151;cursor:pointer;font-weight:500}'
  + '.tab.on{background:#17181a;border-color:#17181a;color:#fff}'
  + '.panel{display:none}.panel.on{display:block}'
  + '.cards{display:grid;grid-template-columns:repeat(' + Math.min(4, BUCKETS.length) + ',1fr);gap:12px}'
  + '.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px}'
  + '.card.empty{opacity:.45}'
  + '.card-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}'
  + '.card-rank{font-size:11px;color:#9ca3af}'
  + '.card-price{font-size:25px;font-weight:700;letter-spacing:-.5px}'
  + '.card-price .unit{font-size:12px;font-weight:500;color:#6b7280;margin-left:2px}'
  + '.card-line{font-size:12.5px;color:#374151;margin-top:4px;font-variant-numeric:tabular-nums}'
  + '.card-meta{font-size:11.5px;color:#9ca3af;margin-top:8px;padding-top:8px;border-top:1px dashed #eceef1}'
  + '.badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11.5px;font-weight:600}'
  + '.b0{background:#e8f5ee;color:#0f7b4f}.bh{background:#fdf0e3;color:#b45309}'
  + '.b1{background:#e8effd;color:#1d4ed8}.b2{background:#f1eafe;color:#6d28d9}'
  + 'table{border-collapse:separate;border-spacing:0;background:#fff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:12.5px}'
  + '.tbl{width:100%}'
  + 'th{background:#f9fafb;text-align:left;padding:10px 9px;font-weight:600;color:#4b5563;font-size:11.5px;border-bottom:1px solid #e5e7eb;white-space:nowrap}'
  + 'td{padding:9px 9px;border-bottom:1px solid #f1f2f4;vertical-align:middle}'
  + 'tbody tr:hover{background:#fafbfc}tbody tr:last-child td{border-bottom:none}'
  + '.num{text-align:right;font-variant-numeric:tabular-nums}'
  + '.mono{font-variant-numeric:tabular-nums;white-space:nowrap;font-size:12px}'
  + '.dim{color:#9ca3af;font-size:11px}.price{font-weight:700}.night{color:#7c3aed}'
  + '.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin:0 0 12px}'
  + '.sbtn,.fbtn,.tbtn{font:inherit;font-size:12px;padding:6px 11px;border-radius:7px;border:1px solid #d7dae0;background:#fff;color:#374151;cursor:pointer}'
  + '.sbtn:hover,.fbtn:hover,.tbtn:hover{border-color:#b9bec7}'
  + '.sbtn.on{background:#2f6fed;border-color:#2f6fed;color:#fff}'
  + '.fbtn.on{background:#17181a;border-color:#17181a;color:#fff}'
  + '.tbtn.on{background:#0f7b4f;border-color:#0f7b4f;color:#fff}'
  + '.sep{width:1px;height:18px;background:#e5e7eb;margin:0 3px}'
  + '.flabel{font-size:11.5px;color:#9ca3af}'
  + '.cnt{margin-left:auto;font-size:11.5px;color:#9ca3af;font-variant-numeric:tabular-nums}'
  + '.t-d{font-size:10px;color:#9ca3af;border:1px solid #e5e7eb;border-radius:4px;padding:0 4px;margin-left:4px}'
  + '.t-t{font-size:10px;color:#b45309;background:#fdf0e3;border-radius:4px;padding:1px 5px;margin-left:4px}'
  + '.air{font-size:9.5px;color:#1d4ed8;background:#e8effd;border-radius:3px;padding:0 3px;margin-left:3px;font-weight:600;letter-spacing:.2px}'
  + '.p1{color:#c2410c;font-size:9px;font-weight:700;margin-left:1px}'
  + '.cmp{width:100%}.cmp td{padding:10px 12px}'
  + '.notes{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px 20px;font-size:13px;line-height:1.85;color:#374151}'
  + '.notes ul{margin:0;padding-left:18px}.notes li{margin:3px 0}'
  + '.notes code{background:#f3f4f6;padding:1px 5px;border-radius:4px;font-size:12px;color:#b45309}'
  + '.flag{background:#fff8e6;border:1px solid #f5e0b0;border-radius:8px;padding:12px 16px;font-size:13px;line-height:1.75;color:#7a5300;margin-top:10px}'
  + '.warn{background:#fef2f2;border:1px solid #f5c2c0;border-radius:8px;padding:12px 16px;font-size:13px;line-height:1.75;color:#8a1f1a;margin-top:10px}'
  + '</style></head><body><div class="wrap">'
  + '<h1>' + TITLE + '</h1>'
  + '<div class="sub">'
  + ORIGIN_NAME + ' ' + ORIGIN_CODE + ' ↔ ' + DEST_NAME + ' ' + DEST_CODE + '　|　' + RESORT_NAME + '<br>'
  + '日场 <b>' + RESORT.dayOpen + '–' + RESORT.dayClose + '</b>（' + SESSION_H.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + 'h）　|　' + nightDesc + '<br>'
  + '机场↔雪场 <b>' + (TO_RESORT / 60).toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + 'h</b>　|　提前 <b>' + PRE_FLIGHT + ' 分钟</b>到机场　|　元/日 = <b>（含税机票 + 住宿）</b> ÷ 等效雪日（总雪时 ÷ ' + SESSION_H.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + '）<br>'
  + '税费 <b>¥' + TAX_SEG + ' / 航段</b>（按段计收）　|　住宿：雪场 <b>¥' + LODGE_RESORT + '/晚</b>　|　转机过夜 <b>¥' + LODGE_TRANS + '/晚</b>'
  + '</div>'
  + '<div class="tabs">' + tabs + '</div>'
  + panels
  + cmpTable()
  + maxHourTable()
  + '<div class="rule"></div>'
  + '<div class="flag"><b>请假口径</b>　工作日上班 <b>' + RULE.dayStart + '</b>、半天分界 <b>' + RULE.halfDayAt + '</b>、下班 <b>' + RULE.dayEnd + '</b>。出发端：' + RULE.halfDayAt + ' 前起飞算 <b>1 天</b>，' + RULE.halfDayAt + '–' + RULE.dayEnd + ' 算 <b>0.5 天</b>，' + RULE.dayEnd + ' 后起飞算 <b>0 天</b>；返程端：' + RULE.dayStart + ' 前落地算 <b>0 天</b>，之后落地算 <b>1 天</b>。中途跨越的工作日整天计入。中转按「第一段起飞 / 末段落地」判定。</div>'
  + '<div class="flag"><b>税费口径</b>　机场建设费与燃油附加费<b>按航段各收一次</b>，本表按 ¥' + TAX_SEG + '/段计算。直飞单程 1 段，中转单程 2 段，往返翻倍。燃油附加费随油价每月调整，下单前请以出票页含税总价为准。</div>'
  + '<div class="flag"><b>住宿口径</b>　雪场 ¥' + LODGE_RESORT + '/晚、转机 ¥' + LODGE_TRANS + '/晚。<b>红眼航班（' + P.redEyeArrivalBefore + ' 前落地）不计住宿</b>，因其在机上过夜。住宿金额 = 雪场晚 × ' + LODGE_RESORT + ' + 转机晚 × ' + LODGE_TRANS + '，故可能大于「雪场晚 × ' + LODGE_RESORT + '」。</div>'
  + '<div class="warn"><b>数据需复核。</b>航班时刻与票价来自单次查询快照，价格实时浮动；中转方案可能由多次查询拼接，存在航班号、时刻或价格不成立的情况。下单前请逐条在出票渠道核实。</div>'
  + '<h2>计算口径与假设</h2>'
  + '<div class="notes"><ul>'
  + '<li><b>总雪时</b> = 日场实测小时' + (NIGHT_OPEN !== null ? ' + 夜场实测小时 × ' + NIGHT_WEIGHT : '') + '。</li>'
  + '<li><b>在场窗口</b>：进场 = 落地 + ' + TO_RESORT + ' 分钟车程；离场 = 起飞 − ' + PRE_FLIGHT + ' 分钟值机 − ' + TO_RESORT + ' 分钟车程。窗口外不计时。</li>'
  + '<li><b>跨日航班</b>按实际落地日计算；表中 ⁺ⁿ 表示落地比起飞晚 n 天。</li>'
  + (NIGHT_CLOSED.size ? '<li><b>夜场例外</b>：' + [...NIGHT_CLOSED].map((d) => WD_CN[d]).join('、') + ' 不开放夜场。</li>' : '')
  + '<li><b>等效雪日</b> = 总雪时 ÷ ' + SESSION_H.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + '（一个完整日场时长）。</li>'
  + '<li><b>机票含税</b> = 裸票价 + ' + TAX_SEG + ' × 航段数。不含行李托运、选座、餐饮等附加费用。</li>'
  + '<li><b>住宿</b> = 雪场晚 × ¥' + LODGE_RESORT + ' + 转机晚 × ¥' + LODGE_TRANS + '。<b>雪场晚</b> = 总晚数 − 转机晚数。</li>'
  + '<li><b>元/日</b> = （机票含税 + 住宿）÷ 等效雪日。不含雪票、装备租赁、餐饮、地面交通。</li>'
  + '<li>相同「请假档 + 总雪时 + 总成本」的组合已合并，保留出发更晚（更省睡眠）的一条。</li>'
  + (SC.some((s) => s.rows.some((r) => r.outAir || r.retAir))
    ? '<li><b>多机场</b>：航班号后的蓝色三字码标出该段实际使用的机场；车程按 <b>' + TO_RESORT + ' 分钟</b> 统一计算，若各机场车程不同，请分开出报告或取最长的一段。</li>'
    : '')
  + '</ul></div>'
  + '<div class="rule"></div>'
  + '<div class="sub">' + (SOURCE_NOTE ? SOURCE_NOTE + ' · ' : '')
  + (DRIVE_SRC ? '车程：' + DRIVE_SRC + '（' + TO_RESORT + ' 分钟） · ' : '')
  + '雪场营业时间以官方公示为准。价格实时浮动，下单前请复核。</div>'
  + '</div>'
  + '<script>'
  + 'document.querySelectorAll(".tab").forEach(function(t){t.onclick=function(){'
  + 'document.querySelectorAll(".tab").forEach(function(x){x.classList.toggle("on",x===t)});'
  + 'document.querySelectorAll(".panel").forEach(function(p){p.classList.toggle("on",p.id==="p-"+t.dataset.k)});};});'
  + 'var state={};'
  + 'document.querySelectorAll(".panel").forEach(function(p){state[p.id.slice(2)]={dir:"asc",filter:"all",type:"all"};});'
  + 'function apply(k){'
  + 'var tb=document.querySelector("#t-"+k+" tbody");if(!tb)return;'
  + 'var s=state[k],rs=[].slice.call(tb.rows).sort(function(a,c){'
  + 'var x=+a.dataset.perday,y=+c.dataset.perday;return s.dir==="desc"?y-x:x-y;});'
  + 'rs.forEach(function(r){tb.appendChild(r)});'
  + 'var n=0;'
  + 'rs.forEach(function(r){'
  + 'var isT=r.cells[3].querySelector(".t-t")!==null||r.cells[6].querySelector(".t-t")!==null;'
  + 'var okL=s.filter==="all"||r.dataset.leave===s.filter;'
  + 'var okT=s.type==="all"||(s.type==="transfer"?isT:!isT);'
  + 'var show=okL&&okT;r.style.display=show?"":"none";if(show)r.cells[0].textContent=++n;});'
  + 'var cnt=document.getElementById("c-"+k);'
  + 'if(cnt)cnt.textContent=(s.filter==="all"&&s.type==="all")?"共 "+rs.length+" 个组合":"筛出 "+n+" / "+rs.length+" 个组合";}'
  + 'document.querySelectorAll(".sbtn").forEach(function(b){b.onclick=function(){'
  + 'var k=b.dataset.k;state[k].dir=b.dataset.dir;'
  + 'b.parentNode.querySelectorAll(".sbtn").forEach(function(x){x.classList.toggle("on",x===b)});apply(k);};});'
  + 'document.querySelectorAll(".fbtn").forEach(function(b){b.onclick=function(){'
  + 'var k=b.dataset.k;state[k].filter=b.dataset.f;'
  + 'b.parentNode.querySelectorAll(".fbtn").forEach(function(x){x.classList.toggle("on",x===b)});apply(k);};});'
  + 'document.querySelectorAll(".tbtn").forEach(function(b){b.onclick=function(){'
  + 'var k=b.dataset.k;state[k].type=b.dataset.t;'
  + 'b.parentNode.querySelectorAll(".tbtn").forEach(function(x){x.classList.toggle("on",x===b)});apply(k);};});'
  + 'Object.keys(state).forEach(apply);'
  + '</script></body></html>';

// ---------------------------------------------------------------- 输出
const outIdx = argv.indexOf('--out');
const outFile = outIdx > -1 && argv[outIdx + 1]
  ? argv[outIdx + 1]
  : path.join(path.dirname(path.resolve(cfgPath)), cfg.output || 'report.html');
fs.writeFileSync(outFile, html, 'utf8');

if (argv.includes('--csv')) {
  const csvPath = outFile.replace(/\.html?$/i, '') + '.csv';
  const head = ['场景', '年假(天)', '出发日期', '去程航班', '起飞', '落地', '雪场晚', '转机晚', '日场h', '夜场h', '总雪时', '机票含税', '住宿', '元每日'];
  const lines = [head.join(',')];
  SC.forEach((s) => s.rows.forEach((r) => lines.push([
    s.label, r.leave, r.outDate, r.outNo, r.outDep, r.outArr,
    r.nResort, r.nTrans, r.hDay, r.hNight, r.totalH, r.fare, r.lodge, r.perDay,
  ].join(','))));
  fs.writeFileSync(csvPath, '\uFEFF' + lines.join('\n'), 'utf8');
  console.log('CSV  →', csvPath);
}

// ---------------------------------------------------------------- 控制台摘要
console.log('\n' + TITLE);
SC.forEach((s) => {
  console.log('\n== ' + s.label + ' == ' + s.rows.length + ' 个非重复组合');
  if (!s.rows.length) {
    console.log('  没有满足请假档位与雪时要求的组合。请检查 BUCKETS 或航班数据。');
    return;
  }
  BUCKETS.forEach((L) => {
    const b = bestOf(s.rows, L);
    if (!b) { console.log('  ' + L + '天: 无可行组合'); return; }
    console.log('  ' + L + '天: ¥' + b.perDay + '/日 | 雪时' + b.totalH + 'h | 机¥' + b.fare + '+宿¥' + b.lodge
      + ' | ' + dn(b.outDate) + ' ' + b.outNo + '(' + b.outTag + ') → ' + dn(b.retDate) + ' ' + b.retNo + '(' + b.retTag + ')');
  });
});
console.log('\nHTML →', outFile);
