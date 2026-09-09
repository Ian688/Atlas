# Code Atlas 独立运行与外部 Agent 集成规格

版本：1.3 · 2026-09-08。配套：开发设计 2.0、算法规格 1.5、成熟能力规格 1.3、长期任务书 1.7。本文是架构与验收合同，尚未对任何外部宿主完成集成验证。公开接口依据与 Atlas 自拟接口分别标明。

## 1. 产品判断与交付边界

Atlas 值得具备独立交付能力：同一份本地代码事实、运行与验证能力，可以服务 Modus、外部 Coding Agent、独立工作台和 CLI / CI。商业收益是待验证假设，不从视觉吸引力直接推定付费需求。

将 Atlas 定位为“供 Agent 使用的代码分析、执行验证与可视化工作台”。其中 Runtime 指索引作业、语言 worker、测试环境、运行采集和变更验证的生命周期；模型会话、推理循环和跨任务调度仍由宿主负责。可以增加自有聊天客户端适配，但不以重建通用 Agent 平台作为 Atlas 引擎前置条件。

从现在的实现开始保证核心可脱离 Modus 启动、操作与验收，并补齐 CLI / 通用协议的真实通路。独立商业 App、账号 / 计费、各平台安装器、所有宿主嵌入 UI、Atlas 自有聊天属于分别评估的发布形态，不悄悄附加到所有基础工作包。不能反过来以“先做 Modus”为理由，把选区、上下文、Runner 或验证锁死在 Modus 私有对象中。

本合同不增加第 34 个顶层工作包；可移植边界、通用集成和下文适用 HI 验收纳入 CA-00、UP-02、MX-01 / 05 / 06 / 10。专属宿主增强以 HostCapabilityProfile 单独取得资格；未验证的宿主不列为已支持。

## 2. 一个核心，多个外壳

| 层 | 所有权 | 不应依赖的内容 |
|---|---|---|
| Atlas Engine | Rust 核心、语义 IR、事实 / 快照、分析与查询、增量失效 | Modus 会话表、特定聊天窗、LLM 可用性 |
| Atlas Execution / Review Services | 环境、fixture、场景、探针、报告、发现、上下文编译、候选改动与验证 | 必须由 Modus server 启动或由某模型决定事实 |
| Atlas Workbench | 通用选区 / 标注 / 意图状态、图投影、运行留痕、比较与可访问交互 | 以 DOM 像素位置作为实体身份、特定宿主消息桥 |
| Host Adapters | Modus 接入、MCP、CLI、WebMCP、兼容宿主 UI、可选自有聊天 | 各适配器各自构建一份真相图或绕过核心执行约束 |

Rust 仍是独立引擎主线；Node / Python 语言 worker 与目标项目环境分别管理。通用服务可按适合的语言实施，但共享合同、事实与结果归属，不以跨语言为由复制事实求解器。宿主提供 Identity / Workspace / Policy / Credential / Agent / OpenView 等端口；独立模式提供本地实现或声明未配置能力。既有授权在范围内复用，不每次查询或选中都重新询问。

建议的最终逻辑归属为 `code-atlas/engine`、`contracts`、`node-worker`、`python-worker`、`runtime`、`workbench`、`adapters`、`cli`。当前暂放在 `src/modus/` 或 `electron/` 的代码可分步迁移；路径不是验收结果。必须通过“无 Modus server、无 Modus 数据库、无模型”的独立进程检查。不要为目录好看一次性移动另一 Agent 的工作。

一个服务实例可以处理多个 ProjectHandle，但每个请求都验证所有者与范围。UI 可关掉而索引 / 测试按已确认作业策略继续；宿主断开不等于测试通过，取消须落实到实际子进程和资源清理。工作台显示的投影是可重建视图，核心事实和运行记录保持唯一来源。

## 3. 外部 Agent 应读取的内容

