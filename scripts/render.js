#!/usr/bin/env node
'use strict';
/**
 * render.js — 把 enumerate.js 产出的 top.json 渲染成汇报页
 *
 * 只负责呈现，不做任何计算。所有数字都直接来自 top.json / legs.json，
 * 避免「报告里的数」和「算出来的数」两套口径。
 *
 * 用法：
 *   node render.js <case.json> --top top.json --legs legs.json [--out report.html]
 */

const fs = require('fs');
const path = require('path');
const L = require('./legs');
const G = require('./graphcore');
const D = require('./design');
const E = require('./embed');

const WD = ['日', '一', '二', '三', '四', '五', '六'];
const dayOf = (a) => Math.floor(a / 1440);
const hm = (a) => {
  const m = a - dayOf(a) * 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
};
const md = (a) => {
  const d = new Date(dayOf(a) * 86400000);
  return (d.getUTCMonth() + 1) + '/' + d.getUTCDate();
};
const wd = (a) => '周' + WD[new Date(dayOf(a) * 86400000).getUTCDay()];

function die(m) { console.error('\u2716 ' + m); process.exit(1); }

const argv = process.argv.slice(2);
const cfgPath = argv.find((a) => !a.startsWith('--'));
if (!cfgPath) die('用法: node render.js <case.json> --top top.json --legs legs.json');
const get = (k, d) => { const i = argv.indexOf('--' + k); return i > -1 ? argv[i + 1] : d; };

const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const topFile = get('top', path.join(path.dirname(path.resolve(cfgPath)), 'top.json'));
const legsFile = get('legs', path.join(path.dirname(path.resolve(cfgPath)), 'legs.json'));
const topData = JSON.parse(fs.readFileSync(topFile, 'utf8'));
const legs = JSON.parse(fs.readFileSync(legsFile, 'utf8'));
const net = L.loadNetwork(cfg.networkFile, cfg.resort, path.dirname(path.resolve(cfgPath)));
const RES = cfg.params.resort;

const outFile = get('out', path.join(path.dirname(path.resolve(cfgPath)), 'report.html'));

// ---------------------------------------------------------------- 统计
const byMode = {};
for (const l of legs) byMode[l.mode] = (byMode[l.mode] || 0) + 1;
// 显示名一律来自路径表（nodes[].short 优先），不在代码里写死任何城市
const nodeName = (id) => {
  const n = net.nodes[id];
  if (!n) return id;
  return n.short || n.name || id;
};
const MODE_CN = { flight: '航班', rail: '高铁', taxi: '打车', shuttle: '雪场接驳' };
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * 节点显示名：只有机场用 IATA 三字码；高铁站一律用中文名。
 * 铁路没有对外的 IATA 码，ZJK / ZMP 这类是拼音码或电报码，不是可以给用户看的"站码"，
 * 混在路径里会被误读成机场（ZJK 看着就像 IATA）。
 */
const AIRPORTS = new Set(Object.keys(net.nodes).filter((id) => (net.nodes[id] || {}).kind === 'airport'));
const tagOf = (id) => (AIRPORTS.has(id) ? id : nodeName(id));

/**
 * 打车/接驳的里程：优先用结构化字段 km（legs.js 从路径表的 ground[].km 带过来），
 * 老 top.json 没有这个字段，就退回从备注里抠「62.7km」。
 */
const kmOf = (g) => {
  if (g.km) return Number(g.km);
  const m = /([\d.]+)\s*km/i.exec(String(g.note || ''));
  return m ? Number(m[1]) : null;
};
/** 62.7km / 33km —— 一位小数、整数不带 .0 */
const fmtKm = (v) => (v == null || !isFinite(v) ? '' : (Math.round(v * 10) / 10) + 'km');

