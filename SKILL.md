---
name: ski-trip-planner
description: 滑雪行程性价比规划。把机票、税费、住宿折算成「元/每小时可滑行时间」，枚举请假 0/0.5/1/2 天的出发与返程组合，输出可筛选排序的 HTML 报告。当用户要规划滑雪行程、比较飞往雪场的航班方案、判断请假值不值、计算单日滑雪成本、或在多个周末之间做取舍时使用（ski trip planning / ski weekend / cost per ski day）。内置航班检索与机场到雪场车程查询。
license: AGPL-3.0
---

# 滑雪行程性价比规划

## 用途

给定「从 A 机场飞到 B 机场、再去某个雪场」，枚举所有可行的出发 × 返程组合，按请假天数分档，算出每个组合能滑多少小时、要花多少钱，输出按 **元/每小时雪时**（即「元/日」= 总成本 ÷ 等效雪日）排序的 HTML 报告，可按年假档位、直飞/中转筛选。

核心在边界时间的处理：落地到进场、离场到起飞、夜场折算、跨日航班、转机过夜、税费按航段计收。这些决定排名。

## 执行原则

1. **所有数值来自用户。** 雪场营业时间、机场到雪场车程、住宿单价、每航段税费、请假档位、请假三时刻，逐项向用户确认后写入 config。缺哪项就问哪项。
2. **目的地确定后先确认行程骨架。** 把起降机场、单程车程、日场/夜场时间、夜场休息日整理成一张卡片，用 AskUserQuestion 请用户确认，再进入检索。
3. **每条数据标注来源。** 航班记录标 `直飞` 或中转城市，报告页脚写 `sourceNote`（数据来源与查询时间）。
4. **预算由用户给定。** 住宿每晚价格、可请几天假，都问清楚后写进 config。

## 流程

### 第 0 步：凭据检查

开始检索前执行一次（这一步本身零成本，不发任何付费请求）：

```bash
node scripts/doctor.js
```

三个凭据分三档，**没有任何一项是死路**：

| 凭据 | 档位 | 缺了怎么办 |
|---|---|---|
| `VARIFLIGHT_MCP_KEY` | **必选** | 按「API Key 配置」引导，一条命令写进 mcp.json；用户拒绝则走第 3 步路径 B 手动录入 |
| `WENDAO_API_KEY` | 可选 | 跳过机场对比，直接把候选机场列给用户选 |
| `AMAP_API_KEY` | 兜底 | 只在问道给不出车程、或需要精确值时才用；都没有就问用户车程分钟数 |

**用户有权拒绝配置所有 key。** 一旦用户表示不想配，不要反复劝，直接：

```bash
node scripts/doctor.js --manual
```

它会打印需要手工收集的项，退出码 0，然后按第 3 步路径 B 走。`planner.js` 的测算逻辑不依赖任何外部服务，手动录入照样能出完整排名——丢的只是自动比价。

### 第 1 步：目的地、候选机场与地面接驳

1. 问清三件事：**雪场全名**、**出发城市**、**有没有机场偏好**。
2. 列出雪场周边的候选机场（一般 2–4 个）。判断依据是驾车用时与航线覆盖，不是单纯距离：第二近的机场常有更多班次和更低票价，值得一并比较。
3. **一次问全**：用 `references/wendao-prompts.md` 的**提示词 1** 发一轮，同时拿到「各机场有没有航班 / 几班 / 最早最晚落地 / 最低票面价 + 全程耗时 / 到雪场车程 / 雪场日场夜场」。按该文件的调用方式直接 POST，不封 CLI。

   - **整个行程问道只调 1 次**（就是这一步），定稿前可选再调 1 次做执飞校验。不要拆成「先问机场、再问骨架、再问营业时间」——实测一次就能全拿到。
   - 提示词里必须把**最低价和全程总耗时绑在一起问**，否则它会拿 14 小时过夜中转的 400 元当最低价，那个数字没有可比性。
   - 问的是**聚合量级**（几班、最早最晚、价位区间），不是逐条航班清单——要清单它只会每类给 2–4 条代表。
   - **否定判断要回查**：「深圳没有直飞张家口」这类结论用飞常准核实后再采信。
   - 问道按日配额、比飞常准宽松，但结果不可复现；问一次就把它榨干，别为同一件事重复问。
   - 没有 `WENDAO_API_KEY` 时跳过这一步，直接把候选机场列给用户，请他选。

