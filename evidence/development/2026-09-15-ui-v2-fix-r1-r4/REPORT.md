# Atlas UI v2：R1–R4 整改交付（自测报告）

结论：**四项整改已实现并自测通过，待独立复审。** 复审对照组（[2026-09-15-ui-v2-current 复审之后的双项目复现](../../reviews/) 指出的 R1–R4）逐项修复；核心证据是**双项目（同名同字节 math.js）每次写入后的双方字节记录**：beta 全程应用/新版本/撤销，alpha 字节自始至终等于基线。

身份：源码指纹 = debug 二进制 = **最终分发包**二进制指纹 `2029ab355d686b063563d0585f6722e39897105ede84a9965466325f078c8b52`（verify 指纹配对 PASS + 对 `dist/atlas-local-darwin-x64/atlas` 单独实测一致）。最终包：`dist/atlas-local-darwin-x64/`。

## R1 · 写入与项目一致（P1，已修）

**机制**：启动 `--allow-writes` 现在只表示"本服务具备 HTTP 写能力"（`contract.writes.capable`）；具体写哪个目录**跟随当前项目**。页内打开项目时必须勾选「以可写方式打开」——这是明确的本机操作者动作，授权随之落到该目录并在最近项目里记录；切走即换，任何时刻至多一个目录可写。`switch_served` 统一换分析、项目键、写目录、该项目自己的设置；`write_gate`、`patch/apply|revert`、`project/reindex`、`patches?target=here` 全部改用**当前**写目录，不再读启动值。

**实测**（[probe.cjs](probe.cjs)，16/16，真实 Chrome，仓库外最终包）：
- 以可写方式打开 beta 后 `contract.writes.root` = beta 目录；确认层显示 beta 绝对目录（[f05](f05-beta-apply-confirm.png)）。
- beta 提案（外部 Agent 以 `codex-agent` 经 CLI 提交）→ 页面验证（运行 beta 自己声明的命令，alpha 的 `node --test` 未出现）→ 应用：**beta/math.js 改变，alpha/math.js 与基线逐字节相同**（[f06](f06-beta-applied.png)，字节日志见 [results.json](results.json) 的 bytesLog 六个快照）。
- 「打开新版本」重新索引**当前项目**：项目停留在 beta，源码显示更新后的 `add(a, b)`（[f07](f07-beta-new-version.png)）。
- 跨版本撤销在 beta 内完成：beta 恢复基线字节，alpha 仍不动（[f08](f08-beta-reverted.png)）。
- 探针结束时两项目字节都等于启动基线。
- 未以可写方式打开的项目：写端点具名拒绝（`当前项目没有写授权`），审阅页显示去哪里勾选；`target=here` 只按当前项目归组，不再混入启动项目的提案。

## R2 · 草稿按项目|版本|对象隔离（P1，已修）

`execDraft` 的键改为 `analysis id|entity id`；`connect()` 整表替换为服务端按项目键保存的草稿（不再与上一个项目合并）；跨版本恢复只经**明确的重定位**迁移（重定位成功时把旧键草稿移到新键并重绘表单）。实测：alpha checkout 填 719/83 → 打开 beta 选中同路径同名 checkout → 输入框为空（[f02](f02-beta-empty-drafts.png)）；beta 填 5/6；切回 alpha 显示 alpha 自己最后的 19/4（R3 前置那组），不是 beta 的 5/6。行为测试另覆盖同键不同分析互不继承、回原分析草稿仍在。

## R3 · 运行结果以记录自身为准（P1，已修）

- 结果卡的版本标注改用 `record.analysis_id`；记录不属于当前分析时，卡上明示「这条结果属于分析 X，不是当前版本 Y 的观测；只作历史记录查看」。
- 切换对象/项目/重连时清除旧结果卡（`select` 与 `connect` 清 `execResult`），不再把 alpha 的 15 留在 beta 的页面下。
- 后台任务行标注外项目任务「属于分析 XXXXXXXX（另一项目/版本）」（[f03](f03-beta-task-labeled.png)）；「查看结果」对不属于当前分析的任务直接拒绝并说明，不再用当前分析解析目标冒充结果。

## R4 · 项目设置按项目生效（P2，已修）

设置持久化改为按项目键的映射（`project-settings.json` v2）：PUT 保存到**当前项目**并立即应用于验证；`switch_served` 换读该项目的声明——没有声明就是"没有声明测试"，不借用别的项目的命令；入队作业仍用自己入队时的快照。实测：alpha=`["node","--test"]`、beta=`["node","-e","…BETA-TEST-RAN…"]`，beta 的验证输出出现 beta 命令且无 alpha 命令（[f04](f04-beta-settings.png)）；**服务停止重启后**各项目声明与写授权逐项恢复（[restart-check.cjs](restart-check.cjs)，4/4：alpha node --test、beta -e 命令、双方写目录）。设置页文案标明「仅本项目」，`GET /api/project/settings` 说明切换语义。

## 检查与退出码

| 检查 | 结果 |
|---|---|
| `python3 scripts/verify.py --label ui-v2-fix-r1-r4`（25 项 + 指纹配对） | 全 PASS；fingerprint `2029ab35…` 配对；`status: PASS`。日志 [verify/](verify/) |
| `node --test web/tests/app.behavior.test.mjs` | exit 0；**78** 项通过（新增 4 项：草稿作用域、切换清结果卡、外项目任务拒绝、结果卡按记录标注版本） |
| 双项目整改复验 [probe.cjs](probe.cjs)（真实 Chrome、仓库外最终包、同名同字节样本） | **16/16 PASS**；bytesLog 六快照：仅 beta 应用/撤销改变 beta，alpha 恒等于基线 |
| R4 重启恢复 [restart-check.cjs](restart-check.cjs) | 4/4 PASS |
| `git diff --check` | exit 0（verify 内 whitespace PASS） |

## 交付物与文档

- 最终包：`dist/atlas-local-darwin-x64/`（含本轮全部修复）。
- 契约更新：`contract.writes` 新增 `capable`，root 语义改为"当前项目"；`/api/project/settings`、`/api/project/open`（新增 `allow_writes`）说明按项目生效。HOST_API/FRONTEND_API_CONTRACT 已有端点段落同步补充语义（见 `docs/HOST_API.md` 项目编排段）。

## 边界与未升级为独立资格的项

- 同项目跨版本撤销、重启任务恢复、3D 成员往返、外部 Agent 完整任务：本轮 probe 复验了同项目跨版本撤销（R1 链内）与重启设置恢复；3D 与完整外部 Agent 任务保持上一轮自测范围，未独立重跑。
- 打开项目的"分析进度"仍只有经过时间；3D 目录过滤、handoff 关联字段、断线自动查记录维持上轮报告所列边界。
- 平台仍为 darwin-x64 + Node 26。
