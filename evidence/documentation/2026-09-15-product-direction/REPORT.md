# 产品方向整理

2026-09-15。用户授权专业化产品设计与过时文档清理。本轮只修改文档，没有修改产品代码，也没有验收当前产品。

新增 docs/PRODUCT_DESIGN.md：目标用户与首个任务、页面结构、12 类可见功能、节点操作、Review、场景/断言、真实轨迹和调试、Agent 协作、实现结构与 A–D 顺序。明确区分已有基础、新设计和技术验证。

整理 README，去掉只能服务启动时分析、只能启动时配置测试等过时描述；更新 USE-CASES、FRONTEND_DESIGN、设计索引、HANDOFF、任务书的产品方向与 progress 新设计指针。当前仍执行 M1–M6，不中断/重做在途地图开发。源码已有 explore.js/tree/knowledge，交接由“未实现”改为“有实现入口，待核对交付”。

修改前的上述文件保存在本目录的同名相对路径。未删除历史规格/证据或其他开发者代码；清理的是当前入口中的错误与冲突，而非抹去历史。未将新设计标成产品完成，历史 R1–R4 资格保持原范围。

验证：7 个文档本地链接检查无断链、progress JSON 可解析，命令退出 0；git diff --check 退出 0。未跑产品测试，因为本轮无产品代码变更。

依据：直接读取 README/ARCHITECTURE/HANDOFF/任务书、产品/前端设计与当前 runner/server/explore 源码。runner 明确 not_sampled；没有新的运行轨迹资格。外部技术参考使用 VS Code、Playwright、GitHub 官方文档，不作市场需求已验证声明。
