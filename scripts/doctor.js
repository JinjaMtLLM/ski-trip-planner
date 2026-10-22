#!/usr/bin/env node
'use strict';
/**
 * doctor.js — 检查外部服务的凭据状态与连通性
 *
 * 用法：
 *   node scripts/doctor.js               只检查环境变量 / mcp.json 是否配置（零成本）
 *   node scripts/doctor.js --probe       加发**零成本**真实请求验证可用性
 *   node scripts/doctor.js --probe-wendao  额外探活问道（消耗 1 次日配额，20–60 秒）
 *   node scripts/doctor.js --probe-all     等价于 --probe --probe-wendao
 *   node scripts/doctor.js --manual      用户拒绝配置任何 key：输出手动录入清单，退出码 0
 *   node scripts/doctor.js --json        机器可读结果
 *
 * 检测成本（重要）：
 *   飞常准 MCP  initialize + tools/list 不扣积分 → 完全免费
 *   高德        1 次地理编码，在免费额度内 → 不计费
 *   携程问道    1 次真实查询，扣 1 次日配额且要等 20–60 秒 → 默认不探活
 *
 * 退出码：
 *   0  必选凭据可用，或已显式声明走手动模式（--manual）
 *   1  必选凭据缺失或不可用（仍可改走 --manual，不是死路）
 */

const { SPECS, ROLES, ORDER, status, statusLine, guide, manualGuide, detectWendaoError, padEnd } = require('./keys');
const { rpc, openSession, token, VariflightError } = require('./variflight');
const cache = require('./cache');

const args = process.argv.slice(2);
const has = (f) => args.includes('--' + f);

const AMAP_GEOCODE = 'https://restapi.amap.com/v3/geocode/geo';
const WENDAO_ENDPOINT = 'https://externalcallback.ctrip.com/skills/api/crew/skillhub/searchInfo';

/** 缓存目录与条目数：让用户知道「为什么这次没扣分」或「旧数据存在哪」 */
function cacheStatus() {
  const dir = cache.cacheDir();
  if (!dir) return { dir: '', entries: 0 };
  return { dir, entries: cache.list().length };
}

const INFOCODE = {
  10001: 'key 不正确或已过期',
  10002: '未开通该接口权限',
  10003: '访问频率超限',
  10004: '当日调用量已超限',
  10009: 'key 的平台类型不对，需使用「Web服务」类型',
  20003: '配额已用尽',
};

async function probeAmap(key) {
  const url = AMAP_GEOCODE + '?key=' + encodeURIComponent(key) + '&address=' + encodeURIComponent('北京');
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, detail: 'HTTP ' + res.status };
    const data = await res.json();
    if (String(data.status) === '1' && data.infocode === '10000') {
      return { ok: true, detail: '地理编码可用' };
    }
    return { ok: false, detail: (INFOCODE[data.infocode] || data.info || '未知错误') + '（infocode ' + data.infocode + '）' };
  } catch (e) {
    return { ok: false, detail: '网络请求失败：' + e.message };
  }
}

async function probeWendao(tok) {
  const body = { inputs: { token: tok, query: '查询明天北京到上海的直飞航班，列出航班号和票价' } };
  try {
    const res = await fetch(WENDAO_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, detail: 'token 无效或已过期（HTTP ' + res.status + '）' };
    if (!res.ok) return { ok: false, detail: 'HTTP ' + res.status };
    const data = await res.json();
    const r = data && typeof data === 'object' && 'result' in data ? data.result : data;
    const text = typeof r === 'string' ? r : r && typeof r === 'object' ? (r.content || JSON.stringify(r)) : '';
    const err = detectWendaoError(text);
    if (err) {
      const detail = err.kind === 'auth' ? 'token 无效或已过期：' + err.message
        : err.kind === 'quota' ? '当日调用配额已用尽：' + err.message
          : '返回内容为空';
      return { ok: false, detail, kind: err.kind };
    }
    return { ok: true, detail: '接口返回正文 ' + String(text).length + ' 字' };
  } catch (e) {
    return { ok: false, detail: '网络请求失败：' + e.message };
  }
}

