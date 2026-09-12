# W08 深化：嵌套闭包只能被真实产生（`--via`）

窗口：`2026-09-12/w08-closure-via`
日期：2026-09-12（Asia/Shanghai）
结论：**DELIVERED**。执行画像里最后一块"应当存在但不可运行"的类别——嵌套函数捕获的外层绑定——现在有一条真实的运行路径，而且这条路径不发明作用域。

## 1. 这一轮解决的是什么

W08 的画像把 `needs_context` 分成两类：**可以声明的输入**（`this`、具名全局）和**无法用数据声明的上下文**。后者在此之前只有一种：嵌套函数捕获的外层绑定。它的特点是：

- 捕获的绑定（例如 `let value = start; return function increment(step) { value += step; }` 里的 `value`）**不是参数命名空间里的东西**，所以调用者无法用 `--global value=...` 声明它；
- 它只在**包含它的那个函数运行期间**存在，所以也不能"从外面构造"；
- 它不是 `target_not_exported` 那种命名问题：即使你把包含函数整个复制出来，也只有真实执行它才会产生那个闭包实例。

之前的结论是"直接不可运行"。这一轮把它变成"只能经包含函数运行"，并且把"拿到的是不是那个函数"做成可核对的证据。

## 2. 交付的行为

### 2.1 画像知道闭包在哪里、捕获了什么

`ExecutionProfile` 新增三个字段（都对旧记录 `serde(default)` 兼容）：

- `captures`：捕获绑定的**名字**（从 `Capture(<binding id>)` 出发，先查已发布的 `binding_names`，查不到时只用 id 最后一段且必须像标识符；不允许把路径段冒充绑定名）。
- `enclosing_symbol`：目标的包含函数符号（来自分析图的 `node.parent`；`file:` 前缀表示顶层，此时为 `null`）。
- `enclosing_name`：给人读的名字，身份仍然只有符号 id。

`unsatisfiable_context` 里仍然是 `captures`（直接调用照旧拒绝），拒绝的 detail 现在点名捕获了哪些绑定、以及应当使用哪个 `--via` 符号：

```
函数依赖 Atlas 无法用数据声明的上下文：captures（捕获的绑定：value）；
该函数只能通过 --via symbol:src/counter.js:0:144 运行，由包含函数 makeCounter（symbol:src/counter.js:0:144）真实产生这个实例
```

### 2.2 `--via` 是唯一入口，而且必须是真正的包含函数

`RunSpec.via = {symbol, args, this_arg}`（HTTP 请求体同形）。硬约束：

- `via.symbol` 必须**逐字等于** `profile.enclosing_symbol`，否则在**启动任何进程之前**拒绝：`via_not_the_enclosing_symbol`。"某个大概会返回相似函数的符号"不是同一个作用域，这种错误会在运行时伪装成正确结果，所以在决定阶段就挡掉。
- `via.symbol == spec.symbol` 是非法 spec（`via_symbol_is_the_target`）。
- 包含函数自己也要能跑：它有自己的画像和决定（`via.profile` / `via.decision`）。它不行就整轮拒绝（`via_scope_refused`，detail 里带上它自己的拒绝码）。
- 只支持一层。包含函数自身也是嵌套的时静态拒绝 `closure_depth_not_supported`，并具名下一层（例如"包含函数 middle（symbol:…）自身也是嵌套的（它的包含函数是 outerFactory（symbol:…））"），而不是让运行死在命名空间查找上。

### 2.3 harness 的两个阶段，规则完全相同

一个 `via` 运行是两次调用，记录里按顺序有两条 `call` 事件（`stage: "enclosing"` 与 `stage: "target"`）：

1. **阶段 1**：按包含函数的钉住字节在模块命名空间里做**源码同一性**查找（`Function.toString()` 归一化后等于该符号的字节切片，唯一命中），用 `--via-args` / `--via-this` 调用它。
2. **阶段 2**：只调用阶段 1 返回值中与**目标符号**钉住字节源码一致的那个函数，用 `--args` / `--this`。

