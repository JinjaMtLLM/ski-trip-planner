#!/usr/bin/env node
'use strict';
/**
 * design.js — 全部汇报页的唯一视觉真源
 *
 * 为什么要有这个文件：样式原本只存在于 render.js 拼 HTML 的字符串里，五个雪场页复用它，
 * 禾木那两页各写了一份自己的，于是同样的「元/雪日表」在两边长得不一样——折叠边框圆角不裁、
 * 主数字 27px 变 19px、th 字号 11 变 11.5、选中行用玫红粉底、hover 明细整块没有。
 * 规范写在字符串里就等于没有规范，谁都能绕开。所以把 CSS / 页壳 / 段落头 / 五步 / 统计条 /
 * 口径块 / 悬停运行时都搬到这里，任何页面要用，只能 require 这份。
 *
 * 约定（改这里就是改所有页面，动手前先想清楚）：
 *   底 #f5f6f8　线 #e4e7ec　字 #16181d　次字 #6b7280　主色 #2f6fed
 *   h1 25px　段头 h2 15px + 3px 竖条　正文 16px（不显式设 font-size，跟浏览器默认走）
 *   表格 separate + border-spacing:0，圆角才裁得住；数据列一律 .num 右对齐
 *   主数字 .cp 27px；悬停明细只有一套 #tip
 */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * 样式表。
 * @param {object} o
 * @param {number} o.cardCols 最优卡一行几列（默认 9，跟年假档数走）
 * @param {string} o.extra    页面独有的补充规则，追加在末尾，便于个别页面微调而不改共用部分
 */
function css(o) {
  const cardCols = Math.max(Number((o || {}).cardCols) || 9, 1);
  const extra = (o || {}).extra || '';
  return '*{box-sizing:border-box}'
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
    + '.cards{display:grid;grid-template-columns:repeat(' + cardCols + ',minmax(0,1fr));gap:12px}'
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
    + '.cl span{cursor:help}.cl span+span{margin-left:14px}'
    + '.cl span:hover{color:#1d4ed8}'
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
    + '.refs{display:block;white-space:nowrap;color:#a0a7b3;font-size:10px;margin-top:1px;font-variant-numeric:tabular-nums;letter-spacing:.15px}'
    + '.nd{font-weight:600}.nd.weak{font-weight:500;color:#939aa6}'
    + '.ic{font-size:10px;margin:0 2px;vertical-align:1px;line-height:1}'
    + '.ic.flight{color:#1d4ed8}.ic.rail{color:#0d7a4c}'
    + '.ic.taxi{color:#c6cbd3}.ic.shuttle{color:#c6cbd3}'
    + '.rt:hover .chain,.croute:hover .chain{color:#1d4ed8}.rt:hover .refs,.croute:hover .refs{color:#8fa2c8}'
    + '#tip{position:fixed;z-index:99;pointer-events:none;background:#16181d;color:#fff;border-radius:7px;font-size:11px;line-height:1.7;padding:10px 13px;opacity:0;transition:opacity .12s;box-shadow:0 10px 30px rgba(0,0,0,.28)}'
    + '#tip .tg{display:grid;grid-template-columns:auto auto auto auto auto;column-gap:14px;row-gap:1px}'
    + '#tip .tg.snow{grid-template-columns:auto auto auto;column-gap:18px;row-gap:2px}'
    + '#tip .tg.cost{grid-template-columns:auto auto auto;column-gap:16px;row-gap:0}'
    + '#tip .tc.n{color:#9aa1ad}'
    + '#tip .rowline{grid-column:1/-1;display:flex;justify-content:space-between;border-top:1px solid #3c424c;padding-top:5px;margin-top:5px;color:#fff}'
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
    + extra;
}

// ---------------------------------------------------------------- 组件
/** 段落头：3px 竖条 + 标题 + 可选右侧说明 */
const sec = (title, hint) => '<div class="sh"><h2>' + title + '</h2>'
  + (hint ? '<span class="pmeta">' + hint + '</span>' : '') + '</div>';

/** 五步算法条 */
const steps = (list) => '<div class="steps">' + list.map((x) => '<div class="step">'
  + '<div class="sn">' + x.n + '</div><div class="st">' + x.t + '</div><div class="sd">' + x.d + '</div></div>').join('') + '</div>';

/** 统计条（六格） */
const stats = (list) => '<div class="stat">' + list.map((x) => '<div class="sb">'
  + '<div class="sv">' + x.v + '</div><div class="sl">' + x.l + '</div></div>').join('') + '</div>';

/** 口径 / 已知局限 */
const notes = (items) => '<div class="notes"><ul>' + items.filter(Boolean).map((s) => '<li>' + s + '</li>').join('') + '</ul></div>';
const warn = (text) => '<div class="warn">' + text + '</div>';

// ---------------------------------------------------------------- 页壳
/**
 * 组装整页。body 由调用方拼好后传进来，这个函数只负责 <head>、空挂 #tip 和悬停脚本。
 * @param {object} o
 * @param {string} o.title    <title> 与页脚前的标题文案
 * @param {string} o.sub      标题下的口径行（.sub，可用 <b>）
 * @param {string} o.body     正文
 * @param {number} o.cardCols 最优卡列数
 * @param {string} o.extraCss 页面独有规则
 * @param {string} o.script   页面独有脚本（追加在悬停脚本之后）
 * @param {string} o.footLeft 页脚左侧文案（生成时间等）
 */
function page(o) {
  return '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8"><title>' + o.title + '</title><style>'
    + css({ cardCols: o.cardCols, extra: o.extraCss })
    + '</style></head><body><div class="wrap">'
    + '<h1>' + o.title + '</h1>'
    + '<div class="sub">' + (o.sub || '') + '</div>'
    + (o.body || '')
    + (o.footLeft ? '<div class="sub" style="margin-top:22px">' + o.footLeft + '</div>' : '')
    + '</div><div id="tip"></div><script>'
    + tipRuntime(o.tips || [])
    + (o.script || '')
    + '<\/script></body></html>';
}

