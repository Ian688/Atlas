# W08：受控运行的副本范围（依赖切片）

窗口：`2026-09-12/w08-materialise-slice`
日期：2026-09-12（Asia/Shanghai）
结论：**DELIVERED**。隔离副本的范围从"一个隐含行为"变成一个**被记录的选择**；`dependencies` 模式只物化目标文件的静态 import 闭包，这是一个**更紧的读边界**，而它缺什么、依据是什么、怎么复核，全部写在记录里。

## 1. 为什么这不是"顺手优化"

`atlas exec` 每次运行都把整个钉住快照复制到一个一次性的 `0700` 目录。小项目上这看不见；大项目上这是**每一次单函数调用**都要付的成本，而且副本越大，被测代码能读到的无关文件越多。两个方面都指向同一件事：副本范围应当是显式的、有依据的、可复核的。

## 2. 交付的行为

`atlas exec --materialise snapshot|dependencies`（默认 `snapshot`，与过去逐字节一致）。

**`dependencies` 物化什么**

- 目标文件的**静态 import 闭包**：已发布的 `import` 边，传递到不动点；
- `type_import` **不跟随**：它在模块运行前就被擦除，它指的文件不是运行所需；
- **快照里所有 `package.json`**（有上限，跳过的数量会报出）。这不是顺手带上：Node 用最近的 `package.json` 决定"同一份字节按 CJS 还是 ESM 解释"，rxjs 的 `dist/cjs/package.json` 正是那个决定性文件——缺了它，同一份字节会被当成 ESM 而加载失败；
- 目标文件自然在闭包里；副本里没有目标文件时**直接拒绝**（`slice_missing_target`），绝不启动一个没有目标的进程。

**记录把范围变成证据**（`isolation.materialisation`）

```json
{ "mode": "dependencies",
  "basis": "已发布 import 边上的传递闭包…加上快照里所有 package.json…",
  "files_written": 7, "files_in_snapshot": 2277, "bytes_written": 9514,
  "written": ["package.json", "dist/cjs/internal/util/isFunction.js", …],
  "written_truncated": false,
  "package_json": {"kept": 6, "skipped_by_cap": 0},
  "closure": {"seed": "dist/cjs/internal/util/isFunction.js", "reached": 1,
              "unresolved_relative": [], "unresolved_bare": 0,
              "import_edges_read": 2549, "bounded": false},
  "workdir_digest": "…",
  "known_risk": ["动态 import 的计算型 specifier 不在静态图里…",
                 "函数运行时按相对路径读取的其它项目文件不在副本里…ENOENT…"],
  "fallback": "若本次运行以 module_load_failed / ENOENT 失败，可用 --materialise snapshot 复核；切片是静态闭包，不是运行时依赖追踪" }
```

几个刻意的区分：

- **未解析的 import 分两类**：`unresolved_relative`（相对 specifier，可能真的缺文件，**逐个具名**列出）与 `unresolved_bare`（`node:fs` 由 Node 提供、已安装包本来就不在快照里，只计数）。把整张图的未解析边都算成本次运行的问题，是错的——只有闭包**触达**的文件上的边才与这次运行有关。
- **`known_risk` 在运行之前就列出**运行时的两种已知缺口（计算型动态 `import()`、按相对路径读取从未 import 的文件），`fallback` 直接说复核方式。
- **有界**：闭包遍历有文件数/边数上限，触顶报 `bounded: true`，绝不产出一个悄悄缺文件的副本。
- **页面不能选范围**：收紧读边界是能看到记录的人的决定，不是页面替别人的函数声明输入的场合——与 `this`/`global` 同一条规则（HTTP 请求类型里没有这个字段）。

## 3. 真实项目实测

`python3 scripts/bench_exec_slice.py --analysis dc2f21c4… --repeat 3`（rxjs@7.8.1，tarball sha256 在测量前校验；目标 `dist/cjs/internal/util/isFunction.js:isFunction`，一个真实的 CommonJS 模块，`isFunction(3) === false`）

| 模式 | 写入文件 | 写入字节 | verdict | wall 秒（3 次） | 峰值 RSS |
|---|---|---|---|---|---|
| `snapshot` | **2277** | **4,501,327** | returned ×3 | 2.243 / 1.793 / 1.630 | ~42.2 MB |
| `dependencies` | **7** | **9,514** | returned ×3 | 1.201 / 0.864 / 0.879 | ~42.2 MB |

