# S5 Agent 报告（final）—— 修复 `charge` 的折扣率边界

> 全部发现 / 上下文 / 提案 / 验证均通过 Atlas HTTP 接口完成（`Authorization: Bearer <token>`，`Host: 127.0.0.1:36168`）。
> 未调用 `/api/patch/apply`；用户检出目录零改动（见 §6 校验）。

- 服务 URL：`http://127.0.0.1:36168/`
- 样本项目：`/tmp/Atlas 首版 S5-final/shop`
- **基分析 id（base analysis）**：`ddff4b3cc3701cfd0b9f72a45ca95b16b44ecac6f3820f635456f784aafcd9d4`
- 引擎：`foundation-flow-0.2.2`；契约 `atlas.host-contract.v1`

---

## 1. 目标函数与实体引用

| 项 | 值 |
|---|---|
| 目标函数 | `charge(amount, coupon)` |
| 文件 | `src/money.js`（第 2 行起） |
| **实体引用** | `symbol:src/money.js:64:278`（analysis 内符号 id；`64:278` 是快照内的字节区间） |
| 找到方式 | `GET /api/search?q=charge&kind=function` → `total:1`，唯一命中 |

`GET /api/node?entity=symbol:src/money.js:64:278` 回显：
`{"disposition":"syntax_extracted","id":"symbol:src/money.js:64:278","kind":"function","name":"charge","path":"src/money.js","parent":"file:src/money.js","start":64,"end":278}`

`GET /api/source?entity=symbol:src/money.js:64:278`（`blob=4e34213d26dc609ab18c9ffd4bc749a8ec5f9b21db85bff60d6e1e06ab5c8488`，`file_total_bytes=358`）：

```js
export function charge(amount, coupon) {
  if (amount <= 0) {
    return 0;
  }
  const rate = coupon && coupon.rate ? coupon.rate : 0;
  const total = amount * (1 - rate);
  return Math.round(total * 100) / 100;
}
```

### 调用关系（Static，候选不是运行路径）

- `direction=out`：`edges:[]`（**0 条出边**，root 是 charge 自身）。`unresolved` 1 条：`call:src/money.js:246:269` `Math.round`，`basis: dynamic_external_or_missing_binding`，`target: null`。
- `direction=in`：`edges` **4 条**（边的条数，不是调用者个数），涉及 3 个不同 `source` 符号：
  1. `call:src/order.js:167:186` ← `symbol:src/order.js:38:189` (`checkout`)
  2. `call:test/money.test.mjs:183:209` ← `symbol:test/money.test.mjs:160:217`
  3. `call:test/money.test.mjs:301:316` ← `symbol:test/money.test.mjs:278:360`
  4. `call:test/money.test.mjs:337:353` ← `symbol:test/money.test.mjs:278:360`
  `basis` 均为 `lexical_declaration_candidate`；`truncated:false`；`unresolved:[]`。

### profile（可否运行）

`GET /api/profile?entity=symbol:src/money.js:64:278`：`classification: "needs_entry_driver"`，`runnable: true`，`required_grants: ["unknown_calls"]`，`unknown_reasons: ["getter_on_unknown_object_possible","unknown_callee_effects"]`。

`GET /api/flow?...` 同源：`status: complete_within_profile`，`coverage: {cfg_blocks:13, reachable_blocks:10, transfers:52, unknown_op_transfers:0}`。

---

## 2. 提交的提案（Intent，未写文件）

为了让"修复"和"回归测试"都能被独立复核，我提交了 **3 份**提案，全部 `state: verified`。

### 提案 A（修复本体）—— `eb896175b8af84e761ebfc614dcd803f05a95e17a79382fb73a4a06ab8627847`

entity：`symbol:src/money.js:64:278`；`validation.ok:true`，`patched_paths:["src/money.js"]`，`hunks:1`，`added_lines:3 / removed_lines:2`，`patched_digest:3ad706054be014cd40014d5c4ba020b5d80da6e49b8c22e9e57eae6e6e2f834c`。

```diff
--- a/src/money.js
+++ b/src/money.js
@@ -3,8 +3,9 @@
   if (amount <= 0) {
     return 0;
   }
-  const rate = coupon && coupon.rate ? coupon.rate : 0;
-  const total = amount * (1 - rate);
+  const raw = coupon && coupon.rate ? coupon.rate : 0;
+  const rate = Math.min(1, Math.max(0, raw));
+  const total = amount * (1 - rate);
   return Math.round(total * 100) / 100;
 }
 
```

### 提案 B（回归测试）—— `24ad22873a65306846fc84127a3f4a0e7579c555498f18a5658685373dda80c8`

entity：`file:test/money.test.mjs`；`validation.ok:true`，`patched_paths:["test/money.test.mjs"]`，`hunks:1`，`added_lines:7 / removed_lines:0`，`patched_digest:fb77e93ac2f561c5e321846563a3a17b89aa3cb7f107a311046c9c1c9cb0e69e`。

