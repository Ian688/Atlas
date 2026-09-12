# W08 补片：外部读分三类 —— 导入、运行时全局、真正的自由标识符

窗口：2026-09-12/w08-imports。工作目录 `/Users/yinsijie/CodeRepo/Atlas`。

上一片的上下文模型把"参数之外的东西"分成"可声明的输入"和"必须承认的未知"，但漏掉了一个更基本的问题：
**什么才算外部**。实测暴露出两个方向相反的错误。

## 一、两个真实错误

**错误一：导入被当成全局。** `import fs from 'node:fs'` 之后在函数里读 `fs`，engine 记 `ReadExternal(fs)` →
`may_access_global = true`。于是 `writeIt` 的画像显示"读取全局状态"，而 `fs` 其实就在被复制的模块里。

**错误二（后果更糟）：内建被要求声明。** `divide` 里 `throw new Error(...)` 让画像列出 `required_globals: ["Error"]`。
调用者（包括我自己的测试助手）照着声明 `--global Error=null` —— 那不是"提供"一个 Error 构造器，而是**拿掉**一个：

```
expected 'Error'  actual 'TypeError'      ← 运行因为与被测函数无关的原因失败了
```

这条是测试暴露的，不是推断的：自动按画像声明上下文的测试助手把 `Error` 声明成 `null`，抛出的异常立刻变成了 TypeError。

## 二、三分法

| 类别 | 例子 | 调用者要做什么 |
|---|---|---|
| **运行时 import** | `import fs from 'node:fs'`、`import { helper } from './helper.js'` | 什么都不用做：模块整体被复制，导入时它就在 |
| **运行时内建 / 宿主全局** | `Error`、`Math`、`JSON`、`console`、`process`、`setTimeout`… | 什么都不用做：运行时提供。**声明它反而会覆盖真值** |
| **真正的自由标识符** | `CONFIG`（模块里没有声明、也没导入） | 必须声明，拒绝里**具名**：`global:CONFIG` |

实现：
- worker 在 `FlowFunction.imports` 里列出运行时可导入名（`import type` 排除——它被擦除，列出它会把一个未定义读当成模块提供的状态）；producer 提升为 `worker/0.2.1`。
- engine 的 `OpKind::ReadExternal(name)` 只在该名字**不在** imports 里时置 `may_access_global`。
- 画像的外部名来自三处并集后**减去** imports 与 `RUNTIME_GLOBALS`：`read_external` op（`detail` 就是名字，覆盖那些没进值来源的读）、`External(name)` 来源（覆盖进了摘要的读）。
- engine 的"未建模"哨兵从 `External("unmodeled")` 改成 `External("<unmodeled>")`：尖括号不可能出现在 JS 标识符里，所以它永远不会和一个真名字冲突（之前一个叫 `unmodeled` 的模块绑定会被误当成哨兵）。

实测（真实 CLI）：

```
writeIt       reads_global False   globals []
callHelper    reads_global False   globals []
readConfig    reads_global True    ctx ['globals']  globals ['CONFIG']
divide        globals []           （Error 是内建，不再被要求声明；抛出的仍是真 Error）
```

## 三、版本对齐只用一个常量

`imports` 缺席的旧 worker 无法表达"这是导入还是全局"，它的输出会被**读成相反的结论**。因此：

- `atlas_contract::WORKER_PRODUCER`（`typescript/5.9.3;worker/0.2.1`）是引擎接受的唯一 producer；
  不匹配时报 `worker_producer_not_supported:got=…:expected=…`（原来是 `language_contract_mismatch`，不具名）。
- `ENGINE_VERSION` → `foundation-flow-0.2.2`，`ALGORITHM_VERSION` → `0.2.2`：版本包变化会让增量缓存按设计失效。
- `FLOW_SCHEMA` 仍是 `atlas.flow-ir.v1`：新增字段带 `serde(default)`，**形状**兼容；变的是**语义**，语义由 producer 声明。

## 四、资格边界

- **动态 import / require 的局部绑定仍无法解析**：`const { execSync } = await import('node:child_process')` 里的
  `execSync` 在已发布事实里仍是一个未解析名（函数内解构声明属声明 profile 外），所以这类函数仍被保守处理。
- `RUNTIME_GLOBALS` 是一份**手写清单**，不是从运行时枚举出来的。清单之外的内建（新标准新增的，或宿主特有的）会被当成需要声明的真全局；方向是保守的（要求声明），但会造成不便。
- 版本提升使既有 store 的增量缓存失效（按设计），旧分析本身仍可查询（不可变）。

## 五、验证

```
python3 scripts/verify.py --label w08-imports \
  --out evidence/development/2026-09-12-w08-imports --keep-going   退出码 0
  21/21 检查退出码 0
  negative-control 受控失败 ✓   fingerprint pairing: binary == source ✓
  status PASS · document_errors [] · sources_changed 0 · binary_stale false
```

| 命令 | 退出码 | 结果 |
|---|---|---|
| `cargo test --workspace --locked` | 0 | 112 → 113 |
| `npm test --prefix workers/typescript` | 0 | 25 → 26 |
| `python3 scripts/test_execution.py` | 0 | 37 → 39 |
| 其余 18 项 | 0 | 见 verification.json |
