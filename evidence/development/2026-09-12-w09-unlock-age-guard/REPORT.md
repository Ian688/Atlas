# W09：清锁的年龄门

窗口：`2026-09-12/w09-unlock-age-guard`
日期：2026-09-12（Asia/Shanghai）
结论：**DELIVERED**。`patch unlock` 之前可以把**正在被写入**的锁清掉——那等于把两个写者放回同一个检出，正是锁要防的事。现在默认只清"足够老"的锁。

## 1. 行为

- `patch unlock --target <checkout>`，`--stale-after <SECONDS>`（默认 300）：
  - 锁的年龄 ≥ `--stale-after` → 清除，并报出 `holder` 与 `since_ms`；
  - 锁**年轻**、或锁文件里**没有时间戳**（年龄未知）→ 拒绝：`lock_not_stale:<path>:holder=<who>:age_ms=<ms|unknown>:stale_after_s=<n>:use --force to clear a lock that may still be held`；
- `--force` 是唯一越过年龄门的方式，且它仍然报出年龄（未知就是 `null` + `since_unknown`），不猜。

年龄是这里**唯一**可得的证据（锁文件只记持有者与取锁时刻），所以"年轻或未知"必须由人显式覆盖，而不是由工具替他判断。

## 2. 验证

`scripts/test_patch.py` 44 → **44**（同一条用例被重写为完整序列，覆盖三种情形）：

1. **新鲜**锁（`now`）→ `patch unlock` 被拒 `lock_not_stale`，**锁仍在**，随后 `patch apply` 仍被 `apply_lock_held` 挡住；
2. `--force` → 清除成功；
3. **10 分钟前**的锁 → 无需 `--force` 即可清除，并报出 `holder=dead-process`；
4. 无锁时 → `no_apply_lock`（不是静默成功）；
5. 最后同一提案**真的可以 apply**（证明解锁确实解锁了）。

门禁：`python3 scripts/verify.py --label w09-unlock-age-guard --out evidence/development/2026-09-12-w09-unlock-age-guard --keep-going`

- **22/22 检查 exit 0**；受控负对照 red；指纹配对一致 `e542876700d20f41abd0d354830695e1b50daf7657374141e052a1a429251769`；`sources_changed_during_run: 0`；`clippy -D warnings` 通过。

## 3. 没有做的事

- 年龄门是**启发式**：它只能防"太年轻"，防不了"一把真正很久以前的锁其实还属于一个卡住的进程"（那种情况只能靠人看 `holder`）。
- 时间戳是**本地墙钟**：时钟回拨会让年龄变成负数（表现为"不 stale"→ 拒绝，方向是安全的），但不能用于严格时序推理。
- 没有锁租约/心跳（不像作业租约那样自动过期）：清理始终是人的动作。
- 仍是单机文件锁，不约束人工编辑；没有合并与逐文件磁盘备份。

## 4. 复现

```bash
cargo build
python3 scripts/test_patch.py Cli        # 44 tests
python3 scripts/verify.py --label w09-unlock-age-guard \
  --out evidence/development/2026-09-12-w09-unlock-age-guard --keep-going
