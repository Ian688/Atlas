# W09：共享选区、Intent 与有界 Agent Bridge（首片）

窗口：2026-09-12/w09-selection-and-bridge。工作目录 `/Users/yinsijie/CodeRepo/Atlas`。

W09 从 `NOT_IMPLEMENTED` 推进到 `PARTIAL`：共享选区对象、跨版本拒绝、2D/3D 选区互通、语义 DOM 与桥接面、Intent 注解、带幂等身份与租约 ACK 的有界 Agent Bridge 全部接通并纳入验证门。**AI Coding 的补丁链（隔离应用 → 重新解析 → 测试 → 图 diff → 审阅/撤销）没有实现**，本切片只有提案占位与拒绝，没有任何写源码的路径。

## 一、交付

| 位置 | 内容 |
|---|---|
| `crates/atlas-engine/src/bridge.rs`（新增） | 选区对象与版本检查、注解、Agent 请求队列（身份/租约/ACK/终态）；6 个单测 |
| `crates/atlas-app/src/agent.rs`（新增） | 三个有界动作的实现 |
| `crates/atlas-app/src/main.rs` | `select` / `annotate` / `annotations` 与 `agent request|work|claim|complete|status|list|reap` |
| `crates/atlas-app/src/server.rs` | `/api/selection`、`/api/annotation`、`/api/annotations`、`/api/agent/{request,requests,work}` |
| `scripts/test_bridge.py`（新增） | 20 个用例（CLI 15 + HTTP 5），已加入 `verify.py` |
| `web/app.js`、`web/index.html` | 选区发布与 3D 链接、Intent 面板、`globalThis.atlasBridge` |
| `web/city3d.js`、`web/city3d.html` | 读取同一选区、纯函数化的选择决策与拒绝、桥接面 |

## 二、选区带版本，而且会被拒绝

选区是 `{id, analysis_id, entity_id, entity_kind, version}`，其中 `version` 就是 analysis id。analysis id 是整份 Analysis 内容的摘要，所以"版本相同"是可判定的**等式**，不是时间戳猜测。

2D 与 `/city3d` 通过 URL fragment 交换选区（fragment 不进入 HTTP 请求，也不进服务日志）。投影如果正在服务另一个版本，会拒绝：

```
citySelectionTarget({entity_id, analysis: "OLD"}, "NEW", nodes, layout)
  → { ok:false, code:"stale_selection_version", selection_analysis:"OLD", served_analysis:"NEW" }
```

**为什么不是"尽量高亮"**：把旧名字静默改指到当前版本的某个对象，在有人据以行动之前，与一个正确答案是无法区分的。所以在 2D 里跨版本 fragment 不会被自动选中并给出说明，在 3D 里不会高亮任何列——`citySelectionTarget` 是一个纯函数，每一种拒绝都有测试。

同一个投影内，选区也只在实体真实存在时才成立：`resolve_entity` 解析不到就报错。之前 `select` 有一个 `unwrap_or(entity)` 的静默兜底，会为不存在的对象造出一个选区 id——这正是"空结果看起来像事实"的形状，已改掉并加了测试。

## 三、Intent 不是事实，提案不是代码

`atlas annotate` / `/api/annotation` 把约束、场景、补丁登记为注解：

- `exists` 恒为 `false`，`proposed_by` 必填（human/agent/调用者名），`kind` 限 `intent/constraint/scenario/patch`。
- id 是内容的摘要：同一条 Intent 提两次是一行；不同作者是不同提案；后来者不能就地改写别人的提案。
- UI 明确写"提案（尚未存在）"；`propose_patch` 的动作结果额外带 `applied:false` 与 `没有应用…` 说明。
- 测试断言：提交补丁提案后，源文件字节不变，已发布 analysis id 不变。

## 四、有界 Agent Bridge

请求身份 = `(owner, request_key)`，与 W06 作业同一套幂等纪律：同一个人问同一个问题是一行，不同 owner 是不同请求。

