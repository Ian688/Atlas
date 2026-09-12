# W09 补片：补丁验证作为持久作业（队列按 kind 分派）

窗口：2026-09-12/w09-queued-verify。工作目录 `/Users/yinsijie/CodeRepo/Atlas`。

之前 `patch verify` 只能前台执行：一次完整索引管线占着终端，长项目上尤其明显。本补片把它接进 W06 的持久作业队列，
顺带把队列从"index 专用"变成"按 kind 分派"——两种作业共用同一套身份、优先级、租约、心跳与崩溃收割。

## 一、交付

| 位置 | 内容 |
|---|---|
| `crates/atlas-engine/src/job.rs` | `kind`（`index` / `patch_verify`）+ `is_known_kind`；`JobRequest` 带 kind；root 只对 index 必填 |
| `crates/atlas-engine/src/store.rs` | `jobs.kind` 纯增量加列迁移，默认 `index`（旧库里的行本来就是 index 请求） |
| `crates/atlas-app/src/patchwork.rs` | `verify_proposal`：前台与排队共用的一段代码 |
| `crates/atlas-app/src/main.rs` | `patch verify --enqueue --owner X [--request-key K] [--priority N]`；`StoredVerify` 自描述参数；`claimed_kind` 分派 |
| `scripts/test_patch.py` | 新增 `Queued` 类 5 个用例；同时把测试类去重（原来 16 个 CLI 用例被执行了三遍） |

## 二、为什么不是"再写一条排队路径"

`patch verify` 前台路径与 `job work` 的 `patch_verify` 路径调用**同一个 `verify_proposal`**。
两条路径只差"谁在等"：一条在终端里等，一条由租约持有者跑完写终态。因此不存在"排队版验证更宽松/更严格"的可能。

终态 artifact 也统一了：index 作业记录新 analysis，`patch_verify` 作业记录**补丁树派生的那个 analysis**。
两者都在 `jobs.analysis_id` 里，因为它回答的是同一个问题——"这个请求产生了什么"。

## 三、隐私与失败语义

- **自描述**：`StoredVerify` 随作业行存储（node/worker/期限/test argv），工人读行里的参数，而不是拿自己的默认值顶替别人的请求。
- **一行描述不了自己怎么跑就判失败**：期限越界（如 `index_deadline_seconds=0`）→ 作业 `failed`，`terminal_reason` 写明原因，提案保持 `proposed`。测试用手写坏行验证了这条。
- **幂等**：同一 `(owner, project, request_key)` 是一行；完成后重排报告 `already_completed`，而不是让完成的验证看起来还在排队（这是顺带修掉的一处误导文案）。
- **前台不需要身份**：`--owner` 只在 `--enqueue` 时必填。前台命令要求一个存在只为被忽略的 flag 是坏的接口。

## 四、实测

```
patch verify <id> --enqueue --owner me --request-key k1 --test-argv '["node","-e","process.exit(0)"]'
  → queued | kind patch_verify | state queued
job work --once
  → ran 1 | completed | kind patch_verify
    job.analysis_id  819cb3e108c5397b…  == verification.patched_analysis_id
    test exit 0
  → 提案状态 proposed → verified，检出目录零改动
patch verify <id> --enqueue --owner me --request-key k1
  → already_completed
```

多 kind 共存（一次 `job work --max 4`）：`kinds == ["index", "patch_verify"]`，两个都 `completed`。

## 五、资格边界

- 队列仍是单 worker 串行、需人工触发；没有守护进程、并行 worker 池、公平性或配额（与 W06 同一缺口）。
- `verify` 会在同一 store 里多发布一个 analysis（补丁树），长期累积且无回收策略。
- 排队验证与前台验证共用代码，但**并发两个 worker 对同一提案**仍由 `mark_patch_verified` 的单向状态迁移挡住：
  后者拿到 `proposal_verification_lost_a_race`，作业判失败。这是有意的（不接受重复验证覆盖已发布的验证结果），但会浪费一次索引。

## 六、验证

```
python3 scripts/verify.py --label w09-queued-verify \
  --out evidence/development/2026-09-12-w09-queued-verify --keep-going   退出码 0
  21/21 检查退出码 0
  negative-control 受控失败 ✓   fingerprint pairing: binary == source ✓
  status PASS · document_errors [] · sources_changed 0 · binary_stale false
```

| 命令 | 退出码 | 结果 |
|---|---|---|
| `cargo test --workspace --locked` | 0 | 111 |
| `python3 scripts/test_patch.py` | 0 | 25/25（CLI 16 + 排队 5 + HTTP 3，已去重） |
| `python3 scripts/test_jobs.py` | 0 | 11/11（队列行为不因 kind 受损） |
