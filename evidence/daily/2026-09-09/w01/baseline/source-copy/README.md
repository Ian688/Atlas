# Atlas

独立的本地代码分析服务与可视化工作台。Modus 是未来的一个宿主，Atlas 的解析引擎、事实、查询和工作台不依赖 Modus、Python 服务或 LLM。

这是 **Foundation 0.1：一条真实可运行的架构切片**，不是成熟 Atlas 的能力验收。已打通文件清点 → 内容快照 → JavaScript/TypeScript 语言材料 → Rust 关系图 → 查询 → 2D 工作台 → 固定选区上下文。完整目标仍包含控制流/数据流、函数与场景测试、正式 2D/3D、Agent 操作与 AI Coding。

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
- 用 Rust 构建包含关系、调用候选图、递归分量；按版本分页、多跳遍历、读取 UTF-8 源码窗口。
- 在真实 2D 页面中浏览文件与函数，选中对象高亮相关候选，其他对象变淡，导出带分析版本的本地 JSON 上下文。
- 外部 Agent 可以调用 CLI/本地 HTTP，或操作有语义标签的网页；导出上下文不会自动发送给任何模型。

**当前连线是静态候选，不是数据流、真实执行顺序或运行血流。** 计算器同时出现加、减、除候选，不能据此声称一次加法执行过所有分支。当前按钮没有修改代码、运行任意函数或调用模型的能力。

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
node examples/calculator/demo.mjs
```

自动化分别覆盖存储/遍历/边界、真实编译器材料、完整 CLI/HTTP 链路和独立计算器断言。120 文件、1,200 函数是合成分页与预算样本；10,000 节点 SCC 是图算法样本；两者均不构成大型真实项目资格。
