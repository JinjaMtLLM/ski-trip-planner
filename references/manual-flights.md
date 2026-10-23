# 手动录入模式：一个 key 都不配也能出结果

用户有权拒绝配置任何 API。这时候**不要停**——`planner.js` 的测算逻辑不依赖任何外部服务，
只要能把航班和参数填进 `config.json`，照样能算出各请假档位的「元/每小时雪时」排名。

自动比价拿不到，是唯一真正的损失。

---

## 什么时候走这条路

- 用户明确说「不想配」「太麻烦」「别管什么 key」；
- 所有 key 都失效、配额耗尽，且缓存里也没有可用数据；
- 只想快速验证某个想法（比如「我请 1 天到底值不值」），不需要全量候选。

先跑一次确认清单：

```bash
node scripts/doctor.js --manual
```

它不会检查任何凭据，只打印需要向用户收集的项，退出码 0。

---

## 需要收集什么

| 项 | 说明 | 谁提供 |
|---|---|---|
| 航班 | 出发/到达地、日期、航班号、起飞时刻、落地时刻、票面价 | 用户，或你按公开信息整理后请用户核对 |
| 中转 | 中转城市、停留分钟数 | 同上 |
| 车程 | 每个候选机场 → 雪场的单程分钟数（含预留） | 用户口述，或问道粗筛值 |
| 雪场 | 日场起止、夜场起止与休息日、雪季 | 官方公示 |
| 住宿 | 雪场每晚、转机城市每晚 | 用户 |
| 请假口径 | 上班 / 半天分界 / 下班三个时刻 | 用户 |

**至少每个方向要有一条航班**，否则那个方向没有组合可算。

---

## 可直接运行的完整示例

把下面存成 `config.json`，跑 `node scripts/planner.js config.json` 就能出报告。
数字是示意，替换成用户给的值即可。

```json
{
  "title": "深圳 → 北大湖 滑雪行程性价比",
  "origin": { "code": "SZX", "name": "深圳宝安" },
  "destAirport": {
    "code": "CGQ",
    "name": "长春龙嘉",
    "toResortMinutes": 150,
    "toResortMinutesSource": "user"
  },
  "resort": {
    "name": "北大湖滑雪度假区",
    "dayOpen": "08:30",
    "dayClose": "16:30",
    "nightOpen": "18:00",
    "nightClose": "21:00",
    "nightWeight": 0.5,
    "nightClosedWeekdays": [1]
  },
  "params": {
    "preFlightMinutes": 90,
    "taxPerSegment": 150,
    "lodgingResort": 400,
    "lodgingTransit": 100,
    "redEyeArrivalBefore": "05:00",
    "leave": { "dayStart": "08:30", "halfDayAt": "14:00", "dayEnd": "20:00" },
    "leaveBuckets": [0, 0.5, 1, 2]
  },
  "scenarios": [
    {
      "key": "w1",
      "label": "01-08 周末",
      "out": [
        { "date": "2027-01-08", "dep": "07:40", "arr": "13:15", "price": 800, "tax": 140, "no": "CZ3613", "tag": "直飞" },
        { "date": "2027-01-08", "dep": "16:30", "arr": "23:55", "price": 620, "tax": 280, "no": "SC4682+SC4725", "tag": "青岛转", "seg": 2, "stopMinutes": 95 },
        { "date": "2027-01-08", "dep": "21:30", "arr": "02:40", "arrDate": "2027-01-09", "price": 540, "tax": 140, "no": "CZ3615", "tag": "直飞" },
        { "date": "2027-01-09", "dep": "07:40", "arr": "13:15", "price": 780, "tax": 140, "no": "CZ3613", "tag": "直飞" }
      ],
      "ret": [
        { "date": "2027-01-10", "dep": "14:10", "arr": "20:30", "price": 760, "tax": 140, "no": "CZ6358", "tag": "直飞" },
        { "date": "2027-01-11", "dep": "14:10", "arr": "20:30", "price": 620, "tax": 140, "no": "CZ6358", "tag": "直飞" }
      ]
    }
  ],
  "sourceNote": "航班与票价为手动录入（2026-10-23），未接入自动比价"
}
```

输出会是这样（数字随取值变化）：

```
== 01-08 周末 == N 个非重复组合
  0天: ¥xxxx/日 | 雪时 xx.xxh | 机¥xxxx+宿¥xxx | ...
```

---

## 手动录入的四个易错点

1. **`price` 写裸票价，不含税费。** 税费由 `taxPerSegment × seg` 叠加；若该航班知道确切的
   机建 + 燃油，写 `tax` 字段覆盖它，否则会按默认值估。
2. **跨日航班必须写 `arrDate`。** 比如 20:05 起飞、次日 01:30 落地，漏了 `arrDate`
   会被当成当天 01:30 落地，请假判定和住宿晚数全错。
3. **中转的 `dep` 写第一段起飞、`arr` 写末段落地。** 请假判定只看这两个时刻，
   中转停留时间写在 `stopMinutes` 里另算。
4. **`toResortMinutesSource` 要如实填。** `amap` = 高德实测、`wendao` = 问道估算、
   `user` = 用户口述。报告副标题会印出「车程：问道估算（150 分钟）」这类标注，
   免得把估算当实测用。

字段的完整定义见 `references/config-schema.md`。

---

## 校验

`planner.js` 缺字段会直接报错并指出字段名，不会静默用默认值。常见报错：

| 报错 | 原因 |
|---|---|
| `缺少 params.leave.dayStart` | 请假三时刻没填全 |
| `destAirport.toResortMinutes 必须是数字` | 车程写成了 `"2.5h"` 这类字符串 |
| `scenarios[0].out 为空` | 那个方向一条航班都没给 |
| `leave 需满足 dayStart < halfDayAt < dayEnd` | 三个时刻顺序反了 |

跑通了再交付 HTML。手动模式下**务必在 `sourceNote` 里写明数据来源和录入日期**，
并提醒用户：这些票价不是实时报价，下单前必须在航司或 OTA 页面复核。
