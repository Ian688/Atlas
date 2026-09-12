# W09/W06 补片：HTTP 上的身份是会话，不是声明

窗口：2026-09-12/w09-session-identity。工作目录 `/Users/yinsijie/CodeRepo/Atlas`。

工作单要求"服务端验证权限与版本；不能信任前端声明"。之前 `/api/agent/request` 直接采信请求体里的 `owner`，
注解与提案的作者也由调用者自报——一个页面可以用别人的名义写行，`owner` 这一列因此没有意义。

## 一、改了什么

| 面 | 之前 | 现在 |
|---|---|---|
| `/api/agent/request` | 请求体 `owner` 决定作业身份 | `owner` **不在请求类型里**；服务端按会话写入 `session-<token前12位>` |
| `/api/annotation` | 请求体 `proposed_by` 决定作者 | 字段移除；作者 = 会话 |
| `/api/patch/propose` | 请求体 `proposed_by` 决定作者 | 字段移除；作者 = 会话 |
| CLI | `--owner` / `--proposed-by` / `--by` | 不变：本机操作者声明自己是谁 |

服务端能验证的唯一身份是"持有会话令牌"，所以这就是写进记录的身份。这不是"忽略未知字段"的约定：
字段**不在请求类型里**，因此没有可绕过的解析路径（与 `analysis_id` 同样的处理方式）。

CLI 的显式声明保留，因为它服务的是另一个信任模型：本机操作者在自己的仓库上操作。把两者混为一谈，
要么让本机 CLI 变得没法用，要么假装 HTTP 已经认证——两种都不诚实。

## 二、实测

```
POST /api/agent/request {"owner":"somebody-else","request_key":"impersonate",...}
  → request.owner = "session-603974a1-832"      （不是 somebody-else）
POST ... {"owner":"another-name"}（同一会话）
  → request.owner 相同                          （一个会话就是一个 owner）
POST /api/annotation {"proposed_by":"a-person",...}
  → annotation.proposed_by = "session-603974a1-832"
POST /api/patch/propose {"proposed_by":"a-person",...}
  → proposal.proposed_by = "session-603974a1-832"
```

## 三、顺带修正的宿主客户端

`adapters/modus/atlas_host_client.mjs` 的 `annotate()` / `proposePatch()` 不再发送 `proposed_by`，
并在注释里写明：作者是服务端按会话记录的，宿主若需要自己的名字出现在记录里，应当走 CLI。
`scripts/test_host_adapter.py` 的断言也从"作者是 host"改为"作者是会话"——原来的断言本身就是在验证一个不该成立的行为。

Web 页面同样不再发送 `proposed_by`；行为测试显式断言请求体里没有该字段。

## 四、资格边界

- **CLI 的 owner 仍未认证**：它是操作者声明。本机信任模型下这是可接受的，但远程/多租户场景需要真正的认证与授权，未实现。
- 会话身份是稳定字符串（token 前 12 位），不是可审计的用户账户；没有账户、角色、配额或吊销。
- 因此 W06 blocker 的措辞改为："CLI owner 是操作者声明；HTTP 已改为服务端按会话钉定，远程认证仍未实现"。

## 五、验证

```
python3 scripts/verify.py --label w09-session-identity \
  --out evidence/development/2026-09-12-w09-session-identity --keep-going   退出码 0
  21/21 检查退出码 0
  negative-control 受控失败 ✓   fingerprint pairing: binary == source ✓
  status PASS · document_errors [] · sources_changed 0 · binary_stale false
```

| 命令 | 退出码 | 结果 |
|---|---|---|
| `cargo test --workspace --locked` | 0 | 111 |
| `python3 scripts/test_bridge.py` | 0 | 22/22（新增 2 项身份用例） |
| `python3 scripts/test_host_adapter.py` | 0 | 8/8 |
| `python3 scripts/test_execution.py` | 0 | 37/37 |
| `python3 scripts/test_patch.py` | 0 | 25/25 |
| `node web/tests/app.behavior.test.mjs` | 0 | 25/25 |
