#!/usr/bin/env node
'use strict';
/**
 * keys.js — 外部服务凭据登记表，以及缺 key 时给用户的引导文案
 *
 * 被 amap_route.js / flight_query.js / doctor.js / mcp_config.js 共用，保证三处输出一致。
 * 凭据只从环境变量读取：不写入文件、不作为命令行参数传递、不回显完整内容。
 *
 * 三个 key 分三档（role）：
 *   required     必选。缺了拿不到票价，但**不是死路**——可以走手动录入模式。
 *   recommended  建议配置。缺了降级，主线仍能跑完，只是少了粗筛这一步。
 *   fallback     兜底。只有主路径给不出值、或需要精确值时才用。
 */

const ROLES = {
  required: '必选',
  recommended: '建议',
  fallback: '兜底',
};

const SPECS = {
  VARIFLIGHT_MCP_KEY: {
    service: '飞常准 MCP',
    usage: '航班号 / 时刻 / 含税票价 / 余票（主数据源）',
    role: 'required',
    applyUrl: 'https://cmcp.variflight.com/',
    applyNote: '微信扫码或手机号登录 → 控制台生成 MCP Key。每月 100 积分，按唯一「出发→到达」城市对计费',
    probeCost: '免费 —— initialize + tools/list 不扣积分',
    example: 'node scripts/flight_query.js --from SZX --to CGQ --weekend 2027-01-08 --leave-days 1 --both --out w1.json',
    quickSetup: 'node scripts/mcp_config.js --write',
    quickSetupNote: '写进 agent 的 MCP 配置（已有配置先备份，路径可用 --file 或 SKI_MCP_CONFIG 指定），'
      + '之后所有脚本自动读取；还需在连接器管理里把它设为信任（Trust）才生效',
    fallback: '也可以只设环境变量 VARIFLIGHT_MCP_KEY，脚本优先读它。',
    manual: '完全不配置时走「手动录入航班」模式：用户自己给航班时刻与价格，或由你按公开信息整理后请用户核对，'
      + '再手工拼 config.json 交给 planner.js。见 references/manual-flights.md。',
  },
  WENDAO_API_KEY: {
    service: '携程问道',
    usage: '一次问全的机场对比 / 执飞校验（建议配置，不封 CLI）',
    role: 'recommended',
    applyUrl: 'https://www.ctrip.com/wendao/openclaw',
    applyNote: '按页面指引申请并复制 API token；按日配额，比飞常准宽松，适合反复粗筛',
    probeCost: '消耗 1 次日配额，响应 20–60 秒 —— 所以默认不探活，加 --probe-wendao 才测',
    example: "curl -sS -X POST 'https://externalcallback.ctrip.com/skills/api/crew/skillhub/searchInfo' -H 'Content-Type: application/json' -d \"{\\\"inputs\\\":{\\\"token\\\":\\\"$WENDAO_API_KEY\\\",\\\"query\\\":\\\"<提示词>\\\"}}\"",
    fallback: '不配置时跳过机场对比，直接把候选机场列给用户选。'
      + '**不要改用飞常准代做粗筛** —— 飞常准按城市对扣积分，只留给第 3 步的详细检索。'
      + '提示词见 references/wendao-prompts.md。',
  },
  AMAP_API_KEY: {
    service: '高德开放平台',
    usage: '驾车路径规划（机场 → 雪场 车程，兜底与精确值）',
    role: 'fallback',
    applyUrl: 'https://console.amap.com/dev/key/app',
    applyNote: '创建应用后新增 Key，服务平台选「Web服务」，并开通「地理编码」与「驾车路径规划」',
    probeCost: '消耗 1 次地理编码额度（在免费额度内，不计费）',
    example: 'node scripts/amap_route.js --from "<机场名称>" --to "<雪场名称>" --from-city "<城市>"',
    fallback: '只有问道给不出车程、或用户要求精确值、或没配问道 key 时才需要。'
      + '都没有时问用户「单程车程大概多少分钟」，加预留后继续，并在报告里注明是估算。',
  },
};

// 中日韩字符按 2 列宽计算，用于对齐
const charWidth = (ch) => (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1);
const textWidth = (s) => [...s].reduce((n, ch) => n + charWidth(ch), 0);
const padEnd = (s, w) => s + ' '.repeat(Math.max(0, w - textWidth(s)));

