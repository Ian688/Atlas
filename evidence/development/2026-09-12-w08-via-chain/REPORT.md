# W08：多层闭包链（`--via-chain`）

窗口：`2026-09-12/w08-via-chain`
日期：2026-09-12（Asia/Shanghai）
结论：**DELIVERED**。嵌套闭包从"只能取一层"扩到任意深度（上限 8），而且**每一环都按同一把源码同一性尺子核对**——链条不会因为"中间那层看起来对"就被信任。

## 1. 之前是什么样

第 5 轮交付的 `--via` 只能走一层：`makeCounter → increment`。嵌得更深时（`outerFactory → middle → inner`）静态拒绝 `closure_depth_not_supported`。理由是诚实的（一层之外的实例只能由更外层真实产生），但能力是缺的。

## 2. 现在是什么样

### 2.1 语义划分不变

`--via` **永远**表示"目标的包含函数"（必须逐字等于 `enclosing_symbol`，否则 `via_not_the_enclosing_symbol`）。新增的 `--via-chain` 是**它之上**的祖先，由外到内：

```bash
atlas exec $A 'src/counter.js:inner' --args '[3]' \
  --via 'src/counter.js:middle' \
  --via-chain '[{"symbol":"src/counter.js:outerFactory","args":[4]}]' \
  --allow-effects unknown_calls
# → returned 7      （outerFactory(4) → middle() → inner(3) = 4 + 3）
```

调用顺序 `via_chain… → via → 目标`。上限 8：每一环都是一次真实调用，没有上限就是无界运行。`--via_this` 仍然只给最近一层；`--via-chain` 的每一项带自己的 `args`/`this_arg`。

### 2.2 链本身要被图证明

链不是调用者说了算：

| 情况 | 结果 |
|---|---|
| 某一环的包含函数不是上一环 | `via_chain_not_connected`（**请求不成立**，命令失败，不发布记录） |
| 最外一环不是顶层 | `via_chain_not_rooted`（只有顶层才可能出现在模块命名空间里） |
| 给了 `--via-chain` 没给 `--via` | `via_chain_without_via`（validate 阶段拒绝） |
| 超过 8 环 | `via_chain_too_long` |
| 某一环自己的画像不允许运行 | 拒绝记录 `via_scope_refused`，detail 里带上"链上第几个" |

前四条是**请求形状**问题（和 `invalid_materialise_mode`、`via_symbol_not_found` 同类），所以命令失败；第五条是关于分析的**决定**，所以发布一条 `refused` 记录——`refused` 不是失败的执行。

只给 `--via` 而包含函数自身也是嵌套的，仍然拒绝 `closure_depth_not_supported`，但 detail 现在**可行动**：它具名下一层，并说明"请把这一层（以及更外层，按由外到内顺序）加进 `--via-chain`"。

### 2.3 harness：阶段循环，每环同一把尺子

`payload.via.stages[]` 每项是 `{name, args, this_arg, source}`，其中 `source` 是**该环必须返回的那个函数**的钉住字节（最后一环是目标）。执行循环：

1. 用最外一环的源码在模块命名空间里按源码同一性找到它（命中不了是 `enclosing_not_exported`）；
2. 逐环调用：返回值必须是函数，且 `Function.toString()` 必须与**下一环符号**的钉住字节匹配；
3. 全部通过后才调用目标。

失败点被记录而不是被吞掉：

- 某环返回的不是函数 → `closure_not_returned`，`failed_stage = i`，该环的返回值原样保留；
- 某环返回的是**别的**函数 → `closure_identity_mismatch`，`failed_stage = i`，并保留观测到的源码与它本该是哪个符号（`expected`）；
- 某环抛出 → `verdict=threw`，`failed_stage = i`；
- 目标自己的抛出不再可能被外层 catch 误报成 `module_load_failed`（这一条在重写时发现了：非 via 分支必须有**自己的** try/catch，否则目标抛错会落到外层的模块加载 catch 里）。

### 2.4 记录形状向后兼容

`stage_report` 仍然是**产出目标实例的那一环**（一层深的闭包就是唯一那一环，字段含义与第 5 轮完全一致：`matched_by/value/thrown/closure/export_name/awaited`），新增：

