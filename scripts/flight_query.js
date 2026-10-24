#!/usr/bin/env node
'use strict';
/**
 * flight_query.js — 航班检索（飞常准 MCP）
 *
 * **省分第一原则：把同一方向的全部日期合并进一次调用。** 飞常准按「次调用」扣分，
 * 与 SQL 里塞几个日期无关，所以 2 天拆两次 = 2 分，合并一次 = 1 分。
 * 本脚本默认就把整个窗口压成「每方向 1 次调用」，不需要手动批处理。
 *
 * 三种用法：
 *
 *   1) 按请假档位自动铺日期（推荐）
 *      node flight_query.js --from SZX --to CGQ --weekend 2027-01-08 --leave-days 1 --both --out w1.json
 *        请假 1 天 → 窗口 = 周末 ± 2 天：去程 周三…周六，返程 周日…周二（共 7 天，1 次调用）
 *
 *   2) 显式日期（多天用逗号合并，单天就只写一天）
 *      node flight_query.js --from SZX --to CGQ --dates 2027-01-08,2027-01-09
 *
 *   3) 只要某一天：--dates 里写一天即可，没有单独的 --date 参数
 *      node flight_query.js --from SZX --to CGQ --dates 2027-01-08
 *
 * 选项：
 *   --from <城市或机场三字码>   城市码会覆盖同城所有机场（BJS = PEK+PKX）
 *   --to   <同上>
 *   --weekend <YYYY-MM-DD>     该日期所在周末的任意一天，自动归到周五
 *   --leave-days <0|0.5|1|2|3>   最多能请几天：只用来铺查询窗口（周末 ± (天数+1)），不筛结果
 *   --dates <a,b,c>            显式日期列表（多天必须写在一起，这是省分关键）
 *   --both                     同时查返程方向，输出 { out, ret }
 *   --type <both|direct|transfer>  过滤，默认 both
 *   --per-day <n>              每个日期最多保留几条（按含税价取最低）。给了就走「按日限额」
 *                              路径：无 CTE、可 6 源、自动加中转停留上限。**推荐**
 *                              单周末 3 天 → 66（3×66=198 行）；合并 6 天 → 33（6×33=198 行）
 *   --max-stop <分钟>          中转停留上限，默认 960（16h），0 = 不限。仅 --per-day 生效
 *   --per-transfer <n>         旧口径：直飞全留 + 每个日期保留 n 条中转，默认 15。
 *                              行预算有效率只有 52%，新查询请改用 --per-day
 *   --market <domestic|international>  航线市场，默认 domestic。港澳台/日韩/东南亚等
 *                              国际航线必须写 international，否则返回 0 行
 *   --chunk <n>                每次调用的日期上限，默认 0 = 一个方向全并进一次调用
 *                              （上限 6，超出会自动拆批——一次 SQL 最多 6 个数据源）
 *   --no-refill                截断后不自动补查（默认会自动补，只补被砍到的那几天）
 *   --out <file>               写入文件
 *   --raw                      只打印本次调用的元信息（积分、行数、截断、缓存）
 *   --quiet                    不打印进度
 *   --no-journal               不写运行记录（默认每次都写，见下）
 *
 * 截断自愈：结果按日期排序，200 行上限只会砍掉靠后的日期。脚本检测到 truncated 后
 * 只补查「被砍到的那天起」的日期（每天 1 次调用，命中缓存 0 分），不重跑整批。
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
 * 积分（实测，非文档口径）：**1 积分 / 次 tools/call**，与日期数无关；
 * 命中缓存的调用 0 分；失败调用 0 分。所以省分的唯一办法是合并，不是拆细。
 */

const fs = require('fs');
const { tokenSource } = require('./variflight');
const { queryFlights, leaveWindow, planBatches, VariflightError } = require('./variflight');
const journal = require('./journal');
const mcpJson = require('./mcp_json');

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

