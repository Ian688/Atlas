# Atlas w01 独立复审：CHANGES_REQUIRED

复审日期：2026-09-09。对象：`evidence/daily/2026-09-09/w01/final/` 所绑定源码。工作目录：`/Users/yinsijie/CodeRepo/Atlas`。

**结论：存在真实、可运行的进展；不接受 W01–W05 已具备可靠语义的整体验收，W06 的全流程 deadline 声明也需要修正。保留实现，优先修复本单七项问题，不需要推倒重写。** `DELIVERED` 可以保留为交付事件，不能代替 `ACCEPTED`。

## 1. 独立检查结果与范围

| 检查 | 独立观察 |
|---|---|
| 交付验证绑定的源码 | 实际为 46 个路径，全部匹配当前字节；交付摘要的“45 个”是计数不一致 |
| 最终完整清单 | 62 个路径，复审开始时只有 `docs/implementation/progress.json` 不匹配；这是台账变化，不是产品代码变化。不根据这一点推断修改者 |
| 原有验证命令 | 9/9 复跑通过，脚本最终退出码 0；日志见 `baseline/` |
| 新语义反例 | 12 个函数场景经真实 worker→Rust→SQLite→CLI 查询，与 Node 执行自有纯样例对照；其中 6 个值可靠性断言失败，脚本退出码 1 |
| 新边界反例 | 6 项：worker 超时控制项通过，其余 5 项未达到预期；脚本退出码 1。缺失 Flow 函数一项主要反映覆盖合同缺口，见 R6 |
| 变更范围 | 本次只添加复审证据、续开发任务及更新进度台账；未修改产品代码、原交付包或 Modus |

这不是全部 AL/ET/GE 的验收，也没有新做 UI 视觉验收、生产诊断、实际函数 Runner 或大项目资格认证。原测试的绿色结果成立；它们不足以证明未覆盖的语义正确。Git 尚无可用提交基线，本次以交付清单中的源码 SHA-256 绑定结果。

复现命令（在仓库根执行；两个 probe 当前应返回 **1**，表示断言发现缺陷，不是环境阻塞）：

```sh
python3 scripts/verify.py --label w01-review-replay --out evidence/reviews/w01-review-replay --timeout 180
python3 evidence/reviews/2026-09-09-w01/probe_semantics.py
python3 evidence/reviews/2026-09-09-w01/probe_boundaries.py
```

复审记录：`semantic-probes.json` 保存全部函数事实、Node oracle、实际 CLI 命令与退出码；`boundary-probes.json` 保存输入、worker 故障注入方式、墙钟、退出码和数据库发布行数。probe 的临时项目、事实库及子进程均独立并清理；仅 Node oracle 执行本单内固定编写的样例，Atlas 索引仍为静态解析。

## 2. 七项必须修复的问题

### R1 / P1：异常边使用整个基本块执行后的环境，丢掉真实异常路径的值

位置：`crates/atlas-engine/src/solve.rs:1203`，关联 `flow.rs:677` 的操作级异常边与 `solve.rs:646` 的块级 transfer。

```js
function exceptionState(change) {
  let x = 1;
  try { change(); x = 2; }
  catch (e) { return x; }
  return x;
}
```

当 `change` 抛异常，真实返回 **1**；不抛异常时返回 2。Atlas 却输出 `returns.constants=[2]`、`unknown=false`、`status=complete_within_profile`。原因是异常转移读取 `out.clone()`，其中已执行了抛异常操作之后的赋值。函数级 `unknown_callee_effects` 不能修复返回值里已丢失的可能性。

要求：为每个可能抛异常的操作建立正确的正常/异常后继状态，可以拆分基本块，也可以保持操作级异常状态；异常状态不得包含尚未执行的后续操作。调用在抛出前产生的副作用也不能直接回滚成调用前状态。增加 catch/finally、多个抛出点、返回表达式内调用、已发生副作用的成对反例。该样例结果至少包含 1 和 2，不能仍声称只有 2。

### R2 / P1：调用副作用没有作用到调用者的堆状态，旧值被当成确定结果