```diff
--- a/test/money.test.mjs
+++ b/test/money.test.mjs
@@ -14,3 +14,10 @@
 test('refundable covers the normal range', () => {
   assert.equal(refundable(500), true);
   assert.equal(refundable(2000), false);
 });
+
+test('charge clamps the coupon rate into 0..1', () => {
+  assert.equal(charge(100, { rate: 1.5 }), 0);
+  assert.equal(charge(100, { rate: -0.5 }), 100);
+  assert.equal(charge(100, { rate: 1 }), 0);
+  assert.equal(charge(100, { rate: 0 }), 100);
+});
```

### 提案 C（修复 + 回归测试，同一份 diff）—— `3a165427ae04724c7e24708350948eda11ae8fd485aa8686680fd7a2f7720d36`

entity：`symbol:src/money.js:64:278`；`validation.ok:true`，`patched_paths:["src/money.js","test/money.test.mjs"]`，`hunks:2`，两个文件分别 3+/2- 与 7+/0-，`patched_digest` 与 A、B 逐文件一致。

> **为什么要 C**：每次 `patch/verify` 只把**一份**提案应用到基线快照上。A 单独验证只能证明"正常情况仍通过"（新增测试不在副本里），B 单独验证恰恰会被判失败（修复不在副本里）。所以"修复让边界测试转绿"这件事必须由 C 来观测，C 的 `patched_analysis_id=43f4245dd4ef393317dc8a0249190e27f8e1a40b58fe6e72698a75174e3ea897` 才是修复+测试的联合证据。
>
> **建议由人应用的也是 C**（或 A、B 都应用）。

---

## 3. 验证结果（Observed：`node --test`）

测试命令由服务启动时声明，我无法更改，契约与每次作业的 `options` 均为 `test_argv: ["node","--test"]`、`test_timeout_ms: 120000`。

| 提案 | 验证作业 id | 隔离分析 id（patched_analysis_id） | `test.ran` | `exit_code` | `passed` | 计数 |
|---|---|---|---|---|---|---|
| A 修复本体 `eb896175…` | `748e95199fefd8a8e2d26305f4a1d100c83259a9ee918861a45d896288eddf9a` | `1ed120a130bae918fd3f4305cd5966d1e3108f62f7e8dd6143d1f2ffb2345c53` | true | **0** | true | tests 3 / pass 3 / fail 0 |
| B 回归测试 `24ad2287…` | `9c62d88e9426af39bb57e4c02b6aae37c7ccb1c47f2006fe3e1c574d928181f9` | `1fdfee5c63fa89e37ecbffe2443783a29eaf000349364cf3ed08d698805497fa` | true | **1** | **false** | tests 4 / pass 3 / **fail 1** |
| C 修复+测试 `3a165427…` | `698260ca34d6674f7d612eadc56e9202ac4528beffb606514bbf1c6e78c32547` | `43f4245dd4ef393317dc8a0249190e27f8e1a40b58fe6e72698a75174e3ea897` | true | **0** | true | tests 4 / pass 4 / fail 0 |

三份提案的 `state` 最终均为 `verified`（`GET /api/patch?id=…`），`terminal_reason` 为 null。

### 3.1 提案 B：边界测试在未修复时确实红（证明 bug 与测试有效）

`exit_code:1`，stdout 摘录：

```
✔ charge applies the coupon
✔ charge returns zero for zero or negative amounts
✔ refundable covers the normal range
✖ charge clamps the coupon rate into 0..1
ℹ tests 4  ℹ pass 3  ℹ fail 1
...
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
-50 !== 0
    at .../test/money.test.mjs:20:10
{ actual: -50, expected: 0, operator: 'strictEqual' }
```

`-50 !== 0` 就是任务里说的 `charge(100,{rate:1.5}) === -50`，**执行观测**到了原缺陷。

### 3.2 提案 C：修复后边界测试转绿

`exit_code:0`，stdout 全文（`duration_ms: 302`，服务端 `test.duration_ms: 302`，内部 `duration_ms 151.227458`）：

```
✔ charge applies the coupon (1.068077ms)
✔ charge returns zero for zero or negative amounts (0.162908ms)
✔ refundable covers the normal range (0.151283ms)
✔ charge clamps the coupon rate into 0..1 (0.162924ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 151.227458
```

- 正常情况未变：`charge applies the coupon` 与 `charge returns zero for zero or negative amounts`（即 `charge(100,{rate:0.2})===80`、`charge(0,null)===0`、`charge(-5,null)===0`）依旧 ✔。
- 边界情况新增覆盖 ✔（`rate 1.5 / -0.5 / 1 / 0` 四例）。
- `stderr` 空，`ran:true`，`observed:true`。**真跑了，退出码 0，通过。**

### 3.3 图差异要点（Static，取自 `verification.graph_diff`）

提案 C（`atlas.graph-diff.v1`，`base_analysis_id` = 基分析）：

