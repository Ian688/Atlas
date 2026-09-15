# Atlas 设计入口

从 [产品设计](../PRODUCT_DESIGN.md) 了解功能与交付路线。当前探索页使用 [项目地图设计](atlas-explore-next/DESIGN.md) 和 [可点击原型](atlas-explore-next/index.html)。

[六页设计包 v2](atlas-v2/README.md) / [图集](atlas-v2/gallery.html) 仅用于其他现有页面的背景参考。下面的旧工作台原型也仅作历史参考。

# 工作台原型

- 双击 [workbench-preview.html](workbench-preview.html) 查看完整页面；不需要 Atlas 服务。
- [workbench-prototype.html](workbench-prototype.html) 是可交互原型片段，供对话预览和设计修改；preview 是生成的独立预览。
- [主设计](../FRONTEND_DESIGN.md)、[接线表](../FRONTEND_API_CONTRACT.md)、[实现提示词](../START_FRONTEND_AGENT.md) 指导产品接线。

源码节选来自 `examples/tour`；关系/画像/结果均是显式标注的样例，原型不会索引、运行用户代码或写入补丁。结构页是 2.5D 空间草图；正式 WebGL 材质、管道、相机和大图性能尚未由它验证。

设计交互检查：本地需 Node、Playwright 与 Chrome/Chromium。`NODE_PATH` 指向含 playwright 的包目录，`ATLAS_DESIGN_CHROME` 可指定浏览器可执行文件。

```sh
NODE_PATH=<含playwright的node_modules目录> ATLAS_DESIGN_CHROME=<浏览器可执行文件> node docs/design/check-prototype.cjs
```

检查产物见 [设计验证目录](../../evidence/design/2026-09-13-workbench/REPORT.md)。这些是设计检查，不代替生产工作台 E2E。若重新运行需保留上一设计版本的截图/结果，再产生新结果。

当前 preview 由 visualize 技能的 render.py 从片段生成，已经包含预览壳，可直接分发给执行 Agent；无需安装技能才能查看。修改片段后在原环境重新生成对应 preview，避免两份不一致。
