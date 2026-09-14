# Atlas 首版本地交付报告(D0→D4)

日期:2026-09-15。状态:`NEEDS_INDEPENDENT_REVIEW`(自测与真机旅程通过,待独立复审)。
基线:HEAD `cca8fcf0` + 工作区既有未提交实现;本轮新增改动见"改动清单"。

## 用户结果(对照 START_DELIVERY_AGENT.md 完成线)

- **D0 修复已有阻断**:独立复验报告的 R1–R4 全部修复并经真实浏览器探针确认(9/9 PASS,修复前 3 FAIL 证据保留):
  - R1 验证切换卡死:`startVerify` 的全局互斥在轮询退出时不清除,切走再回来后无法再验证。改为**按提案轮询**(verifyPolls 映射),轮询跟踪服务端作业、与选区解耦,结束/超时(150 次×2s 上限)必清理;切走再返回、失败、重试全覆盖。
  - R2 全局依赖漏报:根因在语言 worker——简写属性 `{ written }` 的读取用 `getSymbolAtLocation` 解析到**属性符号**,局部读取被误判 `read_external`;此前 profile 层按"函数内同名绑定"一刀切扣除,又把块内 `let CONFIG` 遮蔽的全局读漏掉。修复:worker 对 shorthand 属性改用 `getShorthandAssignmentValueSymbol`(符号级精确解析),engine 撤销按名扣除。shadow 样本现在如实报 `required_globals=['CONFIG']`,coupon 简写不再误报。
  - R3 验证身份不一致:验证的持久身份固定为 (owner, analysis, proposal id);客户端自定义 request_key 不再参与身份(serde 忽略),提交/重试/查询收敛到同一作业行。
  - R4 连线错位:`graphNode` 的 x 是矩形左缘而 `drawFocusPlan` 传中心点,盒子被画到端口右侧半宽。统一为左缘;新增真实 SVG 几何断言(每条边起止点都落在某盒边界上)。
- **D1 完成 T1**:查找(服务端)、关系/源码/值/未知联动、参数与所缺条件配置(this/globals)、真实运行、历史对照(历史行含 verdict/返回值/实参,两次运行同屏可对照)。之前窗口已交付,本轮补历史行返回值显示并回归。
- **D2 完成 T2**:多行 diff 以行级增删视图呈现(+/−着色、行号、换行、600 行显示上限明示);图差异列出新增/删除/变更对象(基线可解析的对象可点击定位);新增 `POST /api/exec-compare`——同一输入在基线分析与验证派生的补丁分析上各做一次真实隔离运行,结果并排、双侧版本身份固定,拒绝原因如实显示(如缺 unknown_calls 授权);应用/撤销走既有 `--allow-writes`+逐字目录校验,已做真实字节验证(apply 后 `>= 0` 落盘、revert 后恢复 `> 0`),页面说明"当前仍读基线分析,重新索引后指向新版本"。
- **D3 完成 T3**:启动入口接受项目路径(dist `start.sh <项目路径>`);索引期 Ctrl-C 即取消(pty 实测 SIGINT → exit 130,服务与临时副本干净退出);重开浏览器后 localStorage 本机会话自动重连,选区/页签/镜头( fragment)与运行草稿(localStorage)全部恢复;分析版本变化走既有 relocate/拒绝路径。2D/3D 往返保留对象与版本(实测 fits→3D→返回)。
- **D4 本地交付**:`bash scripts/dist.sh` 产出 `dist/atlas-local-darwin-x64/`(35MB):atlas 二进制(网页资源已内嵌)、workers/(worker.mjs+src+typescript 5.9.3 闭包)、`start.sh`、`README.md`。已从 `/tmp` 仓库外位置启动并在 tour 与不同结构临时项目(/tmp/journey/project,嵌套 utils、对象/默认参数)走通完整旅程;Node ≥18 检查给准确安装指引;无需 Cargo/Python/仓库 cwd。

## 真实浏览器旅程记录(Chrome,IAB 自动化;SVG 节点以页面内 click 事件驱动,HTML 控件为真实坐标点击)

不同结构临时项目(/tmp/journey/project,交付物从 /tmp 启动):
1. 搜索 `fits`(非首屏)→ 选中,标题/源码联动;焦点图显示邻居 `area`,点击切到 area,源码跟随。
2. 运行页签:fits(对象参数)两次运行 → `true`/`false`,历史两行含实参+返回值可对照。
3. 多行 diff 提案(scale 加 Math.round 三行)→ 校验通过 → 页面验证 → verified(变更节点 3)。
4. 前后对照:输入 `[{width:3.333,height:2},"0.1"]` → 基线 `{width:0.3333…,height:0.2}` vs 补丁 `{width:0.33,height:0.2}`,版本固定 00bc3099/99de1e54。
5. 应用 → 磁盘 geo.js 变为多行 Math.round 版本(字节验证);撤销 → 恢复单行原版(字节验证)。
6. 关闭重开:刷新页面自动重连,scale 选区+审阅页签恢复。
7. fits → 3D(共享选区注明)→ 返回 2D(fits 恢复+源码加载)。

tour 项目(交付物从 /tmp 启动):redeem 搜索/选中/运行(returned,109ms,完整返回对象)。另有更早窗口的 tour 全旅程记录(F1–F5)。

## 验证与退出码

| 检查 | 结果 |
|---|---|
| `python3 scripts/verify.py --label d0-d4-first-local-delivery --out evidence/development/2026-09-15-d0-delivery/verify --keep-going` | **PASS,exit 0**(中途一次 rust-clippy exit 101——exec_compare 闭包所有权与未读字段——已修,复验 PASS) |
| `node web/tests/app.behavior.test.mjs` | exit 0,66/66(新增:R4 坐标、R1 轮询解耦、D2 对照/可读 diff、D3 草稿持久化) |
| `npm test --prefix workers/typescript` | exit 0,28/28(新增 2 项 R2 回归:简写局部读取、块内 let 不遮蔽全局) |
| `cargo test --workspace --locked` | exit 0 |
| `node evidence/development/2026-09-15-d0-delivery/probe.cjs`(NODE_PATH 指向 playwright) | exit 0,9/9(修复前同 probe 3 FAIL,证据 `results-before-fix.json` 与 screenshots/) |
| 应用/撤销字节检查(grep 落盘内容) | 通过 |
| 交付物从 /tmp 仓库外启动 + /api/report 200 + /api/exec verdict=returned | 通过 |
| `git diff --check` | exit 0 |

## 已知限制(如实)

- 运行对照的补丁侧需要该提案先完成隔离验证;未验证/已应用的提案不提供对照(接口 409 并给原因)。
- 补丁侧"新增对象"只存在于补丁分析,当前工作台读基线分析,故仅列出并标注,不可点击定位。
- 页面触发验证不运行测试命令(无操作者声明的测试配置);`test.ran:false` 如实呈现。取消:索引期 Ctrl-C 已验证;HTTP 无运行中作业取消路由(后端能力未建,页面不显示取消按钮)。
- 平台:本轮在 macOS x64(darwin-x64)验证;其它平台未验证。
- 会话令牌保存在本机 localStorage 以支持重开恢复;它只属于 127.0.0.1 本机 origin,不进入任何外发请求(与启动 URL fragment 同一边界)。

## 接下来直接做

- 独立复审:R2 修复的符号解析在更大样本上的表现;exec-compare 的授权边界;dist 在干净机器(无 Xcode CLT)上的行为。
- 后续候选:补丁侧新增对象的定位(需服务补丁分析)、运行对照的测试预期关联、相机/折叠跨会话持久。
