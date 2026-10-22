#!/usr/bin/env node
'use strict';
/**
 * doctor.js — 检查两个外部服务的凭据状态
 *
 * 用法：
 *   node scripts/doctor.js            只检查环境变量是否设置
 *   node scripts/doctor.js --probe    各发一次真实请求，验证可用性
 *   node scripts/doctor.js --json     输出机器可读结果
 *
 * 退出码：必需凭据（WENDAO_API_KEY）可用为 0，否则为 1。
 * 高德凭据缺失或不可用不改变退出码，按「向用户询问单程车程」降级。
 */

const { SPECS, status, statusLine, guide, detectWendaoError } = require('./keys');

const args = process.argv.slice(2);
const has = (f) => args.includes('--' + f);

const AMAP_GEOCODE = 'https://restapi.amap.com/v3/geocode/geo';
const WENDAO_ENDPOINT = 'https://externalcallback.ctrip.com/skills/api/crew/skillhub/searchInfo';

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

async function probeWendao(token) {
  const body = { inputs: { token, query: '查询明天北京到上海的直飞航班，列出航班号和票价' } };
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

const PROBES = { AMAP_API_KEY: probeAmap, WENDAO_API_KEY: probeWendao };

async function main() {
  const names = ['WENDAO_API_KEY', 'AMAP_API_KEY'];
  const rows = [];
  for (const name of names) {
    const st = status(name);
    const row = { env: name, set: st.set, length: st.length, required: st.spec.required, service: st.spec.service, usage: st.spec.usage };
    if (st.set && has('probe')) {
      const r = await PROBES[name](process.env[name].trim());
      row.probe = r;
    }
    rows.push(row);
  }

  const requiredOk = rows.filter((r) => r.required).every((r) => r.set && (!r.probe || r.probe.ok));
  const amapRow = rows.find((r) => r.env === 'AMAP_API_KEY');
  const amapOk = amapRow.set && (!amapRow.probe || amapRow.probe.ok);

  if (has('json')) {
    console.log(JSON.stringify({ ok: requiredOk, keys: rows }, null, 2));
    process.exit(requiredOk ? 0 : 1);
  }

  console.log('凭据检查' + (has('probe') ? '（含真实请求验证）' : ''));
  console.log('─'.repeat(60));
  for (const r of rows) {
    console.log(statusLine({ env: r.env, spec: SPECS[r.env], set: r.set, length: r.length }));
    if (r.probe) {
      console.log(' '.repeat(17) + (r.probe.ok ? '✔ ' : '✖ ') + r.probe.detail);
    }
  }
  console.log('');

  if (!requiredOk) {
    const bad = rows.find((r) => r.required && !(r.set && (!r.probe || r.probe.ok)));
    const p = bad.probe;
    let reason;
    let tail;
    if (bad.set && p && p.kind === 'quota') {
      reason = `${bad.env} 有效，但${p.detail}`;
      tail = '配额恢复后重跑原命令；或按步骤 2 换用另一个 token。';
    } else if (bad.set) {
      reason = `环境变量 ${bad.env} 已设置但不可用（${p ? p.detail : '未通过验证'}）`;
      tail = '按步骤 2 重新设置后，在同一终端会话内重跑原命令。';
    }
    console.error(guide(bad.env, { reason, tail }));
    process.exit(1);
  }

  if (!amapOk) {
    if (!amapRow.set) {
      console.log('→ 高德凭据未设置，可按下面的引导配置；或向用户询问单程车程分钟数继续。');
      console.error(guide('AMAP_API_KEY'));
    } else {
      console.log('→ 高德凭据不可用，可按下面的引导重新配置；或向用户询问单程车程分钟数继续。');
      console.error(guide('AMAP_API_KEY', {
        reason: '环境变量 AMAP_API_KEY 已设置但不可用（' + (amapRow.probe ? amapRow.probe.detail : '未通过验证') + '）',
      }));
    }
    process.exit(0);
  }

  console.log('→ 两个凭据均可用，进入流程。');
  process.exit(0);
}

main().catch((e) => {
  console.error('✖ 检查过程出错：' + e.message);
  process.exit(1);
});
