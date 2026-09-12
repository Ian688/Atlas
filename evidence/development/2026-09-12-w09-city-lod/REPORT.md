# W09：3D 的正式层级与 LOD（LOD 不改变事实数量）

窗口：`2026-09-12/w09-city-lod`
日期：2026-09-12（Asia/Shanghai）
结论：**DELIVERED**。`/city3d` 不再是"一张固定的图"，而是**一个不可裁剪的模型 + 每个层级一张视图**；工作单要求的"LOD 不改变事实数量"从承诺变成可失败、可显示的检查。

## 1. 之前是什么样

城市只有一种画法：顶层目录 = 地块，文件 = 柱体，函数 = 柱内层（上限 18），调用候选 = 地面管道。`state.mode` 会在相机靠近时从 `file` 切到 `function`（把柱体拆成函数层），但：

- 没有形式层级：project / district / file 的关系只存在于渲染代码的分组里，没有一个数据结构能回答"这个目录声明了多少函数"；
- 没有"层级"这个概念：相机距离既决定细节又隐含层级，且切换没有任何可检查的性质；
- 事实与渲染混在一起：`stats` 里既有 `files`（全部）又有 `shownFiles`（画出的），但没有任何机制保证"聚合"与"明细"一致。

## 2. 现在是什么样

### 2.1 模型：`buildCityHierarchy`（`atlas.city-hierarchy.v1`）

不可裁剪的形式层级 `project → district → file`，每个节点带同一组事实：`files / declaredFunctions / loadedFunctions / analyzedFiles / unanalyzedFiles / unresolvedCalls / callSites`。

- **目录与项目的数字是子节点的和**，不是在别处另记一份：调用只记在"发出它的文件"上，然后逐层相加。
- 结构里**没有任何渲染预算**：`maxFiles`/`maxPipes` 只出现在视图函数里，出现不了这里。
- 是纯数据（普通对象，不是 `Map`），能跨 JSON 边界，所以检查可以在没有 GPU 的地方跑。

### 2.2 视图：`cityLevelView`（`atlas.city-layout.v1`）

同样的层级，三种画法；三者共用同一个打包函数（`cityPackPlates`），所以粗层级不可能悄悄得到与文件层级不同的重叠行为：

| 层级 | 画什么 | 管道 | 不画什么（并且说出来） |
|---|---|---|---|
| `project` | 1 个地块 + 1 根聚合柱体 | 无（项目内部调用在一层里没有两个对象可连） | 逐文件柱体、函数层 |
| `district` | 每个目录 1 个地块 + 1 根聚合柱体 | 跨目录调用 | 逐文件柱体、函数层；**同目录内部调用**计入 `internalPairs` |
| `file` | 今天的样子：每文件一根柱体、函数层、文件间管道 | 文件间调用 | 超过 `maxFiles` 的文件（按预算，并报出 `omitted`） |

柱高在所有层级都是同一公式 `CITY_BASE_H + max(declared,1) * CITY_SLAB_H`：聚合柱体的高度就是它组成部分的高度和，与"高度来自引擎声明的函数数量"这条约定一致（不做视觉缩放）。

### 2.3 承载断言：`cityLevelInvariants`

对每个事实逐层重加，**只有 `project == Σdistrict == Σfile` 才算守恒**：

```js
{ schema:'atlas.city-level-invariants.v1', ok, checked:[7 个事实],
  totals, violated, violations:[{key, project, districts, files}] }
```

- 每个视图都带 `invariants`，页面上一行显式显示 `层级聚合守恒 ✓`；不守恒时列出字段名。
- 这条检查**能失败**（见 §4 的用例）：把 `totals` 改一个数，`ok` 必须变 false。一个不会失败的守恒检查不是证据。

### 2.4 层级省略 ≠ 预算截断

两种"没画出来"必须分开说，否则读者会把"这一层不画函数层"读成"函数丢了"：

- 层级省略：`本层级不画函数层与逐文件柱体：这是层级定义，不是渲染预算`；
- 预算截断：`truncated.{files,pipes,slabs}` 与 `omitted.{files,functions}`，以及 `已按预算截断：文件`。

### 2.5 聚合柱体永不冒充文件

- 柱体带 `aggregate`（代表 >1 个文件）、`filePaths`、`slabDetail`（能否展开函数层）三个不同含义的标记；
- `citySelectionQuery(aggregate) === null`：没有单一源码可读，检查器不会声称一个目录是文件；
- **恰好一个文件**的目录在这个层级"就是那个文件"：`file_id` 指向真实文件，源码照常可读（一个文件不是聚合）；
- 粗层级的柱体在**任何相机距离**都画成实心块（`slabDetail=false`）。否则靠近时它会退化成底板，层级在你想仔细看它的时候消失；
- 共享选区落到粗层级：命中**真实对象**（2D 里选的函数/文件），高亮代表它的聚合柱体，并写明"当前层级（目录）里它由聚合柱体代表，未做精确高亮"；过期版本照旧**先拒绝**（`stale_selection_version`），层级处理不削弱这条规则；
- 运行标记按 `filePaths` 落在聚合柱体上，记录仍然指名真实文件，观测行写明"这是聚合，不是'整个目录都跑过'"。

