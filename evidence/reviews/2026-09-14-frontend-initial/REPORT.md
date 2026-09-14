# 前端首轮独立复验：CHANGES_REQUIRED

2026-09-14。检查对象：HEAD cca8fcf0c77dd32d9f57db3969b9f520c56eacb3 加当前未提交实现。保留执行者 F1–F5 的交付与自测记录；本轮是有限范围复验，不是完整验收。没有修改产品代码。

## 已验证可用

独立临时项目经真实 worker/Rust/store 索引，HTTP 查找 add/caller/shadow；Chrome 真实指针点击关系图 caller→add；填写 2、3 并运行，观测返回 5、退出码 0。浏览器无未捕获异常。不是原型或模拟 API。

## 必修问题

1. **R1 / P1 验证切换后卡死**。`web/app.js:startVerify`：提交第一个提案验证，切换函数，等轮询发现 request 改变后返回，再切回并验证第二个提案。按钮点击产生 0 次 POST，`state.verifying` 仍指向第一个提案。旧轮询退出未清理全局互斥状态，阻断后续用户任务。修复作业状态与当前选区的生命周期，覆盖切换、返回、失败和重试。
2. **R2 / P1 全局依赖漏报**。`crates/atlas-engine/src/exec.rs:external_names` 用整个函数的名称集合扣除局部变量，跨作用域误删外部读。真实样本 `export function shadow() { { let CONFIG = 1; } CONFIG; return 0; }` 的画像 `required_globals=[]`，虽然 reasons 仍提示 reads_global。用户缺少需配置的具体名称。按绑定身份/词法解析修复；同时保留原先对象简写局部变量不被误报的行为。
3. **R3 / P2 验证身份不一致**。POST `/api/patch/verify` 接受自定义 request_key 并返回 job id，GET `?id=<proposal>` 却按提案 id 重建默认作业身份，返回 job=null。提交与查询须共享同一持久身份；核对失败重试和重复提交，不能使界面永远等待。
4. **R4 / P1 调用边画错位置**。实际截图 `01-real-workbench.png` 中 caller→add 箭头停在 caller 框内，没有连接 add。`drawFocusPlan` 传入中心 x，`graphNode` 却将 x 作为矩形左边；端口仍用布局坐标。统一坐标约定，用真实 SVG 几何与截图检查端点，保留鼠标/键盘选择。

## 产品缺口

截图 `03-review-navigation.png` 中补丁 diff 被压成一段文本，结构变化只显示计数。这还不是主设计要求的可读前后差异与定位。下一片在修复上述问题后，完成 T2：多行增删差异、实际变更对象/源码定位、验证与测试结果清楚分开、授权目录应用及撤销。复用现有补丁链。运行前后对照、相机/折叠恢复是执行者承认的缺口，本轮没有将其验收为完成；T3 在 T2 后继续。

## 命令与证据

- `cargo build --workspace --locked`：exit 0。
- `node --test web/tests/app.behavior.test.mjs`：exit 0，脚本内 63 项通过，见 web-tests.log。
- `NODE_PATH=/Users/yinsijie/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules node evidence/reviews/2026-09-14-frontend-initial/probe.cjs`：exit 1，6 项断言中 3 PASS / 3 FAIL，见 results.json；R4 来自截图与坐标代码核对，未混入断言计数。
- `probe.cjs` 自建并清理临时项目/store/服务，Chrome 路径写在脚本中；其他环境可调整工具路径，保留断言语义。

未复验完整 tour、全部值/未知锚点、2D/3D 恢复、授权应用/撤销、作业崩溃恢复或全套综合检查。当前结论足以安排修正，不足以声称完整 T1–T3 或 RELEASE_PASS。
