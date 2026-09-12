# 下一 Coding Agent：从真实基础继续建造完整 Atlas

版本：Foundation 0.1，2026-09-08。工作目录为独立 `/Users/yinsijie/CodeRepo/Atlas`，不是 Modus 内 `code-atlas`。先读 `../README.md` 与 `ARCHITECTURE.md`，然后根据任务读取 `specs/` 对应完整合同。不要重建另一份相同基础，不把“此切片通过”写为 Atlas 整体完成。

2026-09-09 执行补充：用户采用外部 Coding Agent 持续开发、阶段成果交回独立复审的工作方式。执行从 [持续开发任务书](DAILY_DEVELOPMENT_WORK_ORDER.md)、[可直接转交的提示词](START_CODING_AGENT.md) 和 [持续进度](implementation/progress.json) 接续。本文保留长期技术依赖；持续开发任务书细化工作项与交付，不缩减完整产品目标。

## 接手时先做

1. 检查 Git 与其他 Agent 的改动；读取 `../evidence/foundation/verification.json`，对照当前源码指纹。已记录证据不是未来变更后的证明。
2. 按 README 安装固定依赖、构建并复验。保留退出码、失败原文、真实版本。Node 范围、实际测试版本与正式环境资格分开。
3. 运行计算器工作台，点 `calculate`，验证源码来自快照、候选跨到 `parseInput/evaluate` 并到下一层、未知仍显示、导出 Context 指向相同 Analysis。
4. 根据下列依赖选择有实际收益的一条垂直切片；更新本任务书与证据，不能只做空接口。

## 当前可依赖的事实

- 有独立 Rust/Node/SQLite/CLI/HTTP/Web 链路。旧 Modus code-atlas **未迁移、未接入新服务**：本切片只交付了宿主接缝（合同即数据 + 参考客户端 + 无存储访问检查）；切换入口需要宿主侧 E2E，而 Modus 检出不在本工作区，无法验证，因此没有切换。
- 静态能力是函数结构与词法候选，加上 0.2 的声明 profile 内局部语义：worker Flow IR → Rust CFG（finally completion/短路/循环/switch）→ 局部抽象解释（def-use、值来源、有限常量折叠、循环不动点、显式 unknown 与预算）。CLI `flows`/`flow` 与 HTTP `/api/flows`、`/api/flow` 已接通，函数面板消费同一事实。跨过程符号摘要（调用点代回、SCC 固定点）已接通并有 D13/D14/D15/D17 反例；有界标量参数 k=1 上下文已接通（每 callee 至多 8 个调用点）；完整堆/闭包上下文、堆别名精度与真实执行仍是目标。
- 索引全链协作取消、发布事务取消门与共享求解预算已接通；`flow.frontier`、调用点 unknown 与计数是部分结果的查询合同。
- 有界分页/遍历、快照源码和 SelectionContext 可用；持久作业身份/幂等/租约/崩溃收割/优先级队列与增量失效已接通（W06/W07 仍 PARTIAL）。正式工具注册/MCP、回执与可控 target runner 中的**场景驱动**（业务步骤、入口动作、依赖切片）仍未实现。
- AI Coding 第一条完整链已接通：diff 提案对固定快照校验 → 隔离副本重新索引 + 图差异 + 声明的 argv 测试 → apply/revert 带字节漂移校验。Intent/Static/Observed 分开存放。Web 侧已有提案审阅面板（登记 + 读验证结果），但 verify 与应用仍只在 CLI，verify 也还没有进持久作业队列。
- Web 实际使用服务事实，候选高亮保留，函数详情面板显示块级控制流、值来源摘要与绑定状态矩阵；`/city3d` 是同一份分析的 WebGL2 投影。**执行画像与隔离受控运行已接通（W08 首片）**：静态分类 + 快照副本 + 目标 Node 权限模型强制 + 源码同一性选目标 + 入口观测记录。仍没有行级覆盖、运行期调用图、上下文合成、Effect journal 与 AI 代码写入。
- CLI 的 worker 参数指定 Atlas 自有受信任提取程序。不要把它扩展为直接运行用户代码的入口。

## 优先级 A：先做本地流 IR 与一条可证明的数据流

对应原 AL 的语法/绑定、CFG、局部值流、摘要前置要求。首批声明一个明确 JS/TS 子集；样本必须包含遮蔽、默认参数、解构、赋值、短路、循环、return/throw/try/finally，并逐项标明已支持和未知。

从 TypeScript AST 提取有源码锚点的语言材料；在 Rust 构建有版本的 Flow IR/CFG。区分函数声明与实际求值、调用引用与调用执行、控制边与数据边。异常 completion 不能用普通 if/else 替代。定义 lattice、join、transfer、widen、worklist 终止与预算降级；先把参数→返回与已建模副作用做成可验证查询，再扩展堆/闭包/框架。

验收：fixture 的预期控制边/值流由源码语义写出，不抄实现输出；新反例包含未覆盖分支、递归、别名/副作用与未知。源文件变更后旧 Flow/Selection 仍可读；不将分析结果标为 observed。原 52 ET / 17 AL 的覆盖登记应逐项映射，不因有 9 个基础测试而抵消原验收。