外部 Agent 必须能读取机器可用的 WorkbenchState，而不仅是截图。按请求返回：项目和源码快照、分析版本、选择与标注、可见范围及折叠摘要、图层、业务意图、当前 / 历史运行、断言和证据缺口、候选变更状态。折叠节点并不表示对象不存在；视口内对象也不自动成为完整影响范围。

四类材料分开：CodeGraph 保存有来源的代码事实；IntentGraph 保存用户和模型的拟议设计；RunOverlay 保存特定运行观察；WorkbenchState 保存用户正在看什么、想做什么。静态可能路径、拟议关系、真实观察路径不得因共用颜色而混成一种事实。

读取流程应是“能力 / 项目摘要 → 指定请求和选区 → 有界依赖与运行证据 → 必要源码”。ContextBundle 带 included / omitted / unresolved / redacted 清单与继续读取的引用；达到预算须明确截断，不能让 LLM 把局部材料误认为全项目。减少源码重复发送和建树 token，不保证解释或修改不需要读取关键函数、调用者、契约与测试。

正式双视图按 [双视图规格](/Users/yinsijie/CodeRepo/Modus/docs/code-atlas-dual-view-design-2026-09-08.md) 扩展：WorkbenchState 保存各 pane 的 view_mode / lens / projection_ref 与联动；ViewProjection 明确 display instance、canonical / invocation 与聚合成员。外部 Agent 可以读同一选区，切换 2D / 3D 或关系镜头，切换维度不重新请求模型建树。

## 4. 选区与标注合同

SelectionEnvelope 至少包含 owner_id、project_id、snapshot_id、analysis_revision、selection_id / revision、entity / port / relation 引用、source_anchor 与内容 hash、可选 run_id / invocation_id、annotation_refs、graph_layer、来源窗口和创建时间。所选对象、实际执行入口、依赖、观测范围、允许写范围独立表达。

用户点击“交给 Agent”后冻结 InteractionRequest；后续移动鼠标或改选区不得改变已经提交的请求。批量选择支持版本化集合与显式查询选择器，但真正执行前物化并核验目标集合；不能到执行时偷偷使用新的 latest selection。

以下是 Atlas 拟议的请求摘要示例，不是当前可调用 API；实际 schema 还需严格定义全部引用、枚举、错误和大小限制：

```json
{
  "schema": "atlas.interaction-request.v1",
  "request_id": "rq_42",
  "project_id": "delivery_demo",
  "snapshot_id": "snap_18",
  "selection_ref": {"id": "sel_7", "revision": 3},
  "intent": "检查这条用券路径在两笔并发订单下是否会重复核销",
  "context_ref": "ctx_42",
  "host_binding_ref": "binding_5",
  "operation": "review_and_test",
  "write_scope": [],
  "expected_revision": 1
}
```

截图和布局说明可作为辅助材料，但截图无法替代 source hash、函数身份、运行实例与断言结果。标注也是数据；从用户项目、注释或网页读到的指令不能扩大此请求的权限和披露范围。

## 5. 双向通路与请求邮箱

| 方向 | 机制 | 完成的含义 |
|---|---|---|
| 用户 / UI → Atlas | 冻结选区、意图和 InteractionRequest，写入本地邮箱 | 请求已存，不代表模型已接收 |
| Atlas → Agent | 宿主支持的上下文 / 用户消息提交，或 Agent 按引用主动领取 | 交付 / ACK，不代表测试或修改完成 |
| Agent → Atlas | 类型化查询、场景 prepare / run、候选变更、ViewCommand | 服务校验后实际执行并返回回执 |
| Atlas → UI / Agent | 带游标事件流、GraphDelta、报告引用、状态读取 | 具体作业结果和证据，独立于聊天文本 |

通用最小路径不依赖向聊天窗注入内容：用户在 Atlas 提交请求后，在原 Agent 任务中说“处理 Atlas 的 rq_42”；Agent 用 MCP / CLI 领取并读取材料。宿主不支持自动触发回合时，界面清楚显示“等待 Agent 领取”并提供复制请求引用，不伪装已经发送。复制内容只带非敏感引用和目的，不夹带凭据。

