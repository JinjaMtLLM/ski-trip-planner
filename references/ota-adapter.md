# OTA 补数适配层（third_party/ticket-monitoring）

飞常准 1 分/次、100 分/月，且不给退改与行李额；OTA 免费、给中转停留分钟，
但它是「轮询 + 落库 + 告警」的完整应用，不是查询库。这一层只做一件事：
**把 OTA 明细变成 legs.js 认识的缓存条目**，让下游 `legs → enumerate → render`
一行都不用改，两个数据源也就天然可切换。

## 1. 目录与入口

```
third_party/ticket-monitoring/     ← submodule，钉在 844c5e1，**任何情况下不改它**
scripts/ota/fetch.py               ← 抓数驱动：import 它的 crawlers，归一后落盘
scripts/ota/bridge.js              ← 桥接：OTA 明细 → 飞常准格式缓存条目
scripts/ota/cli.js                 ← 唯一入口：体检 / 抓 / 桥 一条命令
references/ota-adapter.md          ← 本文
```

```bash
node scripts/ota/cli.js cases/jjs-cny/case.json --check          # 体检：submodule / python / 明细目录
node scripts/ota/cli.js cases/jjs-cny/case.json --fetch          # 抓缺失的日期，再桥接
node scripts/ota/cli.js cases/jjs-cny/case.json                  # 只桥接已有明细
node scripts/ota/cli.js cases/jjs-cny/case.json --cache-dir tmp/x --dry   # 隔离试跑，不落盘
node scripts/legs.js cases/jjs-cny/case.json                     # 之后照旧
```

`--fetch` 只抓「还没抓过的 (航线, 日期, 渠道)」，中断重跑自动跳过；
`--only SZX-AAT` 限定单条航线，`--channels fliggy` 限定渠道。

## 2. 为什么是「伪造缓存」而不是改 legs.js

`legs.js` 除了航班还要建高铁边、打车边、做同类接驳合并。复刻一遍必然出错，
所以只在数据入口处对齐：缓存条目的形状对了，下游就完全不知道数据来自 OTA。

缓存键**不能手拼**，必须与 `legs.js` 的 `readCachedFlights()` 用同一套函数：

```js
const sql = perDay ? vf.buildSqlPerDay(sources, perDay, market, maxStop)
                   : vf.buildSql(sources, perTransfer, market);
const key = cache.keyOf('getFlightTicketPrice', { sql });
```

键差一个字符就是「缓存未命中」，白抓一遍还不报错。

条目用 `cache.write()` 写（自带 `schema`/`key` 并更新索引）。手工 `fs.writeFileSync`
写的条目 `cache.read()` 会判成 miss，索引里也看不见——早先那版就是这么埋的坑。

## 3. 数据契约

`fetch.py` 的输出（键 = `FROM|TO|DATE`）：

```json
{ "SZX|AAT|2027-02-05": { "fliggy": [ {...}, ... ], "ctrip": [ ... ] } }
```

每行归一字段：

| 字段 | 含义 |
|---|---|
| `no` | 航班号，多段用 `+` 连接（`ZH9415+9C6685`） |
| `dep` / `arr` | `HH:MM`，本地时刻 |
| `arrDate` | 落地日期，跨天才有 |
| `segs` | 航段数：1 = 直飞/经停，2 = 一次中转，3 = 两次 |
| `via` | 中转城市中文名，直飞为空 |
| `stop` | 中转停留分钟（**渠道直接给**，比「时长做差」可靠） |
| `price` | 国内＝票面裸价；**国际＝已含税总价** |
| `tax` | 国内＝按 140×航段 估；国际＝携程 `adultTax` 分项 |
| `fare` | 仅国际行：票面（= `price − tax`） |

## 4. 含税口径（最容易错的一处）

| | 国内（fliggy / ctrip / tongcheng） | 国际（ctrip PC 列表） |
|---|---|---|
| `price` | 裸价 | **含税总价**（`ctrip.py:555` = adultPrice + adultTax） |
| `tax` | 渠道给 `transferTax`，缺失按 140×航段 估 | `adultTax` 分项，只作拆分 |
| 合成总价 | `price + tax` | **就是 `price`**，再加一次税就重复计税 |

