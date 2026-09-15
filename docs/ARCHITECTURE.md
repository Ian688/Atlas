# Atlas 架构与改代码入口

更新：2026-09-15。本文说明现有模块的职责、需要保持的语义和可替换的实现。当前任务见 [执行任务书](DAILY_DEVELOPMENT_WORK_ORDER.md)，统一产品与架构目标见 [PRODUCT_DESIGN](PRODUCT_DESIGN.md)，稳定用户结果见 [USE-CASES](USE-CASES.md)。本次整理不构成产品复验；精确字段/默认值查源码，历史资格查 evidence。

实施时按 [统一设计第 0 节](PRODUCT_DESIGN.md) 区分当前交付、架构责任、后续能力与非目标。扩大规模和能力靠演进生产器/索引/查询，不以示例大小、UI 层级或传输协议定义核心数据模型。

## 1. 依赖方向

Atlas 是独立 Rust 核心 + TypeScript 语言 worker + CLI/本地 Web。Modus、外部 Agent、CLI 和浏览器通过公开接口使用能力，不共享宿主私有数据库。Python 用于开发与验证脚本，不是产品服务依赖。

```text
项目文件 → 清点/内容快照 → 语言材料 → Rust 校验与求解 → 不可变 Analysis → 查询 → 工作台/CLI/Agent
                             固定源码与运行声明 → 隔离执行 → Observed 记录 ↗
                             修改提案 → 隔离验证/重新索引/测试 → 差异 → 应用或撤销
```

静态分析不运行用户项目、插件或模型。显式受控执行走 runner，模型解释与提案走消费者/桥接。显示投影不修改事实。

完整语义模型、局部失败、MCP 接入与事实对应表见统一设计第 8–9 节。以下是工程映射，不把计划中的能力列成已实现。运行观测与静态分析并列，按源码版本关联；UI 和外部 Agent 均可直接消费核心接口，内置 Agent 可选。

## 2. 按故障位置查代码

| 问题 | 入口与职责 |
|---|---|
| 合同/版本/身份 | `crates/atlas-contract/src/lib.rs`：共享类型、生产者与算法版本 |
| 文件遗漏/源码字节 | `crates/atlas-engine/src/scan.rs`、`store.rs`：清点、快照、blob、发布 |
| JS/TS 绑定和 IR | `workers/typescript/worker.mjs`、`workers/typescript/src/parse.mjs`、`flow.mjs` |
| IR 校验/派生 | `crates/atlas-engine/src/analyze.rs`、`facts.rs` |
| CFG/局部求解/跨过程 | `flow.rs`、`solve.rs`、`inter.rs`（均在 engine/src） |
| 查询/来源/邻居/分页 | `crates/atlas-engine/src/query.rs` |
| 取消/作业/增量 | `control.rs`、`job.rs`、`incremental.rs`（engine/src）；CLI 调度在 app |
| 运行画像/真实执行 | `crates/atlas-engine/src/exec.rs`、`crates/atlas-app/src/runner.rs` |
| 补丁/验证/写入 | `crates/atlas-engine/src/patch.rs`、`crates/atlas-app/src/patchwork.rs` |
| 桥接/重定位 | `crates/atlas-engine/src/bridge.rs`、`relocate.rs`；`crates/atlas-app/src/agent.rs` |
| 产品入口/鉴权/进程 | `crates/atlas-app/src/main.rs`、`server.rs`、`worker.rs` |
| 项目地图/知识/记录 | `web/explore.js`、engine `tree.rs` / `notes.rs`、app `knowledge.rs`；有在途实现，按最新包核对 |
| 2D/输入/运行/审阅 | `web/app.js`、`web/index.html`、`web/style.css` |
| 共享层级/布局/3D | `web/hierarchy.js`、`web/layout.js`、`web/city3d.js` |

从真实用户动作找到 handler、请求与事实生产者。缺字段就贯通生产和消费，不只填界面假值；表现问题优先改消费者，不绕道重造引擎。

## 3. 需要保持的数据语义