/** 一段路在 hover 里的班次列：航班显示航班号，高铁显示车次，打车/接驳显示方式 + 里程 */
const tagCol = (g) => {
  // 路径表给了车种标签（「特急 33km」「新干线 222km」）就用它——比「高铁/雪场接驳」这种
  // 方式名具体得多，里程也一眼可见。
  if (g.label) return g.label;
  if (g.mode === 'flight' || g.mode === 'rail') return g.ref || MODE_CN[g.mode];
  const km = fmtKm(kmOf(g));
  return (MODE_CN[g.mode] || g.mode) + (km ? ' ' + km : '');
};

/**
 * hover 明细：全部路段（含打车/接驳）。返回二维数组，交给前端按网格渲染。
 */
function tipRows(list) {
  if (!Array.isArray(list) || !list.length) return [];
  return list.map((g) => {
    const t = g.dep == null ? '' : hm(g.dep) + '-' + hm(g.arr);
    return [
      t,
      tagOf(g.from) + '-' + tagOf(g.to),
      tagCol(g),
      g.cost ? '\uffe5' + g.cost : '',
      g.stop > 0 ? '\u8f6c' + Math.round(g.stop / 6) / 10 + 'h' : '',
    ];
  });
}

/** 每张卡/每个单元格的 hover 明细登记进 TIPS，DOM 里只留一个下标 */
const TIPS = [];
function pushTip(obj) { TIPS.push(obj); return TIPS.length - 1; }
function tipKey(it, which) {
  return pushTip({ k: 'legs', rows: tipRows(it[which + 'Legs']) });
}
const RES_PRICE = Number(cfg.params.lodgingResort || 0);
const TRANSIT_PRICE = Number(cfg.params.lodgingTransit || 0);

/** 费用明细：逐段票价 + 两类住宿 + 合计 */
function costRows(it) {
  const rows = [];
  // 具体车次/服务名放第二列；通用占位名（雪场接驳 / 打车）没有信息量，留空
  const svc = (g) => {
    const r = g.ref || '';
    return (r === '雪场接驳' || r === '打车' || r === '接驳') ? '' : r;
  };
  const add = (dir, list) => {
    for (const g of list || []) {
      rows.push([dir + ' ' + (g.label || MODE_CN[g.mode] || g.mode) + ' ' + tagOf(g.from) + '-' + tagOf(g.to),
        svc(g),
        '￥' + (g.cost || 0)]);
    }
  };
  add('去程', it.outLegs);
  add('返程', it.retLegs);
  const airSum = rows.filter((r) => r[0].includes('航班')).reduce((a, r) => a + Number(String(r[2]).replace('￥', '')), 0);
  rows.push(['机票小计', '', '￥' + airSum]);
  rows.push(['地面交通', '电车 / 特急 / 新干线 / 巴士 / 打车', '￥' + (Math.round((it.transport - airSum) * 10) / 10)]);
  rows.push(['交通合计', '', '￥' + it.transport, 'sum']);
  rows.push(['雪场住宿', it.resortN + ' 晚 × ￥' + RES_PRICE, '￥' + it.resortN * RES_PRICE]);
  rows.push(['中转住宿', it.hotelN + ' 晚 × ￥' + TRANSIT_PRICE, '￥' + it.hotelN * TRANSIT_PRICE]);
  rows.push(['总计', '', '￥' + it.total, 'grand']);
  return rows;
}
function costKey(it) { return pushTip({ k: 'cost', rows: costRows(it) }); }

/**
 * 雪时明细：把「26.12 小时」摊成逐日逐场的真实滑行时段。
 * 时段由 graphcore.snowWindows 算，和枚举时的雪时口径是同一份代码，不会两边对不上。
 */
