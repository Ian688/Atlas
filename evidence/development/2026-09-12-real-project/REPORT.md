# W07 GE-2/GE-3：真实中型项目 rxjs@7.8.1 的冷/热/增量成本、峰值 RSS 与覆盖分母

窗口：2026-09-12-real-project。工作目录 `/Users/yinsijie/CodeRepo/Atlas`。

本报告记录在**真实第三方项目** `rxjs@7.8.1`（npm tarball，sha256 `c532167725ab7d085123209156c93cef22f2479cb9c8527060f1cd903aa9d149`，索引前校验通过）上实测的冷/热/编辑/删除成本、峰值 RSS、覆盖分母与磁盘成本。证据文件：

| 位置 | 内容 |
|---|---|
| `scripts/bench_real_project.py`（新增） | 全流程测量脚本，仅标准库；下载校验 → 解包 → 环境 → 复用探针 → 六个索引场景 → 恢复 → JSON + 逐命令日志 |
| `evidence/development/2026-09-12-real-project/rxjs/bench.json` | schema `atlas.real-project-bench.v1`，最终（修复后）运行的完整证据 |
| `evidence/development/2026-09-12-real-project/rxjs/*.log` | 每个命令的原始 stdout+stderr 与退出码行 |
| `evidence/development/2026-09-12-real-project/rxjs/prefix-failure/` | **修复前**两次失败运行的 bench.json 与日志（未发布任何 analysis） |
| `evidence/development/2026-09-12-real-project/rxjs/diag/` | 根因定位：15 次二分运行日志、最小复现 fixture、修复前后 A/B、worker 测试日志 |

**一句话结论**：第一次在真实中型项目上跑这条链路时 Atlas **无法索引**——六个索引命令全部以 `Error: Invalid("flow_reference_unknown_binding")` 退出 1。该失败被二分定位到一个文件（`src/internal/Observable.ts`）、一个方法（`toPromise`）和最终一个 5 行嵌套闭包构造，牵出**两个真实缺陷**；两个缺陷已在 worker 源码修复（由主 agent 完成，非本报告作者）。**下面第一至七节的全部数字都是修复之后重跑得到的**；修复前的失败运行数据单独记录在第九节，不混入。

## 一、结论摘要（修复后，单次运行）

| 场景 | 退出码 | 墙钟秒 | 峰值 RSS（字节 / MiB） | 结果 |
|---|---|---|---|---|
| cold（空 store，首次 `--incremental`） | 0 | 160.33 | 563,224,576 / 537.1 | `derived` |
| hot（同一 store，`--incremental`） | 0 | 12.13 | 491,786,240 / 469.0 | `reused`，derivation 0.0s |
| edit（给 1 个叶子追加注释，`--incremental`） | 0 | 117.55 | 563,355,648 / 537.3 | `derived`，own_content 1 / by_dependency 0 |
| edit_full（编辑后整树，plain 全量，独立新 store） | 0 | 159.28 | 528,023,552 / 503.6 | `id` 与 edit 相同 |
| delete（删除另一个叶子，`--incremental`） | 0 | 96.78 | 612,343,808 / 584.0 | `derived`，withdrawn 1 个 |
| delete_full（删除后整树，plain 全量，另一新 store） | 0 | 136.82 | 561,397,760 / 535.4 | `id` 与 delete 相同 |

**两条承重断言均成立**（见第七节）：增量 edit 与全量 edit_full 发布同一 `analysis id`；增量 delete 与全量 delete_full 发布同一 `analysis id`。脚本退出码 0。

实测的规模：1255 个 `.js`/`.ts` 源文件、2,531,086 字节源码；快照捕获 2277 个文件；6573 个函数、14,476 个调用点（其中 10,775 个 unresolved，74.43%）、8938 节点、25,969 边。

## 二、目标与下载校验