/** 飞常准 MCP：initialize + tools/list，两者都不扣积分 */
async function probeVariflight() {
  try {
    const { info } = await openSession();
    const { json } = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const n = ((json.result && json.result.tools) || []).length;
    if (!n) return { ok: false, detail: '握手成功但没返回工具列表' };
    return { ok: true, detail: `MCP 可用（${(info && info.name) || 'unknown'}，${n} 个工具）` };
  } catch (e) {
    if (e instanceof VariflightError) {
      return { ok: false, detail: e.message, kind: e.kind };
    }
    return { ok: false, detail: '探活失败：' + e.message };
  }
}

const PROBES = { AMAP_API_KEY: probeAmap, WENDAO_API_KEY: probeWendao, VARIFLIGHT_MCP_KEY: probeVariflight };

// ── 手动模式 ────────────────────────────────────────────────────────────
if (has('manual')) {
  const manual = {
    mode: 'manual',
    ok: true,
    reason: '用户选择不配置任何 key，改用手动录入航班',
    checklist: [
      '航班：出发地、到达地、日期、航班号、起飞时刻、落地时刻（跨日注明）、票面价',
      '中转：中转城市、停留分钟数（可用 stops 或直接写 tag）',
      '车程：每个候选机场到雪场的单程分钟数（含预留）',
      '雪场：日场起止、夜场起止与休息日、雪季',
      '住宿：雪场每晚、转机城市每晚',
      '请假口径：上班 / 半天分界 / 下班三个时刻',
    ],
    next: 'node scripts/planner.js config.json',
    doc: 'references/manual-flights.md',
  };
  if (has('json')) {
    console.log(JSON.stringify(manual, null, 2));
    process.exit(0);
  }
  console.log('手动录入模式');
  console.log('─'.repeat(60));
  console.log('不配置任何 key 也能把行程算出来，只是没有自动比价。');
  console.log('需要向用户收集：');
  for (const c of manual.checklist) console.log('  · ' + c);
  console.log('');
  console.log('然后：' + manual.next);
  console.log('字段与示例：' + manual.doc);
  process.exit(0);
}

