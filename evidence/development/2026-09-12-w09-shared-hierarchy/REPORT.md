# W09：两个投影，一个层级定义（2D 正式层级 + 空间索引）

窗口：`2026-09-12/w09-shared-hierarchy`
日期：2026-09-12（Asia/Shanghai）
结论：**DELIVERED**。之前 `项目 → 目录 → 文件` 这个形式层级只活在 3D 城市里；2D 画布画的是"加载顺序里的前 12 个含函数文件"，既没有层级概念，也不知道自己在和 3D 说不同的语言。这一轮把层级抽成两个投影共用的唯一定义，并给 2D 装上真实的层级切换与空间索引。

## 1. 事实上的问题

抽取之前的状态是**每个视图各自自洽**：3D 的守恒断言全部通过，2D 的聚合也全部通过，它们只是对"什么是目录、目录一共声明了多少函数"给出两个互不相干的答案。这种漂移没有报警器——两边都不报错，只有把两张图并排看才发现。所以这一轮交付的不是新功能，而是**消除一个不可见的错误来源**，并让"只有一个定义"这件事本身可被检查。

## 2. 交付

**`web/hierarchy.js`（新，几何无关的唯一定义）**

- 身份、成员关系、被计数的事实、层级分组；**不知道**柱子、地块、像素或相机。
- `buildAtlasHierarchy`（schema `atlas.hierarchy.v1`，不可裁剪）、`atlasLevelInvariants`（重新相加，不守恒就列出字段）、`atlasLevelBlocks`（一个层级画哪些块，含 `omitted` 与 `budget` 两个分开的读数）、`atlasSpatialIndex` / `atlasIndexHit`（均匀网格，报告 `scanned` 与具名未命中）。
- `ATLAS_LEVELS` / `ATLAS_FACT_KEYS` 只在这里定义一次。

**`web/city3d.js`**

- 删掉本地那份层级实现（`buildCityHierarchy` 的函数体、层级常量、路径助手），改为 `atlas*` 的别名/委托；`cityLevelView` 现在从 `atlasLevelBlocks` 拿块集，只补几何（脚印、高度、函数层、地块打包）。
- 25 项城市行为检查在重构后**全部保持通过**，即抽取没有改变任何行为——这是"等价重构"的证据，而不是我口头保证。

**`web/app.js` + `web/index.html` + `web/style.css`**

- 2D 概览按所选层级绘制共享层级的块：`项目 / 目录 / 文件` 三个按钮，块的含义随层级改变，事实不随层级改变。
- 层级与预算分开说：`层级未展开 N 文件（不是丢失）` 是层级定义，`预算截断：文件层只画前 60 个文件（2277 中）` 是渲染预算。两个投影预算不同（2D 60、3D 400），**只有层级是共享的**，这一点在代码与文档里都写明了。
- 聚合块被明确标注为聚合，`fileId` 为 `null`：点击它不会打开其中某一个文件。
- **本页只加载了一页对象**这件事被写进状态行：`本页已加载 100/8938 对象，未加载的对象不在这个层级里`（见第 5 节，这是本轮自己发现并补上的诚实性问题）。
- 画布点选走空间索引：`levelHitAt` / `levelPickAt` 返回命中块、`scanned`、`candidates`，未命中是 `outside_the_index` / `no_block_at_this_point` 而不是 `null`。
- 层级切换**不清理焦点、不重锚选区**：焦点图存在时仍画焦点图，状态行明说"当前仍是焦点图，层级作用于概览"；未知层级被拒绝（返回 `false`），不静默强转成文件层。

**`crates/atlas-app/src/server.rs`**

- 新增 `/hierarchy.js` 路由，与其他资源共用同一个 `asset()`（继承 CSP、Host/Origin、会话令牌边界）。

## 3. 门禁

`python3 scripts/verify.py --label w09-shared-hierarchy --out evidence/development/2026-09-12-w09-shared-hierarchy --keep-going`

- **23/23 检查 exit 0**（新增 `web-syntax-hierarchy`，因为共享文件解析失败会同时打死两个页面）；
- 受控负对照 `entry-backfill-frontier` **red**（exit 1，受控）；
- 指纹配对一致 `c1fa598b4c8987f1535d258f4c9f6f11d32ec7772d6fdac75624353c6b829762`（binary == source）；
- `sources_changed: 0`、`binary_stale: false`、`document_errors: []`。

**第一次运行是红的，而且红得有价值。** 第一次运行 `fingerprint pairing` FAIL：

```
binary=b1f84a675b0fb70745d788cba3c3f75f043ca5364aa5743c30317a9f3f533c13
source=8c2690a3605bf50766cad4bbb973fc10b02fb8469dbbce9f79c13f44cd40ce51
sources_changed: 1
```