| 项 | 值 |
|---|---|
| 包 | `rxjs@7.8.1` |
| `npm pack` 退出码 | 0 |
| tarball sha256 | `c532167725ab7d085123209156c93cef22f2479cb9c8527060f1cd903aa9d149`（与 pin **一致**） |
| tarball 字节 | 752,048 |
| 解包 | 2277 个文件、4,501,327 字节，剥掉前导 `package/`，0 符号链接、0 跳过 |
| 整树摘要（sorted `relpath\0sha256`） | `b2bbb6a149d2cb15d561e44ce88a13f1a47ad8c8c65dc0e4e889fb53436d0ebe`（2277 文件） |
| 分析扩展名清点 | `.js` 754 文件 / 1,310,426 B；`.ts` 501 文件 / 1,220,660 B；合计 1255 / 2,531,086 B |
| 环境 | macOS 15.7.9 x86_64；Node v26.5.1；rustc/cargo 1.96.1；`target/debug/atlas` sha256 `10c6ab5cc674623e287f462ca1336898d7c4adbc47f2724b79e8eebed1884018`，32,705,024 B |
| 峰值 RSS 方法 | Darwin `/usr/bin/time -l` 的 `maximum resident set size`（字节）；全部 `peak_rss` 均实测，无 `peak_rss_unavailable` |
| 分析元数据 | `schema atlas.analysis.v1`，`engine foundation-flow-0.2.1`，`producer typescript/5.9.3;worker/0.2.0`，`binary_fingerprint 6c5a3150e755…` |

索引命令模板（六个场景共用，`edit_full`/`delete_full` 不带 `--incremental`）：

```sh
target/debug/atlas --store <store> index <project> --node node \
  --worker <abs>/workers/typescript/worker.mjs \
  --timeout-seconds 600 --scan-deadline-seconds 300 --index-deadline-seconds 1800 [--incremental]
```

## 三、实测：冷/热/编辑/删除（修复后）

墙钟为脚本 `time.monotonic()` 测得（含 `/usr/bin/time` 包装开销）；峰值 RSS 为该命令进程由 `time(1)` 报告的进程最大值，**不是堆剖析**。

| 场景 | 退出码 | 墙钟秒 | 峰值 RSS（字节） | 峰值 RSS（MiB） |
|---|---|---|---|---|
| cold | 0 | 160.333789 | 563,224,576 | 537.1 |
| hot | 0 | 12.133070 | 491,786,240 | 469.0 |
| edit | 0 | 117.551355 | 563,355,648 | 537.3 |
| edit_full | 0 | 159.283626 | 528,023,552 | 503.6 |
| delete | 0 | 96.782164 | 612,343,808 | 584.0 |
| delete_full | 0 | 136.818976 | 561,397,760 | 535.4 |

派生必须完成全部事实，因此热复用是唯一跳过派生的路径：hot 12.13s 相对 cold 160.33s 是 **13.2×**；但代价仍是每次热跑都要付一遍 scan + worker（4.02s + 8.01s）。

### 关于 cold 为什么带 `--incremental`

Task 文本把 cold 定义为基础命令、hot「加 `--incremental`」。实测表明这在本实现里**不可能**得到 `reused`：只有 `--incremental` 运行才会写入复用键（`record_incremental_run` 位于 `if options.incremental` 分支内）。因此 cold 被实现为「空 store 上的第一次 `--incremental` 运行」——它同样是首次全量派生，只是额外记录了一行复用键，是唯一能测到真实 hot 复用的方式。这一点由 JSON 里的 `reuse_record_probe` 直接测量（真实小 fixture，同二进制同 worker）：

| 探针步骤 | `--incremental` | 退出码 | 结果 |
|---|---|---|---|
| plain cold（新 store） | 否 | 0 | 无 incremental 报告（未记录复用键） |
| 随后 `--incremental`（同 store） | 是 | 0 | `derived`（**没有复用**） |
| `--incremental` cold（另一新 store） | 是 | 0 | `derived`（记录复用键） |
| 再 `--incremental`（同 store） | 是 | 0 | `reused` |

所以「plain 冷启动之后可以热复用」**不成立**，已作为未证明项记入第十节。

## 四、分阶段实测（增量报告内的 scan / worker / derivation）

只有 `--incremental` 场景带分阶段计时（来自引擎自身的 `incremental.seconds`）；`edit_full`/`delete_full` 是 plain 运行，没有该对象，故只有总墙钟。

