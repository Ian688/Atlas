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

先做 ExecutionProfile 和充分性报告，将函数分为可纯调用、需上下文、需入口驱动、当前不支持。需要 this、数据库/网络/文件副作用时列出依赖与环境，不“new Function + 源码片段”强行执行。需要闭包时不构造作用域、也不接受函数值输入：`--via <enclosing-symbol>` 先调用**恰好是目标包含函数**的那个函数，再只调用它返回的、源码与目标钉住字节一致的那个实例（`closure_not_returned` / `closure_identity_mismatch` 是观测）。嵌得更深时 `--via-chain` 给出**它之上**的祖先（由外到内），每一环都按同一把源码同一性尺子核对、失败点记录在 `failed_stage`；链必须是真实包含路径且最外层是顶层，深度上限 8。

Runner 使用隔离工作副本和用户项目真实环境，不用 Atlas 的 Node 版本假冒目标环境。副本的**范围**是一个被记录的选择而不是隐含行为：`--materialise snapshot`（默认，整快照）或 `dependencies`（目标文件的静态 import 闭包 + 全部 package.json，因为 Node 靠后者决定模块类型）。切片是更紧的读边界：运行时按相对路径读取却从未 import 的文件会以 ENOENT 失败，记录里 `known_risk` 事先列出、`fallback` 说明复核方式（`--materialise snapshot`），未解析的相对 import 逐个具名，遍历触顶报 `bounded`。显式 effects/网络/文件/数据库权限、fixture/mocks 标签、进程树生命周期、日志/输出预算。RunSpec 固定源码版本和调用入口，Trace 映射 build/source map，观测事件有实际来源。测试“复制函数”须核对源/目标字节、目录范围、异常、覆盖/权限与副作用，不只是返回值为 true。

验收：纯函数、上下文函数、异步和失败分支、循环/取消、禁止副作用、mock 与真实结果区分、source drift。图中未知路径与缺失采样要显示，不能用静态 BFS 作为实际 Trace 顺序。

## 优先级 D：正式双视图与 Agent/AI Coding

先建立共享选择/标注对象、版本和投影状态，再扩展 3D：目录是平面框，文件玻璃柱，内部函数层。LOD 不改变事实数量；激活与留下的线路来自 Run，静态关联用另外的图例。2D 保留局部清晰路线，选区能互通。

Agent Bridge 开放有界动作与资源引用，增加请求队列/租约/ACK，浏览器可访问语义 DOM 和选区状态。不能依赖向 Codex/Claude 私有聊天窗口注入。模型提出 Intent/Scenario/Patch，必须经版本与权限校验；旧选区要重定位/拒绝，不能静默改另一函数。

AI Coding 第一条完整链应做到：选函数标注新增约束 → 导出最小证据 → 提案占位 → 生成 patch → 隔离应用 → 本地重新解析 → 测试 → 图 diff → 审阅/应用或撤销。把 Intent、Static、Observed 分清，不将占位展示为真实存在代码。

## 明确未完成的工程工作

公开 schema/golden/兼容性；依赖许可/分发；Windows/Linux 与 Node24 实际资格；超深 AST 的 worker 栈预算；更强路径竞争防护；查询响应的细化预算与取消；断电耐久、GC、存储迁移；更多语言/框架；源码隐私/披露规则；完整真实大仓库基准；远程服务认证；持久工作台状态；Modus adapter。生产诊断仍是候选拓展，不能默认接入生产数据库。

这些是接力任务，不是永久放弃。允许替换框架和目录，要求保留身份、授权、本地数据、明确未知、终止和真实验收。不要为了沿用旧代码而保留错误，也不要为展示进度而把未实现功能画成可用按钮。

## 交接状态（2026-09-12，第 19 轮结束时）

本节是**当前实际状态**，不是目标描述。全部数字都有 `evidence/development/` 下的窗口目录（`REPORT.md` + `verification.json` + 各检查日志）与 Git 提交对应。

### 首要性：呈现（2026-09-12，用户明确纠正）

**Atlas 的表达方式就是呈现。** 它不是聊天对象，是仪器：画布、面板、屏幕结构本身就是产品。底层事实再准确，只要呈现层偷懒，产品就等于不存在——知识都在引擎里，没有人能据此做决定。