4. **确定车程**。优先级：**问道给的值 → 高德（必要时）→ 用户口述**。

   - **默认直接用问道的车程**——它是同一次调用里免费拿到的。但那是粗值，预留按 **+30%** 取（不是高德的 +20%），并把 `destAirport.toResortMinutesSource` 写成 `wendao`，报告里会印「车程：问道估算」。
   - **这几种情况才去跑高德**（`toResortMinutesSource: "amap"`）：
     - 问道没给车程，或给得和距离明显对不上；
     - 两个候选机场的车程差在 30 分钟以内，排名对它敏感；
     - 用户明确要精确值；
     - 没配问道 key。

     ```bash
     node scripts/amap_route.js --from "<机场名称>" --to "<雪场名称>" --from-city <城市>
     ```

     输出 `toResortMinutes` = 驾车用时 + 预留，预留算子 **+20% 且至少 +15 分钟**，用 `--buffer-pct` / `--buffer-min` 调整。冬季山路、夜间、雪天把比例取到 30% 以上。
   - 三者都没有时，问用户「单程车程大概多少分钟」，加预留后继续，`toResortMinutesSource: "user"`。

5. **把对比表交给用户选**，用 AskUserQuestion 让他决定主选机场，以及是否把其他机场的航班一并纳入比较。选择权在用户，不要替他挑。

   ```
   header: 到达机场
   question: 雪场周边有这几个机场，样本日 <日期> 的情况如下（车程已含预留）：
             <机场A>  车程 XhXX  进场 <HH:MM>  约 <N> 班  价位 <区间>
             <机场B>  车程 YhYY  进场 <HH:MM>  约 <M> 班  价位 <区间>
             选哪个作为主选？
   options:
     - <机场A>（车程短）
     - <机场B>（航班多/票价低）
     - 两个都纳入，让方案自己比
   ```

   班次量与价位写「约」「区间」，因为这一步的航班数据来自问道，只作量级判断；车程要标明来源（实测 / 估算）。

6. 把「驾车 X 分钟 + 预留 Y 分钟 = Z 分钟」明确写进给用户的确认卡，Z 直接决定能滑多久。
7. **核实雪场营业时间**：日场起止、有无夜场及其起止、**哪几天不开放夜场**。以官方公示为准。提示词 1 里它也会给一版，但那只是线索——实测它把万龙写成「日场 08:00–21:30」，把夜场并进了日场；这个值直接决定雪时计算，错了排名全错。
8. **输出行程骨架并请用户确认**，格式见 `references/intake.md`。

多机场方案在后续阶段的两条约束：`scenarios[].out` / `.ret` 里每条航班补 `airport` 三字码；`destAirport.toResortMinutes` 取各机场车程中最长的一段，并在报告里说明。

### 第 2 步：采集参数

一次最多问 3 题，用选项式提问（`references/intake.md` 有现成选项集）。采集项：

- **出行时间范围**：哪几个周末或假期，每个对应报告的一个 Tab
- **住宿预算**：雪场每晚、转机城市每晚，分开问
- **年假预算**：可接受档位（0 / 0.5 / 1 / 2，或自定义）
- **税费口径**：每航段机建 + 燃油合计，给建议值让用户确认
- **请假口径**：上班时刻、半天分界、下班时刻三个值，默认 08:30 / 14:00 / 20:00，以选项形式请用户确认后填入 `params.leave`

### 第 3 步：检索航班

按「请假档位」自动铺日期，一个往返一次调用：

```bash
node scripts/flight_query.js \
  --from <出发城市码> --to <到达城市码> \
  --weekend YYYY-MM-DD --leave-days <0|0.5|1|2> \
  --both --out <场景key>.json
```

`--weekend` 传该周末任意一天，脚本自动归到周五，再按请假天数铺日期：

| 请假 | 去程 | 返程 | 数据源 |
|---|---|---|---|
| 0 | 周五、周六 | 周日 | 3 |
| 0.5 | 周五、周六 | 周日、周一 | 4 |
| 1 | 周四、周五、周六 | 周日、周一、周二 | 6 |
| 2 | 周三…周六 | 周日…周三 | 8 |

