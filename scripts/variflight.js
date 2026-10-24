#!/usr/bin/env node
'use strict';
/**
 * variflight.js — 飞常准 MCP 航班票价检索封装
 *
 * 只用于**详细检索**（第 3 步）：给定日期窗口，拿全量候选与含税票价。
 * 不要拿它做机场粗筛/预查——按城市对扣积分，粗筛一律走携程问道或让用户手选。
 *
 * 计费模型（实测；journal 里每次调用的 credits 字段可逐条核对）：
 *   - getFlightTicketPrice：**1 积分 / 次 tools/call**，与 SQL 里塞了几个日期无关。
 *     所以唯一有效的省分手段是「把同一方向的全部日期合并进一次调用」：
 *     2 天拆两次 = 2 分，合并一次 = 1 分。
 *   - 同一 (工具, 参数) 命中本地缓存：0 分。
 *   - 失败调用（401 / 工具返回 ERROR）：0 分。
 *   - initialize / tools/list：免费。
 *
 * 硬约束（实测）：
 *   - SQL 输出上限 200 行，超了 truncated: true 且会静默丢数据。
 *     结果按 tag（= 日期）排序，所以截断只砍**靠后**的日期：
 *     最后一个有行的日期可能是半截，它之后的日期整段缺失。
 *     截断后**不要整体重跑**（那是新的 tools/call，再扣 1 分），
 *     只补「被砍到的那天起」的日期 —— 见 queryFlights 的自动补查逻辑。
 *   - 同一 O-D 的多个日期必须放进同一次调用，拆开查会重复计费。
 *
 * key：优先读环境变量 VARIFLIGHT_MCP_KEY；未设置时回退读 agent 的 MCP 配置
 *      里 variflight-mcp 的 Authorization 头（路径解析见 scripts/mcp_json.js）。
 */

const cache = require('./cache');
const mcpJson = require('./mcp_json');

const ENDPOINT = 'https://c-gw.variflight.com/chat_message/mcp/api/legacy';
const PROTOCOL = '2025-03-26';

// 实测硬上限（见 references/variflight-query-plan.md）
const MAX_SOURCES_PER_SQL = 6;      // 一次 SQL 最多 6 个航班数据源
const MAX_ROWS_PER_SQL = 200;       // 输出最多 200 行，超了 truncated:true 且静默丢数据
const DEFAULT_MAX_STOP_MIN = 960;   // 中转停留上限 16h。480 会砍掉「落地睡一晚」整类最优解

class VariflightError extends Error {
  constructor(message, kind, hint) {
    super(message);
    this.name = 'VariflightError';
    this.kind = kind || 'other';
    this.hint = hint;
  }
}

// ── 凭据 ────────────────────────────────────────────────────────────────
function tokenFromMcpConfig() {
  const hit = mcpJson.findServer();
  return hit ? mcpJson.bearerOf(hit.server) : '';
}

function token() {
  const env = (process.env.VARIFLIGHT_MCP_KEY || '').trim();
  if (env) return env;
  return tokenFromMcpConfig();
}