function snowRows(it) {
  const days = G.snowWindows(it.arriveResort, it.leaveResort, RES);
  const nightW = RES.nightWeight == null ? 0.5 : RES.nightWeight;
  const rows = days.map((dw) => {
    let min = 0;
    const spans = dw.segs.map(([a, b, kind]) => {
      min += (b - a) * (kind === 'night' ? nightW : 1);
      return hm(a) + '-' + hm(b) + (kind === 'night' ? ' 夜' : '');
    });
    // md/wd 收的是绝对分钟，dw.day 是天号，要乘回分钟
    return [md(dw.day * 1440) + ' ' + wd(dw.day * 1440), spans.join(' \u00b7 '), (Math.round(min / 6) / 10) + 'h'];
  });
  // 加滑段（乌鲁木齐天山）落在主雪场窗口之外，snowWindows 看不到它，
  // 所以单独补行——否则明细逐日相加会小于 hEff，读者会以为算错了。
  // 只补时段与雪时，往返行程一段都不改。
  for (const pair of [['去程', it.tmsOut], ['返程', it.tms]]) {
    const tag = pair[0], blk = pair[1];
    if (!blk) continue;
    rows.push([tag + ' 天山加滑（机场/车站接驳按预估车程）',
      blk.start.slice(5, 10) + ' ' + blk.start.slice(11) + '\u2013' + blk.end.slice(11),
      (Math.round(blk.h * 10) / 10) + 'h']);
  }
  // 末行把口径写明：夜场折半后的「有效雪时」不等于表里各段时长之和
  rows.push(['合计　日场 ' + it.hDay + 'h + 夜场 ' + it.hNight + 'h × ' + nightW, '', it.hEff + 'h', 'sum']);
  return rows;
}
function snowKey(it) { return pushTip({ k: 'snow', rows: snowRows(it) }); }

const ICON = { flight: '\u2708', rail: '\u{1F69D}', taxi: '\u{1F695}', shuttle: '\u{1F68C}' };
const GROUND = { taxi: 1, shuttle: 1 };

/** 首行节点链：机场码 ✈ 机场码 🚕 城市 🚝 车站（打车/接驳只留浅色图标，不打断链路） */
function chainHtml(it, which) {
  const arr = it[which + 'Legs'];
  let out = '';
  if (Array.isArray(arr) && arr.length) {
    out = '<span class="nd">' + esc(tagOf(arr[0].from)) + '</span>';
    for (const g of arr) {
      out += '<span class="ic ' + g.mode + '">' + ICON[g.mode] + '</span>';
      out += '<span class="nd' + (GROUND[g.mode] ? ' weak' : '') + '">' + esc(tagOf(g.to)) + '</span>';
    }
    return out;
  }
  // 旧 top.json 没有逐段明细时，从路由字符串反推
  const segs = String(it[which + 'Route'] || '').split(' | ').filter(Boolean);
  if (!segs.length) return '';
  let prev = null;
  for (const seg of segs) {
    const m = /^(\w+)\u2192(\w+)\s+(.*)$/.exec(seg);
    if (!m) continue;
    const [, from, to, ref] = m;
    const mode = /\u6253\u8f66/.test(ref) ? 'taxi' : /\u63a5\u9a73/.test(ref) ? 'shuttle' : /^[GDCZKT]\d+/.test(ref) ? 'rail' : 'flight';
    if (prev === null) out += '<span class="nd">' + esc(tagOf(from)) + '</span>';
    out += '<span class="ic ' + mode + '">' + ICON[mode] + '</span>'
      + '<span class="nd' + (GROUND[mode] ? ' weak' : '') + '">' + esc(tagOf(to)) + '</span>';
    prev = to;
  }
  return out;
}

/** 次行：班次串联，ZH9101+G1234。地面段没有班次号，但有车种标签（「特急 33km」）就照写 */
function refLine(it, which) {
  const arr = it[which + 'Legs'];
  if (Array.isArray(arr) && arr.length) {
    return arr
      .map((g) => (g.mode === 'flight' || g.mode === 'rail' ? (g.label || g.ref) : (g.label || '')))
      .filter(Boolean).join('+');
  }
  return String(it[which + 'Route'] || '').split(' | ')
    .map((seg) => (/\u6253\u8f66|\u63a5\u9a73/.test(seg) ? '' : (seg.split(/\s+/)[1] || '')))
    .filter(Boolean).join('+');
}

