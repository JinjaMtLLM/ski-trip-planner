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
  const add = (dir, list) => {
    for (const g of list || []) {
      rows.push([dir + ' ' + (MODE_CN[g.mode] || g.mode) + ' ' + tagOf(g.from) + '-' + tagOf(g.to),
        (g.mode === 'flight' || g.mode === 'rail') ? (g.ref || '') : '',
        '￥' + (g.cost || 0)]);
    }
  };
  add('去程', it.outLegs);
  add('返程', it.retLegs);
  const airSum = rows.filter((r) => r[0].includes('航班')).reduce((a, r) => a + Number(String(r[2]).replace('￥', '')), 0);
  rows.push(['机票小计', '', '￥' + airSum]);
  rows.push(['其他交通', '高铁 + 打车 + 接驳', '￥' + (it.transport - airSum)]);
  rows.push(['交通合计', '', '￥' + it.transport, 'sum']);
  rows.push(['雪场住宿', it.resortN + ' 晚 × ￥' + RES_PRICE, '￥' + it.resortN * RES_PRICE]);
  rows.push(['中转住宿', it.hotelN + ' 晚 × ￥' + TRANSIT_PRICE, '￥' + it.hotelN * TRANSIT_PRICE]);
  rows.push(['总计', '', '￥' + it.total, 'grand']);
  return rows;
}
function costKey(it) { return pushTip({ k: 'cost', rows: costRows(it) }); }

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

