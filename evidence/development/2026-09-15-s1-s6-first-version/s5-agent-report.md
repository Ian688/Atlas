# S5：Agent 独立完成一次代码修改（金额边界修复）

日期：2026-09-15　任务对象：`/tmp/Atlas 首版 S5/shop`
工作原则：**发现、读关系/上下文、提 diff、触发验证、读结果全部走 Atlas 接口**；不读 Atlas 存储，不直接改检出目录，不调用 `patch/apply`。

---

## 0. 连接与接口清单

- 凭据：`evidence/development/2026-09-15-s1-s6-first-version/s5-credentials.json`
  `url=http://127.0.0.1:49687/`，`project=/tmp/Atlas 首版 S5/shop`（令牌不写入本报告）。
- 所有请求带 `Authorization: Bearer <token>` 与 `Host: 127.0.0.1:49687`。
- 接口清单取自 `GET /api/contract`（`schema=atlas.host-contract.v1`），**没有猜接口**。
  契约里与本次相关的"限制"原文：
  - `source`：单次上限 65536 字节；字节来自不可变快照，读取时校验哈希。
  - `search`：单页上限 500；子串匹配，不是正则。
  - `reach`：`预算内结果，不是执行顺序`。
  - `exec`：`Node 权限模型强制`；`超时上限 30s`；`页面不能放宽沙箱`。
  - `patch verify`(CLI)：`用户检出目录零改动`。
  - `patch/apply`：只在启动时 `--allow-writes` 指定的目录内写入，**未启用一律 403 `http_writes_disabled`**。
- 契约声明的测试命令（`verification.test_argv`）：`["node","--test"]`，`test_timeout_ms=120000`。**改不了，也没改。**

**基线分析 id（base）**：`ddff4b3cc3701cfd0b9f72a45ca95b16b44ecac6f3820f635456f784aafcd9d4`
快照 id `fa4f39d4eda6419892f3c1d1cb490cf40600f3cccd02af6b220f536ce6087f45`；`function_count=6`、`call_count=15`、`unresolved_call_count=9`。

## 1. 目标发现（走接口）

- `GET /api/search?q=charge&kind=function` → `total=1`
  → `charge`，`id=symbol:src/money.js:64:278`，`path=src/money.js`，`start=64`，`end=278`，`disposition=syntax_extracted`。
- `GET /api/node?entity=symbol:src/money.js:64:278` → 同一实体，确认引用可解析（没有 `entity_not_found` / `ambiguous_entity`）。

**实体引用（本报告全篇使用）**：`symbol:src/money.js:64:278`

## 2. 读源码 / 关系 / 上下文（走接口）

- `GET /api/source?entity=symbol:src/money.js:64:278` — 基线字节（`blob=4e34213d…`，`file_total_bytes=358`，`start_line=2`）：

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

- `GET /api/reach?direction=in` → 3 条入边（都是 `lexical_declaration_candidate`）：
  `src/order.js:checkout`（`symbol:src/order.js:38:189`）、
  `test/money.test.mjs` 两个匿名测试（`symbol:test/money.test.mjs:160:217`、`symbol:test/money.test.mjs:278:360`）。
  → 说明 `charge` 既被生产代码 `checkout` 调用，也被 `node --test` 覆盖。
- `GET /api/reach?direction=out` → `edges=[]`，未解析项 `Math.round`（`call:src/money.js:246:269`，`basis=dynamic_external_or_missing_binding`，`target=null`）。
- `POST /api/context {"entity":"symbol:src/money.js:64:278"}` → `atlas.selection-context.v1`，`evidence_kind=static_candidates`，
  `disclosure=local_only_until_explicitly_shared`，`selection_id=9ee8acf94dd769d41398ec847b4bad5bc2d4c60c19012d8ba2b5bccc4bdbe522`。
- `GET /api/flow?entity=...` → `status=complete_within_profile`，`profile=js-structured-control.v1`。
  关键静态事实：`rate` 的取值来自 `t:.../cond:2`，其 `origins` 含 `Derived(op15)`（`coupon.rate` 的属性读）与常量 `0`，
  `reasons=[property_value_unknown]`，`unknown=true`；`returns.reasons=[non_constant_operands]`，`unknown=true`。
  **这是静态推导，不是执行观测**：它说明 `rate` 没有常量上界，但静态上并未证明 `rate>1` 会发生。

## 3. 想拿执行观测，被拒绝（如实记录）

- `POST /api/exec {"symbol":"symbol:src/money.js:64:278","args":[100,{"rate":1.5}]}`
  → `verdict=refused`，`refusal.code=missing_requirements`，`detail=未授予：unknown_calls`，
  `missing_grants=["unknown_calls"]`，`isolation.started=false`（`refused_before_spawn`），`value=null`。
