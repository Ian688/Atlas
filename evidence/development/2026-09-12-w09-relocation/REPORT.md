# W09 补片：跨版本选区重定位

窗口：2026-09-12/w09-relocation。工作目录 `/Users/yinsijie/CodeRepo/Atlas`。

登记在案的 W09 blocker 是"选区只在同一 analysis 内互通；跨版本是拒绝而不是重定位"。本片补上重定位，
并且把"能判定的"和"不能判定的"分开——后者如实拒绝，不猜。

## 一、交付

| 位置 | 内容 |
|---|---|
| `crates/atlas-engine/src/relocate.rs`（新增） | 重定位判定与依据；6 个单测 |
| `crates/atlas-app/src/main.rs` | `atlas relocate <from-analysis> <entity> --to <analysis>` |
| `crates/atlas-app/src/server.rs` | `GET /api/relocate?entity=&from=` + 合同条目 |
| `web/app.js` | fragment 选区属于别的版本时调用重定位，并显示依据与字节是否变化 |
| `scripts/test_relocate.py`（新增） | 15 个用例，已加入 `verify.py` |
| `adapters/modus/atlas_host_client.mjs` | `relocate()` |

## 二、三条依据，按强度排序，全部公开

| 依据 | 含义 | 判据 |
|---|---|---|
| `path_and_name` | 同 kind、同路径、同名字 | 唯一命中即采用；**字节是否变化单独给出** |
| `identical_bytes` | 同 kind 且源码字节完全相同，但位置不同 | 唯一命中；这是移动/重命名**唯一**能被诚实识别的形状 |
| `name_only` | 同 kind、同名、路径不同 | 唯一命中；明确标注"证据较弱，请确认" |
| `same_version` | 同一个分析 | 无需重定位 |

**拒绝**（都不是猜）：
- `entity_withdrawn`：文件在目标版本已不存在（与增量报告同一套措辞）；
- `no_counterpart`：文件还在，但这个实体没有同名也没有字节匹配的对应物——同路径下的其他函数作为**上下文**列出，
  说明里写明"它们只是邻居，不是匹配"；
- `ambiguous_counterparts`：同路径同名出现多个，或同名字节相同的出现多个。

## 三、真实 CLI 输出

v1 → v2：`add` 被编辑、`keep` 未变、`rename_me` 被改名并改了内容、`drop_me` 换文件且改名、`extra` 所在文件被删除。

```
add         relocated True  | by path_and_name   | bytes_changed True  | cand 3
keep        relocated True  | by path_and_name   | bytes_changed False | cand 3
drop_me     relocated False | refusal no_counterpart | cand 3
truly_gone  relocated False | refusal no_counterpart | cand 4
extra       relocated False | refusal entity_withdrawn
```

`drop_me`/`truly_gone` 的拒绝是对的：改名时**名字本身是字节的一部分**，所以既没有同名、也没有字节相同；
`extra` 的文件整个消失，因此是撤回而不是"没有对应物"。

## 四、重定位不改任何东西

返回的是**建议**加一个钉在目标版本上的选区（`selection.version == 目标 analysis`）。测试断言：
重定位前后 `atlas report <旧版本>` 完全一致，目标版本 id 不变——没有分析被改写，没有 checkpoint 被创建。

网页在 fragment 选区属于别的版本时调用它：重定位成功就选中对应物并说明依据与"字节是否变化"；
被拒绝就显示拒绝码与 engine 的原因；**查询失败显示为失败**，不显示成"服务决定不重定位"。

## 五、资格边界

- **改名且内容也变了**的对象无法识别（名字是字节的一部分），如实拒绝。这不是精度不足的妥协，而是"没有证据"的正确回答；要覆盖它需要跨版本的重命名启发式，本片没有做。
- **移动链**（A→B→C）没有追踪：每跳都是一次独立判定。
- `candidates` 是有界列表（同 kind 且同路径或同名）；一个文件里有上千个同名对象时列表会很长，没有做专门的分页。
- 重定位只对**已发布**的两个分析生效；它不推断"应该"是什么版本。

## 六、验证

```
python3 scripts/verify.py --label w09-relocation \
  --out evidence/development/2026-09-12-w09-relocation --keep-going   退出码 0
  22/22 检查退出码 0（新增 relocate）
  negative-control 受控失败 ✓   fingerprint pairing: binary == source ✓
  status PASS · document_errors [] · sources_changed 0 · binary_stale false
```

| 命令 | 退出码 | 结果 |
|---|---|---|
| `cargo test --workspace --locked` | 0 | 113 → 119 |
| `python3 scripts/test_relocate.py` | 0 | 15/15 |
| `python3 scripts/test_host_adapter.py` | 0 | 8 → 9 |
| `node web/tests/app.behavior.test.mjs` | 0 | 25 → 27 |
