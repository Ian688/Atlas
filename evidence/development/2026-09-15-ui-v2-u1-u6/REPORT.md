# Atlas UI v2：U1→U6 完整界面交付（自测报告）

结论：**自测通过，待独立复审。** 上一轮评审（[2026-09-15-ui-v2-current](../../reviews/2026-09-15-ui-v2-current/REPORT.md)）的 2 个 P1 与 3 个 P2 已逐项落实；六个页面在本轮从最终分发包、仓库外、真实 Chrome 完整走通（30/30 项），历史 D0–D4 未重做、也不作为本轮完成证明。

时间与身份：2026-09-15；源码指纹 = debug 二进制指纹 = **最终分发包**二进制指纹 `02378fedc716441eb8d3ae385485a72d723268d207305780f19c0d1fd8c3d297`（`verify-final` 的 fingerprint pairing PASS + 对 `dist/atlas-local-darwin-x64/atlas` 单独实测）。最终包：`dist/atlas-local-darwin-x64/`（35M，`./start.sh <项目目录>`）。

## 逐项落实（对照上一轮评审表）

| 评审项 | 本轮交付 | 实测位置 |
|---|---|---|
| P1 后台任务入口只进项目首页 | 服务端新增 `GET /api/exec/runs`（句柄带目标对象/状态/终态）；左导航「后台任务」弹层列出真实任务，运行中可取消、已完成可「查看结果」跳回运行页同一对象，导航徽标显示在途数 | 旅程 `U2 后台任务`，截图 [j03](journey/j03-background-tasks.png)/[j04](journey/j04-task-cancelled.png) |
| P1 项目页无打开/切换/设置 | 服务端新增项目编排：`POST /api/project/open`（按目录索引并真实切换，作业可轮询/取消；按 analysis 直接切换）、`GET /api/projects`（最近项目，服务启动的项目也登记）、`GET/PUT /api/project/settings`（声明的测试命令/超时，保存即对之后的验证生效并随 store 保留）。项目页有打开输入框、最近列表、设置表单 | 旅程 `U4` 全部 3 项，截图 [j05](journey/j05-settings.png)/[j06](journey/j06-project-beta.png)/[j07](journey/j07-project-alpha.png) |
| P2 运行页信息层级 | R1 横幅显示签名/文件/固定版本；R4 结果区改为「终态结果卡（大字返回值/异常/拒绝/取消）+ 结果/本次输入/输出日志三页签 + 执行依据与边界（收起）」；画像长文收进「画像依据」；历史、比较、取消各归其位 | 旅程 `U2` 前 3 项，截图 [j02](journey/j02-run-baseline.png) |
| P2 修改页旧面板堆放 | 三栏 C2–C5：提案列表（可选中、显示状态与校验失败原因）→ 集中差异（多文件页签、行级 diff、完整 diff、静态影响）→ 验证证据（验证按钮、真实测试输出、同输入对照、检查并应用/一键撤销）；应用/撤销先过确认层（真实目录、文件集合、测试状态）；应用后「打开新版本」重索引并切换服务，撤销入口在版本切换后经 `GET /api/patches?target=here` 仍可达 | 旅程 `U3` 全部 5 项，截图 [j09](journey/j09-review-located.png)/[j10](journey/j10-verified.png)/[j11](journey/j11-compare.png)/[j12](journey/j12-apply-confirm.png)/[j13](journey/j13-new-version.png)/[j14](journey/j14-cross-version-proposal.png)/[j15](journey/j15-reverted.png) |
| P2 Agent 按钮不定位提案 / 3D 只有说明 | Agent 页每份提案带真实证据引用（登记时间、来源自我声明、派生分析、测试结论）并可「审阅这份提案」落到审阅页同一提案；3D 页列出所选文件的真实函数成员、点击进入工作台同一对象；city3d（WebGL2）检查器新增文件成员，每个成员可带回 2D 工作台同一函数 | 旅程 `U5` 全部 3 项，截图 [j08](journey/j08-agent-proposal.png)/[j16](journey/j16-city3d.png)/[j17](journey/j17-roundtrip.png) |
| `scripts/demo.sh` 固定打开 tour | 接受可选目录参数：`bash scripts/demo.sh <目录>` | 脚本头注；本轮启动器另用 `start.sh` 实测 |

## 用户旅程（最终包、仓库外、真实 Chrome，30/30 通过）

以 `ATLAS_STORE=… ./pkg/start.sh /tmp/atlas-journey/alpha` 启动最终包，样本为仓库外两个临时项目（alpha：`math.js` 的 add/checkout/spin + 一个只在修复后才会通过的测试；beta：`gamma.js`）。脚本 [journey/journey.cjs](journey/journey.cjs)，结果 [journey/results.json](journey/results.json)，截图 26 张。除两处标注外全部为页面点击/输入：