- **积分按唯一「出发→到达」城市对计费，与日期数无关。** 一个往返周末固定 2 分，铺几天都一样。
- **优先用城市码**：`BJS` 覆盖首都 + 大兴，`SHA` 覆盖浦东 + 虹桥，一次查询拿全，省掉逐个机场预查。跨城市的多机场（如长春 CGQ 与沈阳 SHE）才需要分开查。
- `--chunk 3`（默认）控制每次调用的数据源数。返回 `truncated: true` 说明有数据被静默截断，调小 `--chunk` 或 `--per-transfer` 重跑。
- `--per-transfer 15`（默认）控制每个日期保留的中转条数；直飞与经停全留。
- 输出 `{ out, ret }`，字段与 config 的航班对象一致：`price` 是票面价，`tax` 是实际机建 + 燃油，`arrDate`、`seg`、`tag` 都已填好，直接拼进 `scenarios[].out` / `.ret`。
- 同一航班号同日多条以最低价为准（脚本已去重）。
- 加 `--raw` 可看本次调用的积分消耗、行数与截断情况。

**查询结果自动缓存**（`<技能根>/.cache/`，也可用 `SKI_CACHE_DIR` 指定）。查询很贵，重跑不该再花一次钱：

- 缓存键是 `(工具, 参数)` 的哈希，参数里含完整 SQL —— 同样的命令重跑必然命中，改了日期或航线就是新键。
- **存的是原始返回，不是解析后的对象**，所以解析逻辑以后改了，老缓存照样能重新解析。
- 新鲜期默认 6 小时（`--cache-ttl <分钟>` 可调）。超过新鲜期、上次被截断、上次就是失败记录 —— 这三种情况在正常模式下都重查，不拿残数据糊弄。
- **查询失败时自动回退到该键上的旧缓存**，输出里标 `fallback`。网络断了、key 过期了，活照样能干完。
- `--refresh` 强制重查并覆盖；`--no-cache` 完全不读不写。
- `meta.dataAt` 是这批数据真正的获取时间（有缓存命中时会早于「现在」）。**写报告 `sourceNote` 要用它**，不要写当前时间。
- 维护：`node scripts/cache.js list`（看有什么、多旧）、`prune`（清过期）、`clear`（清空）、`show <key>`（看某次的原始返回）。

**可选：执飞交叉校验。** 最终只差 1–2 个候选时，用 `references/wendao-prompts.md` 的**提示词 2** 问一次「这天执飞吗」。这是问道唯一比飞常准更值得信的场景（实测与飞常准库存一致），但它给的航班号偶发出错，所以只用来确认**已知航班号**，不要拿它发现新航班。两者冲突时以飞常准为准，并在回复里说明。

### 第 3 步 · 路径 B：手动录入（无任何凭据时）

用户拒绝配置所有 key、或 key 全失效且缓存也没数据时，**不要中止任务**。改成向用户收集航班，手工拼 `{ out, ret }`：

1. 跑一次 `node scripts/doctor.js --manual`，按它打印的清单逐项问用户（航班、车程、雪场时间、住宿、请假口径）。
2. 每个方向至少一条航班，否则那个方向没有组合可算。
3. 按 `references/manual-flights.md` 的完整示例拼 `config.json`——那份示例是可运行的，直接改数字即可。
4. 四个易错点：`price` 是裸票价、跨日必须写 `arrDate`、中转的 `dep`/`arr` 取首末段、`toResortMinutesSource` 如实填 `user`。
5. `sourceNote` 里写明「手动录入 + 日期」，并提醒用户票价非实时，下单前必须复核。

**脚本出错时**：每次运行都会写一份记录到 `<缓存目录>/runs/`，含完整命令行、每步输入输出、失败那次的 SQL 和缓存 key。出错时路径会打出来；也可以 `node scripts/journal.js list` 看历史、`show <runId>` 看详情。拿这份记录可以直接用缓存里的原始行手工拼结果，不必整条链路重跑。

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
- 请假天数的三段式判定（上班 / 半天分界 / 下班三个时刻，取值由用户给定）
- 税费优先取航班自带的实际机建 + 燃油（`tax` 字段），缺失时才按每航段默认值估算；红眼航班不计住宿、雪场晚数的推导
- 成本边界与敏感度检查方法

