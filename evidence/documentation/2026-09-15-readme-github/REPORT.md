# GitHub README 更新

2026-09-15。按用户请求更新 README，准备由用户自行上传 GitHub。

改动：以用途、用户动作、真实截图、源码启动、本机打包、Agent 接入和当前方向组织首页。源码入口统一到支持项目参数的 demo.sh，说明只读默认值；本机包说明目录来源和写能力，避免假设已存在公开下载包。Node 要求按 worker package 的 >=24 写；分发验证范围仍为 darwin-x64 + Node 26。

新增 docs/images 两张 PNG，直接复制已有真实截图（来源见该目录 README），已目视检查，不含地址栏或会话令牌。使用测试项目、不同开发版本，首页明确注明。采用仓库相对链接以便 GitHub 显示。未生成概念图冒充产品画面。

验证：README 本地文档与图片链接检查退出 0，git diff --check 退出 0。核对 demo.sh、dist.sh 和 package.json 的命令/依赖声明；本轮未重新构建或启动产品，未升级验收状态。原 README 保存在 README.before.md。progress 仅新增文档更新指针；没有修改产品代码、分发脚本或历史交付状态，没有提交或推送。
