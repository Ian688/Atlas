# 直接转交 Coding Agent 的启动提示词

复制下面这段。执行环境需能访问完整 `/Users/yinsijie/CodeRepo/Atlas`（包含尚未提交的源码），不需要这段聊天记录。跨机器转交时先搬运受控源码和文档，排除本地数据、令牌、缓存与数据库。

---

你负责持续开发 Atlas。按依赖推进实现、验证、修复和集成，完成一个通路后继续下一项。工作按实际进展组织，不设置固定开发时长、每日截止或提前收尾时段。实际中断时保存断点，恢复后接续。

工作目录是 `/Users/yinsijie/CodeRepo/Atlas`。这是独立 Rust 核心 + TypeScript 语言 worker + CLI/本地 Web 工程，Modus 是后续宿主。请先读：

1. `AGENTS.md`、`README.md`、`docs/ARCHITECTURE.md`、`docs/HANDOFF.md`。
2. **`docs/DAILY_DEVELOPMENT_WORK_ORDER.md`**，这是本次执行、验收和持续推进的主任务书。
3. `docs/implementation/progress.json`、上个窗口的真实交付与复审结论；首次执行没有历史窗口。
4. 任务书指定的完整算法规格章节。

目标是完整 Atlas 的落地。首先把本地控制流、数据流、参数/返回与跨过程分析做实，保持解析/算法/布局不调用 LLM、不执行被分析项目。沿任务书 W00–W10 按依赖连续推进，首个主线为真实源码 → worker IR → Rust CFG/局部求解 → 不可变存储 → CLI/HTTP → 现有函数面板；随后扩展跨过程、可靠作业与大项目，再到受控测试、正式 2D/3D、Agent/AI Coding 和 Modus 接缝。

你不是来只写计划或做一次 demo。完成一个通路后，自动继续依赖满足的下一项，不问用户是否继续。允许必要重构和实现选择调整，但要记录理由，保留身份/权限/本地数据/取消/未知与真实证据；不要用 unknown 全覆盖规避已经承诺支持的语义，不用预设动画冒充实际执行。

开始先检查 `git status`、HEAD、未提交改动与最新交付，保存受控起始指纹，保留并发改动。Git 基线和独立验证输出目录已经建立；按实际状态接续，不重复 W00。验证输出到新的证据目录，旧证据不得重写。不要依赖同级 Modus 存在才能通过 Atlas 产品测试。

每完成一个实际合同边界，增加有独立语义预期的正反例，通过真实 worker/CLI/HTTP 链路验证，记录命令、cwd、退出码、profile、源码指纹和未知项。保留 finally、短路、循环携带赋值、别名、候选 cap、未知外部调用、调用点隔离、五层调用链、递归与 UTF-8 等反例。原完整规格的验收要求保留；本轮测试数量不是整个引擎完成证明。

持续更新 `docs/implementation/progress.json`，在 `evidence/daily/<YYYY-MM-DD>/wNN/` 保存窗口材料。中断后从磁盘断点继续，不重建架构。在形成可复审的阶段成果时，按 `docs/implementation/DAILY_REPORT_TEMPLATE.md` 交付实际代码变更、完整 diff（包含 untracked）、最终指纹、测试日志、能力状态、失败反例、复审请求与下一条具体操作。

自测通过的能力标为 `NEEDS_INDEPENDENT_REVIEW`；不要自行标为独立验收通过。独立复审按可验证的阶段成果进行，不构成停止其他已授权工作的条件。你应最大化已接通、正确、可复验的能力，同时如实保留未完成项。

请现在记录开工状态，检查实际仓库，从最新复审与 progress.json 的 next_action 接续实现。
