#!/usr/bin/env node
'use strict';
/**
 * variflight.js — 飞常准 MCP 航班票价检索封装
 *
 * 被 flight_query.js / airport_scan.js 共用。
 *
 * 计费模型（实测）：
 *   - 搜索 flights(...)：1 积分 / 唯一「出发城市→到达城市」O-D 对，日期不重复计费
 *   - 快照 flight_snapshot(...)：1 积分 / 次调用
 *   - initialize / tools/list：免费
 *
 * 硬约束（实测）：
 *   - SQL 输出上限 200 行，超了 truncated: true 且会静默丢数据
 *   - 同一 O-D 的多个日期必须放进同一次调用，拆开查会重复计费
 *
 * key：优先读环境变量 VARIFLIGHT_MCP_KEY；未设置时回退读
 *      ~/.workbuddy-ai/mcp.json 里 variflight-mcp 的 Authorization 头。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cache = require('./cache');

const ENDPOINT = 'https://c-gw.variflight.com/chat_message/mcp/api/legacy';
const PROTOCOL = '2025-03-26';

class VariflightError extends Error {
  constructor(message, kind, hint) {
    super(message);
    this.name = 'VariflightError';
    this.kind = kind || 'other';
    this.hint = hint;
  }
}

// ── 凭据 ────────────────────────────────────────────────────────────────
function token() {
  const env = (process.env.VARIFLIGHT_MCP_KEY || '').trim();
  if (env) return env;
  try {
    const p = path.join(os.homedir(), '.workbuddy-ai', 'mcp.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const servers = j.mcpServers || j.mcp || {};
    const auth = (servers['variflight-mcp'] || {}).headers?.Authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(String(auth).trim());
    if (m) return m[1].trim();
  } catch (_) { /* 没有就按未设置处理 */ }
  return '';
}

const tokenSource = () => (process.env.VARIFLIGHT_MCP_KEY || '').trim()
  ? 'env:VARIFLIGHT_MCP_KEY'
  : token() ? '~/.workbuddy-ai/mcp.json' : '';

// ── JSON-RPC / SSE ──────────────────────────────────────────────────────
/** 响应可能是裸 JSON，也可能是 SSE（id: / event: / data: 三行），两种都吃 */
function parseBody(text) {
  const t = String(text || '').trim();
  // 有的服务只发 data: 行，不带 id/event，所以行首就要判
  const looksSse = /^(id|event|data):/.test(t) || t.includes('\nevent:') || t.includes('\ndata:');
  const payload = looksSse
    ? t.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('')
    : t;
  try { return JSON.parse(payload); } catch (_) { return null; }
}

async function rpc(body, sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: 'Bearer ' + token(),
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  let res;
  try {
    res = await fetch(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (e) {
    throw new VariflightError('请求失败：' + e.message, 'network', '检查网络或代理。');
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new VariflightError('鉴权失败（HTTP ' + res.status + '）', 'auth',
      'MCP Key 无效或已过期，到 https://cmcp.variflight.com/ 重新生成，或重跑 node scripts/doctor.js --probe。');
  }
  if (!res.ok) throw new VariflightError('接口 HTTP ' + res.status, 'http', '稍后重试。');
  const json = parseBody(text);
  if (!json) throw new VariflightError('响应既不是 JSON 也不是 SSE', 'parse', '把原始返回保存下来排查。');
  if (json.error) {
    throw new VariflightError('接口错误：' + JSON.stringify(json.error), 'rpc', '检查 SQL 语法与必填参数。');
  }
  return { json, sessionId: res.headers.get('mcp-session-id') || sessionId };
}

/** 建会话。initialize 不扣积分，每次进程内做一次即可。 */
async function openSession() {
  const { json, sessionId } = await rpc({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'ski-trip-planner', version: '1.0' } },
  });
  return { info: json.result && json.result.serverInfo, sessionId };
}

/** 调工具，返回 document（含 item.data.rows）与原始 text 块。 */
async function callTool(name, args, sessionId) {
  const { json, sessionId: sid } = await rpc({
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args },
  }, sessionId);
  const result = json.result || {};
  if (result.isError) {
    const msg = (result.content || []).map((c) => c.text).filter(Boolean).join('\n') || '工具返回错误';
    const err = new VariflightError('查询失败：' + msg, 'tool',
      '多为 SQL 语法问题，检查 flights(...) 的参数名与字面量。');
    err.toolText = msg;                    // 留给失败记录落盘
    throw err;
  }
  const textBlock = (result.content || []).find((c) => c.type === 'text');
  if (!textBlock) throw new VariflightError('响应里没有 text 块', 'parse');
  let doc;
  try { doc = JSON.parse(textBlock.text); } catch (e) {
    throw new VariflightError('text 块不是合法 JSON', 'parse');
  }
  return { doc, raw: textBlock.text, sessionId: sid };
}

