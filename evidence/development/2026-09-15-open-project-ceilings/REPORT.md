# 页面上"打开本地项目"失败：一次事故诊断与一处修复

日期：2026-09-15 · 触发：用户报告"在 Atlas 页面打开本地项目代码，失败了"
范围：只处理"打开并分析一个本机目录"这条真实路径，未改产品方向、未改工作包顺序。

## 1 结论先说

1. **页面这条链路本身是通的**：用一个绝对路径打开 `examples/calculator`，页面依次显示
   "正在索引 …" → "新项目已加载：探索、运行、审阅都指向这份新分析。"（真实浏览器，见第 5 节）。
   所以"打开失败"不是页面坏了，而是某些输入或某些项目会撞上服务端的硬上限。
1b. **最像"打开并分析失败"的那一种，是会话过期**：服务重启换令牌，而"再打开那条带令牌的地址"
   不会重新加载页面，页面就一直用旧令牌、顶栏还说"已连接"、「打开并分析」是灰的却不说原因。
   已修，见第 7 节。
2. **修掉了一个真缺陷**：解析 worker 的响应上限是写死的 `32 * 1024 * 1024`，失败只报
   `worker_output_limit`——没有数字、没有可改的东西。一个 77 个源文件的项目就撞上了它，
   整份索引作废。现在它是有名字、有数值、可调上限的 `--worker-output-mb`（默认 256 MiB）。
3. **下一个墙被指名了，但没有消除**：一份机器生成的小型函数（vendored 打包文件里的
   16 054 语句、10 975 binding）会被每函数预算拒绝，从而否决**整个项目**。这条预算不能靠
   调数字解决（第 4 节有测量）。要不要让这种项目仍能打开，是语义决定，见第 6 节。
4. **没有找到用户那次尝试留下的痕迹**：本机所有 store 里都不存在与用户时间点对应的
   "有快照、无分析"记录（第 3 节）。也就是说用户撞到的大概率是**索引开始之前**就失败的那几类
   （路径不是目录 / 会话失效 / 已有作业在跑），而不是本次修掉的大项目上限。这一条需要用户确认。

## 2 用户报告的路径与它留下的痕迹

页面上"打开并分析"的完整链路：`POST /api/project/open {path}` → 服务端在后台索引 →
页面每 1.2 s 轮询 `GET /api/project/open?id=` → `switched` 时切换并刷新。

失败点分成两类，区分它们的正是"store 里有没有留下快照"：

| 阶段 | 失败 | 服务端返回 | 痕迹 |
|---|---|---|---|
| 校验 | 路径不是目录（含 `~` 开头、相对路径、指向文件） | 400 `path_not_a_directory` | 无快照 |
| 校验 | 目录读不到（权限/消失） | 400 `path_unreadable` | 无快照 |
| 校验 | 会话或来源不符 | 401 `local session required` | 无快照 |
| 校验 | 同一时刻已有索引作业 | 409 `open_already_running` | 无快照 |
| 索引 | 解析响应超限（**本次修掉**） | 作业 `failed` `worker_output_limit` | 有快照、无分析 |
| 索引 | 每函数预算超限（**仍然存在**） | 作业 `failed` `flow_function_budget_exceeded` | 有快照、无分析 |

## 3 为什么判断用户撞的是"索引之前"那一类

命令（在仓库根）：

```
for db in local-state/*/atlas.db; do
  sqlite3 "$db" "select count(*) from snapshots;"; sqlite3 "$db" "select count(*) from analyses;"
  sqlite3 "$db" "select id from snapshots where id not in (select snapshot from analyses);"
done
```

结果：只有 `local-state/demo-tour` 存在孤儿快照，且它们全部产生于本次诊断期间（08:33 的直接
API 调用、08:37 与 08:52 的页面复现）。其余 store（calculator、ctx、demo、loc、mt、unreach）
最后修改时间都是 09-08 / 09-12，与用户这次操作无关。

推论：用户那次尝试**没有进入索引阶段**。但用户页面当时正对着我 08:22 启动的服务，而 08:26–08:33
之间我在用同一台服务跑自己的探测（会占用"一次只允许一个索引作业"的名额），因此
`open_already_running (409)` 与 `path_not_a_directory (400)` 都是合理解释，需要用用户看到的
那句话来定。

## 4 两个墙的测量

### 4.1 已修：解析响应上限 32 MiB

工作区外探针 `probe-worker-output.cjs`（按 `is_source` 的口径收集文件，直接喂给
`workers/typescript/worker.mjs`）：

