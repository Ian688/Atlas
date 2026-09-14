# Atlas 阶段交付 — T1:理解并运行函数(F1+F2+F3)

日期:2026-09-14。状态:NEEDS_INDEPENDENT_REVIEW(自测通过,待独立复审)。

## 用户结果

- 任务:任务书 T1「理解并运行一个函数」,按主设计 F1→F2→F3 三个切片交付,原型只作视觉基线,全部接线真实接口。
- 现在能完成(入口:`scripts/demo.sh` 打印的地址):
  - **F1 工作空间**:新工作台骨架(顶栏/左侧查找/中央任务区/旁侧源码/底部状态);旧首屏 hero、指标卡、五件事卡片、五步引导全部删除。左侧为服务端搜索(`GET /api/search`),按文件分组、报告匹配总数与截断,空结果与失败分别呈现并可重试。四个任务页签(结构定位/理解代码/运行验证/审阅修改)+理解三镜头(调用关系/值从哪来/未知边界)。关系图为一跳上游+下游合并视图(此前只有下游),未解析目标为虚线边界桩。返回按钮+最近列表,返回恢复对象与镜头。
  - **F2 值与未知依据**:`/api/source` 支持受限 `start,end` 字节窗口(限制在对象自身跨度内,补 `file_total_bytes`/`start_line`,UTF-8 边界对齐,越界拒绝)。值来源行(返回语句/绑定定义/调用点)与未知条目可点击,真实加载窗口并按行号渲染+高亮+滚动;无源码锚点的未知如实说明,不再只打印字节数。项目诊断未知打开文件并定位到真实字节区间。
  - **F3 运行闭环**:运行页签为参数化表单——按画像 `params[]` 逐参数 JSON 输入,「JSON 数组编辑」高级模式共享同一草稿;草稿按选区保存互不覆盖。画像声明 `this_arg`/`globals` 时按缺项逐项出现输入(数据输入,不扩大任何授权);HTTP `ExecRequest` 接通 `this_arg`/`globals` 并记录进发布 spec。结果结构化:目标+分析版本/实际输入/verdict/返回值或异常/耗时退出码/观测边界/授予边界;预检拒绝显示为拒绝(无进程启动),输入保留。运行历史列表可「重填输入(不自动运行)」。取消:服务端无取消路由,页面不显示取消按钮(诚实边界)。
  - 快速 A→B 切换:A 的迟到源码/提案/画像/运行结果不会出现在 B 上(每个资源按 select generation+实体 id 双重守卫)。
- 剩余:T2(F4 审阅修改)、T3(F5 连续工作/3D 结构定位)未开始,按任务书接续。

## 关键引擎/服务端修复

- **引擎**:redeem 等函数的画像把局部变量(written/receipt)误报为 `required_globals`——简写属性读取 `return { written, receipt }` 被下层标为 `read_external`。`exec.rs::external_names` 现在扣除 `binding_names` 中的已知局部/参数名,页面不再要求用户"声明"局部变量。
- **服务端**:`/api/search`(query.rs+server.rs,LIKE+json_extract+稳定排序+cursor 绑定查询);`/api/source` 窗口(`store.rs::source_window`);`ExecRequest` 接 `this_arg`/`globals`(server.rs)。
- **前端消费错误**(接线表第 4 节):API 错误只显示状态码丢 body;patches/annotations 无 generation 且失败当空;source/reach Promise.all 连坐;提案与选区竞态;未知只打印字节。
- **前端真实 bug**:侧栏重渲染替换节点打断点击(签名守卫);外壳无高度约束把返回按钮推出视口(应用式内部滚动);SVG viewBox 硬编码 800 裁掉焦点图右列。

## 实际验证

| 命令或浏览器操作 | 最终退出码/结果 | 证据 |
|---|---|---|
| `python3 scripts/verify.py --label t1-f1f2f3 --out evidence/development/2026-09-14-t1-f1f2f3 --keep-going` | **PASS,exit 0**(rust-format/clippy/tests、worker、integration、execution、patch、bridge、web/city3d behaviour、whitespace、negative-control、指纹配对) | `evidence/development/2026-09-14-t1-f1f2f3/` |
| `node web/tests/app.behavior.test.mjs` | exit 0,**59/59**(F1 新增 7 项:F1 关键核对;F2 新增 4 项:锚点定位/无锚点说明/窗口失败保留旧视图/诊断定位;F3 新增 4 项:逐参数+receiver+globals 提交、无效输入不发请求、无需求不出输入框、历史重填不自动运行) | 同上 |
| `cargo test --workspace --locked` | exit 0(新增 search 分页/游标绑定/通配符字面测试) | 同上 |
| 浏览器:搜索 write/dispatch(非首屏)→选中;邻居导航 redeem→dispatch;未解析桩呈现;返回按钮;快速 onlyPositive→total 无串对象;镜头值/未知真实事实 | 通过(CUA 真实坐标点击 + 页面内 click 事件双路径) | 截图 `evidence/development/2026-09-14-f1-workbench/screenshots/f1-focus-graph.png` |
| 浏览器 F2:redeem 未知 `unmodeled_construct:for_in_of_element_unknown` 点击 → 高亮第 21 行 `for (const item of order.items) {`;绑定 written 点击 → 高亮 `let written = 0;` | 通过 | 本报告会话记录 |
| 浏览器 F3:validate 表单运行 → returned/返回值 true;redeem 运行 → returned 98ms 返回完整对象;清空参数 → 内联错误指名参数且 0 请求;历史重填恢复输入不自动运行 | 通过 | 本报告会话记录 |
| HTTP:globals 声明进入发布 spec;越界源码窗口 400;search 游标绑定查询 | 通过 | 本报告会话记录 |
| `git diff --check` | exit 0 | — |

浏览器环境说明:本会话的内置浏览器(IAB)对页面合成输入不稳定——HTML 按钮可真实坐标点击,SVG 节点与后期会话需页面内 `MouseEvent('click')`(同一监听器路径);已用两种路径交叉验证。真人浏览器复核留给独立评审。

## 接下来直接做

- **T2 / F4 审阅修改**:复用现有 `renderPatches`/`proposePatch`/`writePatch` 与 `/api/patch/*`;按主设计 §5 补网页触发验证(接线表"拟议 `POST /api/patch/verify`",首片可只做静态验证 `test.ran:false`)与四块报告版式(说明+diff/静态变化/测试对照/应用区)。
- **T3 / F5**:恢复(关闭重开)+2D/3D 选区往返;结构定位页签接 `city3d`。
- 复审关注:引擎 `external_names` 修复对其他样本(examples/calculator、flow-lab)的影响面;IAB 与真人浏览器的 SVG 点击差异;`/api/search` LIKE 对非 ASCII 的匹配语义说明。
