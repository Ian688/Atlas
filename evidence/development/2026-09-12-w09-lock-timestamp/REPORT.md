# W09：锁文件记录取锁时刻

窗口：`2026-09-12/w09-lock-timestamp`
日期：2026-09-12（Asia/Shanghai）
结论：**DELIVERED**。上一轮留下的缺口之一——锁文件里只有持有者、**没有时间**——被补上，而且是"缺就说不缺就报"的方式，不是猜。

## 1. 行为

锁文件现在是两行：持有者、取锁毫秒时间戳。

- 被挡住时：`apply_lock_held:<path>:holder=<who>:since_ms=<ms>`；
- `patch unlock` 报出 `holder` 与 `since_ms`；
- **旧格式**（只有持有者一行）不猜时间：`since_ms=unknown`（拒绝信息）/ `since_ms: null` + `since_unknown: "lock_file_has_no_timestamp"`（解锁输出）。

"谁、从什么时候开始持有"正是人判断这把锁是不是真的被遗弃所需要的信息；猜一个时间比没有时间更糟，因为它看起来像证据。

## 2. 验证

`scripts/test_patch.py` 43 → **44**：

- 新增：手写 `other-run\n1700000000000\n` → apply 被拒，stderr 里同时有 `apply_lock_held` 与 `since_ms=1700000000000`；
- 扩展（上一轮的 unlock 用例）：手写的**无时间戳**锁 → `since_ms` 为 `null` 且 `since_unknown=lock_file_has_no_timestamp`，随后解锁成功、同一提案可以被 apply。

门禁：`python3 scripts/verify.py --label w09-lock-timestamp --out evidence/development/2026-09-12-w09-lock-timestamp --keep-going`

- **22/22 检查 exit 0**；受控负对照 red；指纹配对一致 `b76bbe10d8d2a2e7cb761e051b2305ceec8db6adb4f7d1b179d0d3e20fb9adea`；`sources_changed_during_run: 0`；`clippy -D warnings` 通过。

## 3. 没有做的事

- 锁仍是**单机文件锁**：不跨机器、不约束人工编辑、没有超时自动过期；
- 时间戳是**本地墙钟**（`now_ms`），不是单调时钟：可用于"看起来很久了"，不能用于严格时序推理；
- 没有锁历史（只保留当前持有者）；提案上的 actor 仍只有最后一次；
- 没有合并与逐文件磁盘备份（撤销来源是内容寻址的钉住 blob）。

## 4. 复现

```bash
cargo build
python3 scripts/test_patch.py Cli        # 44 tests
python3 scripts/verify.py --label w09-lock-timestamp \
  --out evidence/development/2026-09-12-w09-lock-timestamp --keep-going
```
