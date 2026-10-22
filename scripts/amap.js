#!/usr/bin/env node
'use strict';
/**
 * amap.js — 高德开放平台封装（地理编码 + 驾车路径规划）
 *
 * 被 amap_route.js 使用（机场 → 雪场单条路线）。
 * key 仅从环境变量 AMAP_API_KEY 读取。失败时抛出 AmapError，由调用方决定如何退出。
 */

const INFOCODE_HINT = {
  10001: 'key 不正确或已过期，重新申请或更换后按引导重新设置',
  10002: '没有该接口权限（需开通「地理编码」/「驾车路径规划」）',
  10003: '访问过于频繁，请降低频率',
  10004: '当日访问量已超限',
  10009: 'key 绑定的平台类型不对，需改用「Web服务」类型',
  20003: '配额已用尽',
};

class AmapError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'AmapError';
    this.hint = hint;
  }
}

const key = () => (process.env.AMAP_API_KEY || '').trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 高频访问类错误，退避后重试即可通过
const RETRY_CODES = new Set(['10003', '10021']);

async function call(url, attempt = 1) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'ski-trip-planner/1.0' } });
  } catch (e) {
    throw new AmapError('网络请求失败：' + e.message, '检查网络或代理设置。');
  }
  if (!res.ok) {
    throw new AmapError('高德接口 HTTP ' + res.status,
      '稍后重试；持续失败时用 node scripts/doctor.js --probe 验证凭据。');
  }
  const data = await res.json();
  if (String(data.status) !== '1' || data.infocode !== '10000') {
    if (RETRY_CODES.has(String(data.infocode)) && attempt < 3) {
      await sleep(400 * attempt);
      return call(url, attempt + 1);
    }
    throw new AmapError('高德接口返回错误：' + (data.info || '未知') + '（infocode ' + data.infocode + '）',
      (INFOCODE_HINT[data.infocode] || '检查参数或 key 权限。')
      + '\n  凭据状态与重新配置：node scripts/doctor.js --probe');
  }
  return data;
}

/** 地址 → 坐标。命中失败抛错，提示补 city 或直接用坐标。 */
async function geocode(name, city) {
  const url = 'https://restapi.amap.com/v3/geocode/geo?key=' + encodeURIComponent(key())
    + '&address=' + encodeURIComponent(name)
    + (city ? '&city=' + encodeURIComponent(city) : '');
  const data = await call(url);
  const g = (data.geocodes || [])[0];
  if (!g) {
    throw new AmapError('地理编码未命中：' + name,
      '补上城市名后再试，或改用坐标参数直接给经纬度。');
  }
  return { name: g.formatted_address || name, lnglat: g.location };
}

/** 两点驾车，返回 { driveMin, distanceKm } */
async function driving(originLngLat, destinationLngLat) {
  const url = 'https://restapi.amap.com/v3/direction/driving?key=' + encodeURIComponent(key())
    + '&origin=' + encodeURIComponent(originLngLat)
    + '&destination=' + encodeURIComponent(destinationLngLat)
    + '&extensions=base&strategy=0';
  const data = await call(url);
  const path0 = ((data.route || {}).paths || [])[0];
  if (!path0) throw new AmapError('未取到驾车路线', '两点可能不可驾车到达，或跨海/跨境。');
  return {
    driveMin: Math.round(Number(path0.duration) / 60),
    distanceKm: +(Number(path0.distance) / 1000).toFixed(1),
  };
}

/**
 * 机场 → 雪场完整路线，含预留。
 * opts: { from, to, fromCity, toCity, fromLngLat, toLngLat, bufferPct, bufferMin }
 * 返回 { from, to, distanceKm, driveMin, bufferPct, bufferMin, toResortMinutes }
 */
async function routeInfo(opts) {
  const bufferPct = opts.bufferPct == null ? 20 : Number(opts.bufferPct);
  const bufferMin = opts.bufferMin == null ? 15 : Number(opts.bufferMin);
  if (!isFinite(bufferPct) || bufferPct < 0) throw new AmapError('bufferPct 应为非负数字');
  if (!isFinite(bufferMin) || bufferMin < 0) throw new AmapError('bufferMin 应为非负数字');

  const fromInfo = opts.fromLngLat
    ? { name: opts.from || opts.fromLngLat, lnglat: opts.fromLngLat }
    : await geocode(opts.from, opts.fromCity);
  const toInfo = opts.toLngLat
    ? { name: opts.to || opts.toLngLat, lnglat: opts.toLngLat }
    : await geocode(opts.to, opts.toCity);

  const { driveMin, distanceKm } = await driving(fromInfo.lnglat, toInfo.lnglat);

  return {
    from: fromInfo.name,
    to: toInfo.name,
    distanceKm,
    driveMin,
    bufferPct,
    bufferMin,
    toResortMinutes: Math.round(driveMin * (1 + bufferPct / 100) + bufferMin),
  };
}

module.exports = { AmapError, geocode, driving, routeInfo };
