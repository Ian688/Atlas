# 探索代码：项目地图与多展示区

[打开可点击设计](index.html) · [完整功能与实现说明](DESIGN.md) · [交给开发 Agent 的详细提示词](DEVELOPMENT_PROMPT.md)

默认从项目根地图开始，逐层展开目录、文件、函数或文件内容。每个节点提供简介和按类型变化的操作菜单；多个展示区分别放自己的节点标签，方便同时保留项目全貌、源码和关系。

试用顺序：点 charge() 的 i → 阅读三种解释来源 → … 在新展示区打开 → 切换“内容” → 编辑解析并保存 → 写批注并创建 Agent 交接草稿。

[项目地图](images/01-project-map.png) · [多个展示区](images/02-multiple-areas.png) · [解析记录](images/03-explanation-record.png) · [Agent 交接](images/04-agent-handoff.png) · [标注版](images/06-annotated.png)

这是新设计提案，不改现有产品。目录中所有项目、模型回复、运行和补丁都为交互示例。旧 `atlas-v2/explore-mindmap*` 草稿保留原样，不叠加为本稿的限制。

运行：`python3 -m http.server 8807 --bind 127.0.0.1 --directory docs/design/atlas-explore-next`，然后打开 `http://127.0.0.1:8807`。

浏览器检查见 `checks.json`；检查脚本 `check.cjs` 需要本机 Chrome 与 Playwright，使用 `NODE_PATH` 指向已安装依赖。
