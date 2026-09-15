# UI v2 U1–U6 独立复审

**结论：CHANGES_REQUIRED。主要界面已落地，单项目核心流程实测通过；项目切换后会串写入目录、输入与运行证据，完整交付暂不通过。**

本轮不要求重新设计页面，也不恢复旧后台专项。先修下面四项，再从最终包复验。

## R1 · P1：查看 beta，却把 beta 的补丁应用到 alpha

真实 Chrome 操作：从复制到仓库外的分发包启动 alpha → 页面打开 beta → 选择 beta/math.js 的 checkout → 在页面提交并验证补丁 → 检查并应用 → 确认。

两个项目有同名、同字节的 math.js；beta 另有 extra.js，因此分析身份不同。**实测 alpha/math.js 被改，beta/math.js 完全未改。** 点击「打开新版本」又把当前项目从 beta 切回 alpha。

确认层确实显示了 alpha 的绝对目录，所以这里不是声称绕过写入授权。问题是工作台当前项目、提案来源、写入对象不一致；用户正常完成 beta 的修改任务，却改了另一个项目。同文件名、同基础字节在项目副本中很常见，字节漂移检查不能代替项目归属校验。

定位：`server.rs:2190 switch_served` 只更新 analysis/project_key；`server.rs:538 write_gate` 和 `server.rs:2420 project_reindex` 继续使用启动时的 write_root。`patches?target=here` 同样会混入启动项目的提案，并把它们说明成当前项目的旧版本。

修复完成线：打开项目、写入授权、提案所属项目、重索引目录要一致。服务端拒绝错项目写入，不能只依赖确认框；新项目写权限按明确的本机用户操作建立。beta 的应用/新版本/撤销全程留在 beta，alpha 字节保持不变；原有同项目跨版本撤销仍可用。

证据：[确认层](08-beta-write-confirmation.png)、[应用之后](09-beta-applied-to-alpha.png)、[新版本跳回 alpha](10-reindex-project.png)、[实际字节判断](results.json)。

## R2 · P1：同名函数输入草稿串项目

alpha 的 checkout 填 719、83；页面打开 beta，选中同路径同名函数后，表单自动带入 **719、83**。beta 从未填写过这组输入。

定位：`web/app.js:1894 execDraft` 只按 entity id 存草稿；这个 id 在不同项目的相同文件位置可以相同。connect 合并 saved drafts，也没有隔离当前项目的草稿集合。

修复完成线：草稿按项目、版本和对象归属保存；跨版本恢复通过明确的重定位，跨项目不复用。用同路径同签名函数验证 A→B→A，各自选区/页签/输入保持独立，重开后亦然。

证据：[beta 的输入框](05-beta-drafts.png)。

## R3 · P1：旧运行记录被标成新项目的运行结果

alpha 的 checkout(19,4) 曾返回 15，记录固定在分析 `5ea2403fca04…`。切到 beta，打开后台任务中这条记录，结果卡仍显示 15，却标注 beta 的分析 `689e3f0810e3…`。记录本身的 analysis_id 没变，UI 显示错了。在本次样本中，切到 beta 同名函数时，旧结果还会直接残留在结果卡上。

定位：`web/app.js:2399 openTaskResult` 用当前分析解析 task.symbol，未按 task.analysis_id 找回目标；`web/app.js:2106 renderExecResult` 用 state.report.id 给历史记录标版本。

修复完成线：结果卡、输入快照、源码目标均以实际运行记录为准。跨项目任务可以切回所属项目查看，或作为明确标注所属项目/版本的只读历史展示；不能冒充当前对象的结果。切换对象和项目时清除不匹配的旧结果。

证据：[旧任务显示在 beta](07-old-task-under-beta.png)、results.json 中记录与当前分析的完整 id。

## R4 · P2：「项目设置」实际是全 store 共用

