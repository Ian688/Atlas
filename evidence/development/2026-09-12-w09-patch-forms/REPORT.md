# W09：补丁的三种形式（修改 / 新建 / 删除）

窗口：`2026-09-12/w09-patch-forms`
日期：2026-09-12（Asia/Shanghai）
结论：**DELIVERED**。AI Coding 链不再只会改现有文件：新建与删除现在是**一等形式**，而且"删除"不被当成"编辑成空文件"——两者的 revert 语义不同，系统里也分开存。

## 1. 之前是什么样

统一 diff 只支持修改。`--- /dev/null` / `+++ /dev/null` 被**具名拒绝**（`diff_creates_or_deletes_a_file_which_this_slice_refuses`）——诚实地承认没做，但"AI 加一个文件"是最常见的改动之一，缺了它这条链是不完整的。另外两个当时也没被检查的洞：

- 两侧表头不一致（`--- a/one.js` / `+++ b/two.js`）会**静默按 `+++` 应用**；
- git 的 `rename from/到` 行被当作"文件级元数据忽略"，于是重命名+编辑的 diff 会以令人困惑的方式失败。

## 2. 现在是什么样

### 2.1 形式由表头声明、由 hunks 复核

`PatchForm = modify | create | delete`：

| 表头 | 形式 | 复核（不满足即具名拒绝） |
|---|---|---|
| `--- /dev/null` | `create` | 所有行必须是 `+`（`create_patch_has_non_added_lines`）、`old_start/old_len` 必须为 0、内容非空 |
| `+++ /dev/null` | `delete` | 所有行必须是 `-`（`delete_patch_has_context_or_added_lines`）、`new_start/new_len` 必须为 0 |
| 两侧都有 | `modify` | 现有语义不变 |
| 两侧都是 `/dev/null` | — | `diff_has_no_path` |
| 两侧不一致 | — | `diff_headers_disagree:<old>:<new>`（过去是静默取 `+++`） |
| `rename from/到`、`copy from/到` | — | `rename_not_expressible_in_unified_diff` |

形式**不是从 hunk 形状反推**的：如果是反推，一次"把文件编辑成空"就会被读成删除，而这两个改动的回滚方式完全不同。

### 2.2 删除 ≠ 编辑成空文件

`PatchOutcome` 把三者分开：

```rust
pub struct PatchOutcome {
    pub files: BTreeMap<String, Vec<u8>>,     // 修改/新建后的内容
    pub deleted: BTreeSet<String>,            // 被移除的路径
    pub report: Vec<AppliedPatch>,            // 每个文件：form / hunks / patched_digest / removed_digest / 行数
}
```

一致性检查：新建必须指向快照里**没有**的路径（`create_target_already_exists`），删除必须指向**有**的路径（`delete_target_not_in_snapshot`），一条 diff 两次碰到同一路径直接拒绝（`diff_touches_a_path_twice`，否则先后顺序会决定结果）。

### 2.3 apply / revert 按形式各查各的

| 形式 | apply 的前置检查 | 动作 | revert 的前置检查 | 动作 |
|---|---|---|---|---|
| modify | 磁盘字节 == 钉住 blob | 原子替换 | 磁盘字节 == apply 写下的字节 | 写回钉住字节 |
| create | **目标不存在** | 建文件 | 磁盘字节 == apply 写下的字节 | **删掉文件** |
| delete | 磁盘字节 == 钉住 blob | 删文件 | **目标仍不存在** | 按钉住字节恢复 |

- 新建的漂移检查就是"那里什么都没有"：审查之后出现的文件是别人的工作，覆盖它和覆盖一次修改是同一种损失（`create_target_already_exists`）。
- 撤销删除时若目标又被别人创建了，拒绝（`target_recreated_since_delete`）。
- 隔离验证副本也按 outcome 组装：新建的文件写进去（虽然快照里没有）、删除的文件不写进去，并且拒绝"声明为新建却已在快照里"这类自相矛盾（`created_path_already_in_snapshot`）。

### 2.4 新建的提案可以命名一个还不存在的实体

