# W09 补片：3D 城市的观测层（与静态层分开）

窗口：2026-09-12/w09-observed-layer。工作目录 `/Users/yinsijie/CodeRepo/Atlas`。

工作单要求"激活与留下的线路来自 Run，静态关联用另外的图例"。现在 Atlas **有** Run 了（W08 的受控执行记录），
但只有入口调用的返回/抛出，没有行级或调用级采样。因此本补片诚实地只做能做的部分：

**标出已运行过的入口**（真实观测），并给它一条与静态调用候选完全分开的图例；
**不**画"激活路径"，因为没有东西可以支撑那个说法。

## 一、交付

| 位置 | 内容 |
|---|---|
| `crates/atlas-engine/src/store.rs` | `run_markers`：把已发布的执行记录投影成 `{symbol,path,name,verdict,duration_ms,mocked,denied_effects}` |
| `crates/atlas-app/src/server.rs` | `GET /api/run-markers` + 合同条目 |
| `web/city3d.js` | `cityRunMarkers`（纯函数）、`cityObservedLine`、描边色 `wireObserved`、覆盖栏"观测"一行 |
| `web/city3d.html` | 观测行 |
| `adapters/modus/atlas_host_client.mjs` | `runMarkers()`，并纳入合同覆盖检查 |
| `web/tests/city3d.behavior.test.mjs` | 新增 3 项观测层用例（共 17） |

## 二、观测**读**静态布局，不改它

`cityRunMarkers(markers, layout)` 是纯函数，测试断言三件事：

1. **布局字节不变**：`JSON.stringify(layout)` 在映射前后相同——观测不加文件、不改高度、不把未解析调用变成已解析。
2. **落不进布局的记录被报出数量**，不丢弃：`unplaced: ['src/gone.js']`。测试同时断言 `placed=2 / total=3`。
3. **颜色三态互不重叠**：`wireSelected`（选中）、`wireObserved`（已运行）、`wire`（静态）两两不同——
   "我选中了它"和"我运行过它"是两个不同的声明。

覆盖栏单独一行给出结论分布，并明确静态与观测的关系：

```
观测（运行入口）3：returned 2 · timeout 1 · 落在 1 个文件 · 未落在当前布局 1
观测（运行入口）0：还没有入口被运行过。管线是静态调用候选，与运行无关。
```

第四种情况同样写出来：**观测查询失败**时显示"观测层不可用：运行记录查询失败，未显示任何'已运行'标记"。
把查询失败画成"什么都没运行过"是虚假陈述。

## 三、资格边界

- **不画激活路径**：Atlas 没有行级覆盖或调用级采样（执行记录里 `trace.coverage = not_sampled`）。
  "留下的线路来自 Run"在缺少 trace 之前无法诚实实现，因此没有实现——只标入口。
- **LOD 未实现**：城市仍按固定规则投影，没有随距离改变几何密度。工作单要求"LOD 不改变事实数量"，
  当前连 LOD 都没有，"不改变事实数量"因此是靠**不画**来满足的，不是靠实现。
- 观测层只覆盖受控运行过的入口；`/city3d` 与 2D 面板读的是同一份执行记录。

## 四、验证

```
python3 scripts/verify.py --label w09-observed-layer \
  --out evidence/development/2026-09-12-w09-observed-layer --keep-going   退出码 0
  21/21 检查退出码 0
  negative-control 受控失败 ✓   fingerprint pairing: binary == source ✓
  status PASS · document_errors [] · sources_changed 0 · binary_stale false
```

| 命令 | 退出码 | 结果 |
|---|---|---|
| `cargo test --workspace --locked` | 0 | 111 |
| `node web/tests/city3d.behavior.test.mjs` | 0 | 17/17（新增 3） |
| `python3 scripts/test_host_adapter.py` | 0 | 8/8 |
| `python3 scripts/test_bridge.py` | 0 | 22/22 |
| `python3 scripts/test_patch.py` | 0 | 25/25 |
| `python3 scripts/test_execution.py` | 0 | 37/37 |
