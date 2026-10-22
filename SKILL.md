---
name: ski-trip-planner
description: 滑雪行程性价比规划。把机票、税费、住宿折算成「元/每小时可滑行时间」，枚举请假 0/0.5/1/2 天的出发与返程组合，输出可筛选排序的 HTML 报告。当用户要规划滑雪行程、比较飞往雪场的航班方案、判断请假值不值、计算单日滑雪成本、或在多个周末之间做取舍时使用（ski trip planning / ski weekend / cost per ski day）。内置航班检索与机场到雪场车程查询。
agent_created: true
---

# 滑雪行程性价比规划

## 用途

给定「从 A 机场飞到 B 机场、再去某个雪场」，枚举所有可行的出发 × 返程组合，按请假天数分档，算出每个组合能滑多少小时、要花多少钱，输出按 **元/每小时雪时**（即「元/日」= 总成本 ÷ 等效雪日）排序的 HTML 报告，可按年假档位、直飞/中转筛选。

核心在边界时间的处理：落地到进场、离场到起飞、夜场折算、跨日航班、转机过夜、税费按航段计收。这些决定排名。

## 执行原则

1. **所有数值来自用户。** 雪场营业时间、机场到雪场车程、住宿单价、每航段税费、请假档位，逐项向用户确认后写入 config。缺哪项就问哪项。
2. **目的地确定后先确认行程骨架。** 把起降机场、单程车程、日场/夜场时间、夜场休息日整理成一张卡片，用 AskUserQuestion 请用户确认，再进入检索。
3. **每条数据标注来源。** 航班记录标 `直飞` 或中转城市，报告页脚写 `sourceNote`（数据来源与查询时间）。
4. **预算由用户给定。** 住宿每晚价格、可请几天假，都问清楚后写进 config。

## 流程

### 第 0 步：凭据检查

开始检索前执行一次：

```bash
node scripts/doctor.js
```

输出两个 key 的状态。缺 `WENDAO_API_KEY` 时先按「API Key 配置」引导用户完成设置，再进入第 3 步；缺 `AMAP_API_KEY` 时按「API Key 配置」引导，用户不提供则走第 1 步第 4 条降级。

### 第 1 步：目的地与地面接驳

1. 问清三件事：**雪场全名**、**出发城市**、**可接受的备选机场**。
2. 确定离雪场最近的到达机场，查驾车用时：

   ```bash
   node scripts/amap_route.js --from "<机场名称>" --to "<雪场名称>" --from-city <城市>
   ```

   脚本输出 `toResortMinutes` = 驾车用时 + 预留，预留算子为 **+20% 且至少 +15 分钟**，用 `--buffer-pct` / `--buffer-min` 调整。冬季山路、夜间、雪天场景把比例取到 30% 以上。
3. 把「驾车 X 分钟 + 预留 Y 分钟 = Z 分钟」明确写进给用户的确认卡，Z 直接决定能滑多久。
4. 用户没有高德 key 时，询问「单程车程大概多少分钟」，加预留后把增量告知用户。
5. 查证雪场营业时间：日场起止、有无夜场及其起止、**哪几天不开放夜场**。来源取官方公示，查不到则问用户。
6. **输出行程骨架并请用户确认**，格式见 `references/intake.md`。

### 第 2 步：采集参数

一次最多问 3 题，用选项式提问（`references/intake.md` 有现成选项集）。采集项：

- **出行时间范围**：哪几个周末或假期，每个对应报告的一个 Tab
- **住宿预算**：雪场每晚、转机城市每晚，分开问
- **年假预算**：可接受档位（0 / 0.5 / 1 / 2，或自定义）
- **税费口径**：每航段机建 + 燃油合计，给建议值让用户确认
- **请假切点**：出发几点算半天、几点后不请假、返程几点前落地不请假

### 第 3 步：检索航班

对每个日期、每个方向各执行一次：

```bash
node scripts/flight_query.js \
  --from "<出发城市>" --to "<到达城市>" --date YYYY-MM-DD --type both --out <出程|返程>-YYYY-MM-DD.json
```

- `--type both` 同时取直飞与中转；默认 `--repeat 2` 执行两次查询并取并集，用于补齐班次。
- `--repeat 1` 用于快速试探，定稿前用默认值再跑一次。
- 输出为 JSON 数组，字段与 config 的航班对象一致，直接拼进 `scenarios[].out` / `.ret`。
- 同一航班号在同一日期出现多条时以最低价为准。
- 跨日航班由脚本自动填 `arrDate`，人工核对一遍首末条。
- 需要人工检查解析结果时加 `--raw` 看原始返回。

