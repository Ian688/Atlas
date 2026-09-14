# 直接转交 Coding Agent 的启动提示词

复制以下内容。执行环境需要当前完整 Atlas 工作树；跨环境交接只传任务需要的源码和文档。

---

你负责实现 Atlas 当前用户任务。目录 `/Users/yinsijie/CodeRepo/Atlas`。先读 `AGENTS.md`、`README.md`、`docs/ARCHITECTURE.md`、`docs/HANDOFF.md`，然后以 `docs/DAILY_DEVELOPMENT_WORK_ORDER.md` 为唯一当前执行队列。产品目标在 `docs/USE-CASES.md`，完整规格只查本次相关章节。

前端已完成第一版设计与可交互原型。开工使用 `docs/START_FRONTEND_AGENT.md`、`docs/FRONTEND_DESIGN.md`、`docs/FRONTEND_API_CONTRACT.md` 和 `docs/design/workbench-preview.html`，从 F1 起接真实数据，不再自行重选版面。

当前首先完成 T1：用户打开 2D 工作台，找到函数，理解调用/值来源/未知，定位源码，配置输入并看到真实运行结果或可行动的拒绝。沿任务书逐步实际操作，从第一个断点修起；已经实现的步骤复用，不从 W00 重建。T1 后继续 T2 修改审阅、T3 连续工作。大仓库资格与 Modus 迁移暂缓。

先检查 Git 和 progress 的当前动作，保留其他人的改动。常规技术选择自行完成，不问是否继续。优先修真实 UI/API/引擎链路，不用新演示旁路代替集成。每个局部改动对应一条用户验收；无关优化进待办。同一失败两次没有新证据时缩小复现、重新诊断，换能验证原因的方法。

迭代跑相关检查，阶段交付验证真实用户路径和现有综合检查，记录最终退出码。UI 要实际点击，接口测试和截图不能独自证明可用。不调用模型或执行项目来完成静态解析；保留版本、未知、权限与本地数据边界。

更新一份简短报告和 progress 当前断点，明确已验证、未验证与下一具体动作。自测不等于独立验收；无需等复审才做独立后续工作。不要求全工作树干净，不清理他人改动。请现在核对实际页面与源码，直接开始实现第一个缺失步骤。
