# W09：`patch unlock` —— 锁的操作面

窗口：`2026-09-12/w09-patch-unlock`
日期：2026-09-12（Asia/Shanghai）
结论：**DELIVERED**。上一轮引入的检出锁有一个刻意的性质：崩溃残留的锁会挡住下一次 apply 并报出持有者。本轮补上它缺的那一半——**受支持的清理方式**。

## 1. 为什么需要它

锁挡住写入是有意的（"宁可挡一次，也不要在进程还在写的时候让锁悄悄消失"），但在此之前的唯一清理方式是 `rm`。这有两个问题：一是没有记录谁持有过，二是手滑删错目录没有任何反馈。`patch unlock` 同时解决这两点。

## 2. 行为

```
atlas --store S patch unlock --target <checkout>
{ "removed": true, "path": ".../.atlas-apply.lock", "holder": "dead-process", "note": "..." }
```

- 删除**之前**报出原持有者：删掉之后，这行输出就是唯一的记录；
- **没有锁时报错**（`no_apply_lock:<path>`），而不是静默成功——目录写错不该看起来像"已清理"；
- 不改变任何提案状态：清锁只是清锁（被拒绝的 apply 仍需重新决定）。

## 3. 验证

`scripts/test_patch.py` 42 → **43**：写一个伪造的残留锁（持有者 `dead-process`）→ `patch unlock` 报告 `removed`/`holder` 且文件消失 → 再次 unlock 以 `no_apply_lock` 失败（stderr）→ **同一个提案现在可以真的 apply**（证明解锁确实解锁了，而不是只删了个文件）。

门禁：`python3 scripts/verify.py --label w09-patch-unlock --out evidence/development/2026-09-12-w09-patch-unlock --keep-going`

- **22/22 检查 exit 0**；受控负对照 red；指纹配对一致 `e27c2ee2853a3c0d4ae0db2df36896a75e856984cd463a57602fd4d2d5f8a21f`；`sources_changed_during_run: 0`；`clippy -D warnings` 通过。

## 4. 没有做的事

- 锁仍然是**单机文件锁**：不跨机器，也不约束人工编辑文件（只有字节校验能发现）。
- 没有锁超时/租约：残留锁必须先被显式清理，不会自动过期。
- 没有"谁在何时加的锁"的时间戳记录（锁文件里只有持有者字符串）；审计轨迹仍只有提案上的最后一次 actor。
- 没有合并与逐文件磁盘备份（撤销来源是内容寻址的钉住 blob）。

## 5. 复现

```bash
cargo build
python3 scripts/test_patch.py Cli        # 43 tests（含 unlock）
python3 scripts/verify.py --label w09-patch-unlock \
  --out evidence/development/2026-09-12-w09-patch-unlock --keep-going
```