## API Key 配置

key 都从环境变量读取（飞常准允许回退读 `~/.workbuddy-ai/mcp.json`），变量名固定。

| 变量 | 档位 | 服务 | 用途 | 申请地址 |
|---|---|---|---|---|
| `VARIFLIGHT_MCP_KEY` | **必选** | 飞常准 MCP | 航班、时刻、含税票价、余票（主数据源） | https://cmcp.variflight.com/ |
| `WENDAO_API_KEY` | 可选 | 携程问道 | 一次问全的机场对比与骨架摸底、执飞校验（按日配额，不封 CLI） | https://www.ctrip.com/wendao/openclaw |
| `AMAP_API_KEY` | 兜底 | 高德开放平台 | 驾车路径规划（问道给不出车程或需要精确值时） | https://console.amap.com/dev/key/app |

飞常准 MCP 每月 100 积分，按唯一「出发→到达」城市对计费；`initialize` / `tools/list` 不扣分。积分用尽时换 Key，或先用 `--raw` 确认消耗。

### 检测成本（都是 0 成本或免费额度内）

| 凭据 | 检测方式 | 成本 |
|---|---|---|
| 飞常准 MCP | `initialize` + `tools/list` | **完全免费**，不扣积分 |
| 高德 | 1 次地理编码 | 免费额度内，不计费 |
| 携程问道 | 1 次真实查询 | 扣 1 次日配额 + 等 20–60 秒，**所以默认不探活** |

所以 `node scripts/doctor.js` 本身零成本（只读配置），`--probe` 也只探前两项。要连问道一起测才加 `--probe-wendao`。

### 缺 key 时怎么引导

按「索取 → 设置 → 验证」三步走，一次只处理一个 key。

1. **索取**：直接给出申请地址、这个 key 换来的数据、以及变量名，让用户可以立即去申请。
2. **设置**：飞常准用**一条命令**写完，其余给环境变量命令由用户自己执行。

   **飞常准 MCP（推荐，一条命令）**：

   ```bash
   VARIFLIGHT_MCP_KEY="你的 key" node scripts/mcp_config.js --write
   ```

   它会合并写进 `~/.workbuddy-ai/mcp.json`（已有内容先备份、其他 MCP 不动、key 打码显示）。
   之后还需要在 WorkBuddy 的「连接器管理 → 右上角自定义连接器」里点 **Trust**，新 MCP 才生效——这步无法脚本代替。
   检查是否配好：`node scripts/mcp_config.js --check`。

   **环境变量（三者通用）**：

   | 平台 | 命令 |
   |---|---|
   | macOS / Linux | `export VARIFLIGHT_MCP_KEY='你的 key'` |
   | Windows CMD | `set VARIFLIGHT_MCP_KEY=你的 key` |
   | Windows PowerShell | `$env:VARIFLIGHT_MCP_KEY="你的 key"` |
   | 长期生效 | 写入 `~/.zshrc` 或 `~/.bash_profile`；Windows 在「系统属性 → 环境变量」加用户级变量 |

3. **验证**：`node scripts/doctor.js --probe`（零成本），逐项确认可用性。

脚本在缺 key 时会直接打印这套引导（`scripts/keys.js`），把输出原样转给用户即可，不必改写。引导里已经带了申请链接、一键命令和检测成本，不要自己重写一份。

### 用户只能临时提供 key 时

用内联方式只传给本次进程，key 不落盘：

```bash
VARIFLIGHT_MCP_KEY="用户给的 key" node scripts/flight_query.js --from "<出发>" --to "<到达>" --date YYYY-MM-DD
```

问道没有 CLI，临时 token 直接塞进 curl：

```bash
WENDAO_API_KEY="用户给的 token" curl -sS -X POST 'https://externalcallback.ctrip.com/skills/api/crew/skillhub/searchInfo' \
  -H 'Content-Type: application/json' \
  -d "{\"inputs\":{\"token\":\"$WENDAO_API_KEY\",\"query\":\"<提示词>\"}}"
```

Windows 上已配置的用户级变量在当前会话取不到时，先取一次再执行：

