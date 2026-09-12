# W09：apply/revert 的检出锁

窗口：`2026-09-12/w09-apply-lock`
日期：2026-09-12（Asia/Shanghai）
结论：**DELIVERED**。写入路径现在在整段「校验字节 + 写入」期间持锁，两个进程不可能都通过校验再都写；错误路径也释放锁。

## 1. 之前的窗口

apply 的语义是「先读目标当前字节，确认它仍是提案所依据的钉住字节；然后写」。这两步之间有一个真实窗口：两个 Atlas 进程可以**都**通过第一步，然后都写，第二个赢——而它通过的检查描述的已经是**不存在的检出**了。CLI 与 HTTP 写路径现在都存在（第 10 轮），所以这个窗口不再只是理论问题。

## 2. 现在

- `patch::ApplyLock::acquire(root, holder)`：在检出目录里用 `create_new` 创建 `.atlas-apply.lock`（操作系统保证第二次创建失败），文件里写入**持有者身份**；
- 第二个进程得到 `apply_lock_held:<path>:holder=<who>` —— 具名拒绝，并说清是谁持有，而不是笼统的 "locked"；
- `apply_proposal` / `revert_proposal` 在**任何检查之前**取锁，并持有到操作结束；
- 锁在 guard `Drop` 时释放，**包括每一条错误路径**（字节漂移、路径不存在、写失败……）；
- 崩溃留下的锁会挡住下一次尝试并报出持有者：宁可让人看见"有锁"，也不要让锁悄悄消失而进程还在写。

## 3. 验证

`scripts/test_patch.py` 39 → **42**（新增 3 条）：

| 用例 | 断言 |
|---|---|
| `test_apply_takes_a_lock_so_two_processes_cannot_both_win` | 外部写入 `.atlas-apply.lock`（内容 `another-process`）时 apply 失败、stderr 含 `apply_lock_held` 与持有者、**目标文件一个字节没变**；删除锁后 apply 成功，并且**锁文件已被释放** |
| `test_a_refused_apply_leaves_no_lock_behind` | 检出在验证后被移动 → apply 被拒绝，且**不留下锁** |
| `test_revert_holds_the_lock_too` | 撤销同样持锁：外部持锁时 revert 被拒绝，已应用的字节原样保留 |

门禁：`python3 scripts/verify.py --label w09-apply-lock --out evidence/development/2026-09-12-w09-apply-lock --keep-going`

- **22/22 检查 exit 0**；受控负对照 red；指纹配对一致 `da957f4ec3eea96599434a946513d58907309dec1163ac79e82a63b6e7246fd3`；`sources_changed_during_run: 0`；`clippy -D warnings` 通过。

## 4. 没有做的事（不得读成已实现）

- **没有合并**：撤销是把钉住字节写回，不是三方合并；检出上的新改动会让 apply/revert 拒绝，而不是被合并。
- **没有逐文件磁盘备份副本**：撤销来源是 store 里内容寻址的钉住 blob（读取时重新哈希校验），所以"备份"是那份不可变字节而不是旁边的 `.bak`。若 store 被删且检出被改，就没有恢复来源——这一点必须在文档里说清。
- **锁是单机文件锁**：不跨机器（没有 NFS/分布式锁语义），也**不防手动编辑**（人不受锁约束，只有字节校验能发现）。
- 锁文件可能因崩溃残留（这是刻意的：宁可挡一次也不静默消失），需要人工删除，没有超时自动清理。
- 没有备份/合并/锁定相关的 CLI 子命令（如 `patch unlock`）。

## 5. 复现

```bash
cargo build
python3 scripts/test_patch.py Cli        # 含 3 条锁用例
python3 scripts/test_patch.py            # 42 tests
python3 scripts/verify.py --label w09-apply-lock \
  --out evidence/development/2026-09-12-w09-apply-lock --keep-going
```
