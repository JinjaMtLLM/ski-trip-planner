# case.json — 枚举管线的输入

一次行程一个 case 文件。与 `config-schema.md` 的区别：那个是给 `planner.js` 的（要手工列出每条航班），这个是给 `legs.js` 的（只声明查哪些航线，航班从缓存读）。

```json
{
  "title": "示例：起点城 → 示例滑雪场 2027/03/05–03/07",
  "origin": "AAA",
  "resort": "RESORT",
  "networkFile": "./network.json",
  "dataAsOf": "2027-02-01",
  "dates": { "from": "2027-03-04", "to": "2027-03-08" },
  "flightQueries": [
    { "from": "AAA", "to": "BBB", "date": "2027-03-05" },
    { "from": "AAA", "to": "BBB", "date": "2027-03-06" },
    { "from": "BBB", "to": "AAA", "dates": ["2027-03-07", "2027-03-08"] }
  ],
  "params": {
    "perTransfer": 15,
    "maxStopMinutes": 480,
    "lodgingResort": 300,
    "lodgingTransit": 80,
    "terminalWaitFreeMin": 240,
    "nightBoundary": "03:00",
    "leave": { "dayStart": "08:30", "halfDayAt": "14:00", "dayEnd": "20:00" },
    "leaveDays": 1,
    "resort": {
      "name": "示例滑雪场",
      "dayOpen": "08:30", "dayClose": "16:30",
      "nightOpen": "18:30", "nightClose": "21:30",
      "nightWeight": 0.5, "nightClosedWeekdays": []
    }
  }
}
```

## 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `title` | 是 | 报告标题 |
| `origin` / `resort` | 是 | 节点 id，须存在于 `networkFile` 指向的路径表 `nodes` 里 |
| `networkFile` | 建议 | 路径表位置（相对 case.json）。不写则在 skill 的 `references/network.json` 找；该文件是本地数据、不入库 |
| `dataAsOf` / `notes` | 否 | 报告「数据时效」日期与案例专属备注（HTML 片段数组），写在报告的「口径与已知局限」里 |
| `dates` | 是 | 时间窗，高铁时刻表按这个范围逐日展开 |
| `flightQueries[]` | 是 | 要读缓存的航线。单日写 `date`，多日合并查过写 `dates` |
| `params.resort` | 是 | 雪场营业时间。夜场不开放就删掉 `nightOpen`。另可写 `seasonStart` / `seasonEnd`（`YYYY-MM-DD`）：雪季未开板的日子一律不算雪时——日本雪场常分区开板，不写会把「开板前落地」算成一整天 |
| `params.leave` | 是 | 三个时刻，顺序必须 `dayStart < halfDayAt < dayEnd` |
| `params.lodgingResort` / `lodgingTransit` | 是 | 雪场每晚 / 中转城市每晚。中转价按当地实际填，别照抄雪场价 |
| `params.leaveDays` | 是 | 用户最多请几天，**只**决定航班查询窗口（周末 ± (天数+1)），不筛组合 |
| `params.perTransfer` / `maxStopMinutes` / `terminalWaitFreeMin` / `nightBoundary` | 否 | 默认 15 / 480 / 240 / `03:00`，见 `enumeration.md` 的口径表 |
| `params.market` | 否 | `domestic`（默认）/ `international`。港澳台、日韩、东南亚、欧美航线必须写 `international`，否则查询返回 0 行 |
| `params.maxGapMinutes` | 否 | 单节点最长候车，默认不限。路径表里有大量「班期边」（高铁时刻表）时才设（如 1200）；铁路改即到即走估算后不要设，否则返程会在机场等几天、整批被砍掉 |

**档位不写在这里。** 组合算出来几天就成几档（0 / 0.5 / 1 / 1.5 / 2 …），每档各取前 30，写 `leaveBuckets` 只对 `planner.js` 有效。

## `date` 还是 `dates`

**必须和当初查询时一致。** 缓存 key 是完整 SQL 的哈希，查的时候把两天合并成一次调用，读的时候也必须给 `dates: [a, b]`；写成两条单日 `date` 会全部 cache miss（然后被当成「没有缓存」跳过）。

不确定的话先 `node scripts/cache.js list` 看缓存里有哪些、参数是什么。

## 缺缓存时

`legs.js` 不会自己去查（查一次 1 积分，应该由人决定）。缺了会在输出里列出来：

```
⚠ 缺缓存：BBB→AAA 2027-03-07 (no-cache)
```

这时要么补查（`flight_query.js`），要么把那条从 `flightQueries` 里删掉——删掉意味着这个方向不参与枚举，属于已知缺失，不是算错。
