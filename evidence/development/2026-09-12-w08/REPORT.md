# W08：执行画像与受控执行（首片）

窗口：2026-09-12/w08-execution。工作目录 `/Users/yinsijie/CodeRepo/Atlas`。

W08 从 `NOT_IMPLEMENTED` 推进到 `PARTIAL`：静态执行画像、RunSpec 固定、隔离副本、权限强制、源码同一性选目标、入口观测记录、scenario 断言、CLI/HTTP 边界与 Web 面板全部接通并纳入验证门。**仍缺**上下文合成、Effect journal、依赖切片、行级覆盖与运行期调用图。

本窗口还顺带在真实 `rxjs@7.8.1` 上找到并修复了两个 worker 缺陷（同一错误码 `flow_reference_unknown_binding` 的两个独立来源），见第五节。

## 一、交付

| 位置 | 内容 |
|---|---|
| `crates/atlas-engine/src/exec.rs`（新增） | 执行画像、Grants/RunSpec、隔离副本物化、harness、栈帧映射；8 个单测 |
| `crates/atlas-app/src/runner.rs`（新增） | 权限探针、进程组监督、观测记录装配、scenario 断言、符号解析 |
| `crates/atlas-app/src/main.rs` | `atlas profile`、`atlas exec`（`--plan` / `--scenario` / `--history` / `--allow-effects` / `--fixtures`） |
| `crates/atlas-app/src/server.rs` | `GET /api/profile`、`GET /api/exec-records`、`POST /api/exec` |
| `crates/atlas-engine/src/store.rs` | `exec_records` 表与不可变发布（身份 = 规范化答案摘要） |
| `scripts/test_execution.py`（新增） | 26 个用例，已加入 `verify.py` |
| `web/app.js` / `web/index.html` | 函数面板的执行画像与受控运行；7 项新增行为测试 |
| `workers/typescript/src/flow.mjs` | 两个真实缺陷修复 + 回归测试 |

## 二、执行画像是静态的，而且保守

分类顺序：`unsupported` → `needs_entry_driver` → `needs_context` → `pure_callable`。每条降级理由都带 `code` / `detail` / `evidence`，`evidence` 指回它读的那个已发布字段，消费者可以自己核对而不是相信标签。

关键保守点：**`status != complete_within_profile` 一律降级**。partial 分析的 frontier 恰恰是事实缺失的块，所以「没有未知副作用」没有被证明。`Capture` / `External` / `This` / 堆读写 / 全局读 / `unknown_call` / `registers_callback` / `escaped_local_value` / 调用点目标不完整，任何一条成立都降级。参数按绑定声明的字节偏移排序；排不出顺序时 `arity = null`，让调用者自己看，而不是猜。

在计算器样本上的真实输出：

```
add            pure_callable
divide         needs_entry_driver  [unknown_region, unknown_call, reads_global]
calculate      needs_entry_driver  [unknown_region, unknown_call, registers_callback, reads_global, callsite_incomplete]
```

这不是"分类器太松"：`divide` 里 `throw new Error(...)` 确实构造了一个 Atlas 不建模的全局对象并调用它。宁可把 `divide` 降级，也不把「未建模」说成「无副作用」。

## 三、受控运行的强制边界

执行只在一个条件下发生：静态画像允许，且 spec 显式授予所需项。路径：

1. **隔离副本**：从不可变快照的每个内容寻址 blob 读入并**重新哈希校验**后写入一个 `0700` 临时目录。临时根先 `canonicalize`——否则 Node 的模块 loader 会在 `/var → /private/var` 上做一次未被授权的 `realpathSync` 而死在 loader 里，而不是死在被测代码里（这是实测踩到的，不是推测）。
2. **按源码同一性选目标**：模块命名空间里每个函数的 `toString()` 归一化后必须等于快照中该符号的字节切片，唯一命中才调用。因此改名、遮蔽导出、同名不同函数都不会被静默执行；命中不了就是 `target_not_exported`，不猜。已测试：未导出的 `hidden` 不会被调用。
3. **权限强制**：用调用者指定的**目标 Node** 以 `--permission` 启动，只授予副本只读。权限模型不是"接受了 flag"就算数：每个进程首次运行前先跑一个能力探针，**要求一次真实写入被 `ERR_ACCESS_DENIED` 拒绝**，否则 Atlas 拒绝执行用户代码。
4. **生命周期**：子进程自成进程组，超时/取消按组 `SIGKILL` 并回收；stdin/stdout/stderr 都有预算；harness 报告带每轮唯一标记、最后写入并显式退出，所以目标自己写到 stdout 的内容不会被误当作报告。