1. **探索（U1）**：搜 `checkout` 选中 → 点关系图中的 `add` → 源码切到 add → 「返回」回到 checkout。
2. **运行（U2）**：`checkout(17,23)` 基线返回 **−6**（结果卡大字），页签里能看本次输入 `[17,23]` 与输出日志；历史记录可「重填输入」。启动 `spin(3000000000)` 后切到 checkout，打开「后台任务」：spin 显示运行中（徽标 1）→ 面板里点取消 → 服务端确认后显示已取消；checkout 的已完成任务可「查看结果」跳回运行页并显示同一终态记录。
3. **项目设置（U4）**：项目页把测试命令存为 `["node","--test"]`、超时 60000 → 状态「已生效」，之后验证输出里出现的就是这条 argv。
4. **打开/切换项目（U4）**：输入 beta 目录 →「打开并分析」→ 索引完成自动切换（左上项目名 beta、新分析版本）；搜索 `checkout` 为 0、`gamma` 命中（隔离）；「最近项目」一键切回 alpha。
5. **Agent 交接（U5）**：外部 Agent 以 `codex-agent` 身份经 CLI 提交 checkout 修复提案（`patch/propose`，这是 Agent 的真实接入方式）→ Agent 页刷新后显示提案与证据引用 →「审阅这份提案」落到审阅页同一提案。
6. **验证与对照（U3）**：页面点「验证」→ 隔离副本里真实执行 `node --test` 并通过（测试对旧实现必然失败，通过即证明补丁生效）→ 运行页「以相同输入比较」：基线 −6 / 补丁 40 各自呈现。
7. **应用 → 新版本 → 撤销（U3）**：「检查并应用」确认层显示真实授权目录与文件 → 确认后磁盘字节更新 → 「打开新版本」重索引并切换 → 页面源码显示 `add(a, b)`，同输入运行返回 **40**（新基线）→ 审阅页（提案已标注「固定在项目之前的分析上」）「一键撤销」→ 磁盘恢复，再走一次打开项目，页面源码恢复 `add(a, -b)`。
8. **3D（U5）**：带同一选区进入 `/city3d`（WebGL2）→ 揭示选区 → 文件层级点选柱体 → 检查器列出 math.js 的成员 add/checkout/spin → 成员/顶栏链接回 2D 工作台，同一对象。
9. **布局（U6）**：1600/1024/390 三档 × 四页无根页面横向溢出（截图 j18-*）。

## 检查与退出码

| 检查 | 结果 |
|---|---|
| `python3 scripts/verify.py --label ui-v2-u1-u6-final2`（25 项：fmt/clippy/测试/集成/取消/作业/并发/增量/语义/执行/桥接/补丁/宿主/重定位/视图/网页行为等） | 全部 PASS；fingerprint pairing PASS（binary=source）；负向对照按设计为 FAIL→计 PASS；`status: PASS`。日志 [verify-final/](verify-final/) |
| `node --test web/tests/app.behavior.test.mjs` | exit 0；**74** 项通过（68 项既有 + 6 项本轮新增：结果页签、后台任务、提案定位、设置生效、项目打开/切换、跨版本提案可达） |
| `git diff --check` | exit 0 |
| 最终包旅程（真实 Chrome headless，仓库外） | 30/30 PASS，浏览器 JS 错误 0 |
| 行为测试之外，本轮新增 Rust 面 | `cargo clippy -D warnings`、`cargo fmt --check` 经 verify 全过；服务端新端点均有冒烟（curl 实测 open/switch/settings/runs/reindex） |

## 交付物

- 最终包：`dist/atlas-local-darwin-x64/`（启动：`./start.sh /path/to/project`；`ATLAS_TEST_ARGV` 可选，页面内设置等效且可后续更新）。
- 文档：`docs/HOST_API.md`、`docs/FRONTEND_API_CONTRACT.md` 已补新端点（exec/runs、project/open(+cancel)、project/reindex、project/settings、projects）。
- 行为与旅程证据：本目录（`journey/` 26 张截图 + results.json + 脚本；`verify-final/` 各项日志）。

## 未完成 / 明确边界（不计入本轮通过项）

- **分析进度粒度**：打开项目时只有经过时间与「有界、可取消」说明，没有阶段级进度（索引管线不发布进度事件）；取消是协作式，管线在检查点停下才显示 cancelled。
- **3D 目录过滤**：设计 D1 的「只看某目录」过滤未做；层级切换（项目/目录/文件）已有。3D 成员列表来自本页已加载节点（本轮小项目为全量；大项目会标注已加载子集，与 2D 一致）。
- **Agent 提案与交接草稿的持久关联字段**（handoff_id 等）未加：以真实提案为主列、交接目标为项目草稿，未发明关联。
- **断线重连**：重连后靠 ui-state/记录恢复；「执行结果未知 → 自动查记录」未做自动链（任务面板手动刷新可查）。
- **平台与语言**：仍只验证 darwin-x64 + Node 26；语言链仍为 TS/JS。未重做 D0–D4 历史，也未把它们记为本轮证明。
- 390 宽度保证主操作可达（截图为证），未做移动端精修。

## 下一步

交独立复审：重点复核跨版本提案的撤销链、后台取消终态、项目切换后的草稿/选区隔离，以及设置生效的验证输出。
