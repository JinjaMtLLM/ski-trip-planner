# 交付页模板

两套版式，**都是由脚本生成、不是手改 HTML**。手改会立刻破坏 `data-bytes` / `data-sha256` 与 `#raw-manifest` 的三方一致性。

---

## A. 单场次报告（`scripts/render.js` 产出）

不需要模板文件——版式写死在 `render.js` + `design.js` 里，**换雪场只换 `case.json`，不要动渲染代码**。结构是固定的：

| 区块 | 内容 |
|---|---|
| 页头 | 雪场名、窗口、口径摘要（住宿单价、夜场权重、日场舍弃阈值、年假三段时刻） |
| 各档最优 | 每档一张横排卡片，只放该档第一名：元/雪日、雪时 + 总花费、出发时刻、回到起点时刻 |
| 趋势图 | 纯 SVG，元/雪日 / 雪时 / 总花费三条线画在同一画布、各自按自身量程铺满（只比斜率不比高低），左右两端标真实数值 |
| 页签 | `全部年假` + 每个实际出现过的档位（**档位来自数据，不来自配置**） |
| 明细表 | 列序固定：年假 · 出发 · 入场 · 去程路径 · 离场 · 返程路径 · 回起点 · 雪时 · 住宿 · 总花费 · 元/雪日 · 备注 |
| 页脚 | 元/雪日定义、有效雪时构成、日场舍弃阈值、年假口径（含节假日是否启用）、数据时效、生成时间与引擎版本 |
| 内嵌数据 | `<!--RAW-DATA-BEGIN-->` 之后：`case.json` / `network.json` / `legs.csv` / `legs.json` / `top.csv` + `algo/*.js` + `#raw-manifest` |

```bash
node scripts/legs.js      <case.json> --out legs.csv
node scripts/enumerate.js <case.json> --legs legs.json --top 30
node scripts/render.js    <case.json> --top top.json --legs legs.json --out report.html
```

路径首行是节点链（机场用 IATA 三字码，高铁站与雪场用中文），次行是班次 `ZH9101+G1234`；每处路径、雪时、住宿、总花费都有 hover 明细。

---

## B. 多场次对比页（页签版）

把若干份 A 报告装进一页，顶部加一个自绘的概览页签。

```
.tabbar（sticky）
  ├── 概览页签 → #pane-cmp（热力表 / 折线图 / 总表）
  └── 每场次一个页签 → #pane-<sid>（.pane.rp-pane，空的，运行时才建 iframe）
<script type="text/plain" data-emb="<sid>">  ← 每份 A 报告（去 raw 区 + 转义）
data-raw 块 × N                              ← 全部算例的原始交通数据
#raw-manifest                                ← 清单
```

### 一条命令

```bash
python templates/season-page/build.py                      # 用 season.config.json
python templates/season-page/build.py my-season.json       # 换一份配置
python templates/season-page/build.py --no-collect         # 跳过重算 season-data.json
python templates/season-page/build.py --no-verify          # 只出页面
```

它按死顺序做四件事，**顺序不能换**：

1. `collect.py` —— 各算例 `top.json` → `tmp/season-data.json`（概览页唯一的数源）
2. `build_season.py` + `build_season_all.py` —— 概览正文 + 页签 + 空面板 → `tmp/season_shell.html`
3. `attach.js` —— `embed.js` 的 `attach()`，塞原始交通数据与 `algo/*.js`，写 `#raw-manifest`
4. 回填 `<!--EMB-PAYLOADS-->`（**必须在 attach 之后**）
   然后 `verify_season_all.py` 六节校验，不全绿就退出非零。

第 4 步为什么不能提前：载荷里含字面量 `</body>`，`attach()` 用 `lastIndexOf('</body>')` 定位插入点，提前塞会被载荷抢走。

**前置**：每份报告已用 `render.js` 出好 `report.html`，每份 `top.json` 已用 `enumerate.js` 出好。模板不管查航班、不管枚举。

### 只改 `season.config.json`

换雪季 / 换雪场 / 加减场次，**只动这一个文件**，四个生成器都不用碰。仓里那份是 2026–27 雪季的实例，照它的结构改成自己的。

