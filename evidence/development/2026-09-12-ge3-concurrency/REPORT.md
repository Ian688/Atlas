# GE-3 并发资格：写锁是等待，不是报错

窗口：`2026-09-12/ge3-concurrency`
日期：2026-09-12（Asia/Shanghai）
结论：**DELIVERED**。真实项目上的并发索引第一次运行就是**失败**的；这一轮把它变成"等待 + 具名拒绝 + 并发下同 id"，并用同一棵真实树做了测量。

## 1. 缺陷是怎么发现的（不是猜的）

GE-3 要求并发资格。第一次实测就红了——对同一份已钉住快照并发跑 3 个 `atlas index`（同一个 store）：

```
run1 exit=0
run2 exit=1
run3 exit=1
Error: Sql(SqliteFailure(Error { code: DatabaseBusy, extended_code: 5 }, Some("database is locked")))
```

store 没有坏，分析也没有错：一个进程正在**发布**（publication 持写锁），另外两个撞上写锁后，用的是一个**固定 5 秒**的重试预算——比一次真实发布短得多，于是放弃并把 SQLite 的原文当结论抛了出来。

同一轮还暴露了第二个问题（读路径也取写锁）：`Store::open` 每次都对整个 schema 跑一遍 `CREATE TABLE IF NOT EXISTS`。即使什么都不建，它也会取写锁，因此**任何**命令（包括 `report`）都要排在发布者后面。再加上 schema 是**逐语句**执行的（没有包在事务里），并发首开空 store 时，输的进程可能已经看到 `analyses` 却还没看到 `jobs`，随后以 `no such table: jobs` 失败。

## 2. 修复

| 问题 | 修复 | 证据 |
| --- | --- | --- |
| 5 秒固定预算 | 写锁等待改为**可取消的轮询**：每次尝试之间走取消控制点，因此等待可被打断；默认预算 180 秒，`ATLAS_STORE_BUSY_TIMEOUT_MS` 可覆盖 | `crates/atlas-engine/src/store.rs::retry_on_busy_for` / `writer_budget` |
| `database is locked` 原样抛出 | 预算耗尽返回**具名拒绝**：`store_writer_timeout:budget_ms=400:waited_ms=…:another process holds the SQLite writer lock; raise ATLAS_STORE_BUSY_TIMEOUT_MS …` | `test_a_spent_budget_is_a_named_refusal_not_a_raw_sqlite_error` |
| 读取排在发布者后面 | 已初始化的 store **只读打开**：仅在 schema 缺失时才创建 | `test_reading_does_not_queue_behind_a_writer`（读必须 < 6s，写锁被外部持有 7s） |
| 逐语句建表 + 单表判断 | schema 创建放进**一个 IMMEDIATE 事务**，并在事务内**重查**三张表是否齐全；`jobs_queue` 索引同样按需创建 | `test_concurrent_first_opens_converge_on_one_analysis` |
| busy handler 睡在 SQLite 里 | 连接层的 `busy_timeout` 刻意保持 25ms：真正的等待由可取消的轮询完成 | 同上 |

## 3. 真实项目资格（rxjs@7.8.1）

`python3 scripts/bench_concurrency.py --parallelism 3 --out evidence/development/2026-09-12-real-project/rxjs/concurrency.json`

被测量的字节：`rxjs@7.8.1` tarball，sha256 `c532167725ab7d085123209156c93cef22f2479cb9c8527060f1cd903aa9d149`（脚本在索引前校验），树摘要 `b2bbb6a149d2cb15d561e44ce88a13f1a47ad8c8c65dc0e4e889fb53436d0ebe`，2277 个文件、其中 1255 个 JS/TS 源文件（`.js` 754 / `.ts` 501，共 2,531,086 字节）。8 逻辑核，并行度 3 是脚本被告知的取值，不是测量出来的最优值。