宿主允许时，可以把“交给 Agent”直接绑定到该会话的公开提交接口。绑定来自用户选择或明确宿主会话，不通过猜最近窗口、扫描聊天数据库、修改历史文件或模拟键盘实现。宿主资源变更通知 / 工具结果变更不等于自动启动新的 LLM 回合；推送事件和调度模型是两项独立能力。

邮箱状态：draft → queued → delivered → acknowledged → running → completed / failed / cancelled；stale / expired 表示版本或寿命失效，不能覆盖已经发生的运行历史。记录 request_id、payload_hash、目标 binding、递增事件序号、租约和 ACK。采用可重试交付与幂等执行，不承诺跨进程全局 exactly-once；不可幂等副作用在不确定时先查状态，禁止盲重试。

只有用户指定或已绑定的 Agent 可以领取可写任务；多 Agent 中一个取得执行租约，其他保持观察或产生独立提案。作业和变更另有 job_id / change_id，消息重发不得启动第二笔支付、第二次迁移或第二份落地操作。断连后可从游标恢复；游标过期返回 gap 和重新取快照的方法，不能偷偷丢事件。

2D 与 3D 的标注均冻结到同一个 InteractionRequest；已提交请求不因视图或布局变化而漂移。选中聚合节点时固定真实集合 / 查询范围，运行实例与源码修改对象分开；具体由双视图 DV 与本合同 HI 联合验证。

## 6. 拟议的协议面与读取算法

以下名称是拟议的 Atlas 服务操作；MCP、CLI、WebMCP 只是它们的适配，不是三套业务实现。

| 操作族 | 典型操作 | 核心限制 |
|---|---|---|
| 能力 / 配对 | capabilities、session_bind、session_unbind | 协议版本、host profile、身份范围、实际支持能力 |
| 工作台 | workbench_get、selection_get、annotation_list | 返回版本化状态与分页引用，不默认导出所有源码 |
| 请求 | interaction_get、interaction_claim、interaction_ack | 冻结 payload、租约、幂等；ACK 不等于执行成功 |
| 理解 | context_prepare、graph_query、source_read、report_read | 复用 AL-12 / 上下文编译器，预算与遗漏可见 |
| 测试 | scenario_validate、run_prepare、run_start、run_cancel | 本地校验，目标环境 / fixture / effect 模式与断言明确 |
| 开发 | design_intent_put、change_prepare、change_validate、change_apply | 绑定候选快照、来源 hash、写范围和并发条件 |
| 视图 | view_command、events_read | 有限动作和证据引用；不能创造运行事实或通过状态 |

读状态与修改状态均包含 expected_revision 或具体版本；查询返回 snapshot / analysis_revision / run_id / projection_revision 组合及一致性状态。实体重命名后用有证据的跨版本映射，歧义则返回 stale / ambiguous，禁止只按函数名把操作转到另一个对象。

本地实现算法：校验请求范围 → 固定快照 / 运行 → 解析版本化目标 → 索引查询和有界依赖切片 → 组合输入上下文、运行证据与必要源码 → 披露过滤 → 返回材料清单与后续游标。该流程不调用 LLM。模型需要更多信息时显式翻页；大图按语义区域请求，不用一条工具结果返回数百万关系。

事件流采用分页 / 有界批次、背压、取消与重连；图布局位置可合并，运行因果事件和请求回执不能因 UI 节流而被静默丢弃。协议大版本不兼容时停止相应操作并给出升级理由；可选字段通过能力协商扩展，跨语言 golden 消息和旧客户端回归测试覆盖兼容范围。

CLI 必须支持结构化 JSON 输入输出、分离 stderr 诊断、明确 exit code / partial 状态、截止时间与可取消作业引用。提出 `atlas serve`、`atlas request get` 等命令时标明设计状态，不能在安装器 / 教程中假称命令已存在。无守护进程运行也应能读取导出包；写操作不以任意本地 JSON 文件为执行凭据。