在 alpha 的项目设置中保存 `["node","--test"]`，切到新打开的 beta，该设置原样生效。beta 的验证随后也运行了 alpha 的命令。产品没有说明这是全服务设置。

定位：`server.rs:2053` 把设置保存到 store 根下唯一的 project-settings.json；verify 配置在 switch_served 时未切换。

修复完成线：按项目持久化并切换设置，保留已经入队作业自己的配置快照；用 A、B 两条有区别的测试命令验证实际执行输出及服务重启后的恢复。若提供全局默认值，需明确标注并区分项目覆盖值。

证据：[beta 设置页](06-beta-settings.png)、results.json。

## 本轮确认通过的部分

- 最终包复制到自己的临时目录，用包内 start.sh 从仓库外启动；页面搜索、关系跳转、源码和真实运行可用。
- 在另一个函数运行时离开，再从后台任务面板取消，显示服务端确认的 cancelled 终态。
- 页面声明 node --test 后，隔离验证实际执行该命令并返回成功；三栏审阅布局实际为 grid。
- 同一输入 [19,4] 的真实前后对照为 15 / 23，显示各自固定版本。
- 单项目应用 → 打开新版本读更新源码 → 跨版本撤销，实际磁盘字节精确恢复。
- 页面打开 beta 能得到不同分析，并找到 betaOnly。

截图确认运行结果卡、三栏审阅、任务面板和设置表单已有实现；上一轮「入口只有说明」的问题不再原样列为未完成。

## 检查和范围

| 检查 | 结果 |
|---|---|
| 自编 [probe.cjs](probe.cjs)，真实 Chrome，最终包与独立双项目样本 | exit 1；7 PASS、5 FAIL。两个失败归并为 R1，因此是四项整改 |
| `node --test web/tests/app.behavior.test.mjs` | exit 0；74 项既有检查通过，见 web-tests.log |
| 当前源码 fingerprint 与复制包 /api/report 的 binary_fingerprint | 一致：02378fedc716441eb8d3ae385485a72d723268d207305780f19c0d1fd8c3d297 |
| 已交付的 verify-final/verification.json | 读取核对：PASS；本轮未重复运行整个 verify.py，不记为独立全量通过 |
| `git diff --check` | exit 0，见 diff-check.log |

包文件 SHA-256 与源码构建指纹是两种不同值；报告中「三方一致」指内嵌构建指纹，非 debug/release 文件逐字节相同。实测身份见 [identity.json](identity.json)、[fingerprint-check.json](fingerprint-check.json)。

所有测试写入只发生在本轮自建临时项目，结束已关闭自己的浏览器/服务并清理临时包和样本；没有修改用户项目源码。日志不保存会话令牌。git 工作树中其他人的修改均保留。

本轮主要针对单项目核心链和新增加的项目切换。没有独立重跑完整外部 Agent 任务、3D 成员往返或服务重启；这些保持自测范围，未升级独立资格。

交付报告的「30/30」是脚本断言结果，不足以推出所有完成线都被覆盖：其「两个项目状态隔离」只检查 gamma/checkout 搜索结果，没有填写并切换同名函数草稿；应用/撤销都在切回 alpha 后做，漏掉 beta 写入；3D 检查读取 members 但没有断言其内容或返回后的对象身份；所谓外部 Agent 提案是脚本调用 CLI 并传入 proposed_by，并非本轮独立 Agent 自主完成任务。后续补齐对应断言即可，不需扩大成新的平台项目。

## 给下一位实现者

沿用任务书 v5 和当前设计，按 **R1 项目与写入一致 → R2/R3 草稿和记录身份 → R4 项目设置** 修复。复用本目录的双项目复现，不把冲突规避为不同函数名；记录每次写入后两个项目的文件字节。随后核对同项目跨版本撤销、项目重启恢复与设计规定的 Agent/3D 往返，再打最终包。交一份新报告即可，无需重写历史报告或重新做已完成的界面。
