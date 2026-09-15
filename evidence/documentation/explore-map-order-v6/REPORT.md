# 最新探索页设计的开发交接

用户要求为另一个开发 Agent 提供详细提示词，确保按最新设计实现。

已编写 docs/design/atlas-explore-next/DEVELOPMENT_PROMPT.md：页面区域、递归节点、多区多标签、三来源解释/解析记录、类型菜单、批注交接与 Review、M1–M6 顺序、模型外部配置处理、已知回归防线、16段真实用户验收路线及最终包报告要求。

已将唯一执行任务书升级为 v6，四个 Agent 启动入口、FRONTEND_DESIGN、HANDOFF 和 progress 统一指向同一提示词，避免继续机械执行旧 v5。原入口文档保存在本目录，历史实现与独立验收证据未改写。

核对：8个入口文档本地链接均可解析；progress JSON有效且版本为6.0；git diff --check exit0。本轮只改开发文档与指针，没有改产品、原型功能或分发包，没有新增产品验收资格。