```
files=77 payload_bytes=2545125 (2.4 MiB)
exit=0 seconds=8.7 stdout_bytes=92579300 (88.3 MiB) stderr=""
  flow             66.00 MiB
  calls            19.29 MiB
  symbols          2.97 MiB
  biggest flow functions:
    symbol:web/vendor/elk.bundled.js:8841:1604190   7913 KiB
```

输入 2.4 MiB、输出 88.3 MiB，而 Rust 侧只读 32 MiB：这是设计上的量级错配，不是项目"太大"。
快照规模（同一 store）：2734 条目录项、2521 个 captured、48.2 MB，其中 1860 个 `.log`、
183 个 `.png`——它们**不会**进入 worker（`scan::is_source` 只认
js/jsx/mjs/cjs/ts/tsx/mts/cts 与 `package.json`），所以这 88 MiB 全部来自 77 个 JS/TS 文件。

### 4.2 未修：每函数预算

`crates/atlas-engine/src/flow.rs`：`MAX_FUNCTIONS=20000`、`MAX_STATEMENTS_PER_FUNCTION=20000`、
`MAX_BINDINGS_PER_FUNCTION=4000`、`MAX_SCOPES_PER_FUNCTION=4000`。用探针数出的结果：

```
flow.functions=13334 over-budget=1
  symbol:web/vendor/elk.bundled.js:8841:1604190  bindings=10975 scopes=2 body=16054
```

13334 个函数里只有 1 个越界，而"每函数覆盖契约"（`flow_coverage_mismatch`）不允许部分 flow，
于是一个打包文件里的一个函数否决了整个项目。

**把预算提到与语句预算一致（20000）试过了，结论是不能这么修**：

```
$ /usr/bin/time -l ./target/debug/atlas --store local-state/demo-tour index . --index-deadline-seconds 120
exit=1
      123.46 real       102.68 user         6.19 sys
          1648431104  maximum resident set size
Error: Invalid("analysis_deadline_exceeded_no_analysis_published")
```

改之前：约 90 s 给出一个有名有姓的拒绝；改之后：耗光 120 s 管线预算、1.65 GB 峰值内存、
什么都没发布（默认 600 s 预算下另一次运行跑到 327 s 被结束、同样没有输出）。
所以 4000 不是随手写的数字，它是把"一个机器生成的巨型函数"挡在求解器之外的护栏。
这条测量已作为注释写回 `flow.rs`，以免下一个人再试一遍。

## 5 改动清单与验证

### 改动

- `crates/atlas-app/src/worker.rs`：响应上限与 stderr 上限分开命名；
  响应超限报 `worker_output_limit:limit_mb=<n>:raise --worker-output-mb`，
  stderr 超限报 `worker_stderr_limit:limit_bytes=65536`（不再冒充"答案太大"）。新增 2 个测试。
- `crates/atlas-app/src/main.rs`：新增 `DEFAULT_WORKER_OUTPUT_MB = 256` 与
  `--worker-output-mb`；按 `--worker-heap-mb` 的既有路径串联
  `IndexOptions`（`new`/`from_args`/`fingerprint`/`stored`/`from_job`）、`StoredOptions`、
  `StoredVerify`（含 `serde` 默认值，老作业行仍可运行）。
- `crates/atlas-app/src/server.rs`：`ServerConfig.worker_output_mb`，页面打开项目与
  补丁验证都走同一个上限。
- `crates/atlas-app/src/patchwork.rs`：`VerifyOptions.worker_output_mb`。
- `crates/atlas-engine/src/flow.rs`：预算失败改为
  `flow_function_budget_exceeded:what=…:count=…:limit=…:path=…:start=…:end=…`，
  并写回上面那次测量。保留了 `flow_function_budget_exceeded` 前缀。
- 删除的那处：`32 * 1024 * 1024` 硬编码。

### 验证（真实 exit code）

```
$ cargo build                 → exit 0
$ cargo test                  → exit 0；129 passed / 0 failed
                                (7 worker + 68 engine + 4 engine + 24 engine + 9 app + 17 app)
```

真实浏览器（playwright-core 1.63 + 本机 Chromium，服务 127.0.0.1:8791，见 `repro-page-open.cjs`）：

- 打开 `examples/calculator` → `新项目已加载：探索、运行、审阅都指向这份新分析。`
- 打开本仓库 `/Users/yinsijie/CodeRepo/Atlas` → 34 s 后
  `打开未完成：failed（flow_function_budget_exceeded:what=bindings:count=10975:limit=4000:path=web/vendor/elk.bundled.js:start=8841:end=1604190）`

