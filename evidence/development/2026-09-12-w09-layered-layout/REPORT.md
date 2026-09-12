# W09：2D 调用视图变成真正的布局（第 2/3 步）

窗口：`2026-09-12/w09-layered-layout`
日期：2026-09-12（Asia/Shanghai）
结论：**DELIVERED**。2D 的调用视图从"三列网格 + 边连盒子中点"改成**分层布局 + 端口 + 折叠摘要边**，并且这一轮最值钱的产出是两个**只有实测才能发现**的事实：钉版引擎在浏览器里好用、在 `node:vm` 里不可靠；以及我第一版折叠逻辑**把折叠画没了**。

## 1. 为什么引入一个第三方文件

上一轮的诊断是：2D"效果不好"的根因不是样式，而是**缺了规格流水线里的中间层**（聚合 → 尺寸 → 布局 → 端口 → 标签）。规格对此有明确指令，并且要求**先在 fixture 上评估再定选型**，不是先假定：

> 优先沿用 ELK / elkjs 的本地布局方向…… 布局算法与 renderer 分离
> — `docs/specs/code-atlas-dual-view-design-2026-09-08.md` §9

所以这一轮真的去取了它、量了它、记录了口径，而不是"听说 ELK 好就用"。

| 项 | 值 |
|---|---|
| 包 / 版本 | `elkjs` **0.12.0**（钉住，不是范围） |
| 文件 | `lib/elk.bundled.js`，**逐字节未修改** |
| SHA-256 | `1222e44f953ce7746af23801e723708f8e6f436b8b377a6a5fc7552f34a307b3` |
| 大小 | 1,609,707 字节 |
| 许可 | EPL-2.0 OR GPL-3.0-or-later（全文在 `web/vendor/LICENSE.elk.md`） |
| 运行时依赖 | 无 |
| 职责 | **只算坐标**。它看不到分析，只看到 Atlas 已经推导出的盒子与边 |

记录写在 `web/vendor/README.md`，并且**计入门禁指纹**（`build.rs` 与 `verify.py` 两份清单同时更新——上一轮就是因为这两份不一致被门禁判红）。

## 2. 接缝：谁拥有什么

- **Atlas 拥有**：存在什么、什么是未知、预算裁掉了什么、选区带什么身份、折叠了谁。
- **引擎拥有**：盒子放哪里。

所以 `web/layout.js` 是纯的、可测的，并且**引擎是可注入的**：测试注入受控引擎，基准注入真引擎。

**折叠必须是可读的，不是可数的。** 超出 `LAYOUT_MAX_NODES = 120` 的成员按两种形状折叠，因为两者意思不同：

- **链**（两个已绘制对象之间的折叠中间层）→ **摘要边**，带 `members[]` 与 `viaCount`，标注 `经 N 个函数`，`declared: 'folded_chain'`；
- **尾**（挂在某个已绘制对象上、外面没有已绘制端点）→ **折叠标记盒** `折叠 N 个函数`，`declared: 'folded_tail'`。

两者都是虚线并且**绝不允许读成直接调用**。折叠的成员**逐个列在 `members` 里**，不是只给一个数字。

## 3. 三个由实测抓出来的真 bug（都发生在这一轮）

1. **折叠被画没了。** 第一版把折叠成员自己当成摘要边的端点，而"两端都必须已绘制"的守卫随即把每条摘要边丢掉。基准在 `focus_folded` 场景报了 `folded=81, summaryEdges=0`—— **预算切了图，图什么都没说**。修法：折叠必须归到**已绘制**端点（链）或生成折叠标记盒（尾）。
2. **折叠尾巴一个成员一个标记。** 分组键里错放了成员 id，"折叠 81 个成员"变成 81 个盒子，等于没省。修法：按锚点分组。
3. **缺失坐标被当成 0。** 最危险的一个：引擎返回没有坐标的结果时，适配器默认成 `(0,0)`，于是**所有盒子叠在原点**——一张看起来像有意为之、实际什么都没说的图。改成具名拒绝 `elk_returned_no_coordinates`，并单独区分 `elk_returned_duplicate_box_ids`。

**第四个发现是环境性的**：同一个图、同一个 API，在 `node:vm` 里**有时返回坐标、有时一个都不返回**（ELK 拿到另一个 realm 创建的对象时静默失败）。所以：

- 基准在**纯 node** 里跑（`scripts/bench_view_layout.mjs`），那里的数字才可信；
- 页面测试注入**受控引擎**，不依赖真引擎的宿主行为；
- 额外加了 `scripts/probe_browser_engine.py`：把**逐字节相同的**三个文件从临时本地服务拉起，用真实无头浏览器跑同一个 `planFocusLayoutAsync`，把结果读出来。**浏览器里的结果**：

