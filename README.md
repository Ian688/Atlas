# Atlas

独立的本地代码分析服务与可视化工作台。Modus 是未来的一个宿主，Atlas 的解析引擎、事实、查询和工作台不依赖 Modus、Python 服务或 LLM。

这是 **Foundation 0.2：一条真实可运行的架构切片**，不是成熟 Atlas 的能力验收。已打通文件清点 → 内容快照 → JavaScript/TypeScript 语言材料 → Rust 关系图 → **版本化 Flow IR → CFG → 局部抽象解释（def-use、值来源、常量折叠、循环不动点）** → 跨过程摘要 → 查询 → 持久作业与增量失效 → 2D/3D 工作台 → **执行画像与隔离受控运行** → 固定选区上下文。完整目标仍包含上下文合成、正式 Source/Scenario Trace、Agent 操作与 AI Coding。

## 启动

语言 worker 的堆上限是可配置的（`--worker-heap-mb`，默认 1024，范围 128–8192）：worker 持有整个程序与全部函数的 Flow IR，footprint 随项目规模增长，固定上限曾把大项目变成一句无法解释的失败。撞到上限时报 `worker_heap_exhausted:limit_mb=…` 并给出要改的参数。

需要 Rust/Cargo、Node.js 和 npm。TypeScript 编译器依赖固定为 5.9.3；Rust 依赖由 Cargo.lock 固定。Node 24+ 为当前声明的开发范围，具体被验证版本查看 [验证记录](evidence/foundation/verification.json)，不能把范围当作各版本均已验收。

在本仓库根目录执行：

```sh
npm ci --prefix workers/typescript --ignore-scripts --no-audit --no-fund
cargo build --workspace --locked
python3 scripts/demo.py --open
```

Python 只用于便利脚本和集成验证；Atlas 产品运行时不依赖 Python。直接使用二进制亦可：

```sh
target/debug/atlas --store local-state index examples/calculator
target/debug/atlas --store local-state serve <上一步返回的id>
```

服务只监听 `127.0.0.1`。启动输出包含 URL 和权限为 `0600` 的本地会话文件路径，不打印令牌。打开 URL，将会话文件中的 `token` 填入页面即可。`demo.py --open` 会在本机浏览器通过 URL fragment 传入令牌，页面随即移除 fragment；令牌不进入服务访问 URL。关闭服务用 Ctrl-C。

二进制从其他目录运行时，`index` 需显式指定 `--worker /absolute/path/to/workers/typescript/worker.mjs`。当前没有独立安装包、自动升级器或 worker 资源定位安装协议。

## 现在可以做什么

