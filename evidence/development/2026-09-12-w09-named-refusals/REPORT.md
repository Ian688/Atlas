# W09：拒绝必须具名（错误映射层）

窗口：`2026-09-12/w09-named-refusals`
结论：**DELIVERED**。修的是上一轮验证时抓到的既有缺陷。

## 1. 问题

`GET /api/node` 未命中时返回的是一句通用错误：`{"error":"invalid_or_unavailable_query"}`。
原因不在解析器——`resolve_entity` 一直返回**带具名前缀**的原因（`entity_not_found:<引用>`、`ambiguous_entity:<引用>:<个数>`）——
而是 HTTP 层在 `Ok(Err(_))` 分支把整串丢掉了，只留一个通用码。

后果不只是难看：**"这个实体不在这份分析里"和"你的查询本身有问题"是两种不同答案**，
调用者分不清就会去重试错的那个。而且 `reach` / `source` / `flow` / `profile` / `context` 共用同一条分支，
所以这是**全站查询端点**的缺陷，不是新接口的。

## 2. 改动

`crates/atlas-app/src/server.rs` 的 `Ok(Err(error))` 分支：从 `Error::Invalid(text)` 取出原因，
按第一个 `:` 之前的具名码作为 `error`，完整原因放进 `detail`，HTTP 仍是 400。

## 3. 验证

真实服务（rxjs 分析）：

| 请求 | 结果 |
|---|---|
| `entity=symbol:no/such.js:1:2` | `400 {"error":"entity_not_found","detail":"…"}` |
| `entity=完全不存在的东西` | `400 {"error":"entity_not_found","detail":"entity_not_found:完全不存在的东西"}` |
| `entity=dist/cjs/internal/util/isFunction.js:isFunction` | `200`，返回该节点 |

用例：`scripts/test_integration.py` 新增两条断言（未命中必须 `error == "entity_not_found"` 且状态 400；
`api/node?entity=file:src/math.js` 必须返回该节点）→ **18 tests OK**。

门禁：**25/25 检查 exit 0**，受控负对照 red（exit 1），
指纹配对一致 `2f920f7142acaaab53dd7ac8e918c46587ff6d78353def07d5ee54e27821b5bc`，`sources_changed_during_run: 0`。

## 4. 只验证了一半的地方（不夸大）

`ambiguous_entity` 这条分支**存在但本轮没有被触发**：我试的两个候选（`pipe`、`empty`）都落到 `entity_not_found`。
所以"歧义会具名"目前是**读代码得出的结论，不是测出来的**。需要构造一个真实歧义样本（同一文件引用匹配多个文件、
或同名符号多处出现）才能把它变成证据。

## 5. 没有做的事

块 × 绑定状态矩阵仍未进函数工作台主视图；「167 处未知区域」仍是数字；`atlas node` CLI 仍未加。
