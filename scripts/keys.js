#!/usr/bin/env node
'use strict';
/**
 * keys.js — 外部服务凭据登记表，以及缺 key 时给用户的引导文案
 *
 * 被 amap_route.js / flight_query.js / doctor.js 共用，保证三处输出一致。
 * 凭据只从环境变量读取：不写入文件、不作为命令行参数传递、不回显完整内容。
 */

const SPECS = {
  VARIFLIGHT_MCP_KEY: {
    service: '飞常准 MCP',
    usage: '航班号 / 时刻 / 含税票价 / 余票（主数据源）',
    applyUrl: 'https://cmcp.variflight.com/',
    applyNote: '微信扫码或手机号登录，在控制台生成 MCP Key；每月 100 积分，按唯一「出发→到达」城市对计费',
    example: 'node scripts/flight_query.js --from SZX --to CGQ --weekend 2026-12-11 --leave-days 1 --both --out w1.json',
    required: true,
    fallback: '也可以把 Key 写进 ~/.workbuddy-ai/mcp.json 的 variflight-mcp.headers.Authorization（Bearer <Key>），脚本会自动读取。',
  },
  WENDAO_API_KEY: {
    service: '携程问道',
    usage: '机场粗筛 / 骨架摸底 / 执飞校验（可选，不封 CLI）',
    applyUrl: 'https://www.ctrip.com/wendao/openclaw',
    applyNote: '按页面指引申请并复制 API token；按日配额，比飞常准宽松，适合反复粗筛',
    example: "curl -sS -X POST 'https://externalcallback.ctrip.com/skills/api/crew/skillhub/searchInfo' -H 'Content-Type: application/json' -d \"{\\\"inputs\\\":{\\\"token\\\":\\\"$WENDAO_API_KEY\\\",\\\"query\\\":\\\"<提示词>\\\"}}\"",
    required: false,
    fallback: '不配置也能跑完整流程：跳过机场粗筛，直接把候选机场列给用户选；也失去执飞状态的交叉校验。提示词见 references/wendao-prompts.md。',
  },
  AMAP_API_KEY: {
    service: '高德开放平台',
    usage: '地理编码 + 驾车路径规划（机场 → 雪场 车程）',
    applyUrl: 'https://console.amap.com/dev/key/app',
    applyNote: '创建应用后新增 Key，服务平台选「Web服务」，并开通「地理编码」与「驾车路径规划」',
    example: 'node scripts/amap_route.js --from "<机场名称>" --to "<雪场名称>" --from-city "<城市>"',
    required: false,
    fallback: '不提供 key 时，改问「单程车程大概多少分钟」，加预留后继续，并在报告里注明车程为估算值。',
  },
};

// 中日韩字符按 2 列宽计算，用于对齐
const charWidth = (ch) => (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1);
const textWidth = (s) => [...s].reduce((n, ch) => n + charWidth(ch), 0);
const padEnd = (s, w) => s + ' '.repeat(Math.max(0, w - textWidth(s)));

const read = (envName) => (process.env[envName] || '').trim();

function status(envName) {
  const spec = SPECS[envName];
  if (!spec) throw new Error('未登记的凭据：' + envName);
  const value = read(envName);
  return { env: envName, spec, set: Boolean(value), length: value.length };
}

function statusLine(st) {
  const state = st.set ? `已设置（${st.length} 位）` : '未设置';
  return padEnd(st.env, 20) + padEnd(state, 16) + st.spec.service + ' · ' + st.spec.usage;
}

/**
 * 缺 key 或 key 不可用时给用户的完整引导，返回多行字符串。
 * opts.reason 用于替换首行，例如「环境变量 X 已设置但不可用：Invalid token.」
 */
function guide(envName, opts) {
  const spec = SPECS[envName];
  const rows = [
    ['macOS / Linux', `export ${envName}='你的 key'`],
    ['Windows CMD', `set ${envName}=你的 key`],
    ['Windows PowerShell', `$env:${envName}="你的 key"`],
    ['长期生效', '写入 ~/.zshrc 或 ~/.bash_profile；Windows 在「系统属性 → 环境变量」加用户级变量'],
  ];
  const w = Math.max(...rows.map((r) => textWidth(r[0]))) + 2;
  const IND = ' '.repeat(11);
  const item = (n, label, text) => `  ${n}. ${padEnd(label, 6)}${text}`;

  const lines = [
    (opts && opts.reason) || `缺少环境变量 ${envName}`,
    `  ${padEnd('用途', 9)}${spec.service} · ${spec.usage}`,
    '',
    item(1, '获取', spec.applyUrl),
    `${IND}${spec.applyNote}`,
    item(2, '设置', `变量名须完全一致：${envName}`),
    ...rows.map((r) => `${IND}${padEnd(r[0], w)}${r[1]}`),
    item(3, '单次', `${envName}="你的 key" ${spec.example}`),
    `${IND}仅对本次进程生效，不写入任何文件`,
    item(4, '验证', 'node scripts/doctor.js --probe'),
    '',
    opts && opts.tail
      ? '  ' + opts.tail
      : (opts && opts.reason
        ? '  按上面步骤重新申请或更换 key，然后在同一终端会话内重跑原命令。凭据只从环境变量读取：不写入 config、不写进脚本文件、不作为命令行参数传递、回复中不回显完整内容。'
        : '  设置后重跑原命令即可。凭据只从环境变量读取：不写入 config、不写进脚本文件、不作为命令行参数传递、回复中不回显完整内容。'),
  ];
  if (spec.fallback) lines.push('  ' + spec.fallback);
  return lines.join('\n');
}

/** 缺 key 则直接退出，并打印引导 */
function requireKey(envName) {
  const st = status(envName);
  if (st.set) return st;
  console.error('\u2716 ' + guide(envName));
  process.exit(1);
}

/**
 * 识别携程问道返回文本里的失败信息。
 * 该接口即使凭据无效也回 200，错误藏在 result 字符串里（形如 {"error": "Invalid token."}）。
 * 返回 { kind, message }，kind 为 'auth' | 'quota' | 'empty'；无异常时返回 null。
 */
const AUTH_PAT = /invalid\s*token|token[^，。]{0,8}(无效|失效|过期|不正确)|unauthor|forbidden|未授权|请先登录/i;
const QUOTA_PAT = /limit\s*exceeded|quota|配额|调用次数|次数已用完|too\s*many\s*requests/i;

function detectWendaoError(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return { kind: 'empty', message: '返回内容为空' };

  let parsed = null;
  if (s.startsWith('{') && s.endsWith('}')) {
    try { parsed = JSON.parse(s); } catch (e) { parsed = null; }
  }
  const inner = parsed && typeof parsed === 'object' && typeof parsed.error === 'string' ? parsed.error.trim() : '';

  if (inner) {
    const kind = AUTH_PAT.test(inner) ? 'auth' : QUOTA_PAT.test(inner) ? 'quota' : 'auth';
    return { kind, message: inner };
  }
  if (s.length <= 160 && AUTH_PAT.test(s)) return { kind: 'auth', message: s };
  if (s.length <= 160 && QUOTA_PAT.test(s)) return { kind: 'quota', message: s };
  return null;
}

module.exports = { SPECS, status, statusLine, guide, requireKey, detectWendaoError, textWidth, padEnd };
