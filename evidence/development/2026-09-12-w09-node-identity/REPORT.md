# W09：按身份取实体（打通深链接与"点不动的邻居"）

窗口：`2026-09-12/w09-node-identity`
结论：**DELIVERED**。这一轮把 Atlas 从"能画、但走不进去"变成**能走**。

## 1. 问题（上一轮实测留下的）

`/api/nodes` 按 id 排序翻页，**目录与文件在前，第一页里一个函数都没有**（500/8938，0 个函数）。
于是两件事同时坏掉：画布上未加载的邻居盒子写着"未载入本分析"、`fileId: null`、**点了没反应**；
URL 深链接也只能指向已加载页里的对象——**函数一律进不去**。
引擎里其实一直有 `Store::node(analysis, id)`，缺的是把它接到 HTTP/页面。

## 2. 交付

**`GET /api/node?entity=<引用>`**（`crates/atlas-app/src/server.rs`）：与 `reach`/`source`/`flow` 用同一套引用解析
（符号 id、`path:name`、裸名），只在这一份分析内解析，返回 `{analysis_id, node}`；契约表同步补了一条，
否则 `contract` 会与实际接口不一致。

**页面接线**（`web/app.js`）：新增 `resolveEntity()`（本地没有就问服务要，拿到后并入 `state.nodes`）与
`openUnloaded()`（点未加载盒子 → 解析 → 选中；解析不了**明说失败**，不假装打开）。
深链接（同版本分支与 relocate 分支）与焦点图盒子的点击都改走这条路径。

## 3. 验证

- **按身份取回（真实 store）**：`symbol:dist/cjs/internal/util/isFunction.js:106:176` → 返回该节点；
  `dist/cjs/internal/util/isFunction.js:isFunction` → 解析到**同一个** id；
- **深链接整条链路（真实页面截图）**：`#token=…&selection=<该函数 id>&analysis=<该分析>` 打开后
  函数被选中、右侧显示 `1 个相关对象 / 0 条调用候选 / 0 个未解析调用`、快照源码面板显示真实字节、
  中间是钉版引擎的调用视图（状态行 `引擎 布局引擎 · 交叉 0 · 标签碰撞 0`）。
  **这是"选中一个不在第一页里的函数"第一次成立**——此前无任何路径可走；
- 门禁：**25/25 检查 exit 0**，受控负对照 red（exit 1），
  指纹配对一致 `de26963356283f37f175d445579a7b892cbfcc60cbeca943a68826b99c8ee707`，`sources_changed_during_run: 0`；
- `web-behaviour` 44/44（未回退），`city3d-behaviour` 28/28。

## 4. 验证时新发现的缺陷（下一轮修）

**未命中返回的是通用错误 `{"error":"invalid_or_unavailable_query"}`，不是具名拒绝。**
按本项目一直坚持的标准，"这个实体不在这份分析里 / 名字有歧义 / 版本不同"应该各自具名，
而不是塌缩成一句话——`reach`/`source`/`flow` 也共用同一套映射，所以这是**既有缺陷**，
只是这一轮才被测到。修它会动到错误到 HTTP 的映射层，需要单独一轮 + 用例。

## 5. 没有做的事

- 仍未加 `atlas node <analysis> <id>` CLI（引擎能力已可通过 HTTP 使用；CLI 属欠账）；
- 块 × 绑定状态矩阵仍在折叠面板里，未进函数工作台主视图；
- 「167 处未知区域」仍是数字，不可点开；
- 跨分析引用只做了"不解析"，**没有**做"具名拒绝"（见第 4 节）。
