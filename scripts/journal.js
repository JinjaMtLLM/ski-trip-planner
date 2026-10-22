#!/usr/bin/env node
'use strict';
/**
 * journal.js — 脚本间调用的运行记录
 *
 * 为什么需要：脚本串联时，中间态只活在进程内存里。一旦某一步抛错，
 * 上层拿到的只有一句错误消息，没法判断是参数错了、SQL 错了、还是接口抽风；
 * 而重新跑一遍又要花钱（飞常准按 O-D 对扣积分）。
 *
 * 所以每次运行写一个 JSON 到 <缓存目录>/runs/：
 *   - 完整命令行、时间、退出状态
 *   - 每一步的输入 / 输出（数组只留条数与样本，完整数据靠 cache key 指过去）
 *   - 出错时的 name / kind / message / hint / stack
 *   - 本次用到的缓存 key —— 原始返回都在缓存里，可以据此手工拼结果
 *
 * 这份记录就是给 LLM 做「中间胶水层」用的：读它 → 看哪一步断了 → 用缓存里的
 * 原始数据手工补完，或者改参数重跑，而不是整条链路重来一遍。
 *
 * 用法：
 *   const journal = require('./journal');
 *   const run = journal.begin('flight_query.js', process.argv.slice(2));
 *   run.step('dates', { input: {...}, output: {...} });
 *   run.done({ out: 'w1.json' });          // 成功
 *   run.fail(err);                          // 失败，返回记录路径
 *
 * 环境变量 SKI_NO_JOURNAL=1 或构造时 enabled:false 可关闭。
 * 记录不落仓库：默认在 <技能根>/.cache/runs/，已在 .gitignore 里。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cache = require('./cache');

const SCHEMA = 1;

/** 目录：跟着缓存目录走，缓存不可用时退回系统临时目录 */
function runsDir() {
  const base = cache.cacheDir() || path.join(os.tmpdir(), 'ski-trip-planner-cache');
  const d = path.join(base, 'runs');
  try {
    fs.mkdirSync(d, { recursive: true });
    fs.accessSync(d, fs.constants.W_OK);
    return d;
  } catch (_) {
    return '';
  }
}

/**
 * 安全序列化：数组只留条数与样本，长字符串截断，避免把几百条航班塞进记录。
 * 要看完整数据就去对应的缓存条目。
 */
function brief(v, depth = 0, seen = new WeakSet()) {
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t === 'string') return v.length > 400 ? v.slice(0, 400) + `…(${v.length} 字)` : v;
  if (t === 'number' || t === 'boolean') return v;
  if (t === 'function') return '[Function]';
  if (t === 'bigint') return String(v);
  if (t === 'symbol') return String(v);

  if (v instanceof Error) {
    return { name: v.name, message: v.message, kind: v.kind, hint: v.hint };
  }
  if (seen.has(v)) return '[Circular]';
  if (depth > 4) return Array.isArray(v) ? `[Array(${v.length})]` : '[Object]';
  seen.add(v);

  if (Array.isArray(v)) {
    const head = v.slice(0, 2).map((x) => brief(x, depth + 1, seen));
    return v.length <= 2 ? head : [...head, `…共 ${v.length} 条`];
  }
  if (v instanceof Date) return v.toISOString();
  if (t === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = brief(v[k], depth + 1, seen);
    return out;
  }
  return String(v);
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

/** 按错误类型给「下一步怎么办」的建议，直接给 LLM 看 */
function hintsFor(err, ctx = {}) {
  const kind = (err && err.kind) || '';
  const msg = String((err && err.message) || '');
  const out = [];

  if (kind === 'auth') {
    out.push('凭据无效：跑 node scripts/doctor.js --probe 确认（免费），或 node scripts/doctor.js --manual 走手动录入。');
  } else if (kind === 'quota') {
    out.push('配额用尽：去掉 --refresh 重跑会用缓存；或换 key；或走手动录入。');
  } else if (kind === 'network' || /fetch|ECONN|ETIMEDOUT|网络/i.test(msg)) {
    out.push('网络问题：先确认能连上接口域名，再重跑。');
  } else if (kind === 'tool') {
    out.push('SQL / 工具报错：读 steps 里最后一条 call.input.sql，逐字核对参数名与字面量。');
  } else if (kind === 'arg') {
    out.push('参数问题：检查 --from / --to 是否为 IATA 码，日期是否 YYYY-MM-DD。');
  }

  if (ctx.truncated) out.push('有结果被截断：调小 --per-transfer 或 --chunk 重跑，截断的缓存不会被直接复用。');

  if (ctx.cacheMode === 'off') {
    out.push('本次带了 --no-cache，没有缓存可复用；去掉它重跑会写缓存，之后再失败就能兜底。');
    out.push('要手工出结果：读 steps 里失败那条 call.input.sql，单独查一次，把行拼成 { out, ret } 直接喂 planner.js。');
  } else {
    out.push('重跑同一条命令会命中缓存，不会重复扣分。');
    out.push('每次调用的原始返回都在缓存里：node scripts/cache.js list 看 key，show <key> 看原文。');
    out.push('要手工出结果：读 steps 里的 input 和 cacheKey，用缓存里的原始行拼 { out, ret } 直接喂 planner.js。');
  }
  return out;
}

/**
 * 开始一次运行记录。
 * @param {string} script  脚本名，例如 'flight_query.js'
 * @param {string[]} argv  命令行参数（不含 node 与脚本路径）
 * @param {{enabled?:boolean, quiet?:boolean}} [opts]
 */
