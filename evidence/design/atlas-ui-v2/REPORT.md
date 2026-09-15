# Atlas 完整界面设计 v2 交付

本次完成设计，不实现产品功能。用户将优先级调整为完整页面、按钮和动态交互，后端按其需要补齐。设计包位于 docs/design/atlas-v2/。

产物：六页可点击原型（项目、探索、3D、运行、审阅、Agent）、27张PNG（正常/标注/动态/响应式与总览）、图集、全局设计与技术表、三份逐页面操作规格、实现提示词。当前任务书更新为v5的U1→U6，所有常用启动文档已指向同一设计；旧设计和任务书有存档。

三位设计Agent分别提供探索/运行/审阅与交接模块和规格，主Agent统一了布局、项目/函数/版本、对照输入、异常状态与新版本接续，实际检查截图并修正审阅DOM嵌套、提案布局、移动宽度和标注显示。

验证：

- `node --check` 四个JS文件（shell/explore/run/review）均 exit 0。
- `NODE_PATH=/Users/yinsijie/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules node docs/design/atlas-v2/check.cjs` 最终 **29/29 PASS，exit 0**。结果保存在设计包checks.json。
- 使用真实Chrome的点击、输入和键盘测试：导入空输入/取消、搜索及源码定位、真实页面状态切换、模拟运行/取消/授权、修改对照输入、新版本源码与漂移弹层、Agent交接文本、同提案跳转、3D文件到函数与对应运行、命令面板。
- 六页在1600、1024、390宽度均无文档横向溢出。图/长代码容器可独立滚动。已目视检查正常探索、项目、运行对照、审阅、Agent、3D及总览图。
- 新设计和当前入口文档的本地链接检查通过；`git diff --check` exit 0。

范围：所有运行、验证、时间、文件和数量都是显式标识的设计样例，原型没有调用Atlas服务、模型或运行用户代码。3D是等距SVG交互模型，正式版仍使用现有WebGL2；相机拖动、图形能力与性能不由原型取得资格。分隔条拖动、完整目录管理/取消HTTP等正式行为在规格里交付，不声称原型实现了生产能力。

本次没有修改产品Rust/worker/web源码、重建分发包或运行产品综合检查。之前产品独立复审CHANGES_REQUIRED保持原样。下一步是实现Agent按DEVELOPMENT_PROMPT.md执行U1→U6，自测与独立复审仍分开。

图片直接由HTML原型与图集渲染，无外部字体/CDN或独立生成的不一致视觉稿。可双击index.html离线打开；当前预览也可从本机 http://127.0.0.1:8768/gallery.html 访问（本机服务停止后改用文件）。