这条纠正推翻本仓库此前的事实上的优先级（"先造可验证的机制，UI 最后投影一次"）。它带来的直接后果：

- **先做屏幕，再补算法**：任何一轮如果没有让某个使用场景的屏幕变得可用，这一轮就不算完成，无论它修了多少底层缺陷；
- **一次只交一屏**：以"一个人能不能用这一屏做决定"为验收，而不是以"机制是否完备"为验收；
- **门禁保留、不再扩**：证据是为了不虚报，不是为了替代功能；
- **"能不能点、能不能看懂、结论会不会被读错"与算法正确性同级**：例如"第一页 0 个函数、点了没反应"和"返回值发布成 0.0"都算 P0，和解析错误一样严重；
- 呈现的第一屏是**函数工作台**：以"我要改这个函数"为任务，把四问（谁调用它 / 它调用谁 / 返回值从哪来 / 哪里是未知）作为页面的主结构，动作带理由，未知带边界。设计目标见 `evidence/development/` 之外的会话记录；落地时以真实页面为准，不以 mockup 为准。

### 已完成并有证据的能力（本会话交付）

| 主题 | 交付 | 门禁窗口 |
|---|---|---|
| W08 嵌套闭包 | `--via` 一层：包含函数真实产生实例 + 源码同一性核对 | `2026-09-12-w08-closure-via` |
| W08 多层闭包 | `--via-chain`：逐环调用、逐环核对、失败环节记录 `failed_stage` | `2026-09-12-w08-via-chain` |
| W08 副本范围 | `--materialise snapshot\|dependencies`：静态 import 闭包 + package.json；真实项目 2277→7 文件 | `2026-09-12-w08-materialise-slice` |
| W09 3D 层级 | `project→district→file` 形式层级 + LOD，聚合守恒可失败可显示 | `2026-09-12-w09-city-lod` |
| W09 补丁形式 | 修改/新建（`--- /dev/null`）/删除（`+++ /dev/null`），重命名具名拒绝 | `2026-09-12-w09-patch-forms` |
| W09 一键撤销 | `serve --allow-writes <DIR>` 才开放 HTTP 写；单目录 + 路径回显 | `2026-09-12-w09-http-writes` |
| W09 写入锁 | `.atlas-apply.lock`（持有者 + 取锁时刻），`patch unlock` + 年龄门 | `2026-09-12-w09-apply-lock`、`-patch-unlock`、`-unlock-age-guard`、`-lock-timestamp` |
| W07/W06 并发 | 写锁等待可取消 + 具名超时；3 并发同 id（真实 rxjs）；`job work --parallel 1..=4` 每槽位独立租约 | `2026-09-12-ge3-concurrency`、`2026-09-12-w06-bounded-parallel-jobs` |
| W09 共享层级 | 2D/3D 共用一个几何无关的层级定义（`web/hierarchy.js`）；2D 获得层级切换 + 均匀网格空间索引；层级省略与预算截断分开报告 | `2026-09-12-w09-shared-hierarchy` |
| W09 尺度合同 | 柱高从等比改为分段单调尺度（2D/3D 共用）；压缩标记环；「尺度」行含标尺与对照；可读性基准进入门禁（判据可被证伪） | `2026-09-12-w09-column-scale` |
| W09 2D 分层布局 | 本地钉版 elkjs 0.12.0（`web/vendor/`，未修改、EPL-2.0、指纹覆盖）+ 端口 + 折叠摘要边；无坐标结果具名拒绝、迟到布局按 generation 丢弃、引擎/交叉/碰撞/折叠进入状态行与门禁 | `2026-09-12-w09-layered-layout` |

门禁状态：`python3 scripts/verify.py` = **25 项检查 + 1 项受控负对照 + 指纹配对**（含"二进制自称的指纹 == 从源码算出的指纹"），最新为全绿（见 `evidence/development/2026-09-12-w09-shared-hierarchy/verification.json`）。第 17 轮第一次运行**是红的**：`fingerprint pairing` 发现 `build.rs` 的指纹清单漏了 `web/hierarchy.js`，原始失败证据保留在该窗口 `runs/run-1-fingerprint-mismatch/`。

### 下一轮起点（按价值排序）

