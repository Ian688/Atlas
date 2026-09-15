# Atlas 接入说明（给编程 Agent）

Atlas 是一个**本机**的代码工作台。它给你：查函数、读调用关系与源码、取有界上下文、
提交 diff 提案、在隔离副本里验证、比较修改前后。分析不调用模型；运行与写入都要显式授权。

**不要**去读 Atlas 的数据库文件，也不要直接改用户的检出目录当作"完成任务"。
 discovering 接口请用 `GET /api/contract`。

## 1. 连上

服务由人启动。你会拿到：

- `ATLAS_URL`，形如 `http://127.0.0.1:<port>/`
- `ATLAS_TOKEN`，本地会话令牌

每个请求都要带：

```
Authorization: Bearer <ATLAS_TOKEN>
Host: 127.0.0.1:<port>        # 必须与 URL 一致
```

令牌只在本机回环生效，等同于启动密钥；不要把它写进日志或提交内容。

等价的命令行入口是 `atlas`（同一个二进制）。命令清单同样在 `/api/contract` 里，
`transport=cli` 的条目只能用命令行，`transport=http` 的只能用 HTTP。

## 2. 先看接口清单

```
GET /api/contract
```

返回 `atlas.host-contract.v1`：逐条列出接口名、方法、传输方式、用途、**保证**和**限制**。
限制那一栏是真话——比如"单页上限 500""只说明入口运行结论，不是调用路径"。
按它写调用，不要猜。

## 3. 查函数、关系、源码

| 想做什么 | 怎么调 |
|---|---|
| 按名字/路径找函数 | `GET /api/search?q=<子串>&kind=function` |
| 取一个实体（符号 id、`path:name`、裸名都行） | `GET /api/node?entity=<引用>` |
| 谁调用它 / 它调用谁 | `GET /api/reach?entity=<引用>&direction=out\|in` |
| 读源码窗口 | `GET /api/source?entity=<引用>` |
| 看值来源、CFG、未知 | `GET /api/flow?entity=<引用>` |
| 判断能不能跑起来、缺什么输入 | `GET /api/profile?entity=<引用>` |

所有引用都在**当前这一份分析**里解析，跨版本的名字不会被改指到当前版本的同名对象。
解析不到会给出具名原因（`entity_not_found:<引用>`、`ambiguous_entity:<引用>:<n>`），
按原因调整，不要自己兜底。

## 4. 取有界上下文

```
POST /api/context
Content-Type: application/json

{"entity": "<引用>"}
```

返回内容寻址、可重复取回的上下文。它是**给你读的**，Atlas 不会替你发给任何模型。

## 5. 跑一次（可选）

```
POST /api/exec
{"symbol":"<引用>", "args":[…], "this_arg":…, "globals":{"NAME":…}}
```

- 在隔离副本里执行，Node 权限模型强制，沙箱边界由服务端决定，**页面/Agent 不能放宽**。
- 超时上限 30s。拒绝会给出具名原因和缺什么，按它补，不要硬闯。
- 修改前后对照：`POST /api/exec-compare`，两侧用同一份声明输入，需要先完成验证。

## 6. 提 diff

```
POST /api/patch/propose
{"entity":"<引用>", "diff":"<统一 diff 文本>", "summary":"<一句话>"}
```

- 这是 **Intent**：登记提案，不写任何文件。
- diff 必须能应用到固定快照的字节上；对不上会带那一行拒绝，并被记为 `rejected`。
- 支持修改 / 新建（`--- /dev/null`）/ 删除（`+++ /dev/null`）。重命名不受支持，会被具名拒绝。

## 7. 触发验证并读结果

```
POST /api/patch/verify          {"id":"<提案 id>"}
GET  /api/patch/verify?id=<提案 id>    # 轮询到 completed / failed / cancelled
```

验证会：从不可变快照物化隔离副本 → 重新索引派生一个新分析 → 出图差异 → 跑**启动时声明的**
测试命令（`argv`，不是 shell 字符串）。测试命令你改不了，只能在启动时由人配置。

结果里三类证据分开存放，不要互相冒充：

- `proposal` — Intent（diff）
- `verification.graph_diff` / `patched_analysis_id` — Static（重新派生的分析）
- `verification.test` — Observed（真实退出码与输出）

`test.ran=false` 表示**没有跑任何测试，这不是通过**。别把它读成绿灯。

## 8. 应用 / 撤销

只有人在启动时用 `--allow-writes <目录>` 授权过的那个目录可以写，而且请求必须逐字回显它：

```
POST /api/patch/apply   {"id":"<提案 id>", "confirm_path":"<契约里 writes.root 的原值>"}
POST /api/patch/revert  {"id":"<提案 id>", "confirm_path":"<同上>"}
```

未启用时一律 403。写入由人决定——**你不要替用户应用补丁**。

## 9. 几条硬规则

- 未解析、未知、截断必须原样呈现，不要因为不好看而丢掉。
- 静态候选、静态推导、执行观测是三类证据，展示时要能分辨。
- 不能绕过 Atlas 直接读写样本文件再宣称"工具可用"：目标代码的探索和验证要走这些接口。
- 提交内容里引用证据时，给出分析 id、提案 id、验证记录，让人能在工作台里定位同一份东西。
