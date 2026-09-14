# Atlas 阶段交付 — F1 工作空间与真实选择

日期:2026-09-14。状态:NEEDS_INDEPENDENT_REVIEW(自测通过,待独立复审)。

## 用户结果

- 任务:T1 第 1 切片 **F1**(主设计 F1「工作空间与真实选择」),交付旧首屏到新工作台的替换。
- 现在能完成:
  - 打开 `scripts/demo.sh` 打印的地址,直接进入工作台:顶栏(项目/分析版本/状态/3D 入口)、左侧「查找函数」、中央任务区(结构定位/理解代码/运行验证/审阅修改四个页签;理解代码含调用关系/值从哪来/未知边界三个镜头)、旁侧源码依据区、底部细状态。旧首屏的 hero 标题、规模指标卡、「五件事」卡片和五步引导已删除。
  - 左栏查找是**服务端搜索**:`GET /api/search?q=&kind=function&limit=&cursor=`,按名称/路径子串匹配(大小写 ASCII 折叠,`%`/`_` 按字面),path→name→id 稳定排序,cursor 绑定 query/kind/analysis/limit;结果按文件分组显示,报告匹配总数与已显示数,空结果与失败分别呈现,失败可重试。
  - 选中函数后:标题/面包屑、源码(UTF-8 字节区间)、调用关系、值事实、执行画像、Intent/提案全部指向同一对象;关系图为**一跳上游+下游**合并视图(此前只有下游),未解析目标以虚线边界桩呈现;点击邻居/最近列表/返回按钮可连续导航,返回恢复对象与镜头。
  - 各资源(source/reach-in/reach-out/flow/profile/patches/annotations)独立加载、独立重试、独立报错;每个加载器按 select 的 generation 令牌 + 实体 id 双重核对,快速 A→B 切换时 A 的迟到提案/源码/画像不会出现在 B 上。
- 剩余:F2(值来源/未知定位到源码区间,含 /api/source 任意窗口)、F3(参数化运行表单)未开始;F1 的图节点点击在本会话的 IAB 自动化里需合成事件(HTML 按钮可真实点击),已用真实 CUA 点击+页面内 click 事件双路径覆盖,真人浏览器行为待复审确认。

## 改动与身份

- cwd `/Users/yinsijie/CodeRepo/Atlas`,基线 HEAD `cca8fcf`,本次改动未提交(工作区还有他人的文档改动,未触碰)。
- 服务端:
  - `crates/atlas-engine/src/query.rs`:新增 `SearchPage` + `search_nodes()`(LIKE 匹配 + json_extract 取 body 内 name + ESCAPE 通配符转义 + 稳定分页)。
  - `crates/atlas-engine/src/store.rs`:`Store::search_nodes` 转发。
  - `crates/atlas-app/src/server.rs`:`Request` 增加 `q` 字段,`"search"` 查询分支,`/api/search` 路由与 `endpoint!` 包装。
- 前端:
  - `web/index.html`:重写为工作台骨架(顶栏/左栏/页签任务区/源码旁栏/底栏),删除 intro/brief/tour/metrics/旧 explorer/旧 inspector 布局;保留全部 app.js 依赖的元素 id。
  - `web/app.js`:重写外壳与选区管线——服务端搜索(`runSearch/renderSearch`,防抖、追加页、签名守卫防 DOM 重建打断点击)、最近列表+返回栈(`select(push)/navBack`)、页签与镜头(`setMode/setLens/renderTask`)、资源独立加载器(`loadSource/loadRelations/loadFlow/loadProfile`,均带 generation+实体守卫与局部重试)、`mergeFocus`(in/out 一跳合并,按 edge id 去重)、API 错误体解析(`errorText/resourceError`,不再只显示 HTTP 状态码);flow/exec/patch/annotation/布局/层级渲染器原样保留。
  - `web/style.css`:工作台外壳样式(设计稿色板/间距/三栏网格/响应式),保留图内元素、heat 矩阵、3D 城市样式;外壳 `height:100vh` + 各区 `min-height:0` 内部滚动。
- 修复的消费错误(接线表第 4 节):`api/apiJson` 丢 body;`loadPatches/loadAnnotations` 无 generation 且失败当空;source/reach `Promise.all` 连坐失败;提案提交与选区切换竞态;viewBox 硬编码 800 裁掉焦点图右列。
- 兼容:`/api/nodes`、`/api/edges` 等既有接口未动;`/api/search` 为新增只读查询;3D 页(`/city3d`)与 bridge 协议未变。

## 实际验证

| 命令或浏览器操作 | 最终退出码/操作结果 | 日志或截图 | 验证范围 |
|---|---|---|---|
| `python3 scripts/verify.py --label f1-workbench --out evidence/development/2026-09-14-f1-workbench --keep-going` | **PASS(exit 0)**,26 项检查含 rust-clippy/tests、worker、integration、execution、patch、web-behaviour、city3d-behaviour | `evidence/development/2026-09-14-f1-workbench/` | 综合检查全套 |
| `node web/tests/app.behavior.test.mjs` | exit 0,**51/51**(新增 7 项 F1 检查:服务端搜索契约、空/失败区分、慢答案不落地、A 迟到提案不进 B、source/reach 独立失败+重试、返回栈、页签镜头) | 同上 verification.json | 2D 页面行为 |
| `cargo test --workspace --locked` | exit 0(新增 `search_matches_name_and_path_with_stable_pages_and_bounded_cursors`) | 同上 | 引擎层 |
| 浏览器(IAB):搜索 `write`/`dispatch`(非首屏)→点击选中;沿焦点图点邻居 redeem→dispatch;未解析桩 `? handler` 呈现;返回按钮 redeem→write→redeem;快速 onlyPositive→total 无串对象;镜头 值从哪来/未知边界 显示真实 flow 事实 | 全部通过(见截图) | 本报告同目录 `screenshots/` | F1 核心核对:搜索非首屏函数、快速 A→B、迟到结果不串 |
| `git diff --check` | exit 0 | — | 空白一致性 |

浏览器环境说明:本会话 IAB 对 SVG 节点的合成点击不稳定,图内导航用页面内 `MouseEvent('click')` 路径验证(事件沿同一监听器执行);左栏/页签/返回均为真实 CUA 坐标点击。已发现并修复 3 个真实 bug:侧栏重渲染替换节点打断点击(签名守卫)、外壳无高度约束把返回按钮推出视口(应用式内部滚动)、viewBox 裁剪焦点图右列。

## 接下来直接做

- **F2 值与未知依据**:`crates/atlas-app/src/server.rs` 的 `"source"` 分支与 `store.rs::source` 扩展受限 `start,end`(固定 blob UTF-8 字节,返回补 `file_total_bytes,start_line`);`web/app.js` 的 `renderFlow` 值行与 `renderUnknowns` 条目接 op index→`ops[].start/end`,点击在源码区滚动并高亮区间(`byteLineMap/lineOf` 已就位);覆盖长函数后部/UTF-8/无锚点/截断重试。
- 复审关注:IAB 与真实浏览器对 SVG 点击的差异;`/api/search` 的 LIKE 匹配在非 ASCII 大小写上的语义说明是否足够;`mergeFocus` 一跳过滤对递归/折叠场景的表现。
