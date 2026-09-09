# ADR 0001：独立仓库与渐进替换

日期：2026-09-08；状态：已采用并开始实施。

用户明确授权重建 Atlas 架构与示例实现，并接受必要的破坏式改写。工程选择为 `/Users/yinsijie/CodeRepo/Atlas`，与 `/Users/yinsijie/CodeRepo/Modus` 同级，自己的 Git 分支 `codex/standalone-foundation`，不设远程、不提交、不发布。

这样做是为了独立发布、依赖与测试、被其他 Agent 使用和更清晰的产品责任。独立不是必须使用同级路径才能成立；可在 monorepo 中实现，但本项目现在选择独立仓库更便于落实所有权。

原 Modus 内代码不决定新实现形状，也不在此轮批量删除。允许破坏式改写不意味着必须先销毁可比较的历史。新的链路完成资格与 Modus adapter 验证后，再由单独迁移任务切换宿主入口、处理旧数据格式并删除退役实现。

当前不评价另一 Agent 的能力，代码是否保留取决于独立可复验的正确性。原审查反例转成新基础的边界测试，而不复用旧“完成”台账作为新证据。

迁移次序：独立可运行 → 正式作业/权限/版本接口 → Modus 适配独立服务 → E2E 对照 → 用户认可切换 → 旧实现退役。宿主适配不得直接读取 Atlas SQLite；Atlas 不读取 Modus 会话数据库。

本轮开始时记录的 Modus 旧产品文件指纹位于 `../evidence/foundation/modus-before.json`（相对于本 docs 文件夹）。结束检查记录于同目录的 `verification.json`；其他 Agent 并发改动若存在应列为外部漂移，不能覆盖回去。