外部 Agent 可能直接用编辑器 / 文件工具写代码。区分两种实际模式：经 Atlas change 协议生成候选、验证并落地；或 Atlas watcher 观察外部写入，标记 external_edit、建立新快照、撤回旧事实并提示待验证。第二种仍能实时渲染和 Review，但 Atlas 无法仅靠协议约定约束其他进程的全部文件写入，也不能补称变更已经过自己的授权 / 验证。需要受控落地时，把 Agent 的可写范围配置为候选工作区并实际验证隔离；解析失败保留错误区与上个可读图，不用旧图表示新代码已有效。

## 7. Codex 等宿主的真实接入边界

检索日期：2026-09-08。OpenAI 文档部分原 Codex URL 当前跳转到 `learn.chatgpt.com`，正文区分 ChatGPT、Codex 与可用宿主；这不证明用户已安装版本拥有所有能力。下表只描述公开接口和可推导的 Atlas 方案，仍需安装版本 / 账号 / 组织策略 / 实际会话验证。

| 路线 | 官方依据支持什么 | Atlas 的用法与边界 |
|---|---|---|
| MCP | 本地 Codex 客户端可接 STDIO 或 Streamable HTTP 工具服务 | Atlas 独立 MCP server 暴露能力、选区、报告、测试与变更；不能由此推导任意聊天窗消息注入 |
| WebMCP / Site tools | 在支持的内置浏览器中，页面注册动作供 Agent 发现和调用 | 顶层 Atlas 工作台可暴露 workbench_get / view_command 等；网页关闭后工具可能消失，耐久作业仍由 Atlas 服务持有 |
| MCP Apps / 插件 UI | 兼容宿主的组件与工具桥；ChatGPT 文档包括 ui/message 和 sendFollowUpMessage | 可作为直接选区交互的增强适配；不能把 ChatGPT iframe 桥当成所有 Codex Desktop 都实现的 API |
| Codex App Server | 在自有产品中构建会话、审批、历史与流式 Agent 体验 | Atlas 自有聊天客户端可提交选区并消费流式改动；不是接管已有 Codex Desktop 聊天窗 |
| Codex SDK | 在自有程序 / 工作流 / CI 中程序化运行 Codex | 用于 Atlas 自有作业编排；不等于桌面 UI 扩展 API |

当前 Site tools 官方文档示例使用 `document.modelContext?.registerTool`，要求顶层页面 JavaScript 注册；文档明确当前不发现 iframe 内注册工具，也不支持声明式表单 API，且有模型 / 工作区 / 灰度限制。实现时按实际宿主检测，不凭 API 名或 WebMCP 总规范声称浏览器全部支持。Modus 中的嵌入工作台走原生适配；外部浏览器工作台另提供顶层入口，两者共用核心操作。

MCP 工具接入、网页工具、MCP Apps 嵌入组件是不同扩展面：不要把 iframe 中的 MCP Apps 桥与顶层页面的 WebMCP 发现机制混用。HostCapabilityProfile 分别记录 tools、resource_read、event_subscribe、view_embed、selection_read、submit_user_message、steer_active_turn、owned_chat_stream，并记录实测版本与证据。

App Server 路线优先评估 stdio 与版本匹配的生成 schema；其他传输按其当前成熟度验证。turn/start / steer 等仅用于本客户端拥有和绑定的会话。Atlas 独立 MCP server 是 Atlas 向 Agent 暴露能力，与已弃用的 `codex mcp-server` 命令方向不同，不以该弃用命令作为新架构前提。

## 8. 完整使用例：选中用券路径交给外部 Agent