位置：`crates/atlas-engine/src/solve.rs:928` 与 `:938`；附带 `:797`、`:840` 的 `may_call` 覆盖赋值问题。

```js
function setValue(o) { o.value = 2; }
function knownMutation() {
  const o = {value: 1}; setValue(o); return o.value;
}
function unknownMutation(change) {
  const o = {value: 1}; change(o); return o.value;
}
```

两例分别由已知 setter、外部传入的 setter 把值改为 2；真实均返回 **2**。Atlas 两例均返回 `[1]` 且 `unknown=false`。实现只 join `Effects` 布尔/集合标记，没有重代入已知 callee 写效果，也没有使未知调用可能修改的逃逸堆位置失效。`may_write_heap=true` 或 `unknown_call=true` 只是标记，不能替代堆状态转移。

同一 `knownMutation` 的 callsite 明确含 `setValue`，但后续属性读取把累计的 `effects.may_call` 覆盖为 `[]`，最终摘要遗漏真实调用。

要求：建立可重代入的读写效果/堆摘要与别名关系；未知调用对可达且可能被修改的对象/闭包状态作有理由的保守失效。简单已知 setter 应逐步得到实际写后值；尚未精确建模时不能继续输出确定旧值。累计 may-effect 应单调合并。增加 setter/getter、回调、别名共享、闭包写与“先写后抛”测试。

### R3 / P1：多个候选对象中缺失字段的分支被忽略

位置：`crates/atlas-engine/src/solve.rs:803`。

```js
function missingField(flag) {
  const o = flag ? {value: 1} : {};
  return o.value;
}
```

`flag=false` 时真实返回 **undefined**；Atlas 返回 `[1]`、`unknown=false`，且没有 unknown reason。属性读取只合并在 heap 中找到的键；另一个可能对象的缺失字段没有贡献值，导致漏掉实际路径。

要求：区分已知属性、已知缺失、未知属性/原型；对每个候选对象都合并读结果。有完整缺失证明时包含 undefined；原型、getter 等尚未建模时保留 unknown。不能因为某个候选对象找到了属性就把整体结果变成确定值。增加候选顺序置换、不同字段、条件对象和别名 join 反例。

### R4 / P1：JavaScript 加法折叠错误，产生虚假的确定常量

位置：`crates/atlas-engine/src/solve.rs:1423`。

| 表达式 | Node 实际值 | Atlas 返回常量 |
|---|---|---|
| `true + 1` | 数字 2 | 字符串 `"true1"` |
| `null + 1` | 数字 1 | 字符串 `"null1"` |

当前代码仅对“两边都是数字”做数字加法，其余统一转字符串。这会进一步造成条件剪枝、分支可达性和下游结果错误。

要求：按声明支持的 primitive 语义实现转换；只有适用字符串拼接条件时才拼接。对象转换、Symbol、BigInt 等未实现组合应显式 unknown/异常，不能猜值。上述两个普通 primitive 例子必须精确通过，不能统一改成 unknown 掩盖缺陷；用独立 Node oracle 扩展混合类型矩阵及由结果驱动的分支。

### R5 / P1：全流程 deadline 没有覆盖 Rust 分析和发布阶段

位置：`crates/atlas-app/src/main.rs:149`；关联 `inter.rs:38`、`solve.rs:592` 及存储提交。

普通 worker 超时控制项在约 **2.034 秒**以 `worker_deadline` 结束，零 Analysis 发布，证明这段边界有效。进一步使用同一 1,200 函数源码的真实 worker 预计算材料，配合受控缓存 worker 隔离后续 Rust 阶段：设置 `--index-deadline-seconds 1`，实际运行 **24.599 秒**，退出 **0**，发布 **1 个 Analysis、1,200 个 facts**。

缓存 worker 只回放真实解析材料并按本次请求重绑定 Snapshot ID，没有伪造函数/控制流；预计算不计入测量。这是阶段隔离测试，不声称默认 worker 的总耗时恰为 24.599 秒。