隔离副本保证的是**源码漂移不可能发生**，而不是"被检测到"：跑的就是快照里的字节。测试 `test_execution_uses_the_pinned_bytes_after_the_project_changes` 改了检出目录里的源文件之后，运行结果仍然是旧快照的答案，记录 id 不变。

## 四、观测边界写在记录里

```
trace.kind   = observed-entry-call
trace.coverage = not_sampled
trace.unknown_paths = not_observed
```

只有入口调用的返回/抛出、运行时报告的源码位置、进程输出与退出状态被观测。抛出时把 V8 栈帧映射回快照的**相对路径 + 行 + 列 + 字节偏移 + 行文本**：

```
src/basic.js:6  byte_offset 159  "  if (b === 0) { throw new Error('Division by zero'); }"
```

**没有行级覆盖采样，没有运行期调用图，静态 BFS 不作为执行顺序。** 记录身份 = `digest(固定问题 + 观测答案)`，刻意排除耗时与绝对临时路径：同一问题得到同一答案就是同一行（可重复、可幂等查询），答案不同会产生第二条记录，而不是静默覆盖。

`--fixtures` 的运行必须在记录里标 `isolation.mocks = true`，前端明确提示 `不得当作真实环境观测`；默认（无该标志）不得声称用了 mock。scenario 里 `refused` 与断言 `failed` 分开计数——把「静态画像拒绝执行」算成「断言失败」会把一次从未发生的执行说成一次失败。

## 五、真实项目基准暴露的两个缺陷（GE-2 的直接产出）

第一次用真实 `rxjs@7.8.1`（1004 个 JS/TS 源文件）跑全量索引时，索引直接失败：

```
Error: Invalid("flow_reference_unknown_binding")   exit 1
```

最小化到 `src/internal/Observable.ts`（一个 Promise executor 箭头里的 `let value`），随后在全树上扫描，发现 **105 处**悬空绑定引用。两个独立来源：

| # | 位置 | 原因 | 修复 |
|---|---|---|---|
| 1 | `flow.mjs` `collectDeclarations()` | 收集声明时下降进嵌套函数体，于是外层方法把内层箭头的 `let value` 认领成自己的绑定；内层箭头自己的声明反而引用了一个它没有声明的绑定 | 在 function-like 节点处停止下降（只登记提升的函数声明），class body 同理 |
| 2 | `flow.mjs` `walkModule()` | pass 0 只在函数/类**声明**处停止，于是下降进了函数表达式与箭头 IIFE。rxjs 的 `dist/bundles/rxjs.umd.js` 是 IIFE，工厂函数表达式的全部局部名（`extendStatics`、`__assign`、`EMPTY_SUBSCRIPTION` …）被当成模块名，每个函数都去登记，第一个登记的认领了它们，真正声明它们的 IIFE 悬空 | 在所有 function-like 节点与 class 表达式处停止下降 |

修复后把完整 rxjs 树重新喂给 worker：**6573 个 flow 函数，0 处悬空引用**；单独索引 UMD bundle：1056 个函数，全部 `complete_within_profile`。

这两个缺陷都**不是合成样本能发现的**：第一个需要"嵌套函数里声明、外层同时有方法"的形状，第二个需要一个 UMD/IIFE 打包产物。它们也解释了为什么之前的合成样本一直绿。

回归测试：`workers/typescript/tests/flow.test.mjs` 新增 "a nested function keeps its own declarations out of the enclosing function (GE-2 regression)"，对**每一个**发出的函数断言"每个绑定引用都能被该函数声明或捕获"。

## 六、资格边界（本窗口未证明的）

