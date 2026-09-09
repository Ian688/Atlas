# w02 独立复审：CHANGES_REQUIRED

审查提交：`6b4c47412e81b8fc9e9ea224b4609956ac4e976a`。本次仅新增复审材料，不修改产品实现，不提交 Git。初始工作区干净；交付 source-manifest 的 62/62 文件与当前字节相符（source-audit.json）。

常规自测结果可信，但不构成 R1–R7/M1–M3 全部闭环的证明。独立新增 5 项断言失败，其中 4 项静态返回值排除了真实运行结果，且均声明 `complete_within_profile`、`unknown=false`。不能将它们归入已登记的精度不足：保守 {1,2} 可以包含实际值 2，本次输出 {1} 则不能。

## 阻断项

### F1 / P1：typed_constants 把所有非零有限数标成无穷（M2）

位置：crates/atlas-engine/src/solve.rs:2033–2039。分支只判断正负，没有判断 is_infinite。`return 41` 的 constants 为 [41]，typed_constants 却为 [{kind:"infinity"}]；负有限数同理会进入 negative_infinity。机器消费者按建议优先读取侧车时失去真实数值。

修复要求：先区分 finite / NaN / ±Infinity，有限数保留 number 与 value。增加直接 CLI 序列化断言覆盖正负整数、小数、零、NaN、正负无穷及同名字符串。

### F2 / P1：已知堆写经过包装函数后消失（R2）

位置：solve.rs:1392–1446，apply_summary_heap 仅更新 state.heap，没有将重代入效果继续写入 state.written；参数实参也退化为 wildcard，没有保留可继续重代入的参数身份。

复现：`set(o){o.value=2}` → `wrap(o){set(o)}` → 调用者创建 `{value:1}`，调用 wrap 后读取 value。Node 返回 2；Atlas 返回 [1]、unknown=false。

修复要求：摘要应用必须同时支持当前函数内读写与向上层传播；保留参数对应关系，并验证两层/三层包装、参数换位、混合分支。允许保守并集，不能漏掉 2。

### F3 / P1：调用写堆后抛异常，catch 仍读取调用前旧值（R1/R2）

位置：solve.rs:805–811、1593–1601。调用前状态解决了“throw 后赋值被提前执行”，但异常边直接发送 pre-state，遗漏 callee 在抛出前完成的写操作。

复现：`fail(o){o.value=2;throw 7}`；调用者 o.value=1，try 调用 fail，catch 返回 o.value。Node 返回 2；Atlas 返回 [1]、unknown=false。

修复要求：异常路径的局部状态必须排除调用后的赋值，同时包含调用内部可能已发生的堆效果；已知/未知调用均需要异常效果处理。不能用调用者整个 block 的结束状态修复，以免重引入 R1。增加 throw 前写、throw 后写、未知函数修改后抛出的交叉测试。

### F4 / P1：未知调用未失效嵌套可达对象（R2）

位置：solve.rs:1344–1374，clobber_for_unknown_call 只收集直接实参 Allocation，没有沿堆值追踪可达分配点。

复现：inner={value:1}，outer={inner}，未知 change(outer) 执行 `outer.inner.value=2` 后读取 inner.value。Node 返回 2；Atlas 返回 [1]、unknown=false。

修复要求：对逃逸参数可达堆做有界传递失效，达到预算必须显式保守降级；验证嵌套对象、别名、循环引用与边界预算。不能只匹配直接参数 site。

### F5 / P1：大整数 ToString 被 i64 饱和截断（R4）

位置：solve.rs:1958–1959（js_string 的整数分支）。条件 abs(n)<1e21 大于 i64 范围，`as i64` 饱和。

复现：`return ''+100000000000000000000`。Node 为 "100000000000000000000"；Atlas 为 "9223372036854775807"，unknown=false。

修复要求：禁止通过窄整数类型转换 JS number 的文本表示，使用与声明数域一致的转换；尚不能精确处理时显式 unknown。测试 ±1e20、i64 边界、1e21 指数阈值和原有小数拼接。

## 已复验通过的范围

- `python3 scripts/verify.py --out evidence/reviews/2026-09-09-w02/verification --keep-going`：最终退出码 0，9/9 PASS。包括 Rust、worker、集成、calculator、web-syntax。
- 原 semantic probe：main 返回码 0；原 boundary probe：main 返回码 0。使用 importlib 加载历史脚本并将 OUT 指向本目录，避免覆盖历史证据。两者包装进程退出码 0。
- malformed IR 三项均退出 1，analyses=0、facts=0；optional catch 退出 0。
- pipeline deadline：退出 1，2.128s，零 analysis/facts；Rust-stage deadline：退出 1，1.071s，零 analysis/facts。这两个非零退出符合预期，不是验证失败。
- 新增 `python3 evidence/reviews/2026-09-09-w02/probe_adjacent.py`：最终退出码 1，5/5 断言失败；真实 Node oracle 只执行本次自有固定 fixture，不执行被审项目代码。

原 semantic probe 的成功条件允许 unknown，且只对 6 项检查，不校验 typed_constants；所以它返回 0 与本次失败并不矛盾。M1 原 identity 样例与 finallyReturn 的精度已观察到改善，但不能据此推导整个摘要系统可靠。

## 证据与交接

- adjacent-results.json、adjacent.log、probe_adjacent.py：新增可重复反例及源码。
- semantic-probes.json、boundary-probes.json：本轮旧 probe 新输出。
- verification/verification.json 及日志：本轮全套验证。
- source-audit.json：被审提交与 62 文件指纹对账。

`a6385e9` 的提交名称与源码表明主要修复已包含在首个 Git 基线中，a6385e9→6b4c474 不是 R1–R7 完整修复前后差异。今后 Git diff 可用；本次历史修复仍须借助旧 manifest/快照。capability-matrix 的 integration 数量仍写 12，与最终交付 13 不一致，应同步台账。

建议下一窗口先修 F1–F5，新增正式回归与相邻扰动，更新 R1/R2/R4/M2 的修复状态后再申请复审。W06/W07、k=1、capture 与大项目资格继续保持独立未验收边界。本轮未进行 UI 交互资格或完整产品验收。
