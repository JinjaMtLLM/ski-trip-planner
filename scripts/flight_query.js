#!/usr/bin/env node
'use strict';
/**
 * flight_query.js — 航班检索（携程问道接口，内化于本 skill）
 *
 * 用法：
 *   node flight_query.js --from <出发城市或机场> --to <到达城市或机场> --date YYYY-MM-DD
 *                        [--type direct|transfer|both]  默认 both
 *                        [--repeat 2]                   同一查询执行次数，取并集
 *                        [--raw]                        输出原始文本
 *                        [--out <file>]                 写入文件
 *
 * key：仅从环境变量 WENDAO_API_KEY 读取，不接受命令行参数。
 *
 * 输出：JSON 数组，字段与 config.json 的航班对象一致，可直接拼进 config。
 *   [{ date, dep, arr, arrDate?, price, no, tag, seg, airline, via? }, ...]
 *
 * 解析策略：不依赖固定版式。逐行扫描「HH:MM」并判断其角色（起飞/到达），
 * 用「起飞 → 到达」配对切分段，再按出现顺序绑航班号。版式变化不影响结果。
 */

const fs = require('fs');

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i > -1 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const hasFlag = (name) => args.includes('--' + name);

function die(msg, hint) {
  console.error('\u2716 ' + msg + (hint ? '\n  ' + hint : ''));
  process.exit(1);
}

// ── 入参 ────────────────────────────────────────────────────────────────
const { requireKey, detectWendaoError } = require('./keys');
requireKey('WENDAO_API_KEY');
const TOKEN = (process.env.WENDAO_API_KEY || '').trim();

const FROM = getArg('from');
const TO = getArg('to');
const DATE = getArg('date');
if (!FROM || !TO || !DATE) die('缺少 --from / --to / --date');
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) die('--date 需为 YYYY-MM-DD');

const TYPE = getArg('type', 'both');
if (!['direct', 'transfer', 'both'].includes(TYPE)) die('--type 只能是 direct / transfer / both');

const REPEAT = Math.max(1, Math.min(5, Number(getArg('repeat', 2)) || 1));

// ── 查询语句 ────────────────────────────────────────────────────────────
const CN_DATE = DATE.slice(0, 4) + '年' + (+DATE.slice(5, 7)) + '月' + (+DATE.slice(8, 10)) + '日';

const QUERY = {
  direct: FROM + '到' + TO + ' ' + CN_DATE + ' 的直飞航班，列出每个航班的航空公司、航班号、起飞时间、到达时间、经济舱票价（元）',
  transfer: FROM + '到' + TO + ' ' + CN_DATE + ' 的中转航班方案（含过夜中转），逐个方案列出中转城市、每一段的航班号与起飞到达时间、联程经济舱票价（元）',
};

// ── 接口 ────────────────────────────────────────────────────────────────
const ENDPOINT = 'https://externalcallback.ctrip.com/skills/api/crew/skillhub/searchInfo';

async function callWendao(query) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: { token: TOKEN, query } }),
    });
  } catch (e) {
    die('请求失败：' + e.message, '检查网络或代理。');
  }
  if (!res.ok) {
    die('接口 HTTP ' + res.status,
      res.status === 401 || res.status === 403
        ? 'token 无效或已过期，按 node scripts/doctor.js --probe 的引导重新设置 WENDAO_API_KEY。'
        : '稍后重试；持续失败时用 node scripts/doctor.js --probe 验证凭据。');
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    die('响应不是合法 JSON');
  }
  if (data && typeof data === 'object' && data.error) {
    const msg = String(data.error);
    const authIssue = /token|auth|unauthor|forbidden|invalid/i.test(msg);
    die('接口返回错误：' + msg,
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
    die('检索失败：' + err.message,
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

// ── 去重 ────────────────────────────────────────────────────────────────
function dedupe(list) {
  const map = new Map();
  for (const r of list) {
    const k = [r.no, r.date, r.dep, r.arr].join('|');
    const prev = map.get(k);
    if (!prev || r.price < prev.price) map.set(k, r);
  }
  return [...map.values()];
}

// ── 主流程 ──────────────────────────────────────────────────────────────
(async () => {
  const types = TYPE === 'both' ? ['direct', 'transfer'] : [TYPE];
  const raws = [];
  const all = [];

  for (const t of types) {
    for (let i = 0; i < REPEAT; i++) {
      const text = await callWendao(QUERY[t]);
      raws.push(text);
      const recs = parseFlights(text, DATE);
      all.push(...recs);
      console.error('  ' + t + ' #' + (i + 1) + ' → ' + recs.length + ' 条');
    }
  }

  if (hasFlag('raw')) {
    const txt = raws.join('\n\n' + '─'.repeat(60) + '\n\n');
    if (getArg('out')) {
      fs.writeFileSync(getArg('out'), txt, 'utf8');
      console.error('原始文本 → ' + getArg('out'));
    } else process.stdout.write(txt + '\n');
    return;
  }

  const merged = dedupe(all).sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.dep.localeCompare(b.dep));

  const json = JSON.stringify(merged, null, 1);
  if (getArg('out')) {
    fs.writeFileSync(getArg('out'), json, 'utf8');
    console.error('\u2713 ' + merged.length + ' 条 → ' + getArg('out'));
  } else {
    process.stdout.write(json + '\n');
  }
  if (!merged.length) {
    console.error('\u2716 未解析出航班。加 --raw 查看原始返回，并用 node scripts/doctor.js --probe 验证凭据。');
    process.exit(2);
  }
})();