三种非成功路径都是**观测**，不是"失败的调用"：

| 情况 | record verdict | 记录里保留的东西 |
| --- | --- | --- |
| 命名空间里找不到包含函数 | `enclosing_not_exported`（多个同源命中则 `enclosing_ambiguous`） | 候选列表 |
| 包含函数返回的不是函数 | `closure_not_returned` | `via.stage_report.value` = 它真实返回的值 |
| 返回的是函数但源码不一致 | `closure_identity_mismatch` | `via.stage_report.closure.observed_source` = 观测到的源码 |

第三条是关键：`factory(true)` 返回 `alpha`、目标是 `beta`，两者形状相似、都是真实函数。按名字或位置接受就会静默执行错误的函数，所以只按源码同一性接受。

### 2.4 源码绑定是构造性的，不是声明性的

`via.source_binding` 与目标 `source_binding` 一样：从内容寻址 blob 读取、读取时重新哈希校验，记录 start/end/blob 与 `bytes_verified: true`。新增的 `exec::source_slice()` 被 `prepare()` 与 via 解析共用，避免两处各写一遍切片逻辑。

### 2.5 页面与宿主

- 2D 工作台：画像有 `enclosing_symbol` 时出现"经由包含函数取得闭包实例"勾选与包含函数实参输入；因为捕获导致直接调用不可能时默认勾选；按钮可用性跟随勾选而不是只跟随分类。运行结果分两段展示（阶段 1 返回值/匹配方式、阶段 2 闭包实例与源码同一性）。拒绝时把包含函数**自己的**决定也显示出来，避免读者把包含函数的拒绝归到目标头上。
- HTTP：`POST /api/exec` 接受 `via: {symbol, args}`，符号在服务端本分析内解析；`this_arg` 仍然**不在**页面的请求类型里（页面不能替别人声明输入）。
- 宿主客户端 `adapters/modus/atlas_host_client.mjs` 的 `exec({..., via})` 透传这段结构，宿主没有别的办法拿到闭包——它不能自己造一个函数传进来。

## 3. 真实验证

`python3 scripts/verify.py --label w08-closure-via --out evidence/development/2026-09-12-w08-closure-via --keep-going`

- **21/21 检查 exit 0**（rust-format、rust-clippy `-D warnings`、rust-tests、rust-build、worker-tests、integration、cancellation、jobs、incremental、semantic-contracts、execution、bridge、patch、host-adapter、relocate、calculator、web-syntax、city3d-syntax、web-behaviour、city3d-behaviour、whitespace）。
- **受控负对照** red：`ATLAS_FORCE_ENTRY_BACKFILL=1 scripts/test_semantic_contracts.py` → exit 1（V-09 frontier 断言必须变红）。
- **指纹配对一致**：`e072c3c3173fcad288284b032de58df0b4f52a7e1a674ef2ca5a4fa61c502168`，二进制与源码两侧相同。
- `sources_changed_during_run: 0`；`binary.sources_newer_than_binary: []`；`binary.sha256 = b4b252fff8d894e483b6e58575d47b8b76b45b5aa0c3712d22f0f5b270b5e44a`。

### 3.1 新增用例（全部真跑，不是模拟）

CLI（`scripts/test_execution.py`，47 → **50**，其中 6 个新用例针对 via）：