- `GET /api/profile?entity=...` → `classification=needs_entry_driver`，`required_grants=["unknown_calls"]`，
  `unknown_reasons=[getter_on_unknown_object_possible, unknown_callee_effects]`。
- 验证完成后又试 `POST /api/exec-compare {"entity":"symbol:src/money.js:64:278","args":[100,{"rate":1.5}],"proposal_id":"<提案 id>"}`
  → **两侧都是** `verdict=refused` / `missing_requirements` / `未授予：unknown_calls`
  （base `ddff4b3c…` 与 patched `60314f08…` 各拒绝一次）。这与契约"缺授权的函数两侧都会被具名拒绝"一致。

结论：**标量级的"修复前后各跑一次"在本次服务配置下拿不到**，授权只能由人在启动时给，我没有绕过。
因此"修复有效"的可观测证据来自验证作业真实执行的测试命令，而不是我的本地演算。

## 4. 提案（Intent，不写文件）

`POST /api/patch/propose` → `outcome=proposed`，`validation.ok=true`，`hunks=2`，
两个文件都是 `form=modify`：`src/money.js`(+3/-2)、`test/money.test.mjs`(+5/-0)。

**提案 id：`a41f014faaf6d1e26576f7093f665279b82a4abd0f15e930e015217903f2378f`**（一次成功，没有第二次提案）

summary：`把 charge 的折扣率夹到 0..1（rate>1 不再算出负数金额），并补一条 rate>1 / rate<0 的回归测试`

diff（逐字）：

```diff
--- a/src/money.js
+++ b/src/money.js
@@ -1,9 +1,10 @@
-// 金额计算：折扣券直接乘算，边界没有约束。
+// 金额计算：折扣率夹在 0..1 之后再乘算。
 export function charge(amount, coupon) {
   if (amount <= 0) {
     return 0;
   }
-  const rate = coupon && coupon.rate ? coupon.rate : 0;
+  const raw = coupon && coupon.rate ? coupon.rate : 0;
+  const rate = Math.min(1, Math.max(0, raw));
   const total = amount * (1 - rate);
   return Math.round(total * 100) / 100;
 }
--- a/test/money.test.mjs
+++ b/test/money.test.mjs
@@ -11,6 +11,11 @@
   assert.equal(charge(-5, null), 0);
 });
 
+test('charge clamps the coupon rate into 0..1', () => {
+  assert.equal(charge(100, { rate: 1.5 }), 0);
+  assert.equal(charge(100, { rate: -0.5 }), 100);
+});
+
 test('refundable covers the normal range', () => {
   assert.equal(refundable(500), true);
   assert.equal(refundable(2000), false);
```

修法说明：把 `coupon.rate` 先读进 `raw`，再用 `Math.min(1, Math.max(0, raw))` 夹到 `0..1`，之后才参与 `amount * (1 - rate)`。
`rate=1.5` → 夹成 1 → 总金额 0（不再是 −50）；`rate=-0.5` → 夹成 0 → 原价的 100；`rate=0.2` 与 `amount<=0` 两条路径的代码一字未动。

字节与行号核对：为了让 diff 精确匹配固定快照，我**读过**样本文件核对字节（money.js 358B / money.test.mjs 499B，UTF-8、LF 结尾），
并在 `/tmp` 的一次性副本上用 `diff -u` 生成 diff、用 `git apply -p1` 做过一次演练；
这只用于对齐字节，**没有改动项目目录**，也不当作验证证据（验证证据见下节，全部由 Atlas 产出）。

## 5. 验证（走接口）

- `POST /api/patch/verify {"id":"a41f014f…"} ` → `outcome=queued`
  **作业 id**：`cd2a6a21e9b55629174676b909d09e0a75444d1f4e85f2c326f58e19552d7cfd`，`kind=patch_verify`，
  `options` 回显 `test_argv=["node","--test"]`、`test_timeout_ms=120000`、`worker=…/typescript/worker.mjs`。
- 轮询 `GET /api/patch/verify?id=a41f014f…` → **终态 `state=completed`**，`attempt=1`，`terminal_reason=null`，
  `analysis_id=60314f08f4e683f399f531467bc6a6a3f1e8805fa6b82a0bb467760e1de0b183`。
- `GET /api/patch?id=a41f014f…` → 提案 `state=verified`，`verification.isolation.user_checkout_touched=false`，
  `method=从不可变快照的内容寻址 blob 物化到 0700 临时目录，补丁只写在这个副本里`。

### 5.1 测试：真的跑了

`verification.test`：`ran=true`、`observed=true`、`passed=true`、`exit_code=0`、`duration_ms=292`、`argv=["node","--test"]`

