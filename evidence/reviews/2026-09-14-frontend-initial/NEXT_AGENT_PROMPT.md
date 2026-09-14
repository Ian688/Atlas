# 下一单：修好已交付工作台，再完成修改审阅

在 /Users/yinsijie/CodeRepo/Atlas 直接延续当前未提交实现。F1–F5 已有实现，不从 F1 重做。遵循 AGENTS.md 与 docs/DAILY_DEVELOPMENT_WORK_ORDER.md；当前断点见同目录 REPORT.md 与 results.json，不需要通读历史规格。

目标：用户能沿准确的函数关系理解代码，填写真实运行依赖，提出补丁并完成可读、可操作的审阅。当前独立复验 CHANGES_REQUIRED，先处理 R1–R4，再完成 T2 的前后差异展示和应用/撤销闭环，随后按原任务书继续 T3。常规实现选择自行决定，不需要重新申请许可。

1. 先运行同目录 probe.cjs 复现三个失败。修复 web/app.js 验证生命周期、exec.rs 的作用域误判、server.rs 验证提交/查询身份；再统一 drawFocusPlan/graphNode 的坐标与端口。修真实路径，不删除断言或把普通局部变量统一标成未知。
2. 扩展少量能区分错误的用例：切换后再验证及失败重试；块内同名局部与块外全局共存、对象简写局部不误报；默认/自定义请求键查询与重复提交；连线端点落在相应节点边界。复用现有测试，不另建测试平台。
3. 把 renderPatches 中压成文字的 diff 做成可读多行增删，展示实际结构变更并能定位对象/源码。验证状态与测试是否运行分开；未运行测试明确呈现。完成一次真实提案→隔离验证→查看差异→授权临时目录应用→撤销，验证实际文件字节。用多行且包含新增/删除的样本检查版面。
4. 真实浏览器点击查找→相邻函数→运行→审阅→切换返回，用 tour 和不同结构小样本核对。截图检查关系端点、文本换行、滚动与按钮状态，不能只用 DOM 模拟或接口返回代替。
5. 改动中跑聚焦检查；交付时跑任务书规定的适用集成/综合检查。记录最终命令、退出码、截图及真实未完成项。更新一份简洁交付报告与 progress 当前指针，保留本轮独立复验和其他人的未提交更改。自测通过标 NEEDS_INDEPENDENT_REVIEW。

原始复现命令（本机已可运行）：
```sh
cargo build --workspace --locked
NODE_PATH=/Users/yinsijie/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules node evidence/reviews/2026-09-14-frontend-initial/probe.cjs
```
运行前复制该脚本到新的证据目录，保留本轮 results.json 和截图；脚本按自身目录输出。不要重写历史失败证据。若工具路径变化，仅调整运行环境，不改变反例和预期。

无需为本单先完成大仓库资格、Modus 迁移、额外语言或通用调度平台。先交付上面的用户闭环，后续沿原任务书推进。
