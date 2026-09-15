# Atlas 产品开发图谱

这是 [产品设计](../../PRODUCT_DESIGN.md) 的图解，供产品讨论和开发 Agent 交接。开发顺序仍以 [当前任务书](../../DAILY_DEVELOPMENT_WORK_ORDER.md) 为准；探索页像素与交互参考 [可点击原型](../atlas-explore-next/index.html)。图中 B/C/D 为后续设计，不代表已交付。每张图另有同名 `.mmd`，可单独渲染和修改。

## 01 产品全景：每个入口解决什么问题

```mermaid
flowchart LR
  atlas["Atlas：理解代码、完成修改、核验结果"]
  atlas --> explore["探索：应该改哪里"]
  atlas --> reason["追踪：为什么这样运行"]
  atlas --> coding["协作：怎样准确交给 Agent"]
  atlas --> verify["验证：改得对不对"]
  atlas --> review["审阅：是否采用"]
  explore --> map["项目地图 · 多区标签 · 搜索定位"]
  explore --> knowledge["算法摘要 · 注释 · 按需 AI 解释 · 批注"]
  reason --> static["调用与引用 · 值来源 · 修改影响"]
  reason --> observed["真实事件 · 异常 · 断点与变量"]
  coding --> task["目标 + 节点版本 + 范围 + 验收场景"]
  task --> proposal["讨论与提案回到同一任务"]
  verify --> scenario["保存场景 · 明确断言 · 批量重跑"]
  verify --> compare["基线与补丁：同输入、同声明环境对照"]
  review --> evidence["目的 · diff · 影响 · 测试 · 未验证问题"]
  evidence --> decision["返工 / 采用 / 应用后撤销"]
```

地图与解释已有新实现入口，需核对当前交付；运行和提案链已有基础。场景集合、完整影响、轨迹及调试的新增部分不能按本图直接宣布完成。

## 02 页面结构：功能放在哪里

这是区域关系图，不规定固定宽度。默认只展示地图与详情，其他区域按操作打开。

```mermaid
flowchart TB
  top["顶部：项目与版本 / 全项目搜索 / 当前任务 / 后台作业"]
  subgraph body["工作区：可分区、最大化、关闭、恢复"]
    direction LR
    nav["左侧导航\n探索 / 验证 / 审阅\n工作区 / 关注 / 3D / 设置"]
    paneA["区域 A：独立标签\n项目地图 / 子树 / 调用关系"]
    paneB["区域 B：按需打开\n源码 / 差异 / 数据来源"]
    inspector["右侧详情\n简介 / 依据 / 批注\n节点动作 / 当前任务讨论"]
  end
  bottom["按需展开验证区\n场景列表 / 实际与预期 / 日志 / 已采集轨迹"]
  top --> body
  body --> bottom
  paneA -. "选中节点，更新详情" .-> inspector
  paneA -. "在新区域打开，保留原图" .-> paneB
  inspector -. "运行或查看场景" .-> bottom
```

区域自己的选区、标签、展开、缩放和请求代次独立；激活区域决定详情上下文。换项目时恢复该项目的工作区，不把同名函数的草稿或结果带过去。

## 03 节点操作：点击什么、出现什么

```mermaid
flowchart LR
  node["节点：项目 / 目录 / 文件 / 代码成员"]
  node --> select["单击：本区域选中 + 详情"]
  node --> open["双击或 Enter：本区域节点标签"]
  node --> info["i：解释面板"]
  info --> sources["算法摘要 / 原始注释 / 按需 LLM"]
  sources --> save["查看依据 → 编辑 → 保存 → 历史"]
  node --> more["更多菜单"]
  more --> area["新展示区：保留原区，独立探索"]
  more --> note["批注 → 创建任务 → 预览交接上下文"]
  more --> typed{"节点类型"}
  typed --> project["项目：测试配置 / 重新分析 / 本次修改"]
  typed --> folder["目录：子地图 / 范围搜索 / 模块依赖"]
  typed --> file["文件：源码 / 声明引用 / 文件差异"]
  typed --> fn["函数：调用 / 值来源 / 运行 / 场景"]
  typed --> other["文本配置：阅读 / 批注 / 修改交接"]
```

缺少能力时显示具体原因和下一步。文件不是默认可执行入口；LLM 解释需要真实配置和明确发送范围；旧源码版本的解释保留来源并提示复核。

