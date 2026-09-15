# S5 在最终交付包上的复验

第一次 S5 复验用的是 `cargo fmt` 之前的包；此后契约补了 `search` / `exec-compare` / `ui-state`
三条（一个真实 Agent 正因为契约里查不到 `/api/search` 才改用了 `/api/nodes`），
所以 S5 在**重建后的最终包**上完整重跑了一次。

## 三份产出

| 角色 | 做了什么 | 证据 |
|---|---|---|
| 执行 Agent | 只读接入说明，用公开接口完成"修复金额边界并保留正常情况" | `s5-agent-report-final.md` |
| 独立核对 Agent | 自己打 diff、自己跑断言与 `node --test`、核对检出目录字节、逐条找反例 | 本文件"独立核对结论" |
| 人 | 在工作台定位同一份提案与验证结果，在授权目录应用并核对字节，再撤销 | `s5-final-human-results.json`、`s5-final-review-*.png` |

服务与凭据：`s5-final-credentials.json`（`/tmp/Atlas 首版 S5-final`，独立 store）。

## 执行 Agent 的产出（它自己的报告为证）

- 用 `GET /api/search?q=charge&kind=function` 找到 `charge`（这次契约里能查到 search 了）。
- 提案 A（修复本体）、B（只加回归测试）、C（A+B 合并）三份，均 `state=verified`，均未 apply。
- 建议人应用 C：`3a165427ae04724c7e24708350948eda11ae8fd485aa8686680fd7a2f7720d36`。
- **它自己发现并修正了一个理解偏差**：一次 verify 只把一份提案应用到基线快照，所以 A 单独验证
  看不到新测试、B 单独验证反而失败。它因此提交了合并的 C，才拿到"修复让边界测试转绿"的联合观测。
- 三份验证的测试都是真跑：A `3/3` 退出码 0；**B `pass 3 / fail 1` 退出码 1**（失败详情正是
  `-50 !== 0`）；C `4/4` 退出码 0。
- 它报告了具名拒绝：`POST /api/exec` → `missing_requirements`（`未授予：unknown_calls`，
  `refused_before_spawn`），没有把它当成通过。

## 独立核对结论（另一个 Agent，附反例）

**满足原始需求。** 核对者自己做的：

- 在项目外的临时副本里打上 C 的 diff：`src/money.js` 403 字节 / `test/money.test.mjs` 749 字节，
  sha256 与提案 `patched_digest`（`3ad70605…` / `fb77e93a…`）逐字节相同。
- 自己跑行为探针：`rate=1.5→0`、`rate=0.2→80`、`amount=0→0`、`amount=-5→0` 全 PASS；
  并在**未修复**的原始字节上实测 `rate=1.5 → -50`，证明修复是实质的。
- 自己跑 `node --test`：补丁后 `tests 4 / pass 4 / fail 0` 退出码 0。
- 逐字段核对验证记录，确认没有"没跑说成通过"；确认 B 确实 `exit_code=1`。
- 核对检出目录：`src/money.js` md5 `f11d03f2…`（358B）、`test/money.test.mjs` md5 `4e0d3805…`（499B），
  仍是补丁前字节；C 的 `state=verified`、`target=null`，证明 `/api/patch/apply` 未被执行者调用。

**它列出的偏差（都属轻微，已如实登记，不改执行者报告）：**

1. 报告把 flow 字段 `supported_op_transfers:52` 简写成 `transfers:52`（数值对，字段名被改写）。
2. 报告有一句把测试用例名等同于具体断言，严谨性略欠（数值无偏差）。
3. 报告把失败栈里的临时目录路径省略了中段（常规摘录）。

**它明确声明没验证的**：补丁后源码正文未能从接口读回（`/api/source` 与 `/api/report` 都只服务
本实例钉定的那份分析，见下面"已知限制"）；`patched_snapshot_id` 无法独立复核；
`rate` 传 `NaN` / 对象等遗留形状未被新测试覆盖（核对者实测修复前后语义一致，未引入回归：
`charge(100,{rate:NaN})===100`、`charge(100,{rate:{}})` 为 `NaN`）。

## 人的审阅

`s5-final-human-results.json`：4/4 PASS——工作台能看到同一份提案（作者是 Agent 的会话身份）、
验证结果可读（测试真跑、退出码 0、输出可展开）、应用后检出目录字节真的变成 Agent 那份改动、
撤销后两个文件逐字节回到应用前。

## 这次复验暴露的产品观察（登记为待办，本轮未改）

同一实例的 HTTP 面只服务启动时钉定的那一份分析，但一个显式的 `analysis=` / `analysis_id=`
查询参数会被**静默忽略**：`GET /api/report?analysis=<补丁分析 id>` 仍然返回基线的计数，
`GET /api/source?...&analysis=<补丁分析 id>` 则报 `entity_not_found`。执行 Agent 与独立核对者
都被这一点绊过。

契约里写了"只反映已发布的那个版本"，但静默忽略一个显式参数会让调用者得出错误结论。
更好的做法是：当调用方显式指定了别的分析时**具名拒绝**，并说明本实例服务哪一份、以及
看补丁侧应该读提案的 `verification.graph_diff`。本轮不改（改它要重建包并重跑 S5，
而它不影响任何本次结论）；已写入交付报告的"接下来直接做"。