/** 路径单元格：两行，hover 出逐段明细 */
function routeBlock(it, which, tag, cls) {
  const refs = refLine(it, which);
  return '<' + tag + ' class="' + cls + '" data-tipkey="' + tipKey(it, which) + '">'
    + '<span class="chain">' + chainHtml(it, which) + '</span>'
    + (refs ? '<span class="refs">' + esc(refs) + '</span>' : '')
    + '</' + tag + '>';
}

const badge = (v) => '<span class="bg b' + String(v).replace('.', 'h') + '">' + v + ' 天</span>';

// ---------------------------------------------------------------- 最优卡
function championCard(it, label, sub) {
  if (!it) return '<div class="card empty"><div class="ct">' + badge(label) + '</div><div class="cm">该档无可行组合</div></div>';
  return '<div class="card">'
    + '<div class="ct">' + badge(label) + '<span class="cr">' + sub + '</span></div>'
    + '<div class="cp">¥' + it.perDay + '<span class="cu">/雪日</span></div>'
    // 同一行两个 hover：雪时弹出逐日滑行表，总花费弹出费用构成
    + '<div class="cl"><span data-tipkey="' + snowKey(it) + '">雪时 <b>' + it.hEff + '</b> 小时</span>'
    + '<span data-tipkey="' + costKey(it) + '">总花费 \uffe5' + it.total + '</span></div>'
    // 档位多时卡片会变窄，起止时刻分两行写，避免「回深 / 圳」被折断
    + '<div class="cm"><span>' + md(it.outFirst) + ' ' + hm(it.outFirst) + ' 出发</span>'
    + '<span>' + md(it.backHome) + ' ' + hm(it.backHome) + ' 回到' + nodeName(cfg.origin) + '</span></div>'
    + '</div>';
}

// ---------------------------------------------------------------- 表
/** 机票小计（大交通）；交通费减去它就是高铁 + 打车 + 接驳 */
function flightCost(it) {
  return (it.outLegs || []).concat(it.retLegs || [])
    .filter((g) => g.mode === 'flight')
    .reduce((a, g) => a + (g.cost || 0), 0);
}

function table(list) {
  // 次行是「时刻 + 动作词」：读表时不用回头对照表头就知道 09:32 是入场还是离场
  // col + data-v 给前端排序用：v 是原始数值（分钟 / 小时 / 元），不是显示文本
  const dateCell = (a, act, col) => '<td class="mono" data-col="' + col + '" data-v="' + a + '">'
    + md(a) + ' <span class="dim">' + wd(a) + '</span><br>'
    + '<span class="dim">' + hm(a) + ' ' + act + '</span></td>';
  return list.map((it) => {
    const flags = (it.flags || []).map((f) => '<span class="fl">' + f + '</span>').join('');
    const ck = costKey(it);
    const air = flightCost(it);
    return '<tr data-leave="' + it.leave + '" data-perday="' + it.perDay + '" data-h="' + it.hEff + '">'
      + '<td>' + badge(it.leave) + '</td>'
      + dateCell(it.outFirst, '出发', 'out')
      + dateCell(it.arriveResort, '入场', 'arr')
      + routeBlock(it, 'out', 'td', 'rt')
      + dateCell(it.leaveResort, '离场', 'leave')
      + routeBlock(it, 'ret', 'td', 'rt')
      + dateCell(it.backHome, '到达', 'back')
      + '<td class="num hcell" data-col="h" data-v="' + it.hEff + '" data-tipkey="' + snowKey(it) + '"><b>' + it.hEff + '</b>'
      + '<br><span class="dim">日' + it.hDay + ' 夜' + it.hNight + '</span></td>'
      + '<td class="num lodgecell" data-col="lodge" data-v="' + it.lodge + '" data-tipkey="' + ck + '">¥' + it.lodge
      + '<br><span class="dim">雪场' + it.resortN + ' 中转' + it.hotelN + '</span></td>'
      + '<td class="num costcell" data-col="total" data-v="' + it.total + '" data-tipkey="' + ck + '">¥' + it.total
      + '<br><span class="dim">\u2708 \uffe5' + air + '</span></td>'
      + '<td class="num price" data-col="perday" data-v="' + it.perDay + '">¥' + it.perDay + '</td>'
      + '<td class="flcell">' + flags + '</td>'
      + '</tr>';
  }).join('');
}

