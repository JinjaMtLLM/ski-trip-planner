#!/usr/bin/env node
'use strict';
/**
 * flight_query.js — 航班检索（飞常准 MCP）
 *
 * 三种用法，按日期窗口自动决定查几天：
 *
 *   1) 按请假档位自动铺日期（推荐）
 *      node flight_query.js --from SZX --to CGQ --weekend 2026-12-11 --leave-days 1 --both --out w1.json
 *        请假 1 天 → 去程 周四/周五/周六，返程 周日/周一/周二
 *
 *   2) 显式日期
 *      node flight_query.js --from SZX --to CGQ --dates 2026-12-11,2026-12-12
 *
 *   3) 单日（旧用法）
 *      node flight_query.js --from SZX --to CGQ --date 2026-12-11
 *
 * 选项：
 *   --from <城市或机场三字码>   城市码会覆盖同城所有机场（BJS = PEK+PKX）
 *   --to   <同上>
 *   --weekend <YYYY-MM-DD>     该日期所在周末的任意一天，自动归到周五
 *   --leave-days <0|0.5|1|2>   请假天数，决定去程/返程各铺几天
 *   --dates <a,b,c>            显式日期列表
 *   --date  <YYYY-MM-DD>       单日
 *   --both                     同时查返程方向，输出 { out, ret }
 *   --type <both|direct|transfer>  过滤，默认 both
 *   --per-transfer <n>         每个日期保留的中转条数，默认 15
 *   --chunk <n>                每次调用的数据源上限，默认 3（防 200 行截断）
 *   --out <file>               写入文件
 *   --raw                      只打印本次调用的元信息（积分、行数、截断、缓存）
 *   --quiet                    不打印进度
 *   --no-journal               不写运行记录（默认每次都写，见下）
 *
 * 运行记录（给「脚本出错后手工补救」用）：
 *   每次运行写一份 <缓存目录>/runs/<时间>-<pid>-flight_query.js.json，
 *   含完整命令行、每步输入输出、每次调用的 SQL 与缓存 key、出错位置与建议。
 *   出错时会把路径打出来；node scripts/journal.js list 可以看历史。
 *
 * 缓存（查询很贵，重跑不该再花一次钱）：
 *   --no-cache                 不读也不写缓存，强制真查
 *   --refresh                  无视缓存直接查，成功后覆盖
 *   --cache-ttl <分钟>         缓存新鲜期，默认 360（6 小时）；超期在正常模式下重查
 *   --cache-dir <目录>         指定缓存目录，等价于设 SKI_CACHE_DIR
 *   原始结果落盘在 <技能根>/.cache/<key>.json；维护见 node scripts/cache.js list|prune|clear
 *
 * 输出：JSON 数组（单方向）或 { out, ret }（--both），字段与 config.json 的航班对象一致。
 *   [{ date, dep, arr, arrDate?, price, tax?, no, tag, seg, seats?, stopMinutes? }, ...]
 *
 * 积分：按唯一「出发城市→到达城市」对计费，与日期数无关；命中缓存的 O-D 对不扣分。
 */

const fs = require('fs');
const { tokenSource } = require('./variflight');
const { queryFlights, leaveWindow, VariflightError } = require('./variflight');
const journal = require('./journal');

function die(msg, hint) {
  console.error('\u2716 ' + msg + (hint ? '\n  ' + hint : ''));
  process.exit(1);
}

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i > -1 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const hasFlag = (name) => args.includes('--' + name);

