# Code Atlas 本地拆解引擎：算法与实现规格

版本：1.5 · 2026-09-08。配套版本见 [Atlas 开发入口](code-atlas/README.md)。本文规定 17 项本地算法和 52 个 ET 用例；第 26 节将首轮实现审查的反例转为求解、版本、资源与验收合同。属于待实现和验证的技术合同，不是引擎已完成声明。

核心决定保持不变：Rust 拥有本地事实、分析调度、通用算法与查询核心；语言 worker 输出经过版本绑定的语法、绑定、类型和语言语义材料。成熟解析器可以复用，程序分析算法必须真实接通。独立的 renderer 或 LLM 不拥有第二套“真相图”。

## 1. 100% 本地解析的准确要求

项目材料进入本地快照后，文件清点、语法与符号提取、名称绑定、模块解析、调用目标推导、控制 / 数据流、框架联系、索引、增量更新、事实报告和显示投影全部在用户本地执行，产品模型调用计数为 0。原始材料不因算法遇到困难而发送给 LLM、云向量服务或远程解析 API。

远程 Git 获取、用户允许的依赖下载与实际网络业务测试分别记账，不算代码解析算法；材料准备好后，纯解析资格测试须能在禁网、无模型配置的环境完成。实际业务运行有自己的环境与 IO 权限，不能伪称所有程序联网行为都是解析器联网。

“100% 本地”不能被弱化为“多数在本地，剩下调用模型”。与此同时，语义支持范围必须精确：本地算法对受支持语言 / 特性实现正确的规则，对暂未建模的内容保留位置、影响和未知原因。文件清点完整、受支持语法完整、关系推导质量、运行观测覆盖分别测量，不用一个百分比互相替代。

这是引擎优先的开发合同。UI 可以并行消费真实结果，但漂亮画布、Rust 启动壳和调用现成 parser 得到 AST 都不能代替本规格验收。

## 2. 原设计审查发现与本次补齐

| 原设计已有内容 | 仍不足的实施细节 | 本文补齐 |
|---|---|---|
| 作用域、类型、有限值传播 | 类型签名与实际调用目标的区别、别名与未知处理 | AL-03–07 |
| CFG、def-use、跨函数摘要 | 求值顺序、异常 / finally、转移函数、强弱更新 | AL-02、05–08 |
| SCC / 固定点 | 域的有限性、队列、递归依赖、预算耗尽结果 | AL-06–08、15 |
| 接口 hash 与增量失效 | 函数体变而签名不变、负查询依赖、删除后撤回事实 | AL-11 |
| 关系图与 IO 线路 | 调用返回匹配、可行性、调用与数据关系类型 | AL-07–10、13 |
| 精度和规模指标 | 防止全标 unknown 混过验收、独立 oracle、算法用例 | AL-14、第 23 节 |
| 选中函数到局部测试 | 上下文可构造性、真实 / 替身边界、独立断言与多选 | AL-16、ET-41–52 |

本文细化算法，不再重新选择是否用 Rust。具体 crate、对象布局和 IPC 编码由工程验证确定；每个算法的语义合同、反例和边界须保留。

## 3. 统一内部表示与所有权

### 3.1 四种内部材料

| 材料 | 最低内容 | 权威 producer |
|---|---|---|
| SourceUnit | 原始 blob、语言 / 版本、文件身份、解码与坐标映射、构建变体 | Rust 快照与语言识别 |
| LanguageFacts | AST / CST 锚点、声明、词法绑定、类型 / 模块解析结果、诊断 | 固定版本语言 worker |
| AnalysisIR | 结构化语句与有序操作、局部 / 捕获变量、调用点、属性访问、异常与挂起语义 | worker 按语言降级生成，Rust 验证与构建分析图 |
| DerivedFacts | CFG、def-use、候选目标、摘要、IO 边界、影响、来源与完整性 | Rust 算法核心 |

worker 利用 TypeScript Compiler API、Python AST / symtable 等获取语言事实；Rust 不重新猜测 Python 的词法规则或 TypeScript 的 moduleResolution。Rust 必须实际实现归一化校验、CFG 构建、值 / 别名传播、调用摘要、分区固定点、索引与查询，不能把这些职责全部藏回 Python。