/** 次行：班次串联，ZH9101+G1234（打车/接驳没有班次，自然不出现） */
function refLine(it, which) {
  const arr = it[which + 'Legs'];
  if (Array.isArray(arr) && arr.length) {
    const refs = arr.filter((g) => g.mode === 'flight' || g.mode === 'rail').map((g) => g.ref).filter(Boolean);
    return refs.join('+');
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
    + '<div class="cl" data-tipkey="' + costKey(it) + '">雪时 <b>' + it.hEff + '</b> 小时　总花费 ¥' + it.total + '</div>'
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
  const dateCell = (a, act) => '<td class="mono">' + md(a) + ' <span class="dim">' + wd(a) + '</span><br>'
    + '<span class="dim">' + hm(a) + ' ' + act + '</span></td>';
  return list.map((it) => {
    const flags = (it.flags || []).map((f) => '<span class="fl">' + f + '</span>').join('');
    const ck = costKey(it);
    const air = flightCost(it);
    return '<tr data-leave="' + it.leave + '" data-perday="' + it.perDay + '" data-h="' + it.hEff + '">'
      + '<td>' + badge(it.leave) + '</td>'
      + dateCell(it.outFirst, '出发')
      + dateCell(it.arriveResort, '入场')
      + routeBlock(it, 'out', 'td', 'rt')
      + dateCell(it.leaveResort, '离场')
      + routeBlock(it, 'ret', 'td', 'rt')
      + dateCell(it.backHome, '到达')
      + '<td class="num"><b>' + it.hEff + '</b><br><span class="dim">日' + it.hDay + ' 夜' + it.hNight + '</span></td>'
      + '<td class="num lodgecell" data-tipkey="' + ck + '">¥' + it.lodge
      + '<br><span class="dim">雪场' + it.resortN + ' 中转' + it.hotelN + '</span></td>'
      + '<td class="num costcell" data-tipkey="' + ck + '">¥' + it.total
      + '<br><span class="dim">\u2708 \uffe5' + air + '</span></td>'
      + '<td class="num price">¥' + it.perDay + '</td>'
      + '<td class="flcell">' + flags + '</td>'
      + '</tr>';
  }).join('');
}

// ---------------------------------------------------------------- 组装
const BUCKETS = topData.buckets;
const RES = cfg.params.resort;
const SESSION = (Number(RES.dayClose.slice(0, 2)) * 60 + Number(RES.dayClose.slice(3)) -
  (Number(RES.dayOpen.slice(0, 2)) * 60 + Number(RES.dayOpen.slice(3)))) / 60;

const cards = BUCKETS.map((b) => {
  const list = topData.top[b] || [];
  // 每档只放第一名：质量缺陷（长中转等）留在表格「备注」列里供参考，最优位不再并列替代方案
  const meta = list.length ? list.length + ' 个组合' : '无可行组合';
  return championCard(list[0], b, '最优 · ' + meta);
}).join('');

// ---------------------------------------------------------------- 趋势图
/** 年假天数 → 最优档三项指标的折线图（纯 SVG，不引外部图表库）
 *  三项单位不同（¥/雪日、h、¥），塞进一根真实纵轴会互相压扁到看不出趋势，
 *  所以画在同一块画布上、每项各自按自己的区间铺满整高：斜率可比，高低不可比。
 *  真实数值放在图例的「起点 → 终点」和右端标签里，不在每个点上堆数字。 */
function trendChart() {
  const pts = BUCKETS.map((b, i) => {
    const it = (topData.top[b] || [])[0];
    return it ? { i: i, b: b, perDay: it.perDay, h: it.hEff, total: it.total } : null;
  });
  if (!pts.length || pts.some((p) => !p)) return '';

  const SERIES = [
    { name: '元/雪日', color: '#2f6fed', v: (p) => p.perDay, f: (x) => '¥' + x },
    { name: '雪时', color: '#d97706', v: (p) => p.h, f: (x) => x.toFixed(2) + 'h' },
    { name: '总花费', color: '#8b93a1', v: (p) => p.total, f: (x) => '¥' + x }
  ];

  const W = 632, H = 214, PL = 66, PR = 552, PT = 16, PB = 180;
  const x = (i) => PL + (i * (PR - PL)) / Math.max(pts.length - 1, 1);

  const grid = [0, 1, 2, 3].map((k) => {
    const y = PT + ((PB - PT) / 3) * k;
    return '<line x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + PR + '" y2="' + y.toFixed(1) + '" stroke="#eff1f4"/>';
  }).join('');

  const rows = SERIES.map((se) => {
    const vals = pts.map(se.v);
    const lo0 = Math.min.apply(null, vals), hi0 = Math.max.apply(null, vals);
    const pad = (hi0 - lo0) * 0.14 || Math.max(hi0 * 0.05, 1);
    const lo = lo0 - pad, hi = hi0 + pad;
    const y = (v) => PB - ((v - lo) / (hi - lo)) * (PB - PT);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(se.v(p)).toFixed(1)).join(' ');
    const dots = pts.map((p, i) => '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(se.v(p)).toFixed(1)
      + '" r="3.2" fill="#fff" stroke="' + se.color + '" stroke-width="2"/>').join('');
    return {
      se: se, d: d, dots: dots,
      startV: se.f(se.v(pts[0])),
      startY: y(se.v(pts[0])),
      endV: se.f(se.v(pts[pts.length - 1])),
      endY: y(se.v(pts[pts.length - 1]))
    };
  });

  // 起止点标签：先按各自点的真实位置排，再自上而下推挤，避免两条线靠太近时字叠字
  const spread = (list) => {
    list.sort((a, b) => a.y - b.y);
    for (let i = 1; i < list.length; i++) {
      if (list[i].y - list[i - 1].y < 14) list[i].y = list[i - 1].y + 14;
    }
    const over = list.length ? list[list.length - 1].y - PB : 0;
    if (over > 0) list.forEach((l) => { l.y -= over; });
    return list;
  };
  const lab = (l, x, anchor) => '<text x="' + x + '" y="' + (l.y + 3.2).toFixed(1) + '" font-size="9.5"'
    + (anchor === 'end' ? ' text-anchor="end"' : '') + ' fill="' + l.c + '">' + l.v + '</text>';
  const startLabels = spread(rows.map((r) => ({ y: r.startY, v: r.startV, c: r.se.color })))
    .map((l) => lab(l, PL - 9, 'end')).join('');
  const endLabels = spread(rows.map((r) => ({ y: r.endY, v: r.endV, c: r.se.color })))
    .map((l) => lab(l, PR + 9)).join('');

  const xs = pts.map((p, i) => '<text x="' + x(i).toFixed(1) + '" y="' + (H - 8)
    + '" text-anchor="middle" font-size="10" fill="#6b7280">' + p.b + ' 天</text>').join('');

  const legend = rows.map((r) => '<span><i style="background:' + r.se.color + '"></i>'
    + r.se.name + ' <b>' + r.startV + '</b>\u2192<b>' + r.endV + '</b></span>').join('');

  return '<div class="chartbox">'
    + '<div class="chead"><span class="ct2">年假天数 → 各档最优</span><span class="lg">' + legend + '</span></div>'
    + '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="各档最优的元/雪日、雪时、总花费随年假天数的变化">'
    + grid + rows.map((r) => '<path d="' + r.d + '" fill="none" stroke="' + r.se.color
      + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' + r.dots).join('')
    + endLabels + startLabels + xs + '</svg>'
    + '<div class="cfoot">横轴＝年假天数；纵轴每项按自身区间铺满，只比斜率不比高低。左右两端标注起止值，图例为「起点→终点」。</div>'
    + '</div>';
}

const ALL = BUCKETS.reduce((a, b) => a.concat(topData.top[b] || []), []).sort((a, b) => a.perDay - b.perDay);

function panelOf(k, title, meta, list, on) {
  return '<div class="panel' + (on ? ' on' : '') + '" id="p-' + k + '">'
    + '<div class="phead"><h2>' + title + '</h2>'
    + '<span class="pmeta">' + meta + '</span></div>'
    + '<table class="tbl"><thead><tr>'
    + '<th style="width:64px">年假</th><th style="width:74px">出发</th><th style="width:74px">入场</th>'
    + '<th>去程路径</th><th style="width:74px">离场</th>'
    + '<th>返程路径</th><th style="width:74px">回' + nodeName(cfg.origin) + '</th>'
    + '<th class="num" style="width:80px">雪时</th><th class="num" style="width:88px">住宿</th>'
    + '<th class="num" style="width:104px">总花费</th><th class="num" style="width:70px">元/雪日</th>'
    + '<th style="width:96px">备注</th>'
    + '</tr></thead><tbody>' + table(list) + '</tbody></table></div>';
}

const META = '按「元 / 等效雪日」升序　等效雪日 = 有效雪时 ÷ ' + SESSION + 'h';
const tabs = '<button class="tab on" data-k="all">全部年假</button>'
  + BUCKETS.map((b) => '<button class="tab" data-k="' + b + '">' + b + ' 天年假</button>').join('');
const panels = panelOf('all', '全部年假档 · 共 ' + ALL.length + ' 名', META, ALL, true)
  + BUCKETS.map((b) => {
    const list = topData.top[b] || [];
    return panelOf(b, b + ' 天年假 · 性价比前 ' + list.length + ' 名', META, list, false);
  }).join('');

const stepBox = (n, t, d) => '<div class="step"><div class="sn">' + n + '</div><div class="st">' + t + '</div><div class="sd">' + d + '</div></div>';

const totalCombos = (topData.totalCombos || 0);
const html = '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8"><title>' + cfg.title + ' · 路径枚举报告</title><style>'
  + '*{box-sizing:border-box}'
  + 'body{margin:0;padding:34px 28px 70px;font-family:-apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;background:#f5f6f8;color:#16181d;-webkit-font-smoothing:antialiased}'
  + '.wrap{max-width:1580px;margin:0 auto}'
  + 'h1{font-size:25px;margin:0 0 8px;letter-spacing:-.4px}'
  + '.sub{color:#6b7280;font-size:13px;line-height:1.8}'
  + '.sub b{color:#16181d;font-weight:600}'
  + 'h2{font-size:15px;margin:0}'
  + '.sec{margin-top:30px}'
  + '.sh{display:flex;align-items:center;gap:9px;margin:30px 0 14px}'
  + '.sh::before{content:"";width:3px;height:15px;background:#2f6fed;border-radius:2px}'
  + '.steps{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}'
  + '.step{background:#fff;border:1px solid #e4e7ec;border-radius:10px;padding:14px 15px;position:relative}'
  + '.sn{font-size:11px;font-weight:700;color:#2f6fed;letter-spacing:.5px}'
  + '.st{font-size:13.5px;font-weight:600;margin:5px 0 6px}'
  + '.sd{font-size:11.5px;color:#6b7280;line-height:1.65}'
  + '.stat{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-top:12px}'
  + '.sb{background:#fff;border:1px solid #e4e7ec;border-radius:9px;padding:12px 14px}'
  + '.sv{font-size:20px;font-weight:700;letter-spacing:-.5px}'
  + '.sl{font-size:11px;color:#8b93a1;margin-top:2px}'
  + '.cards{display:grid;grid-template-columns:repeat(' + Math.max(BUCKETS.length, 1) + ',minmax(0,1fr));gap:12px}'
  + '.chartbox{margin-top:12px;background:#fff;border:1px solid #e4e7ec;border-radius:11px;padding:13px 16px 9px;max-width:664px}'
  + '.chead{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}'
  + '.ct2{font-size:12px;font-weight:600;color:#3f4652}'
  + '.lg{display:flex;gap:12px;font-size:10.5px;color:#6b7280}'
  + '.csub{font-size:10px;color:#b3b9c4}'
  + '.lg b{color:#3f4652;font-weight:600}'
  + '.lg i{display:inline-block;width:9px;height:2px;border-radius:1px;margin-right:4px;vertical-align:middle}'
  + '.cfoot{font-size:10px;color:#a6adba;margin-top:3px}'
  + '.card{background:#fff;border:1px solid #e4e7ec;border-radius:11px;padding:15px 17px}'
  + '.card.empty{opacity:.45}'
  + '.ct{display:flex;justify-content:space-between;align-items:center;margin-bottom:9px}'
  + '.cr{font-size:10.5px;color:#98a0ad}'
  + '.cp{font-size:27px;font-weight:700;letter-spacing:-.7px}'
  + '.cu{font-size:12px;font-weight:500;color:#6b7280;margin-left:2px}'
  + '.cl{font-size:12.5px;color:#3f4652;margin-top:3px;cursor:help}'
  + '.cl:hover{color:#1d4ed8}'
  + '.cbar{display:flex;gap:14px;font-size:11.5px;color:#8b93a1;margin-top:8px;padding-top:8px;border-top:1px dashed #eceef1}'
  + '.croute{font-size:11px;margin-top:9px;line-height:1.7;cursor:help}'
  + '.cm{font-size:11px;color:#98a0ad;margin-top:9px;padding-top:8px;border-top:1px dashed #eceef1;line-height:1.6}'
  + '.cm span{display:block;white-space:nowrap}'
  + '.cflag{font-size:11px;color:#b45309;background:#fef6e7;border-radius:5px;padding:3px 7px;margin-top:7px;display:inline-block}'
  + '.bg{display:inline-block;padding:2px 9px;border-radius:20px;font-size:11.5px;font-weight:600}'
  + '.b0{background:#e7f5ee;color:#0d7a4c}.bh{background:#fdf0e2;color:#b45309}.b1{background:#e7eefd;color:#1d4ed8}'
  + '.tabs{display:flex;gap:6px;margin:6px 0 0}'
  + '.tab{font:inherit;font-size:13px;padding:8px 20px;border-radius:8px;border:1px solid #d6dae1;background:#fff;color:#3f4652;cursor:pointer;font-weight:500}'
  + '.tab.on{background:#16181d;border-color:#16181d;color:#fff}'
  + '.panel{display:none;margin-top:14px}.panel.on{display:block}'
  + '.phead{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px}'
  + '.pmeta{font-size:11.5px;color:#98a0ad}'
  + 'table{border-collapse:separate;border-spacing:0;background:#fff;border:1px solid #e4e7ec;border-radius:10px;overflow:hidden;font-size:12px;width:100%}'
  + 'th{background:#f9fafb;text-align:left;padding:9px 8px;font-weight:600;color:#4b5563;font-size:11px;border-bottom:1px solid #e4e7ec;white-space:nowrap}'
  + 'td{padding:8px;border-bottom:1px solid #f1f3f5;vertical-align:top}'
  + 'tbody tr:hover{background:#fafbfc}tbody tr:last-child td{border-bottom:none}'
  + '.num{text-align:right;font-variant-numeric:tabular-nums}'
  + '.mono{font-variant-numeric:tabular-nums;white-space:nowrap;font-size:11.5px;line-height:1.5}'
  + '.dim{color:#98a0ad;font-size:10.5px}.price{font-weight:700;font-size:13px}'
  + '.costcell,.lodgecell,.cbar{cursor:help}'
  + '.lodgecell:hover{color:#1d4ed8}'
  + '.costcell:hover,.cbar:hover{color:#1d4ed8}'
  + '.rt{font-size:11px;line-height:1.7;min-width:172px;cursor:help}'
  + '.chain{display:block;white-space:nowrap;color:#16181d;letter-spacing:.1px}'
  + '.refs{display:block;white-space:nowrap;color:#a0a7b3;font-size:10px;margin-top:1px;'
  + 'font-variant-numeric:tabular-nums;letter-spacing:.15px}'
  + '.nd{font-weight:600}.nd.weak{font-weight:500;color:#939aa6}'
  + '.ic{font-size:10px;margin:0 2px;vertical-align:1px;line-height:1}'
  + '.ic.flight{color:#1d4ed8}.ic.rail{color:#0d7a4c}'
  + '.ic.taxi{color:#c6cbd3}.ic.shuttle{color:#c6cbd3}'
  + '.rt:hover .chain,.croute:hover .chain{color:#1d4ed8}.rt:hover .refs,.croute:hover .refs{color:#8fa2c8}'
  + '#tip{position:fixed;z-index:99;pointer-events:none;background:#16181d;color:#fff;border-radius:7px;'
  + 'font-size:11px;line-height:1.7;padding:10px 13px;opacity:0;transition:opacity .12s;'
  + 'box-shadow:0 10px 30px rgba(0,0,0,.28)}'
  + '#tip .tg{display:grid;grid-template-columns:auto auto auto auto auto;column-gap:14px;row-gap:1px}'
  + '#tip .tg.cost{grid-template-columns:auto auto auto;column-gap:16px;row-gap:0}'
  + '#tip .tc.n{color:#9aa1ad}'
  + '#tip .rowline{grid-column:1/-1;display:flex;justify-content:space-between;'
  + 'border-top:1px solid #3c424c;padding-top:5px;margin-top:5px;color:#fff}'
  + '#tip .rowline.sum{font-weight:600}'
  + '#tip .rowline.grand{font-weight:700;border-top-color:#6b7280}'
  + '#tip .tc{white-space:nowrap}'
  + '#tip .tc.t{color:#a9b1be;font-variant-numeric:tabular-nums}'
  + '#tip .tc.c{text-align:right;font-variant-numeric:tabular-nums}'
  + '#tip .tc.x{color:#8f97a4}'
  + '#tip .tc.m{color:#e5e7eb}'
  + '.fl{display:inline-block;font-size:10px;background:#fef6e7;color:#a16207;border-radius:4px;padding:1px 5px;margin:1px 2px 1px 0;white-space:nowrap}'
  + '.notes{background:#fff;border:1px solid #e4e7ec;border-radius:10px;padding:16px 20px;font-size:12.5px;line-height:1.9;color:#3f4652}'
  + '.notes b{color:#16181d}'
  + '.notes ul{margin:0;padding-left:17px}.notes li{margin:4px 0}'
  + '.notes code{background:#f3f4f6;padding:1px 5px;border-radius:4px;font-size:11.5px;color:#b45309}'
  + '.warn{background:#fef2f2;border:1px solid #f6c9c6;border-radius:9px;padding:13px 17px;font-size:12.5px;line-height:1.85;color:#8a1f1a;margin-top:10px}'
  + '</style></head><body><div class="wrap">'
  + '<h1>' + cfg.title + '</h1>'
  + '<div class="sub">' + nodeName(cfg.origin) + ' ⇄ ' + nodeName(cfg.resort) + '　|　日场 <b>' + RES.dayOpen + '–' + RES.dayClose + '</b>（' + SESSION + 'h）　夜场 <b>'
  + (RES.nightOpen || '—') + '–' + (RES.nightClose || '—') + '</b> 按 <b>' + RES.nightWeight + '</b> 折算<br>'
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
  + '<li><b>有效雪时</b> = 日场实测小时 + 夜场实测小时 × ' + RES.nightWeight + '。到场 = 落地 + 出站 + 车程；离场 = 首段发车 − 进站 − 车程。</li>'
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
  + 'var TIPS=' + JSON.stringify(TIPS) + ';'
  + 'var tipEl=document.getElementById("tip");'
  + 'function cell(cls,txt){var d=document.createElement("div");d.className="tc "+cls;d.textContent=txt||"";return d;}'
  + 'function fillTip(t){'
  + '  var g=document.createElement("div"),i;'
  + '  if(t.k==="cost"){'
  + '    g.className="tg cost";'
  + '    (t.rows||[]).forEach(function(r){'
  + '      var ex=r[3]||"";'
  + '      if(ex){'
  + '        var d=document.createElement("div");d.className="tc rowline "+ex;'
  + '        var a=document.createElement("span");a.textContent=r[0];'
  + '        var b=document.createElement("span");b.textContent=r[2];'
  + '        d.appendChild(a);d.appendChild(b);g.appendChild(d);'
  + '      } else {'
  + '        g.appendChild(cell("",r[0]));g.appendChild(cell("n",r[1]));g.appendChild(cell("c",r[2]));}'
  + '    });'
  + '  } else {'
  + '    g.className="tg";'
  + '    (t.rows||[]).forEach(function(r){'
  + '      var cls=["t","","m","c","x"];'
  + '      for(i=0;i<5;i++) g.appendChild(cell(cls[i],r[i]));});}'
  + '  tipEl.innerHTML="";tipEl.appendChild(g);}'
  + 'document.querySelectorAll("[data-tipkey]").forEach(function(el){'
  + '  el.addEventListener("mouseenter",function(){fillTip(TIPS[+el.dataset.tipkey]||{k:"legs",rows:[]});tipEl.style.opacity=1;});'
  + '  el.addEventListener("mousemove",function(ev){'
  + '    var w=tipEl.offsetWidth,h=tipEl.offsetHeight;'
  + '    var left=Math.min(ev.clientX+14,window.innerWidth-w-12);'
  + '    var top=ev.clientY-h-12<8?ev.clientY+18:ev.clientY-h-12;'
  + '    tipEl.style.left=left+"px";tipEl.style.top=top+"px";});'
  + '  el.addEventListener("mouseleave",function(){tipEl.style.opacity=0;});});'
  + '</script></body></html>';

fs.writeFileSync(outFile, html, 'utf8');
console.log('HTML →', outFile);
