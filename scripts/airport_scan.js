#!/usr/bin/env node
'use strict';
/**
 * airport_scan.js — 多机场预查：同一雪场、多个候选机场，一天样本票价 + 车程横向对比
 *
 * 用途：雪场附近常有多个机场可选（不同城市、不同车程、不同票价）。
 * 用同一天的票价和车程做一次对齐比较，把结果交给用户选，而不是替他选。
 *
 * 注意：本脚本走飞常准，每个候选机场城市对消耗 1 积分。
 * 主流程的机场粗筛改用携程问道（references/wendao-prompts.md 提示词 1）+ amap_route.js，
 * 不烧积分；只有用户明确要「精确预查」时才用本脚本。
 *
 * 用法：
 *   node airport_scan.js --resort "<雪场名称>" --from "<出发城市>" --date YYYY-MM-DD \
 *        --candidates "<机场1>|<城市1>;<机场2>|<城市2>" [--resort-city <城市>] \
 *        [--type direct|both] [--repeat 1] [--buffer-pct 20] [--buffer-min 15] \
 *        [--out <file>] [--no-cache | --refresh]
 *
 * key：AMAP_API_KEY 查车程（必需），VARIFLIGHT_MCP_KEY 查票价（缺失时只出车程）。
 *
 * 输出：JSON 数组，每个元素对应一个候选机场：
 *   { airport, city, distanceKm, driveMin, bufferPct, bufferMin, toResortMinutes,
 *     cheapest: {price, no, dep, arr, tag, seg, resortArrival} | null,
 *     earliestResortArrival, flightCount, error? }
 */

const fs = require('fs');
const { requireKey, textWidth, padEnd } = require('./keys');
const { routeInfo } = require('./amap');
const { queryFlights, token } = require('./variflight');

function die(msg, hint) {
  console.error('\u2716 ' + msg + (hint ? '\n  ' + hint : ''));
  process.exit(1);
}

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i > -1 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

const RESORT = getArg('resort');
const FROM = getArg('from');
const DATE = getArg('date');
const RAW_CANDIDATES = getArg('candidates');

if (!RESORT) die('缺少 --resort <雪场名称>');
if (!DATE || !/^\d{4}-\d{2}-\d{2}$/.test(DATE)) die('缺少 --date YYYY-MM-DD（用于对齐比较的样本日期）');
if (!RAW_CANDIDATES) {
  die('缺少 --candidates "<机场1>|<城市1>;<机场2>|<城市2>"',
    '城市可省略，写作 "<机场名称>" 也接受；用分号分隔多个候选机场。');
}

const CANDIDATES = RAW_CANDIDATES
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [airport, city] = s.split('|').map((x) => (x || '').trim());
    return { airport, city: city || '' };
  });
if (!CANDIDATES.length) die('--candidates 解析后为空');

const TYPE = getArg('type', 'direct');
if (!['direct', 'transfer', 'both'].includes(TYPE)) die('--type 只能是 direct / transfer / both');
const REPEAT = Math.max(1, Math.min(5, Number(getArg('repeat', 1)) || 1));
const BUFFER_PCT = Number(getArg('buffer-pct', 20));
const BUFFER_MIN = Number(getArg('buffer-min', 15));

// 查询结果按 (SQL) 缓存，重跑同一组候选机场不再重复扣分
const CACHE = {
  mode: args.includes('--no-cache') ? 'off' : args.includes('--refresh') ? 'refresh' : 'auto',
};

requireKey('AMAP_API_KEY');
const canQueryFares = Boolean(token());
if (!canQueryFares) {
  console.error('! 未配置飞常准 MCP Key，本次只输出车程，不含票价。');
} else {
  const calls = CANDIDATES.length;
  console.error('将发起最多 ' + calls + ' 次航班查询（每个候选机场一次；命中缓存的不扣积分）。');
}

