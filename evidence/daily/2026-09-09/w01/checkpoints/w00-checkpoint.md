# W00 Checkpoint — 开工基线与证据隔离

时间: 2026-09-09,时区 Asia/Shanghai(+08:00)
窗口开工(墙钟): 2026-09-09T00:29:44+08:00

## 已完成

1. **受控起始基线** `baseline/source-copy/` + `baseline/source-manifest.json`
   - 54 个受控文件(排除 .git/node_modules/target/local-state/evidence/__pycache__)的 SHA-256 清单。
   - 与 `evidence/foundation/verification.json`(2026-09-08T15:49:08Z)的 35 个 source hash 对比:全部 MATCH,无 mismatch、无 missing。
   - Git 状态快照: 分支 `codex/standalone-foundation`,无任何 commit,全部文件 untracked;空 `git diff` 不证明无改动,已在 manifest 中记录。
2. **`scripts/verify.py` 参数化重写**(schema `atlas.verification.v2`)
   - 输出目录改为 `--out` 显式指定,默认 `evidence/daily/<本地日期>/<label>/`;显式拒绝把输出指向 `evidence/foundation`。
   - Modus 保护检查改为可选: 仅当 `--modus-baseline` 提供基线 hash 文件才检查;Modus 目录缺失时记录 "cannot verify: Modus checkout absent; no protection is asserted",不再伪造"N 个文件未变"。Atlas 产品验证不再依赖同级 Modus 仓库存在。
   - 记录 git head 状态与 whitespace 检查的真实覆盖范围(无 HEAD 时 `git diff --check` 几乎不覆盖 untracked 文件,PASS 不等于空白审计)。
   - 失败后未运行的检查记录为 `not_run_after_failure`,不再静默消失。
3. **基线验证结果** `baseline/verification/`: 9 项检查全部 PASS,退出码 0(rust-format/clippy/tests/build、worker-tests、integration、calculator、web-syntax、whitespace)。工具链: 见 verification.json。

## 下一步

进入 W01: worker 输出版本化语句/操作/Scope/Binding 的 Flow IR,Rust 校验。