原因：我把 `web/hierarchy.js` 加进了 `scripts/verify.py` 的指纹清单，却忘了 `crates/atlas-engine/build.rs` 也有一份必须逐字一致的清单。于是"二进制自称的指纹"与"从源码算出的指纹"不再是同一个函数——正是门禁里那句"没人能核对的指纹是装饰"要抓的东西。修复是给 `build.rs` 补上同一项（`crates/atlas-engine/build.rs`），重跑后配对通过。

原始失败证据保留在 `runs/run-1-fingerprint-mismatch/`（`verification.json` + 全部日志），没有覆盖掉——一个只留绿色结果的窗口等于把"门禁真的会红"这件事也一起删掉了。

## 4. 测试增量

| 套件 | 之前 | 现在 |
|---|---|---|
| `web/tests/app.behavior.test.mjs` | 32 | **40** |
| `web/tests/city3d.behavior.test.mjs` | 25 | 25（重构后不变，即等价） |

新增的 8 项断言（关键几条）：

1. **同一份层级**：`state.hierarchy.schema === 'atlas.hierarchy.v1'`，`atlasLevelInvariants().ok === true`，且声明函数数等于三个文件之和、已加载函数数是本页真实拥有的数量；
2. **层级只改变"块代表什么"**：三次切换得到块数 `[1, 2, 3]`，而 `totals` 三次**逐字节相同**；同一对调用在文件层是画出的管道、在目录层是 `internalPairs` 里被计数的内部对——**数目没有变，变的是"这两个端点是不是两个画出来的对象"**；
3. **聚合块**：`district:lib` 的 `fileId === null` 且文案含"聚合"；只有一个文件的目录仍然 `fileId === 'file:<该文件>'`（单一来源仍可读，不被一刀切成"聚合不可读"）；
4. **空间索引**：`index.boxes === blocks.length`；`levelHitAt(100,80)` 命中第一个块并带出可打开的 `fileId`；`scanned <= boxes`；越界查询返回 `outside_the_index`；
5. **预算 vs 层级**：70 个文件时文件层画 60、`totals.files === 70`、状态行出现 `预算截断：文件层只画前 60 个文件（70 中）`；切到项目层后 `budget.files === false` 且 `enumeratedFiles === 70`（项目层不枚举文件，所以它没有可截断的东西）；
6. **不重锚**：聚焦一个函数后切层级，`state.selected.id` 不变，页面明说"当前仍是焦点图"；`setLevel('nope')` 返回 `false`；
7. **未加载子集必须自报**：当 `nodePage.total` 远大于已加载对象数时，状态行必须出现 `仅已加载子集` 与 `本页已加载 7/900 对象`；
8. **静态防漂移**：两个页面都必须先加载 `/hierarchy.js` 再加载自己的脚本，且 `app.js` / `city3d.js` 都**不得**再出现 `const ATLAS_LEVELS = [` / `const ATLAS_FACT_KEYS = [` ——这条断言防的是"下一次有人图省事又抄一份"。

`scripts/test_integration.py` 的资源断言从 `["app.js","style.css"]` 扩到 `["app.js","hierarchy.js","style.css"]`，所以"服务真的会发这个文件"由 HTTP 层证过，而不是靠路由代码看起来对。

## 5. 本轮自己发现并修掉的诚实性问题

真机截图（rxjs 分析，2D 页面）暴露了一个我本来会漏掉的问题：状态行最初写的是 `声明函数 2080`，而项目实际是 6573。原因不是算错，而是**这个页面只加载了一页对象**（100/8938），层级是在已加载子集上算的。把子集总数当成项目总数，和隐藏预算是同一类错误——数字是真的，读者得出的结论是假的。现在状态行写成 `声明函数 2080（仅已加载子集）· 本页已加载 100/8938 对象，未加载的对象不在这个层级里`，并有第 7 条断言把它钉住。

## 6. 没有做的事

- **没有**让 2D 像 3D 那样翻完所有分页再算层级。3D 会加载到 400 文件的上限，2D 仍只算已加载的一页；因此 2D 的 `项目 / 目录` 层级数字是**子集**数字，它现在会自报这一点，但"子集层级"本身仍是限制。
- **没有**给 2D 做可交互的空间布局/自动避让：空间索引只解决"这一点上是哪个块"，不解决"块怎么排更好看"。
- **没有**把层级通过 URL fragment 在两投影之间传递：选区可以传，层级还不能，所以在 3D 切到目录层再跳到 2D 会回到文件层。
- **没有**实现行级/调用级运行采样；城市里的运行信息仍是入口调用粒度。
- **没有**改动任何分析（Rust 引擎）行为：本轮只动了 UI 层、`build.rs` 的指纹清单和一处静态路由。
- 资格结论不变：W00–W10 的 qualification 仍一律 `NOT_QUALIFIED`，独立评审未做。