```powershell
$env:VARIFLIGHT_MCP_KEY = [Environment]::GetEnvironmentVariable('VARIFLIGHT_MCP_KEY','User')
```

### 规则

- 变量名完全一致：`VARIFLIGHT_MCP_KEY`、`WENDAO_API_KEY`、`AMAP_API_KEY`。
- 高德 key 必须是**「Web 服务」**类型，并在控制台开通「地理编码」与「驾车路径规划」两项服务。
- key 只从环境变量或 `~/.workbuddy-ai/mcp.json` 读取：不写入 `config.json`，不写进 shell 脚本或任何仓库文件，不作为命令行参数传递，回复中不回显完整内容。
- **先跑零成本检查**（`node scripts/doctor.js`，只读配置不发请求），再决定要不要 `--probe`。
- 缺 `VARIFLIGHT_MCP_KEY` 时先引导；**用户拒绝配置就直接转手动录入**（第 3 步路径 B），不要反复劝。
- 缺 `AMAP_API_KEY` 不阻塞：车程优先用问道的值，其次问用户。
- 引导文案直接转 `scripts/keys.js` 的输出，里面已含申请链接、一键命令、检测成本，不要自己另写一份。

## 运行环境

| 依赖 | 说明 |
|---|---|
| Node.js ≥ 18 | 脚本使用内置 `fetch`，无 npm 依赖 |
| 网络 | `c-gw.variflight.com`、`restapi.amap.com`、`externalcallback.ctrip.com` 可达 |
| 可写目录 | `<技能根>/.cache/`（可用 `SKI_CACHE_DIR` 改）。不可写时缓存与运行记录自动降级为关闭，脚本照常跑 |

## 文件说明

| 路径 | 用途 |
|---|---|
| `scripts/planner.js` | 测算引擎 + HTML 生成。纯参数驱动，无内置地点/日期，缺参即报错 |
| `scripts/flight_query.js` | 航班检索（飞常准 MCP），按请假档位铺日期，输出可直接写入 config 的 `{ out, ret }` |
| `scripts/variflight.js` | 飞常准 MCP 客户端：JSON-RPC/SSE 解析、SQL 构造、日期窗口、结果映射、缓存读写 |
| `scripts/cache.js` | 查询结果缓存：按 (工具, 参数) 哈希落盘原始返回，带新鲜期、失败回退、过期清理；也可单独 `node scripts/cache.js list` 维护 |
| `scripts/journal.js` | 运行记录：每次运行写 `runs/<runId>.json`，含命令行、每步输入输出、失败 SQL、缓存 key；`list` / `show` / `clear` |
| `scripts/mcp_config.js` | 一条命令把飞常准 MCP 合并写进 `~/.workbuddy-ai/mcp.json`，带备份与 `--check` / `--print` / `--remove` |
| `scripts/amap_route.js` | 高德驾车用时查询，输出含预留的 `toResortMinutes`。兜底用，不是主路径 |
| `scripts/airport_scan.js` | 可选：多机场精确预查（同日票价 + 车程横向对比）。会消耗飞常准积分，主流程用问道粗筛代替，仅在用户要求精确预查时使用 |
| `scripts/wendao.js` | 携程问道的请求与解析实现，供需要编程调用的场景使用。主流程不经过它，粗筛直接按 `references/wendao-prompts.md` 发原始请求 |
| `scripts/amap.js` | 地理编码与驾车路径规划实现，被上面两个路线脚本共用 |
| `scripts/keys.js` | 凭据登记表（三档 role）与缺 key 引导文案，所有脚本共用 |
| `scripts/doctor.js` | 凭据检查：默认零成本；`--probe` 只探免费项；`--probe-wendao` 才测问道；`--manual` 输出手动录入清单 |
| `references/wendao-prompts.md` | 携程问道的提示词库：一次问全的机场对比提示词、执飞校验提示词、四条写法原则与字段可信度 |
| `references/intake.md` | 问答脚本：该问什么、选项怎么给、骨架确认卡长什么样 |
| `references/config-schema.md` | config.json 逐字段说明与可复制骨架 |
| `references/manual-flights.md` | 手动录入模式：不配任何 key 时怎么收集航班、可直接运行的完整示例、四个易错点 |
| `references/algorithm.md` | 计算模型、边界条件、敏感度检查方法 |
