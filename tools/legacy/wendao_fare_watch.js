#!/usr/bin/env node
'use strict';
/**
 * wendao_fare_watch.js — 携程问道「票面价」小时巡检 + 本地补税
 *
 * 为什么这么设计：问道给不出税费分项（实测明确回复「工具未返回该价格是否
 * 已含税费的分项明细」），但它给票面价是稳的。所以这里只让它出票面价，
 * 含税总价由本地按航段累加：
 *
 *     tax = PER_SEG × 航段数        （直飞 1 段 = 140，1 次中转 2 段 = 280）
 *     含税总价 = 票面价 + tax
 *
 * PER_SEG 取 140 = 机建 50 + 长航线燃油 90，与项目里其他报告同一口径，
 * 便于横向比。注意短航段（如 AAT→URC 约 500km）燃油实际只有 ¥20 上下，
 * 所以中转方案的估算值通常偏高 ¥60–120，报告里会注明。
 *
 * 用法：
 *   node tools/wendao_fare_watch.js
 *   node tools/wendao_fare_watch.js --per-seg 70     # 换成短段口径
 *   node tools/wendao_fare_watch.js --dry            # 只打印不落盘
 *
 * 产物：
 *   out/fare-watch/fares.csv     **主表**：长表结构，每次追加、按 (时间,航班组合) 去重
 *   out/fare-watch/latest.md     最近一次的可读报告
 *   out/fare-watch/history.jsonl 每次一行原始结构，用于看价格漂移
 *   out/fare-watch/raw/<ts>.txt  原始返回，解析失败时靠它排查
 */

const fs = require('fs');
const path = require('path');
const wendao = require(path.join(__dirname, '..', 'scripts', 'wendao.js'));

const OUT_DIR = path.join(__dirname, '..', 'out', 'fare-watch');
const RAW_DIR = path.join(OUT_DIR, 'raw');
const HISTORY = path.join(OUT_DIR, 'history.jsonl');
const LATEST = path.join(OUT_DIR, 'latest.md');
const FARES = path.join(OUT_DIR, 'fares.csv');

const CSV_HEADER = [
  '查询时间', '航线', '出行日期', '航班组合', '中转城市', '航段数',
  '票面价', '税', '含税总价', '全程分钟', '到达', '方案标题',
];

const ROUTE = { from: '阿勒泰', to: '深圳', code: 'AAT→SZX', date: '2027-01-03', dateCN: '2027年1月3日' };

const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const PER_SEG = Number(argOf('--per-seg', 140));
const DRY = argv.includes('--dry');

// 只问票面价，主动把税费排除在问题之外——问了它也只回一句「无法拆分」。
const QUERY = `${ROUTE.dateCN}${ROUTE.from}飞${ROUTE.to}。
这一天能查到的方案都列一下，直飞和中转都要，只要票面价，税费不用管（我自己算）。

每个方案麻烦写成一段，里面包含：
- 每一段的航班号、几点起飞、几点落地、在哪个机场；
- 全程大概多少小时；
- 这个方案一个人的经济舱票面价多少元。

同一天不同中转城市的方案我都要看，别只挑最便宜的一两个给我。`;

// ---------- 解析 ----------
//
// 问道的排版每天都不一样，实测至少三种，必须都能切：
//   A. `**方案1（最快）｜经兰州中转，全程约8h20，票面价2420元**` + 正文
//   B. `### 经兰州中转（3套方案）` 分城市，下面 `方案1：…票面价2170元。第一段9C6620…`
//   C. 整段散文，没有「方案N」标记（多数是无库存时的兜底回答，本来就该解析出 0 条）
//
// 关键教训（2026-10-27 复盘）：**必须一个方案一行**。早期版本按「###」分块，
// 遇到 B 型排版会把一节里的 3–4 个方案并成一行 —— 航班号取并集（凭空多出航段、
// 税翻倍）、价格取最大值、耗时取最大值，三个错值拼在一起。现在按「方案N」切，
// 且块内**取第一个价格**而不是最大值。

