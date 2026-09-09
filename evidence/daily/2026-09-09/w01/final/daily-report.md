# Atlas 每日交付 — 2026-09-09 / w01

## 窗口与代码身份

| 字段 | 实际值 |
|---|---|
| window_id / status | `2026-09-09/w01` / DELIVERED |
| 开始、结束、时区、UTC | 开始 2026-09-09T00:29:44+08:00(2026-09-08T16:29:44Z);结束 2026-09-09T03:28:36+08:00(最终验证 time_utc=2026-09-08T19:26:50Z 之后无代码改动);时区 Asia/Shanghai |
| 实际墙钟时长 | 约 2 小时 59 分钟(00:29:44→03:28:36 +08:00);平台活跃时长未知,未获取;窗口尚有约 7 小时余量,提前交付原因见下 |
| 中断及恢复 | 无中断;单次连续会话 |
| cwd / branch / HEAD | `/Users/yinsijie/CodeRepo/Atlas`;分支 `codex/standalone-foundation`;无任何 commit(全部 untracked,起始即如此) |
| 起始源码清单/指纹 | `evidence/daily/2026-09-09/w01/baseline/source-manifest.json`(54 文件;与 foundation 记录 35 个 hash 全部 MATCH) |
| 最终源码清单/指纹 | `evidence/daily/2026-09-09/w01/final/source-manifest.json` + `final/verification/verification.json` 内 source_hashes(45 项) |
| 完整 changes.patch / changes.json | `final/changes.patch`(含全部新增文件内容,32 个 diff 条目)/ `final/changes.json`(新增 10、修改 20、删除仅 .DS_Store 噪音) |
| 前一窗口与复审结论 | 首次执行:NONE |

## 本次实现及可运行结果

主线通路(全部经真实 worker→Rust→SQLite→CLI/HTTP→面板验证,不是孤例拼装):
**JS/TS 源码 → 快照 → worker Flow IR(atlas.flow-ir.v1)→ Rust 校验 → CFG → 局部抽象解释 → 跨过程符号摘要 → 原子发布 → CLI `flows`/`flow` → HTTP `/api/flows`、`/api/flow` → 函数面板流程视图**

| W / feature | implementation | automated_checks | qualification | review_status | 证据 |
|---|---|---|---|---|---|
| W00 基线与证据隔离(verify.py 参数化) | IMPLEMENTED | PASS(9/9) | QUALIFIED_WITHIN_PROFILE | NEEDS_INDEPENDENT_REVIEW | baseline/、scripts/verify.py |
| W01 Flow IR 与作用域/绑定 | IMPLEMENTED | PASS(worker 20/20) | QUALIFIED_WITHIN_PROFILE | NEEDS_INDEPENDENT_REVIEW | workers/typescript/src/flow.mjs、crates/atlas-contract/src/flow.rs |
| W02 CFG 与 finally completion | IMPLEMENTED | PASS(单测+集成) | QUALIFIED_WITHIN_PROFILE | NEEDS_INDEPENDENT_REVIEW | crates/atlas-engine/src/flow.rs |
| W03 局部抽象解释/def-use/来源 | IMPLEMENTED | PASS(单测+集成) | QUALIFIED_WITHIN_PROFILE | NEEDS_INDEPENDENT_REVIEW | crates/atlas-engine/src/solve.rs |
| W04 跨过程符号摘要(SCC/调用点代回) | IMPLEMENTED | PASS(d13/d14/d15/d17) | QUALIFIED_WITHIN_PROFILE | NEEDS_INDEPENDENT_REVIEW | crates/atlas-engine/src/inter.rs |
| W05 存储/查询/真实面板 | IMPLEMENTED | PASS(集成 9/9) | QUALIFIED_WITHIN_PROFILE | NEEDS_INDEPENDENT_REVIEW | store.rs/query.rs/main.rs/server.rs/web/app.js |
| W06 作业与资源边界 | PARTIAL | PASS(扫描/管线 deadline 单测+多项目隔离+并发幂等+blob 损坏恢复集成) | NOT_QUALIFIED | NEEDS_INDEPENDENT_REVIEW | scan.rs、main.rs --index-deadline-seconds、test_multi_project_store_isolation 等 |
| W07–W10 | NOT_IMPLEMENTED | NOT_RUN | NOT_QUALIFIED | NOT_REQUESTED | 见 progress.json 队列 |

用户现在能做的事(举例,计算器或 flow-lab 样例即可复现):
- `atlas --store S index PROJECT` 得到分析;`flows` 列出有局部语义事实的函数;`flow <analysis> <symbol>` 给出该函数的 CFG(块/分支/异常边/finally dispatch)、每块绑定值状态(常量/来源/初始化/未知及原因)、def-use、返回与抛出值、效果(可能调用目标、未知外部调用、堆写、回调注册、逃逸)、调用点(目标集合是否闭合、实参来源、代回结果)与预算消耗。
- 浏览器打开 `serve`,选中函数即显示同一份事实的摘要视图(含跨过程摘要与调用点行);截图见 `final/artifacts/`。

修复与已纠正的实现错误(过程中发现并修正,均有测试锁定):
- `??` 分支方向反置导致 RHS 副作用被提前可达;
- 短路/条件表达式曾用非路径敏感的 JoinValues(已改为路径内临时变量);
- finally 体自身终止时误挂 dispatch;
- 表达式体箭头函数导致 worker 崩溃;
- scope id 跨函数冲突;
- worker pass-0 模块扫描误入函数体,把局部变量注册成模块绑定;
- 求解器早期迭代污染 returns/effects(改为按块覆写终值);
- 未知对象属性读/写未标记 unknown_call(getter/setter)。