// ---------------------------------------------------------------- 组装
const BUCKETS = topData.buckets;
const SESSION = (Number(RES.dayClose.slice(0, 2)) * 60 + Number(RES.dayClose.slice(3)) -
  (Number(RES.dayOpen.slice(0, 2)) * 60 + Number(RES.dayOpen.slice(3)))) / 60;
// 夜场权重：case/network 里没写就按 graphcore 的默认 0.5——否则页面会印出「按 undefined 折算」
const NIGHT_W = RES.nightWeight == null ? 0.5 : RES.nightWeight;
// 日场「太短就不算」的阈值，和 graphcore.snowWindows 用的是同一个默认值
const MIN_DAY_H = RES.minDayH == null ? 3 : Number(RES.minDayH);

const cards = BUCKETS.map((b) => {
  const list = topData.top[b] || [];
  // 每档只放第一名：质量缺陷（长中转等）留在表格「备注」列里供参考，最优位不再并列替代方案
  const meta = list.length ? list.length + ' 个组合' : '无可行组合';
  return championCard(list[0], b, '最优 · ' + meta);
}).join('');

// ---------------------------------------------------------------- 趋势图
/** 年假天数 → 最优档三项指标（几何与配色见 design.trendChart） */
function trendChart() {
  const pts = BUCKETS.map((b) => {
    const it = (topData.top[b] || [])[0];
    return it ? { b: b, perDay: it.perDay, h: it.hEff, total: it.total } : null;
  });
  if (!pts.length || pts.some((p) => !p)) return '';
  return D.trendChart({
    pts: pts,
    head: '年假天数 → 各档最优',
    foot: '横轴＝年假天数；纵轴每项按自身区间铺满，只比斜率不比高低。左右两端标注起止值，图例为「起点→终点」。',
    aria: '各档最优的元/雪日、雪时、总花费随年假天数的变化',
    series: [
      { name: '元/雪日', color: '#2f6fed', v: (p) => p.perDay, f: (x) => '¥' + x },
      { name: '雪时', color: '#d97706', v: (p) => p.h, f: (x) => x.toFixed(2) + 'h' },
      { name: '总花费', color: '#8b93a1', v: (p) => p.total, f: (x) => '¥' + x }
    ]
  });
}

const ALL = BUCKETS.reduce((a, b) => a.concat(topData.top[b] || []), []).sort((a, b) => a.perDay - b.perDay);

// 可排序表头：key 与 <td data-col> 对应；width 沿用原来的固定宽度，避免点一下就抖动
const sortTh = (key, label, cls, width, dir) =>
  '<th class="s' + (cls ? ' ' + cls : '') + (dir ? ' on' : '') + '" data-sort="' + key + '"'
  + (dir ? ' data-dir="' + dir + '"' : '') + ' style="width:' + width + 'px">' + label
  + '<span class="si">' + (dir === 'asc' ? '↑' : dir === 'desc' ? '↓' : '↕') + '</span></th>';