const FLIGHT_RE = /(?<![A-Za-z0-9])([A-Z0-9]{2})(\d{3,4})(?![0-9])/g;
const PRICE_RE = /(\d{3,5})\s*元/g;
const SCHEME_START = /^\s*(?:[-*•]\s*)?\*{0,2}\s*(?:方案|组合)\s*[0-9一二三四五六七八九十]+/;

function flightNos(text) {
  const out = [];
  let m;
  FLIGHT_RE.lastIndex = 0;
  while ((m = FLIGHT_RE.exec(text))) {
    if (!/[A-Z]/.test(m[1])) continue;          // 纯数字不是航班号
    const no = m[1] + m[2];
    if (!out.includes(no)) out.push(no);
  }
  return out;
}

/** 取方案内**第一个**像票价的数字。取最大值会把「区间为2090元至3323元」这类汇总句读进来 */
function pickPrice(text) {
  let m, first = null, firstAny = null;
  PRICE_RE.lastIndex = 0;
  while ((m = PRICE_RE.exec(text))) {
    const v = Number(m[1]);
    if (v < 300) continue;                      // 过滤「机建 50 元」这类噪声
    const around = text.slice(Math.max(0, m.index - 24), m.index);
    if (/票面|票价|价格|经济舱/.test(around)) {
      if (first === null) first = v;
    } else if (firstAny === null) firstAny = v;
  }
  return first !== null ? first : firstAny;
}

/** 「全程…约 X 小时 Y 分」；不能用全段最大值——正文里「中转停留约 25 小时」会盖过全程 */
function pickTotalDuration(text) {
  const m = text.match(/全程[^0-9]{0,14}(\d+)\s*小时\s*(?:(\d+)\s*分)?/);
  return m ? Number(m[1]) * 60 + Number(m[2] || 0) : null;
}

const HUB_FIX = {
  兰州中川: '兰州', 西安咸阳: '西安', 乌鲁木齐地窝堡: '乌鲁木齐', 乌鲁木齐天山: '乌鲁木齐',
  成都天府: '成都', 重庆江北: '重庆', 杭州萧山: '杭州', 南京禄口: '南京',
};

function hubOf(text) {
  // 「经兰州中川中转」和「中转重庆江北」两种写法都有，少认一种就会让整列退化成「中转」
  let m = text.match(/经\s*([^\s，,。、；;）)]{2,6}?)\s*(?:中转|转机|换乘)/);
  if (!m) m = text.match(/中转\s*([^\s，,。、；;）)]{2,6})/);
  if (!m) return '';
  return HUB_FIX[m[1]] || m[1];
}

function arrLabel(text) {
  // 只认「1月N日…落地」这种紧贴落地的显式日期。`01-03` 是**出发日**不是到达日，
  // 拿它当到达日会把 1/4 到写成 1/3，宁可留空（全程列已经给了耗时）。
  const m = text.match(/1\s*月\s*(\d{1,2})\s*日[^。；;\n]{0,14}?(?:落地|到达|抵达)/);
  if (m) return '1/' + m[1] + ' 到';
  if (/第三天|第3天/.test(text)) return '1/5 到';
  if (/次日|第二天|第2天/.test(text)) return '次日到';
  if (/当天|当日|同日/.test(text)) return '当天到';
  return '';
}

/**
 * 把正文切成「一个方案一段」。实测排版至少五种，靠两条规则统一：
 *   1. 空行分段落，标题行（### / **加粗整行**）只用来更新「当前中转城市」；
 *   2. 段落自带价格 → 开一个新方案；段落无价 → 补进上一个方案（标题带价、正文写航段的排版）。
 * 这样 A「**方案N｜…票面价**」、B「### 经X中转 / 方案N：…」、D「**经X中转** / 散文段」、
 * E「### 直飞方案 / 南航 CZ9001：…」都能切成一方案一行。
 */