| 场景 | scan 秒 | worker 秒 | derivation 秒 | 引擎 total 秒 | 脚本墙钟秒 |
|---|---|---|---|---|---|
| cold | 50.448738 | 6.218204 | 103.196524 | 160.215291 | 160.333789 |
| hot | 4.015081 | 8.007356 | 0.000000 | 12.044972 | 12.133070 |
| edit | 3.150649 | 8.410604 | 105.416997 | 117.476294 | 117.551355 |
| delete | 3.663170 | 6.458458 | 86.187079 | 96.695782 | 96.782164 |

读数：

- **派生是全程序成本**。edit 只改了 1 个文件（`own_content: 1`、`by_dependency: 0`、`reusable: 1254`），derivation 仍要 105.42s，与 cold 的 103.20s 几乎相同。这以真实项目数据确认了 W07 已声明的算法边界：Rust 侧派生是全程序 SCC 不动点，「按文件缓存派生结果」在算法上不成立。
- **冷启动的 scan 显著更贵**（50.45s vs 3.15–4.02s）。W07 已记录 `put_blob` 对已存在 blob 不再写盘；这与 2277 个新 blob 的首次落盘（每个一次 fsync）一致。但本次证据**没有 scan 内部子阶段计数**，所以这是与既有结论一致的**解释**，不是本报告独立测得的因果分解。
- **热路径仍有约 12s 固定成本**：scan + worker 必须在复用判定之前完成（worker 仍解析全部 1255 个文件），只有 103s 的 derivation 被跳过。
- worker 阶段本身只需 6.2–8.4s（TypeScript 解析 1255 文件），**真正的瓶颈是 Rust 派生**。

## 五、覆盖分母与图规模（cold 元数据）

| 键 | 值 |
|---|---|
| `catalog_entries` | 2365 |
| `disposition:captured` | 2277 |
| `disposition:directory` | 88 |
| `encountered_source_files` | 1255 |
| `parsed_source_files` | 1255 |
| `flow_functions` | 6573 |
| `flow_complete_within_profile` | 6573 |
| `flow_partial` | 0 |
| `flow_frontier_functions` | 0 |
| `flow_unknown_regions` | 167 |
| `interproc_sccs` | 6568 |
| `interproc_recursive_sccs` | 19 |
| `file_count` / `function_count` | 2277 / 6573 |
| `call_count` / `unresolved_call_count` | 14476 / 10775 |
| `node_count` / `edge_count` | 8938 / 25969 |

- 源文件解析覆盖是完整的：`encountered_source_files == parsed_source_files == 1255`，`flow_functions == flow_complete_within_profile == 6573`，`flow_partial == 0`、`flow_frontier_functions == 0`。
- 但**调用候选分辨率很低**：10775/14476 = **74.43% unresolved**。`dist/bundles/rxjs.umd.js` 这类打包产物里的属性调用/动态调用只能保留未知（167 条 `FLOW_UNKNOWN_REGION` 诊断，样例为 `for_in_of_iteration`）。覆盖率数字不能被读成「分析基本完成」。
- `metadata` 实际出现的键（未做任何假设）：`binary_fingerprint, call_count, coverage, diagnostics, edge_count, engine, file_count, flow_digest, function_count, id, incremental, limitations, node_count, producer, recursive_components, schema, snapshot_id, unresolved_call_count`。`unresolved_call_count` **存在**。

## 六、磁盘成本

`--store` 是 `local-state/bench/store`；主 store 依次经历 cold → hot → edit → delete（hot 命中不发布新分析，edit/delete 各发布一个新分析，旧分析不删除）。

| 时点 | store 字节 | 文件数 | 说明 |
|---|---|---|---|
| cold 之后 | 129,364,422（123.4 MiB） | 2183 | 1 个已发布分析 + 全部 blob |
| hot 之后 | 129,364,422（123.4 MiB） | 2183 | **完全不变**：复用不写任何新数据 |
| delete 之后 | 379,458,356（361.9 MiB） | 2184 | 4 次运行累计 3 个已发布分析 |

每个额外的已派生分析约 +125,046,967 B（119.3 MiB）。（hot 不增长这一点本身就是复用的独立旁证：字节与版本都没变时没有新事实落盘。）

## 七、承重断言（id 相等）

