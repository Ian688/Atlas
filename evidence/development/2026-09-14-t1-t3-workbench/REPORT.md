# Atlas 阶段交付 — 正式前端 T1→T2→T3(F1–F5)

日期:2026-09-14。状态:NEEDS_INDEPENDENT_REVIEW(自测通过,待独立复审)。
基线 HEAD `cca8fcf`;本报告覆盖 2026-09-14 的两次交付窗口(早前 T1 窗口的报告见 `evidence/development/2026-09-14-f1-workbench/REPORT.md`,其内容已被本窗口包含并超越)。

## 用户结果

按 [前端主设计](docs/FRONTEND_DESIGN.md) F1–F5 与 [API 接线表](docs/FRONTEND_API_CONTRACT.md),沿现有 Rust/HTTP/JS 链路交付了正式工作台;原型只作视觉基线,其样例函数名、关系、返回值、验证状态均未进入生产逻辑。

- **F1 工作空间与真实选择**:顶栏(项目/分析版本/状态/3D 入口/连接会话)、左侧服务端搜索(`GET /api/search`,按文件分组、匹配总数与分页如实报告、空/失败/重试分明)、四个任务页签+理解三镜头、旁侧源码区、底部细状态。旧首屏 hero/指标卡/五件事/五步引导全部删除。关系图为一跳上游+下游合并视图(in/out 分别请求,按 edge id 去重),未解析目标为虚线边界桩。返回栈+最近列表。
- **F2 值与未知依据**:`/api/source` 受限 `start,end` 字节窗口(限定对象自身跨度,补 `file_total_bytes`/`start_line`,UTF-8 边界对齐)。值来源行(返回语句/绑定定义/调用点)与未知条目按真实 op 字节锚点可点击定位:窗口加载、行号渲染、高亮、滚动、"显示完整对象"还原;无锚点的未知如实写"无单一源码锚点"。项目诊断未知打开文件并定位到真实区间,不再只打印字节数。
- **F3 运行闭环**:运行页签参数化表单——按画像 `params[]` 逐参数 JSON 输入+「JSON 数组编辑」高级模式(共用一份按选区保存的草稿);画像声明 `this_arg`/`globals` 时按缺项逐项出现输入,HTTP `ExecRequest` 接通并记录进发布 spec;无类型/默认值证据不生成占位。结果结构化(目标+版本/实际输入/verdict/返回或异常/耗时退出码/观测边界/授予边界);预检拒绝显示为拒绝且保留输入;历史记录列表可"重填输入(不自动运行)";取消按钮不出现(服务端无取消路由)。
- **F4 审阅修改**:`POST /api/patch/verify {id}` 入队 `patch_verify` 作业并由服务端进程内以同一 `verify_proposal` 路径执行(`GET /api/patch/verify?id=` 状态查询;服务端独占执行参数,页面不能提交 shell 字符串)。页面:proposed+校验通过的提案出现"验证"按钮,轮询按提案 id+选区 generation 双重核对;验证后提案转 verified 并显示图差异(变更/新增/删除节点、未解析调用前后)与"没有跑任何测试。这不是通过。"(test.ran:false 如实);应用/撤销仍受 `--allow-writes` 边界,页面不能指定目录。
- **F5 连续工作与结构联动**:选区/分析版本、当前页签与镜头持久在 URL fragment;2D↔3D 投影链接携带选区+会话令牌+任务状态(fragment 是令牌唯一传输通道,消费页立即剥离);往返后同一对象、同一任务,3D 侧"共享选区"注明,跨版本选区拒绝与 2D 侧重定位均为既有路径(有测试)。

## 关键修复

- **引擎**:`external_names` 扣除已知局部绑定——简写属性读取(`return { written, receipt }`)曾被 `read_external` 化,导致 redeem 画像把局部变量报成 `required_globals`(页面会要求用户"声明"局部变量)。
- **消费错误**(接线表 §4 全项):API 错误体解析;patches/annotations generation 守卫;source/reach 独立加载;提案/选区竞态;未知真实定位;/api/contract 文案随能力同步(验证已是页面动作)。
- **前端真实 bug**:侧栏重渲染替换节点打断点击(签名守卫);外壳高度约束(返回按钮曾被推出视口);viewBox 硬编码裁掉焦点图右列。

## 实际验证

| 命令或浏览器操作 | 最终退出码/结果 | 证据 |
|---|---|---|
| `python3 scripts/verify.py --label t1-t3-workbench-complete --out evidence/development/2026-09-14-t1-t3-workbench --keep-going` | **PASS,exit 0**(全套:rust、worker、integration、execution、patch、bridge、web/city3d、whitespace、negative-control、指纹配对) | `evidence/development/2026-09-14-t1-t3-workbench/` |
| `node web/tests/app.behavior.test.mjs` | exit 0,**63/63**(本窗口新增 15 项:F1 关键核对 7、F2 锚点 4、F3 表单 4;另 F4 验证 3、F5 fragment 持久化 1 及既有用例随交互更新) | 同上 verification.json |
| `node web/tests/city3d.behavior.test.mjs` | exit 0,28/28 | 同上 |
| `cargo test --workspace --locked` | exit 0(新增 search 分页/游标绑定/通配符字面测试) | 同上 |
| 浏览器 F1:搜索非首屏函数、邻居导航、未解析桩、返回、快速 A→B 无串对象(截图) | 通过 | `evidence/development/2026-09-14-f1-workbench/screenshots/` |
| 浏览器 F2:未知条目→高亮 `for (const item of order.items) {`(L21);绑定 written→`let written = 0;` | 通过 | 会话记录 |
| 浏览器 F3:validate 运行 returned/true;redeem 运行 returned 98ms 完整对象;空参数内联错误且 0 请求;历史重填不自动运行 | 通过 | 会话记录 |
| 浏览器 F4:登记真实 diff 提案→页面验证→verified+图差异(变更 4/新增 2/删除 2)+"没有跑任何测试" | 通过 | 会话记录 |
| 浏览器 F5:validate+值从哪来 → 3D(共享选区)→ 返回链接(mode/lens/token)→ 2D 恢复同一选区+镜头+flow 可见 | 通过 | 会话记录 |
| `git diff --check` | exit 0 | — |

浏览器环境说明:本会话内置浏览器(IAB)对页面输入不稳定——HTML 按钮可真实坐标点击(CUA),SVG 节点与部分会话需页面内 `MouseEvent('click')`(同一监听器路径),已双路径交叉验证。**事故与恢复**:一次脚本错误把 city3d.js 内容写入了 web/app.js;因工作区未提交,从 cargo 目标文件(`deps/*.0bcuv3x.rcgu.o`,include_str 嵌入的最后一次好构建)中完整提取恢复,并重放其后的单个编辑;恢复后 63/63 检查通过。

## 接下来直接做

- 独立复审:重点核对引擎 `external_names` 修复在其他样本(calculator、flow-lab)的影响面、`/api/patch/verify` 的服务端参数边界、以及真人浏览器中的 SVG 点击与往返体验。
- 后续候选(未承诺):F4 的共同输入前后运行对照(需两次真实运行关联)、F5 相机/折叠的跨会话持久、`/api/exec` 异步取消(接线表 F3 后续,需后端先行)。
