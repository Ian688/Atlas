# W09：图形化一键撤销（带显式写边界）

窗口：`2026-09-12/w09-http-writes`
日期：2026-09-12（Asia/Shanghai）
结论：**DELIVERED**。页面现在可以一键 apply/revert，但它能写的目录**只能由启动参数指定**，请求无法把它打开；而且写入路径与 CLI 是**同一段代码**。

## 1. 为什么这件事需要一个显式边界

之前的设计刻意让 apply/revert 只存在于本机 CLI，理由是"页面无法让你看见将要写入哪个目录"。这个理由仍然成立，所以这一轮没有简单地"把写端点打开"，而是：

- **默认关闭**：`atlas serve <analysis>` 时 `POST /api/patch/apply|revert` 一律 403 `http_writes_disabled`，detail 直接说"请在 CLI 上执行"；
- **只有一个目录**：`--allow-writes <DIR>` 由操作者在启动时给出，启动时 `canonicalize` 一次，之后所有比较都是两个绝对路径；
- **页面必须看见它**：契约里 `writes.root` 是页面唯一能写入的目录，按钮上写着它，请求必须逐字回显 `confirm_path`；
- **请求不能指定目录**：请求体里没有 target/root 字段，注入同名字段也不会被读（有用例锁住）。

## 2. 交付的行为

| 层 | 行为 |
|---|---|
| CLI | `atlas serve <analysis> [--port N] [--allow-writes <DIR>]`；不传则该服务没有任何写路径 |
| HTTP | `POST /api/patch/apply`、`POST /api/patch/revert`，body `{id, confirm_path}` |
| 拒绝 | 未启用 → 403 `http_writes_disabled`；`confirm_path` 与服务端目录不一致 → 400 `confirmation_mismatch`（带 `expected`），**不写任何文件**；revert 的提案记录目录不是本服务器目录 → 409 `revert_target_is_not_this_checkout`；检出目录在审查后移动 → 409（`target_changed_since_apply` / 新建路径被占 / 删除目标消失，按形式） |
| 记录 | `terminal_reason = applied_by:<actor>` / `reverted_by:<actor>`，HTTP 的 actor 是会话身份（`session-…`）——"已应用"而不说"谁、通过哪条路径"是不可审阅的 |
| 契约 | `writes: {enabled, root, how_to_enable, scope}`；两条新端点也登记在 `endpoints` 里 |
| 页面 | 契约允许时，已应用的提案出现「一键撤销」，已验证的出现「应用（写入 <root>）」；按钮禁用状态跟随状态机；失败时状态栏说"写入未发生"，并**重新拉取**提案列表（不乐观更新）。契约查询失败时按"没有写路径"处理 |

**同一段代码**：CLI 的 `patch apply|revert` 与 HTTP 的两个端点都调用 `patchwork::apply_proposal` / `revert_proposal`。这是这一轮最重要的结构决定：两套"检查字节再写"的实现必然漂移，而漂移的那一套正好是没人测的那一套。重构后 CLI 里那份重复的逐形式写入逻辑被删掉了（`pinned_digest` 也只留一份）。

## 3. 验证

| 套件 | 之前 | 现在 | 内容 |
|---|---|---|---|
| `scripts/test_patch.py` | 31 | **37** | 新增 `Http`：未启用时 403 + `--allow-writes` 提示 + 契约 `writes.enabled=false` + 端点已登记；新增 `HttpWrites`（以 `--allow-writes <project>` 启动）：一键 apply→revert 且字节恢复、actor 记录为 `applied_by:session-…`、`confirm_path` 不一致 → 400 且不写、**注入 `target`/`root`/`path` 字段不被读**（只写操作者目录）、检出目录移动 → 409 且保留新编辑、**新建文件的提案经 HTTP apply 后 revert 会删掉文件** |
| `web/tests/app.behavior.test.mjs` | 31 | **32** | 没有写契约时**不显示**按钮并说明原因；有写契约时显示按钮与目录、说明"页面不能指定目录"；点击 POST 的 `confirm_path` 等于契约里的 root |

门禁：`python3 scripts/verify.py --label w09-http-writes --out evidence/development/2026-09-12-w09-http-writes --keep-going`

- **22/22 检查 exit 0**；受控负对照 red；指纹配对一致 `a895df34b9638cca606655ba6bb503345900d9ad89adeec38cbb1eb4cb8939ca`；`sources_changed_during_run: 0`。
- `cargo clippy -D warnings` 通过（`write_gate` 的拒绝响应装箱，避免 `result_large_err`）。

## 4. 没有做的事（不得读成已实现）

- **`--allow-writes` 只覆盖一个目录、一个分析**：没有多目录、没有多租户、没有按提案区分权限。要放宽到多目录需要先设计"哪个提案允许写哪里"的规则。
- apply 仍然**没有备份、没有冲突合并、没有文件锁**：并发修改的窗口靠字节校验缩小，但没有消除。撤销只是把钉住字节写回，不是合并。
- 页面没有逐行 diff 审阅视图：现在显示的是表单、路径与截断的 diff 文本。
- 写路径没有速率限制与审计日志（记录里只有最后一次 actor；重复 apply/revert 会被状态机拒绝，但不留历史轨迹）。
- HTTP 写路径没有在真实浏览器里点过（行为测试在 `node:vm` + 最小 DOM 里跑真实 `web/app.js`）；`--allow-writes` 的端到端由 Python 驱动真实二进制与真实 HTTP 验证。

## 5. 复现

```bash
cargo build
python3 scripts/test_patch.py            # 37 tests（含 HttpWrites 5 条）
node web/tests/app.behavior.test.mjs     # 32 checks
atlas --store S serve $A --allow-writes /path/to/checkout
# 契约会给出 writes.root；页面按钮上显示同一个目录
python3 scripts/verify.py --label w09-http-writes \
  --out evidence/development/2026-09-12-w09-http-writes --keep-going
```