- 清点目录、文件、忽略边界、链接、过大/不稳定文件；保留未解析项与实际分母。扫描不会执行被分析项目。
- 保存不可变内容快照。项目文件修改以后，旧分析和旧选区依然读取旧字节。
- 提取 JS/TS 函数、嵌套层级、导入与调用点；通过编译器绑定取得有限的词法调用候选。重绑定、歧义、动态调用等保留未知。
- 在声明 profile（`js-structured-control.v1`）内把函数体降级为带锚点的 Flow IR，并在 Rust 构建基本块 CFG（含 finally 的 completion 语义、短路/条件分支、循环回边、switch 链），再做有界局部抽象解释：def-use、值来源（`Parameter(i)`、`CallResult`、`Allocation`、`Capture` 等）、有限常量折叠与显式 unknown/预算报告。跨过程符号摘要（参数来源按调用点代回、SCC 固定点、递归有限轮）及有界标量参数上下文已接通：每个 callee 最多保留 8 个调用点上下文，其余回退到符号摘要。未知 callee、跨函数堆分配与捕获 origin 等边界保留显式 unknown。
- 索引支持 SIGINT/SIGTERM 协作取消；扫描、worker、Rust 求解及发布锁等待共用控制，提交前接受取消会阻止新分析发布。计算预算耗尽可发布带 unknown、frontier 与实际预算计数的部分事实，deadline 耗尽则拒绝发布。持久作业队列与恢复租约仍待实现。
- 用 Rust 构建包含关系、调用候选图、递归分量；按版本分页、多跳遍历、读取 UTF-8 源码窗口。
- 在真实 2D 页面中浏览文件与函数，选中对象高亮相关候选，其他对象变淡，导出带分析版本的本地 JSON 上下文。函数详情面板显示所选函数的块级控制流与绑定值来源摘要（`atlas-local-absint`，仅声明 profile 内）。
- 函数详情面板里的**绑定状态矩阵**把每个基本块×绑定的状态投影成表。三个视觉通道互相独立，所以没有事实会被另一个掩盖：填充表示值的种类，角标表示该值仍含未知分量，描边表示读取时可能未初始化；「该块无绑定记录」与「值为未知」是两个不同的标记。
- **3D 代码城市**（`/city3d`）是同一份分析的第二种投影：目录为地块、文件为柱、函数为层、调用候选为地面管道。高度取自引擎声明的函数数量，未解析调用按事实画成琥珀矮桩而不丢弃，未分析的文件单独标识，覆盖与截断始终显示。渲染器是手写 WebGL2，无第三方依赖。
- **正式层级与 LOD**：城市背后是一个不可裁剪的形式层级 `项目 → 目录 → 文件`，同一份事实在里面只被计数一次（目录与项目是子节点的和）。切换层级只改变画什么：项目层级一根聚合柱体、目录层级每目录一根、文件层级是原来的样子。工作单的「LOD 不改变事实数量」是可检查的：页面上一行 `层级聚合守恒 ✓`（不守恒就列出字段），并且**层级省略与预算截断分开说**——"这一层不画函数层"是层级定义，"按预算截断"是渲染预算。聚合柱体不会被当成文件：它没有单一源码可读，共享选区落到粗层级时会指名真实文件并明确说这是聚合。
- **观测层与静态层分开**：已运行过的入口用**另一种描边色**标出，并在覆盖栏单独一行给出结论分布（returned/threw/…）。这只是**读**静态布局：观测不会加文件、不会改高度、不会把未解析调用变成已解析。落不进当前布局的运行记录会被报出数量而不是丢掉；查询失败时显示"观测层不可用"，而不是显示成"什么都没运行过"。
- 索引可以作为**持久作业**提交：身份由 (owner, project, request_key) 三元组定义，同一请求幂等——已完成的请求重放原分析而不重跑，失败的可以重试并计入下一次 attempt。作业持有带心跳的租约；租约停止续期就是进程死亡的证据，`job reap` 收割它并判失败，`job work` 则换个人接着跑——崩溃不该让队列停摆，重跑在这里是安全的（发布幂等且不可变）。陈旧持有者无法伪造终态。
- 作业可以**排队**而不是只能即刻执行：`job enqueue` 只登记请求（runner 参数随行存储，所以排队请求描述自己怎么跑），工人按优先级降序、同级最旧优先认领。排队中的作业可以取消；运行中的不行——它属于租约持有者。
- **作业队列按种类分派**：`patch verify --enqueue --owner X` 把验证排成 `patch_verify` 作业，`job work` 认领后用**同一段代码**执行（不是另一条路径），终态 artifact 是补丁树派生的新 analysis。作业身份、租约、心跳、崩溃收割与 index 作业完全一致——队列不是 index 专用的。
- `index --incremental` 在字节与版本都没变时直接返回已发布的分析，并报告一次局部改动会失效什么：每个文件按自身内容与依赖闭包（在导入图 SCC 凝聚上折叠）得到一个键，因此失效**不需要**额外的一遍扫描，且改叶子不会反向失效共享模块。`withdrawn` 列出上次分析过、这次已不存在的文件。**承重断言**：增量与全量必须发布同一个 analysis id，冷/热/编辑/删除四条路径都有测试。已知边界：局部改动仍需重新派生全部函数（Rust 侧是全程序 SCC 不动点）。
- **HTTP 上的身份是会话，不是声明**：`/api/*` 的 owner 与 proposal/annotation 的作者都由服务端按**唯一能验证的身份**（持有会话令牌）写入。页面即使发送 `owner`/`proposed_by` 也不会被采信——让一个页面用别人的名义写行，会让 owner 这一列失去意义。CLI 保留 `--owner`/`--proposed-by`，那是本机操作者声明自己是谁，与远程认证是两件事。
- **跨版本选区重定位**（`atlas relocate` / `GET /api/relocate?entity=&from=`）：选区固定在某个分析版本上，拿到另一个版本打开时只有两个诚实结果——**有依据的重定位**，或**拒绝**。依据只有三条，且都公开：`path_and_name`（同路径同名，字节可能已变，变化会写明）、`identical_bytes`（同名字节完全相同，看起来是移动/重命名）、`name_only`（仅同名、路径不同，证据弱）。改名到无法识别、目标有多个同名、或文件已被撤回，都**拒绝**并给出上下文，绝不把旧名字指到"现在恰好在那个位置"的对象上。重定位只给建议与一个钉在新版本上的选区，不修改任何已存记录。
- **并发是等待，不是报错**：SQLite 写者仍然串行，但等待由 Atlas 的可取消轮询完成（默认 180 秒，`ATLAS_STORE_BUSY_TIMEOUT_MS` 可调），预算耗尽时给的是具名拒绝 `store_writer_timeout:budget_ms=…:waited_ms=…` 而不是把 `database is locked` 原样抛出；schema 创建是一个事务，两个进程同时首开空 store 也不会看到"一半的表"；已初始化的 store 只读打开，读取不会再排在发布者后面。真实证据：rxjs@7.8.1 上 3 个并发 index 全部 exit 0 且发布同一个 analysis id（`evidence/development/2026-09-12-real-project/rxjs/concurrency.json`）。
- **一个选区，两种投影**：选区 = 实体 + 它被选中时的分析版本，随 URL fragment 传递（fragment 不进入 HTTP 请求）。2D 与 `/city3d` 共享同一个选区；投影若在服务另一个版本，会**拒绝**这个选区并说明原因，而不是把它悄悄改指到当前版本的某个对象上。语义 DOM（`data-selection-entity` / `data-analysis-id`）与 `globalThis.atlasBridge` 是给外部 Agent 用的接口，不依赖向任何私有聊天窗口注入。
- **Intent 与提案**：`atlas annotate` / `/api/annotation` 把约束、场景、补丁登记为注解，`exists:false`、带 `proposed_by`。注解是声明，不是事实，也不是已存在的代码；补丁提案只登记为占位对象（`applied:false`），本切片没有应用/重解析/测试/撤销的代码路径。
- **AI Coding 第一条完整链**（`atlas patch …`）：提案是统一 diff，先对**固定快照字节**在内存里应用，位置不符就带着不一致的那一行拒绝（不做模糊匹配——那会把改动挪到另一个长得像的地方）。验证在**隔离副本**里重新索引：派生出新的 analysis，产出**图差异**（节点按 path+name 重新配对，因为 id 绑定字节区间，按 id 比较会把编辑读成删除+新增），并可在副本里跑一条**声明的 argv 测试命令**（不是 shell 字符串）。apply 会先校验目标当前字节仍等于提案所依据的固定快照，否则拒绝——覆盖审查之后发生的改动是损失而不是合并；revert 同样校验 apply 之后的字节。Intent（diff）、Static（重新派生的分析与图差异）、Observed（测试退出码）三类证据分开存放，没跑测试就写「没有跑任何测试，这不是通过」。
- **提案审阅面**（`/api/patches`、`/api/patch`、`POST /api/patch/propose` + 函数面板的补丁提案面板）：页面可以**登记**一份统一 diff（那是 Intent，什么都不改）并读到验证结果——校验是否通过、图差异计数、测试命令的真实退出码；**验证与应用仍只在本机 CLI**（`atlas patch verify/apply/revert`），因为页面无法让你看见将要写入哪个目录。没验证过的提案会明说「还没有验证」，没跑测试会明说「没有跑任何测试，这不是通过」。
- **有界 Agent Bridge**：`atlas agent request/work/claim/complete/reap` 与 `/api/agent/*`。请求身份 = (owner, request_key)，幂等；认领即 ACK 并带租约，过期租约被收割回队列；只有当前租约持有者能写终态。动作集合是**封闭**的（`inspect` / `annotate` / `propose_patch`），请求其它动作在入队时就被持久地拒绝并记录原因。页面不能自己指定 Node 二进制、环境或分析版本。
- **什么算"外部"分三类**：函数自己的 **import** 是模块状态（模块整体在副本里，不需要声明）；**运行时内建/宿主全局**（`Error`、`Math`、`JSON`、`console`、`process`…）由运行时提供，Atlas **不要求**调用者声明——`--global Error=null` 不是"提供"一个 Error 构造器，而是**拿掉**一个，会让运行因为与被测函数无关的原因失败；只有**真正的自由标识符**（如 `CONFIG`）才会被要求声明，并且在拒绝里**具名**（`global:CONFIG`）。worker 与 engine 通过单一常量 `WORKER_PRODUCER` 对齐：表达不了当前语义的 worker 版本被**具名拒绝**，而不是被错误解释。
- **执行画像**（`atlas profile` / `/api/profile`）把每个函数按已发布事实分成 `pure_callable` / `needs_context` / `needs_entry_driver` / `unsupported`，每条降级理由都指回它读的那个字段。partial 分析一律降级：frontier 就是事实缺失的块，「没有副作用」没有被证明。画像区分两类要求：**可以声明的输入**（`this`、具名全局，用 `--this` / `--global NAME=<json>` 给出，记录里写明声明了什么）与**必须承认的未知**（未建模构造、未完成事实、堆近似、未知调用，用 `--allow-effects unknown_calls` 明确承认）。读取模块级状态不需要声明——模块整体都在副本里。嵌套闭包捕获的外层绑定**不是可以声明的值**：它只在包含它的函数运行期间存在。因此 Atlas 不构造作用域、也不接受任何函数值输入，而是只提供一条入口 `--via <enclosing-symbol>`：先调用**恰好等于**目标包含符号的那个函数（给别的符号直接拒绝 `via_not_the_enclosing_symbol`），再只调用它返回的、源码与目标钉住字节**同一**的那个函数实例。嵌得更深时用 `--via-chain` 给出**它之上**的祖先（由外到内）：**每一环**都按同样的源码同一性核对，任何一环返回别的函数就报 `closure_identity_mismatch` 并指出 `failed_stage`；链必须真的是包含路径（`via_chain_not_connected`）且最外层是顶层（`via_chain_not_rooted`），深度上限 8。页面会用分析自身的 `enclosing_symbol` 逐级向上查出祖先并预填这条链。返回的不是函数是 `closure_not_returned`，返回的是别的函数是 `closure_identity_mismatch`（两者都保留观测到的返回值/源码，都算观测而不是失败的调用）；只支持一层，更深的链静态拒绝 `closure_depth_not_supported`。拒绝会一次性列出缺什么。
- **副本范围是一个被记录的选择**：`atlas exec --materialise snapshot|dependencies`。默认仍是整个快照；`dependencies` 只物化目标文件的**静态 import 闭包**加上所有 `package.json`（Node 靠它决定模块类型），是一个**更紧的读边界**——目标运行时按相对路径读取、但从未 import 的文件会以 `ENOENT` 失败，记录里 `known_risk` 事先列出这类情形、`fallback` 说明用 `--materialise snapshot` 复核，未解析的相对 import 逐个具名，遍历触顶则报 `bounded`。真实项目实测（rxjs@7.8.1，`dist/cjs/internal/util/isFunction.js:isFunction`，两种模式都真的运行了该模块）：快照 2277 文件 / 4,501,327 字节，切片 7 文件 / 9,514 字节。
- **受控运行**（`atlas exec` / `/api/exec`）只对通过画像的函数生效：它把快照字节物化成隔离副本，用调用者指定的**目标 Node** 在 `--permission` 下启动，只授予副本只读与显式声明的项。权限是强制的而不是声明式的——每个进程首次运行前先跑一次能力探针，要求一次真实写入被 `ERR_ACCESS_DENIED` 拒绝，否则拒绝执行。目标函数按**源码同一性**选定（命名空间里某个值的 `toString()` 必须等于快照中该符号的字节），因此同名的另一个函数不会被静默执行，导不出的函数直接报 `target_not_exported`。`--via` 运行时命名空间查找针对包含函数（找不到就是 `enclosing_not_exported`），闭包本身从不按名字查找；两阶段的绑定（目标与包含函数）各自都有 `source_binding`，都从内容寻址 blob 读取并重新哈希校验。超时/取消按进程组 `SIGKILL` 回收。
- **Effect journal**：记录运行时明确报告的**被拒绝尝试**（权限种类 + 目标，例如 `FileSystemWrite → /tmp/x`）。Node 只为拒绝附上这些字段，所以 journal 不声称列出被允许的操作——授予集合就是边界，记录里写明这一点。空 journal 等于"没有拒绝被报告"，不等于"没有副作用"。
- **取消与超时是两种事实**：`SIGINT` 取消一次受控运行会按进程组 `SIGKILL` 并发布 `verdict=cancelled` 的记录（取消的运行也是事实，不会被丢掉）；scenario 被取消时**停止**而不是把剩余用例跑成一行"已取消"，结果里 `attempted_cases < declared_cases`。
- **场景结果是证据，会被发布**：`atlas exec --scenario` 的结果（逐用例结局、计数、是否被取消）作为不可变记录落库（`--scenario-history` / `GET /api/scenarios`），不再只存在于 stdout——消费者不该为了问"上次这个场景做了什么"而去捕获输出流。同一场景在同一固定分析上重复运行是同一条记录。
- **观测边界写在记录里**：`coverage=not_sampled`、`unknown_paths=not_observed`。只观测入口调用的返回/抛出、运行时报告的源码位置、进程输出与退出码；没有行级覆盖，没有运行期调用图，静态 BFS 不作为执行顺序。`--scenario` 可对一组用例断言返回/抛出/被拒绝，`refused` 与「断言失败」是两种结果。声明 `--fixtures` 的运行会在记录里标为 mock，结果不得读作真实环境观测。