function begin(script, argv = [], opts = {}) {
  const disabled = opts.enabled === false || process.env.SKI_NO_JOURNAL === '1';
  const dir = disabled ? '' : runsDir();
  const startedAt = new Date();
  const runId = stamp(startedAt) + '-' + process.pid + '-' + String(script).replace(/\W+/g, '_');
  const steps = [];
  const cacheKeys = [];
  let finished = false;

  const record = (extra = {}) => ({
    schema: SCHEMA,
    runId,
    script,
    argv,
    pid: process.pid,
    cwd: process.cwd(),
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    steps,
    cacheKeys: [...new Set(cacheKeys)],
    cacheDir: cache.cacheDir(),
    ...extra,
  });

  function persist(data) {
    if (!dir) return '';
    const p = path.join(dir, runId + '.json');
    try {
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, p);
      // 顺手在索引里留一行，方便 --list 快速扫
      try {
        fs.appendFileSync(path.join(dir, 'index.jsonl'), JSON.stringify({
          runId, script, at: data.startedAt, ok: data.ok,
          error: data.error ? data.error.message : null,
        }) + '\n', 'utf8');
      } catch (_) { /* 索引失败不影响主记录 */ }
      return p;
    } catch (_) {
      return '';
    }
  }

  const run = {
    runId,
    get enabled() { return Boolean(dir); },
    dir,

    /** 记一步中间态。input/output 会被 brief() 压缩，不会把全量航班写进来。 */
    step(name, payload = {}) {
      if (finished) return run;
      const s = { at: new Date().toISOString(), name };
      if (payload.input !== undefined) s.input = brief(payload.input);
      if (payload.output !== undefined) s.output = brief(payload.output);
      if (payload.note) s.note = payload.note;
      if (payload.cacheKey) { s.cacheKey = payload.cacheKey; cacheKeys.push(payload.cacheKey); }
      if (payload.error) s.error = brief(payload.error);
      steps.push(s);
      return run;
    },

    /** 成功收尾。extra 可带 out、counts 等。 */
    done(extra = {}) {
      if (finished) return '';
      finished = true;
      return persist(record({ ok: true, ...extra }));
    },

    /** 失败收尾：写记录并返回路径；不抛异常，由调用方决定怎么退出。 */
    fail(err, extra = {}) {
      if (finished) return '';
      finished = true;
      const e = err instanceof Error ? err : new Error(String(err));
      const data = record({
        ok: false,
        error: {
          name: e.name,
          message: e.message,
          kind: e.kind || '',
          hint: e.hint || '',
          stack: String(e.stack || '').split('\n').slice(0, 8).join('\n'),
        },
        hints: hintsFor(e, extra),
        ...extra,
      });
      return persist(data);
    },

    /** 不落盘，只拿压缩后的上下文用于控制台输出 */
    snapshot() { return record({ ok: null }); },
  };

  return run;
}

/** 失败时打印给用户/LLM 看的那一小段 */
function reportFailure(run, err, extra = {}) {
  const p = run.fail(err, extra);
  const lines = [];
  if (p) {
    lines.push('');
    lines.push('运行记录 ' + p);
    lines.push('  含：命令行、每步输入输出、出错位置、用到的缓存 key');
    for (const h of hintsFor(err, extra)) lines.push('  · ' + h);
  }
  return lines.join('\n');
}

// ── CLI：查看历史记录 ──────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'list';
  const dir = runsDir();

  if (!dir) {
    console.log('运行记录目录不可写');
    process.exit(0);
  }

  if (cmd === 'path') {
    console.log(dir);
  } else if (cmd === 'list') {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch (_) { names = []; }
    if (!names.length) { console.log('运行记录目录 ' + dir + '\n（空）'); process.exit(0); }
    const rows = names.map((n) => {
      const p = path.join(dir, n);
      try { return { p, ...JSON.parse(fs.readFileSync(p, 'utf8')) }; } catch (_) { return null; }
    }).filter(Boolean).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));

    console.log('运行记录 ' + dir);
    console.log('');
    for (const r of rows.slice(0, 40)) {
      const state = r.ok ? '成功' : '失败';
      const err = r.error ? '  ' + r.error.message.slice(0, 60) : '';
      console.log([state, r.script.padEnd(18), r.startedAt.slice(0, 19), r.runId, err].join('  '));
    }
    console.log('\n共 ' + rows.length + ' 条' + (rows.length > 40 ? '（只列最近 40 条）' : ''));
  } else if (cmd === 'show') {
    const id = argv[1];
    if (!id) { console.error('用法：node scripts/journal.js show <runId>'); process.exit(1); }
    const p = path.join(dir, id.endsWith('.json') ? id : id + '.json');
    if (!fs.existsSync(p)) { console.error('没有这条记录：' + id); process.exit(1); }
    console.log(fs.readFileSync(p, 'utf8'));
  } else if (cmd === 'clear') {
    let n = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') && !f.endsWith('.jsonl')) continue;
      try { fs.unlinkSync(path.join(dir, f)); n++; } catch (_) { /* ignore */ }
    }
    console.log('删除 ' + n + ' 个文件');
  } else {
    console.error('未知命令：' + cmd + '\n可用：path | list | show <runId> | clear');
    process.exit(1);
  }
}

module.exports = { begin, reportFailure, hintsFor, brief, runsDir, SCHEMA };
