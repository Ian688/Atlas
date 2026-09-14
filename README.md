# Atlas

Atlas 帮你读懂本地 JavaScript / TypeScript 项目，并在改代码前试跑函数。你可以在浏览器里查找函数、查看谁调用它、对照源码，再填入参数看实际结果。

适合接手陌生项目、排查函数行为，以及检查自己或 AI 提出的代码修改。代码在本机分析，不需要接入 AI 服务。

## 能做什么

- **顺着关系读代码。** 搜索函数，点击调用者或被调用者，旁边同步显示源码；查看变量的值从哪里来，哪些地方还分析不出来。2D 用于阅读，3D 用于浏览项目结构。
- **给函数一组输入，看它怎么返回。** 在页面填写参数，运行支持的函数，查看返回值、异常和历史输入。缺少运行条件时，页面会说明缺什么。分析项目本身不会执行代码。
- **检查一份修改。** 粘贴补丁，查看源码增删，在项目副本中验证，并比较修改前后的运行结果。应用和撤销已有实现，这条流程仍在完善，见下方当前状态。

例如，你准备修改价格计算函数：先查它被哪些地方调用，读相关源码，再分别输入正常值和边界值，检查结果是否符合预期。这样可以把“找代码、看关系、试输入”放在同一个页面里完成。

## 先试一下

准备 Rust/Cargo、Node.js 24+、npm 和 Python 3。在仓库根目录执行：

```sh
npm ci --prefix workers/typescript --ignore-scripts --no-audit --no-fund
cargo build --workspace --locked
python3 scripts/demo.py --open
```

浏览器会打开自带的计算器项目。选择一个函数，查看调用关系和源码，再点“运行这个函数”填写参数。终端按 `Ctrl-C` 停止服务。

Python 只用于这个启动脚本，Atlas 服务本身不需要 Python。

## 打开自己的项目

完成上面的构建后，在仓库根目录执行，把路径换成你的项目：

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