/**
 * 带缓存的工具调用。
 *
 * 三档策略（opts.cache.mode）：
 *   auto    默认。新鲜且完整的缓存直接用；否则真查，成功即写盘。
 *   refresh 无视缓存直接查，成功后覆盖。
 *   off     不读也不写。
 *
 * 失败兜底：真查抛错时，只要该键上有还能解析的缓存，就用它顶上（哪怕过期或被截断），
 * 并在 meta 里标 stale/fallback —— 这是「重试不重复扣分」的核心。
 *
 * @param {string} name
 * @param {object} args
 * @param {{cache?:object, session?:()=>Promise<string>, label?:string, log?:Function}} ctx
 * @returns {Promise<{doc:object, cached:boolean, stale?:boolean, fallback?:boolean, error?:Error, entry?:object, sessionId?:string}>}
 */
async function callToolCached(name, args, ctx = {}) {
  const cfg = ctx.cache || {};
  const mode = cfg.mode || 'auto';
  const ttlMinutes = cfg.ttlMinutes === undefined ? cache.DEFAULT_TTL_MINUTES : Number(cfg.ttlMinutes);
  const log = ctx.log || (() => {});

  const key = cache.keyOf(name, args);
  const hit = mode === 'off' ? null : cache.read(key);

  if (mode === 'auto' && hit) {
    const v = cache.assess(hit, { ttlMinutes });
    if (v.serve) {
      const note = v.reason === 'incomplete' ? '，但上次结果被截断' : '';
      log('    ↳ 命中缓存（' + cache.formatAge(v.age) + '前' + note + '），不消耗积分');
      return { doc: v.doc, cached: true, stale: v.reason !== 'fresh', entry: hit };
    }
    if (v.reason === 'stale') log('    ↳ 缓存已过期（' + cache.formatAge(v.age) + '前），重新查询');
    else if (v.reason === 'incomplete') log('    ↳ 缓存不完整（上次被截断），重新查询；调小 --per-transfer 或 --chunk 才有意义');
    else if (v.reason === 'failed') log('    ↳ 缓存里只有上次的失败记录，重新查询');
    else if (v.reason === 'corrupt') log('    ↳ 缓存无法解析，重新查询');
  }

  try {
    // 建会话也放在 try 里：网络断了的时候，会话都建不起来，同样应该回退缓存
    const sessionId = ctx.session ? await ctx.session() : undefined;
    const { doc, raw, sessionId: sid } = await callTool(name, args, sessionId);
    const data = (doc.item && doc.item.data) || {};
    if (mode !== 'off') {
      cache.write({
        schema: cache.SCHEMA, key, tool: name, args,
        sql: args.sql, label: ctx.label || '',
        createdAt: new Date().toISOString(),
        ok: true, error: null,
        truncated: Boolean(data.truncated),
        rowCount: data.row_count || 0,
        sourceCount: data.source_count || 0,
        raw,
      });
    }
    return { doc, cached: false, sessionId: sid };
  } catch (e) {
    if (mode !== 'off' && hit) {
      const v = cache.assess(hit, { allowStale: true, allowIncomplete: true });
      if (v.serve) {
        log('    ⚠ 查询失败（' + e.message + '），回退到缓存（' + cache.formatAge(v.age) + '前的数据）');
        return { doc: v.doc, cached: true, stale: true, fallback: true, entry: hit, error: e };
      }
    }
    // 失败也记一笔，便于事后排查；这类条目永远不会被当成数据返回
    if (mode !== 'off') {
      cache.write({
        schema: cache.SCHEMA, key, tool: name, args,
        sql: args.sql, label: ctx.label || '',
        createdAt: new Date().toISOString(),
        ok: false, error: e.message,
        truncated: false, rowCount: 0, sourceCount: 0,
        raw: e.toolText || '',
      });
    }
    throw e;
  }
}

// ── SQL 构造 ────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/'/g, "''");

/**
 * 一组同 O-D 的日期 → 一条 SQL。
 * 直飞/经停全留，中转按成人含税价取前 perTransfer 条（分区排名，互不挤占）。
 */
function buildSql(sources, perTransfer) {
  const limit = Math.max(1, Math.min(200, Number(perTransfer) || 15));
  const union = sources.map((s) => {
    const tag = `${s.date}|${s.from}-${s.to}`;
    return `  SELECT '${esc(tag)}' AS tag, o.option_id, o.transfers, o.flight_nos,
         o.adult_fare, o.adult_construction_fee, o.adult_fuel, o.adult_total,
         o.seats, o.summary
  FROM flights(
    market := 'domestic',
    legs := [{'dep_city':'${esc(s.from)}','arr_city':'${esc(s.to)}','date':'${esc(s.date)}'}],
    cabin := '${esc(s.cabin || 'economy')}'
  ) AS o`;
  }).join('\n  UNION ALL\n');

  return `WITH all_rows AS (
${union}
), ranked AS (
  SELECT *,
         ROW_NUMBER() OVER (PARTITION BY tag, transfers
                            ORDER BY adult_total NULLS LAST) AS rn
  FROM all_rows
)
SELECT tag, option_id, transfers, flight_nos, adult_fare,
       adult_construction_fee, adult_fuel, adult_total, seats, summary
FROM ranked
WHERE transfers = 0 OR rn <= ${limit}
ORDER BY tag, transfers, adult_total NULLS LAST`;
}

