# Atlas 首版本地交付：S1–S6

窗口：`2026-09-15/s1-s6-first-version`。执行顺序：任务书 v4.0 的 S1→S6。
状态：**自测通过，NEEDS_INDEPENDENT_REVIEW**。人的旅程与 Agent 旅程都已实际执行并留证。

上一轮独立复验（[2026-09-15-local-delivery](../reviews/2026-09-15-local-delivery/REPORT.md)）为
CHANGES_REQUIRED，两个 P1 阻断（`worker_missing`、重启丢任务）在本轮修复并复验。

## 用户结果

- **S1 任意目录的分发链**：把分发包拷到含空格路径、从 `/` 启动，提案 → 验证 → 对照 →
  应用 → 撤销全程可用，失败具名且可重试。原因是资源定位以调用者 cwd 为锚：现在以可执行文件
  为锚（`resolve_worker`），`serve` 也接受启动配置（`--worker/--node/--test-argv/--test-timeout-ms/
  --worker-heap-mb`），后台验证、重试与排队作业都通过这两条找到同一份资源。
- **S2 真正关闭再启动能接上任务**：随机端口让每次启动都是新 origin，localStorage 取不到。
  现在端口按项目路径稳定推导（被占用时明确回退到随机端口），任务状态（选区、页签、
  输入草稿）按**项目身份**存在 store 里（`--project`，默认分析 id），页签与草稿恢复后
  选区按分析版本重定位。不同项目的同名函数不串状态；源码位移按 `path_and_name` 重定位，
  改名到无法识别时具名拒绝。
- **S3 测试与完整输入对照**：测试命令在启动时声明（`--test-argv`，JSON argv，不是 shell 字符串），
  在隔离副本里执行；页面显示真实命令、退出码、耗时与可展开的 stdout/stderr，
  未声明时如实写"没有跑任何测试，这不是通过"。前后对照把 args / this / globals 一起送到两侧，
  页面复用运行页签的草稿并回显实际发出的声明输入。
- **S4 最终包完整旅程**：`examples/tour` 12 项 + 多层目录跨目录 import 的临时项目 6 项，全部用
  真实指针/键盘在 Chrome 里完成（查找、点真实关系、源码/值定位、运行、多行补丁、隔离验证、
  切换对象不串结果、前后对照、应用/撤销字节核对、2D/3D 往返、停止重开）。
- **S5 真实 Agent 任务**：一个没有开发上下文的编程 Agent 只读 [接入说明](../../../../docs/AGENT_ONBOARDING.md)，
  用公开接口完成"修复金额边界并保留正常情况"：`/api/search` 找到 `charge`、`/api/reach` 读关系、
  `POST /api/context` 取上下文、`POST /api/patch/propose` 提交提案（含一条回归测试）、
  `POST /api/patch/verify` 触发隔离验证（`ran=true`、`exit_code=0`、4/4 通过）。它没有应用补丁。
  **另一个独立 Agent** 复核了结果（自己打 diff、自己跑断言与 `node --test`、核对检出目录字节），
  结论是满足需求，并抓出执行者报告 1 处事实夸大（把 4 条入边写成 3 条）。
  人随后在工作台定位到同一份提案与验证结果，在授权目录应用并核对字节、再撤销并逐字节核对。

### 剩余 / 未解决

- 需要未知调用授权的函数（例如读 `this` 或调用未解析的外部名）在 HTTP 面上无法运行，
  对照也被具名拒绝——沙箱不能由页面放宽，这是设计而不是缺口，但它限制了对照的适用范围。
- 同一实例的 HTTP 面只服务启动时钉定的那份分析；要看补丁侧的图只能读 `verification.graph_diff`。
- 只验证过 macOS darwin-x64 + Node 26.5.1；Windows、Linux、其他架构、干净机器未验证。
- 独立复审未做。

## 改动与身份

- 仓库 `/Users/yinsijie/CodeRepo/Atlas`，实际 HEAD `c8fada2` + 本窗口未提交改动。
- 关键改动：
  - `crates/atlas-app/src/main.rs`：`resolve_worker`（以可执行文件为锚，`--worker`/`ATLAS_WORKER` 优先）；
    `serve` 新增 `--worker/--node/--test-argv/--test-timeout-ms/--worker-heap-mb/--project`；
    `patch verify` 的 `--worker` 变成可选并走同一解析。
  - `crates/atlas-app/src/server.rs`：`ServerConfig`（验证资源固定为启动配置）；
    `App::server_verify_options`；稳定性端口回退；`ui-state` 读写端点（`GET`/`PUT`）；
    `exec-compare` 接受 `this_arg`/`globals` 并回显 `declared_inputs`；契约补上
    `search` / `exec-compare` / `ui-state` 三条（原先页面在用但不在契约里）。
  - `crates/atlas-engine/src/store.rs`：`ui_state` 表（纯增量创建）与读写方法；
  - `crates/atlas-engine/src/job.rs`：`claim_job` 与 `enqueue_job` 支持 failed/cancelled 的重试
    （原先只有 queued 能被认领，失败后页面无法重试；重试会带上本次提交的运行参数）。
  - `web/app.js`：服务端任务状态保存/恢复、重定位结论优先于"已恢复"提示、对照默认沿用运行草稿
    且重建时保留用户已改的输入、测试结果显示命令/退出码/输出/失败与超时。
  - `scripts/dist.sh`：启动脚本传入 worker/project/声明的测试命令，端口按项目稳定推导，
    启动时**实测** Node 权限模型真的会拒绝，并在不通过时明确说"运行函数不可用"。
  - 文档：新增 `docs/AGENT_ONBOARDING.md`；修正 `docs/HOST_API.md` 的 HTTP 接口清单
    （原先漏了 patch 系列，一个真实 Agent 因此找不到入口）；README / dist README 对齐现状。