- `needs_context` **不可运行**：本切片不合成上下文（captures / this / 模块态）。因此真实项目里大量函数只能停在画像阶段。
- profile 的 external/global 判定偏保守：rxjs 上除 `add` 一类纯算术函数外基本落入 `needs_entry_driver`。精度未评估，也没有"误判为 pure 的"系统性检查（现有测试只覆盖单个反例方向）。
- 没有 **Effect journal**：fs/net/env/子进程的实际行为由 Node 权限模型在运行时强制，Atlas 不记录执行期效果清单。
- **fixtures 只是声明标签**：不注入 mock、不做依赖切片、不校验 mock 与真实依赖的差别，只保证结果不会被读作真实环境观测。
- 没有行级覆盖、运行期调用图、事件因果链；未观测路径保持未知。
- 副本物化的是**整个快照**而不是目标的依赖闭包：大项目上这是纯粹的浪费（也是 blocker）。
- 进程组 `SIGKILL` 依赖 POSIX 进程组；Windows 未资格。
- Node 权限模型仍是实验特性（`--allow-net` 会打印 ExperimentalWarning）。Atlas 用能力探针而不是版本号判断可用性，但跨版本行为未资格。
- 仍未实现：AI 代码写入、正式工具注册/MCP、双向 Agent 会话。

## 七、验证

```
python3 scripts/verify.py --label w08-execution \
  --out evidence/development/2026-09-12-w08 --keep-going    退出码 0
  17/17 检查退出码 0（新增 execution）
  negative-control 受控失败 ✓   fingerprint pairing: binary == source ✓
  status PASS · document_errors [] · sources_changed 0 · binary_stale false
```

各入口的独立退出码：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `cargo fmt --all --check` | 0 | — |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | 0 | — |
| `cargo test --workspace --locked` | 0 | 77 → 93 |
| `npm test --prefix workers/typescript` | 0 | 24 → 25 |
| `python3 scripts/test_execution.py` | 0 | 26 → 27 |
| `python3 scripts/test_integration.py` | 0 | 新增 HTTP 执行边界用例 |
| `node web/tests/app.behavior.test.mjs` | 0 | 8 → 15 |
| `python3 scripts/bench_real_project.py`（manual，见 GE-2 报告） | 0 | 真实 rxjs 全链 |

资格范围：只覆盖上列检查，不构成完整 AL/ET/GE/MT/HI/DV 或成熟 Atlas 验收。

---

## 八、补片（同日）：上下文模型 —— 可声明的输入 vs 必须承认的未知

W08 首片把一切"参数之外的东西"都塞进 `needs_context` 并判定不可运行，这既太粗也太悲观：读一个全局和执行一段未建模的代码不是同一类问题。
本补片把它拆成两类，并让拒绝变得可行动。

| 类别 | 例子 | 调用者要做什么 |
|---|---|---|
| **可声明的输入** | 函数读取 `this`；读取有名字的外部名（`External(name)`） | 用 `--this '<json>'` / `--global NAME=<json>` 给出值；记录里写明声明了什么 |
| **必须承认的未知** | 未建模构造、未完成的 frontier、堆近似、未知调用、无名的外部读 | `--allow-effects unknown_calls` 明确承认"这次运行超出了被证明的范围" |
| **不需要声明** | 顶层函数读取模块级状态（`Capture`，模块整体被复制） | 只需承认未知即可运行 |
| **不可运行** | 嵌套函数引用外层函数的绑定（闭包实例） | 本切片不接受用数据声明一个实例 |

三点理由，每一点都对应一个被修掉的错误行为：

1. **`globals` 不再是权限。** 它曾经是 `--allow-effects` 里的一个授权名，但授予一个权限并不能提供那个值——读到 `undefined` 或 `ReferenceError` 与"被允许读"是两件事。旧的 `globals` 授权名现在会**报错**（`unknown_effect_grant`），而不是被忽略，否则调用者会以为自己提供了什么。
2. **具名才算要求。** 要求从 `External(name)` 来源提取，拒绝里写 `global:CONFIG` 这样的具体名字。没有名字可指的全局读取不会被要求"声明某个值"——那不可行动；它落在承认项里，而运行会给出真实答案（实测是 `ReferenceError`，这本身是有用的观测）。
3. **模块状态在副本里。** 顶层函数读取模块级 `const` 时，worker 把它记为 `Capture`。把 Capture 一律当作不可满足是错的：模块整体被复制，导入时那份状态就存在。现在按"函数是否顶层"区分：顶层 → 只要求承认未知；嵌套 → 不可运行。

拒绝也改成一次列全：`refusal` 同时带 `missing_grants` 与 `missing_context`，不让人改一个再试一次。

**实测（真实 CLI 输出）**：

