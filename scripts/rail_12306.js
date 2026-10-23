#!/usr/bin/env node
'use strict';
/**
 * rail_12306.js — 12306 高铁时刻查询客户端（带 1 QPS 节流）
 *
 * 为什么单独一个文件：12306 没有公开 API，可用的三个接口限制完全不同。
 *
 *   leftTicket/queryG        有票查询。**限流**：连发几条就 302 到 error.html，
 *                            按 IP + CDN 节点封 20–40 分钟，换 cookie 不解封。
 *   search/v1/train/search   车次查 train_no。不限流。
 *   czxx/queryByTrainNo      逐站时刻。不限流。
 *
 * 所以默认走「search + queryByTrainNo」这条不限流的路；leftTicket 只用来做一次性的
 * 票量确认，且**所有**请求都过同一个 1 QPS 节流阀（--qps 可调）。
 *
 * 两个必须记住的坑：
 *
 *   1. 被封时若客户端自动跟随 302，拿到的是 HTTP 200 + HTML 正文，不是 4xx。
 *      所以 fetch 一律 redirect: 'manual'，再判 body 是否以 '{' 开头。
 *   2. 返回空 body ≠ 被封。超出 15 天预售期时 leftTicket 就是返回空，
 *      别误判成限流然后重试，那只会把封禁坐实。
 *
 * 用法：
 *   node scripts/rail_12306.js --list QIP IZP 2026-11-06
 *   node scripts/rail_12306.js --verify G7831,G7833,G7835 --from QIP --to IZP --date 2026-11-06
 *   node scripts/rail_12306.js --stops G7831 --date 2026-11-06
 *   node scripts/rail_12306.js --codes 清河 太子城 北京北
 */

const { cacheDir } = require('./cache');
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const DEFAULT_QPS = 1;
const PRESALE_DAYS = 15;

const STATION_JS = 'https://kyfw.12306.cn/otn/resources/js/framework/station_name.js';
const INIT_URL = 'https://kyfw.12306.cn/otn/leftTicket/init';
const LEFT_TICKET = 'https://kyfw.12306.cn/otn/leftTicket/queryG';
const TRAIN_SEARCH = 'https://search.12306.cn/search/v1/train/search';
const TRAIN_STOPS = 'https://kyfw.12306.cn/otn/czxx/queryByTrainNo';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RailError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'RailError';
    this.kind = kind || 'error';
  }
}

/**
 * 节流阀：保证相邻两次请求的**发起**间隔不小于 minIntervalMs。
 * 1 QPS 意味着 minIntervalMs = 1000。第一次调用不等待。
 */
function createThrottle(minIntervalMs) {
  let last = 0;
  return async function waitTurn() {
    const gap = Date.now() - last;
    if (last && gap < minIntervalMs) await sleep(minIntervalMs - gap);
    last = Date.now();
  };
}

/** 12306 要 YYYYMMDD，case/config 里习惯写 YYYY-MM-DD */
const ymd = (date) => String(date).replace(/-/g, '');

function presaleInfo(date, now) {
  const today = now || new Date();
  const t = Date.parse(date + 'T00:00:00+08:00');
  if (Number.isNaN(t)) throw new RailError('日期格式应为 YYYY-MM-DD：' + date, 'date');
  const days = Math.floor((t - today.getTime()) / 86400000);
  return { days, open: days >= 0 && days <= PRESALE_DAYS };
}

/**
 * @param {object} opts
 *   qps        每秒请求数，默认 1（= 至少 1000ms 间隔）
 *   fetchImpl  注入用，测试里换成假的
 *   retries    遇到限流时的重试次数，默认 2
 *   backoffMs  首次退避时长，默认 30000，之后翻倍
 */
