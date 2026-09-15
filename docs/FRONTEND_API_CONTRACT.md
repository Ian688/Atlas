# 前端接线：历史接口核对

本文保留v1时期的接口核对，部分字段与缺口已经变化。**当前实现请从[v2区域与技术栈映射](design/atlas-v2/DESIGN.md)及各页操作规格开始，具体字段核对当前server/contract。** 本文不再决定页面或开发顺序。

2026-09-13，只读核对 `server.rs`、`query.rs`、`facts.rs`、`exec.rs`、`runner.rs`、`patchwork.rs` 与 `web/app.js`。下面行号是本次源码定位提示，改动后以符号为准。没有执行产品测试；拟议项不是已存在 API。版式和交互见 [主设计](FRONTEND_DESIGN.md)。

## 1. 可直接复用的接口

除特别说明，API 位于 `crates/atlas-app/src/server.rs`，现有服务固定一个 analysis；继续使用现有会话身份，不由页面声明 owner。

| 用途 | 实际请求 | 返回/前端映射 |
|---|---|---|
| 函数分页 | `GET /api/nodes?kind=function&limit=100&cursor=…` | `{analysis_id,total,items,next_cursor}`；node 的 `id,path,name,kind,parent,start,end` 映射导航/选区。当前不是文本搜索 |
| 单目标 | `GET /api/node?entity=…` | `{analysis_id,node}`；优先用确切 ID，名字歧义拒绝 |
| 上游/下游 | `GET /api/reach?entity=…&direction=in|out` | `{analysis_id,root,direction,nodes,edges,unresolved,frontier,truncated,semantics}`；HTTP 固定 100 节点/400 边预算；这是多跳结果 |
| 源码 | `GET /api/source?entity=…` | `{analysis_id,snapshot_id,entity_id,path,blob,start,end,content,truncated}`；对象起点最多 16000 字节，不支持任意区间请求 |
| Flow | `GET /api/flow?entity=…` | 原始 flow 对象；主要消费 `ops,block_states,def_use,returns,throws,effects,unknown_reasons,coverage,budgets,interprocedural,frontier` |
| 画像 | `GET /api/profile?entity=…` | `classification,runnable,reasons,params,arity,required_grants,required_context,required_globals,unsatisfiable_context,captures,enclosing_symbol` 等 |
| 预检/运行 | `POST /api/exec` | body `{symbol,args,timeout_ms,allow_effects,fixtures,fixture_note,plan,via,via_chain}`；`plan:true` 预检，否则等待最终 record；Node/环境/权限由服务器控制 |
| 运行历史 | `GET /api/exec-records?entity=…&limit=20` | **数组**，不是 Page；记录含 `id,analysis_id,snapshot_id,symbol,spec,profile,verdict,refusal,value,thrown,console,duration_ms,exit_code,source_binding,trace,isolation` 等 |
| 上下文导出 | `POST /api/context` | 复用现有 `web/app.js` context 请求与返回路径，固定选区后导出，不发全仓 |
| 提案列表 | `GET /api/patches?entity=…&limit=20` | `{analysis_id,entity_id,proposals}` |
| 提案详情 | `GET /api/patch?id=…` | **裸 PatchProposal**，含 `id,analysis_id,entity_id,state,proposal,verification,target,terminal_reason` 等 |
| 登记提案 | `POST /api/patch/propose` body `{entity,diff,summary?}` | `{outcome,proposal}`；HTTP 400 也可能含被拒提案，应显示拒绝原因 |
| 应用/撤销 | `POST /api/patch/apply` / `revert` body `{id,confirm_path}` | `{proposal}`；服务需 `--allow-writes`。无开关 403、目录不匹配 400、状态/漂移 409 |

定位：列表/关系/源码 `server.rs:82–141`、`query.rs:89/168`、`store.rs:594`；profile `server.rs:154`、`exec.rs:171`；run `server.rs:836/865`、`runner.rs:385/1124`；patch `server.rs:189/414/472/494/574`、`patch.rs:28`。

## 2. Flow 到来源与源码的映射

`crates/atlas-engine/src/facts.rs` 定义以下已有字段：

- `ops[]`：`index,kind,detail,start,end,may_throw`。
- `block_states[].bindings[]`：`binding,name,init,defs,value`。
- `def_use[]`：`binding,name,defs,uses`。
- `interprocedural.callsites[]`：`op,start,end,label,targets,targets_complete,unknown_component,args,result`。

前端建立 op index→op 字典。点击 definition/use/callsite 使用该 op 的 UTF-8 范围，不用 DOM 字符序号。已知来源和未知分量可以同时展示；缺失的字段显示缺失，不能按函数名字推导业务结论。跨目标点击先取得对应 node 和 analysis，再取源码。

调用图分别请求 in/out，按真实 edge ID 去重，保留两边各自的 frontier/truncated。焦点一跳只取 `target==root` 或 `source==root` 的边。多跳候选如果显示为摘要要带路径/成员，不能借 BFS 向用户声称因果或精确数据流。

## 3. 需要补的接口：只在依赖切片中实现

### F1：真正的函数搜索

现前端 `app.js:604/629` 最多取 24×500 个 all-node，再本地过滤。该方法不能承诺全项目搜索。