// ── 解析 ────────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');

/**
 * summary 形如：
 *   深圳-长春，长龙 GJ8656，2026-10-24 13:55:00 出发、2026-10-24 19:30:00 到达，
 *   直飞，总耗时 5 小时 35 分钟，成人票面价 CNY 800，余票 6 张，航班包含经停。。
 *   深圳市-青岛-长春市，山航 SC4682/SC4725，…，1 次中转，…，中转停留约 1400 分钟。。
 */
function parseSummary(text) {
  const s = String(text || '');
  const out = {};
  const route = /^([^，]+)，/.exec(s);
  if (route) out.cities = route[1].split('-').map((c) => c.replace(/市$/, ''));
  const dt = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):\d{2} 出发、(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):\d{2} 到达/.exec(s);
  if (dt) { out.depDate = dt[1]; out.dep = dt[2]; out.arrDate = dt[3]; out.arr = dt[4]; }
  const stop = /中转停留约 (\d+) 分钟/.exec(s);
  if (stop) out.stopMinutes = Number(stop[1]);
  return out;
}

/** 一行候选 → config 里的航班对象 */
function toFlight(row, src) {
  const p = parseSummary(row.summary);
  const transfers = Number(row.transfers) || 0;
  const cities = p.cities || [];
  const via = transfers > 0 && cities.length >= 3 ? cities[1] : '';

  const f = {
    date: p.depDate || src.date,
    dep: p.dep || '',
    arr: p.arr || '',
    price: row.adult_fare,
    no: (row.flight_nos || []).join('+'),
    tag: via ? via + '转' : '直飞',
    seg: transfers + 1,
  };
  if (p.arrDate && p.arrDate !== f.date) f.arrDate = p.arrDate;

  const tax = (Number(row.adult_construction_fee) || 0) + (Number(row.adult_fuel) || 0);
  if (tax > 0) f.tax = tax;                       // 实际机建 + 燃油，planner 优先用它
  if (typeof row.seats === 'number') f.seats = row.seats;
  if (typeof p.stopMinutes === 'number') f.stopMinutes = p.stopMinutes;
  return f;
}

const DEDUPE_KEY = (f) => [f.no, f.date, f.dep, f.arr].join('|');

function dedupe(list) {
  const map = new Map();
  for (const f of list) {
    const k = DEDUPE_KEY(f);
    const prev = map.get(k);
    if (!prev || f.price < prev.price) map.set(k, f);
  }
  return [...map.values()];
}

// ── 日期窗口 ────────────────────────────────────────────────────────────
const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

/** 把任意一天归到「它所在的那个周末」的周五 */
function fridayOf(date) {
  const d = new Date(date + 'T00:00:00Z');
  const dow = d.getUTCDay();                       // 0=周日 … 6=周六
  const delta = dow === 5 ? 0 : dow === 6 ? -1 : dow === 0 ? -2 : 5 - dow;
  return addDays(date, delta);
}

/**
 * 请假天数 → 去程 / 返程的日期窗口。
 *   请假 0   去程 周五、周六          返程 周日
 *   请假 0.5 去程 周五、周六          返程 周日、周一
 *   请假 1   去程 周四、周五、周六    返程 周日、周一、周二
 *   请假 2   去程 周三…周六           返程 周日…周三
 */
function leaveWindow(anyDate, leaveDays) {
  const D = Number(leaveDays);
  if (!Number.isFinite(D) || D < 0 || D > 2) {
    throw new VariflightError('请假天数需在 0 / 0.5 / 1 / 2 之间，收到 ' + leaveDays, 'arg');
  }
  const fri = fridayOf(anyDate);
  const backStart = Math.max(0, Math.floor(D));
  const outCount = 2 + backStart;                  // 周五、周六 + 往前请的整天
  const retCount = D === 0 ? 1 : Math.floor(D) + 2;

  const out = [];
  for (let i = 0; i < outCount; i++) out.push(addDays(fri, -backStart + i));
  const ret = [];
  for (let i = 0; i < retCount; i++) ret.push(addDays(fri, 2 + i));

  return { friday: fri, out, ret };
}

