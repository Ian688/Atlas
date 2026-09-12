# W07：增量失效、事实撤回与派生成本

窗口：2026-09-12/w07-incremental。工作目录 `/Users/yinsijie/CodeRepo/Atlas`。

W07 从 `NOT_IMPLEMENTED` 推进到 `PARTIAL`：缓存键、失效归因、撤回与成本记账已接通并纳入验证门；**局部改动仍然需要重新派生全部函数**，原因在下面第三节，有实测数据。

## 一、交付

| 位置 | 内容 |
|---|---|
| `crates/atlas-engine/src/incremental.rs`（新增） | 运行键、文件键、SCC 凝聚闭包摘要、失效归因、撤回；8 个单测 |
| `crates/atlas-engine/src/store.rs` | `incremental_runs` 表；`put_blob` 缺陷修复（见第三节） |
| `crates/atlas-app/src/main.rs` | `index --incremental`（`job submit/enqueue` 同样支持）；分阶段计时 |
| `scripts/test_incremental.py`（新增） | 6 个 CLI 级用例；已加入 `verify.py` |

### 两个键，分工不同

- **运行键** = `H(版本包, 快照 id)`。快照 id 本身就是 `digest(整个 Snapshot)`（含 schema、scan_profile、limits、每个条目的 blob 哈希），所以同一运行键意味着**同样的字节 + 同样的版本**，已发布的分析可以直接返回。
- **文件键** = `H(版本包, 路径, 自身内容 hash, 依赖闭包摘要)`。闭包摘要在**导入图的 SCC 凝聚**上自底向上折叠，因此互相导入的文件作为**一个单位**失效，而不是一个无法排序的环。失效不需要额外的一遍扫描：文件键恰好在"它自己或它依赖的任意文件变了"时改变。

版本包 = `producer | ENGINE_VERSION | FACTS_SCHEMA | ANALYSIS_SCHEMA | FLOW_SCHEMA | FLOW_PROFILE | ALGORITHM_VERSION`，任一升级都会失效缓存。

### 撤回

`withdrawn` 列出上一次运行分析过、这一次不再存在的文件。分析**始终从当前文件集合装配**，从不合并进旧结果，所以撤回是结构性的而非事后清理。

## 二、承重断言

**增量运行必须发布与全量运行完全相同的 analysis id。**

analysis id 是整个 Analysis 内容的摘要，因此任何被错误复用的事实——过期的调用目标、本该撤回却残留的节点——都会改变它。`scripts/test_incremental.py` 的每个用例只要能与全量比较就比较：

```
冷启动 → 热复用 → 编辑 → 删除，四条路径的 id 全部等于对应全量运行的 id
```

这不是"命中率"测试，而是"答案是否相同"测试。

## 三、实测成本模型（改变了对本项的判断）

121 文件合成项目（1 个共享模块 + 30 个导入它的叶子 × 4 个文件规模，2 函数/文件）：

| 场景 | 耗时 | 说明 |
|---|---|---|
| 冷启动（首次，全部 blob 新增） | 4.41s | 主要成本是 blob 发布 |
| 热重跑（未改动） | **0.72s** | 6.1×，跳过全部派生 |
| 局部改动（1 个叶子文件） | 1.53s | 2.9×，仍重新派生全部函数 |

修复后的分阶段实测：`scan 0.049s · worker 0.647s · derivation 0.751s`。

### 发现的真实缺陷：`put_blob` 对已存在的 blob 仍然写盘并 fsync

原实现无条件写临时文件 + `sync_all()`，然后才通过 `persist_noclobber` 发现 blob 已存在。于是**每次扫描每个未改动文件都要一次 fsync**。

修好后：**scan 3.1–4.9s → 0.049s（60–100×）**，全量 index **5.7s → 4.4s**。内容寻址使发布天然幂等（名字就是哈希），所以先检查存在性是语义上正确的做法，不是微优化；完整性校验（内容与名字不符则拒绝读取）**保留未动**。

这个缺陷影响**每一次索引**，与是否增量无关。

### 为什么局部改动仍然昂贵

实测显示 Rust 侧成本是 `inter::analyze_interprocedural_controlled` 的**全程序 SCC 不动点**：单个函数的求解依赖跨文件被调方的摘要。所以"按文件缓存派生结果"在算法上不成立——不是没做，而是做了也不对。文件键因此用于**度量与归因**（`reusable` 就是下一次若实现增量不动点后可跳过的文件数），而不是伪装成已有收益。

## 四、验证

```
python3 scripts/verify.py --label w07-incremental --keep-going   退出码 0
  16/16 检查退出码 0（新增 incremental）
  negative-control 受控失败 ✓   fingerprint pairing: binary == source ✓
  status PASS · document_errors [] · sources_changed 0 · binary_stale false

cargo test --workspace --locked   0   （77 → 85）
cargo clippy ... -D warnings      0
python3 scripts/test_incremental.py  0  （6/6，22s）
```

真实归因输出（改一个叶子文件）：

```
files: {'parsed': 121, 'reusable': 120, 'own_content': 1, 'by_dependency': 0, 'new': 0}
changes: [('app/m5.js', 'own_content')]
```

改共享模块时：`own_content: 1`，`by_dependency: 30`（全部导入者），`via: ["lib/util.js"]`——传播方向正确，且**不反向**（改叶子不会让共享模块失效，有单测钉住）。

## 五、资格边界

- W07 仍是 **PARTIAL**：局部改动不做增量派生。实现增量不动点需要摘要稳定性追踪，是算法级改动，未做。
- 只有**全程序缓存命中**（字节与版本都没变）时才跳过派生。
- 热路径仍要付一次 worker 启动（约 0.65s，node + TypeScript 加载的固定开销）。实测表明空探针与全量解析几乎同价（0.50s vs 0.60s），所以"只探版本"没有意义，已放弃该设计。
- 121 文件是**合成样本**，不是大项目资格；真实中型项目的冷/热/增量成本仍待记录。
- `incremental_runs` 表只增不删，无回收策略。