| 断言 | 结果 | 证据 |
|---|---|---|
| hot id == cold id | **true** | 两者均 `cc00190d81fc…`；`incremental.outcome == "reused"`；`derivation == 0.0` |
| edit id == edit_full id | **true** | 两者均 `b15d0e9bd3e8…` |
| delete id == delete_full id | **true** | 两者均 `0d283af988f4…` |
| delete `withdrawn` == 被删文件 | **true** | `["src/internal/util/subscribeToArray.ts"]` |
| edit `own_content` / `by_dependency` | 1 / 0 | 叶子被改，且没有任何导入者被反向失效 |
| `atlas report <id>` 可读回同一 id | **true** | `verify-report` 退出码 0，id 一致 |
| 编辑/删除的文件按 sha256 逐字节恢复 | **true** | 两文件恢复后 sha256 均等于改动前 |
| 恢复后整树摘要 == 初始摘要 | **true** | 同为 `b2bbb6a1…` |
| 全部索引命令退出码 0 | **true** | 6/6 |
| 脚本 exit gate | **true** | `python3 scripts/bench_real_project.py` 退出码 0 |

被编辑/删除的文件（脚本按「`src/internal` 下无任何源文件导入的最小小叶子」确定性选择）：

- edit：`src/internal/util/workarounds.ts`（338 → 366 B，追加一行真实注释，sha256 `c5720f17…` → `9805e1d1…`；0 个导入者）。
- delete：`src/internal/util/subscribeToArray.ts`（389 B，sha256 `c52067ad…`；0 个导入者，与 edit 不同的另一叶子）。

三个 id 互不相同（`cc00190d…` / `b15d0e9b…` / `0d283af9…`），因为三次的树不同——这也说明 id 确实随内容变化，而不是被错误复用。

## 八、第一次运行失败：发现并修复两个真实缺陷

第一次运行**六个索引命令全部退出 1，stdout 为空**，stderr 唯一一行：

```
Error: Invalid("flow_reference_unknown_binding")
```

该字符串来自 Rust 侧的 Flow 校验（`crates/atlas-engine/src/flow.rs:352-365`、`448-461`）：每个 `Local` 读/写与函数引用必须解析到该函数自己声明的 binding 或 capture，否则视为协议损坏并**拒绝整次派生**（不发布任何 Analysis）。即 scan 与 worker 都已成功，失败发生在 Rust 派生阶段。

定位链（全部为真实运行，日志在 `rxjs/diag/bisect-*.log`，15 次运行）：

1. 全树 1255 文件 → exit 1；`src`-only 252 文件 → exit 1；`dist`-only 1003 文件 → exit 1（触发点在两类都出现）。
2. 对 `src` 二分：252 → 126 → 63 → 31 → 15 → 8 → 4 → 2 → **1 个文件**：`src/internal/Observable.ts`（20,163 B，sha256 `af884584…`）。单独索引它仍稳定 exit 1（重复 2 次）。
3. 用固定版本 TypeScript 解析该文件，按 class member 二分「删掉哪些成员后能通过」：30 个成员中**只删 `toPromise` 实现重载**即可通过；反过来只保留该成员仍然失败。即该方法是该文件失败的**充分且必要**条件。
4. 把该方法化简为最小构造，得到 5 行复现（`diag/minimal-repro/A-nested-capture.ts`）：

```ts
export function outer(f: any, g: any) {
  f(() => {
    let x = 1;
    g(() => x);
  });
}
```

对照实验（同一二进制、同一 worker）：

| fixture | 修复前 exit | 修复后 exit |
|---|---|---|
| A-nested-capture（binding 属于中间箭头，被更深一层箭头读取） | **1** | 0 |
| B-observable-topromise-member（隔离出的 rxjs 方法） | **1** | 0 |
| C-control-single-arrow（binding 在同层箭头内声明并读取） | 0 | 0 |
| D-control-outer-binding（binding 在最外层函数声明，被嵌套箭头捕获） | 0 | 0 |