// ── 主入口 ──────────────────────────────────────────────────────────────
/**
 * 查一批 (from, to, date)。
 * 同一 O-D 的日期合并进同一次调用（省积分）；每次调用最多 chunk 个数据源（防 200 行截断）。
 * 每次调用先过缓存：新鲜且完整的直接复用，不花积分。
 *
 * @param {object} opts
 * @param {Array<{from:string,to:string,date:string,cabin?:string}>} opts.sources
 * @param {number} [opts.perTransfer=15]  每个日期保留的中转条数
 * @param {number} [opts.chunk=3]         每次调用的数据源上限
 * @param {{mode?:'auto'|'refresh'|'off', ttlMinutes?:number}} [opts.cache]
 * @param {(msg:string)=>void} [opts.log]
 * @returns {{flights:Array, meta:object}}
 */
async function queryFlights(opts) {
  const sources = (opts.sources || []).filter((s) => s && s.from && s.to && s.date);
  if (!sources.length) throw new VariflightError('没有可查询的航线日期', 'arg');

  const perTransfer = Number(opts.perTransfer) || 15;
  const chunk = Math.max(1, Math.min(6, Number(opts.chunk) || 3));
  const log = opts.log || (() => {});
  const cacheCfg = opts.cache || {};

  // 按 O-D 分组，组内再按 chunk 切
  const groups = new Map();
  for (const s of sources) {
    const k = s.from + '>' + s.to;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }

  const batches = [];
  for (const [, list] of groups) {
    for (let i = 0; i < list.length; i += chunk) batches.push(list.slice(i, i + chunk));
  }

  // 会话按需建立：全部命中缓存时一次网络请求都不发（initialize 免费，但也没必要走）
  let sessionId = null;
  const session = async () => {
    if (!sessionId) {
      const s = await openSession();
      sessionId = s.sessionId;
    }
    return sessionId;
  };

  const flights = [];
  const calls = [];
  let rows = 0;
  let truncated = false;
  let hits = 0;
  let fallbacks = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const sql = buildSql(batch, perTransfer);
    const od = batch[0].from + '→' + batch[0].to;
    const dates = batch.map((b) => b.date);
    const short = dates.map((d) => d.slice(5)).join(' ');
    log(`  [${i + 1}/${batches.length}] ${od} × ${batch.length} 天（${short}）`);

    const res = await callToolCached('getFlightTicketPrice', { sql }, {
      cache: cacheCfg, session, label: od + ' ' + short, log,
    });

    if (res.cached) hits++;
    if (res.fallback) fallbacks++;

    const data = (res.doc.item && res.doc.item.data) || {};
    rows += data.row_count || 0;
    if (data.truncated) {
      truncated = true;
      log('    ⚠ 返回被截断（truncated: true），有数据没回来，请减小 --chunk 或 --per-transfer');
    }

    const byDate = new Map(batch.map((b) => [b.date, b]));
    for (const row of data.rows || []) {
      const tag = String(row.tag || '');
      const [date] = tag.split('|');
      const src = byDate.get(date) || batch[0];
      const f = toFlight(row, src);
      if (f.dep && f.arr) flights.push(f);
    }

    calls.push({
      od,
      dates,
      rowCount: data.row_count || 0,
      truncated: Boolean(data.truncated),
      sourceCount: data.source_count || 0,
      snapshot: ((data.sources || [])[0] || {}).snapshot_id || '',
      cached: Boolean(res.cached),
      stale: Boolean(res.stale),
      fallback: Boolean(res.fallback),
      dataAt: res.cached && res.entry ? res.entry.createdAt : new Date().toISOString(),
    });
  }

  // 积分只算真正打到接口的 O-D 对；命中缓存的那部分是真省下来的
  const liveOd = new Set(calls.filter((c) => !c.cached).map((c) => c.od));
  const credits = liveOd.size;
  const stamps = calls.map((c) => c.dataAt).filter(Boolean).sort();

  return {
    flights: dedupe(flights).sort((a, b) =>
      a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.dep.localeCompare(b.dep)),
    meta: {
      calls: calls.length,
      rows,
      truncated,
      credits,                       // 本次真实消耗（命中缓存的部分不计）
      odPairs: [...groups.keys()],
      cache: {
        dir: cache.cacheDir(),
        mode: cacheCfg.mode || 'auto',
        hits,
        fallbacks,
        savedCredits: groups.size - credits,
      },
      // 这批数据实际是什么时候拿到的；有缓存命中时会早于「现在」，写报告页脚要用它
      dataAt: { oldest: stamps[0] || '', newest: stamps[stamps.length - 1] || '' },
      detail: calls,
    },
  };
}

module.exports = {
  ENDPOINT, VariflightError, token, tokenSource, parseBody, rpc, openSession,
  callTool, callToolCached, buildSql, parseSummary, toFlight, dedupe, queryFlights,
  fridayOf, leaveWindow, addDays, cache,
};
