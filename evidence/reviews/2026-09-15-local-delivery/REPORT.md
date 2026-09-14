# 首版本地交付独立复验：CHANGES_REQUIRED

检查对象：执行者 2026-09-15 D0–D4 交付，HEAD cca8fcf0 加未提交实现。实际测试 dist 内二进制，不以 debug 构建替代交付物。源码及交付物指纹见 identity.json。本轮不修改产品实现。

## 通过的范围

- 使用交付二进制重放执行者扩展的真实 HTTP/浏览器探针：9/9 PASS，exit 0。原 R1–R4 在该复现范围内通过，包括作用域反例、验证切换、任务身份、SVG 端点几何和真实指针导航。见 regression.cjs、results.json、regression.log。
- 把整个分发目录复制到独立临时位置，从该临时位置调用 start.sh 打开独立项目：搜索 HTTP 200；真实浏览器输入 17、23，实际运行返回 40、运行退出码 0。说明入口和简单受控运行已可用。

## 本次确认的阻断

**L1 / P1 仓库外补丁验证失败。** 上述分发启动后提交合法 add 补丁并验证，作业终态 failed，terminal_reason=worker_missing。start.sh 的 index 使用绝对 worker，但 serve 没有传入对应资源配置；server_verify_options 仍用相对于调用者 cwd 的 workers/typescript/worker.mjs。这导致用户按交付入口可以运行，却不能完成验证/应用链。让服务及持久验证任务使用实际交付资源；验证复制目录和含空格路径下的全程，不能只在 dist 自身目录测试。

**L2 / P1 服务重启不能恢复任务。** 真实浏览器选 add、填写输入并进入 review；关闭页面、终止服务、用同一项目和 store 重启，使用启动器新输出的 URL 打开。端口从 58443 变成 58466，选区变为“选择一个函数”、mode=understand、drafts={}。localStorage 属于 origin，随机端口隔离数据；选区/页签仅在旧 fragment，没有随启动入口恢复。刷新原页面不能证明重启恢复。持久化需以项目/版本识别任务，允许新会话鉴权，不能靠沿用失效 token。

## 仍未完成的原定范围（代码/报告核对）

- D2 显式声明的测试配置没有接入交付入口：server_verify_options 固定 test_argv=None，执行者也记录页面不能配置测试。这不是新加需求；当前任务书要求隔离验证及显式配置测试。可通过本地启动配置传 argv 实现，无需新建任意 shell 输入界面。
- exec-compare 请求与 RunSpec 只传 args，this_arg=None、globals={}；单次运行表单已有 this/globals。对这些已支持输入的函数，尚不能以相同完整运行条件对照。此项来自代码核对，未在本轮动态复现。
- Node >=18 的分发说明与项目 Node 24+ 声明不一致；runner 实际要求 --permission 能力探针成功。应按实际端到端支持范围检查与声明，不能仅 worker 可启动就承诺受控运行。未在 Node18 环境实测。

## 证据与限制

`distribution.cjs`：4 项检查，2 PASS / 2 FAIL，exit 1，见 distribution-results.json、distribution.log；截图 distribution-review.png、distribution-restart.png。脚本启动实际复制包，终止自建进程并清理临时目录，不改用户项目。

两份脚本本机运行命令：
```sh
NODE_PATH=/Users/yinsijie/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules node evidence/reviews/2026-09-15-local-delivery/regression.cjs
NODE_PATH=/Users/yinsijie/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules node evidence/reviews/2026-09-15-local-delivery/distribution.cjs
```

同机仓库外测试不等于干净机器测试。没有重跑综合 suite；没有独立验收完整多项目、多行差异、compare 权限矩阵或应用/撤销。本次失败已阻断后续完整交付验收。保留执行者自测 PASS，首版仍 CHANGES_REQUIRED。下一单仅完成现有交付范围，不启动视觉/算法增强。
