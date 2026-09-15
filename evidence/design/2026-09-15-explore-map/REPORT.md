# 探索页：项目地图与多展示区设计交付

状态：DESIGN_PROTOTYPE_CHECKED；不是产品实现验收。

用户要求的节点层级、i 三来源简介、可编辑解析、类型菜单、批注与 Agent 沟通、多区域多标签管理已整理为 [完整设计](../../../docs/design/atlas-explore-next/DESIGN.md)，并做成 [可点击原型](../../../docs/design/atlas-explore-next/index.html)。

原型使用独立的 HTML/CSS/JS 和 18 个样例节点；现有产品 web/、Rust、worker、分发包均未改。此前 atlas-v2 中尚缺脚本的 mindmap 草稿保留原样，本次另建目录，避免覆盖其他 Agent 的工作。

浏览器验证：本机真实 Chrome + Playwright，13/13 检查 PASS（exit 0），见原型目录 checks.json/check.cjs。覆盖节点定位、三来源分离、新展示区/内容视图、显式生成演示、编辑保存与刷新恢复、批注交接、类型菜单、文档章节、版本变化提示、标注版和 1280/1024/390 根页面无横向溢出。浏览器 JS 错误为 0。检查中发现搜索 Enter 会顺带触发新弹窗按钮，已通过阻止该次 Enter 默认行为修正并复验。

已人工查看主地图与双区域截图。分区时节点最低自动缩放保持可读，结构超出画布时滚动/平移；示例双区域保留项目根标签，同时聚焦 pricing 子树并阅读 charge 源码。

图片位于 docs/design/atlas-explore-next/images/：项目地图、多区域、解析记录、Agent 交接、项目菜单、区域标注及三个宽度截图。

未实现范围在 DESIGN.md 第 10 节明确列出：真实项目数据/大项目分页、模型与聊天连接、实际运行和写入、拖拽标签/分隔线等。生成和执行按钮明确为演示，不以动画或样例结果提供产品执行证据。

预览使用本次独立本地服务 127.0.0.1:8807；用户原有产品服务不受影响。原型数据仅写当前 origin 的 localStorage，重置演示可清空。
