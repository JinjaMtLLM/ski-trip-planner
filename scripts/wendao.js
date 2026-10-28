#!/usr/bin/env node
'use strict';
/**
 * wendao.js — 携程问道请求与解析封装
 *
 * 主流程不经过本文件：机场粗筛与骨架摸底按 references/wendao-prompts.md
 * 直接发原始 HTTP 请求。本文件有两种用法：
 *   1) 编程调用（批量核对航班号、结构化对比）；
 *   2) **CLI 取原文**（`--from/--to/--date`），供 LLM 按
 *      references/wendao-fare-watch-runbook.md 现场判读——CLI 只输出原文，
 *      不做任何解析，parseFlights 不参与。
 * key 仅从环境变量 WENDAO_API_KEY 读取，不接受命令行参数。
 *
 * 解析策略：不依赖返回版式。逐行扫描「HH:MM」判断角色（起飞/到达），
 * 用「起飞 → 到达」配对切段，再按出现顺序绑航班号。
 */

const ENDPOINT = 'https://externalcallback.ctrip.com/skills/api/crew/skillhub/searchInfo';
const { detectWendaoError } = require('./keys');

class WendaoError extends Error {
  constructor(message, kind, hint) {
    super(message);
    this.name = 'WendaoError';
    this.kind = kind || 'other';
    this.hint = hint;
  }
}

const token = () => (process.env.WENDAO_API_KEY || '').trim();

/** 发一次查询，返回正文文本 */
async function search(query) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: { token: token(), query } }),
    });
  } catch (e) {
    throw new WendaoError('请求失败：' + e.message, 'network', '检查网络或代理。');
  }
  if (!res.ok) {
    throw new WendaoError('接口 HTTP ' + res.status,
      res.status === 401 || res.status === 403 ? 'auth' : 'http',
      res.status === 401 || res.status === 403
        ? 'token 无效或已过期，按 node scripts/doctor.js --probe 的引导重新设置 WENDAO_API_KEY。'
        : '稍后重试；持续失败时用 node scripts/doctor.js --probe 验证凭据。');
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new WendaoError('响应不是合法 JSON', 'parse');
  }
  if (data && typeof data === 'object' && data.error) {
    const msg = String(data.error);
    const authIssue = /token|auth|unauthor|forbidden|invalid/i.test(msg);
    throw new WendaoError('接口返回错误：' + msg, authIssue ? 'auth' : 'quota',
      authIssue
        ? 'token 无效，按 node scripts/doctor.js --probe 的引导重新申请并设置 WENDAO_API_KEY。'
        : '配额恢复后重试，或更换 WENDAO_API_KEY；凭据状态见 node scripts/doctor.js --probe。');
  }
  const r = data && typeof data === 'object' && 'result' in data ? data.result : data;
  let text = '';
  if (typeof r === 'string') text = r;
  else if (r && typeof r === 'object') {
    text = typeof r.content === 'string' ? r.content
      : r.data && typeof r.data.content === 'string' ? r.data.content
        : JSON.stringify(r);
  }
  const err = detectWendaoError(text);
  if (err) {
    throw new WendaoError('检索失败：' + err.message, err.kind,
      err.kind === 'quota'
        ? '调用配额已用尽，配额恢复后重试；凭据状态见 node scripts/doctor.js --probe。'
        : 'token 无效，按 node scripts/doctor.js --probe 的引导重新申请并设置 WENDAO_API_KEY。');
  }
  return text;
}

// ── 基础工具 ────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const dayNum = (s) => Math.floor(Date.parse(s.slice(0, 10) + 'T00:00:00Z') / 86400000);
const dateOf = (n) => new Date(n * 86400000).toISOString().slice(0, 10);

function isoDate(y, mo, d, refMonth) {
  let year = y;
  if (refMonth === 12 && mo === 1) year = y + 1;
  if (refMonth === 1 && mo === 12) year = y - 1;
  return year + '-' + pad(mo) + '-' + pad(d);
}

function pickPrice(s) {
  const m = /(\d[\d,]*)\s*元/.exec(s || '');
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

/**
 * 扫描一行里所有 HH:MM，判定角色（dep/arr）与可能附带的月日。
 * 支持两种语序：`12月4日20:05起飞`（后缀）与 `起飞：12月4日 20:05`（前缀）。
 */
function scanTimes(line) {
  const out = [];
  const re = /(\d{1,2})\s*[:：]\s*(\d{2})/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) continue;

    const before = line.slice(Math.max(0, m.index - 14), m.index);
    const after = line.slice(m.index + m[0].length, m.index + m[0].length + 14);

    let role = null;
    if (/到达(?:时间)?\s*\**\s*[：:]?\s*$/.test(before)) role = 'arr';
    else if (/起飞(?:时间)?\s*\**\s*[：:]?\s*$/.test(before)) role = 'dep';
    else if (/^[^\u4e00-\u9fa5a-zA-Z]{0,3}(到达)/.test(after)) role = 'arr';
    else if (/^[^\u4e00-\u9fa5a-zA-Z]{0,3}(起飞)/.test(after)) role = 'dep';
    if (!role) continue;

    const dm = /(\d{1,2})\s*月\s*(\d{1,2})\s*日[^\d]{0,3}$/.exec(before);
    out.push({
      time: pad(h) + ':' + pad(mi),
      role,
      month: dm ? +dm[1] : null,
      day: dm ? +dm[2] : null,
    });
  }
  return out;
}