### 第 4 步：生成报告

1. 按 `references/config-schema.md` 组装 `config.json`，逐项填满。
2. 运行：

   ```bash
   node scripts/planner.js config.json --csv
   ```

   控制台按档位打印最优解，先核对摘要再交付 HTML。
3. 用 `present_files` 交付 HTML。
4. 回复给**各档最优解对照表 + 3–5 条可直接执行的判断**（哪个航班值得选、哪一档有余量、哪个参数最敏感），不复述整张表。

## 计算口径

`references/algorithm.md` 必读，包含：

- 在场窗口与逐日重叠算法（日场满计、夜场按权重折算）
- 请假天数的三段式判定
- 税费按航段计收、红眼航班不计住宿、雪场晚数的推导
- 成本边界与敏感度检查方法

## API Key 配置

两个 key 都只从环境变量读取，变量名固定。

| 变量 | 服务 | 用途 | 申请地址 |
|---|---|---|---|
| `WENDAO_API_KEY` | 携程问道 | 航班号、时刻、票价 | https://www.ctrip.com/wendao/openclaw |
| `AMAP_API_KEY` | 高德开放平台 | 地理编码 + 驾车路径规划 | https://console.amap.com/dev/key/app |

### 缺 key 时怎么引导

按「索取 → 设置 → 验证」三步走，一次只处理一个 key。

1. **索取**：直接给出申请地址、这个 key 换来的数据、以及变量名，让用户可以立即去申请。
2. **设置**：给出变量名和对应平台的命令，由用户在自己的终端执行，长期生效。

   | 平台 | 命令 |
   |---|---|
   | macOS / Linux | `export WENDAO_API_KEY='你的 token'` |
   | Windows CMD | `set WENDAO_API_KEY=你的 token` |
   | Windows PowerShell | `$env:WENDAO_API_KEY="你的 token"` |
   | 长期生效 | 写入 `~/.zshrc` 或 `~/.bash_profile`；Windows 在「系统属性 → 环境变量」加用户级变量 |

3. **验证**：`node scripts/doctor.js --probe` 各发一次真实请求，逐项确认可用性。

脚本在缺 key 时会直接打印这套引导（`scripts/keys.js`），把输出原样转给用户即可，不必改写。

### 用户只能临时提供 key 时

用内联方式只传给本次进程，key 不落盘：

```bash
WENDAO_API_KEY="用户给的 token" node scripts/flight_query.js --from "<出发>" --to "<到达>" --date YYYY-MM-DD
```

Windows 上已配置的用户级变量在当前会话取不到时，先取一次再执行：

```powershell
$env:WENDAO_API_KEY = [Environment]::GetEnvironmentVariable('WENDAO_API_KEY','User')
```

### 规则

- 变量名完全一致：`AMAP_API_KEY` 与 `WENDAO_API_KEY`。
- 高德 key 必须是**「Web 服务」**类型，并在控制台开通「地理编码」与「驾车路径规划」两项服务。
- key 只从环境变量读取：不写入 `config.json`，不写进 shell 脚本或任何仓库文件，不作为命令行参数传递，回复中不回显完整内容。
- 设置完成后先跑一次真实查询确认通，再进入批量检索。
- 缺 `WENDAO_API_KEY` 时航班无法检索，配置完成后再进入第 3 步。
- 缺 `AMAP_API_KEY` 且用户不提供时，问「单程车程大概多少分钟」，加预留后继续，并在报告头部注明车程为估算值。

## 运行环境

| 依赖 | 说明 |
|---|---|
| Node.js ≥ 18 | 脚本使用内置 `fetch`，无 npm 依赖 |
| 网络 | `restapi.amap.com`、`externalcallback.ctrip.com` 可达 |

## 文件说明

| 路径 | 用途 |
|---|---|
| `scripts/planner.js` | 测算引擎 + HTML 生成。纯参数驱动，无内置地点/日期，缺参即报错 |
| `scripts/flight_query.js` | 航班检索（携程问道接口），输出可直接写入 config 的航班数组 |
| `scripts/amap_route.js` | 高德驾车用时查询，输出含预留的 `toResortMinutes` |
| `scripts/keys.js` | 凭据登记表与缺 key 引导文案，三个脚本共用 |
| `scripts/doctor.js` | 凭据状态检查；`--probe` 发真实请求验证 |
| `references/intake.md` | 问答脚本：该问什么、选项怎么给、骨架确认卡长什么样 |
| `references/config-schema.md` | config.json 逐字段说明与可复制骨架 |
| `references/algorithm.md` | 计算模型、边界条件、敏感度检查方法 |
