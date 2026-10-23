#!/usr/bin/env node
'use strict';
/**
 * mcp_config.js — 一条命令把飞常准 MCP 写进 agent 的 MCP 配置
 *
 * 为什么单独一个脚本：飞常准 MCP 是必选数据源，但手动编辑 MCP 配置文件容易
 * 写错结构、覆盖掉别的 MCP、或者把 key 贴进仓库。这里做成幂等合并 +
 * 写前备份 + 不回显 key。
 *
 * 用法：
 *   VARIFLIGHT_MCP_KEY="你的 key" node scripts/mcp_config.js --write
 *       写进已存在的 MCP 配置（已有内容先备份到 .bak-<时间戳>）
 *   node scripts/mcp_config.js --write --file <path>
 *       指定配置文件；也可用环境变量 SKI_MCP_CONFIG 统一指定
 *   node scripts/mcp_config.js --check
 *       只看有没有配好、是否与环境变量一致，不写文件
 *   node scripts/mcp_config.js --print
 *       打印将要写入的片段（key 打码）
 *   node scripts/mcp_config.js --remove
 *       移除 variflight-mcp 条目（先备份）
 *
 * 写完之后还需要在你所用 agent 的连接器管理里把这个 MCP 设为信任（Trust），
 * 新 MCP 才会生效——这一步无法用脚本代替。
 */

const fs = require('fs');
const path = require('path');
const mcpJson = require('./mcp_json');

const SERVER_NAME = mcpJson.SERVER_NAME;
// `/legacy` 是兼容地址；标准 MCP 客户端用 .../mcp/api
const ENDPOINT = 'https://c-gw.variflight.com/chat_message/mcp/api/legacy';

const args = process.argv.slice(2);
const has = (f) => args.includes('--' + f);
const getArg = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i > -1 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};

// 路径优先级：--file > SKI_MCP_CONFIG > 已存在的 MCP 配置 > 默认位置
const configPath = () => getArg('file') || mcpJson.writeTarget();
const mask = (k) => (k ? k.slice(0, 6) + '…' + k.slice(-4) : '');
// key 只从环境变量读：命令行参数会留在 shell history 和进程列表里
const key = () => (process.env.VARIFLIGHT_MCP_KEY || '').trim();

function readConfig(p) {
  if (!fs.existsSync(p)) return { data: { mcpServers: {} }, existed: false };
  const raw = fs.readFileSync(p, 'utf8');
  if (!raw.trim()) return { data: { mcpServers: {} }, existed: true };
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error('\u2716 ' + p + ' 不是合法 JSON，未做任何改动。');
    console.error('  先手工修好它，或用 --file 指定另一个路径：' + e.message);
    process.exit(1);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    console.error('\u2716 ' + p + ' 顶层不是对象，未做任何改动。');
    process.exit(1);
  }
  if (!data.mcpServers || typeof data.mcpServers !== 'object') data.mcpServers = {};
  return { data, existed: true };
}

function entryFor(k) {
  return {
    url: ENDPOINT,
    headers: { Authorization: 'Bearer ' + k },
  };
}

function backup(p) {
  if (!fs.existsSync(p)) return '';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const b = p + '.bak-' + stamp;
  fs.copyFileSync(p, b);
  return b;
}

function writeConfig(p, data) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const b = backup(p);
  const tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch (_) { /* Windows 上无意义 */ }
  return b;
}

// ── 命令 ────────────────────────────────────────────────────────────────
const p = configPath();
const { data, existed } = readConfig(p);
const current = data.mcpServers[SERVER_NAME];