// --date 已移除：它诱导人一天一天地查，而每次调用扣 1 分，拆开就是白花钱。
if (hasFlag('date')) {
  die('--date 已移除，改用 --dates（多天写在一起，一次调用只扣 1 积分）',
    '单日可以这样写：--dates ' + (getArg('date') || 'YYYY-MM-DD')
    + '\n  多天合并：--dates 2026-11-27,2026-11-28,2026-11-29');
}

if (WEEKEND || LEAVE !== undefined) {
  if (!WEEKEND) die('用 --leave-days 时必须同时给 --weekend', '例：--weekend 2027-01-08 --leave-days 1');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(WEEKEND)) die('--weekend 需为 YYYY-MM-DD');
  const D = LEAVE === undefined ? 0 : Number(LEAVE);
  let w;
  try { w = leaveWindow(WEEKEND, D); } catch (e) { die(e.message); }
  outDates = w.out;
  retDates = w.ret;
  windowNote = `请假 ${D} 天 → 周五 ${w.friday}；去程 ${w.out.length} 天，返程 ${w.ret.length} 天`;
  // 窗口一宽（请假 2 天以上），单次合并查询必然撞 200 行上限，补查会按天逐个发调用。
  // 提前把「分几次查更省」讲清楚，比事后看积分更有效。
  if (w.out.length + w.ret.length > 8 && !getArg('chunk')) {
    console.log('  ⚠ 窗口 ' + (w.out.length + w.ret.length) + ' 天，单次查询会撞 200 行上限并触发逐日补查；'
      + '想稳在 ' + Math.ceil((w.out.length + w.ret.length) / 3) + ' 次调用内可加 --chunk 3');
  }
} else if (DATES) {
  outDates = DATES.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = outDates.filter((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d));
  if (bad.length) die('--dates 里有非 YYYY-MM-DD 的日期：' + bad.join(', '));
  outDates = [...new Set(outDates)].sort();
  retDates = outDates.slice();
  windowNote = `显式日期 ${outDates.length} 天（合并成 1 次调用）`;
} else {
  die('缺少日期：--weekend + --leave-days，或 --dates <YYYY-MM-DD[,YYYY-MM-DD...]>',
    '多天务必写进同一个 --dates，合并查只扣 1 积分；拆成多次会各扣 1 分。');
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
        '设置环境变量 VARIFLIGHT_MCP_KEY，或在 MCP 配置（'
        + mcpJson.short(mcpJson.writeTarget()) + '）里配置 variflight-mcp。\n  申请：https://cmcp.variflight.com/');
    }
    log('⚠ 未配置飞常准 MCP Key：本次只能用缓存，缺缓存的航线会失败。');
  }

  const perTransfer = getArg('per-transfer', 15);
  const perDay = Number(getArg('per-day', 0)) || 0;
  const maxStop = Number(getArg('max-stop', 960));
  // 静默回落最危险：写了 --per-day 却没给值，getArg 会退回默认 0，于是悄悄走旧的
  // --per-transfer 口径，行预算白白浪费。宁可报错。
  if (hasFlag('per-day') && !(perDay > 0)) {
    die('--per-day 需要正整数',
      '单周末 3 天用 66（3×66=198 行），合并 6 天用 33（6×33=198 行）');
  }
  if (hasFlag('max-stop') && !(maxStop >= 0)) {
    die('--max-stop 需要分钟数（0 = 不限）', '默认 960 = 16 小时');
  }
  const chunk = getArg('chunk', 0);          // 0 = 该方向的全部日期合并成一次调用（上限 6 源）
  const market = getArg('market', 'domestic');   // domestic | international

  const sources = [];
  for (const d of outDates) sources.push({ from: FROM, to: TO, date: d, dir: 'out' });
  if (BOTH) for (const d of retDates) sources.push({ from: TO, to: FROM, date: d, dir: 'ret' });

  run.step('request', {
    input: { FROM, TO, BOTH, outDates, retDates, TYPE, perTransfer, perDay, maxStop, chunk, cache: CACHE },
    output: { sourceCount: sources.length, sources },
  });

  // 按「次调用」预估，不再按 O-D 对 —— 合并后一次调用就是 1 分
  const planned = planBatches(sources, chunk).batches.length;
  log('航线 ' + FROM + ' ⇄ ' + TO + '　' + windowNote);
  if (perDay) {
    log('取数口径：每个日期最多 ' + perDay + ' 条（按含税价）'
      + '　停留上限 ' + (Number(maxStop) > 0 ? maxStop + ' 分钟' : '不限'));
  }
  log('预计消耗 ' + planned + ' 积分：' + sources.length + ' 个日期合成 ' + planned + ' 次调用'
    + '（每次调用扣 1 分，命中缓存则为 0）');
  if (CACHE.mode === 'off') log('缓存已关闭（--no-cache）');
  else if (CACHE.mode === 'refresh') log('强制重查（--refresh），结果将覆盖缓存');
  log('');

  const { flights, meta } = await queryFlights({
    sources, perTransfer, perDay, maxStopMinutes: maxStop, chunk, log, cache: CACHE, journal: run, market,
    refill: !hasFlag('no-refill'),
  });

  // 按方向归属：优先用查询时打上的 _dir（--both 且去返程日期重叠时唯一可靠的依据），
  // 没有标记时退回按日期判。_dir 是内部字段，输出前剥掉。
  const outSet = new Set(outDates);
  const pick = (f) => f._dir || (outSet.has(f.date) ? 'out' : 'ret');
  const stripDir = (list) => list.map(({ _dir, ...rest }) => rest);

  const filterType = (list) => list.filter((f) =>
    TYPE === 'both' ? true : TYPE === 'direct' ? f.seg === 1 : f.seg > 1);

  const out = stripDir(filterType(flights.filter((f) => pick(f) === 'out')));
  const ret = stripDir(filterType(flights.filter((f) => pick(f) === 'ret')));

  // ── 摘要 ──
  log('');
  log('实际调用 ' + meta.calls + ' 次' + (meta.refills ? '（含自动补查 ' + meta.refills + ' 次）' : '')
    + '，返回 ' + meta.rows + ' 行，去重后 ' + flights.length + ' 条');
  log('扣分 ' + meta.credits + '（' + meta.calls + ' 次调用'
    + (meta.cache.hits ? '，其中 ' + meta.cache.hits + ' 次命中缓存' : '') + '），航线 '
    + meta.odPairs.join(' / '));
  if (meta.truncated) {
    log('⚠ 有调用撞上 200 行上限');
    if (!meta.refills) log('  已用 --no-refill 关闭自动补查，靠后日期的数据可能是缺的');
    else log('  已自动补查被砍到的日期；若仍提示单日截断，说明那天本身就超 200 行');
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
  if (!flights.length && market !== 'international') {
    log('');
    log('⚠ 全部 0 行。若这是国际/地区航线（港澳台、日韩、东南亚、欧美等），');
    log('  加 --market international 重查：market 默认 domestic，国际航线用 domestic 查不到报价。');
  }

  // ── 输出 ──
  const payload = BOTH ? { out, ret } : out;
  run.step('result', {
    output: {
      out: out.length, ret: ret.length, deduped: flights.length,
      calls: meta.calls, refills: meta.refills,
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
    console.error('\u2716 没有查到航班。检查三字码是否为城市码（BJS 而非 PEK），或调小 --per-transfer 重试。');
    process.exit(2);
  }
})().catch((e) => {
  // 先把中间态落盘再退出，否则上层只剩一句错误消息，没法判断断在哪一步
  const note = journal.reportFailure(run, e, { cacheMode: CACHE.mode });
  if (note) console.error(note);
  if (e instanceof VariflightError) die(e.message, e.hint);
  die(e.message);
});