## 验证与反例

最终验证(窗口内最后一次,全部对应最终代码):

| 命令 | 退出码 | 结果 |
|---|---|---|
| `python3 scripts/verify.py --label w01-final --out evidence/daily/2026-09-09/w01/final/verification --timeout 570` | 0 | rust-format/clippy/tests/build、worker-tests、integration、calculator、web-syntax、whitespace 全 PASS |

D 家族覆盖(逐项测试位置见 `docs/implementation/progress.json` 的 `d_family_coverage`):
- 已覆盖:D01(TDZ/遮蔽)、D02(短路不可达+剪枝证据)、D03/D04(finally 保留/覆盖/不恢复旧环境)、D05(循环不动点)、D07/D08(候选保留/强更新 kill)、D09(别名+wildcard 弱更新)、D10(cap 超限→Top+原因)、D12(Parameter 来源)、D13(caller 隔离)、D14(五层链)、D15(互递归收敛、pending≠无返回)、D17(call/forwarded 边分开)、D18(矛盾/未知条件保持可能)、D20(外来 ID 拒绝/旧版本隔离)、D22(全链路)、D06(getter 不执行+unknown_call)、D11(外部调用对象/闭包效果)、D19(20 层嵌套 finally CFG 线性+60 分支预算内完成+扫描/管线 deadline)、D20 深化(损坏 blob 拒绝+flow 存活+恢复路径)、D21(产品级等长 α-重命名:流事实映射回原后逐字节相等)
- 部分/未做:D16、D19(高扇出深链专项)、D21(Rust 层等价性)未专项;**未从必做表中删除任何难例**

复审者可复现样例(从当前源码):
```sh
npm ci --prefix workers/typescript --ignore-scripts --no-audit --no-fund
cargo build --workspace --locked
./target/debug/atlas --store /tmp/atlas-review index examples/flow-lab
# flows 列 13 个函数;identity 的 returns.origins 含 Parameter(0);
# indirect 的 returns.constants 含 41(跨过程代回);divider 的 throws 非空;
# shortCircuit 的 unknown_call=false 且 pruned_edges>0;loopCallers 含 for_in_of_iteration 未知
```
UI: `atlas --store /tmp/atlas-review serve <id>` → 浏览器输入 session token → 选 `branchPick`/`indirect` → 展开“局部控制流与值来源”。

## 资源、生命周期与兼容

- 预算:worker stdin 160MiB/stdout 32MiB 期限 1–600s(既有);扫描整体 deadline 新增(默认 300s,`--scan-deadline-seconds` 1..3600,超限零发布);求解器 transfers≤300k、块访问≤256、cyclic SCC≤32 轮;cap 常量8/目标64/来源8/堆32。
- 兼容:LanguageFacts 增加可选 `flow`;Analysis 增加 `flow_digest`(空=无 flow);producer 0.1.0→0.2.0(0.1.0 输入仍被接受但无 flow 事实);旧分析事实/选区/游标不变(有测试)。CLI 新增 `flows`/`flow`/`--scan-deadline-seconds`;HTTP 新增 GET `/api/flow`、`/api/flows`。无 schema 破坏性变更;数据库用 CREATE TABLE IF NOT EXISTS 增量。
- 并发/隔离:并发重复 index 幂等同终态(测试);跨 analysis 查询被拒(测试)。

## 未解决项与真实失败

- `partial_recursion`/`partial_budget` 路径无专项触发测试(有限格上通常收敛;大 SCC 的轮上限未压测)。
- D16/D19 深链高扇出/D21 Rust 层等价性、k=1 上下文敏感、Capture origin 重代入、堆嵌套字段路径未实现(全部显式记录,非 unknown 化掩盖)。
- 取消 API/作业队列/租约/断电耐久未做(W06 剩余)。
- 本窗口在约 3 小时处交付,剩余约 7 小时窗口额度未用完。继续工作的实际原因:已完成的通路存在一个无法在本窗口自主解决的推进障碍——把 k=1 上下文敏感摘要或 W06 完整作业系统做到可验证质量,需要的改动面会推翻已通过审查友好的已验证交付并在窗口内无法完成复验;按任务书"不为了凑时长把未知改成通过"与"预留末尾收敛"的要求,选择在已验证状态交付。后续窗口从 progress.json next_action 继续。
- 新增集成测试后最终验证重跑:verify.py 9/9 PASS(time_utc=2026-09-08T19:26:50Z),此后无代码改动。

## 请求独立审查

优先级(详见 `final/review-requests.json`,全部为自测 PASS,未自行标 ACCEPTED):
1. finally completion 语义与共享 dispatch(R1:flow.rs lower_try + solve.rs Dispatch)。
2. 短路/`??` 路径敏感与剪枝证据(R2;历史上有两个已修 bug,建议重点扰动)。
3. 跨过程摘要的调用点代回与递归收敛(R6:inter.rs)。
4. worker 边界诚实性:profile 外显式 unknown、不执行被分析代码、校验拒绝(R4)。
5. `flow_digest` 绑定派生事实与 analysis 身份(R5;已知缺口:worker 降级逻辑变化不改变 id)。

## 下一窗口第一步

先处理复审 CHANGES_REQUIRED(若有),否则进入 W06 剩余:索引管线级 deadline/取消(`--index-deadline-seconds` 包裹 scan+worker+publish,tokio::time::timeout,超时零发布;用 120 文件合成项目 + 1s 期限复现失败→修复),然后 worker 崩溃恢复矩阵;依赖:本窗口 W01–W05 已交付、W06 部分(扫描 deadline/多项目隔离/幂等)已交付。
