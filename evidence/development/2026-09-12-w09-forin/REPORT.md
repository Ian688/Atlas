# W09：for...in / for...of 建模（未知区域 167 → 79 → 0）

窗口：`2026-09-12/w09-forin`（含一次被门禁判红后的修正重跑）
结论：**DELIVERED**，但这一轮的过程比结果更值得记——**门禁红了一次，是我改了契约没改测试**。

## 1. 问题

`for...in` / `for...of` 返回**语句级 unknown**，代价是循环头与循环体的调用**全部消失**（rxjs 79 处，全在打包产物里）。

## 2. 改动（只用 IR 已有形式）

- 循环 → `while`，条件就是被迭代的表达式（头部的调用保持可见）；
- 循环变量按真实关键字登记（`const` 不谎报成 `let`），**并发出"每次迭代赋值、值未知"的赋值语句**；
- 无声明形式 `for (x of y)` 显式防护（否则 `.declarations` 未定义会抛错，变成更难看的 `internal_lowering_failure`）。

## 3. 两个由我自己引入/遗漏的问题（都在本轮修掉）

**(a) 循环变量赋值没发出 → 引擎报 `tdz_read_possible_reference_error`。**
那是在断言"这段代码可能抛 ReferenceError"——**假的**。真实语义是循环每次迭代都会赋值，只是值未知。
补上赋值语句后，该理由消失，换成正确的具名说明：`unknown_callee_effects` +
`unmodeled_construct:for_in_of_element_unknown`（元素值未知），而**未知区域仍然是 0**。

**(b) worker 生产者版本两轮没升。** 指纹只覆盖 `crates/**` 与 web 资产，**不含 worker**；
我第 6、7 轮改的是 worker 的分析行为，产出的事实变了、生产者身份却没变——同名的两次分析可以有不同事实。
已把 `WORKER_PRODUCER` 从 `worker/0.2.1` 升到 `worker/0.2.2`（`crates/atlas-contract/src/lib.rs`），
指纹随之改变。这是本轮最该记的一条：**改行为必须改身份，否则比较会骗人。**

## 4. 旧契约的两份副本，都改写了（不是删掉）

| 位置 | 旧断言 | 新断言 |
|---|---|---|
| `workers/typescript/tests/flow.test.mjs` | for-of 必须是语句级 `unknown`，且有 `FLOW_UNKNOWN_REGION` | 必须是 `while`、循环体必须被 lower、且**不得**留下未知区域（旧契约写在注释里） |
| `scripts/test_integration.py` | `flow_unknown_regions > 0`；profile 含 `unmodeled_construct:for_in_of_iteration` | 区域数为 0；profile 含 `unmodeled_construct:for_in_of_element_unknown` 与 `unknown_callee_effects` |

**第一次门禁是红的**（integration exit 1），因为只改了 worker 测试、没改集成测试。这暴露了一个真事实：
**同一个契约在仓库里有两份副本**，改契约必须同时改两处。

## 5. 真实数据

| | 初始 | 第 6 轮 | 本轮 |
|---|---|---|---|
| 显式未知区域（rxjs） | 167 | 79 | **0** |
| 文件 / 函数 / partial | 1255 / 6573 / 0 | 同 | **1255 / 6573 / 0** |

三轮闭环：UI 分解 167 = 79+78+10 → 修后两项（−88）→ 修前一项（−79）→ 0，每一步都精确命中预测。

## 6. 诚实标注：归零 ≠ 精确建模

循环次数未知；元素类型/形状未知；`for...in` 与 `for...of` 走同一路径、键值语义差异未区分；
**新可见的循环内调用没有逐条核对**是否正确解析；本轮未做质量核查，只做了"不再整块放弃"。

## 7. 验证

worker 17/17；集成 18 OK；门禁 **25/25 exit 0**，受控负对照 red，指纹随版本升级而改变、双向一致，`sources_changed 0`。

## 8. 追加：第二次门禁红，同一个教训

升 `WORKER_PRODUCER` 之后门禁**再次判红**：`fingerprint pairing: binary=None`。
原因：**worker 自己也有一份生产者字符串**（`parse.mjs`、`flow.mjs` 各一处），我只升了引擎那一份；
引擎对生产者版本是"不符即具名拒绝"，于是索引直接失败、二进制报不出指纹。
两份 worker 内字符串一并升到 `worker/0.2.2` 后恢复。

**同一个契约在这个仓库里已经出现三份副本**（worker 测试、集成测试、生产者版本字符串 ×2 处）。
这一轮用两次红门禁换来这条认识，值得写在交接里：**改行为时，先搜同名契约的所有副本。**
