# 首版交付独立复审

结论：**CHANGES_REQUIRED**。主体流程可用，资源定位修复有效；尚有版本请求与任务恢复缺陷。保留执行者自测成绩，不将其改写成独立验收通过。

本次直接运行已有 darwin-x64 分发包的临时副本，真实 Chrome 指针/键盘操作。没有修改产品代码或重建包。HEAD、关键源码与包 SHA256 见 [identity.json](identity.json)。执行者 verify 的 source_hashes 与复审开始时全部一致；综合检查 25 项 PASS 属于执行者证据，本次没有重复跑全套。

## 必修问题与下一单顺序

### R1 / P1：显式版本请求被静默忽略

`GET /api/report?analysis=definitely-not-current` 返回 HTTP 200 和当前基线 id，而不是拒绝。见 [delayed-distribution-results.json](delayed-distribution-results.json)。执行者已观察过此问题，本次独立复现。Agent 在核对补丁版本时可能用错事实，因此不能仅作为普通待办。

入口：`crates/atlas-app/src/server.rs:83` 的 Request 与 `query():113`。识别公开支持的显式版本字段，不同于本实例版本时具名拒绝，并回显请求/服务版本；不要求本单增加多版本服务。验收同版本、异版本、无版本请求，以及 Agent 收到拒绝后的正确恢复。不要误伤 relocate 的 from。

### R2 / P2：重定位只迁移选区，没有迁移输入草稿

先填 add(17,23)，保存并停服务；只在源码顶部新增注释，重新启动。函数按 path_and_name 成功重定位，但输入框变成两个空字符串，页面却说“输入草稿一并恢复”。见 [s2-results.json](s2-results.json) 和 [截图](s2-source-moved-relocated.png)。原自测只检查了选区和提示，没有检查重定位后的实参。

入口：`web/app.js:544–569`、`execDraft():1630`。草稿仍以旧 symbol 字节区间为键。根据已验证的版本重定位迁移适用草稿；参数不兼容时明确提示，不按裸名猜。验收顶部注释后的 17/23 实际回填、签名变化处理及不同项目不串用。

### R3 / P2：关闭页面会丢最后一次页签变更

上一轮原始独立探针直接重跑：选 review、关闭页面、停止服务再启动，恢复成 run。仅在关闭前额外等待 1 秒的对照探针则恢复 review。见 [distribution-results.json](distribution-results.json)、[delayed-distribution-results.json](delayed-distribution-results.json)。

入口：`web/app.js:1613–1621`，600ms 去抖，没有页面退出保存路径。修正常关闭时最后一次状态的保存，并让失败有可理解的反馈；测试不要人为等去抖时间来隐藏问题。无需承诺断电前尚未发送的数据能恢复。

### R4 / P2：接入说明把可用授权路径写成不能运行

README/HANDOFF/交付报告写“需要 unknown_calls 的函数在 HTTP 面无法运行/对照”，实际服务接受 `allow_effects:["unknown_calls"]`。本次 S3 的 this 样本要求该 grant，传入后两侧均 returned 30。见 [s3-results.json](s3-results.json)。文件/网络/子进程权限仍是另一个受控边界，不能混写。

校正当前 README/HANDOFF/AGENT_ONBOARDING 与 contract 的说明，给 Agent 准确请求示例和缺授权时的恢复方法。不要为满足错误文档新增限制或重造授权系统；历史报告保留并在新报告指明更正。S5 原 Agent 因缺授权被拒，不能据此认定该类函数无法执行。

## 本次执行结果

| 探针 | 结果 | 范围 |
|---|---|---|
| distribution.cjs（上一轮原始探针） | 3/4，exit 1 | 仓库外启动、实际运行、验证通过；快速关闭恢复失败 |
| delayed-distribution.cjs | 4/5，exit 1 | 等待保存后重启通过；显式错误版本未拒绝 |
| s2-restart.mjs（增加输入框断言） | 8/9，exit 1 | 全新浏览器 context、跨项目隔离、重定位/改名；重定位后草稿失败 |
| s3-verify-compare.mjs | 11/11，exit 0 | 测试成功/失败输出，globals 125/126，this 30/30 |
| s4-journey-tour.mjs | 12/12，exit 0 | 关系/值点击、运行、验证切换、对照、应用撤销真实字节、2D/3D |

脚本复制到本目录后执行，S2/S3/S4 使用本次唯一临时目录，历史结果未覆盖。运行命令：

```sh
NODE_PATH=/Users/yinsijie/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules node <本目录的脚本>
```

S3/S4 写出结果后启动器子进程仍存活，本次按实际 PID 清理了自建进程组，才结束驱动进程；上述测试结果不能当作正常退出的资格证据。下轮顺带核对启动器停止与脚本清理，不扩大为新平台工程。

## 范围与交付判定

本轮 S5 是检查既有执行 Agent 与核对报告，没有重新派发真实 Agent 任务，不冒称第二次 Agent 独立验收。稳定端口占用回退、非分发布局 worker、重试并发、另一结构项目、干净机器与跨平台没有在本轮重新取得资格。已查看重定位截图，界面与空输入一致。

下一单只做 R1→R4，重建包、复测上述反例及受影响主流程；让真实 Agent 按修正说明处理版本拒绝与声明运行授权，再交同一提案供人审阅。最后跑适用综合检查并交新报告。通过后进入实际试用；更多语言、平台、视觉精修不作为本单前置。
