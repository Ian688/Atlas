# S5 独立核对：另外一个 Agent 复核执行者的产出

核对者的身份：一个**没有参与这次任务**的编程 Agent，只拿到原始需求、执行者声称的产出、
样本项目路径与服务凭据。它的职责是找反例，不是复述。

被核对对象：执行者 Agent 用 Atlas 公开接口完成的 `charge` 金额边界修复
（提案 `a41f014faaf6d1e26576f7093f665279b82a4abd0f15e930e015217903f2378f`）。

## 结论

**这次修改满足原始需求。** 三条硬指标由核对者亲手复现，不是转述：

| 核对项 | 核对者实际做的事 | 结果 |
|---|---|---|
| 边界被真的修复 | 在项目外的临时副本里打上提案 diff，自己跑断言 | `charge(100,{rate:1.5})` 未修复时 `-50`，修复后 `0` |
| 正常情况未变 | 同上 | `0.2→80`、`0→0`、`-5→0`、`-0.5→100`、`1→0`，6/6 通过 |
| 自带测试仍通过 | 在副本里自己跑 `node --test` | `tests 4 / pass 4 / fail 0`，退出码 0 |
| 改动范围干净 | 读 `GET /api/patch?id=…` 的 diff 与 `validation.files[].patched_digest` | 只有 `src/money.js` 夹取改动 + `test/money.test.mjs` 一条回归测试；产物 sha256 与提案声明的 `patched_digest` **逐字节相同** |
| 验证记录真实 | 逐字段对照 `verification.test` | `ran/observed/passed/exit_code/argv/patched_analysis_id/stdout` 全部与声称一致，无"没跑说成通过" |
| 检出目录未被偷偷改 | `shasum -a 256` + `GET /api/source` | `src/money.js` 仍是 358 字节、sha256 与基线 blob **完全相同**，磁盘上仍是有 bug 的那一行；`Math.min(1, Math.max(0, raw))` 出现 0 次 |
| 没有替人落地 | 查 `GET /api/agent/requests` | 队列为空，`/api/patch/apply` 未被执行者调用 |

核对者还独立确认了执行者报告里**可核查**的部分：基线 `function_count=6 / call_count=15 /
unresolved_call_count=9`、源码 blob、`reach?direction=out` 为空且 `Math.round` 未解析、
`/api/exec` 与 `/api/exec-compare` 都以 `missing_requirements`（`未授予：unknown_calls`，
`refused_before_spawn`）被拒。

## 核对者发现的反例（如实登记）

**1 处事实夸大（执行者报告 §2）。**
报告写 `GET /api/reach?direction=in` 有 **3 条入边**；实际返回 **4 条**——它把"3 个调用者"
写成了"3 条边"。`symbol:test/money.test.mjs:278:360` 那个测试函数里 `charge` 被调用两次
（`charge(0,null)` 与 `charge(-5,null)`），是两条独立边。偏差偏小，不影响修复结论，
但属于把调用者数当边数的事实性偏差。

**1 处因时间线造成的状态过时（不是执行者的问题）。**
报告写提案 `state=verified`；核对时读到 `state=reverted`，
`terminal_reason=reverted_by:session-bf8e90a7-644`。这是**人**在报告写成之后在工作台
点了"应用 → 核对字节 → 一键撤销"造成的（见 `s5-human-results.json`，两项均 PASS）。
报告写作时 `verified` 属实。

## 核对者明确声明**没有**独立验证的范围

- 补丁分析的图计数与节点增删（`functions 6→7`、`calls 15→22`、`unresolved_calls 9→14`、
  `nodes.added/changed/removed`）：HTTP 面同一实例只服务它启动时钉定的那一份分析，
  核对者拿不到 patched 分析的图来重算，只能确认这些数字与 `verification.graph_diff` 自洽、
  且与它能验证的字节事实不矛盾。
- 执行者自述"读过样本文件核对字节、用 `git apply -p1` 演练过一次"：这是自述，接口侧无法证实；
  但它明确声明不作为验证证据，且核对者的实测结论与之一致。

## 这次核对暴露的产品观察（不是本次修改的缺陷）

同一实例的 HTTP 面**只服务启动时钉定的那一份分析**：`/api/report`、`/api/nodes`、
`/api/flow` 等会忽略调用方传来的 `analysis_id`。这是契约里写明的前提（"只反映已发布的那个版本"），
但对一个想"比较补丁前后"的调用者来说并不直观：要看补丁侧的图，只能读提案
`verification.graph_diff`，或者另起一个服务指向 patched analysis id。

登记为已知限制，本次不改：改它等于给 HTTP 面加一个跨分析参数，
与"一个实例一份分析、跨版本一律不重指"的既有边界冲突。