function panelOf(k, title, meta, list, on) {
  return '<div class="panel' + (on ? ' on' : '') + '" id="p-' + k + '">'
    + '<div class="phead"><h2>' + title + '</h2>'
    + '<span class="pmeta">' + meta + '</span></div>'
    + '<table class="tbl"><thead><tr>'
    + '<th style="width:64px">年假</th>'
    + sortTh('out', '出发', '', 74)
    + sortTh('arr', '入场', '', 74)
    + '<th>去程路径</th>'
    + sortTh('leave', '离场', '', 74)
    + '<th>返程路径</th>'
    + sortTh('back', '回' + nodeName(cfg.origin), '', 74)
    + sortTh('h', '雪时', 'num', 80)
    + sortTh('lodge', '住宿', 'num', 88)
    + sortTh('total', '总花费', 'num', 104)
    // 默认顺序就是元/雪日升序，所以这一列开局即标为激活
    + sortTh('perday', '元/雪日', 'num', 70, 'asc')
    + '<th style="width:96px">备注</th>'
    + '</tr></thead><tbody>' + table(list) + '</tbody></table></div>';
}

const META = '按「元 / 等效雪日」升序　等效雪日 = 有效雪时 ÷ ' + SESSION + 'h'
  + '　·　点表头可改排序，同值时按元/雪日升序';
const tabs = '<button class="tab on" data-k="all">全部年假</button>'
  + BUCKETS.map((b) => '<button class="tab" data-k="' + b + '">' + b + ' 天年假</button>').join('');
const panels = panelOf('all', '全部年假档 · 共 ' + ALL.length + ' 名', META, ALL, true)
  + BUCKETS.map((b) => {
    const list = topData.top[b] || [];
    return panelOf(b, b + ' 天年假 · 性价比前 ' + list.length + ' 名', META, list, false);
  }).join('');

const stepBox = (n, t, d) => '<div class="step"><div class="sn">' + n + '</div><div class="st">' + t + '</div><div class="sd">' + d + '</div></div>';

const totalCombos = (topData.totalCombos || 0);

// ---------------------------------------------------------------- 表头排序
// 每张表独立排序：点一次升序，再点降序。排序值取自 <td data-v> 的原始数字，
// 不从显示文本里反解（「¥1,234」和「21.5 小时」解析方式不同，且会丢精度）。
// 同值时一律按元/雪日升序兜底——否则同一天出发的十几行会保持原顺序，看起来像没排。
const SORT_JS = `
(function(){
  function val(row,key){
    var c=row.querySelector('[data-col="'+key+'"]');
    var v=c?parseFloat(c.getAttribute('data-v')):NaN;
    return isNaN(v)?0:v;
  }
  function sortBy(th){
    var table=th.closest('table'),tb=table.tBodies[0],key=th.getAttribute('data-sort');
    var dir=th.getAttribute('data-dir')==='asc'?'desc':'asc';
    Array.prototype.forEach.call(table.querySelectorAll('th[data-sort]'),function(o){
      if(o!==th){
        o.removeAttribute('data-dir');
        o.classList.remove('on');
        o.querySelector('.si').textContent='↕';
      }
    });
    th.setAttribute('data-dir',dir);
    th.classList.add('on');
    th.querySelector('.si').textContent=(dir==='asc'?'↑':'↓');
    var rows=Array.prototype.slice.call(tb.rows);
    rows.sort(function(a,b){
      var va=val(a,key),vb=val(b,key);
      if(va!==vb)return dir==='asc'?va-vb:vb-va;
      return val(a,'perday')-val(b,'perday');
    });
    for(var i=0;i<rows.length;i++)tb.appendChild(rows[i]);
  }
  Array.prototype.forEach.call(document.querySelectorAll('th[data-sort]'),function(th){
    th.addEventListener('click',function(){sortBy(th);});
  });
})();
`;

