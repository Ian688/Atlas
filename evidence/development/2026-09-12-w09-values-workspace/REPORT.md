# W09：值状态矩阵进函数工作台主视图

窗口：`2026-09-12/w09-values-workspace`
结论：**DELIVERED**。把 Atlas 最深的那层算法（局部抽象解释）从折叠面板搬到了画面正中央。

## 1. 交付

工具条新增工作区视图切换：**关系 / 值状态**（与层级切换同一套交互）。选中函数后切到「值状态」，
主视图显示：算法与状态行、正常返回的来源与未知、潜在抛出、效果（可能调用几个目标 / 是否存在未知外部调用 /
是否注册回调）、跨过程摘要（SCC 与递归数）、逐调用点的目标与实参来源、以及**绑定状态矩阵（块 × 绑定）**
与其图例（常量 / 确定值 / 已知来源 / 显式未知 / 该块无记录 / 角标=含未知分量 / 描边=读取时未初始化或可能未初始化）。

**实现方式是搬移，不是重画**：矩阵仍由同一个 `renderFlowHeat` 渲染，视图切换只是把 `#flow-body`
里已经渲染好的节点移动到主视图容器 `#matrix`。重写一遍渲染只会制造第二个真相——这正是本项目一直在防的漂移。

深链接新增 `&view=values|graph`，视图状态因此可分享（无头浏览器点不了按钮，这也是唯一能截图验证的方式）。

## 2. 验证

真实页面截图（rxjs 分析，函数 `innerFrom`，深链接 `#token=…&selection=<符号 id>&analysis=<id>&view=values`）：
主视图显示 `算法 atlas-local-absint@0.2.2 · complete_within_profile · 28 块 / 48 次操作求值`、
正常返回来源 `Parameter(0), CallResult(op14/20/26)…` 与未知 `call_result_unknown; callee_allocation_heap_not_imported; constructed_object_fields_unknown`、
潜在抛出、效果、`跨过程摘要 SCC 6568(递归 19)`、`绑定状态矩阵 · 14 块 × 2 绑定`；
状态行 `调用视图 11 块 / 10 边 · 未解析 10 · 引擎 布局引擎 · 交叉 0 · 标签碰撞 0`。

门禁：**25/25 检查 exit 0**，受控负对照 red（exit 1），指纹配对一致，`sources_changed_during_run: 0`；
`web-behaviour` 44/44。

## 3. 过程中的两个错误（都当场修掉，记下来）

1. 视图切换第一版**矩阵是空的**：`applyWorkspace()` 挂在 `render()` 末尾，而矩阵是在 `renderFlow()` 里填的，
   时序不对；
2. 修时序时**替换打错了位置**：把 `applyWorkspace()` 接到了重置路径 `renderFlow(null)` 上，而不是选中路径
   `renderFlow(flow, node.id)`。第二次替换才命中。

两条都不是设计问题，是"改完没立刻看画面"。**截图是这两次的唯一发现手段**。

## 4. 没有做的事

「167 处未知区域」仍是数字，不可点开；执行画像/受控运行没有自己的主视图（仍在侧栏折叠面板里）；
`ambiguous_entity` 分支仍未构造样本；`atlas node` CLI 仍未加。
