# config.json 字段说明

`planner.js` 只吃这一个文件。缺任何必填字段会报错退出并指出字段名。

下面示例里的数字只示范格式。实际取值来自用户确认；从上下文推断来的取值，在回复里标注为假设。

下面每一处 `<尖括号>` 都是占位符，实际使用时要替换成用户确认过的值。

```jsonc
{
  // ── 报告标题，会出现在 <h1> 和浏览器标题栏 ────────────────────
  "title": "<出发城市> → <雪场名> 滑雪行程性价比",

  // ── 出发地 ────────────────────────────────────────────────
  "origin": {
    "code": "<出发机场三字码>",
    "name": "<出发机场名>"
  },

  // ── 到达机场（离雪场最近的那个）────────────────────────────
  "destAirport": {
    "code": "<到达机场三字码>",
    "name": "<到达机场名>",
    // 机场→雪场单程分钟数，含预留。由 amap_route.js 的 toResortMinutes 直接填入，
    // 或用户口述 + 你说明的预留量
    "toResortMinutes": 120
  },

  // ── 雪场营业参数（必须来自官方公示或用户确认）──────────────
  "resort": {
    "name": "<雪场全名>",
    "dayOpen": "08:30",          // 日场开始
    "dayClose": "16:00",         // 日场结束
    "nightOpen": "18:00",        // 无夜场则整个删掉这个字段
    "nightClose": "21:00",
    "nightWeight": 0.5,          // 夜场折算权重，0.5 = 3 小时算 1.5 小时；无夜场则删掉
    "nightClosedWeekdays": [1]   // 不开放夜场的星期，0=周日 1=周一 … 6=周六；没有例外就写 []
  },

  // ── 全局计算参数 ───────────────────────────────────────────
  "params": {
    "preFlightMinutes": 90,      // 到机场提前量（值机 + 安检）
    "taxPerSegment": 150,        // 机建 + 燃油，每航段合计
    "lodgingResort": 300,        // 雪场住宿 元/晚
    "lodgingTransit": 80,        // 转机城市过夜 元/晚
    "redEyeArrivalBefore": "05:00", // 早于此时刻落地视为红眼，不计住宿

    // 请假判定三段式
    "leave": {
      "halfDayAt": "13:30",          // 在此之前起飞 = 请 1 天
      "freeAfter": "19:30",          // 在此之后起飞 = 不请假
      "freeArrivalBefore": "10:00"   // 在此之前的落地 = 不请假
    },

    // 只保留这些请假档位的组合
    "leaveBuckets": [0, 0.5, 1, 2]
  },

  // ── 场景（每个场景一个 Tab）────────────────────────────────
  "scenarios": [
    {
      "key": "w1",                 // 仅字母数字下划线，用于 DOM id
      "label": "<场景名，如 第一个周末>",
      "out": [ /* 去程航班 */ ],
      "ret": [ /* 返程航班 */ ]
    }
  ],

  "output": "report.html",         // 可选，默认 report.html
  "sourceNote": "<数据来源与查询时间>" // 可选，会印在报告页脚
}
```

## 航班对象

```jsonc
{
  "date": "YYYY-MM-DD",   // 起飞日（必填）
  "dep": "HH:MM",         // 起飞时刻（必填）
  "arr": "HH:MM",         // 落地时刻（必填）
  "arrDate": "YYYY-MM-DD",// 落地比起飞晚一天时必填，同日则省略
  "price": 1030,          // 裸票价，不含税费（必填）
  "no": "XX1234",         // 航班号；中转写 "XX1234+YY5678"
  "tag": "直飞",           // "直飞" 或中转城市名，如 "某城转"
  "seg": 2                // 航段数；省略时按 tag 推断（直飞=1，其余=2）
}
```

要点：

- **`price` 写裸票价**，税费由 `taxPerSegment × seg` 自动叠加。
- **跨日航班写 `arrDate`**，值为落地日。
- **中转的 `dep` 写第一段起飞、`arr` 写末段落地**，请假判定看的就是这两个时刻。
- `seg` 一般省略；某条中转实际只算 1 段时显式指定。
- 航班数组可直接用 `flight_query.js --out` 的输出粘贴。

## 最小可运行骨架

```jsonc
{
  "title": "<...>",
  "origin": { "code": "<...>", "name": "<...>" },
  "destAirport": { "code": "<...>", "name": "<...>", "toResortMinutes": 120 },
  "resort": { "name": "<...>", "dayOpen": "08:30", "dayClose": "16:00" },
  "params": {
    "preFlightMinutes": 90,
    "taxPerSegment": 150,
    "lodgingResort": 300,
    "lodgingTransit": 80,
    "redEyeArrivalBefore": "05:00",
    "leave": { "halfDayAt": "13:30", "freeAfter": "19:30", "freeArrivalBefore": "10:00" },
    "leaveBuckets": [0, 0.5, 1, 2]
  },
  "scenarios": [
    { "key": "s1", "label": "<...>", "out": [ /* ≥1 条 */ ], "ret": [ /* ≥1 条 */ ] }
  ]
}
```

## 运行

```bash
node scripts/planner.js config.json            # 只出 HTML
node scripts/planner.js config.json --csv      # 同时出 CSV
node scripts/planner.js config.json --out /path/to/x.html
```

控制台摘要会按档位打印最优解，先核对摘要再交付 HTML。