/** ISO → 「MM-DD HH:MM」本地时间，用于报告缓存数据的新鲜度 */
const fmtStamp = (iso) => {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso || '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const FROM = (getArg('from') || '').toUpperCase();
const TO = (getArg('to') || '').toUpperCase();
if (!FROM || !TO) die('缺少 --from / --to', '例：--from SZX --to CGQ');

// 缓存策略要在任何一次 cacheDir() 之前定好
const CACHE_DIR = getArg('cache-dir');
if (CACHE_DIR) process.env.SKI_CACHE_DIR = CACHE_DIR;
const CACHE = {
  mode: hasFlag('no-cache') ? 'off' : hasFlag('refresh') ? 'refresh' : 'auto',
  ttlMinutes: Number(getArg('cache-ttl', 360)),
};
if (!Number.isFinite(CACHE.ttlMinutes) || CACHE.ttlMinutes < 0) {
  die('--cache-ttl 需为不小于 0 的分钟数', '例：--cache-ttl 60');
}

const TYPE = getArg('type', 'both');
if (!['direct', 'transfer', 'both'].includes(TYPE)) die('--type 只能是 direct / transfer / both');

// ── 组装日期窗口 ────────────────────────────────────────────────────────
let outDates = [];
let retDates = [];
let windowNote = '';

const WEEKEND = getArg('weekend');
const LEAVE = getArg('leave-days');
const DATES = getArg('dates');
const DATE = getArg('date');

if (WEEKEND || LEAVE !== undefined) {
  if (!WEEKEND) die('用 --leave-days 时必须同时给 --weekend', '例：--weekend 2026-12-11 --leave-days 1');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(WEEKEND)) die('--weekend 需为 YYYY-MM-DD');
  const D = LEAVE === undefined ? 0 : Number(LEAVE);
  let w;
  try { w = leaveWindow(WEEKEND, D); } catch (e) { die(e.message); }
  outDates = w.out;
  retDates = w.ret;
  windowNote = `请假 ${D} 天 → 周五 ${w.friday}；去程 ${w.out.length} 天，返程 ${w.ret.length} 天`;
} else if (DATES) {
  outDates = DATES.split(',').map((s) => s.trim()).filter(Boolean);
  retDates = outDates.slice();
  windowNote = `显式日期 ${outDates.length} 天`;
} else if (DATE) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) die('--date 需为 YYYY-MM-DD');
  outDates = [DATE];
  retDates = [DATE];
  windowNote = `单日 ${DATE}`;
} else {
  die('缺少日期：--weekend + --leave-days，或 --dates，或 --date');
}

const BOTH = hasFlag('both') || Boolean(WEEKEND);

// 运行记录：即使后面抛错，catch 里也能拿到它写快照
const run = journal.begin('flight_query.js', args, { enabled: !hasFlag('no-journal') });

