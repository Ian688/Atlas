# 消费者层：抽象解释状态矩阵与 3D 代码城市

窗口：2026-09-12/consumer-layer。工作目录 `/Users/yinsijie/CodeRepo/Atlas`。

本轮**不推进任何 W 项**。两项交付都是对**已发布事实的投影**，没有新增分析能力；核心算法缺口（完整堆/闭包上下文、别名精度、Capture 重代入）未触及。

## 交付

| 能力 | 位置 | 数据来源 |
|---|---|---|
| 绑定状态矩阵（块 × 绑定） | `web/app.js` `renderFlowHeat()`、`web/style.css` | `GET /api/flow` 已有事实 |
| 3D 代码城市 | `web/city3d.js`、`web/city3d.html`、`/city3d`、`/city3d.js` | `GET /api/nodes`、`GET /api/edges`、`GET /api/source` |

`crates/atlas-app/src/server.rs` 的两条路由复用现有 `asset()`，因此继承同一套 CSP（`script-src 'self'`）、Host/Origin 校验与会话令牌，没有新增安全路径。`crates/atlas-engine/build.rs` 与 `scripts/verify.py` 的指纹清单已同步纳入 `web/city3d.html`、`web/city3d.js`。

渲染器为手写 WebGL2，零第三方依赖、无构建步骤、无 CDN：`script-src 'self'` 下不使用 import map，脚本以 classic script 加载。

## 三条不变量（有测试）

1. **未解析调用必须被画出**，不能因渲染预算丢弃；它以琥珀矮桩附着在发起文件上，并计入覆盖行。
2. **未分析的文件必须被区分**。`analyze` 为快照中每个文件建节点，包含 `ignored`/`oversize`/`unreadable`；把它们画成普通柱体等于宣称已分析，因此按 disposition 单独标识并计数。
3. **警告不得被值掩盖**。矩阵的填充（值种类）、角标（仍含未知分量）、描边（读取时可能未初始化）是三个独立通道；"该块无绑定记录"与"值为未知"使用完全不同的标记。

## 真实缺陷（由真实浏览器验证发现，非单测）

1. **渲染循环被首帧异常永久杀死**。循环在数据加载前启动，`state.camera` 为 `null` → `cityEye(null)` 抛异常；而 `requestAnimationFrame` 排在函数末尾，异常使整条链断掉，画布此后永久空白。修复：相机取有效初值，帧调度提前到函数开头。
2. **数据未加载时点击画布抛异常**（`cityPick(null)`）。修复：加守卫。
3. **未分析文件被画成已分析柱体**（复核发现）。修复：见不变量 2。

缺陷 1 只有真实浏览器能发现：全部单元测试调用的是纯函数，覆盖不到启动顺序。

## 验证

```
python3 scripts/verify.py --label city3d --keep-going     退出码 0
  rust-format 0 · rust-clippy 0 · rust-tests 0 · rust-build 0 · worker-tests 0
  integration 0 · cancellation 0 · semantic-contracts 0 · calculator 0
  web-syntax 0 · city3d-syntax 0 · web-behaviour 0 · city3d-behaviour 0 · whitespace 0
  negative-control entry-backfill-frontier: 受控失败（退出 1 且含断言失败）
  fingerprint pairing: binary == source == 5a2d252ddc514ddeddc26ee1ee5b65f2e1ae22c907a59fbda0865462140a2315
  状态 PASS · document_errors [] · sources_changed 0 · binary_stale false
```

行为测试：`node web/tests/city3d.behavior.test.mjs` 11 项全过（无需 GPU）；`node web/tests/app.behavior.test.mjs` 8 项全过。

真实浏览器（headless Chrome + SwiftShader，经 CDP 驱动，未新增下载）：
- WebGL2 可用；真实 Analysis 加载为 `文件 7/7 · 函数 10 · 管道 3/3 · 未解析调用 15 · 未截断`。
- 拾取链路完整：点击 → 命中 `README.md` → `/api/source` → 面板显示快照源码。
- 方柱 / 圆柱 / 缩放 LOD 三态：JS 异常 0（仅无关 favicon 404）。

状态矩阵另以 135 个真实绑定状态格逐格对照引擎原始数据：分类违规 0；其中 `常量 + 含未知分量` 3 格、`未知 + 未初始化` 15 格——旧设计会把这两类各画成单一类别而隐藏事实。

## 资格边界

- 3D 仅在 SwiftShader 软件光栅化下验证，**未在真实 GPU 上验证**，性能特征不同。
- 布局算法与 LOD 阈值只在 7 文件的样本上跑过；大项目规模未验证，实例化能力未压力测试。
- 未做视觉可用性评估、未做圆柱/方柱在高密度下的可读性对比。
- 本报告不改变 W01–W10 的任何状态：`NOT_QUALIFIED` 与最新复审 `CHANGES_REQUIRED` 仍然有效。