- `counts`：`calls` 15→26，`functions` 6→7，`files` 4→4，`unresolved_calls` 9→16。
- `edges.added`（**5 条边**）：`Math.max`（unresolved）、`Math.min`（unresolved）、`charge|src/order.js→symbol:src/money.js:64:323`、`charge|test/money.test.mjs→symbol:src/money.js:64:323`、`refundable|test/money.test.mjs→symbol:src/money.js:325:402`。
- `edges.removed`（**3 条边**）：三条指向旧 id `symbol:src/money.js:64:278` / `symbol:src/money.js:280:357` 的 `call_candidate`。
- `nodes.added`（1 个）：`symbol:test/money.test.mjs:548:746`（`<anonymous@548>`，新测试体）。
- `nodes.changed`（4 个，按 path+name 重配对）：`file:src/money.js` 字节 358→403；`file:test/money.test.mjs` 499→749；`charge` id `symbol:src/money.js:64:278`→`symbol:src/money.js:64:323`；`refundable` id `symbol:src/money.js:280:357`→`symbol:src/money.js:325:402`。
- `truncated:false`；新增的 `Math.min`/`Math.max` 两条 unresolved 边与补丁里的夹取调用一致。

> 图差异里的 `edges.added/removed` 是**边**的条数（5 与 3）；`nodes.added/changed` 是**节点**数（1 与 4）。两者不要混算。

---

## 4. 引用的 analysis id

| 用途 | analysis id |
|---|---|
| 基分析（发现/上下文/提案/exec 均在此） | `ddff4b3cc3701cfd0b9f72a45ca95b16b44ecac6f3820f635456f784aafcd9d4` |
| 提案 A 隔离验证派生分析 | `1ed120a130bae918fd3f4305cd5966d1e3108f62f7e8dd6143d1f2ffb2345c53` |
| 提案 B 隔离验证派生分析 | `1fdfee5c63fa89e37ecbffe2443783a29eaf000349364cf3ed08d698805497fa` |
| 提案 C 隔离验证派生分析（修复+测试） | `43f4245dd4ef393317dc8a0249190e27f8e1a40b58fe6e72698a75174e3ea897` |

---

## 5. 被拒绝 / 做不到的步骤（具名原因，原样）

1. **`POST /api/exec` 被拒（未自行兜底）**。对 `symbol:src/money.js:64:278` 传 `args:[100,{"rate":1.5}]`：
   `verdict: "refused"`，`isolation.reason: "refused_before_spawn"`（没有进程被启动），
   `refusal: {"code":"missing_requirements","detail":"未授予：unknown_calls","evidence":"execution_profile.required_grants / required_context","missing_context":[],"missing_grants":["unknown_calls"]}`。
   即 `charge` 的 profile 是 `needs_entry_driver`、`required_grants:["unknown_calls"]`，而 HTTP exec 的 `grants.unknown_calls=false`；页面/Agent 不能放宽沙箱。**这条路径我没拿到单函数执行观测，未把拒绝当通过。** 边界行为改由 `node --test` 的隔离运行观测（§3.1/§3.2），证据同样真实且带退出码。

2. **补丁派生分析无法用读接口按 id 取源码**。`GET /api/source?entity=symbol:src/money.js:64:323&analysis=43f4245d…` 返回 `{"detail":"entity_not_found","error":"entity_not_found"}`；`GET /api/report?analysis=43f4245d…` 无视该参数、仍回基分析 `ddff4b3c…`（其 `snapshot_id=fa4f39d4…`，`function_count:6` 也是基线值）。因此补丁后的源码正文我**没有**从接口读到，只有图差异与测试输出。这是接口限制，不是我把失败说成通过。

3. **未采用 `/api/patch/apply`**（按任务要求，是否应用由人决定）。

---

## 6. 用户检出目录零改动（校验）

`verification.isolation.method`：*"从不可变快照的内容寻址 blob 物化到 0700 临时目录，补丁只写在这个副本里"*，`isolation.user_checkout_touched: false`。

复核 `checksum`（工具外直接读文件核对字节，非"完成任务"手段）：

- `src/money.js`：358 字节，`md5 = f11d03f2a1fcd64b9405e24f0f6e6fc2`（= 补丁前基线；与基分析 `file_total_bytes=358` 一致）
- `test/money.test.mjs`：499 字节，`md5 = 4e0d380505ed5e87db369eee2123b2f7`（= 补丁前基线）

两份文件在本次会话结束时仍是原始字节，未被 Atlas 或我写入。

---

## 7. 结论

- 缺陷：`const rate = coupon && coupon.rate ? coupon.rate : 0;` 未约束取值范围，`rate>1` 得到负金额（观测到 `-50`）。
- 修复：加一行 `const rate = Math.min(1, Math.max(0, raw));` 夹取到 `0..1`；`amount<=0` 的早返、`rate` 缺省为 `0` 的语义均保留。
- 证据链：Intent（提案 C 的 diff）→ Static（`graph_diff`：5 边增 / 3 边减 / 1 节点增 / 4 节点改，新增 `Math.min`/`Math.max` 未解析边）→ Observed（`node --test`，`ran:true`、`exit_code:0`、4/4 通过；对照组 B `exit_code:1`、`fail 1`、`-50 !== 0`）。
- 待人来决定：是否 `POST /api/patch/apply {"id":"3a165427…","confirm_path":"/private/tmp/Atlas 首版 S5-final/shop"}`（本文档未执行）。
