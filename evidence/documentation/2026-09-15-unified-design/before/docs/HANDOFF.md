# Atlas 当前交接

**最新产品决定（2026-09-15）**：按 [产品设计](PRODUCT_DESIGN.md) 将地图、影响分析、场景验证、Agent 修改与审阅串成任务；A 阶段继续当前 M1–M6，完成后优先 B 的可重复场景与修改验收。C/D 的轨迹、调试等是后续设计，不能计入当前能力。

**最新执行任务：按项目地图与多展示区设计开发探索页。** 用户已要求为实现 Agent 整理详细提示词；执行[任务书 v6 的 M1→M6](DAILY_DEVELOPMENT_WORK_ORDER.md)，详见[开发提示词](design/atlas-explore-next/DEVELOPMENT_PROMPT.md)。[可点击设计](design/atlas-explore-next/README.md)的原型检查 13/13 通过；当前源码已有 web/explore.js、tree/knowledge 等实现入口，尚未完成本轮独立验收，先核对最新交付再补缺。已有 R1–R4 验收与其他页面能力保留。


**当前主线：把完整 UI 与用户操作做出来，后端按页面需要提供支持。** 用户已明确调整优先级，旧复审问题不再单独主导开发。

既有六页界面见[设计包 v2](design/atlas-v2/README.md)，只作为已实现页面的背景参考。**当前状态：R1–R4 整改已独立复验通过。** [最新复验](../evidence/reviews/2026-09-15-ui-v2-r1-r4-rereview/REPORT.md)：最终包从仓库外启动，双项目同名函数、beta 应用/新版本/撤销、alpha 字节不变、草稿隔离、外版本任务拒绝、各项目设置与写授权重启恢复，16/16 通过；网页行为 78/78 通过，源码与包内构建指纹一致（2029ab35…）。[实现方整改报告](../evidence/development/2026-09-15-ui-v2-fix-r1-r4/REPORT.md)保留自测记录。真实外部 Agent 任务、3D 成员往返的剩余核对纳入当前 M4/M6；这些资格及平台范围不因 R1–R4 通过自动升级。

产品定位：面向开发者与 Codex 等编程 Agent，理解代码、验证行为、审阅修改；不限定项目语言，JS/TS 是当前已实现语言链。保留2D/3D共同定位；不假设Atlas内置模型或能直接指挥任意外部Agent。

## 已有真实能力

现有 Rust/worker/浏览器已接通：查询、关系与源码、函数运行（后台执行+服务端取消+任务清单，任务按所属分析标注）、补丁验证与测试（按项目声明的 argv 真实生效，入队作业保留自身快照）、同输入对照、授权应用/撤销（写授权跟随当前项目：页内「以可写方式打开」建立，服务端拒绝错项目写入）、应用后重新索引并切换新版本（重索引当前项目）、页面内打开/切换项目（最近项目含可写标记、状态隔离、有界可取消的索引作业、草稿按 项目|版本|对象 隔离）、3D 选区与文件成员往返。不要从头重建。入口见[架构](ARCHITECTURE.md)，公开接口核对 server.rs / GET contract（exec/runs、project/open(+cancel,allow_writes)、project/reindex、project/settings、projects；writes.capable/root 语义见 contract）。

共享工作树包含其他Agent尚未提交的修改，保留。本轮新交付报告与 progress 指针见上；历史证据未改写。