const read = (envName) => (process.env[envName] || '').trim();

/** 展示顺序：必选 → 建议 → 兜底 */
const ORDER = Object.keys(SPECS).sort((a, b) => {
  const rank = { required: 0, recommended: 1, fallback: 2 };
  return rank[SPECS[a].role] - rank[SPECS[b].role];
});

function status(envName) {
  const spec = SPECS[envName];
  if (!spec) throw new Error('未登记的凭据：' + envName);
  const value = read(envName);
  return { env: envName, spec, set: Boolean(value), length: value.length, role: spec.role };
}

function statusLine(st) {
  const state = st.set ? `已设置（${st.length} 位）` : '未设置';
  return padEnd(st.env, 20) + padEnd(state, 16) + padEnd(ROLES[st.spec.role] || '', 5) + st.spec.service;
}

/**
 * 缺 key 或 key 不可用时给用户的完整引导，返回多行字符串。
 * opts.reason 用于替换首行，例如「环境变量 X 已设置但不可用：Invalid token.」
 */
function guide(envName, opts) {
  const spec = SPECS[envName];
  const role = ROLES[spec.role] || '';
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
    ((opts && opts.reason) || `缺少环境变量 ${envName}`) + (role ? `    [${role}]` : ''),
    `  ${padEnd('用途', 9)}${spec.service} · ${spec.usage}`,
    '',
    item(1, '获取', spec.applyUrl),
    `${IND}${spec.applyNote}`,
  ];

  if (spec.quickSetup) {
    lines.push(
      item(2, '一键', `${envName}="你的 key" ${spec.quickSetup}`),
      `${IND}${spec.quickSetupNote}`,
      item(3, '设置', `或者只设环境变量，变量名须完全一致：${envName}`),
    );
  } else {
    lines.push(item(2, '设置', `变量名须完全一致：${envName}`));
  }

  lines.push(
    ...rows.map((r) => `${IND}${padEnd(r[0], w)}${r[1]}`),
    item(spec.quickSetup ? 4 : 3, '单次', `${envName}="你的 key" ${spec.example}`),
    `${IND}仅对本次进程生效，不写入任何文件`,
    item(spec.quickSetup ? 5 : 4, '验证', 'node scripts/doctor.js --probe'),
    `${IND}检测成本：${spec.probeCost}`,
    '',
    opts && opts.tail
      ? '  ' + opts.tail
      : (opts && opts.reason
        ? '  按上面步骤重新申请或更换 key，然后在同一终端会话内重跑原命令。凭据只从环境变量读取：不写入 config、不写进脚本文件、不作为命令行参数传递、回复中不回显完整内容。'
        : '  设置后重跑原命令即可。凭据只从环境变量读取：不写入 config、不写进脚本文件、不作为命令行参数传递、回复中不回显完整内容。'),
  );
  if (spec.fallback) lines.push('  ' + spec.fallback);
  if (spec.manual) lines.push('  ' + spec.manual);
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
 * 「一个都不配」时的说明。skill 必须允许用户拒绝配置所有凭据，
 * 这条路径不能只是「报错退出」，得能真的把行程算出来。
 */
function manualGuide(what) {
  return [
    (what || '没有可用的航班数据源') + '。可以完全不配置任何 key，改用手动录入：',
    '',
    '  1. 你（或用户）提供航班：出发地、到达地、日期、航班号、起飞/落地时刻、票面价，'
      + '中转再补中转城市与停留时长',
    '  2. 按 references/config-schema.md 的航班对象拼成 { out, ret } 两个数组',
    '  3. 填好 config.json，跑 node scripts/planner.js config.json',
    '',
    '  唯一拿不到的是「自动比价」——planner 的测算逻辑不依赖任何 API，',
    '  手动录入的航班照样能算出各请假档位的元/雪时排名。',
    '  详细字段与示例见 references/manual-flights.md。',
  ].join('\n');
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

module.exports = {
  SPECS, ROLES, ORDER, status, statusLine, guide, requireKey, manualGuide,
  detectWendaoError, textWidth, padEnd,
};