**当前连线是静态候选，不是数据流执行顺序或运行血流。** 计算器同时出现加、减、除候选，不能据此声称一次加法执行过所有分支。Flow 事实是声明 profile 内的静态推导：未知构造、外部调用效果与跨过程值流都保留为显式 unknown。`examples/flow-lab` 是局部语义事实的集成测试样例（finally、短路、循环、分支候选、显式 unknown）。

受控运行**不是**在项目目录里执行用户代码：它跑的是从不可变快照物化出来的副本，被测项目的文件不会被写；页面按钮只能选择符号与字面量实参，不能自己放宽沙箱。已经实现：`this`/全局声明、Effect journal、嵌套闭包经包含函数取实例（`--via`）、AI Coding 链（提案→隔离验证→应用/撤销）。仍未实现：依赖切片（每次运行仍物化整个快照）、多于一层的 `--via` 组合、行级覆盖与运行期调用图、堆/别名精度。

## 工程入口

| 入口 | 用途 |
|---|---|
| [架构与算法](docs/ARCHITECTURE.md) | 当前实现、关键不变量、算法边界、完整演进方向 |
| [下一 Agent 任务书](docs/HANDOFF.md) | 可执行接力顺序、验收、缺口与禁止虚报的边界 |
| [宿主接缝](docs/HOST_API.md) | 宿主如何只通过接口工作、必须原样呈现什么、迁移与回退边界 |
| [独立工程决策](docs/adr-0001-independent-foundation.md) | 为什么新建同级仓库，如何逐步替换旧集成 |
| [完整规格快照](docs/specs/README.md) | 原有六份完整设计与适用范围 |
| [验证记录](evidence/foundation/verification.json) | 命令、退出码、版本、源码指纹与资格限制 |