## 优先级 B：独立作业与增量事实

为 index/run/patch 等长期动作定义 owner、project、snapshot/analysis、request/idempotency key、deadline、cancel、terminal state、诊断与 artifact handle。服务端验证权限与版本；不能信任前端声明。重复请求有实际幂等行为，取消须终止拥有的子进程并阻止旧结果替换新结果。

增量缓存键包含源 hash、语言/profile/编译器/算法版本与依赖摘要；按反向依赖与 SCC 传播失效。不要只用 mtime，不能把 worker count 当作项目规模方案。使用源文件、缓存、摘要和最终发布的一致版本，再增加 watcher。

验收：两项目并发、同项目新旧请求交错、worker 崩溃/超时/输出超限、取消、重启、旧结果迟到、缓存污染、并行发布冲突。至少一个真实中型项目，再向原 GE 分级推进并记录冷/热/增量成本、RSS、磁盘、首屏/交互时延；1200 个合成函数不替代它。

已交付的这一片：真实树（rxjs@7.8.1）上的并发资格——1/3/3 串并测量，3 并发共享 store 与 3 并发分 store 全部 exit 0 且发布与串行基线相同的 analysis id，事后读回计数一致（`scripts/bench_concurrency.py`，证据 `evidence/development/2026-09-12-real-project/rxjs/concurrency.json`）。并发最初是**失败**的：两个进程以 5 秒固定预算去撞发布者的写锁，直接以 `database is locked` 退出；现在等待是可取消的、预算可配、耗尽时是具名拒绝，且读取不再需要写锁。仍未资格：大仓库/monorepo、多语言、Windows、跨机器、并发度上限。

## 优先级 C：函数与场景的受控执行

先做 ExecutionProfile 和充分性报告，将函数分为可纯调用、需上下文、需入口驱动、当前不支持。需要 this、数据库/网络/文件副作用时列出依赖与环境，不“new Function + 源码片段”强行执行。需要闭包时不构造作用域、也不接受函数值输入：`--via <enclosing-symbol>` 先调用**恰好是目标包含函数**的那个函数，再只调用它返回的、源码与目标钉住字节一致的那个实例（`closure_not_returned` / `closure_identity_mismatch` 是观测，更深的链静态拒绝）。

Runner 使用隔离工作副本和用户项目真实环境，不用 Atlas 的 Node 版本假冒目标环境。副本的**范围**是一个被记录的选择而不是隐含行为：`--materialise snapshot`（默认，整快照）或 `dependencies`（目标文件的静态 import 闭包 + 全部 package.json，因为 Node 靠后者决定模块类型）。切片是更紧的读边界：运行时按相对路径读取却从未 import 的文件会以 ENOENT 失败，记录里 `known_risk` 事先列出、`fallback` 说明复核方式（`--materialise snapshot`），未解析的相对 import 逐个具名，遍历触顶报 `bounded`。显式 effects/网络/文件/数据库权限、fixture/mocks 标签、进程树生命周期、日志/输出预算。RunSpec 固定源码版本和调用入口，Trace 映射 build/source map，观测事件有实际来源。测试“复制函数”须核对源/目标字节、目录范围、异常、覆盖/权限与副作用，不只是返回值为 true。

验收：纯函数、上下文函数、异步和失败分支、循环/取消、禁止副作用、mock 与真实结果区分、source drift。图中未知路径与缺失采样要显示，不能用静态 BFS 作为实际 Trace 顺序。

## 优先级 D：正式双视图与 Agent/AI Coding

先建立共享选择/标注对象、版本和投影状态，再扩展 3D：目录是平面框，文件玻璃柱，内部函数层。LOD 不改变事实数量；激活与留下的线路来自 Run，静态关联用另外的图例。2D 保留局部清晰路线，选区能互通。

Agent Bridge 开放有界动作与资源引用，增加请求队列/租约/ACK，浏览器可访问语义 DOM 和选区状态。不能依赖向 Codex/Claude 私有聊天窗口注入。模型提出 Intent/Scenario/Patch，必须经版本与权限校验；旧选区要重定位/拒绝，不能静默改另一函数。

AI Coding 第一条完整链应做到：选函数标注新增约束 → 导出最小证据 → 提案占位 → 生成 patch → 隔离应用 → 本地重新解析 → 测试 → 图 diff → 审阅/应用或撤销。把 Intent、Static、Observed 分清，不将占位展示为真实存在代码。

## 明确未完成的工程工作

公开 schema/golden/兼容性；依赖许可/分发；Windows/Linux 与 Node24 实际资格；超深 AST 的 worker 栈预算；更强路径竞争防护；查询响应的细化预算与取消；断电耐久、GC、存储迁移；更多语言/框架；源码隐私/披露规则；完整真实大仓库基准；远程服务认证；持久工作台状态；Modus adapter。生产诊断仍是候选拓展，不能默认接入生产数据库。

这些是接力任务，不是永久放弃。允许替换框架和目录，要求保留身份、授权、本地数据、明确未知、终止和真实验收。不要为了沿用旧代码而保留错误，也不要为展示进度而把未实现功能画成可用按钮。