- 兼容处理：`StoredVerify` / `IndexOptions` 的新字段都带 serde 默认值，旧作业行仍可运行；
  `ui_state` 表对旧 store 增量创建；稳定端口被占用时回退随机端口而不是启动失败。

## 实际验证

| 命令或浏览器操作 | 最终结果 | 证据 | 验证范围 |
|---|---|---|---|
| `python3 scripts/verify.py --label s1-s6-first-version … --keep-going` | exit 0，25 项 PASS（含 fingerprint pairing 一致） | `verify/` | 源码级综合检查；不含分发与浏览器 |
| `node s1-distribution.mjs`（复制包 → 含空格路径 → cwd=/） | 21/21 PASS | `s1-results.json`、`s1-log.txt` | 验证/重试/应用/撤销字节 |
| `node s2-restart.mjs`（真实 Chrome，每次重开换全新 context） | 8/8 PASS | `s2-results.json`、`s2-*.png` | 重启恢复/跨项目不串/重定位与拒绝 |
| `node s3-verify-compare.mjs`（真实 Chrome + HTTP） | 11/11 PASS | `s3-results.json`、`s3-*.png` | 声明测试的显示与失败区分、this/globals 对照 |
| `node s4-journey-tour.mjs`（examples/tour） | 12/12 PASS | `s4-tour-results.json`、`s4-tour-*.png` | 关系点击、值定位、切换不串、应用撤销、2D/3D |
| `node s4-journey-second.mjs`（多层目录项目） | 6/6 PASS | `s4-proj2-results.json`、`s4-proj2-*.png` | 不同结构的同一条旅程 |
| 独立 Agent 任务（`s5-agent-task.mjs` 布置） | 提案 `a41f014f…`，作业 completed，`ran=true` `exit_code=0` 4/4 | `s5-agent-report.md`、`s5-independent-review.md` | 第一次复验（fmt 前的包） |
| **最终包上的 S5 复跑** Agent 任务 | 提案 A/B/C 均 verified，C=`3a165427…`，测试真跑 4/4 退出码 0 | `s5-agent-report-final.md` | 契约补过 `search` 后重跑 |
| **最终包上**独立 Agent 复核 | 满足需求；自建副本复现；列出 3 处轻微措辞偏差 | `s5-final-verification.md` | 由**另一个** Agent 完成，非执行者自述 |
| **最终包上**人的审阅（真实 Chrome） | 4/4 PASS | `s5-final-human-results.json`、`s5-final-review-*.png` | 人在工作台定位同一提案并应用/撤销 |
| `cargo test --workspace --locked` | exit 0（5+68+24+9+17+4） | 见 verify 的 rust-tests | Rust 单测 |
| `node web/tests/app.behavior.test.mjs` | 66/66 | 见 verify 的 web-behaviour | 2D 行为 |

关键失败与修复：本轮 4 个由实测暴露的缺陷都已修并复验——资源定位（S1）、重启丢任务（S2）、
`claim_job`/`enqueue_job` 让失败作业无法重试、以及提案面板在画像到达前渲染导致对照默认输入为空
（S4 第一段抓到，修法是在画像到达后补渲染并保留用户已编辑的值）。契约缺 `search`/`exec-compare`
是由独立 Agent 找不到搜索入口暴露的。

## 接下来直接做

1. **独立复审**：重点核对 S1 的 `resolve_worker` 在非分发布局下的行为、稳定端口被占用时的回退、
   重试语义（failed 行被认领后 `options` 会被本次提交重写）是否可接受，以及 S5 两份独立报告里
   是否还有未被抓到的叙述偏差。
2. **显式 analysis 参数被静默忽略**（`crates/atlas-app/src/server.rs` 的 `Request` 与 `query()`）：
   `GET /api/report?analysis=<补丁分析 id>` 仍返回基线计数，`/api/source?...&analysis=<补丁分析 id>`
   报 `entity_not_found`。执行 Agent 与独立核对者都被绊过。改法是在 `query()` 开头对
   显式指定且不等于本实例分析 id 的请求返回具名拒绝，并说明本实例服务哪一份、看补丁侧应读
   `verification.graph_diff`。本轮未改：它不影响任何本次结论，且改它要重建包并重跑 S5。
3. **对照的适用范围**：需要 `unknown_calls` 的函数在 HTTP 面无法对照。若要扩大，需要一条
   由操作者在启动时授权的路径（例如 `serve --allow-effects unknown_calls`），而不是让页面放宽。
4. **平台**：下一个落点是 Windows/Linux 的分发与权限模型资格；不能沿用 macOS 的证据。
