# W06：持久作业身份、幂等、租约与崩溃恢复

窗口：2026-09-12/w06-jobs。工作目录 `/Users/yinsijie/CodeRepo/Atlas`。

W06 从 PARTIAL 推进到「身份/幂等/租约/恢复已接通，仍缺持久队列与调度器」。**没有**改动任何分析算法：读写的是作业所有权，不是事实语义。

## 交付

| 位置 | 内容 |
|---|---|
| `crates/atlas-engine/src/job.rs`（新增） | `jobs` 表与租约语义；9 个单测 |
| `crates/atlas-engine/src/store.rs` | `jobs` DDL；抽出 `retry_on_busy`，schema 创建与作业写入共用 |
| `crates/atlas-app/src/main.rs` | 抽出 `run_pipeline`；`job submit/status/list/reap`；心跳线程 |
| `scripts/test_jobs.py`（新增） | 6 个 CLI 级用例；已加入 `verify.py` CHECKS |

## 语义（每条都有测试）

1. **身份**：(owner, project, request_key) 三元组定义请求，`id` 只是句柄，**三元组是唯一权威**。
2. **幂等**：`completed` 重放原 analysis 且不重跑（attempt 不增）；`failed`/`cancelled` 可重试并计入下一次 attempt；同一 key 不同 owner 是不同作业。
3. **租约**：认领/心跳/终态都要求 `state='running'` 且持有者匹配，所以被接管后的迟到结果会被拒绝（`recorded=false`）。
4. **恢复**：租约停止续期是进程死亡的证据；`job reap` 只收割过期 `running`，标记 `failed: lease_expired` 并清空租约，随后请求可重试。

## 过程中发现的三个真实缺陷

这三个都不是靠读代码发现的，而是被真实运行逼出来的：

1. **同一性有两个来源**。`submit_job` 假定行 id 等于三元组哈希，于是 `INSERT OR IGNORE` 被 UNIQUE 约束挡掉、`UPDATE` 却按哈希找行 → 合法重试以 `job_not_found` 失败。以三元组为唯一权威后修复，并加了回归测试。
   —— 由"注入伪造 id 的僵尸作业"暴露。
2. **并发提交报 `database is locked`**。作业写入只依赖 busy timeout；而 SQLite 对某些锁状态会**立即**返回 SQLITE_BUSY 而不咨询 busy handler。项目在发布路径上早已解决过这个问题，作业路径却没有复用。现在两者共用 `retry_on_busy`，且认领、插入与身份查询合并为一个立即事务。
   —— 由并发选主用例暴露。
3. **心跳线程整段睡眠，`join` 要等它睡完**。一个 0.75 秒就能跑完的作业要挂 20 秒（= lease/3）才返回。改为 100ms 短切片后：**20.0s → 1.39s**，幂等重放 0.03s；测试套件 **156s → 12.5s**。
   —— 由逐用例计时暴露。

## 验证

```
python3 scripts/verify.py --label w06-jobs --keep-going     退出码 0
  15/15 检查退出码 0（含新增的 jobs）
  negative-control entry-backfill-frontier: 受控失败
  fingerprint pairing: binary == source
  status PASS · document_errors [] · sources_changed 0 · binary_stale false

cargo test --workspace --locked        0   （63 → 72，新增 9 个 job 单测）
python3 scripts/test_jobs.py           0   （6/6，12.5s）
```

## 资格边界

- **仍无持久队列与调度器**：作业由提交者即刻认领执行，不支持排队等待、优先级或独立 worker 池。
- 断电耐久未资格验证：逻辑原子发布不等于灾难恢复。
- 心跳丢失→取消的**端到端**路径只有单元层覆盖（陈旧持有者无法写终态）；没有让真实心跳在运行中失效的集成用例。
- 多机/多用户未涉及：owner 是调用者声明的字符串，未经认证。
- 本报告不改变 W06 的 `PARTIAL` / `NOT_QUALIFIED`，也不改变其他 W 项状态。
