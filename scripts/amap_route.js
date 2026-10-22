#!/usr/bin/env node
'use strict';
/**
 * amap_route.js — 查两点驾车用时（机场 → 雪场）
 *
 * 用法：
 *   node amap_route.js --from "<机场名称>" --to "<雪场名称>" [--from-city <城市>] [--to-city <城市>]
 *                      [--from-lnglat lng,lat] [--to-lnglat lng,lat]
 *                      [--buffer-pct 20] [--buffer-min 15]
 *
 * key 来源：仅环境变量 AMAP_API_KEY
 *
 * 输出：stdout 打印一行 JSON：
 *   { from, to, distanceKm, driveMin, bufferPct, bufferMin, toResortMinutes }
 *   toResortMinutes 即「驾车用时 + 预留」，直接映射到 config 的 destAirport.toResortMinutes
 */

const { requireKey } = require('./keys');
const { routeInfo } = require('./amap');

function die(msg, hint) {
  console.error('\u2716 ' + msg + (hint ? '\n  ' + hint : ''));
  process.exit(1);
}

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i > -1 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

requireKey('AMAP_API_KEY');

const FROM_NAME = getArg('from');
const TO_NAME = getArg('to');
const bufferPct = Number(getArg('buffer-pct', 20));
const bufferMin = Number(getArg('buffer-min', 15));

if (!getArg('from-lnglat') && !FROM_NAME) die('缺少 --from <起点名称> 或 --from-lnglat');
if (!getArg('to-lnglat') && !TO_NAME) die('缺少 --to <终点名称> 或 --to-lnglat');

routeInfo({
  from: FROM_NAME,
  to: TO_NAME,
  fromCity: getArg('from-city'),
  toCity: getArg('to-city'),
  fromLngLat: getArg('from-lnglat'),
  toLngLat: getArg('to-lnglat'),
  bufferPct,
  bufferMin,
}).then((out) => {
  console.log(JSON.stringify(out));
  console.error('驾车 ' + out.distanceKm + ' km / ' + out.driveMin + ' 分钟'
    + ' → 加 ' + out.bufferPct + '% + ' + out.bufferMin + ' 分钟预留 = ' + out.toResortMinutes + ' 分钟');
}).catch((e) => die(e.message, e.hint));