目录：`crates/atlas-contract` 为跨进程数据合同；`crates/atlas-engine` 为本地事实引擎；`crates/atlas-app` 为独立 CLI、worker 进程管理与 HTTP；`workers/typescript` 为隔离语言提取器；`web` 为实际查询消费者；`examples/calculator` 为真实样本。

## 复验

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build --workspace --locked
npm test --prefix workers/typescript
python3 scripts/test_integration.py
python3 scripts/test_cancellation.py
python3 scripts/test_jobs.py
python3 scripts/test_incremental.py
python3 scripts/test_semantic_contracts.py
python3 scripts/test_execution.py
python3 scripts/test_bridge.py
python3 scripts/test_patch.py
python3 scripts/test_host_adapter.py
node examples/calculator/demo.mjs
node web/tests/app.behavior.test.mjs
node web/tests/city3d.behavior.test.mjs
```

自动化分别覆盖存储/遍历/边界、真实编译器材料、完整 CLI/HTTP 链路和独立计算器断言。`web/tests/app.behavior.test.mjs` 在 `node:vm` 的 DOM 里真正驱动 `web/app.js`（会话保持、失败路径清空、事实与选中的 symbol 一致性），因此工作台的行为不再只靠 `node --check` 的语法检查。

自动化分别覆盖存储/遍历/边界、真实编译器材料、完整 CLI/HTTP 链路、独立计算器断言、持久作业与队列、增量等价性、CLI/HTTP 受控执行、选区跨版本拒绝与有界 Agent Bridge、AI Coding 补丁链的全部拒绝路径，以及网页行为。120 文件、1,200 函数是合成分页与预算样本；10,000 节点 SCC 是图算法样本；两者均不构成大型真实项目资格。真实第三方项目的成本记录见 [GE-2/GE-3 证据](evidence/development/2026-09-12-real-project/REPORT.md)，它证明的是单机单项目成本，不是大仓库或多语言资格。