const tokenSource = () => (process.env.VARIFLIGHT_MCP_KEY || '').trim()
  ? 'env:VARIFLIGHT_MCP_KEY'
  : token() ? mcpJson.short(mcpJson.findServer().path) : '';

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
      return { doc: v.doc, cached: true, stale: v.reason !== 'fresh', entry: hit, key };
    }
    if (v.reason === 'stale') log('    ↳ 缓存已过期（' + cache.formatAge(v.age) + '前），重新查询');
    else if (v.reason === 'incomplete') log('    ↳ 缓存不完整（上次被截断），重新查询；调小 --per-transfer 或加 --type direct 才更可能装得下');
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
    return { doc, cached: false, sessionId: sid, key };
  } catch (e) {
    if (mode !== 'off' && hit) {
      const v = cache.assess(hit, { allowStale: true, allowIncomplete: true });
      if (v.serve) {
        log('    ⚠ 查询失败（' + e.message + '），回退到缓存（' + cache.formatAge(v.age) + '前的数据）');
        return { doc: v.doc, cached: true, stale: true, fallback: true, entry: hit, error: e, key };
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
 *
 * 三个要点：
 *   1. 直飞/经停全留，中转按成人含税价取前 perTransfer 条（分区排名，互不挤占）。
 *   2. 机场代码从 legs[1].segments[] 取出（dep_ap / arr_ap），不再靠航司推断。
 *   3. **同时刻去重**：同一 (起飞时刻, 到达时刻, 中转次数) 常有 3–5 条代码共享重复
 *      （同一航班挂 CZ/MF/KN 多个号），对枚举毫无价值，却会把 200 行上限吃光。
 *      只留最便宜的那条，北京这种干线两天并查才不会触发截断。
 */
function buildSql(sources, perTransfer, market) {
  const limit = Math.max(1, Math.min(200, Number(perTransfer) || 15));
  const fallbackMarket = market === 'international' ? 'international' : 'domestic';
  const union = sources.map((s) => {
    const tag = `${s.date}|${s.from}-${s.to}`;
    // 机场代码藏在 legs[1].segments[] 里，必须显式取出来：
    //   · 首段 dep_airport  = 出发机场（BJS 会区分 PEK / PKX，不再靠航司猜）
    //   · 末段 arr_airport  = 最终到达机场（中转方案也是终点机场）
    // 只取 10 个扁平列时这几个字段会丢，报告里就只能按航司归属反推。
    return `  SELECT '${esc(tag)}' AS tag, o.option_id, o.transfers, o.flight_nos,
         o.adult_fare, o.adult_construction_fee, o.adult_fuel, o.adult_total,
         o.seats, o.summary,
         o.legs[1].segments[1].dep_airport                          AS dep_ap,
         o.legs[1].segments[len(o.legs[1].segments)].arr_airport    AS arr_ap,
         o.legs[1].segments[1].dep_airport_name                     AS dep_ap_name,
         o.legs[1].segments[len(o.legs[1].segments)].arr_airport_name AS arr_ap_name,
         o.legs[1].duration_min                                     AS dur_min
  FROM flights(
    market := '${esc(s.market || fallbackMarket)}',
    legs := [{'dep_city':'${esc(s.from)}','arr_city':'${esc(s.to)}','date':'${esc(s.date)}'}],
    cabin := '${esc(s.cabin || 'economy')}'
  ) AS o
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY o.legs[1].dep_time, o.legs[1].arr_time, o.transfers
    ORDER BY o.adult_total NULLS LAST, o.option_id
  ) = 1`;
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
       adult_construction_fee, adult_fuel, adult_total, seats, summary,
       dep_ap, arr_ap, dep_ap_name, arr_ap_name, dur_min
FROM ranked
WHERE transfers = 0 OR rn <= ${limit}
ORDER BY tag, transfers, adult_total NULLS LAST`;
}

// ── 按日限额的 SQL（推荐） ──────────────────────────────────────────────

/** 中转停留分钟数：总耗时 − 各航段飞行耗时。
 *  `segments[i].transfer_duration_min` 文档里有、返回值里恒为 NULL，
 *  用它过滤会 coalesce(…,0) <= N 恒真 → 静默失效。只能做差。 */
const STOP_EXPR = `(o.legs[1].duration_min
             - o.legs[1].segments[1].duration_min
             - coalesce(o.legs[1].segments[2].duration_min, 0)
             - coalesce(o.legs[1].segments[3].duration_min, 0))`;

/**
 * 一组同 O-D 的日期 → 一条「每个日期只留最便宜 N 条」的 SQL。
 *
 * 与 buildSql() 的区别（实测决定，见 references/variflight-query-plan.md）：
 *   1. **不用 CTE、不用窗口函数**。6 个数据源 + 任何窗口函数 CTE 都会
 *      `MCP tool execution failed`（0.6–0.8s，免费）；扁平 UNION ALL 才成功。
 *      所以「排名」改成每个分支自己 `GROUP BY` + `ORDER BY` + `LIMIT`。
 *   2. **限额是「每个日期的总条数」，不是「中转条数」**。旧口径「直飞全留 +
 *      中转前 15」实测只有 52% 的行预算落在引擎会保留的方案上。
 *   3. **GROUP BY (起降时刻, 中转次数) 即共享航班合并**：同一时刻挂多家代码的
 *      航班折叠成一条，`min_by(col, adult_total)` 让航班号/option_id 跟着最低价走。
 *   4. 顺带用 STOP_EXPR 做 16h 停留硬上限，省下的名额留给真正可用的方案。
 *
 * @param {Array<{from,to,date,cabin?,market?}>} sources 同一 O-D 的若干日期
 * @param {number} perDay       每个日期最多保留几条（3 天 66 / 6 天 33 都 = 198 行）
 * @param {string} [market]     domestic | international
 * @param {number} [maxStopMin] 中转停留上限（分钟），0 = 不限
 */
function buildSqlPerDay(sources, perDay, market, maxStopMin) {
  const limit = Math.max(1, Math.min(200, Number(perDay) || 33));
  const cap = Number(maxStopMin) > 0 ? Math.floor(Number(maxStopMin)) : 0;
  const fallbackMarket = market === 'international' ? 'international' : 'domestic';
  const where = cap ? `o.transfers = 0 OR ${STOP_EXPR} <= ${cap}` : 'TRUE';

  const branches = sources.map((s) => {
    const tag = `${s.date}|${s.from}-${s.to}`;
    return `(SELECT '${esc(tag)}' AS tag, o.transfers,
         o.legs[1].dep_time  AS dep, o.legs[1].arr_time AS arr,
         o.legs[1].duration_min AS dur_min,
         o.legs[1].segments[1].dep_airport AS dep_ap,
         o.legs[1].segments[len(o.legs[1].segments)].arr_airport AS arr_ap,
         min_by(o.legs[1].segments[1].dep_airport_name, o.adult_total) AS dep_ap_name,
         min_by(o.legs[1].segments[len(o.legs[1].segments)].arr_airport_name, o.adult_total) AS arr_ap_name,
         min(${STOP_EXPR})                   AS stop_min,
         min(o.adult_total)                  AS adult_total,
         min(o.adult_fare)                   AS adult_fare,
         min(o.adult_construction_fee)       AS adult_construction_fee,
         min(o.adult_fuel)                   AS adult_fuel,
         max(o.seats)                        AS seats,
         min_by(o.option_id,  o.adult_total) AS option_id,
         min_by(o.flight_nos, o.adult_total) AS flight_nos,
         min_by(o.summary,    o.adult_total) AS summary
  FROM flights(
    market := '${esc(s.market || fallbackMarket)}',
    legs := [{'dep_city':'${esc(s.from)}','arr_city':'${esc(s.to)}','date':'${esc(s.date)}'}],
    cabin := '${esc(s.cabin || 'economy')}'
  ) AS o
  WHERE ${where}
  GROUP BY o.legs[1].dep_time, o.legs[1].arr_time, o.transfers, o.legs[1].duration_min,
           o.legs[1].segments[1].dep_airport,
           o.legs[1].segments[len(o.legs[1].segments)].arr_airport
  ORDER BY adult_total NULLS LAST
  LIMIT ${limit})`;
  });

  return branches.join('\nUNION ALL\n') + '\nORDER BY tag, adult_total NULLS LAST';
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

  // 真实机场（SQL 里从 legs[1].segments[] 取的），有就用真的，没有才回落到航司推断
  if (row.dep_ap) { f.depAp = String(row.dep_ap).toUpperCase(); f.depApName = row.dep_ap_name || ''; }
  if (row.arr_ap) { f.arrAp = String(row.arr_ap).toUpperCase(); f.arrApName = row.arr_ap_name || ''; }
  if (typeof row.dur_min === 'number') f.durMin = row.dur_min;

  // 税费：优先用实际机建 + 燃油；国际航线这两个字段常缺失（fuel 记 0），
  // 但 adult_total 是含税总价，差额就是税费——不补这一步会把税费当 0。
  let tax = (Number(row.adult_construction_fee) || 0) + (Number(row.adult_fuel) || 0);
  if (!tax) {
    const total = Number(row.adult_total);
    const fare = Number(row.adult_fare);
    if (Number.isFinite(total) && Number.isFinite(fare) && total > fare) tax = total - fare;
  }
  if (tax > 0) f.tax = tax;                       // 实际机建 + 燃油，planner 优先用它
  if (typeof row.seats === 'number') f.seats = row.seats;
  // 中转停留：优先用 SQL 的 stop_min（做差算出来的，精确）；
  // 旧缓存/旧路径没有这一列，才回落到 summary 文本里的「中转停留约 N 分钟」
  if (typeof row.stop_min === 'number') f.stopMinutes = row.stop_min;
  else if (typeof p.stopMinutes === 'number') f.stopMinutes = p.stopMinutes;
  // 方向标记：--both 且去返程日期区间重叠时，靠它区分 out/ret（输出前会被剥掉）
  if (src && src.dir) f._dir = src.dir;
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
 *
 * 这里的天数**只用来铺查询窗口**，不用来筛结果：窗口开得比周末宽（周末 ± (天数+1)），
 * 让「多请一天反而更便宜」的日期也在池子里；真正呈现哪些年假档，由枚举后组合里
 * 实际出现的天数决定（见 enumerate.js）。
 *
 *   请假 0   去程 周四…周六（3 天）      返程 周日、周一（2 天）
 *   请假 0.5 去程 周四…周六（3 天）      返程 周日、周一（2 天）
 *   请假 1   去程 周三…周六（4 天）      返程 周日…周二（3 天）
 *   请假 2   去程 周二…周六（5 天）      返程 周日…周三（4 天）
 *   请假 3   去程 周一…周六（6 天）      返程 周日…周四（5 天）
 *
 * 上限 3 天：再往上窗口就有 13 天以上、单次查询必撞 200 行上限，逐日补查
 * 的积分比一次合并查询多得多，收益（多请两天假）也不成比例。
 */
const MAX_LEAVE_DAYS = 3;

function leaveWindow(anyDate, leaveDays) {
  const D = Number(leaveDays);
  if (!Number.isFinite(D) || D < 0 || D > MAX_LEAVE_DAYS) {
    throw new VariflightError('请假天数需在 0 / 0.5 / 1 / 2 / 3 之间，收到 ' + leaveDays, 'arg');
  }
  const fri = fridayOf(anyDate);
  const pad = Math.floor(D) + 1;                   // 周末 ± pad 天
  const outCount = pad + 2;                        // 周五往前 pad 天 … 周六
  const retCount = pad + 1;                        // 周日 … 周日往后 pad 天

  const out = [];
  for (let i = 0; i < outCount; i++) out.push(addDays(fri, -pad + i));
  const ret = [];
  for (let i = 0; i < retCount; i++) ret.push(addDays(fri, 2 + i));

  return { friday: fri, out, ret };
}

// ── 主入口 ──────────────────────────────────────────────────────────────
/**
 * chunk 归一化。
 *   0 / 未给 / 非数字  → 6，即**该方向的日期尽量合并进一次调用**（默认，最省分）
 *   正整数 n           → 每次最多 n 个日期，但不会超过 6（一次 SQL 最多 6 个数据源）
 */
function normalizeChunk(chunk) {
  const n = Number(chunk);
  if (!Number.isFinite(n) || n <= 0) return MAX_SOURCES_PER_SQL;
  return Math.max(1, Math.min(MAX_SOURCES_PER_SQL, Math.floor(n)));
}

/**
 * 把 (from,to,date) 列表排成调用批次：先按 O-D 分组，组内再按 chunk 切。
 * 抽出来是为了能在不联网的情况下断言「默认真的只发一次调用」。
 */
function planBatches(sources, chunk) {
  const groups = new Map();
  for (const s of sources) {
    const k = s.from + '>' + s.to;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const limit = normalizeChunk(chunk);
  const batches = [];
  for (const [, list] of groups) {
    for (let i = 0; i < list.length; i += limit) batches.push(list.slice(i, i + limit));
  }
  return { groups, batches };
}

/**
 * 查一批 (from, to, date)。
 *
 * 默认把同一 O-D 的全部日期合并进**一次**调用（1 积分），只有当返回值
 * truncated: true 时，才补查「被砍到的那天起」的日期（每天 1 次调用，命中缓存 0 分）。
 * 这样常见航线 1 分解决问题，只有真正装不下的干线才会多花 1–2 分。
 * 每次调用先过缓存：新鲜且完整的直接复用，不花积分。
 *
 * @param {object} opts
 * @param {Array<{from:string,to:string,date:string,cabin?:string}>} opts.sources
 * @param {number} [opts.perTransfer=15]  每个日期保留的中转条数
 * @param {number} [opts.chunk=0]         每次调用的日期上限；0 = 全部合并（默认）
 * @param {boolean} [opts.refill=true]    截断后是否自动补查被砍掉的日期
 * @param {{mode?:'auto'|'refresh'|'off', ttlMinutes?:number}} [opts.cache]
 * @param {object} [opts.journal]  运行记录句柄（scripts/journal.js），逐步记录输入输出
 * @param {(msg:string)=>void} [opts.log]
 * @param {Function} [opts.callTool] 测试注入点：替换掉默认的 callToolCached（离线跑补查逻辑用）
 * @returns {{flights:Array, meta:object}}
 */
async function queryFlights(opts) {
  const sources = (opts.sources || []).filter((s) => s && s.from && s.to && s.date);
  if (!sources.length) throw new VariflightError('没有可查询的航线日期', 'arg');

  const perTransfer = Number(opts.perTransfer) || 15;
  // perDay 一旦给出就走「按日限额」新路径（无 CTE、可 6 源、默认 16h 停留上限）
  const perDay = Number(opts.perDay) > 0 ? Number(opts.perDay) : 0;
  const maxStopMinutes = opts.maxStopMinutes === undefined
    ? DEFAULT_MAX_STOP_MIN : Number(opts.maxStopMinutes) || 0;
  const refillOn = opts.refill !== false;
  const log = opts.log || (() => {});
  const cacheCfg = opts.cache || {};
  const callFn = opts.callTool || callToolCached;

  const { groups, batches } = planBatches(sources, opts.chunk);

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
  let refills = 0;
  let liveCalls = 0;                 // 真正打到接口的调用次数 = 实际扣的积分

  /** 跑一个批次：调接口（带缓存）→ 记运行记录 → 解析成航班对象 */
  async function runBatch(batch, label) {
    const sql = perDay
      ? buildSqlPerDay(batch, perDay, opts.market, maxStopMinutes)
      : buildSql(batch, perTransfer, opts.market);
    // 行预算是「日期数 × 每天条数 ≤ 200」。超了不会报错，只会 truncated + 逐日补查（多扣分），
    // 所以在发请求之前先提醒一句。
    if (perDay && batch.length * perDay > MAX_ROWS_PER_SQL) {
      log(`    ⚠ ${batch.length} 天 × ${perDay} 条 = ${batch.length * perDay} 行，`
        + `超过 ${MAX_ROWS_PER_SQL} 行上限，会被截断（单方向 3 天配 66、6 天配 33）`);
    }
    const od = batch[0].from + '→' + batch[0].to;
    const dates = batch.map((b) => b.date);
    const short = dates.map((d) => d.slice(5)).join(' ');
    log(`  [${label}] ${od} × ${batch.length} 天（${short}）`);

    let res;
    try {
      res = await callFn('getFlightTicketPrice', { sql }, {
        cache: cacheCfg, session, label: od + ' ' + short, log,
      });
    } catch (e) {
      // 失败的这一步也要留下 SQL，否则上层不知道断在哪个查询上
      if (opts.journal) {
        opts.journal.step('call', {
          input: { od, dates, sql, cacheMode: cacheCfg.mode || 'auto' },
          error: e,
          note: '这一步失败，后续批次未执行',
        });
      }
      throw e;
    }

    if (res.cached) hits++;
    else liveCalls++;
    if (res.fallback) fallbacks++;

    const data = (res.doc.item && res.doc.item.data) || {};
    rows += data.row_count || 0;

    // 把每次调用的输入（SQL）与输出（行数/截断/缓存 key）记进运行记录，
    // 出错时上层可以据此手工拼结果，不必整条链路重跑
    if (opts.journal) {
      opts.journal.step('call', {
        input: { od, dates, sql, cacheMode: cacheCfg.mode || 'auto' },
        output: {
          rowCount: data.row_count || 0,
          sourceCount: data.source_count || 0,
          truncated: Boolean(data.truncated),
          cached: Boolean(res.cached),
          fallback: Boolean(res.fallback),
        },
        cacheKey: res.key,
      });
    }

    if (data.truncated) {
      truncated = true;
      log('    ⚠ 返回被截断（truncated: true），200 行上限，靠后日期的数据被丢掉');
    }

    const byDate = new Map(batch.map((b) => [b.date, b]));
    const seen = new Map();          // 日期 → 这个日期实际回来几行
    for (const row of data.rows || []) {
      const tag = String(row.tag || '');
      const [date] = tag.split('|');
      seen.set(date, (seen.get(date) || 0) + 1);
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
      refill: label === '补查',
      dataAt: res.cached && res.entry ? res.entry.createdAt : new Date().toISOString(),
    });

    return { data, res, seen, batch };
  }

  for (let i = 0; i < batches.length; i++) {
    const r = await runBatch(batches[i], `${i + 1}/${batches.length}`);

    // 截断自愈：结果按日期排序，所以最后有行的那天可能是半截，它之后的日期整段没回来。
    // 只补这一段，不重跑整批 —— 重跑整批既浪费 1 分，结果还是会截断。
    if (!r.data.truncated || !refillOn || r.batch.length <= 1) continue;

    const present = r.batch.map((b) => b.date).filter((d) => r.seen.has(d));
    const cut = present.length ? present[present.length - 1] : r.batch[0].date;
    const from = Math.max(0, r.batch.findIndex((b) => b.date === cut));
    const need = r.batch.slice(from);
    if (!need.length) continue;

    log(`    ↳ 自动补查被砍到的 ${need.length} 天（${need.map((b) => b.date.slice(5)).join(' ')}），不重跑整批`);
    for (const s of need) {
      refills++;
      const rr = await runBatch([s], '补查');
      if (rr.data.truncated) {
        log('    ⚠ 单日仍然截断：这一天本身超过 200 行');
        log(`      用 --per-transfer 调小中转条数（当前 ${perTransfer}），或 --type direct 只看直飞`);
      }
    }
  }

  // 积分 = 真正打到接口的调用次数（命中缓存的那部分是真省下来的）
  const credits = liveCalls;
  const stamps = calls.map((c) => c.dataAt).filter(Boolean).sort();

  return {
    flights: dedupe(flights).sort((a, b) =>
      a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.dep.localeCompare(b.dep)),
    meta: {
      calls: calls.length,
      rows,
      truncated,
      refills,
      credits,                       // 本次真实消耗（命中缓存的部分不计）
      odPairs: [...groups.keys()],
      cache: {
        dir: cache.cacheDir(),
        mode: cacheCfg.mode || 'auto',
        hits,
        fallbacks,
        savedCredits: calls.length - credits,
      },
      // 这批数据实际是什么时候拿到的；有缓存命中时会早于「现在」，写报告页脚要用它
      dataAt: { oldest: stamps[0] || '', newest: stamps[stamps.length - 1] || '' },
      detail: calls,
    },
  };
}

module.exports = {
  ENDPOINT, VariflightError, token, tokenSource, parseBody, rpc, openSession,
  callTool, callToolCached, buildSql, buildSqlPerDay, parseSummary, toFlight, dedupe,
  queryFlights, normalizeChunk, planBatches,
  fridayOf, leaveWindow, addDays, cache,
  MAX_SOURCES_PER_SQL, MAX_ROWS_PER_SQL, DEFAULT_MAX_STOP_MIN,
};
