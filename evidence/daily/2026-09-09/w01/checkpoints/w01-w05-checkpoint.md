# W01–W05 Checkpoint — 本地语义通路已贯通(2026-09-09 ~06:20 +08:00)

## 已完成并验证的能力

**主线通路: 真实 JS/TS 源码 → worker Flow IR → Rust 校验 → CFG → 局部抽象解释 → SQLite 原子发布 → CLI/HTTP 查询 → Web 函数面板**

1. **W01 合同与 worker** (`crates/atlas-contract/src/flow.rs`, `workers/typescript/src/flow.mjs`)
   - `atlas.flow-ir.v1`,profile `js-structured-control.v1`,producer `typescript/5.9.3;worker/0.2.0`。
   - worker 输出: 函数级结构化语句/表达式树(UTF-8 `[start,end)` 锚点)、Scope/Binding(param/var/let/const/function/catch)、参数默认值、捕获列表、unknown_regions 与 FLOW_UNKNOWN_REGION 诊断。
   - 不支持构造(for-of/in、解构、await/yield、模板插值、逻辑赋值、rest/展开、element access、with、class、delete、JSX、正则值等)一律显式 unknown+原因,不静默跳过。
   - 越界防护: 单函数语句 ≤20k,blocks/ops 超限整个函数拒绝(`flow_lowering_budget_exceeded`)。
   - worker 测试 19/19(含 D01 遮蔽/TDZ、D02 短路结构、D03/D04 try/finally、D05 label、跨函数绑定捕获)。

2. **W02 Rust CFG** (`crates/atlas-engine/src/flow.rs`)
   - 基本块 + completion 语义: Return/Throw/Break/Continue/Normal 经共享 finally dispatch(无组合爆炸);finally 正常结束恢复原 completion、自身 abrupt 覆盖(D03/D04 有测试);catch 内异常不再进同一 catch;switch 分支链+顺序 fallthrough;短路/条件表达式为真分支+路径内临时变量(JoinValues 方案已废弃——它不保持路径敏感性);`??` 用 NullishTest。
   - 修复过的关键 bug: ?? 分支接线反置(导致 RHS 副作用提前)、分支后操作误入已终止块、finally 体自身终止时误挂 dispatch、表达式体箭头函数崩溃、scope id 跨函数冲突。
   - `looping_blocks`(迭代 Kosaraju)标记循环块,供求解器弱化堆更新。

3. **W03 局部抽象解释** (`crates/atlas-engine/src/solve.rs`)
   - 维度: 可达性、绑定环境(值+初始化状态 Initialized/NotInitialized/MaybeInitialized+reaching defs)、常量/函数目标/来源 CappedSet(8/64/8,超限合并为 Top+cap_exceeded 原因)、平坦堆(site,field)+wildcard、效果、completion。
   - def-use: 每绑定 defs + 每定义 use 集合。TDZ 读取 → may_throw + tdz_read 原因。
   - 来源: Parameter(i)/Constant/CallResult(op)/Allocation(op)/FunctionValue(op)/External/Capture/Derived/Exception/This。跨函数绑定经 directory 解析(捕获的模块函数值→目标集合)。
   - JS 常量折叠规则显式声明: f64 算术(NaN/±0/除零按 JS)、字符串拼接(integral 数值才转字符串,否则 Top)、===/!==、比较(同型)、&&(短路值)、||、??、typeof、!、void;位运算等不折叠→Top 带原因。
   - worklist: 确定性 BTreeSet 队列、每块访问上限+全局 300k transfer 预算→partial_budget+frontier;返回/抛出值按块覆写后合并(避免早期迭代污染);常量条件剪枝记录 pruned_edges 证据。
   - 语义测试 7/7: D01 TDZ、D02 短路 RHS 不可达+剪枝证据、D03 finally 保留/覆盖 return、D04 finally 不恢复旧环境、D05 循环不动点+回边、D07 两候选保留、D08 强更新 kill、D12 Parameter 来源。

4. **W05 存储/查询/面板**
   - SQLite `facts` 表 (analysis,symbol,kind='flow') 与 Analysis 同事务发布;旧版本 facts 不变(有测试)。
   - CLI: `flows`(列出)、`flow <analysis> <symbol>`(CFG+块状态+def-use+returns/throws+效果+unknowns+预算)。
   - HTTP: GET `/api/flows`、`/api/flow?entity=`(会话鉴权不变)。
   - 面板: 函数选中时 flow 详情(状态、返回/抛出值摘要、效果、unknowns、块与绑定状态,按预算截断)。
   - 集成测试 7/7 通过,新增 D22 全链路测试(worker→store→CLI→HTTP→旧版本隔离)+ flow-lab fixture(11 函数,断言先于输出从 JS 语义写出)。

## 尚未完成(如实)

- W04 跨过程: 调用点参数/返回匹配、摘要固定点、递归 SCC —— 未实现。当前 callee 摘要一律 `callee_summary_pending_interprocedural`,不假装已做。
- D09 别名/堆弱更新、D10 cap 超限、D14 五层链、D15 递归、D16 类型签名、D17 数据转交边、D18 路径条件、D21 alpha-renaming 等价 —— 未有专项测试。
- 面板浏览器实测尚未做(下一步)。
- UI 深链/3D/Agent/AI Coding/作业系统(W06+)未动。

## 下一步

1. 浏览器实测 flow 面板(记录证据)。
2. progress.json 更新 + 最终 verify + 日报材料。
3. 若有余时: D09/D10/D14/D15 专项反例。