`bridge.js` 的 `totalOf()` 用「有没有 `fare`」区分两种口径，别在别处再写一遍判断。

## 5. 筛选语义要复刻

`buildSqlPerDay(n)` 是「按 (起降时刻, 中转次数) 分组取最便宜，再按价格取前 n 条」；
`buildSql` 是「直飞全留 + 中转按价格取前 n」。不复刻的话每天 100+ 条全进图，
枚举规模翻几倍，结果也跟真跑 SQL 对不上。

- 分组用 `groupCheapest()`：同一 (dep, arr, transfers) 只留最便宜的那条。
- `params.perDay` / `params.perTransfer` / `params.directOnly` 原样沿用。
- 每个日期各自截断（`buildSqlPerDay` 也是逐 UNION 分支截断）。

**实测等价**：用这套桥接重建 `cases/jjs-cny` 与 `cases/rusutsu-cny` 的缓存后，
各年假档最优值与已交付页面对到分毫——将军山 919/858/786/745/751/730/712/723/669/654/620/617/573/574/546/573/560，
留寿都 1957/1870/1740/1678/1549/1510/1427/1347/1278/1256/1186/1166/1112/1095/1057/1035。
（旧缓存是「全部合并行、不分组」，行数多 17%，但被淘汰的都是同组更贵的重复项，
枚举结果一致——这也是分组版更该用的理由：同样的答案，更小的图。）

## 6. 四条硬规则

1. **不改 submodule**。只 `sys.path.insert` + `import crawlers` + 调 `safe_fetch()`。
   `debug/` 与 `user_data/` 落到 `tmp/ota/`（`make_cfg()` 里指定），不写进第三方目录。
   `cli.js --check` 会打印它的 `git status`，出现改动就是出事了。
2. **不覆盖真实飞常准条目**。真实条目是花积分换的。已存在且 `source !== 'ota'` 时
   默认跳过，要覆盖必须显式 `--force`。
3. **升级 submodule 要重跑等价性检查**。渠道页一改，`extra` 的字段名就可能变；
   换 commit 后先跑一遍 `cases/jjs-cny` 对比上面的数字。
4. **单渠道单日 19–32 秒**。比飞常准 1.6s 慢一个量级，**扫多日期不划算**，
   优先补「已经确定要查的那几天」，不要拿它做全季粗筛。

## 7. 已知局限

- 国际只有携程 PC 列表可用；同程国际日历 444 会话门、飞猪国际 PC 列表 HKG→CTS 返 0、
  途牛软墙、去哪儿要登录。详见 `references/ota-calendar-probe.md`。
- 携程日历层 `flightNo` 全空 → **算不出雪时**，只能做日期粗筛与交叉校验。
- 明细层的 `price` 各源口径不一（裸价/含税），跨源比价前必须统一，否则差 200–300。
- 跨日期方差为 0 的序列是占位值（携程 SZX→BJS 恒 400 等），必须剔除。
- 没有退改规则、没有行李额（飞猪偶尔给 `transferBaggage`，只作参考）。

## 8. 排错

| 现象 | 原因 / 处理 |
|---|---|
| `✗ submodule 未初始化` | `git submodule update --init --recursive` |
| `✗ 找不到能 import httpx 的解释器` | `python -m venv .venv-ota && .venv-ota/Scripts/pip install -r third_party/ticket-monitoring/requirements.txt`；或设 `SKI_OTA_PYTHON` |
| 桥接后 `legs.js` 报「缺缓存」 | 键不一致：确认 `case.json` 的 `perDay/perTransfer/market/maxStopMinutes` 与查询时完全一致（它们都参与 SQL 文本） |
| 某查询「没有任何 OTA 明细」 | 该日期没抓过，或渠道当天无票；`fetch.py --dry` 先看计划 |
| 行数比预期少 | `perDay` 截断（看 `行/池` 那一列），或该日渠道只回了部分航司 |