失败信息从"某个预算超了"变成了"哪一行、哪个数、哪个上限"。

## 6 待决定（不是本次能替用户定的）

`vendor` 里打包进来的机器生成代码让整个项目打不开，有三种收尾方式：

- **A 每函数排除并如实登记覆盖**：仍列出该函数（可搜、可当调用目标），但不给它 flow，
  并在覆盖里显式写"超出数据流预算"。符合"显式未知与覆盖"这条边界，代价是契约 + worker +
  引擎 + 页面一起改。
- **B 由操作者声明哪些路径不做数据流**：例如 `vendor/**.bundled.js`、`*.min.js`，文件仍被扫描与列出，
  只是没有函数级数据流。新增一个声明入口，不用启发式猜。
- **C 维持拒绝，但把原因说清楚**：本次已做到这一点。

## 7 第二处缺陷：服务换了令牌，页面不接（这才是"打开并分析失败"最像的样子）

在真实浏览器里把"打开并分析"逐个输入试过（`probe-open-inputs.cjs`，全部实测）：

| 输入 | 页面原样回答 |
|---|---|
| 空 | `先输入要打开的本机目录（绝对路径）` |
| `~/CodeRepo/Atlas` | `打开失败：path_not_a_directory (400)` |
| `examples/tour`（相对路径） | 成功（服务端的 cwd 恰好是仓库根，所以相对路径"能用"是巧合，不是承诺） |
| `/…/README.md`（指向文件） | `打开失败：path_not_a_directory (400)` |
| `/…/not-here`（不存在） | `打开失败：path_not_a_directory (400)` |
| `/…/examples/flow-lab`（正常绝对路径） | `新项目已加载：探索、运行、审阅都指向这份新分析。` |

也就是说按钮和接口本身是好的。真正会让人说"打开并分析，失败"的是**会话过期**这一种：

- 服务每次启动换一个新令牌；而"再打开一次那条带令牌的地址"在浏览器里只是**换 fragment、
  不重新加载文档**。页面在加载时只读一次 fragment（`app.js` 顶部那段），没有任何
  `hashchange` 处理，于是它一直用着旧令牌：界面写"已连接"，每个请求却都是 401，
  `state.token` 被清空后「打开并分析」是灰的——**屏幕上没有任何一句话说明原因**。
- 同一处还有一个说谎的细节：`connect()` 失败时清掉了令牌却没有重新渲染，顶栏就一直停在
  "已连接"，项目页说"已连接，但还没有读取到分析版本"。

改动（`web/app.js`）：

1. `connect()` 失败时重新渲染顶栏与当前页，缺了令牌的项目页改为说明
   "服务每次启动都会换一个新令牌……重新打开它打印的那条带令牌地址：页面会就地接上新令牌
   （不用刷新页面），也可以把新令牌填到右上角「连接会话」"，并让「打开并分析」确实置灰。
2. 新增 `hashchange` → `adoptFragmentToken()`：运行中从 fragment 接上新令牌（`typeof window`
   保护，行为测试的 `node:vm` 沙箱里没有 `window`）。

实测（`probe-session-token.cjs` / `probe-dead-session-card.cjs`，真实浏览器）：

```
1. 用已失效令牌加载        nav="未连接"  status="会话已失效或令牌不正确 (401) · 会话已失效，请重新粘贴令牌"
                          项目页按钮 disabled=true，卡片写明换令牌与恢复办法
2. 只换 fragment 换新令牌   nav="已连接 · 2188bbf2" project="tour"（没有刷新页面）
                          GET /api/report -> 401 后紧跟 GET /api/report -> 200
3. 随后"打开并分析"        status="新项目已加载：探索、运行、审阅都指向这份新分析。"
```

`web/tests/app.behavior.test.mjs` 78 项、`web/tests/city3d.behavior.test.mjs` 28 项全部通过
（exit 0）。**注意**：`web/*.js` 是编译期嵌入的（`include_str!`），改了页面必须 `cargo build`
再重启服务，否则浏览器拿到的还是旧文件——本次第一轮验证就踩了这个坑。

## 8 4.2 那个墙：按文件整体撤下数据流，并如实登记（已做）

用户第二次报告"又打开了一个项目，显示失败"，store 里多出来的孤儿快照（09:04）
正是本仓库自身——也就是说他打开的就是 `/Users/yinsijie/CodeRepo/Atlas`，撞的是第 4.2 节那个
`web/vendor/elk.bundled.js`。于是按第 6 节的 A 方案实现：**不再让一个机器生成的函数否决整个项目**。