- `stage_report.stages[]`：每一环的 `{index, name, args, awaited, value, thrown, closure{matched_by,name,expected,observed_source}}`；
- `stage_report.failed_stage`：哪一环失败（全成功为 `null`）；
- `via.ancestors[]`：最近一层之上的祖先（一层深时是 `[]`，所以旧记录读起来一模一样），每项带自己的 `state_binding` 与 `decision`；
- `via.chain` / `via.chain_length`：完整符号序列，便于不必手工把 `ancestors` 与顶层字段拼回去；
- `trace.events`：每个祖先一条 `call` 事件（`stage_index`），最后是 `stage: target`。

### 2.5 页面与宿主

- 页面**逐级查出**祖先：对 `enclosing_symbol` 调 `/api/profile`，读它自己的 `enclosing_symbol`，如此向上（有界 8），把结果预填进祖先链输入框——符号来自分析，用户只提供实参。若画像与被查符号不一致，停止追溯并明确说明，改用 CLI 给出 `--via-chain`。
- 页面按阶段渲染（每环一行：调用了谁、返回了什么、下一级源码同一性是否匹配），并显示"祖先链（由外到内）outer → middle · 共 2 级"。失败时显示"失败发生在第 N 级；目标没有被调用"。
- 宿主客户端 `exec({..., viaChain})` 透传；宿主接缝有一条 3 层链的端到端断言（`makeAdderFactory(200) → makeAdderFromFactory() → addToChain(5) = 205`，两级都必须是 `source_identity`）。

## 3. 验证

| 套件 | 之前 | 现在 | 新增内容 |
|---|---|---|---|
| `scripts/test_execution.py` | 55 | **59** | 3 层链成功（值证明最外层作用域：`outerFactory(4) → inner(3) = 7`）；每环 `source_identity`；`chain/ancestors/stage_report.stages/failed_stage` 形状；调用事件顺序 `[0,1,None]`；链中某环返回错函数 → `closure_identity_mismatch` 且 `failed_stage=0`、目标未被调用；同一链换 `pick` 后成功（证明拒绝是关于身份而非链不可跑）；非包含路径 → `via_chain_not_connected`；`--via-chain` 无 `--via` → `via_chain_without_via` |
| `scripts/test_host_adapter.py` | 10 | **11** | 宿主给出 3 层链，两级都核对 |
| `web/tests/app.behavior.test.mjs` | 29 | **30** | 页面逐级查出祖先并预填、POST 的 `via_chain` 由外到内、面板显示祖先链与每一阶段 |
| Rust 单测 | 66 | 66 | （`via_chain` 的请求形状由 CLI 级用例覆盖） |

门禁：`python3 scripts/verify.py --label w08-via-chain --out evidence/development/2026-09-12-w08-via-chain --keep-going`

- **22/22 检查 exit 0**；受控负对照 red；指纹配对一致 `7815f78d704c158a8ddf99dc90bc6c7ab823b5bb8f5526fd604c0fe055db58af`；`sources_changed_during_run: 0`。

## 4. 没有做的事（不得读成已实现）

- **CLI 不自动推断整条链**：调用者必须给出祖先；页面会逐级查（因为有 `/api/profile`），CLI 仍然要求显式 `--via-chain`——只是拒绝里会告诉你下一层是谁。
- 上限 8 是**策略**，不是测出来的最优值；没有做"链越长越省"的任何优化。
- 每环的实参必须由调用者给出：Atlas 不会从目标的参数反推外层参数（那是另一个问题，而且会发明输入）。
- 链的每一环仍是"函数返回值"这一条路径：如果一个闭包是通过**对象属性**逃逸的（`return { inc }`），仍然取不到——记录里如实报 `closure_not_returned`。
- 没有在真实大型项目上测过多层链（夹具是构造的例子）；多层闭包在真实代码里本就少见。

## 5. 复现

```bash
cargo build
python3 scripts/test_execution.py       # 59 tests
python3 scripts/test_host_adapter.py    # 11 tests
node web/tests/app.behavior.test.mjs    # 30 checks
python3 scripts/verify.py --label w08-via-chain \
  --out evidence/development/2026-09-12-w08-via-chain --keep-going
```