const html = '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8"><title>' + cfg.title + ' · 路径枚举报告</title><style>'
  + D.css({cardCols: Math.max(BUCKETS.length, 1)})
  + '</style></head><body><div class="wrap">'
  + '<h1>' + cfg.title + '</h1>'
  + '<div class="sub">' + nodeName(cfg.origin) + ' ⇄ ' + nodeName(cfg.resort) + '　|　日场 <b>' + RES.dayOpen + '–' + RES.dayClose + '</b>（' + SESSION + 'h）　夜场 <b>'
  + (RES.nightOpen || '—') + '–' + (RES.nightClose || '—') + '</b>'
  + (RES.nightOpen ? ' 按 <b>' + NIGHT_W + '</b> 折算' : '（无夜场）') + '<br>'
  + '住宿 雪场 <b>¥' + cfg.params.lodgingResort + '/晚</b>　中转 <b>¥' + cfg.params.lodgingTransit + '/晚</b>　|　'
  + '请假分界：<b>' + cfg.params.leave.dayStart + '</b> / <b>' + cfg.params.leave.halfDayAt + '</b> / <b>' + cfg.params.leave.dayEnd + '</b></div>'

  + '<div class="sh"><h2>算法：五步，全程无人工挑选</h2></div>'
  + '<div class="steps">'
  + stepBox('STEP 1', '建路径表', '航班 / 高铁 / 打车统一成有向边，每条边带「起点、终点、开始、结束、花费」。')
  + stepBox('STEP 2', 'DFS 穷举', '从' + nodeName(cfg.origin) + '搜到' + nodeName(cfg.resort) + '、再搜回来。约束只有三条：时间能接上、不重复经过节点、段数 ≤ 5。')
  + stepBox('STEP 3', '同键剪枝', '按（年假档, 日期, 到场/离场时刻, 夜间状态）保留最低价。被剪掉的都被严格支配。')
  + stepBox('STEP 4', '笛卡尔配对', '去程 × 返程，只留「返程离场晚于去程到场」的组合，逐对算费用、雪时、年假。')
  + stepBox('STEP 5', '排序取前 30', '按「元 / 等效雪日」升序，每个年假档取前 30 名，附质量标记。')
  + '</div>'

  + '<div class="stat">'
  + '<div class="sb"><div class="sv">' + legs.length + '</div><div class="sl">路径边总数</div></div>'
  + '<div class="sb"><div class="sv">' + (byMode.flight || 0) + '</div><div class="sl">航班边</div></div>'
  + '<div class="sb"><div class="sv">' + (byMode.rail || 0) + '</div><div class="sl">高铁边</div></div>'
  + '<div class="sb"><div class="sv">' + ((byMode.taxi || 0) + (byMode.shuttle || 0)) + '</div><div class="sl">打车 / 接驳边</div></div>'
  + '<div class="sb"><div class="sv">' + (topData.rawItineraries || '—') + '</div><div class="sl">可行组合（配对后）</div></div>'
  + '<div class="sb"><div class="sv">' + Object.keys(net.nodes).length + '</div><div class="sl">网络节点</div></div>'
  + '</div>'

  + '<div class="sh"><h2>各档最优</h2></div>'
  + '<div class="cards">' + cards + '</div>'
  + trendChart()

  + '<div class="sh"><h2>全部组合与各档前 30</h2></div>'
  + '<div class="tabs">' + tabs + '</div>'
  + panels

  + '<div class="sh"><h2>口径与已知局限</h2></div>'
  + '<div class="notes"><ul>'
  + '<li><b>元/雪日</b> = （交通费 + 住宿费）÷（有效雪时 ÷ ' + SESSION + '）。<b>不含</b>雪票、租装备、餐饮、雪场停车。</li>'
  + '<li><b>有效雪时</b> = 日场实测小时'
  + (RES.nightOpen ? ' + 夜场实测小时 × ' + NIGHT_W : '（本雪场无夜场）')
  + '。到场 = 落地 + 出站 + 车程；离场 = 首段发车 − 进站 − 车程。</li>'
  + (MIN_DAY_H > 0
    ? '<li><b>日场不足 ' + MIN_DAY_H + ' 小时的日子按 0 计</b>：某一天「到场→离场」和日场营业时间的'
      + '交集不到 ' + MIN_DAY_H + ' 小时，换鞋、存包、热身都不止这个时间，整天不计雪时。'
      + '夜场不受此限（夜里上山是另一回事）。</li>'
    : '')
  + (function () {
    const c = topData.calendar;
    if (!c || !c.enabled) {
      return '<li><b>年假</b> 按「周六日免假、其余都算上班」计，<b>未考虑法定节假日与调休</b>'
        + '（case.json 没有写 <code>params.calendar</code>）。碰上元旦、春节这类日期会算错。</li>';
    }
    const d = c.inWindow || {};
    const hl = (d.holidays || []).join('、') || '窗口内无法定假';
    const wd = (d.workdays || []).join('、');
    return '<li><b>年假</b> 已接入中国法定节假日与调休：窗口内 ' + hl
      + (wd ? '；调休上班 ' + wd : '；窗口内无调休上班日')
      + '。<br>来源：' + (c.sources || []).join('；')
      + ((c.warnings && c.warnings.length) ? '<br><b>注意</b>　' + c.warnings.join(' ') : '')
      + '</li>';
  })()
  + '<li><b>住宿</b> 按每天 ' + (cfg.params.nightBoundary || '03:00') + ' 这一时刻人在哪判定：在雪场记雪场晚，在机场/车站记中转晚，在车上机上记 0。</li>'
  + '<li><b>中转停留 &gt; ' + (cfg.params.maxStopMinutes || 480) + ' 分钟</b>的航班边已在建表时剔除；「长中转」标记指停留 3–8 小时的航班，价格低但体验差，按需避开。</li>'
  + '<li><b>机场代码</b>取自飞常准 <code>legs[].segments[].dep_airport / arr_airport</code>，代码共享航班也能判对；只有升级前落盘的旧缓存缺这一列时，才按航司归属推断。同一起降时刻的多条代码共享行在建表前已按最低价去重。</li>'
  + '<li><b>高铁时刻表</b>来自 12306 页面与第三方聚合站，不是 API，出行前必须在 12306 复核；打车费与接驳按路径表里的里程、单价展开，实际以现场报价为准。</li>'
  + (cfg.notes || []).map((s) => '<li>' + s + '</li>').join('')
  + '</ul></div>'
  + '<div class="warn"><b>数据时效</b>　航班票价与余票为 ' + (cfg.dataAsOf || new Date().toISOString().slice(0, 10))
  + ' 的查询快照，会随出票变化；高铁票价为公布票价，实际执行有浮动折扣。下单前请逐条复核。</div>'
  + '<div class="sub" style="margin-top:22px">生成时间 ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + '　·　'
  + '枚举引擎 enumerate.js v1　·　边表 legs.js + network.json</div>'
  + '</div>'
  + '<div id="tip"></div>'
  + '<script>'
  + 'document.querySelectorAll(".tab").forEach(function(t){t.onclick=function(){'
  + 'document.querySelectorAll(".tab").forEach(function(x){x.classList.toggle("on",x===t)});'
  + 'document.querySelectorAll(".panel").forEach(function(p){p.classList.toggle("on",p.id==="p-"+t.dataset.k)});};});'
  + SORT_JS
  + D.tipRuntime(TIPS)
  + '<\/script></body></html>';

// 交付物只有 HTML：把原始数据与算法源码一并嵌进去，别人拿一个文件就能验算
const packed = E.attach(html, {
  dir: path.dirname(path.resolve(cfgPath)),
  title: cfg.title,
  kind: 'resort',
  session: SESSION,
  counts: {
    legs: legs.length,
    byMode: byMode,
    buckets: BUCKETS,
    topRows: BUCKETS.reduce((a, b) => a + (topData.top[b] || []).length, 0),
    rawItineraries: topData.rawItineraries,
  },
});

fs.writeFileSync(outFile, packed, 'utf8');
console.log('HTML → ' + outFile + '  (' + (Buffer.byteLength(packed) / 1048576).toFixed(1) + ' MB，含原始数据内嵌)');
