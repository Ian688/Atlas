# Atlas 当前交接

## 压缩上下文后从这里继续

当前执行 [任务书 v4.0 的 S1→S6](DAILY_DEVELOPMENT_WORK_ORDER.md)。可直接把
[开发 Agent 提示词](START_DELIVERY_AGENT.md) 交给执行者。

用户决定：Atlas 同时服务开发者与 Codex 等编程 Agent，不限定项目语言。JS/TS 只是当前实现范围。
首版同时验收人的浏览器流程与真实 Agent 的工具流程，Agent 验收不能推迟为可选集成。

## 最新独立复审

[本次复审](../evidence/reviews/2026-09-15-s1-s6-independent/REPORT.md)：**CHANGES_REQUIRED**。
资源定位与主要旅程通过；下一单按报告 R1→R4 处理版本请求拒绝、重定位草稿、快速关闭保存和授权说明。
下面是执行者交接记录；其中“unknown_calls 在 HTTP 面不能运行”的判断已被本次实测推翻，详见复审。

## 已有成果与实际断点

最新窗口 `2026-09-15/s1-s6-first-version`，见
[执行者报告](../evidence/development/2026-09-15-s1-s6-first-version/REPORT.md)。
**自测通过，NEEDS_INDEPENDENT_REVIEW。**

本次修掉了上一轮两个 P1 阻断：

- 仓库外启动分发包后补丁验证报 `worker_missing` —— 资源定位改为以可执行文件为锚
  （`resolve_worker`），`serve` 也接受启动配置；验证、重试与排队作业共用同一份资源。
- 停止服务再启动丢选区/页签/草稿 —— 端口按项目路径稳定推导，任务状态按项目身份
  存在 store 里并在重开时恢复，选区按分析版本重定位（拒绝时说明原因）。

同时补齐：启动时声明的测试命令（在隔离副本执行，页面显示命令/退出码/输出/超时）、
前后对照的完整声明输入（args / this / globals）、失败验证的重试路径（`claim_job` 认领
failed/cancelled 行）、`ui-state` 端点、契约里缺失的 `search` / `exec-compare` / `ui-state`。

## 人的旅程与 Agent 旅程都已实测

- 人：真实 Chrome，`examples/tour` 12 项 + 多层目录项目 6 项，含关系点击、值定位、
  切换对象不串结果、隔离验证、前后对照、授权应用/撤销字节核对、2D/3D 往返、停止重开。
- Agent：一个没有开发上下文的编程 Agent 只读 [接入说明](AGENT_ONBOARDING.md)，用公开接口
  完成了"修复金额边界并保留正常情况"（提案 `a41f014f…`，验证 completed，测试 4/4 退出码 0），
  没有应用补丁；**另一个独立 Agent** 复核了结果并抓出执行者报告 1 处事实夸大；
  人在工作台定位到同一份提案与结果并应用/撤销。

## 已知限制（保留，不当作完成）

- 需要 `unknown_calls` 授权的函数在 HTTP 面无法运行，对照因此也被具名拒绝——沙箱只能由
  操作者在启动时决定，页面不能放宽。
- 同一实例的 HTTP 面只服务启动时钉定的那一份分析；补丁侧的图只能读 `verification.graph_diff`。
- 稳定端口在旧实例仍占用时会回退到随机端口（页面可用，但浏览器自身本地缓存不再共享）。
- 只验证过 macOS darwin-x64 + Node 26.5.1；Windows、Linux、其他架构与干净机器未验证。

## 当前顺序

S1→S6 已完成自测，本次独立复审发现 R1→R4；先按复审报告修正并复验，再决定首版之后的顺序。

代码导航见 [架构](ARCHITECTURE.md)，前端基线见 [主设计](FRONTEND_DESIGN.md)，
Agent 接入见 [接入说明](AGENT_ONBOARDING.md)，宿主接口见 [HOST_API](HOST_API.md)。

共享工作树有大量未提交改动，不清理、不回退他人工作。只维护一份新交付报告和
[progress 当前指针](implementation/progress.json)，保留历史 evidence。自测与独立验收分开。
