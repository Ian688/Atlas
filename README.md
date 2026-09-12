# Atlas

独立的本地代码分析服务与可视化工作台。Modus 是未来的一个宿主，Atlas 的解析引擎、事实、查询和工作台不依赖 Modus、Python 服务或 LLM。

这是 **Foundation 0.2：一条真实可运行的架构切片**，不是成熟 Atlas 的能力验收。已打通文件清点 → 内容快照 → JavaScript/TypeScript 语言材料 → Rust 关系图 → **版本化 Flow IR → CFG → 局部抽象解释（def-use、值来源、常量折叠、循环不动点）** → 查询 → 2D 工作台 → 固定选区上下文。完整目标仍包含跨过程摘要、函数与场景测试、正式 2D/3D、Agent 操作与 AI Coding。

## 启动

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
- 索引可以作为**持久作业**提交：身份由 (owner, project, request_key) 三元组定义，同一请求幂等——已完成的请求重放原分析而不重跑，失败的可以重试并计入下一次 attempt。作业持有带心跳的租约；租约停止续期就是进程死亡的证据，`job reap` 收割它并判失败，`job work` 则换个人接着跑——崩溃不该让队列停摆，重跑在这里是安全的（发布幂等且不可变）。陈旧持有者无法伪造终态。
- 作业可以**排队**而不是只能即刻执行：`job enqueue` 只登记请求（runner 参数随行存储，所以排队请求描述自己怎么跑），工人按优先级降序、同级最旧优先认领。排队中的作业可以取消；运行中的不行——它属于租约持有者。
- `index --incremental` 在字节与版本都没变时直接返回已发布的分析，并报告一次局部改动会失效什么：每个文件按自身内容与依赖闭包（在导入图 SCC 凝聚上折叠）得到一个键，因此失效**不需要**额外的一遍扫描，且改叶子不会反向失效共享模块。`withdrawn` 列出上次分析过、这次已不存在的文件。**承重断言**：增量与全量必须发布同一个 analysis id，冷/热/编辑/删除四条路径都有测试。已知边界：局部改动仍需重新派生全部函数（Rust 侧是全程序 SCC 不动点）。
- 外部 Agent 可以调用 CLI/本地 HTTP，或操作有语义标签的网页；导出上下文不会自动发送给任何模型。

**当前连线是静态候选，不是数据流执行顺序或运行血流。** 计算器同时出现加、减、除候选，不能据此声称一次加法执行过所有分支。Flow 事实是声明 profile 内的静态推导：未知构造、外部调用效果与跨过程值流都保留为显式 unknown。当前按钮没有修改代码、运行任意函数或调用模型的能力。`examples/flow-lab` 是局部语义事实的集成测试样例（finally、短路、循环、分支候选、显式 unknown）。

## 工程入口

| 入口 | 用途 |
|---|---|
| [架构与算法](docs/ARCHITECTURE.md) | 当前实现、关键不变量、算法边界、完整演进方向 |
| [下一 Agent 任务书](docs/HANDOFF.md) | 可执行接力顺序、验收、缺口与禁止虚报的边界 |
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
node examples/calculator/demo.mjs
node web/tests/app.behavior.test.mjs
node web/tests/city3d.behavior.test.mjs
```

自动化分别覆盖存储/遍历/边界、真实编译器材料、完整 CLI/HTTP 链路和独立计算器断言。`web/tests/app.behavior.test.mjs` 在 `node:vm` 的 DOM 里真正驱动 `web/app.js`（会话保持、失败路径清空、事实与选中的 symbol 一致性），因此工作台的行为不再只靠 `node --check` 的语法检查。

自动化分别覆盖存储/遍历/边界、真实编译器材料、完整 CLI/HTTP 链路和独立计算器断言。120 文件、1,200 函数是合成分页与预算样本；10,000 节点 SCC 是图算法样本；两者均不构成大型真实项目资格。