1. 用户在工作台选中“券校验 → 订单创建 → 券核销”的真实对象，标注“两笔并发订单只能有一笔核销成功”。本地保存选区、契约、版本与请求 rq_42。
2. 支持消息提交的宿主接收这条请求；通用模式由用户在已选 Agent 任务中引用 rq_42。Agent 领取请求，Atlas 返回必要调用关系、事务 / 存储依赖、已有测试、可执行上下文与不确定项。
3. Agent 提出两个 actor 的 ScenarioPlan。Atlas 校验数据准备、实际入口、同步点、资源模式与断言，在测试环境执行；不能靠逐次串行调用冒充并发，不能让两个 actor 使用不同数据库而宣称同券竞争。
4. 真实 invocation / transaction / message 事件激活管道；一个失败也保留它实际走过的路线。发生采集缺口时明确显示未知段，未触达节点变灰。
5. Agent 读取报告并解释断言、证据与缺口，可要求视图定位重复核销的调用实例。用户新增“修复”的明确意图后，或原任务已包含修复授权时，进入限定写范围的候选改动与独立验证。
6. 变更在候选快照解析，新增锁 / 条件更新 / 回调等对应真实源码对象；复跑并发反例与相关旧场景。工作台显示源码差异、关系差异、运行差异和验证结果，外部聊天收到同一证据引用。

该链路中“读取 Atlas 状态”不需要截屏；“理解业务和制定修复”按需用模型；“证明实际发生什么”由本地执行与证据提供。模型关闭后，已保存场景仍可运行、回放、比较和导出。

## 9. 同机、远程与数据边界

同机 Agent 可通过 STDIO / 本地服务共享 ProjectHandle；云端 Agent 不能直接解引用用户电脑上的绝对路径或 localhost。远程模式须在代码所在执行环境部署 Atlas，或建立已授权的窄范围连接 / 材料导出。运行在哪里、源码副本属于哪个版本、哪些材料经过网络必须显示清楚，不通过默认上传全仓来掩盖拓扑差异。

完整代码、索引与运行值保留在其已选本地 / 执行环境，向 LLM 提供披露过滤后的必要材料；外部宿主有自己的保留与处理策略，不能承诺已交付的材料仍完全本地。工具结果、注释与 fixture 值均按不可信内容处理，不成为宿主权限指令。

服务鉴权独立于“监听 localhost”：会话绑定、范围令牌、来源校验、有效期和撤销共同限制跨项目 / 跨窗口访问。凭据不写进分享 URL 或上下文包。沿用当前任务允许的只读、运行、写入与外部副作用权限；不扩大权限，也不把现有授权重复变成每次点击的确认流程。

并行宿主写入采用快照和乐观并发条件；不可直接把另一 Agent 未提交工作覆盖成“基线”。远程断开后先查询作业状态，再决定恢复或取消；暂存到本地的报告只在内容与版本核验后显示为可复验结果。

## 10. 集成验收 HI-01–16

| ID | 实际测试 | 必须观察到的结果 |
|---|---|---|
| HI-01 | 不启动 Modus、不配置模型，独立索引 / 查询 / 已存场景运行 | 核心链可用，模型调用 0，未读取 Modus 私有会话表 |
| HI-02 | 同一 fixture 通过原生适配、CLI、MCP 查询 | 归一化后事实、版本、未知和报告结论一致 |
| HI-03 | 提交选区后马上切换项目和窗口 | 已提交请求目标不漂移，其他项目实体不可混入 |
| HI-04 | 领取期间源码修改、重命名或删除 | stale / 映射证据明确，不按同名函数错误执行 |
| HI-05 | 请求重复交付、ACK 丢失和断连恢复 | 不重复启动不可幂等操作，能区分请求与作业状态 |
| HI-06 | 两个 Agent 同时领取 / 修改 | 租约和并发条件生效，独立提案可读，落地不互相覆盖 |
| HI-07 | 宿主不支持消息注入或自动回合 | 复制引用 / pull 通路完成任务，等待状态真实 |
| HI-08 | 用通用协议完成并发用券测试并控制视图 | 真实入口 / actor / 断言 / 管道回执对应，无伪造运行 |
| HI-09 | 声明 WebMCP 或 MCP Apps 的宿主配置 | 相应模式实测；不支持的 iframe / UI / 消息能力正确回退 |
| HI-10 | 大图 / 大 trace 中连续选区、分页、取消 | 有界响应和内存，省略 / gap 明示，读取不吞整仓 |
| HI-11 | 跨窗口 / 项目 / 过期绑定和凭据泄漏探针 | 越界拒绝；来源材料不能扩大授权，结果不含凭据 |
| HI-12 | 云端 Agent 使用本地绝对路径、远程服务断开 | 拓扑错误明确；仅授权通道传递材料，状态可恢复 |
| HI-13 | 声明 Atlas 自有聊天 / App Server 的配置 | 新建 / 继续本客户端会话，选区回合与流式改动贯通；不借用其他桌面聊天 |
| HI-14 | 外部 Agent 画布意图 / 部分生成 / 完成验证；另直接写入源码 | Intent / Code / Run 分开；直接写入触发 external_edit 与待验证状态，不冒称受控落地 |
| HI-15 | 客户端 / 服务协议跨版本、字段缺失、未知可选能力 | 支持范围内兼容，不兼容有明确错误，golden 消息可复验 |
| HI-16 | 至少一个真实外部 Agent 完成 Review—测试—改动—交接 | 提供宿主版本、实际工具回执、产物 hash 与独立复验；mock 不代替该资格 |

