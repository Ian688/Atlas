# Atlas 接续开发：标量上下文、预算与索引取消

本次在 `d1485df` 和接手时已有的未提交实现之上继续开发。初始源码指纹见 baseline.json，原有未提交差异见 preexisting.patch。保留其他开发者的代码、文档与历史证据，不提交或重置 Git。最终 **11/11 PASS，验证脚本退出码 0**。Rust 51 个测试、worker 20 个测试、原集成 16 个测试、新取消 5 个用例、新语义契约 5 组均通过。当前状态以本目录 verified/verification.json 为准。

## 实际行为

1. **有界标量参数上下文。** 每 callee 最多 8 个调用点上下文，键同时绑定 callee、caller、调用操作和规范化实参。参数换位不再把 caller 的 Parameter 编号误当 callee 参数；实参随摘要精化后重新调度；NaN 不再导致上下文比较永久不相等。对象、捕获、符号参数以及超出数量上限的调用使用符号摘要。跨函数 Allocation 未导入 caller 堆时保留显式 unknown，防止错误别名或数组索引越界。可写的捕获函数绑定不再解析为声明时的唯一目标。
2. **真实共享的求解预算。** 初始求解、SCC 与上下文求解均消耗同一个总 transfer 额度；删除未计入预算的末尾重算。预算或固定点轮数耗尽时，保留全部函数分母，发布 partial 状态和 frontier。返回、抛出、调用点、块绑定与效果同步保守降级，不保留基于未稳定摘要的剪枝证明。CLI/HTTP 的 flow 事实现在包含 frontier、job_total_transfers、job_max_transfers 和 context 上限；它们参与新分析身份，旧事实不变。
3. **取消贯穿整个索引。** 扫描与 Rust 分析放入 blocking 线程，共享 ExecutionControl；SIGINT/SIGTERM listener 一直保留到提交结束。取消不再使用 300ms 后强制 process::exit。worker 只在 true token 时取消，初始已取消不启动子进程，false sender 关闭不误取消；失败统一 kill + wait 回收直接 worker。
4. **事务终态有明确顺序。** 扫描期限与整体期限都覆盖发布锁等待。SQLite writer 按短周期重试，并检查控制对象。最终 commit 与取消接受共用门：先接受取消则拒绝提交，先完成 commit 则保留成功终态，迟到信号不会把已提交分析改成取消。旧 analysis/source/flow 在取消后继续可读，重试可成功。
5. **纠正数字转字符串及错误测试。** w03 的 `{:.0}` 展开会把 `9223372036854775808` 输出成精确整数；Node 的正确字符串为 `9223372036854776000`。现在使用锁定 `ryu-js = 1.0.3` 的纯 Rust 数值转换，覆盖最短十进制、指数阈值、负零、NaN、±Infinity。实现用途依据其 [官方文档](https://docs.rs/ryu-js/1.0.3/ryu_js/)；真实行为由固定 Node oracle 的 12 个边界验证。新增单个依赖，Cargo.lock 已更新；索引器不运行被分析项目。

算法版本更新为 `atlas-local-absint@0.2.0`。README、架构、接力入口与进度台账同步；固定开发工时/提前收尾条件没有恢复。

## 验证入口与证据

最终完整命令：

```sh
python3 scripts/verify.py --out evidence/development/2026-09-10-continuation/verified --keep-going
```

正式验证入口现含 11 组检查，新增脚本已永久纳入 CHECKS：

- Rust：worker 生命周期、扫描期限/取消/提交后终态、局部语义、上下文、共享预算、基础不可变存储与图查询。
- `scripts/test_integration.py`：现有真实 worker → Rust → SQLite → CLI/HTTP 链。
- `scripts/test_cancellation.py`：5 个 POSIX 集成用例；握手缓存来自真实 parser，同快照绑定；通过 PID 回收、数据库文件打开与取消诊断同步，无固定等待时间推断阶段。SIGINT/SIGTERM、发布锁超时均不增加 analysis/facts/nodes/edges，并验证旧版本和重试。
- `scripts/test_semantic_contracts.py`：5 组真实 CLI 契约，含参数换位/精化、8-context cap、0/1/15 总预算、旧 partial 版本保留、12 个数值文本边界及可写捕获目标。
- TypeScript worker、calculator、web-syntax、格式、Clippy、差异空白检查。

过程中的失败保留：verification/ 为修正 Clippy 前的完整运行（退出 1）；final-verification/ 为增加捕获绑定回归前的通过运行；number-string-before.log 为数值文本修复前的 6 项失败（退出 1）；cancellation-first-run.log 记录测试握手尚不充分时的 1 项失败，随后增加 worker 回收及重新打开数据库的同步。最终资格只绑定 verified/ 与最终指纹。

legacy-probes/ 是旧语义/边界脚本在新目录的重放输出，两个 main 返回码均为 0；它们只覆盖各自原有断言。原语义 probe 的 captureChange 虽有输出，却不参与其返回码，因此本轮另加正式断言捕获了确定旧目标的错误。历史 probe JSON 在接手前已经存在未提交改动，本轮没有重写这些文件。

## 未完成与资格边界

本次为已实现范围内的自动验证与内部审查，不自标完整产品 ACCEPTED。

- W06 仍缺持久 owner/project/request 作业身份、队列、租约、崩溃重启恢复；当前控制对象属于一个本地 CLI 索引操作。
- W07 增量失效尚未实现；完整堆/闭包上下文、Capture 重代入与真实执行仍待做。
- 协作取消检查点不等于能中断单次阻塞 OS I/O 或正在提交的磁盘操作；总 transfer 额度不等于总内存/RSS/序列化字节上限。
- POSIX 测试不代替 Windows/Linux 全环境资格；本轮没有新增 UI 交互或真实大项目规模资格。

下一主线是让 owner/project/request、持久租约和取消终态接入同一实际索引与发布链，再推进增量。当前接缝是 control.rs、Store 的受控发布、analyze_controlled 与 CLI 的信号生命周期。

最终核对：验证记录绑定的 51 个源码指纹零漂移；受控最终清单 57 个文件。相对接手时状态修改 18 个、新增 5 个、删除 0 个。changes.json 区分本轮变化，preexisting.patch 保留接手前差异。