原因：剩余时间传给了 scan 和 worker，后续同步 `analyze()` 未收到截止时间。`MAX_TOTAL_TRANSFERS` 也只声明、未使用，单函数预算不等于全作业预算。

要求：将单调绝对 deadline、取消令牌、累计工作预算贯穿解码/校验、CFG、SCC、局部求解、序列化及发布；提交前再次核对终态。长 CPU 阶段需要合作检查点或可回收执行边界；只在同步计算外面套 `tokio::time::timeout` 不足以停止它。允许保留已合法捕获的 Snapshot，但截止后不得发布成功 Analysis。分别测试 scan、worker、Rust 和提交阶段超时/取消，并证明执行已停止、子进程已回收。

### R6 / P1：Rust Flow IR 校验接受重复 binding 与悬空 local 引用

位置：`crates/atlas-engine/src/flow.rs:263`、`:467`。

在真实 worker 输出上分别注入以下错误，经正式 CLI `--worker` 接口重放：

- 同一函数 `bindings` 重复一个已有 ID：退出 0，发布 1 个 Analysis、1 个 fact。`ptr::eq(previous,function)` 分支显式放过了这一重复。
- 将唯一 local read 的 binding 改为 `b:nonexistent`：退出 0，同样发布事实。注入器验证恰好修改了一个引用；不是没有实际修改的假负例。表达式校验只检查跨度，没有检查该引用的声明、可见性与归属。

这与交付中“重复 ID/引用 Rust 校验”的声明不符。worker 是受控解析器，这里验证的是协议防错边界，不将其描述为已证明的远程攻击。

另一个覆盖案例：worker 删掉全部 `flow.functions`，仍发布有 1 个结构函数、0 个 Flow 函数的 Analysis。coverage 数字保留了差异，因此不称为伪造总数；但没有逐函数缺失原因，不能证明所有输入函数都获得了分析或显式排除。

要求：同函数内及跨函数 ID 唯一性；每种读写/参数/函数目标/捕获/作用域父子引用的存在、类型与可见性；声明与 scope 双向一致；预期函数与 Flow 函数/显式排除记录逐一对账。合法不支持的语法要有范围与原因，损坏协议应在派生事实发布前拒绝。将这些注入反例放到真实 worker 边界测试，不能只验证 source span。

### R7 / P2：合法的无绑定 catch 导致整个项目索引失败

位置：`crates/atlas-engine/src/flow.rs:317`、`:1624`。

```js
export function f() {
  try { throw 1; } catch { return 7; }
}
```

真实 CLI 退出 1，错误 `flow_catch_missing_param`；已有 Snapshot，零 Analysis。JS 允许省略 catch 参数，worker 也确实输出了无参数 catch，Rust 两处却强制要求参数。

要求：允许 catch body 存在而 catch binding 不存在，仅有 binding 时初始化它；异常处理、finally 语义保持一致。合法但尚未支持的结构应通过显式 unknown 保留项目其余分析，不能误判为损坏协议后拒绝整个项目。增加无绑定、有绑定、嵌套和重新抛出对照样例。

## 3. 值得继续做的中等改进

### M1：W04 目前主要传播 origin，尚未完成可靠的参数值重代入

`solve.rs:1663` 只替换 origin，并未把实参的 constants/targets/heap 引用一起重代入。

- `identity(41)` 的 summary 返回 `origins=[CallResult(...),Constant]`，但 constants 为空。
- `const f=identity(one); f()` 中实参明确指向 `one`，返回值丢失 targets，第二个调用变为 unknown。

这些结果主要是精度缺口，与 R1–R4 的“返回错误确定值”分开。不能把 `Constant` 来源标签称为具体常量已传播，也不能把 origin 回填称为完整值流摘要。优先建立不同抽象维度的代入规则、callee 目标新增后的依赖重排/SCC 再调度，再扩展 k=1；仅提高上下文数量无法修复当前代入缺失。捕获、抛出值、pending 依赖何时收敛也应明确区分。

### M2：保留 finally completion 的精度，定义可机器区分的值合同