通用独立能力最低覆盖 HI-01–08、10–12、14–16 的适用本地 / 通用协议路径；HI-12 的不可达 / 禁止隐式上传反例始终适用，远程执行成功另按 profile 验证。HI-09 / 13 对声明对应增强的 profile 必须执行，未发布增强明确为未支持，不能因为没有宿主能力宣称全部外部集成失败。

HI 是 MT-23 / 24 和 MX 相关包的细化，不是已经运行的测试。外部实测缺失时可完成协议和本地实现，但 HostCapabilityProfile 保持未验证；不能把 mock 交互录屏当成 Codex Desktop 成功接入证据。

## 11. 推荐实施顺序与商业取舍

先在现有仓库把核心 / 服务 / 工作台 / 适配器的依赖方向做好，交付 headless CLI 和本地 MCP 服务，同时继续 Modus 闭环。第二步让独立浏览器工作台和至少一个真实外部 Agent 完成选区 → 场景 → 改动 → 验证，能力协商后再做 WebMCP / 内嵌 UI 增强。自有聊天可以为需要完整连续交互的用户提供进一步方案，但应单独评估认证、会话和分发成本。

不必现在拆成第二个仓库；包可独立构建、部署、测试、版本化后，再按发布节奏决定是否抽仓。禁止 Modus 与独立版各复制一个引擎。核心协议和操作 SDK 的开放程度、引擎许可证、团队协作 / 商业版本定价另行决定，本轮不擅自更改现有许可证或发布。

付费价值优先验证：复杂项目的 Review / 根因定位质量、跨模块改动的独立验证、团队交接与 CI 复验、不同 Agent 之间共享可追溯事实。对照记录实际任务完成率、耗时、遗漏、返工、运行成本与持续使用；“多接了一个聊天窗”或“省了首轮建树 token”不足以证明商业成立。

## 12. 官方依据与本轮交付检查