`patch propose` 过去先解析实体，所以 `src/new.js` 会以"实体不存在"失败。现在 `patchwork::resolve_proposal_entity` 只在**这条 diff 真的新建了正好那个路径**时才接受未解析的引用（否则原样报"解析不到"），提案写成 `entity_id = "file:src/new.js"` 并标注 `target_exists: false`——与注解的 `exists: false` 是同一条纪律："这是意图，不是已存在的代码"。HTTP 的 `POST /api/patch/propose` 走同一个解析器。

### 2.5 页面读懂形式

提案面板不再只显示"校验通过：N 个 hunk · 路径"，而是显示 **`新建 src/new.js` / `删除 src/old.js` / `修改 …`**，并对新建/删除各说明 apply 与 revert 分别会做什么；删除路径单独列出。页面仍然**不能** apply/revert——它现在能说清"这两个动作分别意味着什么"，但真正的写入仍只在本机 CLI。

## 3. 验证

| 套件 | 之前 | 现在 | 新增内容 |
|---|---|---|---|
| `crates/atlas-engine` 单测（patch） | 8 | **11** | create 安装且只安装 `+` 行、对已存在路径拒绝、带上下文行自相矛盾被拒；delete 走 `deleted` 而非空内容、对不存在路径拒绝、留下行的 hunk 不是删除；表头不一致、同路径两次、git rename 各自具名拒绝 |
| `scripts/test_patch.py` | 25 | **31** | 新建提案 → `target_exists=false`、`forms=[create]`、提案不写文件；verify → apply 建出精确字节 → revert **删掉**该文件；apply 时路径已被别人创建 → 拒绝且保留那人的字节；删除提案 → `patched_paths=[]`、`deleted_paths=[src/math.js]` → apply 删文件 → revert **逐字节**恢复钉住内容；删除目标已消失 → 拒绝；rename → 具名拒绝；对已存在路径的"新建" → `create_target_already_exists` |
| `web/tests/app.behavior.test.mjs` | 30 | **31** | 页面显示"新建/删除 + 路径"与各自的 apply/revert 语义、`target_exists=false`、删除路径 |

门禁：`python3 scripts/verify.py --label w09-patch-forms --out evidence/development/2026-09-12-w09-patch-forms --keep-going`

- **22/22 检查 exit 0**；受控负对照 red；指纹配对一致 `9f68e91be39e39101e12e3660ed8828373f3a7f91b270464b825e650334fb1fe`；`sources_changed_during_run: 0`。

## 4. 没有做的事（不得读成已实现）

- **图形化一键撤销仍未实现**：页面知道形式与语义，但 apply/revert 只在本机 CLI。要让页面写文件，需要一个新的显式开关 + 目标路径回显确认 + 授权与记录设计，必须单独做（下一项）。
- 重命名**拒绝**而不是建模：把重命名写成删除+新建会丢掉两个路径之间的身份联系；改名且内容也变的文件在 `relocate` 里同样是如实拒绝。
- apply 仍然没有备份、没有冲突合并、没有文件锁：并发修改的窗口仍然存在（只靠字节校验缩小）。
- 只支持单个快照内的路径；不做目录级操作、不做符号链接、不做文件权限位（只写内容）。
- 二进制/非 UTF-8 目标仍然拒绝（`patch_target_not_utf8`），新建的内容也必须是文本。

## 5. 复现

```bash
cargo test -p atlas-engine patch
python3 scripts/test_patch.py          # 31 tests
node web/tests/app.behavior.test.mjs   # 31 checks
python3 scripts/verify.py --label w09-patch-forms \
  --out evidence/development/2026-09-12-w09-patch-forms --keep-going
```

手工最小复现：

```bash
printf -- '--- /dev/null\n+++ b/src/new.js\n@@ -0,0 +1,1 @@\n+export const X = 1;\n' > create.patch
atlas --store S patch propose $A src/new.js --diff create.patch   # target_exists=false
atlas --store S patch verify  <id> --test-argv '["node","--check","src/new.js"]'
atlas --store S patch apply   <id> --target CHECKOUT              # 建文件
atlas --store S patch revert  <id>                                # 删掉它
```