if (has('check')) {
  const envKey = key();
  console.log('配置文件 ' + p + (existed ? '' : '（尚不存在）'));
  if (!current) {
    console.log('状态     ' + SERVER_NAME + ' 未配置');
    console.log('');
    console.log(manualGuideForWrite());
    process.exit(1);
  }
  const auth = String((current.headers || {}).Authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  const cfgKey = m ? m[1].trim() : '';
  console.log('状态     ' + SERVER_NAME + ' 已配置');
  console.log('地址     ' + (current.url || '(缺 url)'));
  console.log('Key      ' + (cfgKey ? mask(cfgKey) + '（' + cfgKey.length + ' 位）' : '(缺 Authorization)'));
  if (envKey && cfgKey && envKey !== cfgKey) {
    console.log('注意     环境变量里的 key 与配置文件里的不一致，脚本会优先用环境变量');
  }
  if (current.url !== ENDPOINT) {
    console.log('注意     地址与默认的兼容地址不同：' + ENDPOINT);
  }
  const ok = Boolean(cfgKey) && current.url === ENDPOINT;
  console.log('');
  console.log(ok ? '\u2713 可以直接用：node scripts/doctor.js --probe 验证连通性（免费）'
    : '\u2716 配置不完整，重跑 --write 覆盖');
  process.exit(ok ? 0 : 1);
}

if (has('print')) {
  const k = key() || 'YOUR_KEY';
  console.log(JSON.stringify({ mcpServers: { [SERVER_NAME]: entryFor(k) } }, null, 2)
    .replace(k, k === 'YOUR_KEY' ? k : mask(k)));
  process.exit(0);
}

if (has('remove')) {
  if (!current) {
    console.log(SERVER_NAME + ' 本来就没配置，无需改动');
    process.exit(0);
  }
  delete data.mcpServers[SERVER_NAME];
  const b = writeConfig(p, data);
  console.log('\u2713 已移除 ' + SERVER_NAME + (b ? '\n  备份 ' + b : ''));
  console.log('  提示：环境变量 VARIFLIGHT_MCP_KEY 仍然有效，脚本会优先读它');
  process.exit(0);
}

if (has('write')) {
  const k = key();
  if (!k) {
    console.error('\u2716 没有拿到 key，未做任何改动。');
    console.error('  用法：VARIFLIGHT_MCP_KEY="你的 key" node scripts/mcp_config.js --write');
    console.error('  申请：https://cmcp.variflight.com/');
    process.exit(1);
  }
  if (k.length < 16) {
    console.error('\u2716 key 只有 ' + k.length + ' 位，看起来不完整，未做任何改动。');
    process.exit(1);
  }

  const others = Object.keys(data.mcpServers).filter((n) => n !== SERVER_NAME);
  const replaced = Boolean(current);
  data.mcpServers[SERVER_NAME] = entryFor(k);
  const b = writeConfig(p, data);

  console.log('\u2713 已写入 ' + p);
  console.log('  ' + SERVER_NAME + '  ' + (replaced ? '已更新' : '已新增') + '  Key ' + mask(k));
  if (others.length) console.log('  保留其他 MCP：' + others.join(', '));
  if (b) console.log('  备份 ' + b);
  console.log('');
  console.log('还差一步（脚本无法代劳）：');
  console.log('  在你所用 agent 的连接器管理里找到 ' + SERVER_NAME + '，设为信任（Trust）');
  console.log('  启用后验证：node scripts/doctor.js --probe（免费，不扣积分）');
  process.exit(0);
}

function manualGuideForWrite() {
  return [
    '配置方法：',
    '',
    '  VARIFLIGHT_MCP_KEY="你的 key" node scripts/mcp_config.js --write',
    '',
    '  申请 key：https://cmcp.variflight.com/',
    '  写入位置：' + p,
    '',
    '  写完后还要在你所用 agent 的连接器管理里把它设为信任（Trust）。',
    '  不想写文件也可以只设环境变量 VARIFLIGHT_MCP_KEY，脚本优先读它。',
  ].join('\n');
}

console.error('未知命令。可用：--write | --check | --print | --remove');
console.error('  例：VARIFLIGHT_MCP_KEY="你的 key" node scripts/mcp_config.js --write');
process.exit(1);
