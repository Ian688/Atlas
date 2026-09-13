# 给下一个 Agent 的交接简报

写给接手 Atlas 的 Agent。**先读这一份，再读 `README.md` / `docs/ARCHITECTURE.md` / `docs/HANDOFF.md`。**
这份简报只讲三件事：现在的真实状态、怎么自己验证、以及我已经踩过的坑。

---

## 0. 最重要的前提（用户明确纠正过的，不要退回旧理解）

1. **呈现就是 Atlas 的表达方式。** 它不是聊天对象，是仪器。**一轮如果没有让某个使用场景的屏幕变得可用，这一轮就不算完成**，
   无论修了多少底层缺陷。UI 是把本地计算（索引 / CFG / 抽象解释 / 快照 / 3D 渲染）变成人的洞察的**唯一**环节；
   呈现烂 = 那些资源白烧。
2. **LLM 不是 Atlas 存在的理由。** Atlas 做的是 LLM 结构上做不到的事：把 6573 个函数、14476 个调用点摆在人面前让人自己走；
   同一快照上同一问题永远同一答案；可以指着某个调用点；离线、无模型、可审计。**LLM 是可选的注释层与生成层。**
   凡是发现自己把有价值的部分划给 LLM、把边角料留给 Atlas，就说明设计错了。
3. **广度已暂停**：大仓库资格、宿主侧 E2E 不推进，如实标注 PARTIAL / 阻塞。**当前集中做"让 2D 变成真能用的工作台"。**

---

## 1. 怎么自己验证（不要相信任何人的叙述，包括这份简报）

```bash
cargo build
python3 scripts/verify.py --label <label> --out evidence/development/<date>-<label> --keep-going
```

- **25 项检查 + 1 项受控负对照 + 指纹配对**。全绿才算一轮完成。
- **负对照必须红**（`ATLAS_FORCE_ENTRY_BACKFILL=1` 让语义契约用例 exit 1）；负对照绿了说明断言是空的。
- **指纹配对**：二进制自称的指纹必须等于从源码算出的指纹。它覆盖 `crates/**`、`Cargo.lock`、`web/*`，
  **不覆盖 worker**（见 §3 坑 2）。
- 判定看 `verification.json` 的 `status`：`PASS` / `FAIL` / **`UNSTABLE`**。UNSTABLE 一律不算数，重跑。
- 单点验证的入口：`python3 scripts/test_integration.py`（18 用例，含 HTTP/CLI/worker 全链路）、
  `node --test workers/typescript/tests/flow.test.mjs`（17）、
  `node web/tests/app.behavior.test.mjs`（44）、`node web/tests/city3d.behavior.test.mjs`（28）、
  `node scripts/bench_view_layout.mjs`（18 条布局判据 + 真实引擎）、
  `python3 scripts/bench_view_readability.py --self-check`（可读性判据）、
  `python3 scripts/probe_browser_engine.py`（真实浏览器里的布局引擎）。
- **真实项目**：`local-state/bench/rxjs`（rxjs@7.8.1 检出）。冷索引约 2 分钟。
  常用：`./target/debug/atlas --store <store> index local-state/bench/rxjs`。

## 2. 现在的真实状态

**已验证的能力**：摄取 → 内容寻址快照 → TS 事实 → 版本化 Flow IR → CFG → 局部抽象解释（跨过程摘要、SCC）→ 查询 →
2D 工作台（分层布局 + 端口 + 折叠摘要边 + 值状态矩阵 + 层级切换 + 空间索引）→ 3D 城市（层级 + 尺度合同）→
受控执行 → 补丁链（隔离验证 + 写入锁）→ Agent 桥 → 宿主接缝。

**关键实测数字**（都可在对应 `evidence/development/*/REPORT.md` 里找到口径）：

| 指标 | 值 |
|---|---|
| rxjs 规模 | 1255 源文件 / 6573 有 flow 事实的函数 / 14476 调用点 / 0 partial |
| **显式未知区域** | **167 → 79 → 0**（第 11 轮，三个语言特性补齐） |
| 带 `unmodeled_assignment_target` 的函数 | **317 → 10**（第 11b 轮，元素访问赋值目标） |
| flow 层调用点 | 11,428 → 11,440 |
| 3D 柱高可读性 | 不足最高柱 1% 的列 **850/923 → 0** |
| 未解析调用比例 | **82.8%**（未分解，是已知的下一步） |

**门禁**：最近一次 25/25 exit 0，指纹 `65eea636aa53d987b2b8c03074a57e3333fc77bdf76856632dc9cd5b884dfa57`。

