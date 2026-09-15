# Atlas 宿主接缝（W10）

这份文档是宿主（今天的 Modus，明天的别的宿主）与 Atlas 之间的合同。合同的可执行版本是服务自己发布的
`GET /api/contract`（`atlas.host-contract.v1`），两者同源：`scripts/test_host_adapter.py` 会读回接口清单，
并断言适配器只用清单里发布过、且传输方式一致的接口。

## 1. 一条硬规则

**宿主通过接口工作，不读取 Atlas 的存储。**

存储布局（SQLite 文件、blob 目录、表结构、迁移）**不是**合同的一部分，可以随时改变。宿主一旦读库，就等于把这些
内部细节变成了隐式接口，之后任何一次迁移都会静默破坏宿主。

这条规则在本仓库里有可执行的检查，而不是口头约定：

- `adapters/modus/atlas_host_client.mjs` 只接受 `{url, token}`；构造函数里没有存储路径。
- `scripts/test_host_adapter.py` 读取适配器源码，断言其中不出现 `rusqlite` / `sqlite` / `atlas.db` / `blobs/`
  / `node:fs` / `readFile` 等存储访问。
- 同一个测试断言 `/api/contract` 的响应里不出现 store 路径或 `atlas.db`。
- E2E 里适配器只拿到 URL 与令牌，其余一概不知道。

## 2. 传输与信任边界

| 项 | 约定 |
|---|---|
| 绑定 | 只监听 `127.0.0.1`，端口由操作系统分配 |
| 鉴权 | 每个服务实例一个随机令牌，放在该实例独占的会话文件里（权限 `0600`），不打印到 stdout |
| 请求头 | `Authorization: Bearer <token>` 必需；`Host` 必须匹配；带 `Origin` 时必须匹配本服务 |
| 适配器额外约束 | 只接受 `http:` 且 host 必须是回环地址——本地令牌不能被送到别的机器 |
| CORS | 没有任意 CORS；静态页有 CSP |
| 传输方式 | `http`（服务接口）与 `cli`（本地进程，退出码即判定、stdout 是 JSON）在清单里分开标注 |
| 身份 | HTTP 上唯一可验证的身份是"持有会话令牌"，因此 owner 与作者由**服务端**按会话写入；请求体里的 `owner`/`proposed_by` 不被采信。CLI 的 `--owner`/`--proposed-by` 是本机操作者的自我声明，仍未认证 |

## 3. 接口清单（摘要）

完整清单以 `GET /api/contract` 为准；`?transport=http|cli` 可以只看一种。当前 HTTP 面：

`contract` / `report` / `nodes` / `search` / `node` / `edges` / `reach` / `flow` / `flows` / `source` /
`context` / `profile` / `exec-records` / `exec` / `exec-compare` / `run-markers` / `scenarios` /
`scenario` / `relocate` / `ui-state` / `selection` / `annotations` / `annotation` /
`agent/requests` / `agent/request` / `agent/work` /
`patches` / `patch` / `patch/propose` / `patch/verify` / `patch/apply` / `patch/revert` /
`exec/run` / `exec/cancel` / `exec/runs` /
`projects` / `project/open` / `project/open/cancel` / `project/reindex` / `project/settings`。

后台执行：`POST /api/exec` 带 `background:true` 立即返回 `run_id`；`GET /api/exec/run?id=`
查询状态（终态以 runner 发布的记录为准），`POST /api/exec/cancel` 发送协作取消，
`GET /api/exec/runs` 列出本会话在途与刚完成的运行（含目标对象）。句柄只保存在进程内：
服务重启后句柄消失，已发布的执行记录仍在 store 里。

项目编排：`GET /api/projects` 列出本机 store 记录的最近项目（含各自 `write` 授权标记）；
`POST /api/project/open` 按 `path`（索引并切换，返回 `op_id` 可用 `GET ?id=` 轮询、
`project/open/cancel` 取消）或按 `analysis`（直接切换）打开项目；`allow_writes:true` 是
本机操作者"以可写方式打开"的明确决定——写授权跟随当前项目（任何时刻至多一个目录可写，
`contract.writes.capable` 表示服务是否有写能力，`writes.root` 是当前项目的授权目录）；
`POST /api/project/reindex` 重新索引**当前项目**目录（应用补丁后的"打开新版本"）；
`GET/PUT /api/project/settings` 查看与更新**当前项目**声明的测试命令与超时（按项目
持久化与切换；入队作业保留自己入队时的快照）。