## 04 核心用户旅程：一次 AI 修改怎样交付

```mermaid
flowchart TD
  start["打开项目 → 地图或搜索定位价格函数"]
  start --> understand["看源码、调用者与已有依据"]
  understand --> goal["创建任务：负金额报错，零金额允许"]
  goal --> expected["确认场景与预期：负数 / 零 / 正数"]
  expected --> context["预览必要源码、节点版本、允许范围"]
  context --> agent["复制交接包或发送给已配置 Agent"]
  agent --> patch["收到提案，关联原任务与基线"]
  patch --> isolated["隔离验证：补丁分析 + 声明的测试"]
  isolated --> matrix["同场景运行基线与补丁，展示断言矩阵"]
  matrix --> review["审阅：差异、影响、失败与未验证问题"]
  review --> choice{"用户决定"}
  choice -->|需要修改| feedback["具体批注与失败证据返回任务"]
  feedback --> agent
  choice -->|接受| apply["确认真实目录和文件 → 授权应用"]
  apply --> fresh["重新分析 → 新版本同一节点"]
  fresh --> rerun["重跑场景 / 保留记录 / 必要时撤销"]
```

流程中“Agent 声明完成”“测试通过”“用户接受”“写入成功”是不同状态。任何一步失败要显示实际状态并可重试，不自动前进。

## 05 三种依据：关系、运行、AI 解释不能混用

```mermaid
flowchart LR
  source["固定项目源码与版本"]
  source --> parse["静态解析与求解"]
  parse --> facts["目录成员 / 调用候选 / 值来源 / 未知"]
  facts --> staticUI["结构、调用、数据与候选影响视图"]
  source --> run["显式运行 + 声明输入与环境"]
  run --> records["返回 / 异常 / 日志 / 实际测试结果"]
  run --> capture["后续：真实事件采集或调试适配"]
  capture --> events["采集事件 / 栈帧 / 变量 / 覆盖范围"]
  records --> runUI["结果、断言与对照"]
  events --> traceUI["轨迹或调试视图"]
  facts --> chosen["用户选择的上下文"]
  chosen --> model["显式调用模型或交接 Agent"]
  model --> suggestion["解释、建议、补丁：附来源与版本"]
  suggestion --> reviewUI["用户讨论与审阅"]
```

静态关系不能变成运行动画；未采集的值不能由模型补成观测。当前 runner 没有完整行级或调用轨迹。完整轨迹先验证真实采集，暂停调试另外管理会话。

## 06 结构：前端每种结果由谁提供

这是职责图，不是必须新建的服务或数据库表。优先扩展现有模块与记录。

```mermaid
flowchart TB
  subgraph consumers["消费者"]
    web["前端组件\n地图 / 源码 / 场景 / 审阅 / 任务"]
    external["外部 Agent / CLI"]
  end
  api["Rust 本地服务与公开接口\n鉴权 / 项目与版本 / 作业与取消"]
  web --> api
  external --> api
  api --> analysis["现有分析链\n语言 worker + Rust 分析与查询"]
  api --> execution["现有执行与补丁链\n隔离运行 / 测试 / 对照 / 应用撤销"]
  api --> workflow["扩展任务数据\n批注 / 场景断言 / 提案关联 / 审阅记录"]
  api --> adapters["后续适配器\n测试报告 / 轨迹 / 调试 / 浏览器场景"]
  analysis --> store["版本快照与记录存储\nProject / Analysis / NodeRef\nTask / Scenario / Run / Proposal / Review"]
  execution --> store
  workflow --> store
  adapters --> store
```

前端图布局、源码与 diff、测试报告及调试优先采用合适的成熟组件。图中的关联对象是产品语义，不要求一次建立通用平台或替换现有栈。

## 07 开发顺序：每一阶段交出什么

```mermaid
flowchart LR
  a["A 当前：地图收尾\n核对并完成 M1–M6\n节点 → 交接 → 提案 → 运行审阅"]
  b["B 下一步：修改验收\n任务与验收卡 / 场景断言\n前后矩阵 / 任务审阅"]
  c["C 定位原因\n数据来源 / 修改影响\n真实轨迹采集技术验证"]
  gate{"采集真实、定位正确\n开销与缺口可说明？"}
  trace["交付首种运行时间线\n不扩大为所有项目支持"]
  revise["调整或缩小采集方案\n保留已有运行能力"]
  d["D 项目流程\n结构化测试 / Git 变更\n浏览器场景 / 调试适配"]
  a --> b --> c --> gate
  gate -->|是| trace
  gate -->|否| revise
  trace --> d
  revise -. "独立项目能力可继续" .-> d
```

