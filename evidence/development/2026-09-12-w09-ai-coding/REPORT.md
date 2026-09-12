# W09 续：AI Coding 第一条完整链

窗口：2026-09-12/w09-ai-coding-chain。工作目录 `/Users/yinsijie/CodeRepo/Atlas`。

在 W09 首片（共享选区 + 有界桥接）之上，把工作单要求的 AI Coding 第一条链真正接通：
选函数标注约束 → 导出证据 → 提案 → **隔离应用** → **本地重新解析** → **测试** → **图差异** → 审阅/应用或撤销。
Intent、Static、Observed 三类证据分开存放，占位对象从不被呈现为已存在的代码。

## 一、交付

| 位置 | 内容 |
|---|---|
| `crates/atlas-engine/src/patch.rs`（新增） | 统一 diff 解析与应用、提案存储与单向状态迁移、隔离副本物化、字节校验写入；11 个 diff 单测 |
| `crates/atlas-app/src/patchwork.rs`（新增） | 图差异、声明的 argv 测试运行 |
| `crates/atlas-app/src/main.rs` | `atlas patch propose|verify|apply|revert|status|list` |
| `scripts/test_patch.py`（新增） | 16 个用例，全部拒绝路径都有断言；已加入 `verify.py` |

## 二、逐条对应工作单

| 工作单要求 | 本切片的实现 |
|---|---|
| 选函数标注新增约束 | `atlas annotate` / `--summary`（W09 首片）+ 提案绑定到 `entity_id` 与 `selection_id` |
| 导出最小证据 | 提案记录里只有固定分析 id、目标实体、diff 与校验结果；`patch status` 可查 |
| 提案占位 | `intent: true`、`code_exists: false`，记录里明确写"这是 Intent，还没有写进任何检出目录" |
| 生成 patch | 由外部模型产出统一 diff，Atlas 只接收；Atlas 从不自己编造改动 |
| 隔离应用 | 从内容寻址 blob 物化 `0700` 临时副本，补丁只写在副本里；测试断言用户检出目录零改动 |
| 本地重新解析 | 在副本上跑完整索引管线（scan → worker → analyze），派生出一个**新的 analysis** |
| 测试 | 声明的 **argv 数组**（不是 shell 字符串）在副本内运行，超时按进程组杀死，退出码与输出原样记录 |
| 图 diff | 节点按 `path+name` 配对，给出 added/removed/changed 与函数/文件/调用/未解析调用的前后计数 |
| 审阅/应用或撤销 | `apply` 前校验目标当前字节仍等于固定快照 blob；`revert` 校验当前字节等于 apply 写入的字节 |
| Intent/Static/Observed 分清 | proposal = Intent；`graph_diff` + 派生 analysis = Static；`test` = Observed，各自字段标注，互不冒充 |

## 三、为什么 diff 应用是严格的

**位置不符就拒绝，并带着不一致的那一行。** 不做模糊搜索：模糊应用会把改动悄悄挪到另一个长得像的函数里，而"固定版本"的全部意义就是"讨论的就是这些字节"。拒绝信息包含期望行、实际行、行号与原因：

```
patch_does_not_apply:src/math.js:{"path":"src/math.js","hunk":0,"line":2,
  "expected":"export function subtract(left, right) { return left * right; }",
  "found":"export function subtract(left, right) { return left - right; }",
  "detail":"上下文不匹配：固定快照的字节与提案假设的不同。…"}
```

其它硬边界：CRLF 目标拒绝而不是规范化行尾（规范化会在审查之外改写整个文件）；创建/删除文件不在本切片内（`/dev/null` 头直接拒绝）；未知行标记拒绝而不是猜测；`hunk` 超出文件范围拒绝；目标文件不在快照里拒绝。以上每一条都有单测。

## 四、图差异为什么按 path+name 配对

节点 id 绑定源码字节区间（`symbol:path:start:end`），**编辑一个函数就会改变它的 id**。按 id 比较会把每一次编辑读成"一次删除 + 一次新增"，审阅者会以为函数被删掉了。所以差异按 `kind|path|name` 配对，把编辑报告成 `changed`，同时把前后 id 都原样给出。

实测（计算器样本，给 `add` 加一个 `+ 0`）：

```
nodes  added 0  removed 0  changed 5
  changed src/math.js math.js  span 0 -> 0
  changed src/math.js add      0 -> 0
  changed src/math.js divide 121 -> 125      ← 后面的函数区间整体平移
counts functions 10 -> 10 | files 7 -> 7 | calls 28 -> 28 | unresolved 15 -> 15
```

## 五、apply/revert 的字节纪律

- `apply` 逐文件读取目标当前字节，要求其 sha256 仍等于提案所依据的固定快照 blob；不符即 `target_changed_since_apply` 并拒绝。覆盖审查之后发生的改动是**损失**，不是合并。
- `revert` 要求当前字节等于 apply 写入的字节；在别人更新的版本上回滚会删掉那份更新，因此拒绝。
- 写入是"临时文件 + 改名"，所以不会留下半个文件。
- 状态机单向：`proposed → verified → applied → reverted`，每一步都要求前一状态；对 rejected 提案 verify 会被拒绝，对未验证提案 apply 会被拒绝，重复 apply 会被拒绝（目标已不是基线）。

## 六、资格边界

- **没有 Web 审阅界面**：审阅目前是 CLI（`patch status` / `patch list`）。图形化的 diff 与图差异审阅、一键撤销未实现。
- **verify 还没有进持久作业队列**：它是前台 CLI，一次完整索引管线；长项目上会占用终端。
- 提案形式只支持统一 diff：新建/删除/重命名文件不支持。
- `patch verify` 会在同一 store 里多发布一个 analysis（补丁树），长期累积且无回收策略。
- `apply` 直接写用户检出目录：有字节漂移校验与原子改名，但**没有备份、没有冲突合并、没有文件锁**，并发修改的窗口仍然存在。
- 测试命令是任意 argv：隔离副本 + 清空环境 + 进程组超时是真边界，但它不是沙箱（不同于 W08 里 Node 权限模型对受控调用的强制）。

## 七、验证

```
python3 scripts/verify.py --label w09-ai-coding \
  --out evidence/development/2026-09-12-w09-ai-coding --keep-going   退出码 0
  20/20 检查退出码 0（新增 patch）
  negative-control 受控失败 ✓   fingerprint pairing: binary == source ✓
  status PASS · document_errors [] · sources_changed 0 · binary_stale false
```

| 命令 | 退出码 | 结果 |
|---|---|---|
| `cargo test --workspace --locked` | 0 | 99 → 110 |
| `npm test --prefix workers/typescript` | 0 | 25 |
| `python3 scripts/test_patch.py` | 0 | 16/16（全部拒绝路径） |
| `python3 scripts/test_bridge.py` | 0 | 20/20 |
| `python3 scripts/test_execution.py` | 0 | 27/27 |
| `node web/tests/app.behavior.test.mjs` | 0 | 20 |
| `node web/tests/city3d.behavior.test.mjs` | 0 | 14 |

资格范围：只覆盖上列检查，不构成完整 AL/ET/GE/MT/HI/DV 或成熟 Atlas 验收。