- [OpenAI MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)：本地客户端和 MCP 服务连接方式。
- [Site tools / WebMCP](https://learn.chatgpt.com/docs/webmcp)：同页 Agent 工具、顶层注册、当前限制与可用性条件。
- [插件 UI / MCP Apps](https://developers.openai.com/plugins/build/chatgpt-ui)：兼容宿主的 UI 工具桥；[插件 UI 参考](https://developers.openai.com/plugins/reference)补充 ChatGPT 组件 API。
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)：自有产品的会话与事件集成；[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)补充程序化工作流。
- [MCP 工具规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)：结构化工具定义与结果合同。

上述资料用于能力边界与设计推导，不是已经跑通的 Atlas 依赖清单。当前会话内宿主提供的私有工具也不自动成为第三方插件可获得的公开 API。文档检查验证编号、JSON 示例、交叉引用与格式；产品和宿主资格仍以 HI / MT 的实际证据为准。

## 13. 从当前 CLI 到完整独立服务的接缝合同

1.2 根据 [首轮实现审查](code-atlas-implementation-review-2026-09-08.md) 补强接口。当前 CLI 是独立化基础，尚不代表完整 Web runtime 或外部 Agent 集成已验收。具体迁移采用小切片，不一次性移动目录和重写算法。

通用服务应提供以下稳定操作族，路由/工具名称在契约实现时统一：project.open/index；job.get/subscribe/cancel；query.tree/symbols/neighbors/source/profile/summary；selection.freeze/read；scenario.prepare/run；run.read/replay；workbench.read/apply_view_command；change.prepare/validate。HTTP、CLI、MCP 和 Modus bridge 都适配相同 schema、错误与身份规则；浏览器自动化消费可访问 UI 和结构化状态，不单靠截图猜测实体。

共享 RequestContext 固定 owner/project handle、snapshot/analysis_revision、request_id、适用 generation 和能力 profile。游标再绑定查询/过滤器/排序，RunSpec 绑定 materialization/spec digest 与幂等账本；ViewCommand 只操作可视状态，不绕过执行合同触发实际效果。身份由会话/本地服务鉴权端口建立，不能相信 Agent 自报 owner。

索引/执行 job 的状态归属独立服务；Modus 只拥有适配关系。结果发布与当前用户选择分开，晚到的旧 job 结果不能覆盖新选择。终态、进度、取消、背压、恢复、临时资源回收都可机器读取；主线程/事件循环不能同步等待长查询。

WorkbenchState 是通用状态，不是前端私有字段导出：事实版本、选区/标注、投影 scope、加载与全量统计、query/run/回放游标、IntentGraph/Change 候选、unknown/truncated 都有协议表示。Node/DOM 引用和像素坐标不可作为持久实体身份。

独立 Web 最小验收：无 Modus server/数据库/模型配置，启动同一核心服务；在浏览器导入真实小项目；分页/定位函数；2D/3D 切换；freeze selection；CLI/Agent 工具读相同状态；受支持测试驱动真实轨迹。Modus 再接同一服务完成相同行为。缺少某 Host 的聊天注入 API 时，通过状态读取/请求邮箱/工具结果协作，不虚称支持注入宿主聊天窗。

新增反例并入 HI：双 owner 读/取消隔离、旧 generation、重复 key、跨 query cursor、关闭/重连恢复、无 Modus 运行、跨视图重复效果。宿主权威边界见 [Modus 集成计划](modus-atlas-integration-development-plan-2026-09-08.md)。

### 13.1 1.3：与新版 Modus 的责任闭环

Atlas 是可独立运行的代码能力服务与工作台。Modus 的三种策略、独立 CLI 与外部 Agent 通过公共端口访问相同 Query/Scenario/Run/Selection/Change 语义；不得把某个宿主的聊天 DOM、私有数据库或连接内存地址作为 Atlas 协议字段。

以无 Modus/无 LLM 的独立进程闭环和一个完整选区请求为资格：创建项目 → 索引 → 查询 → 冻结选区 → profile/prepare/run → 状态/报告 → 2D/3D 定位。再接可选模型处理 Intent/候选代码；模型读取与写入结果有版本/披露/回执。浏览器 DOM/AX 操作与结构化 API 使用同一命令服务，不能做两套互不一致状态。

宿主负责自己的模型调用与预算；Atlas 负责专业作业/进程资源、真实结果与本地数据边界。取消模型生成、取消 Atlas 作业、暂停播放、撤销待处理交互是不同动作。宿主失联后按租约/作业策略运行或停止，并能读取结果，不能自动重试未知副作用。

当前适配能力按 profile 报告；外部宿主没有聊天注入/推送能力时，提供可读请求引用与 pull/ACK，不依赖私有注入。实现可以按真实依赖拆分与升级，HI 的 owner/版本/幂等/披露与无宿主验收仍必须完整覆盖。