| 对象 | 身份与用途 |
|---|---|
| Blob / Snapshot | 精确源码字节及捕获清单；旧版本读取旧字节 |
| LanguageFacts | 对应输入快照、生产者、语言材料和明确的未支持项 |
| Analysis | 快照、生产者/算法与派生事实的内容身份；发布后不可原地改写 |
| Entity / Selection | 实体与 analysis 一起使用；源码范围是 UTF-8 字节区间；跨版本有依据地重定位或拒绝 |
| Page / Projection | 查询归属、全量/已加载范围、真实成员和截断；布局不是另一份事实库 |
| Run / Observation | 固定目标、输入、环境/权限与实际结果；返回、抛出、拒绝、超时、取消分开 |
| Intent / Patch | 建议与变更提案；验证产生新的静态结果及测试记录，不把提案当已存在代码 |
| Job / Bridge request | 请求幂等身份、owner、持有者/租约与终态；旧持有者不能覆盖新结果 |

修改事实语义时核对版本常量、生产者和缓存键；身份要反映结果变化。增量与全量对同一输入应给出等价事实。协议/schema 改动同步消费者和必要迁移，不要求维持错误实现。

## 4. 算法与预算

语言 worker 通过受控虚拟输入提取材料；Rust 校验引用、范围和覆盖后建立 CFG、局部抽象解释及跨过程摘要。作用域、求值顺序、异常 completion、调用点参数/返回和堆效果按实际支持范围验证。普通图遍历不等于数据流求解，静态可达不等于运行过。

修改具体语义时查 [算法规格](specs/code-atlas-local-engine-algorithm-spec-2026-09-07.md) 对应章节，先构造源码预期，再通过真实 worker/engine 边界验证。保留正常情形的精度，未知只用于确实缺失的事实和适用近似。

扫描、提取、求解、锁等待、查询和运行有预算/终止路径；取消和发布协调。资源默认值、上下文数、节点上限、worker 堆和布局策略可以测量后调整，避免把当前数值变成产品上限。超限应具名说明；较大项目的分层/分页仍应能找到未显示对象。

SQLite/内容存储、作业队列、增量、受控执行与补丁链已有实现入口，不能按旧文档的“尚未实现”重建。是否满足某个具体场景，通过对应源码与测试核对。新增资格不得引用旧窗口 PASS。

## 5. 工作台

2D/3D 共用层级与分析身份。选区变化携带 generation 或等价机制，迟到响应不能覆盖当前对象。切换视图改变呈现，不悄悄重选对象或伪造关系。

布局引擎负责坐标和路由，Atlas 负责成员、方向、摘要、未知及来源。当前有本地 elkjs 与 WebGL2 实现；可采用更合适的库、后台布局或重构，不要求继续手写。引擎失败有可用回退与说明，不把缺失坐标填成正常布局。

折叠边能找回成员，不能被读成直接调用。总数、已加载范围与渲染省略分清；可通过摘要/分页保持可探索性，不要求一屏装下整个仓库。运行层只展示采集到的观察，缺少行级或调用级事件时不播放虚构路径。

前端允许调整版式、纹理、动效和层级；保留既定双视图和真实源码联动，以任务可完成、可理解为验收。

## 6. 运行、写入与外部消费者

本地服务的会话、Host/Origin 与写入开关在 `server.rs` 核对。owner/作者来自适用的身份边界，不信任远程调用者自报字段。页面不能靠新增请求字段扩大运行或写入权限。

受控运行物化固定源码副本，记录声明输入、权限、目标同一性、拒绝与副作用观察范围；运行隔离和进程回收是实际执行链职责。空日志不证明没有副作用。嵌套闭包、依赖切片、场景和效果记录的支持范围查 `runner.rs` / `exec.rs`，不要用旧描述推断能力上限。

补丁复用提案→隔离验证→重新索引/测试→审阅→应用/撤销。写入校验目标字节漂移和授权目录，保留锁及错误恢复语义。想支持更丰富的合并/备份可演进此链，不另做无校验写入旁路。

MCP 作为正式规划的接入适配层复用现有服务；HTTP/CLI 已有不代表 MCP 已交付。接入不得绕过项目、版本、作业与授权边界；无需为每种消费者另建分析引擎。Atlas 内嵌外部 Agent 属于另一个会话接入方向。

外部工具使用版本化公开接口和有界证据。环境不可用只阻塞对应集成验证；Atlas 本身继续独立开发。本地源码和数据不默认上传。

## 7. 设计变更方式

普通实现调整直接做，在报告说明改变与理由。完整产品方向不受当前库、目录或参数限制。改变公共合同/持久数据时同步兼容与验证；已确认产品目标的实质变化记录用户决定。详细旧实现说明可从 Git 与历史 evidence 追溯，当前架构不再维护重复完成清单。