## 3. 我已经踩过的坑（改代码前先读这一节）

1. **同一个契约在仓库里有 ≥3 份副本。** 例：`for...of` 的契约同时存在于
   `workers/typescript/tests/flow.test.mjs`、`scripts/test_integration.py`、以及生产者版本字符串（两处 worker + 一处引擎）。
   **改行为前先 `grep` 同名契约的所有副本**，否则门禁必红（我红过两次，都是这个原因）。
2. **改 worker 行为必须升生产者版本。** 指纹不含 worker，所以产出的事实变了、身份却没变——同名的两次分析可以有不同事实。
   三处必须同时改：`workers/typescript/src/parse.mjs`、`workers/typescript/src/flow.mjs`、
   `crates/atlas-contract/src/lib.rs` 的 `WORKER_PRODUCER`。引擎对不认识的版本**具名拒绝**（索引会直接失败，`binary=None`）。
3. **门禁运行期间不要改任何源文件**，否则 `status: UNSTABLE`——**全绿也不算数**。
4. **不要凭推理判断界面做成了什么样。** 用真实页面截图。深链接支持：
   `http://127.0.0.1:<port>/#token=<token>&selection=<实体>&analysis=<分析 id>&view=values&panel=unknowns`
   （token 从 store 目录下的 `web-session-*.json` 读）。无头浏览器：
   `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --disable-gpu --hide-scrollbars --window-size=1600,1200 --virtual-time-budget=20000 --screenshot=...`
   —— 用 `perl -e 'alarm 90; exec @ARGV'` 包一层，它挂过。
5. **无头浏览器点不了按钮。** 逻辑验证走真实接口（curl/python），画面验证走 fragment 深链接。
6. **`node:vm` 里的布局引擎不可靠**：同一个图、同一个 API，有时返回坐标、有时一个都不返回（跨 realm 传对象）。
   所以：布局基准跑**纯 node**，页面测试**注入受控引擎**，真实浏览器单独用 `probe_browser_engine.py` 问。
   适配器已对"没有坐标的结果"具名拒绝（`elk_returned_no_coordinates`）——**不要把它改回默认 0**，那会画出"所有盒子叠在原点"。
7. **先写结论再核对数字，就会写错。** 我犯过一次：报告初稿说"新出现的理由并非全部由循环造成"，
   同一次运行的输出推翻了我（34/34 全是循环函数）。**先看数字，再写结论**；错了就**保留错误版本并标注**，不要悄悄改掉。
8. **不要把"没有证据支持的修复"留在树里。** 我做了一个改动，重建全库后四项指标完全相同 → **撤回**。
   没有可测量效果的"修复"不该提交，哪怕它看起来更稳妥。
9. **未加载子集不能当全量。** 页面第一页 500/8938 个对象里**一个函数都没有**（目录与文件在前）。
   任何"从已加载对象推算"的数字都必须标注口径，否则会像曾经那样把 2080 印成项目函数总数。
10. **不要用 `python3 - <<'PY'` 里的引号嵌套写文件**——我因此两次写坏/没写成文件（含一次提交里只有日志没有报告）。
    写中文内容用 `cat > file <<'EOF'`，JSON 用单引号字符串。

## 4. 一轮的完成标准（照这个走）

1. 一个**垂直切片**（不是半个功能）；
2. 真实数据上的**可测量**结果（不是"感觉好多了"）；
3. `python3 scripts/verify.py` **25/25 + 负对照红 + 指纹一致 + status=PASS**；
4. `evidence/development/<date>-<label>/` 里有 `REPORT.md`（含"没有做的事"一节）与 `verification.json`；
5. 更新 `docs/implementation/progress.json`（窗口、`next_action`；说错了就加到 `corrections`）；
6. **提交**，工作树干净；
7. 报告里**如实区分**"已验证 / 未验证 / 环境性阻塞"。原始失败证据**不要删除**（放在窗口的 `runs/` 下）。

## 5. 队列（按当前优先级）

1. 常量 key 收敛为 property（`obj['x'] = 1`）；剩余 10 例 `unmodeled_assignment_target` 归因；
2. 执行画像 / 受控运行的**主视图**（现在还在侧栏折叠面板里）；
3. 未知清单点条目时**按字节区间高亮源码**；
4. 82.8% 未解析率的分解；
5. 3D 缺口：玻璃、边界端口、正交视角、相机保存、按需重绘、搜索定位到层、`visibility_reason`；
6. 未做且未声称：大仓库 / 跨机器 / 多语言 / Windows 资格，独立评审，Modus 宿主侧（环境性阻塞）。
