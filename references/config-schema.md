# config.json 字段说明

`planner.js` 只吃这一个文件。缺任何必填字段会报错退出并指出字段名。

**它不依赖任何外部服务**——没有任何 API key 时也能跑，只要航班和参数填得进去。
手动录入的完整示例与易错点见 `references/manual-flights.md`。

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

  // ── 到达机场（离雪场最近的那个；多机场方案见下方说明）──────
  "destAirport": {
    "code": "<到达机场三字码>",   // 多机场时写成 "AAA/BBB"
    "name": "<到达机场名>",       // 多机场时写成 "A 机场 / B 机场"
    // 机场→雪场单程分钟数，含预留。取值优先级：问道给的值 → amap_route.js
    // 的 toResortMinutes → 用户口述。
    // 多机场且车程不同时取最长的一段，并在报告里说明。
    "toResortMinutes": 120,
    // 车程来源，会印在报告副标题，避免把估算当实测：
    //   "amap"   高德实测（精确）
    //   "wendao" 问道估算（粗值，预留按 +30%）
    //   "user"   用户口述
    // 省略则不显示来源标注。
    "toResortMinutesSource": "amap"
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

    // 请假判定：三个时刻各自独立，都必须由用户确认后填入
    "leave": {
      "dayStart": "08:30",   // 上班时刻；返程落地不晚于此值 = 不请假
      "halfDayAt": "14:00",  // 半天分界；起飞早于此值 = 1 天，晚于此值 = 0.5 天
      "dayEnd": "20:00"      // 下班时刻；起飞不早于此值 = 不请假
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

## 请假口径

`params.leave` 的三个时刻决定每一档的边界，取值全部来自用户（问法见 `references/intake.md` 第三轮题 2）。缺任一项、或三者不满足 `dayStart < halfDayAt < dayEnd` 时，`planner.js` 报错退出。

出发端只认 `halfDayAt` 与 `dayEnd`，返程端只认 `dayStart`。改这三个值会直接改变各档包含哪些组合，报告页脚的「请假口径」会印出实际取值。

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
  "seg": 2,               // 航段数；省略时按 tag 推断（直飞=1，其余=2）
  "tax": 140,             // 可选，实际机建+燃油；有则覆盖 taxPerSegment × seg
  "seats": 9,             // 可选，余票数，仅作参考展示
  "stopMinutes": 1400,    // 可选，中转停留分钟数
  "airport": "XXX"        // 可选，该段实际使用的到达机场三字码，多机场方案时填
}
```

要点：

- **`price` 写裸票价**。税费默认由 `taxPerSegment × seg` 叠加；若航班对象带了 `tax`（`flight_query.js` 从飞常准返回的机建 + 燃油写入），则以实际值为准，不再乘默认值。
- **`flight_query.js` 已自动填好 `price` / `tax` / `arrDate` / `seg` / `tag`**，直接粘进 config 即可，不用手改税费口径。
- **跨日航班写 `arrDate`**，值为落地日。
- **中转的 `dep` 写第一段起飞、`arr` 写末段落地**，请假判定看的就是这两个时刻。
- `seg` 一般省略；某条中转实际只算 1 段时显式指定。
- **`airport` 只在多机场方案里填**，报告会在航班号后显示蓝色三字码。只有一个机场时省略。
- 航班数组可直接用 `flight_query.js --out` 的输出粘贴，再按需补 `airport`。

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
    "leave": { "dayStart": "08:30", "halfDayAt": "14:00", "dayEnd": "20:00" },
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