- `test_a_nested_closure_cannot_be_run_directly_and_says_how_it_can`：画像 `unsatisfiable_context=["captures"]`、`captures=["value"]`、`enclosing_symbol` 指向真实符号；直接执行被拒且 `isolation.started=false`，detail 同时点名绑定与 `--via` 符号。
- `test_a_closure_runs_through_the_function_that_encloses_it`：`makeCounter(100)` → `increment(5)` = **105**；`stage_report.closure.matched_by="source_identity"`；事件顺序 `["enclosing","target"]`；两阶段绑定各自 `bytes_verified`，且是同文件的不同字节区间。
- `test_a_via_symbol_that_is_not_the_enclosing_function_is_refused`：`via_not_the_enclosing_symbol`，不起进程。
- `test_an_enclosing_call_that_returns_a_different_function_is_not_a_target_call`：`factory(true)`→`alpha` 对目标 `beta` 报 `closure_identity_mismatch` 且 `value=null`，观测源码里是 `alpha`；同一路径 `factory(false)`→`beta` 正常返回 3。**证明拒绝是关于身份，而不是关于闭包跑不了。**
- `test_an_enclosing_call_that_returns_a_non_function_is_recorded_as_such`：`maybe(false)` 返回 `2` → `closure_not_returned`，`via.stage_report.value=2`，`isolation.started=true`（包含函数确实跑了）；`maybe(true)` → 14。
- `test_a_chain_deeper_than_one_level_is_refused_by_name`：`inner` via `middle` → `closure_depth_not_supported`（点名 `middle` 与 `outerFactory`）；`middle` via `outerFactory` 正常，返回值是 `{kind:"function", name:"inner"}`（一个被观测到的值，不是"我调用了它"）。
- `test_the_plan_for_a_via_run_names_both_stages`：`--plan` 同时给出两阶段决定，错误 via 在计划期就被拒。

HTTP（`HttpClosure`，3 个用例）：正常闭包运行、非法 via 拒绝、缺少 `unknown_calls` 承认 → `missing_requirements` 且不起进程。

宿主接缝（`scripts/test_host_adapter.py`，9 → **10**）：`client.exec({..., via:{symbol:'makeAdder', args:[100]}}) → 105`，`via.stage_report.closure.matched_by === 'source_identity'`。

Web 行为（`web/tests/app.behavior.test.mjs`，27 → **29**）：闭包只在勾选包含函数后运行、POST 体里 `via` 与目标实参分开、两阶段都在面板上；`closure_identity_mismatch` 明确显示"源码同一性 不匹配"与观测到的 `alpha` 源码。

Rust 单元测试新增 3 个：命名捕获与 enclosing 标注、非法 via 拒绝、`via_symbol_is_the_target` 校验。

## 4. 这一轮**没有**做的事（不得被读成已实现）

- **多级 via 组合**：`outerFactory → middle → inner` 目前是静态拒绝。要做需要逐级组合与逐级源码核对。
- **依赖切片**：每次运行仍然物化整个快照，不是只物化目标闭包。大树上是真实成本。
- **类方法/`this` 闭包**：`--via-this` 与 `--this` 的通道存在，但没有针对类实例的端到端用例；声明一个 JSON 对象当 `this` 不会真的成为一个类实例。
- **文档化之外**：`captures` 只列名字与来源计数，不建模捕获的值；闭包的"身份"由源码比对确定，不追 `Function` 对象的同一性。
- 浏览器端的按钮没有跑过真实浏览器（行为测试在 `node:vm` + 最小 DOM 里跑真实 `web/app.js`）；页面本身不启动进程，运行仍走 CLI/HTTP。

## 5. 复现

```bash
cargo build
python3 scripts/test_execution.py            # 50 tests
python3 scripts/test_host_adapter.py         # 10 tests
node web/tests/app.behavior.test.mjs         # 29 checks
python3 scripts/verify.py --label w08-closure-via \
  --out evidence/development/2026-09-12-w08-closure-via --keep-going
```

手工最小复现（任意含 `makeCounter`/`increment` 的模块）：

```bash
atlas --store S index PROJECT
A=$(atlas --store S index PROJECT | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
atlas --store S profile $A 'src/counter.js:increment'      # captures/enclosing_symbol
atlas --store S exec $A 'src/counter.js:increment' --args '[5]' \
      --via 'src/counter.js:makeCounter' --via-args '[100]' \
      --allow-effects unknown_calls                          # → returned 105
```