其中写入类端点受启动参数约束：`patch/apply` 与 `patch/revert` 只在服务以
`--allow-writes <目录>` 启动时存在，且请求必须逐字回显契约里 `writes.root`；
未启用时一律 `403 http_writes_disabled`。

CLI 面（宿主可用子进程调用）：`index`、`job …`（含 `job work` 执行 `patch_verify`）、
`patch propose|verify|apply|revert|status|list|unlock`（`verify --enqueue` 排队）、
`profile`、`exec`、`select`、`annotate`、`annotations`、`agent …`、`serve`。

补丁在**两个面上都有**：HTTP 提供 `patch/propose`（登记 Intent）与 `patch/verify`
（隔离验证），CLI 提供同一套校验路径的完整命令。两者共用同一段校验代码，因此在页面上
登记不了一个 CLI 会拒绝的 diff。

引用形式：`flow` / `source` / `reach` / `context` / `profile` / `exec` 都接受符号 id、`path:name`
或裸函数名，一律只在当前分析内解析；解析不到就报错，不会兜底成"其实是你给的那个字符串"。

## 4. 宿主必须原样呈现的东西

这些不是风格建议，是接口语义的一部分：

1. **未解析、未知、截断必须显示。** `target: null` 的调用候选、`unknown: true` 的值、
   `truncated: true` 的分页与源码窗口，都不能因为界面上不好看而丢掉。
2. **三类证据必须能分辨**：静态候选（关系图）、静态推导（flow/值来源）、执行观测（受控运行的返回/抛出与
   退出码）。观测记录里 `trace.coverage = "not_sampled"`、`unknown_paths = "not_observed"`，
   宿主不能把它渲染成覆盖率或执行路径。
3. **提案不是代码。** Intent 注解与补丁提案都带 `exists: false` / `code_exists: false`；
   只有 `patch apply` 之后的检出目录里才有那些字节。
4. **测试没跑不等于通过。** `patch verify` 未声明测试时返回 `ran: false` 与"没有跑任何测试，这不是通过"。
5. **沙箱不能被宿主放宽。** `/api/exec` 的请求类型里没有 Node 二进制、环境变量与分析版本；
   文件写、子进程、网络授权只能由本机操作者在 CLI 上给出。

## 5. 迁移与回退边界

**本切片没有切换 Modus 的旧入口。** 理由是可验证性，不是工作量：Modus 检出目录不在本工作区，
在这个仓库里既不能构建也不能测试宿主侧，切换一个无法验证的入口等于把一个声明当成结果。
`scripts/verify.py` 的 Modus 保护检查在没有基线时如实报 `cannot verify`，本切片沿用同一纪律。

迁移是**增量**的，旧路径在切换前保持不动：

1. 宿主仓库引入 `adapters/modus/atlas_host_client.mjs`（或等价实现），放在特性开关之后。
2. 宿主侧 E2E：起一个真实 Atlas 服务 → 宿主经适配器取事实 → 断言拿到的是同一 analysis 的内容。
3. 宿主自己的回归套件在开关打开时通过。
4. 回退验证：把开关关掉，宿主回到旧路径，回归套件仍然通过。**回退就是"停止调用适配器"**，
   因为适配器从不写宿主的数据，也不要求宿主迁移任何东西。
5. 宿主侧加一条与 `scripts/test_host_adapter.py` 同类的检查：宿主代码不得读 Atlas 存储。
6. 以上都通过之后，才切换 Modus 的默认入口并记录旧入口的退役日期。

仍然没有的东西：宿主内嵌的 adapter 包（本仓库只提供参考实现与合同）、远程/多租户认证、
服务发现与自动升级、多版本并存协商。这些是接力任务，不是本切片的隐含承诺。