| 字段 | 作用 |
|---|---|
| `root` | 仓库根；不写则取本文件上两级的目录 |
| `title` / `pageTitle` | 概览页标题、`<title>` |
| `out` / `data` | 输出页、汇总数据的路径（相对 `root`） |
| `sessionHours` | 一个「整雪日」的小时数，元/雪日的分母基准（本项目 9.5） |
| `minDayH` | 日场最短可用时长，不足则整天记 0（默认 3，必须与 `case.json` 一致） |
| `leave` | 年假三段判定时刻 `dayStart` / `halfDayAt` / `dayEnd` |
| `colors` | 雪场码 → 图例色 |
| `resorts[]` | `code` / `name` / `region` / `lodge`（住宿人均），决定图例与热力表的行 |
| `sessions[]` | 概览的列：`id` / `label` / `note` / `cases{雪场码: 算例目录}` |
| `tabs[]` | 页签：`id` / `label` / `dir`（算例目录）/ `resort`（决定颜色） |
| `groups[]` | 页签分组：`label` + `at`（从第几个页签开始），组间强制换行 |
| `texts` | 页面上的人话：`lead` / `meta[]` / `hint` / `tabNote` / `footer`，留空则用自动生成版 |
| `refPage` | 页面上引用另一份交付页时的文件名（只影响文案） |
| `crossCheck` | 可选：`page` + `alias`，与另一份交付页交叉核对同名载荷是否逐字相同 |

`hint` 里可用 `{tabs}` `{cells}` `{ref}` 三个占位符，分别替换成页签数、算例数、`refPage`。

热力表配色只在 `build_season.py` 的 `pcol()` 里定义一次：`<700` 无色底、`700–1500` 绿→黄→红连续渐变、`≥1500` 深红文字无色底。图例从同一个函数采样，**别手写色值**。

### 内部分工（改的时候按这个找文件）

| 文件 | 职责 |
|---|---|
| `collect.py` | `top.json` → `season-data.json`；`KEEP` 决定保留哪些字段 |
| `build_season.py` | 概览正文 `sections()` + `CSS`；`pcol()` 唯一色源 |
| `build_season_all.py` | 外壳、页签、载荷；`shell/style.css` + `shell/runtime.js` |
| `attach.js` | 调 `embed.js` 的 `attach()`，只做这一步 |
| `verify_season_all.py` | 六节校验 |
| `sync_algo.py` | **修补工具**：把已生成页面里的 `algo/*.js` 换成当前 `scripts/` 版本并重算清单。正常交付走 `build.py` 不需要它 |
| `shell/` | 抽出来的基础样式与页签运行时，换雪季不用再找参考页 |
| `legacy/` | 一次性脚本（`build_cmp.py` 重建元旦对比面板、`verify_season.py` 轻量抽查），不参与 `build.py`、**不进分发包**，只在本仓库留作查证 |

### 三条铁律

1. **转义**：`escClose` = `\`→`\\` 再 `</script`→`<\/script`；`unescClose` 必须**逆序两步**（先 `<\/script`→`</script` 再 `\\`→`\`）。单遍正则会算错字节。
2. **读文件一律 `newline=''`**：Python 文本模式默认走通用换行，会把 CRLF 折成 LF，重算 `sha256` 全部对不上——页面本身是好的，是校验器错。
3. **改页面只改生成器**。已经生成好的页面要改内容，要么重跑 `build.py`，要么用 `sync_algo.py`（它知道要同时改块属性和清单）。手改一处会留过期属性。

### 校验清单（`verify_season_all.py` 已覆盖）

- 每个 `data-raw` 块三方一致：内容 ↔ `data-bytes`/`data-sha256` ↔ `#raw-manifest`
- `text/plain` 与 `application/json` 块内无裸 `</script>`
- 每份 `data-emb` 逐字还原 = 对应 `report.html` 去 raw 区后
- 配了 `crossCheck` 时，同名载荷与另一份交付页逐字一致
- 页签与面板一一对应，运行时唯一
- 概览正文标签配平；热力表逐格比对数值 + 底色 + 字色 + 字重；总表逐格回查 `season-data.json`
- 折线图点数 = 有数据的「雪场 × 档位」组合数
