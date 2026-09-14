# Atlas 当前交接

更新：2026-09-14。用户决定先交付完整可用首版，再增强细节。当前执行 [任务书 D0→D4](DAILY_DEVELOPMENT_WORK_ORDER.md)，可直接转交 [首版交付提示词](START_DELIVERY_AGENT.md)。先复核 R1–R4，再完成理解/运行、修改审阅、项目与恢复、本机交付；不能在四个修复后结束整单。

F1–F5 已由执行者交付；首轮独立复验为 CHANGES_REQUIRED。查找、相邻函数真实点击与简单函数实际运行已复验通过；范围与反例见 [独立报告](../evidence/reviews/2026-09-14-frontend-initial/REPORT.md)。本次仅调整交付范围，没有新增实现或重新验证产品。下方设计及旧窗口信息保留为背景。

## 最新独立复验断点

首版交付复验为 CHANGES_REQUIRED，见 [报告](../evidence/reviews/2026-09-15-local-delivery/REPORT.md)。旧 R1–R4 的 9 项回归通过，复制包的查找与运行通过；从仓库外验证补丁失败 worker_missing，服务重启后选区/页签/草稿丢失。当前执行 [下一单](../evidence/reviews/2026-09-15-local-delivery/NEXT_AGENT_PROMPT.md)，补齐原 D2 测试配置及完整输入对照，再重新打包跑全程。下方执行者 DELIVERED 是其交付记录，不是独立验收通过；干净机器验证尚未进行。

## 新增前端设计交接

2026-09-13：新增 [前端主设计](FRONTEND_DESIGN.md)、[API 接线表](FRONTEND_API_CONTRACT.md)、[可点击原型](design/workbench-preview.html) 与 [直接开工提示词](START_FRONTEND_AGENT.md)。原型 19 项设计检查通过，含实际浏览器点击；不是产品验收。按 F1→F3 完成 T1，F4/F5 对应 T2/T3。设计检查见 [报告](../evidence/design/2026-09-13-workbench/REPORT.md)。

## 从哪里继续

唯一当前队列是 [执行任务书](DAILY_DEVELOPMENT_WORK_ORDER.md) 的 **D0→D4(首版本地交付)**。最新窗口 `2026-09-15/d0-d4-first-local-delivery` 已交付:D0 修复(R1–R4,probe 9/9)、D1/D2/D3 用户旅程(运行对照、可读 diff 与前后对照、应用/撤销字节验证、项目路径启动、重开恢复、2D/3D 往返)、D4 本机分发(`dist/atlas-local-darwin-x64/`,仓库外启动验证)。综合检查 verify.py PASS;状态 NEEDS_INDEPENDENT_REVIEW。报告:[2026-09-15 交付](../evidence/development/2026-09-15-d0-delivery/REPORT.md)。独立复审已发现交付阻断，当前下一步以上方“最新独立复验断点”为准。

## 已有实现的查找入口

以下帮助复用代码，不代表整项独立验收通过：

| 链路 | 从这里读 |
|---|---|
| 索引、Flow IR、求解、发布与查询 | `workers/typescript/src/`、`crates/atlas-engine/src/` |
| CLI、服务与 worker 生命周期 | `crates/atlas-app/src/main.rs`、`server.rs`、`worker.rs` |
| 2D 查找、选区、值、未知、运行、补丁面板 | `web/app.js`、`web/index.html`、`web/style.css` |
| 布局与共用层级 | `web/layout.js`、`web/hierarchy.js` |
| 3D 与选区往返 | `web/city3d.js`、`web/city3d.html` |
| 作业、增量、运行、补丁、桥接验证 | `scripts/test_jobs.py`、`test_incremental.py`、`test_execution.py`、`test_patch.py`、`test_bridge.py` |

优先核对运行画像是否易用、未知条目是否定位源码、查找和相邻函数是否真实可点击。不要先以算法百分比或 3D 外观优化替换完整任务。必要底层修复属于当前范围。

## 后续工作如何处理

T2/T3 按任务书继续；正式场景/Trace、更多语言、规模资格、分发和宿主集成保留在 [产品目标](USE-CASES.md) 与 [完整规格](specs/README.md)。此前“大仓库和 Modus 暂停”是当前排序，不是永久删除。环境是否可用以本次检查为准，不沿用“同级仓库不存在”等旧假设。

历史 W 编号、详细窗口、失败与独立复审保留在 progress 和 evidence。旧能力状态、测试数量、指纹与耗时只对当时源码有效；后续改动据实验证，不抄旧 PASS。开发完成状态与正式资格、独立验收分开。