```
add             pure_callable      runnable  grants=[]                ctx=[]
self            needs_context      runnable  grants=[]                ctx=['this_arg']
writeField      needs_context      runnable  grants=['unknown_calls'] ctx=[]
useModuleConst  needs_context      runnable  grants=['unknown_calls'] ctx=[]
readConfig      needs_entry_driver runnable  grants=['unknown_calls'] ctx=[]  globals=[]
divide          needs_entry_driver runnable  grants=['unknown_calls'] ctx=[]
```

**仍未解决**：worker 仍把 ES `import` 绑定当作 `External` 名称——已发布事实里"导入绑定"与"真正的全局"无法区分，所以读取导入模块的函数会被要求承认未知。保守，但不够精确；要修正得让 worker 把 import 绑定登记为模块绑定并区分二者。

---

## 九、补片（同日）：Effect journal —— 只能记录"被挡住"的那一半

执行画像有静态 effects 标签，但"这次运行到底碰了什么"没有记录。补上后，界限必须说清楚：

- Node 的权限模型把 `permission` 与 `resource` 附在它抛出的 `ERR_ACCESS_DENIED` 上。这是**唯一**可得的逐操作证据，所以 journal 只记录被拒绝的尝试，原样带出：

```
被拒绝的尝试 · FileSystemWrite → /tmp/atlas-exec-escape.txt
被拒绝的尝试 · FileSystemRead  → /etc/hosts
被拒绝的尝试 · ChildProcess    → /bin/sh
```

- **被允许的操作没有逐条日志。** Node 不提供系统调用级审计，所以 journal 同时记录授予集合，并写明"被允许的操作没有逐条日志，因此这里不声称'没有效果'；授予集合就是这次运行的边界"。空 journal 是"没有拒绝被报告"，不是"没有副作用"——这两种读法在 UI 上也分开呈现（`没有运行时报告的拒绝尝试。这不等于没有副作用…`）。

实测（真实 CLI 输出）：

```
writeOutside  denial: FileSystemWrite /tmp/atlas-exec-escape.txt
spawnEcho     denial: ChildProcess /bin/sh
readOutside   denial: FileSystemRead /etc/hosts
add           denied_count 0 · granted {fs_write:false, child_process:false, network:false}
```

**仍未解决**：journal 回答不了"这次运行真的写了哪些文件"。那需要系统调用级审计（或每类能力的包装层），本切片没有做。

---

## 十、补片（同日）：取消是取消，超时是超时

W08 验收把"循环/取消"和"超时"并列，但它们是两种事实：超时是 Atlas 选的界限，取消是操作者做的决定。
之前只有超时被测试，取消只是代码里存在。

- `SIGINT` 取消一次受控运行：按进程组 `SIGKILL` 回收子进程，**发布** `verdict=cancelled` 的记录（取消的运行同样是事实，不丢弃），CLI 退出码 0。
- 记录里 `timeout` 与 `cancelled` 是不同 verdict，`trace.events` 最后一条分别是 `timeout` / `cancelled`。
- **scenario 收到取消即停止**：之前会继续把剩余用例一个个跑成"已取消"，看起来像每个用例都被尝试过。
  现在 `stopped: "cancelled"`，并且 `declared_cases` 与 `attempted_cases` 分开报告，测试断言后者严格小于前者。

实测（真实 SIGINT）：

```
atlas exec <id> spin --args [1] --timeout-ms 60000   → SIGINT 1.5s 后
  verdict=cancelled · 事件 timeout? 否 / cancelled 是 · CLI 退出码 0
  spin 的记录可通过 atlas exec <id> spin --history 取回
scenario（3 个用例，第 1 个挂住）→ SIGINT
  declared_cases=3 · attempted_cases=1 · stopped=cancelled · cases=["hangs"]
```

---

## 十一、补片（同日）：场景结果是证据，会被发布

之前 `atlas exec --scenario` 的结果只打印到 stdout：消费者想问"上次这个场景做了什么"必须去捕获输出流。
现在它是不可变记录：

- 表 `scenario_results`（id = 结果摘要，analysis/symbol/name + passed/failed/refused + body）；
- `atlas exec <analysis> <symbol> --scenario-history` 与 `GET /api/scenarios`、`GET /api/scenario?id=`；
- 同一场景在同一固定分析上重复运行是**同一条记录**（id 是结果摘要），不会每次生成新行；
- 结果里保留 `declared_cases` / `attempted_cases` / `stopped`，所以"被取消后剩余用例未尝试"这件事在记录里也能读到。

跨分析读取被拒绝（`scenario_belongs_to_another_analysis`），与提案、执行记录同一纪律。
