'use strict';
/**
 * holidays.js — 中国法定节假日与调休日历
 *
 * 年假计算只认「这天用不用上班」。graphcore 原来的判断是硬编码的
 * `wd === 0 || wd === 6`，碰上元旦、春节这种把假期摊到工作日、又把周末拉来补班的
 * 安排就会两头算错：1/1 落在周五时被当成工作日（多算 1 天假），
 * 而被调休占用的周六又被当成休息日（少算 1 天假）。
 *
 * 本模块只做一件事：回答「某一天对上班族来说是休息日还是工作日」。
 * 数据分三档，报告里会如实标出来源：
 *
 *   official  国务院办公厅已发文，逐日精确
 *   inferred  官方未公布，按近年惯例推算（目前只推元旦，理由见 inferNewYear）
 *   override  case.json 里 params.holidays / params.workdays 手工指定，优先级最高
 *
 * 为什么只推元旦：元旦是唯一一个「公历固定、不依赖农历、不依赖节气」的节日，
 * 连休与调休规则可以从星期几直接推出来。春节、端午、中秋要走农历，
 * 清明要走节气，没有农历表就只能瞎猜 —— 猜错比不猜更糟，所以宁可留空并告警。
 */

const DAY_MS = 86400000;
const dayNum = (s) => Math.floor(Date.parse(String(s).slice(0, 10) + 'T00:00:00Z') / DAY_MS);
const dateStr = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const wdOf = (n) => new Date(n * DAY_MS).getUTCDay();
const WD_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 展开 [from, to] 闭区间为 dayNum 列表 */
const span = (from, to) => {
  const a = dayNum(from), b = dayNum(to), out = [];
  for (let d = a; d <= b; d++) out.push(d);
  return out;
};

// ---------------------------------------------------------------- 已公布安排
/**
 * 逐条抄自国务院办公厅通知，勿凭印象改。新增年份时把通知号与日期一起记下，
 * 报告里的「数据来源」直接引用这两个字段。
 */
const PUBLISHED = {
  2026: {
    doc: '国办发明电〔2025〕7号',
    publishedAt: '2025-11-04',
    periods: [
      { name: '元旦', from: '2026-01-01', to: '2026-01-03' },
      { name: '春节', from: '2026-02-15', to: '2026-02-23' },
      { name: '清明节', from: '2026-04-04', to: '2026-04-06' },
      { name: '劳动节', from: '2026-05-01', to: '2026-05-05' },
      { name: '端午节', from: '2026-06-19', to: '2026-06-21' },
      { name: '中秋节', from: '2026-09-25', to: '2026-09-27' },
      { name: '国庆节', from: '2026-10-01', to: '2026-10-07' },
    ],
    workdays: [
      '2026-01-04', '2026-02-14', '2026-02-28',
      '2026-05-09', '2026-09-20', '2026-10-10',
    ],
  },
};

// ---------------------------------------------------------------- 惯例推算
/**
 * 元旦连续放假规则（近十年惯例，逐例反推出来的）：
 *
 *   1/1 周五 → 周五～周日连休 3 天，不调休              （2021、2027）
 *   1/1 周六 → 周六～周一连休 3 天，不调休              （2022）
 *   1/1 周日 → 周六～周一连休 3 天，不调休              （2023 实际为 12/31–1/2）
 *   1/1 周一 → 周六～周一连休 3 天，不调休              （2024 实际为 12/30–1/1）
 *   1/1 周二 → 周日～周二连休 3 天 + 前一个周六补班     （2019 实际为 12/30–1/1，12/29 上班）
 *   1/1 周三 → 只放当天 1 天，不调休                    （2020、2025）
 *   1/1 周四 → 周四～周六连休 3 天 + 周日补班           （2026 实际为 1/1–1/3，1/4 上班）
 *
 * 周三单独成例的原因：向前够不到上个周末、向后会撞上下一周的开工日，
 * 硬凑 3 天要连调两次休，近年都放弃了。
 */
function inferNewYear(year) {
  const d = dayNum(year + '-01-01');
  const w = wdOf(d);
  switch (w) {
    case 5: return { from: d, to: d + 2, workdays: [] };                 // 周五
    case 6: return { from: d, to: d + 2, workdays: [] };                 // 周六
    case 0: return { from: d - 1, to: d + 1, workdays: [] };             // 周日
    case 1: return { from: d - 2, to: d, workdays: [] };                 // 周一
    case 2: return { from: d - 2, to: d, workdays: [d - 3] };            // 周二
    case 3: return { from: d, to: d, workdays: [] };                     // 周三
    default: return { from: d, to: d + 2, workdays: [d + 3] };           // 周四
  }
}

/** 未公布年份：只推元旦，其余节日列进 missing 交给报告告警 */
const LUNAR_FESTIVALS = ['春节', '清明节', '劳动节', '端午节', '中秋节', '国庆节'];

function inferYear(year) {
  const ny = inferNewYear(year);
  return {
    doc: null,
    publishedAt: null,
    periods: [{ name: '元旦', from: dateStr(ny.from), to: dateStr(ny.to), inferred: true }],
    workdays: ny.workdays.map(dateStr),
    missing: LUNAR_FESTIVALS.slice(),
  };
}