// ── 常规检查 ────────────────────────────────────────────────────────────
async function main() {
  const doProbe = has('probe') || has('probe-all') || has('probe-wendao');
  const probeWendaoToo = has('probe-wendao') || has('probe-all');

  const rows = [];
  for (const name of ORDER) {
    const st = status(name);
    // 飞常准 key 允许来自 ~/.workbuddy-ai/mcp.json，status() 只看环境变量，这里补上
    if (name === 'VARIFLIGHT_MCP_KEY') {
      const k = token();
      st.set = Boolean(k);
      st.length = k.length;
    }
    const row = {
      env: name, set: st.set, length: st.length,
      role: st.spec.role, roleLabel: ROLES[st.spec.role],
      service: st.spec.service, usage: st.spec.usage,
      probeCost: st.spec.probeCost,
      applyUrl: st.spec.applyUrl,
    };

    const shouldProbe = doProbe && st.set && (name !== 'WENDAO_API_KEY' || probeWendaoToo);
    if (shouldProbe) {
      row.probe = await PROBES[name](process.env[name] ? process.env[name].trim() : '');
    } else if (doProbe && st.set && name === 'WENDAO_API_KEY') {
      row.probe = { skipped: true, detail: '默认不探活（会消耗 1 次日配额），需要时加 --probe-wendao' };
    }
    rows.push(row);
  }

  const requiredRows = rows.filter((r) => r.role === 'required');
  const requiredOk = requiredRows.every((r) => r.set && (!r.probe || r.probe.ok));
  const fallbackRow = rows.find((r) => r.role === 'fallback');
  const fallbackOk = !fallbackRow || !fallbackRow.set || !fallbackRow.probe || fallbackRow.probe.ok;
  const recommendedOk = rows.filter((r) => r.role === 'recommended').every((r) => !r.set || !r.probe || r.probe.ok);

  const cs = cacheStatus();

  if (has('json')) {
    console.log(JSON.stringify({
      ok: requiredOk,
      canRunAutomatically: requiredOk,
      manualModeAvailable: true,
      mode: requiredOk ? 'auto' : 'manual',
      keys: rows,
      cache: cs,
    }, null, 2));
    process.exit(requiredOk ? 0 : 1);
  }

  console.log('凭据检查' + (doProbe ? '（含真实请求验证）' : '（零成本，未发请求）'));
  console.log('─'.repeat(60));
  for (const r of rows) {
    console.log(statusLine({ env: r.env, spec: SPECS[r.env], set: r.set, length: r.length }));
    if (r.probe) {
      const mark = r.probe.skipped ? '· ' : r.probe.ok ? '✔ ' : '✖ ';
      console.log(' '.repeat(20) + mark + r.probe.detail);
    }
  }
  console.log(padEnd('缓存', 20) + (cs.dir ? cs.entries + ' 条 · ' + cs.dir : '不可写，已关闭'));
  console.log('');

  if (!requiredOk) {
    const bad = requiredRows.find((r) => !(r.set && (!r.probe || r.probe.ok)));
    const p = bad.probe;
    let reason;
    let tail;
    if (bad.set && p && p.kind === 'quota') {
      reason = `${bad.env} 有效，但${p.detail}`;
      tail = '配额恢复后重跑原命令；或按步骤 2 换一个 key；也可以直接走手动录入（node scripts/doctor.js --manual）。';
    } else if (bad.set) {
      reason = `环境变量 ${bad.env} 已设置但不可用（${p ? p.detail : '未通过验证'}）`;
      tail = '按步骤 2 重新设置后，在同一终端会话内重跑原命令；也可以直接走手动录入（node scripts/doctor.js --manual）。';
    }
    console.error(guide(bad.env, { reason, tail }));
    console.error('');
    console.error(manualGuide('必选凭据 ' + bad.env + ' 不可用'));
    process.exit(1);
  }

  // 必选没问题，再看兜底与建议项
  if (!fallbackOk) {
    console.log('→ 高德凭据不可用（兜底项）：仅在问道给不出车程、或需要精确值时才会用到，可先跳过。');
    console.error(guide('AMAP_API_KEY', {
      reason: '环境变量 AMAP_API_KEY 已设置但不可用（' + (fallbackRow.probe ? fallbackRow.probe.detail : '未通过验证') + '）',
    }));
    process.exit(0);
  }

  if (!recommendedOk) {
    const w = rows.find((r) => r.role === 'recommended');
    console.log('→ 问道凭据不可用（建议项）：跳过机场对比，直接把候选机场列给用户选。');
    console.log('  不要改用飞常准代做粗筛 —— 它按城市对扣积分，只留给第 3 步的详细检索。');
    console.error(guide('WENDAO_API_KEY', {
      reason: '环境变量 WENDAO_API_KEY 已设置但不可用（' + (w.probe ? w.probe.detail : '未通过验证') + '）',
    }));
    process.exit(0);
  }

  const missing = rows.filter((r) => !r.set);
  const tail = missing.length
    ? '未配置：' + missing.map((r) => r.roleLabel + ' ' + r.env).join('、') + '（按各自降级路径继续）'
    : '';
  console.log('→ 必选凭据可用，进入流程。' + tail);
  if (missing.some((r) => r.role === 'recommended')) {
    console.log('  建议补上问道：它是粗筛的唯一来源，缺了只能让用户手选机场，不要用飞常准顶替。');
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('✖ 检查过程出错：' + e.message);
  process.exit(1);
});
