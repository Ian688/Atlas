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

目前是开发预览版。查找、关系导航和简单函数的真实运行已通过独立实测；已有 macOS 本地分发包，完整交付仍在收尾。

- 从仓库外启动分发包后，补丁验证会报 `worker_missing`；停止服务再启动，选区和输入草稿还不能恢复。
- 页面验证的测试命令配置、修改前后对照中的部分运行输入仍需补齐。
- 不能运行所有函数，也不能分析清楚所有动态调用。图中的连线表示代码里的调用关系，不表示这次运行实际走过的路线；目前没有完整运行轨迹。

修复进展见 [当前交接](docs/HANDOFF.md)，实测范围见 [最近一次独立检查](evidence/reviews/2026-09-15-local-delivery/REPORT.md)。

## 参与开发

从 [当前任务书](docs/DAILY_DEVELOPMENT_WORK_ORDER.md) 接手已有工作。

[产品目标](docs/USE-CASES.md) · [前端设计](docs/FRONTEND_DESIGN.md) · [工程架构](docs/ARCHITECTURE.md) · [CLI 与外部工具接口](docs/HOST_API.md)