A 已有在途实现，先检查，不能照图从零重做。B 的完整金额边界任务比增加装饰和菜单更优先。D 的独立能力不需要等所有轨迹问题解决。

## 给开发 Agent 的交接文字

> 先按仓库 AGENTS.md 读取当前任务书与交接，再读本图谱和 docs/PRODUCT_DESIGN.md。图 01 明确目的，图 02–03 明确页面与点击行为，图 04 是贯穿用户任务，图 05–06 明确真实数据来源，图 07 是阶段顺序；图 08–09 补充语义接入与任务验收。当前完成 A/M1–M6；已经实现的功能直接验证和补缺，不重复建设。A 完成后按产品设计推进 B，不在同一轮扩张到全部轨迹和调试。每个功能交付真实页面行为与数据链，保留项目/版本身份；缺数据时给准确状态。报告实际完成的用户流程、未完成项与证据，不用图上的功能名称当作完成证明。

## 开发对照表

| 图 | 实现时回答的问题 | 最小核对 |
|---|---|---|
| 01 | 功能解决哪个用户问题？ | 用户能说明下一步做什么 |
| 02 | 结果在哪个区域出现？ | 新区不覆盖旧区；重开恢复 |
| 03 | 点每个控件实际发生什么？ | 同一节点/版本进入目标页面 |
| 04 | 跨页能否完成一次修改？ | 目标场景修复，检查回归，应用与撤销字节正确 |
| 05 | 显示的结论来自哪里？ | 可回到源码或实际运行记录，缺失明确 |
| 06 | 数据由谁生产、保存和消费？ | 页面与公开接口读取同一记录 |
| 07 | 本轮完成线在哪里？ | 当前阶段有最终包证据，不冒充后续能力 |

## 08 语义底座与接入：同一事实服务人和 Agent

```mermaid
flowchart TB
  ui["工作台：任务 / 地图 / 验证 / Review"] --> api["统一能力服务"]
  agent["外部 Agent"] --> mcp["规划：本地 MCP 适配"]
  mcp --> api
  cli["现有 CLI / HTTP 消费者"] --> api
  optional["可选内置 Agent"] --> api
  api --> query["基础查询与任务查询"]
  api --> execution["显式运行 / 测试 / 提案验证"]
  source["固定源码版本"] --> language["语言适配与索引"]
  language --> semantic["符号 / 定义 / 引用 / 类型材料"]
  semantic --> program["调用 / 控制流 / 数据流 / 未知"]
  program --> query
  execution --> observation["实际记录；后续采集轨迹"]
  program --> evidence["来源 / 版本 / 范围 / 完整性"]
  observation --> evidence
  evidence --> query
  query --> impact["变化对象 / 候选影响 / 关联证据"]
```

MCP 为计划中的适配面，当前已有 HTTP 不等于 MCP 已交付。语义底座复用已有代码，按支持范围扩展。节点展开走成员查询，局部解析、预算、查询、渲染失败分别处理。

## 09 Vibe Coding 与 Review：需求可逐条核验

```mermaid
flowchart LR
  request["自然语言需求 / 节点 / 失败步骤"] --> task["创建任务"]
  task --> card["可编辑验收卡\n位置与用户 / 输入输出\n空态失败 / 成功判据"]
  card --> scenario["确认预期 → 保存场景"]
  task --> context["确认候选代码与上下文"]
  context --> proposal["Agent 提案或导入变更"]
  proposal --> diff["源码差异 / 结构接口差异"]
  scenario --> compare["基线与补丁断言矩阵"]
  proposal --> compare
  diff --> review["任务 Review\n缺陷 / 风险 / 建议\n证据与未验证问题"]
  compare --> review
  review --> decision["采用或返工"]
  decision -->|返工| proposal
  proposal -. "新版本使旧结果需复核" .-> review
```

阶段 B 先完成 B1 任务/验收卡、B2 场景/断言、B3 前后矩阵、B4 任务 Review。浏览器元素到源码关联属于后续适配，不能由名称相似直接推断。
