#!/usr/bin/env node
'use strict';
/**
 * flight_query.js — 单条航线的航班检索（携程问道接口）
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
 */

const fs = require('fs');
const { requireKey } = require('./keys');
const { queryFlights } = require('./wendao');

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

requireKey('WENDAO_API_KEY');

const FROM = getArg('from');
const TO = getArg('to');
const DATE = getArg('date');
if (!FROM || !TO || !DATE) die('缺少 --from / --to / --date');
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) die('--date 需为 YYYY-MM-DD');

const TYPE = getArg('type', 'both');
if (!['direct', 'transfer', 'both'].includes(TYPE)) die('--type 只能是 direct / transfer / both');

(async () => {
  const { flights, raws } = await queryFlights({
    from: FROM, to: TO, date: DATE, type: TYPE, repeat: getArg('repeat', 2),
  });

  if (hasFlag('raw')) {
    const txt = raws.join('\n\n' + '\u2500'.repeat(60) + '\n\n');
    if (getArg('out')) {
      fs.writeFileSync(getArg('out'), txt, 'utf8');
      console.error('原始文本 → ' + getArg('out'));
    } else process.stdout.write(txt + '\n');
    return;
  }

  const json = JSON.stringify(flights, null, 1);
  if (getArg('out')) {
    fs.writeFileSync(getArg('out'), json, 'utf8');
    console.error('\u2713 ' + flights.length + ' 条 → ' + getArg('out'));
  } else {
    process.stdout.write(json + '\n');
  }
  if (!flights.length) {
    console.error('\u2716 未解析出航班。加 --raw 查看原始返回，并用 node scripts/doctor.js --probe 验证凭据。');
    process.exit(2);
  }
})().catch((e) => die(e.message, e.hint));