const toMin = (hm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm || '');
  return m ? +m[1] * 60 + +m[2] : null;
};
const hhmm = (min) => {
  const m = ((min % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
};
const durText = (min) => (min >= 60 ? Math.floor(min / 60) + 'h' + String(min % 60).padStart(2, '0') : min + 'm');

(async () => {
  const rows = [];

  for (const c of CANDIDATES) {
    const row = {
      airport: c.airport,
      city: c.city || '',
      distanceKm: null,
      driveMin: null,
      bufferPct: BUFFER_PCT,
      bufferMin: BUFFER_MIN,
      toResortMinutes: null,
      cheapest: null,
      earliestResortArrival: null,
      flightCount: 0,
    };

    try {
      const r = await routeInfo({
        from: c.airport,
        fromCity: c.city,
        to: RESORT,
        toCity: getArg('resort-city'),
        bufferPct: BUFFER_PCT,
        bufferMin: BUFFER_MIN,
      });
      row.distanceKm = r.distanceKm;
      row.driveMin = r.driveMin;
      row.toResortMinutes = r.toResortMinutes;
    } catch (e) {
      row.error = e.message;
      console.error('  ' + c.airport + ' 车程查询失败：' + e.message);
    }

    if (canQueryFares && FROM) {
      try {
        const { flights: all } = await queryFlights({
          sources: [{ from: FROM, to: c.city || c.airport, date: DATE }],
          perTransfer: TYPE === 'direct' ? 0 : 20,
          chunk: 3,
          cache: CACHE,
          log: () => {},
        });
        const flights = TYPE === 'direct' ? all.filter((f) => f.seg === 1)
          : TYPE === 'transfer' ? all.filter((f) => f.seg > 1)
            : all;
        row.flightCount = flights.length;
        if (flights.length) {
          const withArrival = flights.map((f) => ({
            ...f,
            resortArrivalMin: row.toResortMinutes == null
              ? null
              : toMin(f.arr) + (f.arrDate && f.arrDate !== f.date ? 1440 : 0) + row.toResortMinutes,
          }));
          const byPrice = [...withArrival].sort((a, b) => a.price - b.price)[0];
          row.cheapest = {
            price: byPrice.price,
            tax: byPrice.tax,
            total: byPrice.tax == null ? null : byPrice.price + byPrice.tax,
            no: byPrice.no,
            dep: byPrice.dep,
            arr: byPrice.arr,
            arrDate: byPrice.arrDate || byPrice.date,
            tag: byPrice.tag,
            seg: byPrice.seg,
            resortArrival: byPrice.resortArrivalMin == null ? null : hhmm(byPrice.resortArrivalMin),
          };
          const earliest = withArrival
            .filter((f) => f.resortArrivalMin != null)
            .sort((a, b) => a.resortArrivalMin - b.resortArrivalMin)[0];
          if (earliest) {
            row.earliestResortArrival = hhmm(earliest.resortArrivalMin);
            row.earliestFlight = { no: earliest.no, dep: earliest.dep, arr: earliest.arr };
          }
        }
      } catch (e) {
        row.error = row.error ? row.error + ' / ' + e.message : e.message;
        console.error('  ' + c.airport + ' 票价查询失败：' + e.message);
      }
    }

    rows.push(row);
    console.error('  \u2713 ' + c.airport + (row.toResortMinutes == null ? '' : ' 车程 ' + durText(row.toResortMinutes))
      + (row.cheapest ? ' 最低 ¥' + row.cheapest.price : ''));
  }

  // 有票价的排前面，按票价升序，其次按车程升序
  rows.sort((a, b) => {
    const pa = a.cheapest ? a.cheapest.price : Infinity;
    const pb = b.cheapest ? b.cheapest.price : Infinity;
    if (pa !== pb) return pa - pb;
    return (a.toResortMinutes == null ? Infinity : a.toResortMinutes)
      - (b.toResortMinutes == null ? Infinity : b.toResortMinutes);
  });

  console.error('');
  const head = ['机场', '车程(含预留)', '最低票价', '进场时刻', '班次'];
  const body = rows.map((r) => [
    r.airport,
    r.toResortMinutes == null ? '—' : durText(r.toResortMinutes),
    r.cheapest ? '¥' + r.cheapest.price + ' ' + r.cheapest.no : '—',
    r.cheapest ? r.cheapest.resortArrival : '—',
    r.flightCount ? String(r.flightCount) : '—',
  ]);
  const widths = head.map((h, i) => Math.max(textWidth(h), ...body.map((b) => textWidth(b[i]))) + 2);
  const line = (cells) => cells.map((c, i) => padEnd(c, widths[i])).join('');
  console.error(line(head));
  body.forEach((b) => console.error(line(b)));

  const json = JSON.stringify({
    date: DATE,
    from: FROM || '',
    resort: RESORT,
    type: TYPE,
    repeat: REPEAT,
    note: 'price 为民航票面价，tax 为机建+燃油，total 为两者之和；请让用户基于车程与票价自行选择，不要代为决定。',
    airports: rows,
  }, null, 1);

  if (getArg('out')) {
    fs.writeFileSync(getArg('out'), json, 'utf8');
    console.error('\u2713 结果 → ' + getArg('out'));
  } else {
    process.stdout.write(json + '\n');
  }
})().catch((e) => die(e.message, e.hint));
