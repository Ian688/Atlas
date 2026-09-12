# W07 补片：语言 worker 的堆上限成为参数，并且耗尽时有名字

窗口：2026-09-12/w07-worker-heap。工作目录 `/Users/yinsijie/CodeRepo/Atlas`。

真实项目基准（rxjs@7.8.1，1255 个源文件）实测峰值 RSS 到 **563 MB**。worker 当时被硬编码在
`--max-old-space-size=512`：比 rxjs 稍大的项目就只能在"成功"和一句 `worker_exit_failed` 之间二选一，
而后者不告诉你发生了什么、更不告诉你该改什么。

## 一、交付

| 位置 | 内容 |
|---|---|
| `crates/atlas-app/src/worker.rs` | `heap_mb` 参数；`classify_exit` 把堆耗尽识别为具名错误并带 stderr 尾部 |
| `crates/atlas-app/src/main.rs` | `index` / `job` 的 `--worker-heap-mb`（默认 1024，范围 128–8192），写入作业行，并进入 index 请求指纹 |
| `crates/atlas-app/src/patchwork.rs` | `VerifyOptions.worker_heap_mb`；`StoredVerify` 随行存储（`#[serde(default)]` 兼容旧行） |
| `scripts/test_integration.py` | 上限校验 + **真实**堆耗尽用例 |

## 二、错误有名字

```
$ atlas --store … index /tmp/atlas-oom3/proj --worker-heap-mb 128
Error: "worker_heap_exhausted:limit_mb=128:raise --worker-heap-mb:stderr=<最后三行>"
```

三条信息都在里面：**是哪一类失败**（堆耗尽，不是别的非零退出）、**撞到的是哪个上限**、**可以改哪个参数**。
非堆耗尽的非零退出仍然是 `worker_exit_failed:stderr=…`，因为把两者混为一谈会让操作者去调一个无关的参数。

## 三、实测

| 输入 | 上限 | 结果 |
|---|---|---|
| 单文件 14000 个函数（1.15 MB） | 128 MiB | **1.5 秒**耗尽，报 `worker_heap_exhausted:limit_mb=128` |
| 同一输入 | 1024 MiB | **10 分钟未跑完**（本机，前台超时终止） |
| 计算器样本 | 256 MiB | 正常索引 |

第三行说明这不是"把上限调小就会失败"的假象：小项目在更小的上限下照常工作，是这个**形状**撞上了上限。

## 四、资格边界（本次实测新增的真实限制）

- **单文件超大模块是病态输入**：14000 个函数放在一个文件里，按文件粒度派生 Flow IR（每个函数都要建 CFG 与
  抽象解释）在 1 GiB 堆下 10 分钟仍未完成。这不是"上限不够"，而是这个形状的代价不可接受。
  可行的方向是按函数分批或按文件切分派生，未做。
- 上限范围 128–8192 MiB 是**声明**，不是各档位都验过：只有 128 / 256 / 1024 三档在这次实测里出现过。
- 上限提高会线性的提高单进程内存占用；Atlas 没有总内存预算，也没有在多个 worker 之间分配内存的机制。

## 五、验证

```
python3 scripts/verify.py --label w07-worker-heap \
  --out evidence/development/2026-09-12-w07-worker-heap --keep-going   退出码 0
  21/21 检查退出码 0
  negative-control 受控失败 ✓   fingerprint pairing: binary == source ✓
  status PASS · document_errors [] · sources_changed 0 · binary_stale false
```

| 命令 | 退出码 | 结果 |
|---|---|---|
| `cargo test --workspace --locked` | 0 | 111 → 112 |
| `python3 scripts/test_integration.py` | 0 | 含真实堆耗尽用例 |
| 其余 19 项 | 0 | 见 verification.json |