1. **2D 层级只在已加载的一页上计算**（W09，本轮新增的限制）：3D 会翻页加载到 400 文件上限，2D 仍只用当前一页对象算层级，所以它现在会自报 `本页已加载 100/8938 对象` 与 `（仅已加载子集）`——数字是真的，但"项目/目录层级的全局视图"还没做到。下一步要么让 2D 也翻页（并明确上限），要么明确宣布 2D 的层级是本地子集视图。
2. **层级不经 URL fragment 传递**（W09，本轮新增的限制）：选区可以在 2D/3D 之间传，层级还不能，所以在 3D 切到目录层再跳到 2D 会回到文件层。
3. **2D 可交互布局**：空间索引只回答"这一点上是哪个块"（含具名未命中与 `scanned` 代价），不解决"块怎么排更好看"；自动避让/拖拽尚未实现。
4. **大仓库 / monorepo 规模资格**（W07 GE-2/GE-3）：目前只有 rxjs@7.8.1（1255 源文件）的单包测量；需要另一个更大或 monorepo 形状的真实项目，记录冷/热/增量与并发数字。`scripts/bench_real_project.py` 与 `scripts/bench_concurrency.py` 可直接复用（`--package/--sha256/--project/--store`）。
5. **合并与逐文件备份**（W09）：撤销来源是内容寻址的钉住 blob；检出被改动时 apply/revert 是拒绝而不是合并。
6. **行级 / 调用级采样**（W09 城市运行层）：现在只有入口调用观测，因此城市里的运行信息是"哪些入口被跑过"，不是运行路径；这条需要真正的插桩设计。
7. **Modus 宿主侧 E2E 与旧入口切换**（W10）：**环境性硬阻塞**——Modus 检出不在本工作区，无法构建或测试宿主侧；前置条件与回滚已写在 `docs/HOST_API.md`。

### 已知的真实限制（不得读成已实现）

- 并发资格只到单机单语言 N=3~4；无跨机器、多语言、Windows 资格；`--parallel` 上限 4 是策略不是测量。
- apply 无合并、无逐文件磁盘备份；锁是单机文件锁、不约束人工编辑、无租约/心跳。
- 依赖切片是**静态**闭包：计算型动态 `import()` 与运行时数据文件不在副本里（记录里 `known_risk` 事先列出）。
- 单文件超大模块（实测 14000 函数 / 1.15 MB）在 1 GiB heap 下 10 分钟未完成：按文件粒度的派生代价在该形状下不可接受。
- `incremental_runs` / patch 派生的 analysis 只增不删，无回收策略。
- 2D 的层级视图建立在**本页已加载的一页对象**上（3D 会翻页到 400 文件上限）：页面会自报 `（仅已加载子集）`，但"全局的项目/目录层级"在 2D 还没有。
- 层级还不能像选区那样经 URL fragment 在 2D/3D 之间传递；2D 的空间索引只做"这一点上是哪个块"，不做布局避让。
- **按用户决定，广度已暂停**：W07 大仓库/monorepo 资格与 W10 宿主侧 E2E 不再推进，继续标注为 PARTIAL / 环境性阻塞；当前集中做"把 2D 做成真能用的工作台"。
- 3D 仍缺：玻璃外壳（`alpha:false`）、跨目录调用的**边界端口**、正交/平面 2.5D 视角、相机与折叠的跨视图保存、静态阅读按需重绘（现为常驻 `requestAnimationFrame`）、搜索定位到层、类层组标题、`visibility_reason`、文件树/全局小图/时间轴。
- 可读性现在有两条判据（柱高、布局交叉与标签碰撞），但**帧时间与布局稳定性只有脚本级检查**，没有浏览器内量测；2D 的**概览**仍是网格，只有调用视图是布局出来的。
- 布局在**主线程**同步等待异步引擎结果，`LAYOUT_MAX_NODES = 120`；规格要求的 layout worker、deadline、取消与 generation 缓存**未实现**。3D 的缺口（玻璃、边界端口、正交视角、相机保存、按需重绘、搜索定位、visibility_reason）一条都没动。
- W00–W10 的 `implementation` 多为 PARTIAL：自动化检查 PASS，但**资格（qualification）一律 NOT_QUALIFIED，且独立评审未做**。

### 复验入口（一条命令）

```bash
cargo build && python3 scripts/verify.py --label <label> --out evidence/development/<date>-<label> --keep-going
```