### 2.6 层级切换是纯函数

`cityLevelSwitch(state, level, options)` 只返回状态转移：新视图、按新布局**重新推导**的观测标记、命中的柱体、以及丢失的选区。它不碰 DOM、不碰 GL，所以能在没有 GPU 的测试里驱动。`setLevel` 只把结果推给场景。选区在层级之间**保留的是对象**（`selectedFile`），不是恰好代表它的那个聚合：切换回去仍然高亮原来的文件；层级画不出它时（文件层级有预算上限）如实取消高亮并说出是哪个对象。

## 3. 顺带修掉的一个真实缺陷

`opts.maxFiles || CITY_MAX_FILES` 把**显式的 0** 当成"没给"，于是"什么都不画"变成"全画"——这正是"预算必须被报告而不是被吞掉"的反面。现在 `0` 是预算（`=== undefined` 才用默认），并且有用例锁住：`{maxFiles: 0}` 时 `shownFiles === 0`，而 `declaredFunctions` 仍然是全部分析的事实（`空画面不是空分析`）。

## 4. 验证

`python3 scripts/verify.py --label w09-city-lod --out evidence/development/2026-09-12-w09-city-lod --keep-going`

- **22/22 检查 exit 0**；受控负对照 red（`ATLAS_FORCE_ENTRY_BACKFILL=1` → exit 1）；指纹配对一致 `16a6bf68c9dcf05669f34e487acd679cd1f38a52e9b80ab54a2c86b82ca53259`；`sources_changed_during_run: 0`。

`web/tests/city3d.behavior.test.mjs` **17 → 25**（新增 8 条，全部在 `node:vm` + 最小 DOM 里跑真实的 `web/city3d.js`，不需要 GPU）：

| 用例 | 断言的是 |
|---|---|
| the hierarchy survives a bounded file budget | 预算只改"画什么"：`files`/`declaredFunctions` 与预算无关；`maxFiles: 0` 时 `shownFiles=0` 而声明总数不变；`invariants.ok` 仍为真 |
| every level aggregates to the same facts | 三个层级的事实**完全相等**（declared/files/unresolved/analyzed/loaded），而画出的柱体数分别是 1 / 3 / 更多 |
| a coarse level reports the facts it did not draw | 未解析调用与未分析文件在所有层级都一样；同目录内部调用在目录层级被**计数而不画**（`internalPairs=1`、`pipes=0`）；聚合柱体 `aggregate=true`、`citySelectionQuery` 返回 `null`；层级行写明"层级定义，不是渲染预算" |
| a level view cannot disagree with the hierarchy | 故意把 `totals` 改错，守恒检查必须 `ok=false` 并报出字段（声明函数与未解析调用各一次）；未捕获文件不计入已分析 |
| a run marker at a coarse level is placed, and named as an aggregate | 标记落在 `district:src` 上、记录仍指 `src/a.js`、`aggregated=1`、观测行写明是聚合 |
| a selection at a coarse level names the file and admits the aggregation | 命中聚合柱体但保留 `file_path`；过期版本仍先拒绝；不在分析里的实体仍拒绝 |
| a coarse block is drawn, and a one-file district is still that file | 粗柱体在近景仍是实心块；单文件目录 `aggregate=false` 且源码可读；文件层级 `slabDetail=true` |
| switching level keeps the object, re-derives the markers and never re-anchors | 选区在层级间保留对象；标记按新布局重推；被预算隐藏时 `lost` 指名对象；没有层级时拒绝 `no_layout` |

## 5. 没有做的事（不得读成已实现）

- **"激活路径来自 Run"仍然画不出来**：Atlas 只有入口调用的观测（返回/抛出、退出码），没有行级或调用级采样。城市里的运行信息仍然是"哪些入口被跑过"，不是运行路径。观测行明确这样写。
- 相机驱动的细节切换（远 = 整柱、近 = 函数层）仍在，它与正式层级是两件事：前者决定"同一个文件画多细"，后者决定"什么算一个对象"。两者同时存在，UI 上分别显示。
- 2D 画布没有引入正式层级：它仍按 12 文件 / 每文件 20 函数的可读性预算绘制。
- 聚合柱体没有做视觉上的"碎裂/展开"动画；层级切换是重建实例列表，不是逐帧插值。
- 大项目的空间索引、交互式布局仍未实现：文件层级仍是 `maxFiles=400` 的货架打包。
- 浏览器里没有跑过真实 GPU 帧（行为测试覆盖映射与状态转移，不覆盖渲染管线）；WebGL2 缺失时的提示路径有测试。

## 6. 复现

```bash
node --check web/city3d.js
node web/tests/city3d.behavior.test.mjs      # 25 checks
python3 scripts/verify.py --label w09-city-lod \
  --out evidence/development/2026-09-12-w09-city-lod --keep-going
```

页面上：`/city3d` 工具栏的「项目 / 目录 / 文件」按钮（或键盘 1 / 2 / 3）切换层级；覆盖栏下面一行显示当前层级、声明函数数、柱体数，以及聚合是否守恒。
