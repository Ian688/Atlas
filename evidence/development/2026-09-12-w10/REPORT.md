# W10：宿主接缝与旧实现退役边界（首片）

窗口：2026-09-12/w10-host-seam。工作目录 `/Users/yinsijie/CodeRepo/Atlas`。

W10 从 `NOT_IMPLEMENTED` 推进到 `PARTIAL`：宿主接缝的**合同**作为数据发布，参考宿主客户端只拿 `{url, token}`，
"宿主不读 Atlas 存储"这条规则有可执行检查，宿主侧 E2E 覆盖取事实/选区/Intent/有界动作/受控调用。

**Modus 旧入口没有切换。** 理由是可验证性：Modus 检出目录不在本工作区，在这个仓库里既不能构建也不能测试宿主侧，
切换一个无法验证的入口等于把声明当成结果。切换的前置条件与回退步骤写在 `docs/HOST_API.md`。

## 一、交付

| 位置 | 内容 |
|---|---|
| `crates/atlas-app/src/server.rs` | `CONTRACT` 表与 `GET /api/contract`（`atlas.host-contract.v1`）；查询引用形式与 CLI 对齐；`/api/context` 同时接受查询参数与 JSON body |
| `adapters/modus/atlas_host_client.mjs`（新增） | 无依赖的参考宿主客户端，只接受 `{url, token}` |
| `scripts/test_host_adapter.py`（新增） | 7 个用例，含结构性检查；已加入 `verify.py` |
| `docs/HOST_API.md`（新增） | 合同、信任边界、必须原样呈现的东西、迁移与回退边界 |

## 二、"宿主不读存储"是可执行的，不是文档约定

存储布局（SQLite 文件、blob 目录、表结构、迁移）不是合同的一部分。宿主一旦读库，就把这些内部细节变成隐式接口，
之后任何迁移都会静默破坏宿主。检查：

| 检查 | 断言 |
|---|---|
| 适配器源码 | 不含 `rusqlite` / `sqlite` / `atlas.db` / `blobs/` / `node:fs` / `readFile` / `openSync` |
| 适配器构造 | 只接受 `{url, token}`，简历里没有 store 路径可传 |
| contract 响应 | 不出现 store 路径，也不出现 `atlas.db` |
| E2E 运行 | 适配器只拿到 URL 与令牌，其余一概不知道 |
| 令牌去向 | 拒绝非 `http:` 与非回环 host——本地会话令牌不该被送到别的机器 |

## 三、接口清单即数据

`GET /api/contract` 逐条发布接口名、方法、传输方式（`http` / `cli`）、用途、保证与限制，并带四条宿主规则
（不读存储；写操作都在 Atlas 内部；未解析/未知/截断必须原样呈现；候选/推导/观测三类证据必须能分辨）。
它与实现同源，所以不会与实现漂移；测试读回清单并断言适配器**只用清单里发布过、且传输方式一致**的接口——
适配器若长出一个合同没描述的调用，测试会失败。

顺带修掉两处 HTTP/CLI 不一致：`flow`/`source`/`reach`/`context` 现在和 CLI 一样接受符号 id、`path:name`
或裸函数名（只在当前分析内解析，解析不到即报错）；`POST /api/context` 同时接受查询参数与 JSON body，
并把"body 优先"写进合同，而不是留给实现顺序决定。

## 四、宿主 E2E 覆盖的东西

在一个真实服务进程上，适配器完成了：取合同 → report → nodes → flow（断言拿到的是 `Parameter(0)` 这个真实推导来源，
不是编造的常量）→ source → profile（`pure_callable`）→ 导出 context → 钉选区（版本 = 被服务的 analysis）→
登记 Intent（`exists: false`）→ 入队并执行有界动作（`observed: false`）→ 计划并执行一次受控调用
（返回 42，`trace.coverage = not_sampled`）→ 错误令牌返回 401 并抛错。

## 五、迁移与回退边界（未执行的部分）

`docs/HOST_API.md` 写明增量迁移的 6 步前置条件：宿主引入适配器并放在特性开关后 → 宿主侧 E2E → 宿主回归套件通过 →
**回退验证**（关掉开关回到旧路径，套件仍通过）→ 宿主侧加"不得读 Atlas 存储"的检查 → 才切换默认入口并记录旧入口退役日期。
**回退就是"停止调用适配器"**，因为适配器从不写宿主的数据，也不要求宿主迁移任何东西。

这些步骤里，只有"适配器存在且 E2E 在 Atlas 侧通过"在本工作区完成；其余需要宿主检出。

## 六、资格边界

- 旧 Modus 入口未切换，宿主侧 E2E 未运行（宿主检出不在本工作区）。
- 没有宿主内嵌的适配器包、服务发现、自动升级、远程或多租户认证、多版本并存协商。
- 合同是当前接口的**声明式快照**：没有 JSON Schema/OpenAPI，字段变化靠测试断言而不是类型校验。
- 适配器只覆盖 HTTP 面；`patch` 链只有 CLI 面，宿主若要用补丁链必须自己起子进程。
- 参考客户端是 Node ESM；别的语言的宿主需要自己按合同实现（合同是数据，这是可行的，但未被验证）。

## 七、验证

```
python3 scripts/verify.py --label w10-host-seam \
  --out evidence/development/2026-09-12-w10 --keep-going   退出码 0
  21/21 检查退出码 0（新增 host-adapter）
  negative-control 受控失败 ✓   fingerprint pairing: binary == source ✓
  status PASS · document_errors [] · sources_changed 0 · binary_stale false
```

| 命令 | 退出码 | 结果 |
|---|---|---|
| `cargo fmt --all --check` | 0 | — |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | 0 | — |
| `cargo test --workspace --locked` | 0 | 110 |
| `npm test --prefix workers/typescript` | 0 | 25 |
| `python3 scripts/test_host_adapter.py` | 0 | 7/7 |
| `python3 scripts/test_patch.py` | 0 | 16/16 |
| `python3 scripts/test_bridge.py` | 0 | 20/20 |
| `python3 scripts/test_execution.py` | 0 | 27/27 |
| `node web/tests/app.behavior.test.mjs` | 0 | 20 |
| `node web/tests/city3d.behavior.test.mjs` | 0 | 14 |

资格范围：只覆盖上列检查，不构成完整 AL/ET/GE/MT/HI/DV 或成熟 Atlas 验收。
