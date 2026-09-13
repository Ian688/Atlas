# W09：元素访问赋值目标（两侧一起改）

窗口：`2026-09-12/w09-element-target`
结论：**DELIVERED**。上一轮归因指出的既有限制被修掉，**317 → 10**。

## 1. 改动（合约 / worker / 引擎三处）

- **合约** `crates/atlas-contract/src/flow.rs`：`AssignTarget` 新增 `Element { object, key }`。
  注释写明它与 `Unknown` 的区别：location 不可命名，所以不能是 property，也**不得**声称写了某个绑定；
  但它**仍然是一次写**，且 object 与 key **仍然要被子求值**。
- **worker** `assignTarget()`：`ts.isElementAccessExpression` → `{target:'element', object, key}`；
  `obj[]`（错误恢复 AST）用 `element_key_missing` 的未知表达式兜底，不抛错。
- **引擎** `flow.rs`：
  - 新增求值分支：**按 JS 顺序求值 object → key → value**，再发出写入；
  - 写入记为 `UnknownOp { reason: "element_write_location_unknown:<op>" }`——
    **具名说明"位置未知"**，而不是原来的"目标未建模"；
  - 跨度校验覆盖 object 与 key 两个子表达式。

**刻意的取舍**：我**没有**新增 `OpKind`（例如 `ElementWrite`）与配套的求解器语义。
那是一次未经充分验证的大改（写堆、def-use、字段级影响都要动）；本轮先把
"目标未建模 ⇒ 子表达式与副作用一起丢失"这条修掉，并把未知**说准确**。
常量 key 收敛为 property 这一条（上一轮报告里提过）**没有做**，见 §4。

## 2. 真实数据（rxjs，6573 个同名函数逐项对比）

| 指标 | 改前 | 改后 |
|---|---|---|
| 带 `unmodeled_assignment_target` 的函数 | **317** | **10** |
| 带 `element_write_location_unknown` 的函数 | 0 | **307** |
| flow 层调用点 | 11,428 | **11,440（+12）** |
| CFG 块总数 | 47,718 | 47,718 |
| 返回值无结论 | 5,627 | 5,627 |
| **块数减少的函数（回退）** | — | **0** |

`+12` 个调用点正是 object/key 子表达式里的调用——以前它们随目标一起消失。
没有回退，也没有"块数变了但其实只是换了个说法"。

## 3. 验证

- worker 测试 **17/17**；`cargo test -p atlas-engine` 通过；
- 门禁 **25/25 exit 0**，受控负对照 red，指纹配对一致，`sources_changed 0`；
- 全库逐函数对照见 §2（facts 表聚合，非抽样）。

## 4. 没有做的事（不夸大）

- **写入语义没有变精确**：仍然走 `UnknownOp`，所以该处的值状态照旧降级为未知；
  变的是"未知被说准了"与"子表达式不再丢失"。真正的 `ElementWrite`（写堆、位置未知、
  不声称具体绑定被写）需要新的 `OpKind` 与求解器支持，**未做**；
- **常量 key 未收敛为 property**（`obj['x'] = 1` 现在仍是 element）：这一条我上一轮提过，
  本轮**没有实现**，因为要判断 key 是否为常量字符串需要看已 lower 的表达式形态，
  而我不想在没有用例的情况下猜它的形状；
- **仍未归因**：剩下的 10 个带 `unmodeled_assignment_target` 的函数（多半是解构赋值等其他形状）；
  非循环的 275 个函数也只做了整体归因，没有逐类分清；
- 只核对了 rxjs 一个项目。