// ── 执行 ────────────────────────────────────────────────────────────────
(async () => {
  const log = hasFlag('quiet') ? () => {} : (m) => console.error(m);

  // 没 key 也能跑：命中缓存就不用联网。真要联网时会在那一步失败并回退到缓存。
  if (!tokenSource()) {
    if (CACHE.mode !== 'auto') {
      die('缺少飞常准 MCP Key',
        '设置环境变量 VARIFLIGHT_MCP_KEY，或在 ~/.workbuddy-ai/mcp.json 里配置 variflight-mcp。\n  申请：https://cmcp.variflight.com/');
    }
    log('⚠ 未配置飞常准 MCP Key：本次只能用缓存，缺缓存的航线会失败。');
  }

  const perTransfer = getArg('per-transfer', 15);
  const chunk = getArg('chunk', 3);

  const sources = [];
  for (const d of outDates) sources.push({ from: FROM, to: TO, date: d });
  if (BOTH) for (const d of retDates) sources.push({ from: TO, to: FROM, date: d });

  run.step('request', {
    input: { FROM, TO, BOTH, outDates, retDates, TYPE, perTransfer, chunk, cache: CACHE },
    output: { sourceCount: sources.length, sources },
  });

  log('航线 ' + FROM + ' ⇄ ' + TO + '　' + windowNote);
  log('预计消耗 ' + (BOTH ? 2 : 1) + ' 积分（按唯一 O-D 对计费；命中缓存则为 0）');
  if (CACHE.mode === 'off') log('缓存已关闭（--no-cache）');
  else if (CACHE.mode === 'refresh') log('强制重查（--refresh），结果将覆盖缓存');
  log('');

  const { flights, meta } = await queryFlights({ sources, perTransfer, chunk, log, cache: CACHE, journal: run });

  // 按日期归属方向：去程日期归 out，其余归 ret
  const outSet = new Set(outDates);
  const retSet = new Set(retDates);
  if (BOTH && outDates.some((d) => retSet.has(d))) {
    die('去程与返程日期重叠，无法按日期区分方向',
      '用 --weekend + --leave-days 让窗口自动分开，或分两次调用各查一个方向。');
  }
  const pick = (f) => (outSet.has(f.date) ? 'out' : 'ret');

  const filterType = (list) => list.filter((f) =>
    TYPE === 'both' ? true : TYPE === 'direct' ? f.seg === 1 : f.seg > 1);

  const out = filterType(flights.filter((f) => pick(f) === 'out'));
  const ret = filterType(flights.filter((f) => pick(f) === 'ret'));

  // ── 摘要 ──
  log('');
  log('实际调用 ' + meta.calls + ' 次，返回 ' + meta.rows + ' 行，去重后 ' + flights.length + ' 条');
  log('积分消耗约 ' + meta.credits + '（O-D 对：' + meta.odPairs.join(' / ') + '）');
  if (meta.truncated) {
    log('⚠ 有调用被截断，结果不完整（靠后的日期可能整段缺失）');
    log('  干线航线请用 --chunk 1 让每天单独一批；重跑会再扣积分，所以宁可在第一次就保守');
  }

  const c = meta.cache;
  if (c.mode !== 'off') {
    if (c.hits) {
      log('缓存命中 ' + c.hits + '/' + meta.calls + ' 次' +
        (c.savedCredits ? '，省 ' + c.savedCredits + ' 积分' : '') +
        (c.fallbacks ? '，其中 ' + c.fallbacks + ' 次为失败回退' : ''));
    } else if (c.dir) {
      log('缓存未命中，本次结果已存入 ' + c.dir);
    }
    const o = meta.dataAt.oldest;
    const n = meta.dataAt.newest;
    if (o) log('数据时间 ' + fmtStamp(o) + (n && n !== o ? ' ~ ' + fmtStamp(n) : ''));
  }
  if (c.fallbacks) log('⚠ 有调用失败并回退到旧缓存，票价可能已变动，下单前必须复核');

  const byDate = (list, label) => {
    const dates = [...new Set(list.map((f) => f.date))].sort();
    log('');
    log(label);
    for (const d of dates) {
      const rows = list.filter((f) => f.date === d);
      const direct = rows.filter((f) => f.seg === 1);
      const min = rows.reduce((a, f) => Math.min(a, f.price), Infinity);
      log('  ' + d + '　共 ' + String(rows.length).padStart(3) + ' 条' +
        '　直飞/经停 ' + String(direct.length).padStart(2) +
        '　最低票面 ¥' + (min === Infinity ? '—' : min));
    }
  };
  if (out.length) byDate(out, '去程');
  if (BOTH && ret.length) byDate(ret, '返程');

  // ── 输出 ──
  const payload = BOTH ? { out, ret } : out;
  run.step('result', {
    output: {
      out: out.length, ret: ret.length, deduped: flights.length,
      credits: meta.credits, truncated: meta.truncated, cache: meta.cache,
    },
  });

  if (hasFlag('raw')) {
    console.log(JSON.stringify(meta, null, 2));
    const p = run.done({ mode: 'raw', counts: { out: out.length, ret: ret.length } });
    if (p && !hasFlag('quiet')) console.error('\n运行记录 ' + p);
    return;
  }
  const json = JSON.stringify(payload, null, 1);
  const outFile = getArg('out');
  if (outFile) {
    fs.writeFileSync(outFile, json, 'utf8');
    log('');
    log('\u2713 ' + (BOTH ? `去程 ${out.length} 条 + 返程 ${ret.length} 条` : out.length + ' 条') + ' → ' + outFile);
  } else {
    process.stdout.write(json + '\n');
  }
  const rec = run.done({ out: outFile || '', counts: { out: out.length, ret: ret.length }, credits: meta.credits });
  if (rec && !hasFlag('quiet')) log('运行记录 ' + rec);

  if (!out.length && !ret.length) {
    console.error('\u2716 没有查到航班。检查三字码是否为城市码，或换 --chunk / --per-transfer 重试。');
    process.exit(2);
  }
})().catch((e) => {
  // 先把中间态落盘再退出，否则上层只剩一句错误消息，没法判断断在哪一步
  const note = journal.reportFailure(run, e, { cacheMode: CACHE.mode });
  if (note) console.error(note);
  if (e instanceof VariflightError) die(e.message, e.hint);
  die(e.message);
});
