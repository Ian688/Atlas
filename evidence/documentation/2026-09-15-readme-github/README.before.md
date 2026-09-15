# Atlas

**给开发者和 Codex 等编程 Agent 使用的本地代码工作台：理解项目、验证行为、审阅修改。**

你在浏览器中找代码、看关系和源码、输入参数运行函数，再查看修改前后的差异与运行结果。Agent 通过 CLI 或本地 API 查询同一份代码、提交补丁、读取验证结果。

Atlas 面向各种语言的项目；当前语义分析与受控函数运行首先支持 JavaScript / TypeScript。其他语言的能力不能由文件可见推断为已经支持。

## 能用来做什么

- **接手项目**：查找函数，沿调用关系回到源码，了解修改位置。
- **验证行为**：声明输入，查看真实返回、异常或不能运行的原因，对比两次结果。
- **审阅修改**：看补丁，在副本中验证并执行已配置的测试，对比基线与补丁，再授权应用或撤销。
- **与 Agent 协作**：共享节点、源码版本、提案和验证记录，减少反复复制上下文。

项目地图、多展示区与节点批注正在完善。可重复场景、完整运行轨迹和调试属于后续设计，不能视为现有能力。产品设计见 [功能与路线](docs/PRODUCT_DESIGN.md)，实际交付范围见 [当前交接](docs/HANDOFF.md)。

## 启动

取得本机分发目录后运行：

```sh
./start.sh /path/to/your/project
```

按终端提示打开浏览器。页面可打开/切换项目、配置项目测试命令；修改文件需要对应项目的写授权。当前分发验证范围是 macOS darwin-x64，Node 要求以启动器检查为准；其他平台未验证。

从源码体验示例：

```sh
npm ci --prefix workers/typescript --ignore-scripts --no-audit --no-fund
cargo build --workspace --locked
python3 scripts/demo.py --open
```

源码方式需要 Rust/Cargo、Node.js 24+、npm 和 Python 3；Python 只用于启动脚本。终端按 `Ctrl-C` 停止。

## Agent 接入与边界

见 [Agent 接入说明](docs/AGENT_ONBOARDING.md) 与 [CLI / HTTP 接口](docs/HOST_API.md)。服务的 `GET /api/contract` 返回实际接口能力；不承诺任意 Agent 自动接入。

本地解析不执行项目，也不默认调用模型或上传源码。动态调用可能无法确定，并非所有函数都能独立运行。当前图中的静态调用关系不代表实际执行路线，运行记录没有完整行级覆盖或调用轨迹。测试通过只说明已执行的测试通过。

参与开发从 [当前任务书](docs/DAILY_DEVELOPMENT_WORK_ORDER.md) 开始。旧交付报告保留历史资格，不能代替新代码或新分发包的验收。
