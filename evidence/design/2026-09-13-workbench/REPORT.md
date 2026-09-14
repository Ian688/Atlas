# Atlas 前端设计检查

日期：2026-09-13。范围：设计原型、渲染版面、操作状态与只读 API 接线审查。未修改产品源码、未运行目标项目、未测试 Atlas 产品接口。原有未提交文档保留并在其上补充设计入口。

## 交付

- `docs/FRONTEND_DESIGN.md`：空间分配、2D 图显示模型/渲染、值与未知、运行、审阅、3D 和状态恢复。
- `docs/FRONTEND_API_CONTRACT.md`：实际接口字段与缺口；拟议项明确标注。
- `docs/design/workbench-prototype.html` 与 `workbench-preview.html`：可点击设计；全部非源码数据为样例。
- `docs/START_FRONTEND_AGENT.md`：从 F1 直接开工的独立交接。

## 设计迭代

v1 原型在浏览器通过基本操作后，主代理看图发现窄屏未知节点与图例重叠、代码区截图被 iframe 裁白，已修正图例留白和截图高度。连线改为独立端口。原图和检查保留于 `iterations/v1/`。

独立审查 Agent 只读核对现有后端，并检查第一版截图，提出：运行高亮会被误读成执行覆盖；审阅 expected/actual 混用；参数只有数组编辑；切换丢草稿；窄屏源码挤压。处理如下：

- 运行展示结果不再高亮分支；定位与执行证据分开。
- 报告明确共同输入、独立预期、基线/候选实际结果，未跑显示未运行。
- 参数名表单与高级数组共用草稿，切任务保留草稿和结果。
- 窄屏源码移至下方，正式设计补扩大阅读/分隔调整/长行处理。
- 补结构定位草图并验证共享选择。

主代理重新查看最终关系、运行、审阅、结构、窄屏截图。主体版面可作为实现基线；3D 仅确定结构空间方向，用户易用性和真实数据密度仍需产品接线后验证。

## 已执行检查

```sh
python3 /Users/yinsijie/.codex/plugins/cache/openai-bundled/visualize/1.0.37/skills/visualize/scripts/render.py docs/design/workbench-prototype.html docs/design/workbench-preview.html --force
NODE_PATH=/Users/yinsijie/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules node docs/design/check-prototype.cjs
```

两条命令最终退出码均为 0。浏览器使用本机 Google Chrome，Playwright 真正点击设计页面。

[prototype-checks.json](prototype-checks.json)：19 项通过，page_errors 为空。覆盖图点击与返回、来源高亮、未知定位、搜索空结果、JSON 错误、参数/任务切换草稿、返回/异常/拒绝/超时/取消版式、审阅预览/撤销、源码开合、1440/1024/768/390/320 宽度无横向溢出与结构共享选择。深色主题另截图检查。这不证明缺失的 API 已实现。

## 看图

- [调用关系](01-understand.png)
- [值来源](02-values.png)
- [未知边界](03-unknowns.png)
- [运行表单与结果](04-run.png)
- [审阅报告](05-review.png)
- [1024 宽度](06-width-1024.png)
- [390 宽度](06-width-390.png)
- [深色主题](07-dark.png)
- [结构空间草图](08-structure.png)

## 交给实现者的断点

先做主设计 F1：真实函数查找、共享选区与独立加载的关系/源码，随后 F2/F3 完成理解到运行。搜索、源码区间、receiver/globals、取消、网页补丁验证的现有缺口见接线表。不要把这些设计产物登记为 T1/T2/T3 已实现；产品资格和独立验收保持原状态。
