'use strict';
/**
 * mcp_json.js — 定位并解析 agent 的 MCP 配置文件
 *
 * 各家 agent 的 MCP 配置落地位置不一样，还可能同时存在多份。这里把「找文件」
 * 收成一处，避免每个脚本各写一份路径：
 *
 *   1. 环境变量 SKI_MCP_CONFIG（显式指定，优先级最高）
 *   2. ~/.workbuddy/mcp.json
 *   3. ~/.workbuddy-ai/mcp.json
 *
 * 读取时按顺序取第一份能解析出目标条目的；写入时优先写已有的那份，
 * 都不存在才新建第一顺位。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const SERVER_NAME = 'variflight-mcp';

/** 按优先级列出候选路径（不判存在） */
function candidates() {
  const env = (process.env.SKI_MCP_CONFIG || '').trim();
  return [
    env ? path.resolve(env) : '',
    path.join(HOME, '.workbuddy', 'mcp.json'),
    path.join(HOME, '.workbuddy-ai', 'mcp.json'),
  ].filter(Boolean);
}

const isFile = (p) => {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
};

/** 已存在的第一份；都不存在返回空串 */
function existing() {
  return candidates().find(isFile) || '';
}

/** 写入目标：显式指定的路径照写（不存在则新建），否则优先已有的那份 */
function writeTarget() {
  const env = (process.env.SKI_MCP_CONFIG || '').trim();
  if (env) return path.resolve(env);
  return existing() || candidates()[0];
}

/** 把家目录换成 ~，用于打印 */
function short(p) {
  return p && p.startsWith(HOME) ? '~' + p.slice(HOME.length) : String(p || '');
}

/** 读一份配置，返回 { path, servers }；读不到或不是合法 JSON 返回 null */
function read(p) {
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!j || typeof j !== 'object') return null;
    return { path: p, servers: j.mcpServers || j.mcp || {} };
  } catch (_) {
    return null;
  }
}

/** 在所有候选里找指定 MCP 的条目，返回 { path, server } 或 null */
function findServer(name = SERVER_NAME) {
  for (const p of candidates()) {
    const cfg = read(p);
    if (cfg && cfg.servers && cfg.servers[name]) return { path: p, server: cfg.servers[name] };
  }
  return null;
}

/** 从 Authorization 头里取 Bearer token；找不到返回空串 */
function bearerOf(server) {
  const auth = (server && server.headers && server.headers.Authorization) || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(auth).trim());
  return m ? m[1].trim() : '';
}

module.exports = {
  SERVER_NAME, candidates, existing, writeTarget, short, read, findServer, bearerOf,
};
