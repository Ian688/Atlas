# Atlas 每日交付 — 2026-09-09 / w02(复审修复窗口)

## 窗口与代码身份

| 字段 | 实际值 |
|---|---|
| window_id / status | `2026-09-09/w02` / RUNNING(本报告为窗口内交付;窗口在额度内继续推进 W06/W07 时按同一规范刷新) |
| 开始、结束、时区、UTC | 开始 2026-09-09T05:15:51+08:00;本报告生成于 08:2x+08:00;时区 Asia/Shanghai |
| 实际墙钟时长 | 约 3.1 小时(至本报告生成);窗口剩余额度约 6.9 小时,继续按任务书推进 |
| 中断及恢复 | 无中断 |
| cwd / branch / HEAD | `/Users/yinsijie/CodeRepo/Atlas`;分支 `codex/standalone-foundation`;仍无 commit(与 w01 相同;本窗口收敛时按授权建立 Git 基线提交,仅含 Atlas 自有受控文件) |
| 复审输入 | `evidence/reviews/2026-09-09-w01/REVIEW.md`(CHANGES_REQUIRED,R1–R7 + M1–M3) |
| 起始源码指纹 | 复审绑定 46 个源文件 hash(`evidence/reviews/2026-09-09-w01/review-verification.json`)+ w01 最终 62 文件清单(`evidence/daily/2026-09-09/w01/final/source-manifest.json`) |
| 最终源码指纹 | `evidence/daily/2026-09-09/w02/final/source-manifest.json`(绑定 `final/verification/verification.json`,PASS 9/9) |
| changes | `final/changes.json`(修改 11 / 新增 0 / 删除 0,对照 w01 最终清单)+ `final/changes-full.patch`(11 个变更文件的全部后态内容,因无 Git 历史无法生成逐行 diff;每个文件附 w01 与 w02 的 SHA-256) |
| 前一窗口与复审结论 | w01 DELIVERED;复审 CHANGES_REQUIRED(本窗口逐项修复,见下) |

## 修复逐项状态(先复现→再修复→再锁定)

| 项 | 状态 | 复现(修复前) | 修复位置 | 锁定测试(修复后) |
|---|---|---|---|---|
| R1 异常状态 | RESOLVED | exceptionState 返回 [2](oracle 1) | solve.rs transfer_block 每 may-throw 操作捕获前置状态;flow.rs Term::Throw 带 handler 携带抛出值 | probe exceptionState=[2,1];flow_semantics r1_perturbation(throw 后 x=99 不得出现,抛出值 9 到达异常出口) |
| R2 调用堆效果 | RESOLVED | knownMutation/unknownMutation 返回 [1] | Summary.written+State.written;param{i} 键控写;apply_summary_heap 按实参重代入;clobber_for_unknown_call 保守失效;may_call 改累计 | probe knownMutation=[1,2] 含 2、unknownMutation unknown=true;flow_semantics r2 两测试 |
| R3 缺失字段 | RESOLVED | missingField 返回 [1](oracle undefined) | PropertyRead 按候选对象逐个合并:已知缺失→undefined、未知形状→Top | probe missingField=[1,'undefined'];(相邻扰动:候选顺序由 worker 输出顺序决定,顺序置换由 probe 固定样例覆盖) |
| R4 primitive 加法 | RESOLVED | true+1="true1"、null+1="null1" | solve.rs fold_add:num 转换(true=1/null=0/undefined=NaN)、拼接仅限字符串参与、小数精确带 | probe mixedAddition=[2]、nullAddition=[1];flow_semantics r4 矩阵 8 例(含 ''+0.5、1+'1'、undefined+1=NaN 扰动) |
| R5 全链 deadline | RESOLVED | 缓存 worker 隔离下 24.6s 成功发布 1+1200 | solve/inter/analyze 贯穿单调 deadline;MAX_TOTAL_TRANSFERS 生效;发布前终态核对 | probe rust_stage_deadline:退出 1、~1.1s、0 analyses/0 facts;flow_semantics r5 单测 |
| R6 IR 校验 | RESOLVED | 重复 binding/悬空引用/缺失函数三种注入均成功发布 | validate_flow_with_symbols:重复 id 拒绝、悬空引用拒绝、FunctionRef 校验、逐函数覆盖对账 | 集成 test_worker_ir_tampering...(3 注入,0 analyses/0 facts)+ 边界 probe 三例退出 1 且零发布 |
| R7 无绑定 catch | RESOLVED | 整项目索引失败 flow_catch_missing_param | 校验与 lowering 均允许无参数 catch | 边界 probe optional_catch 退出 0;flow-lab optionalCatch returns=[7] |
| M1 实参代入 | RESOLVED | viaIdentity unknown、identityNumber 无常量 | apply_summary_value 全维度代入(constants/targets);inter.rs MAX_GRAPH_ROUNDS 调用图重调度 | viaIdentity=[1]、identityNumber=[41](手工+集成);D14 五层链保持 |
| M2 completion 精度+tagged | RESOLVED | finallyReturn 返回 [9,1](多余路径) | Dispatch 按 completion 分派(仅 Normal/Multiple 走 normal 边)→ [1] 精确;ValueJson.typed_constants 侧车(undefined/NaN/Infinity 与字符串可机器区分;旧 constants 字段保留,消费者迁移另行记录) | probe finallyReturn=[1];flow 输出含 typed_constants |
| M3 台账 | RESOLVED | D06/D11/D19/D21 重复登记、D18 缺失 | progress.json d_family_coverage 按家族单条目重构(子能力状态+具名测试+gaps),D18=PARTIAL 登记为 throw 顺序扰动测试 | progress.json 提交记录 |