### 语义

- 触发：任一函数的 `bindings > 4000` 或 `scopes > 4000`（原有护栏不动，第 4.2 节的测量仍然成立）。
- 单位是**文件**而不是函数，这是被契约逼出来的：嵌套函数的 `captures` 指向外层函数声明的 binding，
  只摘掉一个函数的 flow 会让同一文件里另一个函数留下悬空 capture——那是协议损坏，不是未知。
  词法捕获不会跨文件，所以整文件撤下恰好只移除它自己声明的 binding，外部不可能悬空。
- 被撤下的文件保留全部符号、调用与源码（仍可搜索、仍可当调用目标），只是没有数据流，
  并且**必须在覆盖、诊断、限制三处登记**；`validate_flow_with_symbols` 新增的 `withheld`
  是白名单而非后门：白名单里的符号必须没有 flow、必须是快照里真实存在的符号，白名单之外
  一个符号都不许缺 flow（`flow_coverage_mismatch`），有 flow 的符号不许同时出现在白名单里
  （`flow_withheld_but_present`）。

### 实测

CLI（`index-atlas-repo-cli.json`）：`exit=0`，约 119 s

```
analysis 41f5fbb64698 · functions 13306 · files 2537 · calls 78219
flow_functions 2180 · flow_withheld_functions 11126 · flow_withheld_files 1
diagnostic: flow_withheld_over_budget bindings=10975 limit=4000 offenders=1 functions=11126 [8841,1604190)
            path=web/vendor/elk.bundled.js
```

页面（真实浏览器，`probe-withheld-flow.cjs`，本次打开发布了 `0b1ec3c63660`）：

```
open      : 新项目已加载：探索、运行、审阅都指向这份新分析。（约 114 s）
nav       : Atlas
renderHome（web/app.js）: 值事实面板 = 算法 atlas-local-absint@0.2.2 · complete_within_profile · 54 块 / 342 次操作求值
elk 里的函数（$$b）     : 这个文件没有发布数据流：flow_withheld_over_budget bindings=10975
                          limit=4000 offenders=1 functions=11126 [8841,1604190)。
                          它的符号、调用与源码照常列出，只是没有做数据流求值。
```

未知镜头里同一条诊断按 `web/vendor/elk.bundled.js …` 列出，与 `web/tests/*.mjs` 的两条
`FLOW_UNKNOWN_REGION` 并列——撤下是"已声明的未知"，不是"加载失败"。

### 改动

- `crates/atlas-engine/src/flow.rs`：新增 `WithheldFlow` / `over_budget()` / `withheld_files()`；
  `validate_flow_with_symbols` 增加 `withheld` 参数与两个方向的反查；新增 2 个单元测试。
- `crates/atlas-engine/src/analyze.rs`：在校验之前按文件撤下 flow，写入 `coverage`
  （`flow_withheld_files` / `flow_withheld_functions`）、`diagnostics`（`flow_withheld_over_budget`）
  与 `limitations`；校验改用新签名。
- `web/app.js`：`withheldFlowFor/withheldFlowText`，值事实面板与未知镜头都按分析的诊断如实转述，
  不再把已声明的未知说成"值事实加载失败"。

测试：`cargo test` exit 0（131 项，含 flow 模块新增 2 项）；`node web/tests/app.behavior.test.mjs`
78 项、`city3d` 28 项全部通过。

## 9 第三处同一类缺陷：扫描预算无名、无杠杆（hermes 1.3 GB）

用户报告"打开并分析 `/Users/yinsijie/CodeRepo/Modus 学习对象/hermes-agent-main` 失败"。
复现（真实 API，新构建）：20 s 内

```
failed | total_byte_budget_exceeded_no_snapshot_published:observed_mb=64:limit_mb=64:raise --max-total-mb
```

仓库实测：**99843 个文件 / 1.3 GB**；预算 `max_entries=20000`、`max_file_bytes=2 MiB`、
`max_total_bytes=64 MiB`（`ScanLimits::default()`，此前写死在 `run_pipeline` 里）。

两点与前面两处同源：**上限没有数值、也没有可调入口**；而且这里连"是哪个上限"都要靠猜。
拒绝本身是**有意的**（不是截断）：一份只覆盖了项目一部分的快照会让所有计数变成假话，
所以 `scan.rs` 的两个超限都是 `…_no_snapshot_published`。保留这个语义，只补上"数值 + 杠杆"。