// ---------------------------------------------------------------- 解析入口
/**
 * 把 case.json 里的日历参数解析成 graphcore 要的集合。
 *
 * @param {object} o
 *   o.years     {number[]}  需要覆盖的年份（一般取 case.dates 跨的年份）
 *   o.calendar  {string}    'CN' 时启用内置日历；不写则完全不考虑法定假（旧行为）
 *   o.holidays  {string[]}  手工追加的休息日，优先级高于内置数据
 *   o.workdays  {string[]}  手工追加的调休上班日，优先级最高
 * @returns {{set:{holidays:Set<number>,workdays:Set<number>}, periods:object[],
 *            workdayList:object[], sources:string[], warnings:string[], enabled:boolean}}
 */
function resolve(o) {
  const opt = o || {};
  const years = (opt.years || []).filter((y) => Number.isFinite(y)).sort();
  const enabled = Boolean(opt.calendar === 'CN'
    || (opt.holidays && opt.holidays.length)
    || (opt.workdays && opt.workdays.length));

  const holidays = new Set();
  const workdays = new Set();
  const periods = [];
  const sources = [];
  const warnings = [];

  if (opt.calendar === 'CN') {
    const spanYears = [];
    for (let y = years[0]; y <= years[years.length - 1]; y++) spanYears.push(y);
    for (const y of spanYears) {
      if (!Number.isFinite(y)) continue;
      const pub = PUBLISHED[y];
      const rec = pub || inferYear(y);
      for (const p of rec.periods) {
        for (const d of span(p.from, p.to)) holidays.add(d);
        periods.push({ ...p, year: y, source: pub ? 'official' : 'inferred' });
      }
      for (const w of rec.workdays) workdays.add(dayNum(w));
      if (pub) {
        sources.push(`${y} 年：${pub.doc}（${pub.publishedAt} 发布）`);
      } else {
        sources.push(`${y} 年：官方通知尚未发布，按近年惯例推算（仅元旦）`);
        if (rec.missing && rec.missing.length) {
          warnings.push(`${y} 年的 ${rec.missing.join('、')} 未推算（依赖农历/节气，需补官方安排）。`
            + ' 行程若落在这些假期，请用 params.holidays 手工指定。');
        }
      }
    }
  }

  // 手工指定覆盖一切：先加 holidays，再加 workdays（workdays 优先级更高，冲突时以它为准）
  for (const h of opt.holidays || []) holidays.add(dayNum(h));
  for (const w of opt.workdays || []) workdays.add(dayNum(w));
  if ((opt.holidays || []).length || (opt.workdays || []).length) {
    sources.push('手工指定：params.holidays / params.workdays');
  }

  // 手工指定的放假日也要建 period：describe() 只遍历 periods，不建的话报告
  // 口径区会把「春节」显示成「窗口内无法定假」——2027 春节实报踩过。
  // 连续日期并成一段，name 取 params.holidaysLabel，缺省「指定假期」。
  {
    const days = [...new Set((opt.holidays || []).map(dayNum))].sort((a, b) => a - b);
    let from = null, to = null;
    const push = () => {
      if (from === null) return;
      periods.push({
        name: opt.holidaysLabel || '指定假期',
        from: dateStr(from), to: dateStr(to),
        year: Number(dateStr(from).slice(0, 4)),
        source: 'manual',
      });
    };
    for (const d of days) {
      if (from === null) { from = to = d; continue; }
      if (d === to + 1) { to = d; continue; }
      push(); from = to = d;
    }
    push();
  }

  // 同一天既标放假日又标上班日 → 以上班日为准，并告警
  for (const w of workdays) {
    if (holidays.has(w)) {
      holidays.delete(w);
      warnings.push(dateStr(w) + ' 同时出现在 holidays 与 workdays，按调休上班处理。');
    }
  }

  return {
    enabled,
    set: { holidays, workdays },
    periods: periods.sort((a, b) => dayNum(a.from) - dayNum(b.from)),
    workdayList: [...workdays].sort((a, b) => a - b).map((d) => ({ date: dateStr(d), wd: WD_CN[wdOf(d)] })),
    sources,
    warnings,
  };
}

/** 「1/1–1/3」这样的短标签，给报告用（月与日都去前导零） */
function shortLabel(p) {
  const fmt = (s) => {
    const [, m, d] = String(s).split('-');
    return Number(m) + '/' + Number(d);
  };
  const f = fmt(p.from), t = fmt(p.to);
  return f === t ? f : f + '–' + t;
}

/** 渲染成一句话，塞进报告口径区 */
function describe(cal, fromDate, toDate) {
  if (!cal || !cal.enabled) return null;
  const inWin = (p) => {
    const pf = dayNum(p.from), pt = dayNum(p.to);
    return pt >= dayNum(fromDate) && pf <= dayNum(toDate);
  };
  const list = cal.periods.filter(inWin).map((p) =>
    `${p.name} ${shortLabel(p)}（${p.source === 'official' ? '官方'
      : (p.source === 'manual' ? '手工指定' : '推定')}）`);
  const wds = cal.workdayList.filter((w) => w.date >= fromDate && w.date <= toDate);
  return {
    holidays: list,
    workdays: wds.map((w) => `${w.date.slice(5).replace('-', '/')} ${w.wd}`),
  };
}

module.exports = {
  PUBLISHED, resolve, describe, shortLabel,
  inferNewYear, inferYear,
  dayNum, dateStr, wdOf, WD_CN, span,
};