`try {return 1} finally {const x=2} return 9` 的真实结果只有 1，当前输出 `[9,1]`。这是多出的不可能路径，属于过近似，不能与 R1 的漏掉真实路径混为一谈。`Dispatch` 无条件发 normal 边使后续不可达语句复活；改成按 completion 分派并检查共享 finally 的 return/throw/break/continue 组合。

此外 `const_to_json` 把 undefined 与字符串 `"undefined"`、NaN 与字符串 `"NaN"` 等序列化成同一值。人类报告和 Agent 消费者需要 tagged constant，不能只靠展示文本。该点来自代码检查，尚未独立重放 HTTP 类型冲突；作为协议改进任务，不计入本次六个确定值反例。

### M3：修正台账与错误风险描述，避免把“具名测试”当作完整能力

- D06、D11、D19、D21 同时出现在 `covered_with_tests` 和 `not_implemented`，应按子能力和测试 ID 拆分。已有 getter 不执行测试，不等于 getter/外部调用之后的堆值可靠。
- 报告“20/22 有具名测试”不能代替分支与负例覆盖；D18 当前仍登记缺失，D19 又有不同子项，不能只按编号加总给出完整度。
- 最终 manifest 中 progress 已漂移，后续台账应关联交付版本并保留变更记录；不要重写旧 manifest 来假装从未修改。
- R5 原复审请求称“同 producer/engine 版本而派生 facts 改变，Analysis ID 仍不变”。按当前 `analyze.rs:341` 起的管线，派生 records 先求 `flow_digest`，再纳入 Analysis 内容身份；这条泛化担忧并不由当前代码支持。原始 IR 是否也要存储/绑定应另立合同，不能把盲目追加 hash 当成本次首要修复。公开 Store 发布入口是否自行核验传入事实与 digest 是另一项待测边界，本次未验收。

## 4. 对提前交付的判断

约 2 小时 59 分的工作量和“无中断”来自执行者报告，本次源码复验不独立证明连续运行时长。交付物有价值，也没有把自测冒充独立 ACCEPTED，这是正确的。

但**剩余约 7 小时、没有不可解除阻塞时，仅因下一个完整功能较大而停止，不符合每日任务书第 1 节持续推进和第 7 节接续要求**。可独立推进的工作包括本单语义负例、IR 校验、普通 catch、阶段截止、未完成的 D 家族子项。它们不要求先完成 k=1 或整个作业系统。

预留末尾 45–60 分钟收敛不能解释还剩 7 小时就停止。下一轮按实际套餐剩余/新窗口计时，完成一项就选择下一项有用且可验证的工作；只在额度/截止到达、平台停止、用户停止或确实无可推进工作的必要阻塞时交接。不得等待凑时长，也不得用一次绿灯代表整轮目标完成。

## 5. 接续顺序和重新验收

1. 先 R1–R4，恢复值和分支的可靠性；R7 是可独立完成的小闭环，可穿插。
2. R6 合同防错、覆盖对账；R5 全阶段 deadline/取消，并检查预算聚合。
3. M1 实参值/函数目标/效果代入与新调用边调度；M2 completion 精度及 tagged values。
4. 再续 W06 崩溃恢复/作业终态、W07 增量等满足依赖的工作。正式 3D、Runner、AI Coding 仍保留长期目标；不要让新 UI 把错误静态结果包装成运行证据。

把本单样例移入正式、可维护测试，添加至少一组不照抄本单的相邻扰动。修复后原 9 项检查和新增反例都要复跑；超时用所有权/终止证据，不只检查返回错误。旧分析是旧源码/算法产物，应保持不可变，新分析更新算法版本与事实身份；不要原地修正已经发布的记录。

续开发提示词见本目录 `NEXT_AGENT_PROMPT.md`。修复交回时逐项提供 R1–R7 的 diff、测试、退出码、最终源码指纹和未解决项；执行者仍填 `NEEDS_INDEPENDENT_REVIEW`，由后续独立复审决定 ACCEPTED。