| 场景 | 每个进程 wall | 峰值 RSS | 退出码 | analysis id |
| --- | --- | --- | --- | --- |
| 串行基线 | 132.98 s | 534,519,808 B | 0 | `dc2f21c4…` |
| 3× 同一 store | 220.2 / 220.2 / 220.6 s | 524.8 / 518.4 / 522.5 MB | 0 / 0 / 0 | 全部 `dc2f21c4…` |
| 3× 各自 store | 237.3 / 238.1 / 238.2 s | 587.2 / 582.7 / 557.2 MB | 0 / 0 / 0 | 全部 `dc2f21c4…` |

- **承重断言**：3 并发（共享 store 与分 store 两种）全部发布与串行基线**逐字节相同**的 analysis id；每个进程都报 6573 个函数。
- **事后读回**（在 3 个写者共享的 store 上）：6573 函数 / 8938 节点 / 25969 边 / 1255 源文件 / 167 未知区域 / 19 个递归 SCC，与基线一致；串行 store 的读回同样一致。
- 共享 store（220 s）与各自 store（238 s）几乎相同 ⇒ **本机瓶颈是 CPU（解析/派生），不是 store 串行化**。这是测量得到的事实，不是吞吐模型；脚本明确不做因果声明。
- 3 并发 220 s vs 串行 133 s ⇒ 3 倍工作量用了约 1.66 倍墙钟（约 1.8× 吞吐），单机 8 核、无超线程调度分析。

## 4. 自动化检查（进入常设门禁）

新增 `scripts/test_store_concurrency.py`（5 个用例，已在 `verify.py` 的 CHECKS 中，运行约 25 s）。它不是"希望撞上"的竞态测试：外部 Python 连接用 `BEGIN IMMEDIATE` **确定性地**持有写锁 7 秒，然后断言 Atlas 的行为。

1. 写必须**等待**并成功（实测 wall ≥ 6 s）。
2. **受控负对照**：同一情形把预算设为 400 ms ⇒ 必须**具名拒绝**，且在被持锁期间就返回。没有这一条，第 1 条可能只是"那次运行根本不需要锁"。
3. 读**不得**等待（wall < 6 s）。
4. 空 store 上 3 个进程并发首开 ⇒ 全部 exit 0，且发布同一个 id，函数计数与 `report` 一致。
5. 同一 `request_key` 从两个进程并发入队 ⇒ 一个 `queued`、一个 `already_queued`，只有一个作业行；不同 key 仍是不同作业。

## 5. 门禁结果

`python3 scripts/verify.py --label ge3-concurrency --out evidence/development/2026-09-12-ge3-concurrency --keep-going`

- **22/22 检查 exit 0**（新增 `store-concurrency`）。
- 受控负对照 red：`ATLAS_FORCE_ENTRY_BACKFILL=1` → exit 1。
- 指纹配对一致：`8a06eaf573d607b41e337977b6145c70c4edd6feb0e7cb87f4b473e85beee09b`；`sources_changed_during_run: 0`。

## 6. 没有做的事（不得读成已实现）

- 并发资格**只到 N=3、单机、单语言（JS/TS）**。大仓库/monorepo、多语言、Windows、跨机器都未资格。
- **没有有界并行策略**：并发度是调用者给的，Atlas 不按核数或内存推导并行上限，也没有队列级的并行 worker 池（`job work --max` 是"最多做几个"，不是"同时做几个"）。
- 没有对 `blobs` 目录的 GC；没有数据库迁移/回收策略；没有断电耐久（目录 fsync）承诺。
- 等待预算耗尽后的行为是**拒绝**，不是排队重试到天亮：这是有意的（有界），但没有"稍后自动重试"的机制。
- 数字来自这一台机器（macOS 15.7.9 x86_64，8 逻辑核，debug 构建）；不构成跨机器或 release 构建的结论。

## 7. 复现

```bash
cargo build
python3 scripts/test_store_concurrency.py                 # 5 tests, ~25 s
python3 scripts/bench_concurrency.py --parallelism 3 \
  --out evidence/development/2026-09-12-real-project/rxjs/concurrency.json
python3 scripts/verify.py --label ge3-concurrency \
  --out evidence/development/2026-09-12-ge3-concurrency --keep-going
```