function createClient(opts) {
  const o = opts || {};
  const qps = o.qps == null ? DEFAULT_QPS : Number(o.qps);
  if (!(qps > 0)) throw new RailError('qps 必须大于 0', 'args');
  const minIntervalMs = Math.ceil(1000 / qps);
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  const retries = o.retries == null ? 2 : o.retries;
  const backoffMs = o.backoffMs == null ? 30000 : o.backoffMs;
  const waitTurn = createThrottle(minIntervalMs);

  const stats = { requests: 0, blocked: 0, waitedMs: 0 };
  let cookie = '';
  let stationCache = null;

  function absorbCookie(res) {
    const raw = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
    if (!raw.length) return;
    const pairs = raw.map((c) => String(c).split(';')[0].trim()).filter(Boolean);
    if (pairs.length) cookie = pairs.join('; ');
  }

  async function rawGet(url, headers) {
    const t0 = Date.now();
    await waitTurn();
    stats.requests += 1;
    const res = await fetchImpl(url, {
      redirect: 'manual',
      headers: Object.assign({ 'User-Agent': UA, 'Accept': 'application/json, text/javascript, */*; q=0.01' }, headers || {}),
    });
    stats.waitedMs += Date.now() - t0;
    return res;
  }

  /**
   * 限流的唯一表现就是「302 到 error.html」或「body 不是 JSON」。
   * 两种情况都归成 blocked，交给上层退避。
   */
  async function getJson(url, headers, label) {
    let attempt = 0;
    let delay = backoffMs;
    for (;;) {
      const res = await rawGet(url, headers);
      const status = res.status;
      if (status >= 300 && status < 400) {
        stats.blocked += 1;
        if (attempt >= retries) {
          throw new RailError('被 12306 限流（' + status + ' → ' + (res.headers.get('location') || '') + '）'
            + '，已重试 ' + attempt + ' 次。' + label + ' 建议改用 --verify（不限流接口）。', 'blocked');
        }
        attempt += 1;
        await sleep(delay);
        delay *= 2;
        continue;
      }
      const text = await res.text();
      if (!text.trimStart().startsWith('{')) {
        stats.blocked += 1;
        if (attempt >= retries) {
          throw new RailError('返回的不是 JSON（多半是 302 跟到了错误页），按限流处理。' + label, 'blocked');
        }
        attempt += 1;
        await sleep(delay);
        delay *= 2;
        continue;
      }
      return JSON.parse(text);
    }
  }

  /** 站名 → 电报码。station_name.js 只在首次拉一次，落盘到缓存目录 */
  async function stations() {
    if (stationCache) return stationCache;
    const file = cacheDir() ? path.join(cacheDir(), 'rail-stations.json') : '';
    if (file && fs.existsSync(file)) {
      try {
        const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (cached && cached.updatedAt && Object.keys(cached.byName || {}).length) {
          stationCache = cached.byName;
          return stationCache;
        }
      } catch { /* 缓存坏了就重拉，不值得报错 */ }
    }
    const res = await rawGet(STATION_JS);
    const text = await res.text();
    if (!text.includes('@')) throw new RailError('station_name.js 内容异常，拿不到站码表', 'stations');
    const byName = {};
    for (const chunk of text.split('@')) {
      const p = chunk.split('|');
      if (p.length >= 4 && p[1]) byName[p[1]] = p[2];
    }
    stationCache = byName;
    if (file) {
      try { fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date().toISOString(), byName }, null, 0)); } catch { /* 不可写就算了 */ }
    }
    return byName;
  }

  async function codeOf(name) {
    if (/^[A-Z]{3}$/.test(name)) return name;
    const map = await stations();
    if (!map[name]) throw new RailError('认不出站名：' + name, 'station');
    return map[name];
  }

  /** 电报码 → 站名。verify 要按站名比对逐站结果 */
  async function nameOf(code) {
    if (!/^[A-Z]{3}$/.test(code)) return code;
    const map = await stations();
    for (const [name, c] of Object.entries(map)) if (c === code) return name;
    throw new RailError('认不出电报码：' + code, 'station');
  }

  /** 车次号 → train_no（search 接口，不限流） */
  async function findTrain(code, date) {
    const j = await getJson(`${TRAIN_SEARCH}?keyword=${encodeURIComponent(code)}&date=${ymd(date)}`, null, '查车次 ' + code);
    if (!j.data || !j.data.length) return null;
    return j.data[0];
  }

  /**
   * 逐站时刻（queryByTrainNo，不限流）。
   * 两个 telecode 参数只是提示，接口一律返回全列停站，所以传什么都行。
   */
  async function stops(trainNo, date) {
    const j = await getJson(`${TRAIN_STOPS}?train_no=${trainNo}&from_station_telecode=IZP`
      + `&to_station_telecode=VAP&depart_date=${date}`, null, '查逐站 ' + trainNo);
    if (!j.data || !j.data.data) return [];
    return j.data.data.map((s) => ({
      station: s.station_name,
      arr: s.arrive_time === '----' ? null : s.arrive_time,
      dep: s.start_time === '----' ? null : s.start_time,
    }));
  }

  /** 有票查询（leftTicket，限流）。返回该方向当天所有车次 */
  async function listTrains(from, to, date) {
    const pre = presaleInfo(date);
    if (!pre.open) {
      throw new RailError(`预售期外（距今天 ${pre.days} 天，窗口 ${PRESALE_DAYS} 天）：接口只会返回空，`
        + '请换成预售期内的同星期几的日期取时刻表', 'presale');
    }
    const fromCode = await codeOf(from);
    const toCode = await codeOf(to);
    if (!cookie) {
      const res = await rawGet(INIT_URL);
      absorbCookie(res);
      await res.text();
    }
    const j = await getJson(`${LEFT_TICKET}?leftTicketDTO.train_date=${date}`
      + `&leftTicketDTO.from_station=${fromCode}&leftTicketDTO.to_station=${toCode}&purpose_codes=ADULT`,
    { Referer: INIT_URL, Cookie: cookie }, '有票查询');
    if (!j.data || !j.data.result) return [];
    const seen = new Set();
    const out = [];
    for (const row of j.data.result) {
      const p = row.split('|');
      const key = p[3] + p[8];
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        code: p[3], dep: p[8], arr: p[9], dur: p[10],
        from: (j.data.map || {})[p[6]] || p[6],
        to: (j.data.map || {})[p[7]] || p[7],
      });
    }
    return out;
  }

  /**
   * 校验一批车次：只走 search + queryByTrainNo，全程不碰 leftTicket。
   * 这是拿到可信时刻表的主路径——第三方（问道）给车次号，12306 给逐站时刻。
   */
  async function verify(codes, from, to, date) {
    const fromName = await nameOf(from);
    const toName = await nameOf(to);
    const rows = [];
    for (const code of codes) {
      const meta = await findTrain(code, date);
      if (!meta) { rows.push({ code, missing: true }); continue; }
      const all = await stops(meta.train_no, date);
      const a = all.find((s) => s.station === fromName);
      const b = all.find((s) => s.station === toName);
      rows.push({
        code,
        dep: a ? a.dep || a.arr : null,
        arr: b ? b.arr || b.dep : null,
        origin: all.length ? all[0].station : null,
        terminus: all.length ? all[all.length - 1].station : null,
        stops: all,
      });
    }
    return rows;
  }

  return { listTrains, verify, stops, findTrain, stations, codeOf, nameOf, stats, minIntervalMs };
}