function splitSchemes(text) {
  const units = [];
  let hub = '';
  let cur = null;
  const flush = () => { if (cur) { units.push(cur); cur = null; } };
  const SKIP = /^(以上|综上|注意|提示|另外|如果|建议|实际|数据来源|具体|同日抵达的方案|以下|20\d\d年)/;

  const onHead = (h) => {
    const hh = hubOf(h);
    if (hh) hub = hh;
    else if (/直飞/.test(h)) hub = '直飞';
    // 「选型速览 / 推荐 / 总结」这类汇总标题不是方案，开了头会把下面整段对比并成一个巨型方案
    if (/选型|速览|推荐|总结|结论|对比|怎么选|如何选|一句话|说明/.test(h)) { flush(); return; }
    const isScheme = pickPrice(h) !== null || flightNos(h).length > 0;
    flush();
    if (isScheme) cur = { title: h, lines: [], hub: hubOf(h) || hub };
  };

  const onPara = (p) => {
    if (SKIP.test(p)) return;
    const hasPrice = pickPrice(p) !== null;
    if (!hasPrice) {
      if (cur) cur.lines.push(p);           // 补正文
      return;                               // 没有当前方案、又没有价 → 前言，丢
    }
    flush();
    cur = { title: p.split('\n')[0], lines: p.split('\n').slice(1), hub: hubOf(p) || hub };
    flush();                                 // 段落级方案：本段即完整方案
  };

  let buf = [];
  const flushBuf = () => {
    const text = buf.join('\n').trim();
    buf = [];
    if (!text) return;
    // 同一段落里可能粘着「方案N」或小结句（实测方案10 的正文与末尾小结之间没有空行），
    // 必须在段内再切一次，否则小结里的价格会被算到最后一个方案头上。
    const groups = [];
    let g = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      if (SKIP.test(t)) {
        if (g.length) { groups.push(g.join('\n')); g = []; }
        groups.push(t);                       // 交给 onPara 去丢
        continue;
      }
      if (SCHEME_START.test(t)) {
        if (g.length) { groups.push(g.join('\n')); g = []; }
        g = [t];
        continue;
      }
      g.push(t);
    }
    if (g.length) groups.push(g.join('\n'));
    for (const grp of groups) onPara(grp);
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) { flushBuf(); continue; }
    if (/^#{1,6}\s/.test(line) || /^\*\*[^*]+\*\*[：:]?$/.test(line)) {
      flushBuf();
      onHead(line.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim());
      continue;
    }
    buf.push(line);
  }
  flushBuf();
  flush();

  // 「标题带价、正文没价」被拆成两段时，把没航班号的那段并进下一段
  const merged = [];
  let pending = null;
  for (const u of units) {
    const full = u.title + '\n' + u.lines.join('\n');
    const own = pickPrice(u.title) !== null ? pickPrice(u.title) : pickPrice(u.lines.join('\n'));
    if (!flightNos(cleanForFlights(full)).length && own !== null) { pending = { u, own }; continue; }
    if (pending) {
      // 本段自己的价优先——否则导语段里的「票面价从 2170 元起」会盖掉真实报价
      if (own !== null) u.priceHint = own;
      u.title = pending.u.title + '｜' + u.title;
      u.hub = u.hub || pending.u.hub;
      pending = null;
    }
    merged.push(u);
  }
  return merged;
}