A/B 的修复前后日志在 `diag/minimal-repro/*__prefix-HEAD.log` 与 `*__fixed-current.log`（`prefix-HEAD` 用的是从 git HEAD 取出的 `flow.mjs`，sha256 `89883201…`；`fixed-current` 的 `flow.mjs` sha256 为 `c9e8aaed…`）。两个缺陷都由主 agent 在 worker 源码修复，本报告记录的是修复后的实测：

- **根因 1**：`workers/typescript/src/flow.mjs` 的 `collectDeclarations()` 会下探嵌套函数体，于是外层方法把内层箭头函数的 `let value` 认领为自己的 binding；内层箭头自己的 declarator 又引用了一个它没有声明的 binding，被 Rust 校验正确拒绝。修复后 `collectDeclarations` 在所有 function-like 节点与 class body 处停止（只登记提升的函数声明）。
- **根因 2**：同文件 `walkModule()`（pass 0，收集模块级名字）只在函数/**声明**与 class 声明处停止，会下探函数表达式与箭头 IIFE。rxjs 的 `dist/bundles/rxjs.umd.js` 整体包在一个 IIFE 里，其工厂函数表达式把整个局部名字表（`extendStatics`、`__assign`、`EMPTY_SUBSCRIPTION` …）贡献给 `moduleNames`；每个函数都去登记这些名字，先构建的函数把它们认领走，真正声明它们的 IIFE 反而留下 105 个悬空引用。修复后 `walkModule` 在所有 function-like 节点和 class 表达式处停止，只 push 声明名。

独立复核（本人运行，非引用他人结论）：`npm test --prefix workers/typescript` **退出码 0，25 pass / 0 fail**（日志 `diag/worker-tests-postfix.log`）。两个根因都定位到了具体的 worker 源码行，修复本身由主 agent 完成。

## 九、修复前的失败运行数据（单独记录）

修复前共跑了两次完整 benchmark（分别使用当时不同的 `target/debug/atlas`：第 1 次 `48ad76b4…`/30,936,352 B，第 2 次 `e462a67d…`/32,691,504 B），**两次全部命令退出 1、未发布任何 analysis（id 为 null）**。原始 JSON 与日志保留在 `rxjs/prefix-failure/`。

| 场景 | 运行 1 墙钟秒 | 运行 1 峰值 RSS (B) | 运行 2 墙钟秒 | 运行 2 峰值 RSS (B) |
|---|---|---|---|---|
| cold | 63.764130 | 479,653,888 | 61.235725 | 446,050,304 |
| hot | 21.852138 | 508,043,264 | 13.236433 | 496,726,016 |
| edit | 16.858930 | 506,105,856 | 15.592051 | 494,120,960 |
| edit_full | 62.833638 | 498,061,312 | 59.041761 | 494,059,520 |
| delete | 14.825204 | 509,222,912 | 14.815872 | 491,446,272 |
| delete_full | 63.205880 | 508,506,112 | 60.949353 | 502,345,728 |

**修复前的峰值 RSS 区间为 446,050,304 – 509,222,912 B（约 425–486 MiB）**，即使派生只做到一半就失败也已经接近/触顶。这是独立于成本的一个发现：**在 1255 文件的真实包上，单进程峰值 RSS 已经进入 500 MB 量级**。修复前那两次运行的墙钟与派生阶段无关（失败发生在校验），只反映「scan + worker + 部分派生」。

不能把修复前的时长与修复后的时长直接作差值当作「修复开销」：两次的失败点不同、二进制不同，且修复前从未完成派生。

## 十、明确未证明的部分（NOT proven）

- **没有证明大仓库/单体仓库资格**。1255 文件、2.5 MB 源码是「中型包」；不是 monorepo，也没有分区调度证据。
- **没有证明多语言资格**。只索引了 JS/TS；其它语言从未进入本次链路。
- **没有证明并发或并行 worker 资格**。全部是单进程单 worker、串行场景。
- **没有证明 Windows 资格**；本次只在 macOS 15.7.9 x86_64 上测量，`peak_rss` 解析路径是 Darwin 专用（Linux 分支有代码但本次未执行）。
- **没有证明跨机器/跨工具链可复现**。Node v26.5.1、rustc 1.96.1、debug 构建、本机负载都会影响数字；墙钟是单次测量，不是多次分布的统计量。
- **峰值 RSS 不是堆剖析**。它是 `time(1)` 报告的进程最大值，无法把字节归因到 scanner、worker、Rust 派生或 SQLite；因此不能据此断言哪一段是内存瓶颈，也不能据此推出更大项目不会 OOM。
- **没有证明「plain 冷启动之后可以热复用」**：实测为否（第四节探针）。复用键只在 `--incremental` 运行时记录。
- **没有证明派生结果可增量**：edit 的 1254/1255 文件 reusable，但 derivation 仍是 105s。`reusable` 是「若实现增量不动点后可跳过的文件数」，不是已有收益。
- **没有证明语义正确性**：id 相等只证明「增量与全量给出同一个答案」，不证明这个答案是对的；74.43% 的调用点仍是 unresolved。
- **没有证明固定的 worker 修复没有引入回归**：本次只做了 A/B fixture、全树 rxjs 索引与 worker 单测 25/25；没有跑完整仓库验证门（`scripts/verify.py`）。
- **没有证明 store 有回收策略**：三个已发布分析累计到 361.9 MiB，`incremental_runs` 与旧分析只增不删。
- **修复前的峰值 RSS 数据只覆盖失败路径**（未完成派生），不代表完整派生下的内存上限。

## 十一、命令与退出码（全部为实际执行）

```sh
# 环境与工具
node --version                                  # 0   v26.5.1
rustc --version                                 # 0   rustc 1.96.1 (31fca3adb 2026-06-26)
cargo --version                                 # 0   cargo 1.96.1 (356927216 2026-06-26)
python3 -m py_compile scripts/bench_real_project.py   # 0

# 修复前
python3 scripts/bench_real_project.py           # 1   六个 index 全 exit 1，flow_reference_unknown_binding
python3 scripts/bench_real_project.py           # 1   同上（第二次，见 prefix-failure/）

# 修复后
cargo build --workspace --locked                # 0   （第一次，7.46s）
cargo build --workspace --locked                # 0   （第二次，0.46s，无操作）
python3 scripts/bench_real_project.py           # 0   六个 index 全 exit 0，两条 id 断言成立
npm test --prefix workers/typescript            # 0   25 pass / 0 fail

# 最终运行内的命令（argv 见同名 .log；峰值 RSS 见 bench.json）
npm pack rxjs@7.8.1 --pack-destination <cache>  # 0
target/debug/atlas ... index ... cold           # 0
target/debug/atlas ... index ... hot --incremental          # 0
target/debug/atlas ... index ... edit --incremental         # 0
target/debug/atlas ... index ... edit_full      # 0
target/debug/atlas ... index ... delete --incremental       # 0
target/debug/atlas ... index ... delete_full    # 0
target/debug/atlas --store <store> report <delete id>       # 0
```

根因定位期间的命令（日志在 `rxjs/diag/`）：二分 15 次 `atlas index`（全树与子集，退出码 1 或 0，见 `bisect-*.log`）；A/B fixture 8 次（`prefix-HEAD` 下 A/B exit 1、C/D exit 0；`fixed-current` 下四个全 exit 0）；`shasum -a 256` 校验 tarball、被编辑/被删文件与恢复结果。

复现整条证据链：

```sh
cargo build --workspace --locked
python3 scripts/bench_real_project.py
```

## 十二、资格边界

- W07 GE-2/GE-3 由此取得**单机、单项目、单次运行**的真实成本与覆盖分母证据：1 个真实第三方 npm 包、1255 个 JS/TS 文件、2.5 MB 源码。
- **仍然是 PARTIAL**：局部改动不做增量派生（105s 实测）；hot 复用只覆盖「字节与版本都没变」，且热跑仍付 scan+worker 固定成本。
- 第一次真实项目运行直接暴露了两个此前单测从未覆盖的 worker 缺陷——合成样本（121 文件扇出、无嵌套闭包捕获）没有触发它们。这本身是「真实项目资格」不可被合成样本替代的证据。
- 峰值 RSS 在 1255 文件规模已达 469–584 MiB（失败路径 425–486 MiB）；更大项目的内存资格仍未建立。
- 本报告未把任何失败写成成功：修复前的失败运行、其峰值 RSS 与未发布 analysis 的事实都单独保留。
