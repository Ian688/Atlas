# W06：有界并行作业执行（`job work --parallel N`）

窗口：`2026-09-12/w06-bounded-parallel-jobs`
日期：2026-09-12（Asia/Shanghai）
结论：**DELIVERED**。一个进程可以同时跑 N 个作业，但 N 是**有界策略**，而"真的并行"有可见证据（实际 holder），不是推断。

## 1. 之前是什么样

`job work` 是严格顺序的：认领→跑完→再认领。GE-3 的并发资格在上一轮已经证明**多个进程**可以并发安全地写同一个 store（写者串行、等待可取消），但**单个进程内**没有并行度，也没有任何策略性上限——"并发"只能靠人手动起多个进程。

## 2. 现在是什么样

`job work --parallel N`（`N ∈ 1..=4`，默认 1）。

- **每个槽位独立 holder**：`<pid>-<uuid>-slotN`。租约标识"谁在跑"，两个槽位共用一个 holder 会让"谁在跑这个作业"变成假话，也会让一个槽位的心跳替另一个续租——这条不是优化，是正确性。
- **上限是策略**：`--parallel 0/5/99` → `job_parallelism_out_of_range`；`--once --parallel 2` 是两种不同请求（"跑一个就停" vs "同时跑 N 个"），直接 `job_once_with_parallelism` 拒绝，而不是悄悄选一个。
- **上限计数是原子的**：`max` 的检查与占用在同一步完成（`fetch_add` 后再比较并回退），两个槽位不可能同时认为"还剩最后一个名额"。
- **证据在输出里**：`{ran, parallelism, holders, max_parallelism, outcomes}`——`holders` 是实际用于领取的 holder 列表，槽位是否真的分开领取看这个。
- **槽位崩溃不静默**：槽位任务失败作为 `job_slot_task_failed` 出现在 outcomes 里；它占用的作业租约过期后由 `job reap` 收回队列。
- **数据库层面**：store 的写者是串行的（第 5b 轮修复的可取消等待），所以并发槽位是在数据库上排队，而不是互相破坏。

## 3. 验证

`scripts/test_patch.py` 新增 `Parallel` 类（37 → **39**）：

| 用例 | 断言 |
|---|---|
| `test_parallel_slots_overlap_and_never_share_a_lease` | 3 个 `patch_verify` 作业各带一条**睡 1.2 秒**的声明测试，`--parallel 3` 运行时每 100ms 轮询 `job list --state running`：观察到**至少一次两个作业同时在跑**（`max(len(holders)) >= 2`）；`ran=3`；`holders` 恰好 3 个且互不相同；三个作业都是 `completed`；终态集合只有一个状态 |
| `test_the_bound_is_enforced_and_one_shot_with_parallelism_is_refused` | `--parallel 0/5/99` → 非零退出 + `job_parallelism_out_of_range`；`--once --parallel 2` → `job_once_with_parallelism` |

用"声明测试睡 1.2 秒"来制造持租时间，而不是靠运气撞上重叠：重叠是**被观察到的**，不是被假设的。

门禁：`python3 scripts/verify.py --label w06-bounded-parallel-jobs --out evidence/development/2026-09-12-w06-bounded-parallel-jobs --keep-going`

- **22/22 检查 exit 0**；受控负对照 red；指纹配对一致 `7256e13183d9a01d5cf26653bc49d41ceedb03cb74e29ca0bacbd8980bdd0391`；`sources_changed_during_run: 0`。

## 4. 没有做的事（不得读成已实现）

- 上限 4 是**策略**，不是测出来的最优值；没有按 CPU/内存推导并行度，也没有全局（跨进程）并发预算。
- 一个进程内的槽位共享该进程的资源上限（worker 各自是子进程，但没有总量控制）。
- 没有做**大仓库 / monorepo / 多语言 / Windows** 的并发资格：本轮只证明单机单语言下"有界并行 + 每槽位独立租约"这件事，规模结论仍然缺失。
- 没有取消传播：`Ctrl-C` 的行为与顺序模式相同（逐个 job 的控制对象），没有做"一次中断停掉所有槽位"的统一设计。
- 没有队列级的公平性/优先级验证（优先级排序是既有逻辑，未在本轮重新测）。

## 5. 复现

```bash
cargo build
python3 scripts/test_patch.py Parallel      # 2 cases
python3 scripts/test_patch.py               # 39 tests
atlas --store S job enqueue PROJECT --owner o --project p --request-key k1   # ×N
atlas --store S job work --parallel 3
python3 scripts/verify.py --label w06-bounded-parallel-jobs \
  --out evidence/development/2026-09-12-w06-bounded-parallel-jobs --keep-going
```