- **两种模式都真的运行了那个模块**（`returned`，值为 `false`），所以这不是"复制得少所以没跑"。
- 切片是 1 个模块 + 6 个 `package.json`；闭包 `reached=1`（该模块不 import 任何东西）、`unresolved_relative=[]`、`bounded=false`、扫描了 2549 条 import 边。
- 墙钟的差**不归因于复制**：它包含 Node 启动、权限探针、复制与调用，脚本的 QUALIFICATION 明确这样写。这里只记录测到的东西。
- 峰值 RSS 没有差别——切片的收益是**文件数与字节数**，不是内存。

## 4. 边界被真正收紧的证据（自动化用例）

`scripts/test_execution.py` 新增 5 条（50 → **55**），载荷全部来自真实子进程：

| 用例 | 断言 |
|---|---|
| `test_a_dependency_slice_carries_the_transitive_import_closure` | `a→b→c` 的传递闭包恰好写入 `{package.json, a.js, b.js, c.js}`，无关的 `sibling.js`/`data.txt` 不在；`reached=3`、`unresolved_relative=[]`、`bounded=false`、`files_written < files_in_snapshot` |
| `test_the_default_copy_is_still_the_whole_snapshot` | 默认模式 `files_written == files_in_snapshot`，无关文件在副本里，`known_risk == []` |
| `test_a_slice_narrows_the_read_boundary_and_the_record_says_how_to_recheck` | 目标运行时读一个从未 import 的数据文件：切片 → `threw` + ENOENT，记录里有 `known_risk` 与 `--materialise snapshot` 的复核方式；整快照 → `returned` 且长度正确 |
| `test_a_computed_dynamic_import_is_a_named_risk_not_a_silent_success` | 计算型 `import('./' + name + '.js')`：切片 → `threw`（`Cannot find module`），记录里 `known_risk` 事先点名动态 import；整快照 → `returned` |
| `test_an_unknown_materialise_mode_is_rejected` | `--materialise everything` → 非零退出 + `invalid_materialise_mode`（绝不静默退回整快照而报告一个更紧的边界） |

Rust 单测新增 2 条：`materialise_mode` 的封闭取值与默认值、`is_relative_specifier` 的判定（`./x` 是、`node:fs`/包名/绝对路径不是）。

## 5. 门禁结果

`python3 scripts/verify.py --label w08-materialise-slice --out evidence/development/2026-09-12-w08-materialise-slice --keep-going`

- **22/22 检查 exit 0**；受控负对照 red；指纹配对一致 `c83c7a52830b615603f01c605e14fb03a07129936fd6f73b172bd62aba2b1a00`；`sources_changed_during_run: 0`。

## 6. 没有做的事（不得读成已实现）

- 切片是**静态闭包**，不是运行时依赖追踪：计算型动态 `import()`、按相对路径读取的数据文件、`tsconfig` 路径别名解析出的文件都不在里面（前两项已在 `known_risk` 里点名）。
- **不跟随 `type_import`** 是基于"类型导入被擦除"这条规则；如果某天 Atlas 执行的是未擦除类型的产物，这条前提要重新审视。
- 已安装的第三方包（`node_modules`）在**两种模式下都不在快照里**：这是既有的边界，不是切片引入的；切片只是不再假装副本包含它。
- 页面/HTTP 仍然只能跑整快照（有意为之）。
- 实测只覆盖一台机器、一个真实项目、一个目标函数；墙钟数字不是吞吐模型。
- 没有做"按函数最小闭包"的更细粒度（例如只复制被调用函数需要的文件）：闭包以文件为粒度。

## 7. 复现

```bash
cargo build
python3 scripts/test_execution.py                       # 55 tests
python3 scripts/bench_exec_slice.py \
  --analysis <rxjs analysis id> --repeat 3 \
  --out evidence/development/2026-09-12-w08-materialise-slice/slice.json
python3 scripts/verify.py --label w08-materialise-slice \
  --out evidence/development/2026-09-12-w08-materialise-slice --keep-going
```

手工最小复现：

```bash
atlas --store S index PROJECT
atlas --store S exec $A 'src/entry.js:run' --args '[5]' --materialise dependencies
# 记录里的 isolation.materialisation 就是这次副本的完整依据
```