首发 JS/TS 用 TypeScript parser / checker 输出，避免每文件重复跑两套解析器。Tree-sitter 随其他语言或容错需求加入；它提供语法结构，语义必须通过后续算法获得。[TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)、[Tree-sitter 增量解析](https://tree-sitter.github.io/tree-sitter/using-parsers/3-advanced-parsing.html)

### 3.2 最低 IR 合同

```text
FunctionIR
  function_id, source_anchor, language_semantics_version
  parameters, receiver?, captures, locals, structured_body
  diagnostic_regions, input_fact_manifest

Operation
  op_id, source_anchor, kind, operands, result?, effect_flags
  kind: Constant / ReadBinding / WriteBinding / Allocate /
        ReadProperty / WriteProperty / Unary / Binary /
        Call / Construct / RegisterCallback / Await / Yield /
        Return / Throw / UnknownOperation

Control
  Sequence / If / Loop / Switch / Try / Catch / Finally /
  Break(label?) / Continue(label?) / Completion

BasicBlock
  block_id, ordered_operations, terminator
  edges: normal / true / false / exception / return /
         break / continue / suspend / resume
```

IR 保留语言运算符和求值规则：JS `+` 与 Python `+` 不能统一当作无副作用数值加法；属性读取可能触发 accessor，Python 运算可能调用特殊方法。无法完整降级的语句产生带源区间的 UnknownOperation，不直接跳过。嵌套函数生成独立 FunctionIR，创建闭包作为外层操作；定义次数与运行调用次数分离。

每份事实包绑定 `snapshot_id + build_variant_id + producer_version + ir_version + input_manifest_hash`。worker 不传指针，不用源文件名作为全局符号 ID；Rust 校验输入引用、范围、ID 冲突、操作顺序和资源限额后才入库。

## 4. 推导结果与精度合同

每项算法结果包含：算法 ID / 版本、输入摘要、分析范围、配置与预算、结果状态、消耗量、来源、已知限制。至少区分：

- `complete_within_profile`：该 profile 中的所请求计算已收敛，仍可能存在真实外部或动态边界。
- `partial_budget / partial_input / unsupported_semantics`：有明确缺项，列出受影响实体与 frontier。
- `cancelled / failed`：未产出可作为该层完成结果的批次；可以引用之前已发布版本。

调用目标额外保存 `targets_complete`、`unknown_component`、`derivation_kind`。单目标只有在候选集合闭合、绑定与可写性已建模、输入完整且没有未知分量时才可标 resolved。某一类型查询只返回一个签名，不满足这个条件。

保守近似与启发式候选分别标记。保守近似的目标是，在声明的语义模型和边界假设成立时不漏掉模型内可能行为；未建模外部行为会使范围变未知。纯文本相似度等启发式不能作为“没有依赖 / 没有副作用 / 安全可删除”的证明。

每条衍生关系保留输入事实引用、规则 ID、源操作或调用点、必要假设。递归摘要用 SCC / 版本引用表示来源，不递归展开无限证据树。事实存在与证据展示预算分开，展示截断不得让算法结果看似穷尽。

## 5. 算法目录与交付映射

| ID | 算法合同 | 主要工作包 |
|---|---|---|
| AL-00 | 文件清点、分类、不可变快照 | CA-01、UP-02 |
| AL-01 | 语法、对象身份与源码坐标 | CA-02、CA-12 |
| AL-02 | 保持语言语义的 IR 降级 | CA-02–03、CA-12 |
| AL-03 | 模块、构建与依赖解析 | CA-03、CA-12 |
| AL-04 | 作用域、符号绑定与类型来源 | CA-03、CA-12 |
| AL-05 | 控制流、异常、循环与完成语义 | CA-03、CA-12–13、CA-16 |
| AL-06 | 局部抽象解释、def-use 与别名 | CA-03、CA-12、CA-16 |
| AL-07 | 调用目标、参数与返回匹配 | CA-03、CA-12–13 |
| AL-08 | 跨过程摘要、递归与 SCC 固定点 | CA-03、CA-11–12、CA-16 |
| AL-09 | 源到汇、控制依赖与影响切片 | CA-04、CA-16 |
| AL-10 | 框架注册、配置消费者与 IO 边界 | CA-03、CA-12–13、CA-16 |
| AL-11 | 增量依赖、撤回、实体跨版本匹配 | CA-01、CA-11、CA-15 |
| AL-12 | 分区存储、有界图查询与显示投影 | CA-04、CA-15、CA-17 |
| AL-13 | 静态锚点与真实运行的本地关联 | CA-06–07、CA-13、UP-03 |
| AL-14 | 完整性、质量计量与本地解释证据 | CA-00、CA-08、CA-18 |
| AL-15 | 预算、调度、隔离与确定性 | UP-02、CA-04、CA-14–15 |
| AL-16 | 函数可执行性、上下文构造与测试切片规划 | CA-00、CA-06–10、CA-12–13、UP-03 |

AL 是原 23 个基础工作包中的算法合同，也为新增 MX 提供底层能力，不另增加 17 个顶层工作包。每个 profile 明确实现了哪些规则与用例；不能只创建同名模块就标完成。

## 6. AL-00：清点、分类与快照

输入为 ProjectHandle、根目录授权、忽略 / 范围规则、文件与字节预算；输出为 FileDisposition 清单、blob manifest、边界与诊断。

1. 用显式栈 / 队列遍历目录，不递归消耗语言调用栈；逐目录记录已枚举项和不可访问边界。
2. 先识别文件类型、大小、链接、权限，再按范围规则决定采集。目录排除必须有路径与规则原因；未遍历目录不编造其内部文件数。
3. 符号链接记录链接对象；跟随策略允许时检查实际根范围并按文件系统身份检测环。硬链接的内容可去重，但不同逻辑路径保留物理归属记录。
4. 读取字节到内容库并计算 hash；以读前 / 读后状态和捕获期间变化发现冲突并重读。达到重试预算则标 unstable；执行 / 修改使用可验证冻结副本。
5. 用扩展名、文件头、显式配置和格式 parser 分类，并记录依据。README、配置、锁、测试、生成物、二进制都有处置结果；无函数文件仍是文件实体。
6. 不为索引执行 import、Git hook、安装脚本、模板、YAML 自定义构造器或原项目构建。必要依赖材料缺失进入明确边界。

遍历和读取的工作量基于已访问项和读取字节近似线性；稳定排序、文件系统 IO 和 hash 成本单独计量。Unicode 规范化和大小写敏感性遵循实际文件系统，不能为“统一命名”合并两个真实路径。

## 7. AL-01：语法、身份与位置

按 `source_hash + parser_version + language_mode` 读取 / 创建语法结果，记录解析错误区间。建立原始字节、解码字符、行首以及 UTF-16 坐标的映射；源跳转始终可以回到原 blob。

一次结构遍历提取目录归属、文件、声明、函数 / 方法 / 类、参数、嵌套对象与调用点。语言 worker 返回稳定局部身份和源区间，Rust 组合项目 / 构建 / 文件命名空间形成实体 ID。重载签名、声明合并、实现体、匿名回调的计数规则分别定义，函数柱按实现对象统计并展示声明关系，不重复计数。

容错节点保留可解析子结构；穿过错误区域推导的关系不得自动标精确。跨文件同名、复制文件相同内容、重复匿名函数都不得因名称或 hash 相同合并身份。

增量语法更新按 parser 的 edit 协议更新旧树和缓存坐标，再解析新文本；无法证明旧树可复用时全文件重解析。语法树复用只优化 parse，不证明语义和调用关系仍有效。[Tree-sitter 增量解析](https://tree-sitter.github.io/tree-sitter/using-parsers/3-advanced-parsing.html)

## 8. AL-02：语义保持的降级

语言 worker 将表达式降级为有序操作及结构化控制节点；Rust 验证并构建 CFG。每个降级规则带语言版本、输入语法、输出操作顺序、异常边与对应 ET 用例。

- `a() + b()` 保留先后和潜在异常；`lhs[index()] = rhs()` 的引用计算与 RHS 顺序按语言规则处理，不能套用另一语言的模板。
- `&& / || / ?? / 条件表达式 / 可选链` 降级为分支与合流，不提前执行或传播不可达 RHS 的副作用。
- 解构、默认参数、展开、迭代协议、属性 getter / setter 具有独立规则；未支持部分通过 UnknownOperation 传递影响，不当作纯复制。
- `await / yield` 表达挂起和恢复，闭包捕获引用可写状态；不要把它们当作普通同步调用后立刻结束。
- Python `with / async with`、JS / Python 的 finally 与运算符分派先在语言语义层明确；尚未完整支持的特性不取得相应运行 / 深分析资格。

降级验证用小程序的返回、异常、操作记录和副作用顺序作 oracle；允许受控执行测试代码来验证编译语义，但用户项目的静态解析过程不执行这些代码。

## 9. AL-03：模块与依赖解析

首先确定每个 compilation unit 的构建变体、语言模式、包根、条件与解析器配置。将解析请求交给对应 worker，但其虚拟文件系统只能读取 manifest 允许的源码、已提供依赖声明和固定标准库，不扫描任意宿主路径。

JS/TS 按 TypeScript 模块解析配置处理相对路径、包 exports / imports、paths、类型声明与扩展替换；记录实际尝试和配置输入。类型声明解析与运行实现路径分别保存：解析到了 `.d.ts` 不等于已经找到或分析实际 JS 实现。类型专用 import 与执行依赖分开。[TypeScript 模块解析](https://www.typescriptlang.org/docs/handbook/modules/reference)

Python 按显式模块根、包 / 命名空间包材料与相对 import 规则建立模块引用；不得 import 用户模块，也不调用可能导入父包或插件的发现流程来“确认”符号。动态 sys.path、import hook 与运行时模块替换形成明确未知边界。

输出 `ModuleResolution` 包含目标候选、声明 / 实现角色、条件、外部状态和读取依赖。**未找到目标也是依赖**：记录查询过的目录 / package manifest / 路径状态，新增文件后必须使旧 unresolved 查询失效。包根、条件、配置或 lock 变化同样触发失效。

## 10. AL-04：作用域与绑定

worker 的语言绑定结果是起点；Rust 以 ScopeId、BindingId 和 ReferenceId 保存并验证绑定关系，区分值命名空间、类型命名空间与声明合并。无语言规则时不能以“最近同名”代替解析。

Python 处理函数级局部判定、global / nonlocal、闭包与推导式作用域；赋值前读取可能是未初始化错误，不能错误绑定外层同名变量。官方 symtable 反映编译器的作用域信息，可作为材料之一，不能单独提供调用图。[Python symtable](https://docs.python.org/3/library/symtable.html)

JS/TS 处理 block / function scope、var / let / const、声明提升与 TDZ、receiver 与捕获；成员属性解析不能等同于词法变量绑定。TypeChecker 提供类型和签名事实，函数值后续是否被替换、对象是否逃逸仍由值传播与效果分析处理。

输出绑定目标、声明 / 读取 / 写入位置、初始化状态、捕获关系和来源。未绑定、歧义、未初始化与已绑定但值未知分别表示；内建符号也必须记录所用标准库版本。

## 11. AL-05：CFG、异常与完成语义

Rust 对结构化 IR 使用入口 / 出口 continuation 与 handler 栈构建基本块，保留每个操作的正常和异常后继。顺序语句串接，if 生成 true / false 边，循环有条件、体、回边和退出，break / continue 依据标签指向相应 continuation。

finally 采用显式 `Completion(kind, value, target)` 语义：从 try / catch 离开的 return、throw、break、continue 先进入 finally；finally 正常结束则恢复旧 completion，finally 自己产生新的 abrupt completion 时覆盖旧值。不要为避免复杂而把 finally 接在一个不保留返回值的普通出口上。

可能抛异常的属性 / 调用 / 运算连至当前 handler；catch 内抛出不能回到同一个 catch；未捕获异常到 exceptional exit。await / yield 的挂起与恢复连边独立，取消语义按环境 profile 处理。

输出 CFG 带正常出口、异常出口、不可达区间与潜在挂起状态。循环或递归都不能用“发生一次调用”代替；静态环不表示本次一定循环。CFG 构建工作量随降级 IR 与边数量增长，禁止无预算复制 finally 造成组合爆炸，必要时共享受 completion 区分的结构。

## 12. AL-06：局部抽象解释、def-use 与别名

### 12.1 有限域

每个程序点状态至少包含可达性、局部绑定、捕获 / 全局单元、抽象堆和效果。`unreachable` 与“可达但变量未初始化”分开；JS undefined、Python 未绑定、未知值都不是不可达底元素。

```text
State = Reachability × Env × Heap × Effects
AbstractValue = Constants × FunctionTargets × HeapLocations × TypeTags × InitState
CappedSet(K) = finite set with <= K members, or Top
join(S,T) = union(S,T) if within K; otherwise Top
join(Top,x) = Top
HeapLocation = (allocation_site, context_key, bounded_field_path)
```

首轮可验证默认预算：常量集合 8、函数目标 64、堆位置集合 32、字段路径深度 2；它们是精度参数，必须写入结果与缓存键。超界合并到 Top / wildcard，不截取前 K 项后继续声称完整。类型、目标与效果的未知分量分别传播。

常量只处理固定版本规则明确支持的原始值操作；不调用用户运算符、getter、repr 或模型求值。整数溢出、浮点、NaN、字符串拼接、布尔真假和类型转换按语言模型保留。对无法证明条件取值的分支保留两条边。

### 12.2 转移规则

| 操作 | 状态更新 | 关系输出 |
|---|---|---|
| 常量与参数输入 | 赋予有限常量或参数抽象值 | constant / input 来源 |
| 局部 `x = y` | 更新 x 的 reaching definition 与抽象值 | value-preserving 传递，旧局部定义被覆盖 |
| `x = y + 1` 等 | 按语言运算求有限结果或 Top | derived-from，不当同一值搬运 |
| 读属性 | 合并可别名位置的命名字段和 wildcard；处理潜在 accessor | read / alias / 可能调用及异常 |
| 写属性 | 默认弱更新；只有证明唯一具体对象与字段时强更新 | write / derived / side effect |
| 未知调用 | 返回含未知；影响可达 / 逃逸对象、捕获与模型内可能修改的全局 | unknown effect / external 边界，不标纯函数 |
| 合流 | Env / Heap / Effects 逐分量 join | 保留各定义来源与条件 |
| 返回 / 抛出 | 输出正常返回或异常分量 | return / throw 端口与来源 |

分配点只有一个抽象位置不等于运行中只有一个对象；循环分配、递归、逃逸与多次调用必须阻止错误的强更新。未知字段写入更新 wildcard，后续具体字段读取合并它；未知对象别名需要使可能受影响的堆摘要不再精确。只有完整可信效果摘要才能省略 clobber。

def-use 采用带程序点的 reaching definitions：可达块输入为前驱输出并集，普通局部写入 kill 该绑定旧定义并 gen 新定义，使用点关联当前定义集合。堆和别名单独建模，不把所有字段一律当局部变量。SSA 可作为等价实现优化，不是首轮额外重写前提。

### 12.3 工作队列与收敛

```text
IN[all blocks] = unreachable
IN[entry] = seeded_parameters_and_environment
queue = [entry]
while queue not empty:
    check_cancel_and_budget()
    b = pop_deterministically(queue)
    out = transfer_block(b, IN[b])
    for edge in successors(b):
        edge_state = apply_edge_condition_and_completion(out, edge)
        merged = join(IN[edge.target], edge_state)
        if merged != IN[edge.target]:
            IN[edge.target] = merged
            enqueue_if_absent(edge.target)
```

每个转移函数要有单调性用例，join 要满足幂等、交换、结合；整个域在固定函数 / 上下文 / 分配点和有限 cap 下有有限高度。实现记录实际更新次数、状态大小和最大队列，不承诺仅随源码行数线性。

预算中断时未完成状态不是最终保守解；列出未求解 frontier，不能据此推导“不可能调用”或“没有 IO”。Top 是域内近似，partial 是计算未完成，两者分别报告。固定点和格的理论基础可参考 Clang 与 MLIR，但上述精度、效果和 IR 合同是 Atlas 的实施选择。[Clang 数据流框架说明](https://clang.llvm.org/docs/DataFlowAnalysisIntro.html)、[MLIR DataFlow](https://mlir.llvm.org/docs/Tutorials/DataFlowAnalysis/)

## 13. AL-07：调用目标与调用返回匹配

对每个 CallSite：先由词法 / 模块绑定定位 callee 表达式，再读取 AL-06 的函数值和对象字段候选；加入版本匹配的框架规则结果；最后保留未知 / 外部成分。构造调用、bound method、闭包、callback 注册与实际调用分别建模。

首轮上下文键采用最近一个调用点（call-string k=1），再加构建 / 精度 profile；k=2 等按需扩展。目标函数每个上下文传入 receiver、实际参数、捕获与必要堆投影。首轮每函数默认最多 128 个上下文；超额合并至明确的通用上下文并标明精度合并，不能丢弃剩余调用。

每条调用保存 CallSiteId 与参数映射；返回和异常通过该调用点对应的 continuation 应用摘要。不能把被调用函数的一个 return 连到所有 caller，使 A 的输入从 B 的调用返回口流出。

`getResolvedSignature` / 某个类型符合接口只证明相应类型事实，不自动证明唯一运行实现；可变属性、原型、动态 dispatch、未建模写入和不完整依赖会保留候选 / unknown。外部声明可以提供签名，但缺实现时效果需明确模型或未知。

callback 注册产生 `registers_callback`；只有受支持调度规则或真实事件才能进一步推导调用。事件名、函数名或 URL 相同只可作为候选证据。

## 14. AL-08：跨过程摘要与递归

`SummaryKey` 包含函数语义 IR hash、构建变体、上下文 / 抽象输入、算法版本、精度 profile 及实际读取依赖。摘要内容至少为：返回值和来源映射、异常、读 / 写位置、外部 IO、callback / 异步注册、逃逸、未知影响和条件。

求解中按稳定的 `(function, bounded_context)` 桶合并抽象输入并单调更新摘要；抽象输入指纹用于已封存结果的缓存与版本识别，不在每次迭代中无限创建新上下文。输入扩大时唤醒该桶与消费者，所有上下文合并 / 配额状态记录在结果中。

递归 SCC 的缓存以成员语义输入和 SCC 外依赖形成统一输入指纹；内部依赖保存 query / member ID，结果收敛后计算成员输出指纹。不要把互相依赖的摘要 hash 递归嵌进对方 hash，造成无穷重算或无法稳定封存。

步骤：建立当前候选调用依赖 → 计算 SCC 与凝聚图 → 对依赖已经稳定的分量求解 → SCC 内迭代摘要并重排受影响 caller，直到稳定或预算中断。调用目标集合可能随值分析增长，新边要加入依赖并重新检查受影响 SCC；不能只做一次初始拓扑排序。

已知代码但待求解的摘要使用内部 pending / bottom 状态与订阅，不立即当作永久外部 Top。递归 SCC 从底开始单调增长；只有分量收敛且所依赖材料就绪时对外发布完整摘要。中断后无法收敛的分量及依赖 caller 明确 partial；不能把 provisional bottom 当成“函数不返回 / 不抛异常”。

来自真正外部未知代码的 Top 与“尚未完成计算”不同。若后续加入实现或更精确模型，建立新分析代次重算依赖，不在同一单调求解中随意把 Top 改回精确集合。

跨过程分析以带调用点的摘要组合为首轮实现。IFDS / IDE 可用于满足其数学条件的专项分析，不能宣称任意 JavaScript 堆 / 类型 / 路径逻辑直接具有 IFDS 的精确性或复杂度；调用返回匹配始终是必要条件。[Reps、Sagiv、Horwitz：Interprocedural Dataflow Analysis via Graph Reachability](https://research.cs.wisc.edu/wpis/papers/diku-tr94-14.pdf)

## 15. AL-09：数据切片、控制依赖与路径

先确定查询关系种类、源 / 汇端口、范围、profile 和预算。值保持、派生、参数、返回、heap read/write、控制影响各有独立边类型；遍历时由查询明确允许的组合决定可通过的边。

局部前向 / 反向切片用工作队列遍历 def-use 与相应控制依赖；跨函数通过摘要和匹配的 CallSite 进入 / 返回，不在混合全图上无条件 BFS。算法返回见证边与条件、未展开 frontier 和解释来源；“静态可能路径”不表示其全部条件可同时成立，也不表示实际执行过。

控制依赖使用所选 CFG 出口语义下的支配 / 后支配关系计算。正常 / 异常出口和不可终止区域须在 profile 中说明；不能为了算法方便接一个虚拟出口后声称无限循环真实终止。可使用成熟图算法，但必须用异常、提前返回和无终止分支反例验证。

条件可行性首轮仅用 AL-06 已证明的常量与有限条件剪枝。更深路径敏感分析 / 本地 SMT 作为受预算专项，加入后仍需报告理论模型与超时；不能用 LLM 判断分支一定可达来改变事实。

显示管道聚合必须保留原成员与关系类型，选中一路可以取回其具体端口链。诸如 `tokenize → parse` 的宏观数据通路可以显示“经 compute 转交”，但不能生成不存在的 call 边。[CodeQL 关于数据流与值派生的区分](https://codeql.github.com/docs/writing-codeql-queries/about-data-flow-analysis/)

## 16. AL-10：框架、配置与 IO 模型

框架模型是有版本和测试的本地规则包，输入为语言事实、抽象参数与配置材料，输出为带源位置、条件、绑定依据和效果的关系。每条规则明确前置条件、参数 / 返回映射、注册与调用时机、依赖读取和不支持情况。

首轮规则覆盖可证明的 UMD / factory / DI、ESM / CJS、DOM 事件与计算器注册；Python 阶段加入受支持路由 / 装饰器和常见 IO API。不能只匹配函数名字或某个文件名：要证明被调用值属于对应 API / 注册器，考虑别名和被替换实现。

IO 按边界类别建立资源端口：文件、网络、数据库、队列、UI、存储。参数中的常量 / 有界模板形成路径或 endpoint 候选，实际文件描述符 / URL / DB 对象由运行证据补充。资源命名空间、环境、协议与构建条件属于身份，两个相同字符串不能直接连成确定跨服务调用。

配置 parser 提取结构、键 / 值、显式引用与代码消费点；读取动态键则用 wildcard / 候选，不能假设每个键都用到了。README、注释、.gitignore、测试和生成文件按角色与材料关系进入图，不强行生成函数。`fake_app` 自然语言 txt 中的函数描述保留为 synthetic / documented 材料，不冒充 parser 提取的可执行函数。

外部声明、schema、OpenAPI、protobuf、受控依赖模型可提供本地接口摘要，来源版本和覆盖清楚。tsconfig 插件、包管理器可执行映射、宏、模板或 build script 不在纯解析阶段自动运行；需要构建材料时由独立准备作业产生可验证 manifest，再由引擎读取。

## 17. AL-11：增量依赖、事实撤回与跨版本身份

### 17.1 记录真正读取的依赖

采用查询依赖图，每次求值记录读取了哪些输入和子查询。至少包含 blob、配置、模块 lookup、目录 / 文件存在性、导出接口、函数语义 IR、调用摘要、框架模型、依赖制品、算法 / 精度版本。

```text
parse_key = source_hash + parser_version + language_mode
binding_key = parse_key + build_variant + resolution_inputs + binder_version
summary_key = own_semantic_ir + abstract_input + context + precision_profile
summary_dependencies = actual read-set of callee summaries / heap models /
                       globals / framework rules / external models
result_fingerprint = canonicalized semantic result + unknown/effect state
```

不能只用依赖函数的 API hash 判断摘要是否可复用。`f(x) { return x }` 改为 `f(x) { return 0 }` 时签名相同，但 caller 的返回数据来源改变；新增文件使原本 unresolved 的 import 成功也是变化。

### 17.2 修改后的更新流程

1. watcher 触发 manifest 复核；漏事件、原子替换、删除、重命名和恢复窗口通过有预算对账补齐。
2. 标记直接输入变动的查询 dirty。重新验证它读取的依赖；必要时重新计算，比较**结果指纹**而非仅比较文件时间。
3. 结果相同可以阻止无关下游重算；结果改变或读取集合变化时更新反向依赖并使消费者失效。负 lookup 也在其中。
4. 对需要重算的函数 / SCC 从新的输入和底状态计算。旧固定点结果不能只继续 union：删掉一条调用或定义时，旧事实必须撤回。
5. 调用图边增删时重建受影响 SCC；跨旧 / 新分区的依赖闭包按保守范围重算，不能遗留环外旧摘要。
6. 把新结果写入 staging，校验后发布新 manifest；未变化分区只有其全部相关输入 / 子查询已验证时才复用。取消后的迟到写入被 generation / lease 拒绝。

语义结果相同允许复用计算 payload，但源码位置、来源依赖与证明 manifest 仍需按当前版本校验 / 重绑定。不得把旧源码证据仅改一个 snapshot 字段就用于新版本，也不能让进度文件或证据目录参与自身源码指纹形成循环。

Salsa 的查询依赖与结果变化检测提供参考，但不要求第一版使用某个特定 crate；Atlas 的持久化分区、负依赖与源码身份须自行满足本合同。[Salsa 增量算法](https://github.com/salsa-rs/salsa/blob/master/book/src/reference/algorithm.md)

### 17.3 实体匹配

同一快照身份与跨快照匹配分开。先匹配未变文件与明确稳定符号，再使用声明路径、签名、结构 hash 与邻域作重命名 / 移动候选；同名复制、重复代码与多个相等候选标 ambiguous，不凭最高分强制匹配。

评论 / 输入 / 测试锚点在无歧义映射时迁移；旧运行和旧源码证据仍绑定旧快照。增量与干净全量的等价比较针对相同输入、算法与充分预算下的完成结果；若一侧 partial，先报告状态与范围差异，不能将未完成结果当作等价证明。

## 18. AL-12：索引、有界查询与显示投影

核心使用分区内紧凑实体编号、字符串 intern、正 / 反邻接索引与类型分区；外部稳定 ID 与分区内编号通过字典转换。编号只能在对应 manifest / 分区内解释，不跨进程传裸指针，不让 JS number 承担任意精度 ID。

不可变邻接段可采用 CSR 或等价紧凑布局；增量写入产生新段 / 覆盖层，经压实和校验后发布。具体物理格式在 CA-00 基准确认；必须支持入边、出边、contains、调用点与来源查找，不能每次选区扫描全库 JSON。

| 操作 | 必须实现的算法 / 索引 | 成本说明 |
|---|---|---|
| 目录 / 文件展开 | parent 索引与稳定分页 | 与返回成员和索引查找相关 |
| 有界上下游 | 邻接索引 + 去重队列 + frontier | 访问子图 O(Vq + Eq)，输出与状态内存另计 |
| 静态环与分区依赖 | 迭代式 Tarjan / Kosaraju 或等价 SCC | 已物化选定图 O(V + E)，IO 与构图另计 |
| 数据源到汇 | AL-09 摘要 / 调用点匹配 | 不承诺普通 BFS 的成本 |
| 符号 / 文本检索 | 符号键与 FTS / 等价索引 | 不能被模糊检索结果替代精确 ID 查询 |
| 显示聚合 | 层级与边界端口分组、成员计数 / 引用 | 聚合的是投影，不修改事实 |

每个 cursor 绑定项目、owner、snapshot / revision、查询过滤、排序与分页位置；过期 / 跨项目 cursor 拒绝或明确重启查询。截断同时返回准确已返回量、可继续 frontier 和未遍历范围；不能将当前可见数当成全图总数。

布局、颜色和聚合只使用本地投影。边捆绑按关系种类、方向、证据和边界分组，静态候选与实际经过不能因画面美观混成一条“确定流动”。

2D / 3D 是同一事实的正式投影。ProjectionSpec 固定问题镜头 / 查询范围，ViewProjection 区分 display_instance_id、canonical_refs 与 invocation 上下文；聚合摘要保留真实路径 / 成员与完整性，不能将可达性当直接调用或可执行路径。静态 SCC / 分层布局只改变坐标，运行镜头按真实因果和实例构图，不按时间戳编造并发顺序。

具体双视图、布局稳定性与 DV-01–16 见 [双视图规格](/Users/yinsijie/CodeRepo/Modus/docs/code-atlas-dual-view-design-2026-09-08.md)。查询 / SCC 复用现有算法，数据切片复用 AL-09；语义投影、布局和渲染的成本分别计量。单纯切换维度不重解析全仓，也不调用 LLM。

## 19. AL-13：运行与静态事实关联

这层负责本地证据关联，不以一次运行代替静态分析。运行前绑定源码 / 构建产物 / source map / 环境 / collector manifest；静态锚点编译为探针位置或可验证映射表。

每个事件至少带 run、stream、sequence、事件种类、调用实例与源码位置材料；函数进入 / 返回按实例配对，异常与挂起不当作普通返回。异步任务靠传递的父任务 / span link / 注册与调度关联建因果，不能只按时间近邻猜父子关系。

运行对象身份在同一 run 中管理，值摘要不执行 getter / repr；序列化、拷贝和派生形成新的值身份或明确关联。缺少对象 / 字段探针时只展示已记录端口，不能画“完整字段血缘”。

source map 丢失、构建 hash 不符或定位歧义时事件保持 unbound；去重按 stream + sequence，缺口保留 gap。前端 reducer 从事件更新 ActiveSet / VisitedSet / TrailSnapshot，回放读取日志不重复执行业务 IO。

本地报告比较静态候选与已观测路线：未运行到某分支不证明该分支不存在；观测到静态漏掉的目标触发适配器 / 输入 / profile 诊断，不能覆盖原版本事实掩盖问题。

## 20. AL-14：覆盖、质量与本地说明

引擎生成三类本地材料：对象清单与源码来源、推导 / 未知原因、运行与验证报告。它可以说明“该调用通过参数绑定到某函数候选”“该返回值派生自参数”，无需 LLM；“这个模块承担某业务职责”的自然语言归纳仍属于可选解释。

每个统计分母独立记录：已发现文件处置数、受支持语法节点与错误区域、调用点总数及 resolved / candidate / unknown / external / pending、各层分析范围、运行采集缺口。不可访问目录只报告边界，不给未经枚举的精确内部数量。

验收同时约束 precision、recall、候选集合完整性、未知比例和支持特性。**把所有调用都标 unknown 不算完成受支持语义引擎**；对声明的简单绑定、别名、参数转交、闭包与 DI fixture，必须产生规定结果。未知标签服务于真实边界，不能作为跳过已要求算法的替代物。

oracle 使用独立手工标注小语料、语言标准 / 编译器材料、受控执行和变形测试结合。运行只提供已走路径的正证据，不能证明全部静态候选；编译器的类型签名也不能直接充当唯一运行目标的 oracle。预期结果不能从待测引擎自身输出自动拷贝生成。

## 21. AL-15：预算、调度与确定性

一次分析记录工作预算与物理资源预算：抽象集合 cap、上下文数、IR / 状态单元、操作步数、查询边数、RSS、IO / 输出字节和 deadline。精度与语义配置进入缓存身份，显示预算不改变事实。

采用有界任务队列和按项目 / 全局协调的并发配额；worker 输出分块，在解析和反序列化前检查长度、计数与总配额。重计算放在独立进程 / worker，Rust 服务拥有取消、超时与子进程回收，不能让一个 native parser 卡住整个宿主。

按需查询、当前选区和增量修复优先；后台大图作业可暂停 / 恢复。图构建、固定点求解和序列化均设检查点，不只在最外层加 timeout。取消和资源不足不能发布混合代次；进程被终止时保留旧 published manifest 与诊断。

测试模式固定队列顺序、随机种子和燃料预算；完成结果应与合法调度顺序无关。超预算输出标 partial 且记录 frontier，不能把不同时间截断产生的部分集合比较为完整等价。整体复杂度按实际状态空间、上下文和图规模评估；不要把 SCC 的线性复杂度外推为所有跨过程分析都线性。

## 22. AL-16：函数可执行性、上下文构造与测试切片

### 22.1 职责与输入输出

本算法回答“当前选中函数，能以何种入口和上下文执行，缺少什么，怎样验证”，不承诺对任意程序自动构造所有合法状态。Rust 核心负责计划和依赖推导，语言 / 框架 worker 提供版本化的装载、构造与驱动能力描述，ScenarioRunner 负责实际生命周期。全链可以在未配置 LLM 时工作；用户按需请模型编写新 fixture 属于后续代码变更，不能成为基本规划的必经步骤。

输入为 Snapshot / AnalysisRevision、选择实体 / 端口、测试目标、参数材料、AL-03–10 的绑定 / 效果 / 切片、已有测试与 fixture 静态索引、环境 / 驱动 / 探针能力、资源策略和工作预算。README 声称可测试只能作为线索；不通过 import、require、加载插件或测试动态收集来补全只读解析事实。

输出为 FunctionExecutionProfile、一个或多个 ExecutionContextPlan、候选排序理由、未满足前提、未知边界与前沿。每个候选附 `needs_setup / ready / unavailable / stale` 及证据；只证明计划可准备时不能声称函数已经运行或测试通过。

最低内部对象：

```text
Requirement(kind, owner, binding_or_port, abstract_shape, provenance, certainty)
Provider(kind, provides, requires, setup, teardown, effects, adapter_version, validity)
PlanStep(provider_ref, bindings, preconditions, completion, ownership, cleanup)
EntryCandidate(entry_ref, target_refs, reachability_evidence, invocation_recipe)
PlanResult(selection, entries, context_steps, boundary_bindings,
           dependency_envelope, observation_spec, assertions,
           unmet, unknowns, frontier, identity, status)
```

Requirement 包含参数、receiver、捕获变量、模块初始化、全局 / heap 状态、事件循环、浏览器 / native 能力、资源、生命周期和探针。Provider 来自真实参数材料、受支持工厂、已有 fixture / 测试、项目启动适配器和明确的替身；类型可赋值或变量同名不足以证明它可提供满足业务不变量的实例。

### 22.2 有界推导与计划构造

1. **绑定目标。** 校验项目、快照、函数 / 端口身份和 source hash；区分用户选区、测试目标与实际入口。同名、重载签名与运行实现不能混成一个可调用对象。
2. **计算需求。** 从参数 / receiver / 自由变量开始，沿绑定、heap 读写和已解析调用摘要求依赖包络；加入模块装载与注册前提。使用 AL-08 的 SCC 摘要复用递归结果，不为每个函数展开完整调用树。未知调用的效果仍是未知，不能因此推导“无依赖、纯函数”。
3. **寻找提供者。** 按目标绑定查询已有 fixture、工厂、构造器、已知测试入口和框架生命周期描述。优先复用满足要求的方案；构造器、模块初始化、测试收集本身的 IO 和失败出口也属于计划。装载 JS 模块或 Python 模块不等同于只执行一个导出函数。
4. **生成入口候选。** 为可装载函数生成直接驱动；为可构造实例 / 闭包生成工厂驱动；为私有或事件函数沿反向调用 / 注册关系有界搜索上游入口。候选路径保留调用匹配与条件，不把图可达当作条件可满足。只有原来的词法环境或受验证的适配器可恢复捕获值，不能把抽象 heap location 当作真实对象。
5. **解构造前提。** Requirement 的提供方式是 OR，同一 Provider 的全部前提是 AND。工作队列展开当前候选并记录已满足、待构造、冲突与未知需求；循环依赖只有在适配器声明可执行的启动 / 两阶段初始化协议时可消解，不能任意拓扑排序制造顺序。缺少提供者输出具体缺项与候选替代路线。
6. **绑定效果边界。** 每个外部依赖记录 real / fake / recorded_response；替身由策略或明确场景选择，不能因为真实环境难准备就静默替换。替换绑定按语言真实查找位置及作用域实现，不能全局按函数名替换。只记录调用而不替换行为的 observer 另行声明，防止误改返回、异常和调度。
7. **编译观测与断言。** 从目标调用实例、参数 / 返回、所需状态和 IO claim 生成 ObservationSpec；每个 AssertionSpec 映射其必要探针、资源、完成条件和独立预期。不可观测的 claim 标缺项，其他可观测部分可继续探索。测试驱动不得为了输入类型通过而提前修正或过滤要测试的非法数据。
8. **排序与冻结。** 对满足必要前提的计划，按已有测试复用、构造 / 效果成本、观测缺口和范围大小稳定排序，保留理由。冻结版本依赖后交 ScenarioRunner；索引 / prepare 阶段不执行 provider。需要安装或初始化时状态为 needs_setup，实际准备成功并验证前提才成为 ready。

局部纯函数也可能调用纯依赖；“可以单独测试”指存在可管理的执行上下文，不要求其调用图只能有一个节点。测试范围不裁剪程序控制流：运行时实际经过的未选中函数仍然执行和记录，仪器视口不可影响业务分支。

### 22.3 可调用性与运行语义

方法驱动保持 this / self 与实例初始化不变量；闭包经原工厂在新 run 内取得；模块私有函数优先通过公开入口观测。函数 AST 抽取、添加临时 export 或改写私有访问若用于研究，必须作为独立的变换构建绑定补丁 / source map，经过语义差分验证，不能冒充未修改原程序的执行；首批正式实现不依赖这种捷径。

异步函数的入口返回 Promise 与其完成 / 拒绝分开处理；generator 的创建、next / send、yield、throw 与 close 需明确驱动协议，不能创建迭代器就算函数已执行完成。事件处理器需要注册及有效触发动作；等待 / 取消 / timeout 均使用 Runner 拥有的生命周期。历史 trace 可提供输入样本与实例线索，但无法由此保证恢复整个堆、文件句柄、数据库事务或外部服务状态。

目标触达按本次调用实例映射判断：观测到进入即 reached；监测覆盖完整且场景结束未进入才能给 not_exercised；缺 probe / source map / 有 gap 时为 unknown。这与场景 exit code 和断言结论独立；不使用“入口完成”代替“所有所选目标完成”。

### 22.4 多选、效果验证与 AI 材料

独立批量计划默认为每个目标创建独立状态，并保留成员回执；共享服务的冲突资源需串行或明确隔离。关联场景选真实入口，按实际调用实例记录经过哪些目标；没有共同入口不能凭选择顺序连接函数。人工组合以 DriverConnection 明确端口、转换和控制规则，运行记录中标出该接线来自驱动，不写成项目内 calls / data-derived 事实。

效果验证使用 `request → completion → observation → assertion` 材料链，各环节可以有缺项。复制到替身时，实际参数和次数可以独立断言，但没有 real clipboard write claim；真实复制文件 / 剪贴板时，使用独立读回、资源身份和测试标记核对内容。写完成、读回匹配、无额外写入与失败处理分别判断。一个包装层返回 success 不能覆盖下层 write 失败；没有独立预期的 trace 只报告观察结果。

选择到 AI Coding 的本地材料包括所选源码、依赖包络、必要调用方 / 契约、构造计划、替身模式、实际运行 / 断言、未知边界。读 / 运行范围可以超出选区，写范围仍由 ChangeIntent 规定；删除 / 改名 / 新增同时检查调用接入、导出、注册与回归。ContextCompiler 的预算截断必须留下可继续读取的缺项，不把未发送材料当作已经被模型理解。

### 22.5 缓存、复杂度与验收

缓存键覆盖被读取的语义摘要、负 fixture / 入口查询、环境与驱动 / 探针能力、输入形状或影响选择的具体值、替身和约束版本。新增工厂、闭包状态需求变化、函数体效果改变、只改配置 / fixture 都可能使计划失效；RunSpec 再冻结完整输入 hash。ready 不是跨快照可永久复用的资格，执行前再次检查环境与资源前提。

全仓只预计算小型 profile 和共享索引；详细计划按选区展开。设候选入口数、上游深度、展开边数、Requirement / Provider 数、构造方案数、步骤与 deadline 上限。可从 32 个候选、64 层上游、2048 项展开需求作为待测默认预算，具体值由语料测量决定。预算耗尽输出 partial / frontier 和已获得候选，不证明“没有可用入口”。不要枚举全部调用路径或全部 provider 组合，也不宣称找到全局最小可执行切片。

已完成图访问的成本为所访节点 / 边加摘要查询；多候选前提求解取决于展开状态数，组合搜索不保证线性。用 AL-15 的燃料、取消和按需缓存限制；控制某个目标规划不会阻塞全仓 Review。ET-41–52 验证真实模板、依赖构造、效果 claim、观测缺项和多选 / AI 边界；无模型验收覆盖 profile、prepare、run 与基础报告，不只覆盖 AST 导入。

### 22.6 业务场景与画布开发的算法衔接

成熟能力规格第 4–7 节扩展本层，原 AL-16 仍负责具体入口和上下文。ScenarioCompiler 使用有来源的 BoundOperation 和类型化步骤生成计划：校验绑定、输入定义支配使用、分支 / 循环 / 等待预算、状态前提与断言 probe，复用 AL-16 准备每个入口；业务状态搜索使用明确模型而不是凭源码名猜规则。计划静态合法、目标实际触达、业务断言通过是独立结果。

LLM 提出 ScenarioIntent / Plan 或拟新增对象，只能进入带来源的设计层；AL-12 生成计划 / 检查投影，AL-13 的运行事件才能生成实际激活。ViewCommand 必须校验当前 graph_layer / revision 与 evidence 引用，禁止更新事实或虚构执行。

候选源码流形成完整编辑块和版本化 snapshot 后，AL-01–11 正常解析、撤回旧事实与发布 GraphDelta；IntentGraph 通过 ProposalBinding 映射到真实 CodeGraph，不按名称直接覆盖实体身份。部分语法、跨文件未完成变更和冲突保留明确状态。源码已生成不代表调用已接入或测试通过，旧 run 不绑定新源码。

新增业务 / 画布合同与 MX-01–10、MT-01–24 的入口见 [成熟能力规格](/Users/yinsijie/CodeRepo/Modus/docs/code-atlas-maturity-and-scenario-spec-2026-09-07.md)。这些是本地算法之上的真实执行和协作能力，不用 LLM 补图取代任何 AL 规则，也不因原 52 个 ET 已通过就省略成熟业务测试。

独立宿主通过 [集成规格](/Users/yinsijie/CodeRepo/Modus/docs/code-atlas-standalone-integration-spec-2026-09-08.md) 的 WorkbenchState / SelectionEnvelope / InteractionRequest 读取同一事实与上下文。协议适配不新增模型求图器：冻结快照、选区物化、AL-12 有界查询、AL-16 上下文、AL-13 运行证据与披露过滤仍在本地执行。HI 用例补充跨宿主和状态一致性，不替代 ET 的算法验收。

## 23. 算法用例与通过条件

以下 52 个 ET 用例是原 47 个产品案例的算法与执行规划层补充，存在覆盖关联，不应将相加后的数量宣称为互不重叠的功能。它们必须成为可执行 fixture / 属性测试 / 差分测试，记录源码、profile、预期事实与禁止出现的错误结论。

| ID | 输入 / 故障 | 必须观察到的算法结果 |
|---|---|---|
| ET-01 | 嵌套忽略目录、不可访问目录、symlink 环 | 有处置 / 边界，无无限遍历或虚构总数 |
| ET-02 | 读取期间原子替换、多文件持续写入 | 重读或 unstable；不用于正式执行基线 |
| ET-03 | BOM、CRLF、emoji、非 UTF-8 | 原字节与 UI / UTF-16 跳转一致，不偏移到另一符号 |
| ET-04 | 复制同内容文件、同名函数、嵌套匿名函数 | 身份和物理归属不合并，数量规则一致 |
| ET-05 | 半个语法错误文件、0 函数配置文件 | 保留可用对象与错误区间；不制造函数或确定关系 |
| ET-06 | import alias、re-export、循环模块 | 按真实绑定建边，循环不会导致无限解析 |
| ET-07 | tsconfig 条件 / paths、声明文件与 JS 实现不同 | 分离类型与运行目标，配置进入身份 |
| ET-08 | 原 import 不存在，随后新增文件 | 负依赖失效，旧 unresolved 被正确更新 |
| ET-09 | Python 函数后文给 x 赋值、前文读 x | 不错误绑定外层 x，保留未初始化语义 |
| ET-10 | JS block shadow、TDZ、类型 / 值同名 | 正确作用域与命名空间，不按名字混合 |
| ET-11 | `false && sideEffect()` 与 `null ?? f()` | 按语言条件处理 RHS，副作用不提前出现 |
| ET-12 | `return` 经过 finally，finally 再 return / throw | completion 覆盖与异常出口正确 |
| ET-13 | 带 label 的嵌套 loop、break / continue | 连到正确 continuation，不变成函数返回 |
| ET-14 | getter、proxy、Python 特殊方法 | 静态解析不调用它们，效果模型不误标纯读 |
| ET-15 | if 两支分别赋予不同函数再调用 | 候选保留两者，条件不被强猜 |
| ET-16 | 局部先赋 f 再赋 g 后调用 | 强局部更新，调用点不继续指向旧 f |
| ET-17 | 两变量别名同对象、未知字段写入 | 弱更新 / wildcard 影响后续读取，不漏候选 |
| ET-18 | 循环在同分配点创建多对象 | 抽象位置 singleton 不触发错误具体强更新 |
| ET-19 | 函数目标 / 常量超过 cap | Top / 精度合并或 partial，不截前 K 项伪装完整 |
| ET-20 | 未知外部调用拿到对象和 callback | 返回 / heap / 注册效果有未知分量，不断言无副作用 |
| ET-21 | 两个 caller 以不同参数调用同一个函数 | 参数 / 返回按 CallSite 匹配，不跨 caller 串流 |
| ET-22 | 有终止分支的直接递归与互递归 | 摘要 SCC 收敛；pending 不变成“无返回”证明 |
| ET-23 | 求解期间新增间接调用边形成环 | 更新 SCC / caller 依赖，不沿旧拓扑漏分析 |
| ET-24 | 类型只给一个签名，函数属性可被替换 | 不凭单签名生成错误 resolved |
| ET-25 | DI / factory 返回替换实现并重命名变量 | 规则依赖绑定与值传播，不依赖 fixture 文件名 |
| ET-26 | callback 注册但从未触发 | 静态注册可见，真实执行不伪造调用 |
| ET-27 | compute 转交 tokens / AST | 正确 call 与 data-derived / forwarded 边，禁止虚构 tokenize calls parse |
| ET-28 | 两路径条件矛盾，图中存在源到汇路线 | 标可能路径和条件，不声称已证明可执行 |
| ET-29 | 异常路径与不终止分支的控制依赖 | 出口假设明确，不伪造退出 / 控制证明 |
| ET-30 | 函数体从 return 参数变为 return 常量，签名未变 | caller 来源摘要重算，API hash 不阻断传播 |
| ET-31 | 删除调用、移除定义、调用 SCC 分裂 | 旧事实撤回，不只向旧结果做 union |
| ET-32 | 重命名 / 复制产生多个匹配候选 | EntityMatch ambiguous，评论不错误自动迁移 |
| ET-33 | 相同最终源码的增量与干净全量 | 完成结果的事实、来源与未知状态等价 |
| ET-34 | revision 变化、跨项目 cursor、截断查询 | 版本 / owner 校验与 frontier 正确，不漏标截断 |
| ET-35 | 解析 worker 崩溃、取消后迟到输出、磁盘满 | 旧分区可读，新批次不污染 current，进程被回收 |
| ET-36 | 静态索引在禁网和无模型环境执行 | 功能按 profile 可用，provider 边界调用 0、无解析上传 |
| ET-37 | 声明已支持 fixture 却将所有关系标 unknown | 质量门失败；precision 不能掩盖 recall / 覆盖缺失 |
| ET-38 | source map 错版、事件乱序 / 重复 / 缺口 | 不误绑源函数，保留 unbound / gap、正确去重 |
| ET-39 | async / yield 后恢复、两个并发调用 | 静态挂起与运行实例分离，因果不靠时间近邻猜测 |
| ET-40 | 改调度顺序、缩小预算、海量函数 / 边 | 完成结果稳定；partial 明确；CPU / 内存 / 查询受控 |
| ET-41 | 公开纯函数调用另一个纯函数；参数含非法类型 | 本地生成直接驱动，依赖照常执行，原始非法输入到达目标；独立断言正确 |
| ET-42 | 方法依赖 this / self、工厂闭包依赖可变捕获值 | 正确构造实例 / 原词法闭包；缺材料列出需求，不拿抽象值或旧 run handle 代替 |
| ET-43 | 私有函数只能由按钮触发，条件分支本次跳过它 | 候选上游可运行；完整监测下目标 not_exercised，不因入口 exit 0 判目标通过 |
| ET-44 | 模块装载 / fixture 初始化有 IO、循环前提、setup 中途失败 | 静态 prepare 不执行；真实 setup 纳入效果与清理；无启动协议的循环不伪造可构造顺序 |
| ET-45 | 复制函数接记录型剪贴板，注入写失败 / 重复调用 | 精确参数 / 次数 / 错误断言，事件标替身；不能出现实际系统写入已验证结论 |
| ET-46 | 真实文件 / 剪贴板复制；目标原值相同、内容错误、格式错误 | 使用区别于旧值的测试材料、独立读回与资源绑定；识别错误和观测竞争，不靠成功提示通过 |
| ET-47 | 无断言运行、读回探针缺失、错误被上层捕获 | 观察结果与正确性分开；缺材料只影响相关 claim，不凭正常返回证明真实副作用 |
| ET-48 | 同一函数两次并发调用，流事件乱序且其中一个有 gap | 值 / IO 绑定各调用实例；精确证据与未知分开，弹窗与报告不串调用 |
| ET-49 | 多选无共同入口；再人工连接输出到输入；批量使用有状态 fixture | 分别测试 / 实际场景 / 驱动接线明确区分，状态隔离；不把人工路径写成项目事实 |
| ET-50 | 选一个函数解释 / 删除，另有调用者与字符串注册；写范围不含调用者 | 模型材料带相关上下文和未知；删除检查契约与回归，读范围不自动扩大写授权 |
| ET-51 | 仅改变 fixture、捕获需求、环境能力、函数效果或新增入口 | 对应计划失效 / 重算，旧 ready 与旧回执不得绑定新条件；保留失效原因 |
| ET-52 | 禁用模型规划并测试上述 fixture；未知 native 入口 / 预算截断 | 已支持例得到可执行计划与零 provider 调用；真缺项 / frontier 可见，不全标 unavailable 混过验收 |

所有集合和域运算增加性质测试：join 的幂等 / 交换 / 结合、转移单调性、序列化往返、来源引用完整性。变形测试至少覆盖符号一致重命名、无关文件增加、格式 / 注释变化和函数体语义变化。变形预期要注明何种关系应保持、何种应改变。

## 24. 引擎验收门与开发顺序

引擎可以逐步实现，但“完整本地引擎”不能由 UI 完成度替代。维持 R0–R3 阶段，增加算法维度的证据索引：

| 门 | 必须具备 | 与产品阶段的关系 |
|---|---|---|
| GE-0 真实基础链 | AL-00–04 的受支持 JS/TS 规则、版本化事实、AL-12 查询、AL-14/15 基础；ET-01–10、34–36 | 首条引擎链；可以开始真实 UI 接入，不宣称完整语义 |
| GE-1 本地语义链 | AL-05–08 的计算器与声明子集、AL-10 初始规则；ET-11–27 及 ET-37；算法与关系反例通过 | 正式 R0 的语义 Review 门；基础 CFG / def-use / 调用摘要不能全推迟到 CA-16 |
| GE-2 运行与增量 | AL-11 完整失效 / 撤回、AL-13、AL-16，Python 对应规则与异步 / 外部 IO；ET-30–33、38–39、41–52；原 / 新环境证据 | R1 对 JS/TS 与已发布运行 / 函数测试能力验收；R2 补齐混合语言 / 增量 / 外部 IO / 迁移全范围 |
| GE-3 大项目深分析 | AL-09、分区摘要与全部适用 AL；ET-28–29、40；全部适用用例无未解决关键错误，主设计 L 档质量与资源资格 | R3 大项目发布门 |

门中的用例只对其声明 profile 取得资格；一个用例含多语言变体时分别记录结果。不能通过只保留最简单语言子集规避已经列入相应阶段的必做能力。后续领域扩展仍按主设计继续增加模型与语料。

ET-41–52 在 R1 必须具备 JS/TS 的直接调用、实例 / 闭包工厂、实际 APP 上游触发、替身剪贴板和真实临时文件复制、观测 / 断言、多选与修改边界。真实系统剪贴板至少在一个声明支持的桌面或浏览器环境取得 ET-46 资格后，才能显示该模式通过；R2 补齐 Python 和目标平台适配，未取得资格的平台仍提供明确的当前缺项。不能仅用复制动画代替以上 fixture。

算法台账对每个 AL 记录：实际 crate / 函数、输入输出 schema、已实现规则、未支持规则、复杂度 / 资源测量、ET 与产品案例映射、证据、状态和下一步。UP / CA 仍是原 23 个基础工作包，AL / ET 是其中必须追踪的实现与验收维度；成熟范围新增的 MX / MT 单独追踪，不覆盖原证据。

当前进度应先完成可验证的 IR、绑定与固定点小语料，再扩大到仓库和可视化；不要先写大量动画再让模型猜图。大项目要求从首条链保留身份、分区、预算、来源与未知合同，但深度分析的规模和语义覆盖按门扩展。

## 25. 技术来源、可替换点与剩余验证

本文参考了 TypeScript / Python 的语言接口、Tree-sitter 增量机制、Clang / MLIR 数据流框架、CodeQL 对数据流与派生的区分、Salsa 查询依赖，以及 Reps / Sagiv / Horwitz 的跨过程可实现路径研究。来源链接位于对应算法说明中。它们支撑技术路线，不是 Atlas 已实现或达到论文保证的证据。

AL-16 是 Atlas 在上述分析结果之上增加的本地计划层，不是某个解析库自动提供的功能。依赖替身与真实效果的区分参考 [Python unittest.mock](https://docs.python.org/3/library/unittest.mock.html) 和 [Playwright mock APIs](https://playwright.dev/docs/mock)；实际剪贴板读写适配参考目标版本的 [Electron clipboard](https://www.electronjs.org/docs/latest/api/clipboard)。这些工具证明相应基础设施存在，不证明可以为任意函数自动重建上下文或推导正确业务预期。

首轮采用“有界抽象解释 + 调用点匹配摘要 + 依赖增量”的具体组合。可以更换 crate、存储表示、工作队列、持久化和相同语义的图实现；替换算法必须保持来源、完整性、反例和性能合同，不能只保留同名接口。

仍须通过实现回答：各语言降级规则是否正确，抽象域与效果模型是否足以达到受支持范围的精度，框架模型能否泛化，跨过程状态是否在目标预算内收敛，分区与撤回是否正确，以及运行映射是否改变被测语义。文档可指导实施，这些结论必须来自代码、ET / 产品验收、真实仓库抽样与性能证据。

## 26. 首轮实现后的正确性强化合同

本节由 [独立审查](code-atlas-implementation-review-2026-09-08.md) 的实际反例驱动，补强已有 AL，不另建第二套分析引擎。整改顺序见 [执行任务书](code-atlas-remediation-work-order-2026-09-08.md)。新增字段与机制是目标合同，不能据本节声称产品已实现。

### 26.1 值来源、候选目标和未知必须分维度保存

建议的抽象状态至少分为：可调用目标集合、值来源集合、必要类型/常量、对象位置/字段以及效果/未知。`Parameter(index)`、`CallResult(callsite,callee)`、`Constant`、`AllocationSite`、`ExternalInput` 等来源是可追踪身份；参数值未知不等于参数来源未知。

在 `identity(x){return x}` 中，入口给 x 的来源必须是 Parameter(0)，返回保持该来源。调用者执行 `identity(d)` 时用该调用点实际值来源替换参数洞。若 d 是函数，结果的可调用目标包含 d；若 d 来源未知，仍保留它从该参数/调用点而来的证据。

抽象域须定义 bottom（无可达状态）、unknown/top（可能但未建模）与普通空集合的区别。合流为各维度 join；强更新仅在唯一绑定/唯一别名目标成立时使用，其他写操作弱更新。cap 超限加入未知剩余分量及原因，不能把候选任意截短后仍作“只有这些目标”的证明。已知来源可继续展示；任何否定性断言都必须检查 unknown 传播。

### 26.2 以完成状态驱动 CFG 数据流

不要让 CFG 和另一份 FlowNode 解释器各自维护不一致的异常语义。可以保留语言树用于提取，但求解输入应转为具有统一边语义的块与指令。

对块 b：`IN[b] = join(OUT[p,e])`，其中 e 带 normal/throw/return/break/continue 完成类型；`OUT[b,e] = transfer(b, IN[b], e)`。只沿可达且受支持的边传播，常量剪枝必须有语言语义依据。工作队列直到所有相关输出稳定，或记录预算退出与未处理前沿。

try 正常出口保留 try 执行后的环境；可能异常出口进入 catch；catch/try 的完成状态进入 finally。finally 正常完成时恢复传入的完成类型，但保留 finally 对环境和效果的修改；finally 自己 return/throw/break/continue 时覆盖传入完成类型。`let f=a;try{f=b}finally{};f()` 不能恢复 f=a。

循环合流必须迭代到固定点或 widening 的保守结果。单遍循环可以作为显式低精度 profile，但不能遗漏循环携带候选而标为完整。return/throw 后不可达的指令不继续按正常路径执行；未支持的语言构造通过诊断和 unknown 进入结果，而不是隐式跳过。

### 26.3 调用点身份和跨过程固定点

CallSiteKey 至少由源码版本/文件、调用方符号、调用表达式范围或稳定局部键组成；裸 `c1` 只能在 worker 文件载荷内部暂用。进入 Rust 后 canonicalize 一次，所有 CallResult、实参记录、绑定边、摘要桶、trace 映射使用同一规范。

工作结构包括：callee → incoming callsites，caller → outgoing callsites，callsite → callee candidates/actual arguments，以及 callee summary → dependent callers。actual arguments 从 caller 的调用点记录取，不能在 callee 的函数体中查找。

k=1 的上下文桶以 `(callee, latest_callsite)` 标识。调用传递将 actual → formal，返回沿匹配 callsite 代回 caller；不能把不同调用者的实参交叉组合。函数级展示可以合并各桶，但调用点的精确需求不能反过来消费已经丢失上下文的全局并集并宣称 k=1 精度。

调用图以 SCC 凝聚；按依赖顺序求非递归分量，递归分量内做单调迭代。新增目标边可能扩大 SCC/依赖，必须重调度受影响分量。摘要至少分别管理 return、may-call、effects、throws、unknown/approximations；某分量未建模不能使整个函数被推成 pure。

传递调用满足 `Reach(f) = Direct(f) ∪ union(Reach(g), g∈Direct(f))`。可以缓存分区或按需查询，但 `a→b→c→d` 的全范围摘要必须包含 d，或明确给出未展开边界；不能把固定两跳称为闭包。全量传递矩阵可能二次增长，优先 SCC 摘要/按需展开，预算返回部分结果而不是冒充完整矩阵。

### 26.4 “收敛”不等于“完整支持”

每份事实/摘要/报告至少可回答：生产者及版本、输入 profile、所依赖的快照和配置、是否已收敛、语义覆盖、来源、未知理由、截断/预算、支持的 claim 强度。建议分列 `solver_status`、`semantic_coverage`、`approximations`、`unprocessed_frontier`，不得用一个 success 或数字 confidence 代替。

converged 只说明规定抽象域和输入下迭代稳定。若某特性尚未建模、某调用未解析或某边被截断，用户看到的是有缺项的稳定近似。对已支持的普通参数、调用和控制流，不能只改状态为 partial 来逃避语义错误。

### 26.5 不可变目录、分析修订与并发发布

BlobId 是内容地址；CatalogRevision 表示本次清点，包括无法取得 blob 的文件、链接和排除边界；Snapshot 绑定项目与材料；AnalysisRevision 绑定 snapshot、语言/框架/配置/求解 profile。允许内容跨项目复用，owner 和 current 不复用。

物理表如何拆分可评估，但已发布引用必须不可变。新增 symlink、未捕获材料或配置变化后，旧 revision 的目录和证据不得变化；禁止按旧 snapshot_id DELETE 后重建目录表。元数据来自实际采集内容，扫描与捕获间变化需要重新校验/标记。

blob 写入者拥有唯一临时文件；同内容并发发布可校验并复用赢家结果。同步/rename 失败如实传播；SQLite 发布事务、revision 分配和 current CAS 同步设计，不能只对最后 INSERT 使用事务而忽略前面修改的历史表。

### 26.6 有界查询需要约束内部工作

查询上下文固定 owner/project/snapshot/revision/profile、查询种类、过滤器和排序。cursor 绑定该上下文及 continuation，跨过滤器/owner/project/version 拒绝；用户可以显式切 current，但同一分页操作不能偷偷升级版本。

tree 读取目录级索引和聚合；邻域按有界邻接页读取，不把某高扇出节点全部边先放内存；source 按 blob 指定 UTF-8 byte `[start,end)` 窗口读取。区间不减一，越界、负数、无效编码和响应上限有一致语义。

预算包含 visited/scanned nodes/edges、worklist steps、读字节、输出字节、deadline、RSS/队列约束与取消。truncation reasons 单调累加；不能在最后一次 pop 后因为 queue 为空就把先前截断改回 false。被省略的端点给 boundary stub/continuation，图中不出现无说明的悬空引用。图遍历/关系 join 的复杂度按实际访问量计，不能从输出条数推断整个查询是有界的。

### 26.7 增量必须验证撤回与负依赖

缓存键覆盖内容、解析器/语义版本、语言配置、模块解析条件、锁文件、框架模型和精度预算。保存成功和失败查询的依赖：原先 `import './missing'` 不存在也是依赖，新文件出现须使结果失效。

修改/删除/重命名引起事实撤回，再重算受影响 bindings、SCC/摘要、执行画像、报告和投影。图布局可尽量保留用户方位，但旧实体映射必须有证据；不能为稳定动画留着已不存在的关系。相同最终内容和分析 profile 下，增量和干净全量的规范化结果（含 unknown）应等价。

### 26.8 可执行画像与受控运行不可互相替代

AL-16 输出的是可执行性分析、候选入口、环境/依赖缺项与准备计划；是否真的运行仍由具备版本和效果边界的 RunSpec 决定。profile 中 direct_callable 不能自动证明没有网络/文件/数据库效果。

prepare 固定源码材料和环境，run 校验 digest，采用实际进程/输出/取消预算与持久幂等。collector 不应改变 this、构造、异常和异步完成。返回、settled、真实 readback、断言 verdict 分开；采集覆盖不足不构成没有调用/没有副作用的证明。

### 26.9 验证方法与原编号映射

| 验证层 | 新增反例/方法 | 归入原合同 |
|---|---|---|
| 局部语言语义 | 参数来源、try 正常更新、finally 覆盖完成、循环携带、作用域/Unicode | AL-02/05/06/07，ET-04/10–18 |
| 跨过程 | 四层以上闭包、两个 caller、同名 c1、返回函数、递归/cap、真实 worker 到 store | AL-03/04/07/08，ET-19–27 |
| 版本和并发 | 旧目录不变、同 blob 多 writer、project/profile 隔离、CAS/失败取消 | AL-01/11/12/15，ET-02/08/33–36 |
| 查询和大图 | 零预算、单节点、高扇出、分页换过滤器、boundary stub、全量可达 | AL-12/14/15，ET-34/36/40 |
| 运行和画像 | 超时输出、源码固定、幂等、async/构造保真、覆盖缺项、真实效果 | AL-13/16，ET-38–39/41–52 |

层级包括小规则单测、真实语言前端集成、解释器执行对照、变换后关系保持/变化的性质测试、受支持范围中的抽样误报漏报、全量/增量等价、资源和生命周期故障注入。手工构造 IR 或 SummaryProvider 的测试保留，但不能替代真实源码链。

禁网/无模型资格单独执行并记录观测手段；`model_calls=0` 固定字段不是测量。语义资格、规模资格、UI/Host 资格各自有结果。新增反例是现有 ET 的细化，不改成 70 个 ET 或自动增加顶层包。
