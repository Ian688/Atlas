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
