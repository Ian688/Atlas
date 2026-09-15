# Atlas

**Atlas 是给开发者和 Codex 等编程 Agent 使用的本地代码工作台，用来理解项目、验证代码行为、审阅修改。**

开发者在浏览器里看项目结构、沿调用关系读源码、填写输入试跑函数；Agent 通过命令行或 API 查询代码、获取上下文、提交补丁并读取验证结果。两者可以围绕同一份代码版本协作。

Atlas 不限定项目的编程语言。当前首先实现了 JavaScript / TypeScript 支持，其他语言的分析与运行能力尚待接入。

## 用它解决什么问题

- **接手陌生项目：从哪里开始看？** 搜索函数，查看谁调用它、它调用谁，点击关系回到源码。2D 用于详细阅读，3D 用于浏览项目结构。
- **准备修改代码：这个函数到底会怎样运行？** 查看输入要求，填入参数，读取实际返回值或异常，再换一组输入比较。分析不出来的关系和缺少的运行条件会明确显示。
- **拿到一份修改：它改了什么，是否符合预期？** 查看补丁的源码增删，在副本里验证，比较修改前后的结果，再决定是否应用或撤销。这条流程仍在完善。

例如，让 Agent 修改价格计算逻辑时，Atlas 的目标是让它先查相关函数和调用关系，再提出补丁、运行用例，并把修改与验证结果留给你审阅。你可以回到源码核对它的判断。完整的 Agent 协作流程尚未验收通过。

## 开发者和 Agent 怎么用

**开发者**通过浏览器工作台查找、阅读、运行和审阅代码，下面的命令可以打开示例。

**Agent**可以调用 Atlas 的 CLI 或本地 HTTP API，读取函数、关系和源码上下文，提交补丁并获取运行或验证结果。已有接口说明见 [工具接入](docs/HOST_API.md)；服务启动后，`GET /api/contract` 返回它提供的接口清单。Codex 等 Agent 的自动接入和完整任务流程仍需验证，目前不承诺开箱即用。

分析在本机进行，无需调用模型。将上下文交给外部模型由使用者决定，Atlas 不默认上传项目源码。

## 先试一下

当前从源码试用需要 Rust/Cargo、Node.js 24+、npm 和 Python 3。在仓库根目录执行：

```sh
npm ci --prefix workers/typescript --ignore-scripts --no-audit --no-fund
cargo build --workspace --locked
python3 scripts/demo.py --open
```

浏览器会打开自带的计算器项目。选择一个函数，查看调用关系和源码，再点“运行这个函数”填写参数。终端按 `Ctrl-C` 停止服务。

Python 只用于这个启动脚本，Atlas 服务本身不需要 Python。

## 打开自己的项目

完成上面的构建后，在仓库根目录执行，把路径换成你的项目。当前请用 JS/TS 项目体验已实现的分析能力：

```sh
target/debug/atlas --store local-state index /path/to/your/project
```

复制输出中的 `id`，用它启动工作台：

```sh
target/debug/atlas --store local-state serve <id>
```

打开输出中的本地地址，再从输出所指的 `session_file` 文件中复制 `token`，填入页面的“连接会话”。这个入口默认不允许页面修改项目文件。

## 当前状态

开发预览版，首版本地交付的形态已经具备：一套自测通过的旅程（人的浏览器流程 + 真实 Agent 的工具流程）
已完成，等待独立复审。

- 分发包从任意目录启动都能完成"提案 → 隔离验证 → 前后对照 → 授权应用/撤销"；
  停止服务再启动，选区、任务页签和输入草稿按项目恢复（见 [S1/S2 证据](evidence/development/2026-09-15-s1-s6-first-version/)）。
- 测试命令在**启动时声明**（`--test-argv`），验证在隔离副本里执行并显示命令、输出、退出码和超时；
  未声明时如实写"没有跑任何测试，这不是通过"。
- 前后对照使用同一份完整声明输入（args / this / globals），两侧都保留各自的分析版本。
- 一个真实的编程 Agent 已仅凭 [接入说明](docs/AGENT_ONBOARDING.md) 用公开接口完成过一次修改任务，
  并由另一个独立 Agent 复核过结果（其中一处夸大已被记录在案）。

仍然存在的限制（不打算在首版解决）：

- 不能运行所有函数：需要未知调用授权的函数在 HTTP 面上会被具名拒绝（沙箱不能由页面放宽）。
- 分析不出所有动态调用。图中的连线是代码里的调用关系候选，不是这次运行实际走过的路线；
  目前没有行级覆盖或运行轨迹。
- 同一实例的 HTTP 面只服务启动时钉定的那一份分析；要看补丁侧的图，读提案的 `verification.graph_diff`。
- 只验证过 macOS darwin-x64 + Node 26；Windows、Linux、其他架构与干净机器未验证。

交接见 [当前交接](docs/HANDOFF.md)，Agent 接入见 [接入说明](docs/AGENT_ONBOARDING.md)，
首版自测范围见 [本轮报告](evidence/development/2026-09-15-s1-s6-first-version/REPORT.md)。

## 参与开发

从 [当前任务书](docs/DAILY_DEVELOPMENT_WORK_ORDER.md) 接手已有工作。

[产品目标](docs/USE-CASES.md) · [前端设计](docs/FRONTEND_DESIGN.md) · [工程架构](docs/ARCHITECTURE.md) · [CLI 与外部工具接口](docs/HOST_API.md)