```
✔ charge applies the coupon (1.038405ms)
✔ charge returns zero for zero or negative amounts (0.152909ms)
✔ charge clamps the coupon rate into 0..1 (0.14594ms)
✔ refundable covers the normal range (0.153891ms)
ℹ tests 4
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 153.409893
```

`stderr=""`。**4/4 通过、退出码 0**：原有的 `charge(100,{rate:0.2})===80`、`charge(0,null)===0`、`charge(-5,null)===0` 全部保持，
新增的 `rate>1` / `rate<0` 回归测试也通过（这条在旧字节下必然失败，是"边界已修"的执行观测支撑，而不只是"老测试仍绿"）。

### 5.2 图差异（Static）

`verification.graph_diff`（`atlas.graph-diff.v1`），`patched_analysis_id=60314f08…`，`patched_snapshot_id=c9b62abc…`：

- counts：`functions 6→7`、`calls 15→22`、`unresolved_calls 9→14`、`files 4→4`。
- nodes.changed（4）：`charge` 的 id 由 `symbol:src/money.js:64:278` 变为 **`symbol:src/money.js:58:317`**（字节区间变了，所以 id 变了）；
  `refundable` `280:357 → 319:396`；`src/money.js` 358→397 字节；`test/money.test.mjs` 499→657 字节。
- nodes.added（2）：`symbol:test/money.test.mjs:412:518`、`symbol:test/money.test.mjs:565:654`（新增/位移的测试回调）。
- nodes.removed（1）：`symbol:test/money.test.mjs:407:496`（被插入内容推走的旧 id）。
- edges.added（5）：`Math.max`/`Math.min` 两个 `call_candidate`（target `<unresolved>`，即新增的两处外部调用），
  以及 `charge@src/order.js`、`charge@test/…`、`refundable@test/…` 重新指向新的符号 id。
- edges.removed（3）：旧 id 上的同三条 `charge`/`refundable` 边。
- 图差异自带说明：节点按 `path+name` 重新配对；**按 id 比较会把一次编辑读成"删除+新增"，id 仍原样给出**——所以上面的 added/removed 不是"函数被删了"。

## 6. 三类证据分开摆放（不互相冒充）

| 类别 | 内容 | 出处 |
|---|---|---|
| Intent | diff + `validation.ok=true`、`hunks=2` | `PATCH /api/patch/propose` → 提案 `a41f014f…` |
| Static | 基线 flow（`rate` 无常量上界、`property_value_unknown`）+ 图差异 | 分析 `ddff4b3c…` 的 `/api/flow`；`verification.graph_diff`（分析 `60314f08…`） |
| Observed | `node --test`：`ran=true`、`exit_code=0`、pass 4 / fail 0 | `verification.test`（作业 `cd2a6a21…`） |

被拒绝的事也原样留着：`/api/exec` 与 `/api/exec-compare` 均以 `missing_requirements`（缺 `unknown_calls`）被拒绝，没有把它读成"通过"。

## 7. 没有做的事

- **没有调用 `/api/patch/apply`**，也没有调用 `/api/patch/revert`：是否应用由人决定。提案目前 `state=verified`，检出目录零改动（服务端也报 `user_checkout_touched=false`）。
- 若要应用，需要请求逐字回显契约 `writes.root`：`/private/tmp/Atlas 首版 S5/shop`。
- 没有绕过 Atlas 直接改样本文件；没有读 Atlas 的存储文件；没有放宽沙箱。

## 8. 结论

`charge` 的折扣率已在**隔离副本**里被夹到 `0..1`，`rate>1` 不再产生负数金额；三条正常情况行为不变；
项目自带的 `node --test`（外加一条新增的边界回归测试）在该隔离副本里 **4/4 通过、退出码 0**。
这份结论只覆盖"已验证的提案"，**尚未落到用户的检出目录**。

## 9. 引用的 id 一览

- base analysis：`ddff4b3cc3701cfd0b9f72a45ca95b16b44ecac6f3820f635456f784aafcd9d4`
- patched analysis：`60314f08f4e683f399f531467bc6a6a3f1e8805fa6b82a0bb467760e1de0b183`
- 提案：`a41f014faaf6d1e26576f7093f665279b82a4abd0f15e930e015217903f2378f`
- 验证作业：`cd2a6a21e9b55629174676b909d09e0a75444d1f4e85f2c326f58e19552d7cfd`
- 目标实体（基线）：`symbol:src/money.js:64:278`　→　（补丁后）`symbol:src/money.js:58:317`
- selection：`9ee8acf94dd769d41398ec847b4bad5bc2d4c60c19012d8ba2b5bccc4bdbe522`