/** 按 ### 切段。标题可能不在行首，先归一化。 */
function splitSections(text) {
  const norm = text.replace(/\r\n/g, '\n').replace(/[ \t]*#{2,4}[ \t]+/g, '\n### ');
  const out = [];
  let cur = null;
  for (const raw of norm.split('\n')) {
    const line = raw.trim();
    if (/^###\s+/.test(line)) {
      if (cur) out.push(cur);
      cur = { head: line.replace(/^###\s+/, '').trim(), lines: [] };
    } else if (cur) {
      cur.lines.push(raw);
    }
  }
  if (cur) out.push(cur);
  return out;
}

const FLIGHT_NO_RE = /([A-Z]{2}\d{3,4})/;

/** 从若干段文本中按顺序配对 dep/arr，得到航段 */
function buildSegments(lines, year, refMonth) {
  const segs = [];
  let pendingNo = null;
  let pendingDep = null;

  for (const line of lines) {
    const noM = FLIGHT_NO_RE.exec(line);
    if (noM) pendingNo = noM[1];

    for (const t of scanTimes(line)) {
      const date = t.month ? isoDate(year, t.month, t.day, refMonth) : null;
      if (t.role === 'dep') {
        pendingDep = { time: t.time, date, no: pendingNo };
      } else if (t.role === 'arr' && pendingDep) {
        segs.push({
          no: pendingDep.no || pendingNo,
          dep: pendingDep.time,
          depDate: pendingDep.date,
          arr: t.time,
          arrDate: date,
        });
        pendingDep = null;
      }
    }
  }
  if (pendingDep) return [];          // 起飞无落地，数据不完整
  return segs;
}

function parseSection(sec, date, year, refMonth) {
  const head = sec.head;
  const body = sec.lines.join('\n');

  const segs = buildSegments(sec.lines, year, refMonth);
  if (!segs.length) return null;

  const priceLine = sec.lines.find((l) => /票价/.test(l));
  const price = priceLine ? pickPrice(priceLine) : null;
  if (price == null) return null;

  const isTransfer = segs.length >= 2 || /中转/.test(head);

  if (!isTransfer) {
    const s = segs[0];
    const airline = (/^([\u4e00-\u9fa5]{2,10}?航空|[\u4e00-\u9fa5]{2,4}航空)/.exec(head) || [])[1] || '';
    const rec = {
      date: s.depDate || date,
      dep: s.dep,
      arr: s.arr,
      price,
      no: s.no || '',
      tag: '直飞',
      seg: 1,
      airline,
    };
    let arrDate = s.arrDate || s.depDate || date;
    if (!s.arrDate && s.arr <= s.dep) arrDate = dateOf(dayNum(rec.date) + 1);
    if (arrDate !== rec.date) rec.arrDate = arrDate;
    return rec;
  }

  if (segs.length < 2 && /中转|方案/.test(head)) return null;   // 中转方案但只解析到一段，视为不完整

  const first = segs[0];
  const last = segs[segs.length - 1];

  // 中转城市：优先取正文显式字段，其次从标题推断并剥掉方位前缀
  let via = (/中转城市\s*\**\s*[：:]\s*([\u4e00-\u9fa5]{2,6})/.exec(body) || [])[1] || '';
  if (!via) {
    const m1 = /中转\s*([\u4e00-\u9fa5]{2,6})/.exec(head);
    const m2 = /([\u4e00-\u9fa5]{2,6})\s*中转/.exec(head);
    via = (m1 ? m1[1] : (m2 ? m2[1] : '')).replace(/^(经|从|由|在|于)/, '');
  }

  const startDate = first.depDate || date;
  let endDate = last.arrDate || last.depDate || startDate;
  if (!last.arrDate && last.arr <= last.dep) endDate = dateOf(dayNum(last.depDate || startDate) + 1);

  const rec = {
    date: startDate,
    dep: first.dep,
    arr: last.arr,
    price,
    no: segs.map((s) => s.no).filter(Boolean).join('+'),
    tag: via ? via + '转' : '中转',
    seg: segs.length,
  };
  if (via) rec.via = via;
  if (endDate !== startDate) rec.arrDate = endDate;
  return rec;
}

function parseFlights(text, date) {
  const year = +date.slice(0, 4);
  const refMonth = +date.slice(5, 7);
  const recs = [];
  for (const sec of splitSections(text)) {
    try {
      const r = parseSection(sec, date, year, refMonth);
      if (r && r.no && r.price != null) recs.push(r);
    } catch (_) { /* 单段解析失败不影响其余 */ }
  }
  return recs;
}

function dedupe(list) {
  const map = new Map();
  for (const r of list) {
    const k = [r.no, r.date, r.dep, r.arr].join('|');
    const prev = map.get(k);
    if (!prev || r.price < prev.price) map.set(k, r);
  }
  return [...map.values()];
}

const cnDate = (d) => d.slice(0, 4) + '年' + (+d.slice(5, 7)) + '月' + (+d.slice(8, 10)) + '日';

const QUERY = {
  direct: (from, to, date) => from + '到' + to + ' ' + cnDate(date)
    + ' 的直飞航班，列出每个航班的航空公司、航班号、起飞时间、到达时间、经济舱票价（元）',
  transfer: (from, to, date) => from + '到' + to + ' ' + cnDate(date)
    + ' 的中转航班方案（含过夜中转），逐个方案列出中转城市、每一段的航班号与起飞到达时间、联程经济舱票价（元）',
};

/**
 * 检索一条航线。
 * opts: { from, to, date, type: 'direct'|'transfer'|'both', repeat }
 * 返回 { flights, raws, calls }
 */
async function queryFlights(opts) {
  const { from, to, date } = opts;
  const type = opts.type || 'both';
  const repeat = Math.max(1, Math.min(5, Number(opts.repeat) || 1));
  const types = type === 'both' ? ['direct', 'transfer'] : [type];

  const raws = [];
  const all = [];
  for (const t of types) {
    for (let i = 0; i < repeat; i++) {
      const text = await search(QUERY[t](from, to, date));
      raws.push(text);
      all.push(...parseFlights(text, date));
    }
  }
  const flights = dedupe(all).sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.dep.localeCompare(b.dep));
  return { flights, raws, calls: types.length * repeat };
}

module.exports = { WendaoError, search, parseFlights, dedupe, queryFlights, cnDate };

// ---------- CLI：只取原文，不做判读 ----------
//
// 判读交给 LLM，按 references/wendao-fare-watch-runbook.md 执行。问道的排版
// 一天能换十种（2026-10-27 实测），任何正则解析器都会在一周内失效；而
// 「原文里明摆着写了航班号、时刻、票面价」这件事是稳定的。所以 CLI 只负责
// 把话问出去、把话原样带回来，parseFlights 不参与。
//
//   node scripts/wendao.js --from 阿勒泰 --to 深圳 --date 2027-01-03
//   node scripts/wendao.js --query "任意问题" --save out/fare-watch/raw
//
// stdout = 原文（原样）；stderr = 元信息。退出码 0 成功 / 2 配额 / 3 鉴权 / 4 其他。

/** 票面价巡检的标准问法：主动排除税费——问了它也只回「无法拆分」。 */
function fareQuery(from, to, date) {
  return `${cnDate(date)}${from}飞${to}。
这一天能查到的方案都列一下，直飞和中转都要，只要票面价，税费不用管（我自己算）。

每个方案麻烦写成一段，里面包含：
- 每一段的航班号、几点起飞、几点落地、在哪个机场；
- 全程大概多少小时；
- 这个方案一个人的经济舱票面价多少元。

同一天不同中转城市的方案我都要看，别只挑最便宜的一两个给我。`;
}

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const argv = process.argv.slice(2);
  const argOf = (k, d) => {
    const i = argv.indexOf(k);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  const from = argOf('--from', '');
  const to = argOf('--to', '');
  const date = argOf('--date', '');
  const query = argOf('--query', '') || (from && to && date ? fareQuery(from, to, date) : '');
  const saveDir = argOf('--save', '');

  if (!query) {
    console.error('用法：node scripts/wendao.js --from 阿勒泰 --to 深圳 --date 2027-01-03 [--save out/fare-watch/raw]');
    console.error('   或：node scripts/wendao.js --query "任意问题"');
    process.exit(4);
  }

  (async () => {
    let text;
    try {
      text = await search(query);
    } catch (e) {
      console.error(`[error] ${e.kind || 'other'}: ${e.message}`);
      if (e.hint) console.error(`[hint] ${e.hint}`);
      process.exit(e.kind === 'quota' ? 2 : e.kind === 'auth' ? 3 : 4);
    }
    if (saveDir) {
      const p = (n) => String(n).padStart(2, '0');
      const d = new Date();
      const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
        + `-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
      const dir = path.resolve(saveDir);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, stamp + '.txt');
      fs.writeFileSync(file, text, 'utf8');
      console.error(`[saved] ${file}`);
    }
    console.error(`[chars] ${text.length}`);
    process.stdout.write(text.endsWith('\n') ? text : text + '\n');
  })();
}