/**
 * 悬停明细运行时。TIPS 是「下标 → 明细对象」的扁平数组，DOM 里只存 data-tipkey，
 * 所以表格里放几万行也不会把 HTML 撑大。
 */
function tipRuntime(TIPS) {
  return 'var TIPS=' + JSON.stringify(TIPS || []) + ';'
    + 'var tipEl=document.getElementById("tip");'
    + 'function cell(cls,txt){var d=document.createElement("div");d.className="tc "+cls;d.textContent=txt||"";return d;}'
    + 'function fillTip(t){'
    + '  var g=document.createElement("div"),i;'
    + '  if(t.k==="legs"){'
    + '    g.className="tg";'
    + '    (t.rows||[]).forEach(function(r){'
    + '      var cls=["t","","m","c","x"];'
    + '      for(i=0;i<5;i++) g.appendChild(cell(cls[i],r[i]));});'
    + '  } else {'
    + '    g.className="tg "+(t.k==="snow"?"snow":"cost");'
    + '    (t.rows||[]).forEach(function(r){'
    + '      var ex=r[3]||"";'
    + '      if(ex){'
    + '        var d=document.createElement("div");d.className="tc rowline "+ex;'
    + '        var a=document.createElement("span");a.textContent=r[0];'
    + '        var b=document.createElement("span");b.textContent=r[2];'
    + '        d.appendChild(a);d.appendChild(b);g.appendChild(d);'
    + '      } else {'
    + '        g.appendChild(cell("",r[0]));g.appendChild(cell(t.k==="snow"?"m":"n",r[1]));g.appendChild(cell("c",r[2]));}'
    + '    });}'
    + '  tipEl.innerHTML="";tipEl.appendChild(g);}'
    + 'document.querySelectorAll("[data-tipkey]").forEach(function(el){'
    + '  el.addEventListener("mouseenter",function(){fillTip(TIPS[+el.dataset.tipkey]||{k:"legs",rows:[]});tipEl.style.opacity=1;});'
    + '  el.addEventListener("mousemove",function(ev){'
    + '    var w=tipEl.offsetWidth,h=tipEl.offsetHeight;'
    + '    var left=Math.min(ev.clientX+14,window.innerWidth-w-12);'
    + '    var top=ev.clientY-h-12<8?ev.clientY+18:ev.clientY-h-12;'
    + '    tipEl.style.left=left+"px";tipEl.style.top=top+"px";});'
    + '  el.addEventListener("mouseleave",function(){tipEl.style.opacity=0;});});';
}

/** 年假徽标：0 绿 / 0.5 琥珀 / 其余蓝，与 .b0 .bh .b1 对应 */
const badge = (v) => '<span class="bg b' + String(v).replace('.', 'h') + '">' + v + ' 天</span>';

/**
 * 趋势折线图（纯 SVG，不引图表库）。
 *
 * 三项单位不同（¥/雪日、h、¥），塞进一根真实纵轴会互相压扁到看不出趋势，
 * 所以画在同一块画布上、每项各自按自己的区间铺满整高：斜率可比，高低不可比。
 * 真实数值放在图例的「起点 → 终点」和右端标签里，不在每个点上堆数字。
 *
 * @param {object} o
 * @param {Array}  o.pts    [{b}]，按档位顺序
 * @param {Array}  o.series [{name,color,v:(p)=>number,f:(x)=>string}]
 * @param {string} o.head   左上角标题
 * @param {string} o.foot   底部说明
 * @param {function} o.xLabel 横轴标签，默认 p.b + ' 天'
 */
function trendChart(o) {
  const pts = (o.pts || []).map((p, i) => Object.assign({ i: i }, p));
  if (!pts.length || pts.some((p) => !p)) return '';
  const SERIES = o.series;
  const xLabel = o.xLabel || ((p) => p.b + ' 天');

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
  const lab = (l, xx, anchor) => '<text x="' + xx + '" y="' + (l.y + 3.2).toFixed(1) + '" font-size="9.5"'
    + (anchor === 'end' ? ' text-anchor="end"' : '') + ' fill="' + l.c + '">' + l.v + '</text>';
  const startLabels = spread(rows.map((r) => ({ y: r.startY, v: r.startV, c: r.se.color })))
    .map((l) => lab(l, PL - 9, 'end')).join('');
  const endLabels = spread(rows.map((r) => ({ y: r.endY, v: r.endV, c: r.se.color })))
    .map((l) => lab(l, PR + 9)).join('');

  const xs = pts.map((p, i) => '<text x="' + x(i).toFixed(1) + '" y="' + (H - 8)
    + '" text-anchor="middle" font-size="10" fill="#6b7280">' + xLabel(p) + '</text>').join('');

  const legend = rows.map((r) => '<span><i style="background:' + r.se.color + '"></i>'
    + r.se.name + ' <b>' + r.startV + '</b>\u2192<b>' + r.endV + '</b></span>').join('');

  return '<div class="chartbox">'
    + '<div class="chead"><span class="ct2">' + o.head + '</span><span class="lg">' + legend + '</span></div>'
    + '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + (o.aria || o.head) + '">'
    + grid + rows.map((r) => '<path d="' + r.d + '" fill="none" stroke="' + r.se.color
      + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' + r.dots).join('')
    + endLabels + startLabels + xs + '</svg>'
    + '<div class="cfoot">' + o.foot + '</div>'
    + '</div>';
}

module.exports = { css, esc, sec, steps, stats, notes, warn, page, tipRuntime, badge, trendChart };