```
ELK global: function
engine: elk_pinned (no error)
boxes: 21 edges: 20 ports: 40
ms: 230.9 crossings: 0 labelCollisions: 0
atOrigin: 0
distinct x: 3 bounds: {"width":874,"height":1106}
RESULT PASS
```

这条探针**故意不进 CI 门禁**：它需要浏览器和本地服务，而"缺环境就静默跳过"的门禁比没有门禁更糟。

## 4. 异步与 generation

elkjs 0.12 **没有同步 API**（`layout()` 返回 Promise）。这不是细节：它让"迟到的布局结果不得覆盖新选区"（规格原文）从一句话变成必须实现的东西。做法与页面既有模式一致：每次渲染递增 `state.layoutGen`，过期结果被**丢弃并具名**（`engine: 'discarded'`，附带 `engineLabel: 布局结果已过期（选区已改变），未采用`），而不是静默采用。有用例专门验证：两次选择之间释放旧布局，旧结果不得被采纳。

## 5. 门禁

`python3 scripts/verify.py --label w09-layered-layout --out evidence/development/2026-09-12-w09-layered-layout --keep-going`

- **25/25 检查 exit 0**（新增 `view-layout`）；
- 受控负对照 `entry-backfill-frontier` **red**（exit 1，受控）；
- 指纹配对一致 `8a28a20b0d3b8fa5521a7e7ee6aa72d619412cdbae771d9926d0bc8485d7f0cb`（binary == source，含新引入的 1.6 MB 引擎字节）；
- `sources_changed_during_run: 0`、`binary_stale: false`、`document_errors: []`。

`view-layout` 的判据（`scripts/bench_view_layout.mjs`，18 条全过）：同 fixture 必须同结果（确定性）、**无坐标结果必须被拒绝**、每个场景**标签碰撞为 0**、交叉数低于边数一半、典型焦点图 **250 ms 内**、折叠场景必须**真的折叠**且**产生摘要边**（否则"预算切了图却不说"会通过）。

原始数字在 `layout-evaluation.json`：`focus_small 111ms / focus_typical 30ms / focus_depth2 43ms / focus_folded 89ms`（折叠 121 → 绘制 80，36 条摘要边，包围盒从 2318×3302 收到 1008×3176）。

## 6. 测试增量

| 套件 | 之前 | 现在 |
|---|---|---|
| `web/tests/app.behavior.test.mjs` | 40 | **44** |
| `web/tests/city3d.behavior.test.mjs` | 28 | 28 |

新增 4 项（都是行为，不是快照）：分层与端口（上游 x < 目标 x < 下游 x；**每条出边有自己的端口 y**；每条绘制出来的边**必须从某个端口坐标出发**，不是盒子中点）；预算折叠（`exceeded` 为真、成员可列举、摘要边带 `viaCount == members.length`）；**无坐标引擎被拒绝**（回退、错误具名、**没有任何盒子留在原点**）；**迟到布局被丢弃**。

## 7. 没有做的事

- **没有 layout worker、deadline、取消、缓存**。布局在主线程上对 ≤120 块的有界图执行（浏览器实测 21 块约 230 ms，含首次引擎初始化）。规格要求 worker 与 deadline，这条**未实现**，写在 `LAYOUT_MAX_NODES` 旁边而不是藏在心里。
- **2D 的概览仍是网格**：只有**调用视图**是布局出来的。概览画的是层级块，本来就该是矩阵/分组而不是关系图，但"矩阵"也没有真正做过。
- **3D 一条都没动**：玻璃、边界端口、正交/平面视角、相机与折叠保存、按需重绘、搜索定位到层、`visibility_reason`、类层组、文件树/小图/时间轴全部照旧缺失。
- **帧时间与布局稳定性没有浏览器内量测**：脚本级有确定性检查，但没有在真实页面测量布局帧时间与重排稳定性。
- **2D 焦点视图本轮没有做浏览器截图验证**：无头浏览器点不了画布，而 URL fragment 只能选中已加载页里的对象（函数在第二页之后）。视觉验证靠的是浏览器引擎探针 + 行为断言，这条限制应当被读成"没有截图"，不是"截图好看"。
- 资格结论不变：W00–W10 的 qualification 一律 `NOT_QUALIFIED`，独立评审未做。广度仍按用户决定暂停（W07 资格、W10 宿主侧）。
