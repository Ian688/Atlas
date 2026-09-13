# W09：未知归零之后的质量核查（并纠正我上一轮的错误陈述）

窗口：`2026-09-12/w09-quality-check`
结论：**DELIVERED**。这一轮没有改代码，做的是**核对自己上一轮的断言**——并抓到一条夸大。

## 1. 方法

手上正好有两个用同一份 rxjs 检出（`local-state/bench/rxjs`）索引出来的 store：

- `/tmp/atlas-rest-store`：第 6 轮（rest/解构已支持，`for...of` 仍是语句级未知），未知区域 79；
- `/tmp/atlas-final-store`：第 7 轮（`for...of` 已建模），未知区域 0。

挑出**同一份源码里同一个函数**做前后对照：`src/internal/observable/innerFrom.ts:3868:4058`
（`fromIterable` 里那个箭头函数 `(subscriber) => { for (const value of iterable) {...} }`）。

## 2. 实测差异

| | 改前 | 改后 |
|---|---|---|
| CFG 块 | 3 | **9** |
| 返回值 | 无结论（`unknown: true`） | **`['undefined']`，`unknown: false`** |
| 未知理由 | `unknown_callee_effects`、`unmodeled_construct:for_in_of_iteration` | `unknown_callee_effects`、`unmodeled_construct:for_in_of_element_unknown`、**`capture_or_untracked_binding_read`** |
| **该函数发出的调用点** | **2**（`subscriber.next`、`subscriber.complete`） | **2**（完全相同） |

逐条判定（对着源码看，不是看数字）：
- 返回值 `undefined` 且不含未知：源码里只有裸 `return;`，**正确**，且比"无结论"精确；
- `unknown_callee_effects`：`subscriber.next/complete` 是**参数上的属性调用**，目标不可解析——**正确**；
- `unmodeled_construct:for_in_of_element_unknown`：循环元素值未知——**正确且具名**；
- 新增的 `capture_or_untracked_binding_read`：`iterable` 是**捕获**，读捕获本来就意味着"值不可知"。
  它不是新缺陷，而是**以前被语句级未知掩盖的真相**——现在才被说出来。

## 3. 纠正：我上一轮的陈述是夸大的

第 7 轮的提交信息与报告里我写了"**循环头与循环体里的调用全部消失**，下游每条事实都看不见它们"。
**这个说法是错的。** 实测：改前改后该函数的调用点**都是 2 个，完全相同**。

调用点是**解析阶段**抽取的（`parse.mjs` 的 records），与 flow lowering 无关；
语句级未知影响的是 **flow 层**（CFG、值、effects），不是调用图的抽取。

正确的说法应该是：
> `for...of` 之前是一个语句级未知，**循环内部没有任何 flow 事实**（3 个块、返回值无结论、effects 不可分析）；
> 调用点本身由解析阶段抽取，一直存在。

**改进是真的，理由是我说错了。** 我不改写历史提交，而是把它记在这里和 `progress.json` 里——
一个只留正确陈述、把夸大悄悄删掉的记录，比没有记录更糟。

## 4. 这轮核查还确认了什么

- 未知区域从 79 归零是**真的**（两个 store 的 coverage 直接对比）；
- 归零确实带来了**更精确的 flow**（块数 3→9、返回值从无结论到确定），不只是"换个理由"；
- 但**归零不等于解析正确**：本函数的两条调用边在两个版本里**目标都未解析**——
  这符合预期（参数上的属性调用），可它也说明"调用点存在"与"调用被解析"是两件事，
  我此前把二者混在一起说过。

## 5. 验证与残余

- 本轮无代码改动（除记录），故门禁沿用上一轮 `w09-forin-r3` 的 25/25 PASS 证据；
- **未做的核查**：只核对了 1 个函数。79 处归零涉及的全部函数没有逐个核对；
  "调用点存在但目标未解析"的比例在改前改后是否变化，也没有统计。