| 机制 | 行为 |
|---|---|
| 入队校验 | 动作必须属于封闭集合 `inspect` / `annotate` / `propose_patch`；不在集合内或 analysis 不存在 → 直接以 `rejected` 落库并记 `terminal_reason`，因此非法动作是**持久可见的拒绝**，不是静默忽略 |
| 认领即 ACK | 认领写 `ack_at` 与租约；被认领的请求不可再被认领 |
| 租约过期 | 收割把请求**放回队列**（不是判失败）并递增 `attempt`：桥接动作便宜且幂等，丢掉别人正在等的请求没有道理 |
| 终态 | 只有当前租约持有者能写 `done`/`failed`；旁观者与陈旧持有者都被拒绝 |

HTTP 侧刻意更窄：`analysis_id` **不在请求类型里**，所以页面无法把工作钉到本服务没有在服务的版本上（测试发送该字段并断言被忽略）。`/api/agent/work` 最多处理 32 个动作，且能做的仍只有那三个有界动作。

## 五、网页与语义接口

- 2D 选中即发布 `data-selection-entity` / `data-analysis-id`，并把 `/city3d#selection=…&analysis=…` 链接指向同一选区。
- 两个投影都暴露 `globalThis.atlasBridge`，并**声明** `bounded_actions`；测试断言这个列表里没有写码类动作（`write`/`apply`/`patch`/`exec`/`delete`/`index` 都不出现），且选择未加载实体时明确失败。
- 3D 的 `atlasBridge` 只有 `getSelection` / `highlight` / `openProjection`——城市不能写任何东西，也不假装能。

## 六、资格边界（本窗口未证明的）

- **AI Coding 完整链未实现**。没有隔离应用补丁、重新解析、运行测试、图 diff、审阅/应用/撤销。补丁提案止于占位。
- 选区只在同一 analysis 内互通；跨版本是**拒绝**而不是**重定位**。重定位需要实体级重命名/移动追踪，未做。
- 投影状态不持久：选区只在 fragment 与内存里，刷新依赖 URL；没有被同一 analysis 之外的会话存储。
- 没有 LOD 与"激活路径来自 Run"的图例分离——因为还没有 Run 轨迹（W08 只观测入口调用）。
- Agent Bridge 的 `owner` 是未经认证的调用者声明，与 W06 同一缺口：服务端验证身份未实现。
- `inspect` 直接展开已发布上下文，没有按请求方做最小披露裁剪；请求预算与配额未实现。
- 3D 侧的 WebGL 渲染路径仍然只在无 GPU 的映射层被测试（与既有 city3d 测试范围一致）。

## 七、验证

```
python3 scripts/verify.py --label w09-selection-and-bridge \
  --out evidence/development/2026-09-12-w09 --keep-going    退出码 0
  19/19 检查退出码 0（新增 bridge）
  negative-control 受控失败 ✓   fingerprint pairing: binary == source ✓
  status PASS · document_errors [] · sources_changed 0 · binary_stale false
```

| 命令 | 退出码 | 结果 |
|---|---|---|
| `cargo fmt --all --check` | 0 | — |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | 0 | — |
| `cargo test --workspace --locked` | 0 | 93 → 99 |
| `npm test --prefix workers/typescript` | 0 | 25 |
| `python3 scripts/test_bridge.py` | 0 | 20/20 |
| `python3 scripts/test_execution.py` | 0 | 27/27 |
| `python3 scripts/test_integration.py` | 0 | 含 HTTP 执行边界 |
| `node web/tests/app.behavior.test.mjs` | 0 | 15 → 20 |
| `node web/tests/city3d.behavior.test.mjs` | 0 | 11 → 14 |

资格范围：只覆盖上列检查，不构成完整 AL/ET/GE/MT/HI/DV 或成熟 Atlas 验收。
