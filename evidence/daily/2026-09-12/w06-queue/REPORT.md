# W06：持久队列、优先级与调度

窗口：2026-09-12/w06-queue。接续同日 `w06-jobs`（身份/幂等/租约/恢复）。工作目录 `/Users/yinsijie/CodeRepo/Atlas`。

本轮补上 W06 最后一块：**作业可以被排队而不是只能即刻执行**，并补了一次克制的加列迁移。未改动任何分析算法。

## 交付

| 位置 | 内容 |
|---|---|
| `crates/atlas-engine/src/job.rs` | `JobRequest`（把身份收进结构体）、`enqueue_job`、`claim_next`、`cancel_queued`、`priority`/`options` 字段；单测 9 → 14 |
| `crates/atlas-engine/src/store.rs` | 队列索引；**加列迁移**（仅处理可安全回放的纯增量变更） |
| `crates/atlas-app/src/main.rs` | `job enqueue/work/cancel`；抽出 `run_claimed_job` 供 submit 与 work 共用；`IdentityArgs`/`RunnerArgs` 参数复用 |
| `scripts/test_jobs.py` | 6 → 11 个 CLI 级用例，含迁移与优先级 |

## 语义（每条都有测试）

1. **入队不执行**：`enqueue` 后状态为 `queued`、无租约、无 analysis；同请求重复入队仍是一行，可提优先级。
2. **调度顺序**：优先级高者先服务，同优先级按入队时间最旧优先。
3. **自描述的请求**：runner 参数随作业行存储，因此排队请求描述自己怎么跑，而不是取决于哪个 worker 捡到它。
4. **崩溃续跑**：租约过期的 `running` 会被工人重新认领（attempt +1）。这是**队列**对租约的用法——崩溃不该让队列停摆到有人注意。重跑在这里是安全的，因为发布幂等且不可变。
5. **排队取消**：`queued` 可取消；`running` 不可被旁观者取消——它属于租约持有者，否则租约就没有意义。

`reap` 与 `claim_next` 是**两种不同意图**：前者是"放弃这次运行并判失败"，后者是"换个人接着跑"。

## 过程中发现的缺陷

1. **索引先于加列执行，迁移永远跑不到**。`CREATE INDEX ... ON jobs(state,priority,created_at)` 在批量建表里，而旧库那时还没有 `priority` 列 → 开库即失败。
   —— 由**迁移测试**暴露；修复为"先迁移、再建依赖新列的索引"。
2. **`submit_job` 参数达 8 个**（5 个同类型字符串 + holder + lease），靠位置区分 owner 与 project。Clippy 拦下后收进 `JobRequest`。
   —— 由 `-D warnings` 暴露。

## 验证

```
python3 scripts/verify.py --label w06-queue --keep-going     退出码 0
  15/15 检查退出码 0（含 jobs 11 个用例）
  negative-control 受控失败 ✓   fingerprint pairing: binary == source ✓
  status PASS · document_errors [] · sources_changed 0 · binary_stale false

cargo test --workspace --locked   0   （72 → 77）
cargo clippy ... -D warnings      0
python3 scripts/test_jobs.py      0   （11/11，19s）
```

## 资格边界（W06 仍为 PARTIAL / NOT_QUALIFIED）

- **owner 未经认证**：它是调用者声明的字符串。W06 合同里"服务端验证权限与版本"未实现；HTTP 层仍只有本地会话令牌，作业 API 尚未暴露到 HTTP。
- **没有守护进程或并行 worker 池**：`job work` 需人工触发，无重试退避、公平性或配额；单个 worker 串行执行。
- 断电耐久未资格验证。
- 迁移策略只覆盖**纯增量**变更；非增量变更（改列类型、拆表）仍无迁移与回滚方案。
- 心跳丢失→取消的端到端路径仍只有单元层覆盖。