probe 复现与修复后状态:
```sh
python3 evidence/reviews/2026-09-09-w01/probe_semantics.py    # 修复前 exit 1 → 现 exit 0
python3 evidence/reviews/2026-09-09-w01/probe_boundaries.py   # 修复前 exit 1 → 现 exit 0
```
注:probe 设计为自写回 JSON,修复后重跑已覆盖复审记录的原失败输出;原失败逐项结论以 REVIEW.md 为准,本窗口复制了修复后输出到 `final/artifacts/`。

## 验证与反例(全部最终代码上的退出码)

| 命令 | 退出码 |
|---|---|
| `python3 scripts/verify.py --label w02-final --out evidence/daily/2026-09-09/w02/final/verification --timeout 570` | 0(9/9:fmt/clippy/tests/build/worker/integration/calculator/web-syntax/whitespace) |
| `python3 evidence/reviews/2026-09-09-w01/probe_semantics.py` | 0 |
| `python3 evidence/reviews/2026-09-09-w01/probe_boundaries.py` | 0 |
| `cargo test --workspace --locked` | 0(30 pass/0 fail;flow_semantics 19 条含 R1–R5 提炼与扰动) |
| `npm test --prefix workers/typescript` | 0(20 pass/0 fail) |
| `python3 scripts/test_integration.py` | 0(12 pass;新增 worker IR 注入三例) |
| `node examples/calculator/demo.mjs` / `node --check web/app.js` | 0 / 0 |

新增相邻扰动(不照抄本单):r4 矩阵含 `''+0.5`、`1+'1'`、`undefined+1=NaN`、`false+false=0`;r1 扰动含 throw 后赋值不可达与抛出值携带;R6 注入含变异计数断言(防假负例)。

## 资源、生命周期与兼容

- deadline:scan(默认 300s)与 worker(默认 60s)各自预算受 `--index-deadline-seconds`(默认 600)剩余额度的 min() 约束;analyze 全程与发布前核对;超时错误 `analysis_deadline_exceeded_no_analysis_published`,零 Analysis/零 facts 发布(边界 probe 记录)。
- 兼容:ValueJson 新增 `typed_constants` 字段(旧 `constants` 保留);`fold_constants` 改为 pub;Analysis 身份随内容变化(算法行为修复必然改变派生事实,旧 Snapshot/Analysis/facts 未原地篡改,w01 证据目录保留为历史)。
- 未变式:解析/算法/布局不调用 LLM、不执行被分析项目(getter 不执行测试保持通过)。

## 未解决项与真实失败

- k=1 上下文敏感摘要未实现(M1 为全维度代入+调用图重调度;Review 指出“仅提高上下文数量无法修复代入缺失”,代入已先行完成)。
- 已知 setter 写后值当前为保守 {1,2}(合并旧值),无条件写强更新待实现——不再输出确定旧值,符合 R2 的底线要求,精度提升留待后续。
- 取消令牌/协作检查点、作业队列租约、断电耐久(W06 剩余);D16/D18(矛盾路径专项)/D19(高扇出触发)部分子项未做,均登记于 progress.json。
- R6 注入负例当前由集成测试与边界 probe 双重覆盖;`Store::publish_analysis_with_flow` 公开入口自行核验 digest 的边界仍未验收(复审 M3 同项)。

## 请求独立审查(自测均非独立 ACCEPTED)

1. R1 操作级异常前置状态:重点扰动“抛出前副作用保留、抛出后赋值不进入 catch”以及成对正常路径(finallyReturn 应仅 [1])。
2. R2 堆写重代入:{1,2} 合并是否符合“不输出确定旧值”的底线 vs 期望精确 [2];未知调用 wildcard-Top 失效是否过宽/过窄。
3. R4 fold_add 语义表:数值转换与拼接条件;小数格式化精确带([1e-6,1e21) 外保持 unknown)。
4. R5 deadline:合作检查点粒度(逐块/逐函数)是否满足“执行已停止”;发布前核对是否充分。
5. M1 代入与调用图重调度:MAX_GRAPH_ROUNDS=4 上限、Capture origin 不重代入的声明边界。

## 下一窗口第一步

W06 剩余:取消信号(进程组+子进程回收证据)、作业终态幂等矩阵;或处理下一轮复审反馈。依赖:R1–R7/M1–M3 已闭环,probe 与正式回归全部绿色。
