# Atlas 接手速查

更新：2026-09-13。本文件只提供导航，不另设规则或任务队列。

1. [执行任务书](DAILY_DEVELOPMENT_WORK_ORDER.md)：当前 T1–T3、验收步骤、代码入口、诊断与验证方法。
2. [产品目标](USE-CASES.md)：最终用户拿到什么；视觉方案是可迭代实现，不固定每轮屏数。
3. [交接状态](HANDOFF.md) 与 [进度](implementation/progress.json)：从哪里核对断点，不把历史报告当当前证明。
4. [架构](ARCHITECTURE.md)：数据身份与现有接缝；按需查源码及完整规格。

默认直接做：找到 T1 第一个真实失败步骤，改生产路径，跑相关检查，实际点通，再进入下一步。普通重构和实现选择无需确认。详细技术历史通过 Git 与原 evidence 查询，不必开工通读。

容易漏的两点：页面第一页不是全项目；切换选区后的旧异步结果不能覆盖新对象。语义变化要检查生产者/算法版本与分析身份，布局或渲染变化不要改变事实。其余限制以当前任务书为准。

前端开工：[实现提示词](START_FRONTEND_AGENT.md) → [原型](design/workbench-preview.html) → [主设计](FRONTEND_DESIGN.md) / [接线表](FRONTEND_API_CONTRACT.md)。F1 从真实查找/选择/源码关系开始，禁止把设计样例当作已接线数据。