/** 兜底：整篇没有「方案N」标记时，按「标题块 + 含航班号的行」切（C 型排版） */
function splitByHeadings(text) {
  const blocks = [];
  let cur = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^\s*#{2,4}\s+\S/.test(line) || /^\s*\*\*[^*]+\*\*\s*$/.test(line)) {
      cur = { title: line.replace(/^[\s#*]+|[\s*]+$/g, ''), lines: [] };
      blocks.push(cur);
    } else if (cur) cur.lines.push(line);
    else { cur = { title: '', lines: [line] }; blocks.push(cur); }
  }
  return blocks;
}

/** 去掉「比同段 GS7558+SC2325 方案早出发…」这类对比从句，否则会把别的方案的航班号算进来 */
function cleanForFlights(text) {
  return text
    .split(/(?<=[。；;])|\n/)
    .filter((s) => !/^\s*(?:比|但|同样|相比|不过|较|另外|此外|如果|而|同时|只是)/.test(s))
    .join('\n');
}

function parse(text) {
  let segsList = splitSchemes(text);
  if (!segsList.some((s) => pickPrice(s.title + '\n' + s.lines.join('\n')) !== null)) {
    segsList = splitByHeadings(text);       // 退化成 C 型切法
  }

  const rows = [];
  const skipped = [];
  for (const s of segsList) {
    const body = s.lines.join('\n');
    const full = s.title + '\n' + body;
    const nos = flightNos(cleanForFlights(full));
    const fare = s.priceHint != null ? s.priceHint
      : (pickPrice(s.title) !== null ? pickPrice(s.title) : pickPrice(body));
    if (!nos.length || fare === null) continue;
    // 一段航程最多 2 次中转 = 3 段；再多说明这段其实是「多个方案并列」的汇总，丢掉
    if (nos.length > 3) { skipped.push(nos.join('+')); continue; }
    const segs = nos.length;
    const tax = PER_SEG * segs;
    // 中转城市由段数反推：「直飞」只可能是 1 段；2 段以上若还挂着「直飞」标签，
    // 说明是从「### 直飞方案」小节标题继承下来的，必须改回真实中转城市
    let hub = s.hub || hubOf(full);
    if (segs === 1) hub = '直飞';
    else if (!hub || hub === '直飞') hub = hubOf(full) || '中转';
    rows.push({
      flights: nos,
      segs,
      fare,
      tax,
      total: fare + tax,
      durationMin: pickTotalDuration(full),
      arrive: arrLabel(full),
      hub,
      title: s.title.slice(0, 60),
    });
  }
  if (skipped.length) {
    console.error(`[解析] 丢弃 ${skipped.length} 段航段数 >3 的汇总块：${skipped.join(' | ').slice(0, 200)}`);
  }

  // 同一组航班号只留最便宜的一条
  const seen = new Map();
  for (const r of rows) {
    const key = r.flights.join('+');
    if (!seen.has(key) || seen.get(key).fare > r.fare) seen.set(key, r);
  }
  return [...seen.values()].sort((a, b) =>
    a.total - b.total || (a.durationMin || 1e9) - (b.durationMin || 1e9));
}

// ---------- 输出 ----------

const fmtDur = (m) => (m == null ? '—' : Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0'));
const money = (v) => '¥' + v.toLocaleString('en-US');

function loadPrev() {
  try {
    const lines = fs.readFileSync(HISTORY, 'utf8').trim().split('\n').filter(Boolean);
    if (!lines.length) return null;
    return JSON.parse(lines[lines.length - 1]);
  } catch (e) { return null; }
}

function render(rows, meta, prev) {
  const prevBy = new Map();
  if (prev && Array.isArray(prev.rows)) for (const r of prev.rows) prevBy.set(r.flights.join('+'), r);

  const L = [];
  L.push(`# 携程问道 · 票面价巡检　${ROUTE.code}　${ROUTE.date}`);
  L.push('');
  L.push(`> 查询时间 ${meta.at}　·　口径：**问道票面价 + 本地补税**`);
  L.push(`> 税 = ¥${PER_SEG} × 航段数（直飞 1 段 ${money(PER_SEG)}，一次中转 2 段 ${money(PER_SEG * 2)}）`);
  L.push('');
  if (!rows.length) {
    L.push(meta.state === 'no_inventory'
      ? '**本次问道无库存**（原文「暂未检索到…航班数据」）——不是解析失败，原始返回见 `raw/`。'
      : '**本次未解析到任何报价**（疑似解析失败或返回异常）——原始返回见 `raw/`。');
    return L.join('\n');
  }
  L.push('| # | 含税总价 | 票面 | 税 | 全程 | 到达 | 中转 | 航段 | 较上次 |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  rows.forEach((r, i) => {
    const p = prevBy.get(r.flights.join('+'));
    let delta = '—';
    if (p) {
      const d = r.total - p.total;
      delta = d === 0 ? '持平' : (d > 0 ? `+${d}` : `${d}`);
    }
    L.push(`| ${i + 1} | **${money(r.total)}** | ${money(r.fare)} | ${money(r.tax)} | ${fmtDur(r.durationMin)} | ${r.arrive || '—'} | ${r.hub || '—'} | ${r.flights.join('+')} | ${delta} |`);
  });
  L.push('');
  L.push('_估算说明：¥140/段 取「机建 50 + 长航线燃油 90」。AAT→URC 这类短段燃油实际约 ¥20，_');
  L.push('_所以中转方案的含税估算通常偏高 ¥60–120，真实到手价可能更低。_');
  L.push('_「到达」列只在问道原文写明「1月N日…落地」时填；`01-03` 是出发日不是到达日，不拿来推断。_');
  return L.join('\n');
}

// ---------- 主表：fares.csv ----------

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/** 追加到长表；已存在的 (查询时间, 航班组合) 不重复写，保证脚本重跑幂等 */
function appendFares(rows, meta) {
  const existing = new Set();
  if (fs.existsSync(FARES)) {
    const txt = fs.readFileSync(FARES, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      if (!line || line.startsWith('查询时间')) continue;
      // 前两列固定是「查询时间,航线,出行日期,航班组合」，用简单切分取键
      const cols = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || [];
      const cell = (i) => (cols[i] || '').replace(/,$/, '').replace(/^"|"$/g, '');
      existing.add(cell(0) + '\u0000' + cell(3));
    }
  }

  const isNew = !fs.existsSync(FARES) || fs.statSync(FARES).size === 0;
  const out = [];
  if (isNew) out.push(CSV_HEADER.join(','));
  for (const r of rows) {
    const key = meta.at + '\u0000' + r.flights.join('+');
    if (existing.has(key)) continue;
    out.push([
      meta.at, meta.route, meta.date, r.flights.join('+'), r.hub, r.segs,
      r.fare, r.tax, r.total, r.durationMin == null ? '' : r.durationMin,
      r.arrive, r.title,
    ].map(csvCell).join(','));
  }
  if (out.length) fs.appendFileSync(FARES, out.join('\n') + '\n', 'utf8');
  return out.length;
}

// ---------- 重建：用 raw/ 里的原始返回离线重算整张表 ----------

function rebuild() {
  const files = fs.readdirSync(RAW_DIR).filter((f) => f.endsWith('.txt')).sort();
  const hist = [];
  const csv = [CSV_HEADER.join(',')];
  let last = null;
  for (const f of files) {
    const m = f.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})\.txt$/);
    if (!m) continue;
    const at = `${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
    const text = fs.readFileSync(path.join(RAW_DIR, f), 'utf8');
    const rows = parse(text);
    const state = rows.length ? 'ok'
      : (/暂未检索到|未检索到|无法获取|暂无.{0,6}航班|未查到/.test(text) ? 'no_inventory' : 'parse_failed');
    const meta = { at, route: ROUTE.code, date: ROUTE.date, perSeg: PER_SEG, parsed: rows.length, state };
    hist.push(JSON.stringify({ ...meta, rows }));
    for (const r of rows) {
      csv.push([
        at, meta.route, meta.date, r.flights.join('+'), r.hub, r.segs,
        r.fare, r.tax, r.total, r.durationMin == null ? '' : r.durationMin,
        r.arrive, r.title,
      ].map(csvCell).join(','));
    }
    last = { rows, meta };
  }
  fs.writeFileSync(HISTORY, hist.join('\n') + '\n', 'utf8');
  fs.writeFileSync(FARES, csv.join('\n') + '\n', 'utf8');
  if (last) fs.writeFileSync(LATEST, render(last.rows, last.meta, hist.length > 1 ? JSON.parse(hist[hist.length - 2]) : null) + '\n', 'utf8');

  const n = hist.map((h) => JSON.parse(h).parsed);
  console.log(`重建完成：${files.length} 份原始返回 → 主表 ${csv.length - 1} 行`);
  console.log(`每次解析条数：${n.join(' ')}`);
  console.log(`其中 0 条 ${n.filter((x) => x === 0).length} 次，≥8 条 ${n.filter((x) => x >= 8).length} 次`);
  const bad = csv.slice(1).filter((l) => Number(l.split(',')[5]) > 2).length;
  console.log(`航段数 >2 的异常行：${bad}`);
}

// ---------- 主流程 ----------

(async () => {
  if (argv.includes('--rebuild')) { rebuild(); return; }   // 离线重算，零配额

  const dbgRaw = argOf('--units', null);                   // 调试：打印切出来的方案块
  if (dbgRaw) {
    const units = splitSchemes(fs.readFileSync(dbgRaw, 'utf8'));
    units.forEach((u, i) => {
      const full = u.title + '\n' + u.lines.join('\n');
      console.log(`--- #${i + 1} hub=${u.hub} 价=${pickPrice(u.title) ?? pickPrice(u.lines.join('\n'))} 航=${flightNos(cleanForFlights(full)).join('+')} 全程=${pickTotalDuration(full)}`);
      console.log('  title:', u.title.slice(0, 80));
      console.log('  body :', u.lines.join(' / ').slice(0, 120));
    });
    return;
  }

  const at = argOf('--at', null) || new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
  let raw;
  const rawFile = argOf('--from-raw', null);
  if (rawFile) {
    raw = fs.readFileSync(rawFile, 'utf8');   // 离线复算：不消耗问道配额
  } else {
    try {
      raw = await wendao.search(QUERY);
    } catch (e) {
      console.error(`[${at}] 问道调用失败：${e.kind || 'other'} / ${e.message}`);
      if (e.hint) console.error('提示：' + e.hint);
      process.exit(2);
    }
  }

  const rows = parse(raw);
  // 0 条要分清两种原因：问道当天没库存（它明说「暂未检索到」）vs 我们解析失败。
  // 混在一起会让「最低价上升」看起来像涨价，实际只是最便宜那档没返回。
  let state = 'ok';
  if (!rows.length) {
    state = /暂未检索到|未检索到|无法获取|暂无.{0,6}航班|未查到/.test(raw) ? 'no_inventory' : 'parse_failed';
  }
  const meta = { at, route: ROUTE.code, date: ROUTE.date, perSeg: PER_SEG, parsed: rows.length, state };
  const prev = loadPrev();
  const report = render(rows, meta, prev);

  if (!DRY) {
    fs.mkdirSync(RAW_DIR, { recursive: true });
    const stamp = at.replace(/[\/\s:]/g, '-').replace(/,/g, '');
    fs.writeFileSync(path.join(RAW_DIR, stamp + '.txt'), raw, 'utf8');
    fs.writeFileSync(LATEST, report + '\n', 'utf8');
    fs.appendFileSync(HISTORY, JSON.stringify({ ...meta, rows }) + '\n', 'utf8');
    const added = appendFares(rows, meta);
    console.log(`\n[表] ${FARES}　本次新增 ${added} 行`);
  }

  console.log(report);
  if (!rows.length) {
    console.log('\n--- 原始返回（前 1200 字）---\n' + raw.slice(0, 1200));
  }
})();
