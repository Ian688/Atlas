# 完整产品规格快照

此目录的六份原文来自 Modus 已更新的 Atlas 规格，来源和 SHA-256 在 [import-manifest.json](import-manifest.json)。导入时不改原文，不改变旧证据 hash。

| 原文 | 范围 |
|---|---|
| [主设计](code-atlas-development-design-2026-09-07.md) | 完整产品与职责、分层、长期范围 |
| [长期任务书](code-atlas-coding-agent-work-order-2026-09-07.md) | 33 包及原有持续实施规则 |
| [本地算法](code-atlas-local-engine-algorithm-spec-2026-09-07.md) | AL/ET/GE、本地解析、流分析、执行画像 |
| [成熟场景](code-atlas-maturity-and-scenario-spec-2026-09-07.md) | 函数/场景测试、AI Coding 与成熟资格 |
| [独立集成](code-atlas-standalone-integration-spec-2026-09-08.md) | 服务、Agent、选区与回执 |
| [双视图](code-atlas-dual-view-design-2026-09-08.md) | 正式 2D/3D 与共享语义 |

这些文件是**需求快照**，保留部分原仓库相对路径与旧实施引用，不能机械当作本仓库路径。原文中的旧 Rust/Node 链保留、旧 Modus 文件改造顺序等实施假设，受用户本轮独立重建授权及 [当前架构](../ARCHITECTURE.md)、[任务书](../HANDOFF.md) 更新。完整产品目标与正确性验收没有因此取消。

后续修订应在本独立仓库维护新版本与迁移说明，Modus 文档只维护宿主接缝。不能在两个仓库独立修改同一份“当前权威”规格而不声明主从关系。当前六份原文保留为 v2026-09-08 输入基线；本仓库当前实现权威为 README + ARCHITECTURE + HANDOFF，完整目标改动需同步明确到本目录版本化规格。