// ---------------------------------------------------------------- CLI

function getArg(name, argv) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}

async function main(argv) {
  const qps = Number(getArg('qps', argv) || DEFAULT_QPS);
  const date = getArg('date', argv);
  const json = argv.includes('--json');
  const client = createClient({ qps });

  if (argv.includes('--codes')) {
    const names = argv.slice(argv.indexOf('--codes') + 1).filter((a) => !a.startsWith('--'));
    const map = await client.stations();
    for (const n of names) console.log(n + ' = ' + (map[n] || '(未收录)'));
    return;
  }

  if (argv.includes('--list')) {
    const i = argv.indexOf('--list');
    const from = argv[i + 1];
    const to = argv[i + 2];
    const d = argv[i + 3] || date;
    if (!from || !to || !d) throw new RailError('用法：--list <出发站> <到达站> <YYYY-MM-DD>', 'args');
    const rows = await client.listTrains(from, to, d);
    if (json) { console.log(JSON.stringify(rows, null, 2)); return; }
    console.log(`${from} → ${to}  ${d}  共 ${rows.length} 趟（qps=${qps}）`);
    for (const r of rows) console.log(`  ${r.code}  ${r.dep} → ${r.arr}  ${r.dur}`);
    return;
  }

  if (argv.includes('--stops')) {
    const i = argv.indexOf('--stops');
    const code = argv[i + 1];
    const d = argv[i + 2] || date;
    if (!code || !d) throw new RailError('用法：--stops <车次> <YYYY-MM-DD>', 'args');
    const meta = await client.findTrain(code, d);
    if (!meta) throw new RailError('查不到车次 ' + code, 'train');
    const all = await client.stops(meta.train_no, d);
    if (json) { console.log(JSON.stringify(all, null, 2)); return; }
    for (const s of all) console.log(`  ${s.station}  ${s.arr || ''} → ${s.dep || ''}`);
    return;
  }

  if (argv.includes('--verify')) {
    const i = argv.indexOf('--verify');
    const codes = String(argv[i + 1] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const from = getArg('from', argv);
    const to = getArg('to', argv);
    const d = date;
    if (!codes.length || !from || !to || !d) {
      throw new RailError('用法：--verify A,B,C --from <站> --to <站> --date <YYYY-MM-DD>', 'args');
    }
    const rows = await client.verify(codes, from, to, d);
    if (json) { console.log(JSON.stringify(rows, null, 2)); return; }
    for (const r of rows) {
      if (r.missing) { console.log(`  ${r.code}  查不到`); continue; }
      const pass = r.dep && r.arr;
      console.log(`  ${r.code}  ${r.dep || '?'} → ${r.arr || '?'}  ${pass ? '' : '（不经该区间）'}  ${r.origin}→${r.terminus}`);
    }
    return;
  }

  console.log(`rail_12306.js — 12306 时刻查询（默认 1 QPS）

  --list <出发站> <到达站> <日期>        有票查询，走 leftTicket（限流接口，已节流 + 退避重试）
  --verify A,B,C --from <站> --to <站>   逐条校验车次时刻，只走不限流的两个接口
  --stops <车次> <日期>                  打印逐站时刻
  --codes <站名...>                      查电报码
  --qps <n>                              每秒请求数，默认 1
  --json                                 输出 JSON

站名可以直接写中文，也可以写电报码（QIP / IZP / VAP）。`);
}

module.exports = { createClient, createThrottle, presaleInfo, RailError, DEFAULT_QPS };

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error('✖ ' + e.message);
    process.exit(e instanceof RailError && e.kind === 'presale' ? 2 : 1);
  });
}