### 改动

- `crates/atlas-engine/src/scan.rs`：两处超限都改成带观测值与上限、并给出旗标
  （`entry_budget_exceeded_no_snapshot_published:entries=…:limit=…:raise --max-entries`、
  `total_byte_budget_exceeded_no_snapshot_published:observed_mb=…:limit_mb=…:raise --max-total-mb`）。
- `crates/atlas-app/src/main.rs`：新增 `ScanLimitArgs`（`--max-entries` / `--max-file-mb` /
  `--max-total-mb`），用 `#[command(flatten)]` 加到 `index`、`serve`、`job`（RunnerArgs）、
  `patch verify` 四处；`ScanLimits` 作为**一个**字段按 `worker_output_mb` 的既有路径串进
  `IndexOptions`（`new`/`from_args`/`fingerprint`/`stored`/`from_job`）、`StoredOptions`、
  `StoredVerify`（都带 `serde` 默认值，老作业行仍可运行）、`ServerConfig`、`VerifyOptions`。
  队列作业与补丁验证因此重放同一次扫描预算，而不是悄悄退回默认值。

### 实测（诚实版：杠杆通了，整个仓库仍然打不开）

```
$ ./target/debug/atlas --store local-state/hermes-probe index "<hermes>" \
      --max-total-mb 256 --index-deadline-seconds 180
Error: Invalid("analysis_deadline_exceeded_no_analysis_published")   # 扫描已越过 64 MiB，死在管线期限
```

也就是说：64 MiB 那个拒绝已经解除，下一个边界是**管线期限**，而真正的瓶颈是吞吐量——
`hermes-agent-main/ui-tui`（**443 个文件**）从页面打开成功，但耗时 **418 s**（约 7 分钟）。
1.3 GB 的整仓库远超 600 s 的 index 期限，这不是加一个旗标能解决的，属于已推迟的
large-repository 资格（AGENTS.md 明确把"大仓库资格"列为推迟项）。

另有两点关于这个仓库的实情：

- 它主要是 Python（约 5000 个 `.py`），而 Atlas 的 worker 只解析 JS/TS，因此 Python 部分
  不会产出任何函数；有意义的对象在 `apps/`（1368 ts + 602 tsx）、`ui-tui/`（357 ts + 72 tsx）、
  `web/`（197 ts + 164 tsx）。
- 今天可用的路径是**开子项目**：`ui-tui` 已经打开并被登记进"最近项目"（分析 `8665a7d8…`），
  页面上一键即可切回。

### 验证

- `cargo test` exit 0（131 项）；`node web/tests/app.behavior.test.mjs` 78 项、`city3d` 28 项通过。
- 页面路径复现的失败信息已变为上面那条带数值与旗标的形式。
- `./target/debug/atlas index --help` 三面旗标可见。
- 证据目录留了一个 120 MB 的探测 store `local-state/hermes-probe`（gitignored）：删除被安全
  阈值拦下，未执行，留给用户处置。

## 10 hermes 一路撞到的边界链，以及其中一个是**真 bug**

用户第三次报告同一个项目打不开。放开扫描预算后逐层量下去，得到一条完整的边界链：

| 顺序 | 边界 | 实测 | 处置 |
|---|---|---|---|
| 1 | `max_total_bytes` 64 MiB | 仓库 1.3 GB | 已可调（第 9 节） |
| 2 | worker `timeout_seconds` 默认 60 s | 整仓库 JS/TS **60.2 s**、输入 15.5 MiB、输出 160.5 MiB | `serve` 现在可给 `--timeout-seconds`（第 10.1 节） |
| 3 | `worker_file_coverage_mismatch` | **真 bug**，见 10.2 | 已修 |
| 4 | `MAX_FUNCTIONS` 20000 | 该仓库 **34635 个函数** | 已提到 50000，见 10.3 |
| 5 | 管线期限 | 约 55 ms/函数 → 估计 35–45 分钟 | 服务端可用 `--index-deadline-seconds 3600` |

另有两条与用户目标相关的事实：`hermes-agent-main/web` 用默认预算 **31 s** 就能打开；
`apps/` 扫描能过、但解析超过默认 60 s（`worker_deadline`）。

### 10.1 `serve` 现在能给出扫描/解析/管线三个预算