拟议 `GET /api/search?q=&kind=function&limit=&cursor=`，返回标准 Page，增加 query 回显。存储侧按当前 analysis 查名称/路径、稳定排序、分页；cursor 绑定 query/kind/analysis/limit。中文/大小写/空白匹配规则明确一种即可，不先上搜索平台。无查询时可直接复用 nodes(kind=function)。匹配总数只在实际算出时报告，截断要具名。

### F2：任意源码窗口

扩展 `/api/source` 接受受限的 `start,end` 或 `around_start,around_end`（实施时选一种），全部是固定 blob 的 UTF-8 字节；返回补 `file_total_bytes,start_line`。节点身份/文件归属照常校验，限制响应大小，调整到有效 UTF-8 边界。窗口外范围拒绝或说明裁剪；不得回退读取当前磁盘文件。长函数后部、非 ASCII 和有多行换行的锚点必须实际定位到。

### F3：所需上下文输入

RunSpec 已有 `this_arg,globals`；HTTP `ExecRequest` 未接这两项。新增可选 JSON receiver 与具名 globals，按画像缺项显示，校验并记录进 spec。它们是数据输入，不意味着授权文件/网络/子进程。当前 HTTP `allow_effects` 只允许既有窄范围（实际 handler 可确认 `unknown_calls`）；不要从 CLI 参数自动扩大网页权限。超时最高 30 秒、参数上限等保持可解释。

### F3 后续：取消/恢复的真实语义

当前 HTTP 执行同步等待最终结果，无取消路由；局部 `_cancel_tx` 没有发送取消。**AbortController 只能停止客户端等待，不能显示“进程已取消”。** 首个真实运行闭环可沿现接口完成，取消按钮需等后端具备实际能力才出现。

拟议兼容现 `/exec`，增异步提交返回 owner-bound `run_id`，状态查询和 `POST /api/exec/cancel {run_id}`；复用 runner 已有 watch cancel 与进程回收。queued/running/cancelling/terminal 区分，断连后凭同一 ID 查询，不重复执行未知结果。优先复用现有作业/请求基础，不另起并行终态账本。若第一片只做进程内句柄，必须说明重启不恢复，不能称持久作业。

> **2026-09-15 已接通**：`POST /api/exec` 支持 `background:true`（立即返回 `run_id`）；
> `GET /api/exec/run?id=` 状态、`POST /api/exec/cancel` 协作取消、`GET /api/exec/runs`
> 本会话运行清单均已存在。句柄在进程内（重启不恢复），已发布执行记录仍在 store。
> 项目编排（`projects` / `project/open` / `project/open/cancel` / `project/reindex` /
> `project/settings`）也已接通：页面可打开/切换项目、应用后重新索引出新版本、
> 声明测试命令。以 `GET /api/contract` 为准。

### F4：网页触发补丁验证

当前无 `/api/patch/verify`，实际逻辑为 `patchwork::verify_proposal`（`patchwork.rs:185`），CLI 已能入队 `patch_verify`。

拟议 `POST /api/patch/verify {id,request_key,test_profile_id?}` 返回 job ID，增加 owner-bound 状态查询。复用已有 patch_verify 队列和 verify_proposal；服务器决定 worker/Node/资源配置，测试命令来自本机显式声明的 profile。首片可以只做静态验证，返回 `test.ran:false`，UI 不写“测试通过”。不要让网页任意提交扩大权限的 shell 字符串。

验证结果已有 `base_analysis_id,patched_snapshot_id,patched_analysis_id,applied_files,deleted_paths,graph_diff,test,isolation,note`。按这些字段画报告；图差异中的匹配置信/限制如实保留。完整共同输入的前后运行对照需要两次真实记录关联，只有一侧时明确另一侧未运行。

## 4. 第一片顺手修掉的消费错误

这些与新页面实际正确性直接相关，不是另开的工程任务：

| 当前问题 | 直接处理 |
|---|---|
| `api/apiJson` 只显示 HTTP 状态，丢 body | 统一解析 error/detail/proposal，保留请求状态与局部重试 |
| `loadPatches/loadAnnotations` 没有 generation，失败当空列表 | 按 `(analysis,entity)` + generation，empty 与 error 分开 |
| source/reach 用 Promise.all 联合失败 | 独立资源状态，成功的面板继续可用 |
| 提案提交等待中切换函数，旧请求可能清理新草稿 | 草稿按选区保存；提交完成只更新对应 key 的缓存 |
| 未知定位只打印字节数 | 使用新源码窗口真实定位与高亮 |
| `/api/contract` 仍有“应用只在 CLI”“无文件锁”等旧文案 | 随相关 handler 变更同步，避免 UI 据旧描述禁用已有动作 |

## 5. 明确不伪造的数据

`trace.kind="observed-entry-call"`、`coverage="not_sampled"` 仅支撑入口结果与已有异常/输出，不能生成行级执行图、调用级时间轴或完整路径高亮。原型中的关系标签、画像与结果是设计样例；生产 UI 只消费实际字段。若需要新派生摘要，明确输入/算法/未知，禁止从示例值硬编码结果。
