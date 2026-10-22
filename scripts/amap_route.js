#!/usr/bin/env node
'use strict';
/**
 * amap_route.js — 用高德开放平台查两点驾车用时（机场 → 雪场）
 *
 * 用法：
 *   node amap_route.js --from "<机场名称>" --to "<雪场名称>" [--from-city <城市>] [--to-city <城市>]
 *                      [--from-lnglat lng,lat] [--to-lnglat lng,lat]
 *                      [--buffer-pct 20] [--buffer-min 15]
 *
 * key 来源：仅环境变量 AMAP_API_KEY
 *
 * 输出：stdout 打印一行 JSON，供上层直接取值写入 config：
 *   { from, to, distanceKm, driveMin, bufferPct, bufferMin, toResortMinutes }
 *   toResortMinutes 即「驾车用时 + 预留」，直接映射到 config 的 destAirport.toResortMinutes
 */

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i > -1 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

const { requireKey } = require('./keys');

function die(msg, hint) {
  console.error('\u2716 ' + msg + (hint ? '\n  ' + hint : ''));
  process.exit(1);
}

requireKey('AMAP_API_KEY');
const KEY = (process.env.AMAP_API_KEY || '').trim();

const FROM_NAME = getArg('from');
const TO_NAME = getArg('to');
let fromLngLat = getArg('from-lnglat');
let toLngLat = getArg('to-lnglat');

if (!fromLngLat && !FROM_NAME) die('缺少 --from <起点名称> 或 --from-lnglat');
if (!toLngLat && !TO_NAME) die('缺少 --to <终点名称> 或 --to-lnglat');

const BUFFER_PCT = Number(getArg('buffer-pct', 20));
const BUFFER_MIN = Number(getArg('buffer-min', 15));
if (!isFinite(BUFFER_PCT) || BUFFER_PCT < 0) die('--buffer-pct 应为非负数字');
if (!isFinite(BUFFER_MIN) || BUFFER_MIN < 0) die('--buffer-min 应为非负数字');

const INFOCODE_HINT = {
  10001: 'key 不正确或已过期，重新申请或更换后按引导重新设置',
  10002: '没有该接口权限（需开通「地理编码」/「驾车路径规划」）',
  10003: '访问过于频繁，请降低频率',
  10004: '当日访问量已超限',
  10009: 'key 绑定的平台类型不对，需改用「Web服务」类型',
  20003: '配额已用尽',
};

async function call(url) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'ski-trip-planner/1.0' } });
  } catch (e) {
    die('网络请求失败：' + e.message, '检查网络或代理设置。');
  }
  if (!res.ok) die('高德接口 HTTP ' + res.status, '稍后重试；持续失败时用 node scripts/doctor.js --probe 验证凭据。');
  const data = await res.json();
  if (String(data.status) !== '1' || data.infocode !== '10000') {
    die('高德接口返回错误：' + (data.info || '未知') + '（infocode ' + data.infocode + '）',
      (INFOCODE_HINT[data.infocode] || '检查参数或 key 权限。') + '\n  凭据状态与重新配置：node scripts/doctor.js --probe');
  }
  return data;
}

async function geocode(name, city) {
  const url = 'https://restapi.amap.com/v3/geocode/geo?key=' + encodeURIComponent(KEY)
    + '&address=' + encodeURIComponent(name)
    + (city ? '&city=' + encodeURIComponent(city) : '');
  const data = await call(url);
  const g = (data.geocodes || [])[0];
  if (!g) die('地理编码未命中：' + name, '尝试补 --from-city / --to-city，或改用 --from-lnglat 直接给坐标。');
  return { name: g.formatted_address || name, lnglat: g.location };
}

async function main() {
  let fromInfo, toInfo;

  if (fromLngLat) {
    fromInfo = { name: FROM_NAME || fromLngLat, lnglat: fromLngLat };
  } else {
    fromInfo = await geocode(FROM_NAME, getArg('from-city'));
  }

  if (toLngLat) {
    toInfo = { name: TO_NAME || toLngLat, lnglat: toLngLat };
  } else {
    toInfo = await geocode(TO_NAME, getArg('to-city'));
  }

  const url = 'https://restapi.amap.com/v3/direction/driving?key=' + encodeURIComponent(KEY)
    + '&origin=' + encodeURIComponent(fromInfo.lnglat)
    + '&destination=' + encodeURIComponent(toInfo.lnglat)
    + '&extensions=base&strategy=0';

  const data = await call(url);
  const path0 = ((data.route || {}).paths || [])[0];
  if (!path0) die('未取到驾车路线', '两点可能不可驾车到达，或跨海/跨境。');

  const driveMin = Math.round(Number(path0.duration) / 60);
  const distanceKm = +(Number(path0.distance) / 1000).toFixed(1);
  const buffered = Math.round(driveMin * (1 + BUFFER_PCT / 100) + BUFFER_MIN);

  const out = {
    from: fromInfo.name,
    to: toInfo.name,
    distanceKm,
    driveMin,
    bufferPct: BUFFER_PCT,
    bufferMin: BUFFER_MIN,
    toResortMinutes: buffered,
  };
  console.log(JSON.stringify(out));
  console.error('驾车 ' + distanceKm + ' km / ' + driveMin + ' 分钟'
    + ' → 加 ' + BUFFER_PCT + '% + ' + BUFFER_MIN + ' 分钟预留 = ' + buffered + ' 分钟');
}

main().catch((e) => die('未预期错误：' + e.message));