`ServerConfig` 一直有 `timeout_seconds` / `scan_deadline_seconds` / `index_deadline_seconds`
三个字段，但只是 `Default`（60/300/600），没有命令行入口——也就是说**页面这条路径的"打开并分析"
永远被钉在 600 秒**，再大的预算也没用。现在 `serve` 接受这三面旗标（`--timeout-seconds` /
`--scan-deadline-seconds` / `--index-deadline-seconds`），与 `index` 同名同义。

### 10.2 真 bug：源码 `import` 了 `package.json`，整个项目就永远分析不了

失败信息原本只有一句 `worker_file_coverage_mismatch`，不点名。按本仓库今天的做法先让它点名：

```
worker_file_coverage_mismatch:requested=2045:acknowledged=2046:missing=0:unexpected=1:
  unexpected_files=["apps/desktop/package.json"]
```

根因：`store.sources_controlled` 会**故意**把 `package.json` 发给 worker（"JSON 只被 TypeScript
的虚拟模块解析器读取，从不执行"）。当某个源文件 `import` 了它（hermes 的
`apps/desktop` 就这样），TypeScript 会把它加载进 program，worker 的 `parsed_files` 里就
出现 `apps/desktop/package.json`；而引擎的 `expected` 只认 `is_source`（js/jsx/mjs/cjs/ts/tsx/mts/cts），
于是 `expected != acknowledged` → **拒绝整个项目**。

也就是说：**任何源码里 import 了 package.json 的项目都打不开**（Vite / Electron / React 项目很常见），
与项目大小无关。这是一个正确性 bug，不是预算。

修法（`crates/atlas-engine/src/analyze.rs`）：把不变式改成契约真正要的那三条——
必须回报的恰好是"我请求的源文件"；**允许**回报"我交给它的任何文件"（含那份 JSON）；
不许重复。三个方向都保留，且失败仍然点名 `missing_files` / `invented_files`。

### 10.3 函数总量上限：这个可以提，与每函数预算不同

`MAX_FUNCTIONS` 从 20000 提到 50000。理由要与 4.2 节那次失败的尝试对照着读：

- 每函数预算（bindings/scopes 4000）**不能**提：实测把预算提到 20000 后，同一个项目耗光
  120 秒管线预算、1.65 GB 峰值内存、什么都没发布——那是护栏。
- 项目函数总量**不是**那种护栏：函数个数是项目的属性，成本线性（实测约 55 ms/函数），
  而且管线期限仍然兜住整个运行。它只是一条内存天花板，而 20000 这条线把一个**管线本身健康**
  的真实仓库挡在外面（34635 个函数）。拒绝信息本来就带 `functions=34635:limit=20000`。

### 10.4 验证

- `cargo test` exit 0（131 项，flow 模块含新增 2 项）；`node web/tests/app.behavior.test.mjs` 78 项、
  `city3d` 28 项通过。
- 修好覆盖不变式后，同一条路径的失败从"第 3 层"推进到"第 4 层"并被点名
  （`flow_function_budget_exceeded:functions=34635:limit=20000`），证明 10.2 的修复生效。
- 提高 `MAX_FUNCTIONS` 后重跑整仓库索引：**成功发布**，约 10 分钟（11:23 启动，11:33 完成），
  比按 55 ms/函数估的 35–45 分钟快得多。`/tmp/hermes-full.json`：

```
analysis  cc5214bbd69f7ebf78a8c1ddc4061ede2efe5623beb5d15a9c785b6871897861
functions 34635 · files 8207 · calls 123946（unresolved 105006）
flow      34635（withheld 0）· complete_within_profile 0 · partial 34635
catalog   9160 entries · captured 8169 · diagnostics 28
```

  随后用 `serve <analysis> --project <hermes 路径>` 直接把它挂到页面上（项目名与目录正确显示，
  `GET /api/search?q=main` 命中 964 个函数），确认这条路径端到端可用。

  关于这份分析的**如实保留**：34635 个函数全部是 `partial`（没有一个达到 complete_within_profile），
  123946 个调用里 105006 个未解析——这是一个真实 TSX 单仓库的常态，页面在未知镜头里如实列出，
  不当作"分析完整"。另外该仓库约 5000 个 `.py` 不会产出任何函数：worker 只解析 JS/TS。

## 11 未做的事

- 未改 `docs/implementation/progress.json`：它在本工作树里已有他人未提交的改动，
  且本次不是工作包交付；进度指针留给认领这条事故的人。
- 未合并 4.2 的两种方案中的任何一种，见第 6 节。
- 未复现用户亲眼看到的那一条失败信息（第 3 节说明原因）。
