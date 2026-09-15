#!/usr/bin/env bash
# Build a self-contained local distribution of Atlas.
#
# Usage: bash scripts/dist.sh
#
# Produces dist/atlas-local-<os>-<arch>/ containing:
#   atlas                       release binary (web assets embedded)
#   workers/typescript/         indexing worker + typescript package
#   start.sh                    one-command launcher (see below)
#   README.md                   short usage notes
#
# The script is idempotent: it rebuilds the target directory from scratch.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

echo "==> cargo build --release --locked"
cargo build --release --locked
binary="target/release/atlas"
if [ ! -x "$binary" ]; then
  echo "error: $binary not found after build" >&2
  exit 1
fi

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) os_name="darwin" ;;
  *) echo "error: unsupported OS '$os' (this script currently packages macOS builds)" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64) arch_name="x64" ;;
  arm64 | aarch64) arch_name="arm64" ;;
  *) echo "error: unsupported architecture '$arch'" >&2; exit 1 ;;
esac
name="atlas-local-${os_name}-${arch_name}"
dist="dist/$name"

echo "==> assembling $dist"
rm -rf "$dist"
mkdir -p "$dist/workers/typescript"

cp "$binary" "$dist/atlas"
chmod +x "$dist/atlas"

# Language worker closure (verified: worker.mjs -> src/parse.mjs -> src/flow.mjs
# -> 'typescript'; the typescript package has no compile-time dependencies, so
# the whole package is copied as-is).
cp workers/typescript/worker.mjs "$dist/workers/typescript/worker.mjs"
cp -R workers/typescript/src "$dist/workers/typescript/src"
mkdir -p "$dist/workers/typescript/node_modules"
cp -R workers/typescript/node_modules/typescript "$dist/workers/typescript/node_modules/typescript"
cp workers/typescript/package.json "$dist/workers/typescript/package.json"

cat > "$dist/start.sh" <<'START_SH'
#!/usr/bin/env bash
# Atlas launcher: index a project, then serve the workbench on a loopback port.
# Usage: ./start.sh [项目路径]   (默认当前目录;store 固定在 ~/.atlas/store,可用 ATLAS_STORE 覆盖)
set -euo pipefail

DIST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- 平台防呆 ----------------------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"
case "$os/$arch" in
  Darwin/x86_64 | Darwin/arm64 | Darwin/aarch64) : ;;
  *)
    echo "错误:此分发包只支持 macOS(darwin-arm64 / darwin-x64)。" >&2
    echo "当前平台:${os}-${arch},请在对应平台重新打包(bash scripts/dist.sh)。" >&2
    exit 1
    ;;
esac

# --- Node 依赖检查(worker 为纯 ESM,依赖 typescript 5.9.3)---------------------
if ! command -v node >/dev/null 2>&1; then
  echo "错误:未找到 node。Atlas 的索引需要 Node.js >= 18,受控运行还需要 >= 20 的权限模型。" >&2
  echo "安装指引:" >&2
  echo "  brew install node          # macOS + Homebrew" >&2
  echo "  或从 https://nodejs.org 下载并安装 LTS 版本,然后重新打开终端再试。" >&2
  exit 1
fi
node_version="$(node --version 2>/dev/null || true)"
node_major="$(printf '%s' "$node_version" | sed -E 's/^v([0-9]+).*$/\1/')"
case "$node_major" in
  '' | *[!0-9]*) node_major=0 ;;
esac
if [ "$node_major" -lt 18 ]; then
  echo "错误:node 版本过低(检测到 ${node_version:-未知}),索引至少需要 18。" >&2
  echo "升级指引:brew upgrade node,或从 https://nodejs.org 安装 LTS 版本后重开终端。" >&2
  exit 1
fi
# --- 受控运行能力实测:权限模型是否真的会拒绝 ---------------------------------
# 只检查版本号会承诺一件没验证过的事。Atlas 每次受控运行前都会做同样的探针:
# 真正尝试一次写入并要求被拒绝。这里提前做一次,是为了让人在启动前就知道
# "运行函数"能不能用,而不是等到点了按钮才看到 permission_model_unavailable。
# NODE_OPTIONS 里的预加载脚本会干扰探针,所以像 Atlas 一样清掉它。
probe_out="$(env -u NODE_OPTIONS node --permission --eval "const fs=require('fs');const p='/tmp/atlas-probe-'+process.pid;try{fs.writeFileSync(p,'x');try{fs.unlinkSync(p)}catch{};console.log('ATLAS_PROBE=ALLOWED')}catch(e){console.log('ATLAS_PROBE=DENIED:'+(e&&e.code))}" 2>/dev/null || true)"
case "$probe_out" in
  *ATLAS_PROBE=DENIED*) run_capable=yes ;;
  *) run_capable=no ;;
esac

# --- 项目路径 ----------------------------------------------------------------
PROJECT="${1:-$PWD}"
if [ ! -e "$PROJECT" ]; then
  echo "错误:项目路径不存在:${PROJECT}" >&2
  exit 1
fi
if [ ! -r "$PROJECT" ]; then
  echo "错误:项目路径不可读:${PROJECT}" >&2
  exit 1
fi
PROJECT="$(cd "$PROJECT" && pwd)"

# --- store(跨次运行保留)-----------------------------------------------------
STORE="${ATLAS_STORE:-$HOME/.atlas/store}"
mkdir -p "$STORE"
WORKER="$DIST/workers/typescript/worker.mjs"
# 端口按项目路径稳定推导:随机端口会让每次启动都是新 origin,浏览器本地存储
# 与"上次任务"都会丢。服务在端口被占用时自动回退到随机端口。
port=$(( 30000 + ( $(printf '%s' "$PROJECT" | cksum | awk '{print $1}') % 20000 ) ))
# --project:任务状态按项目身份保存,因此重新索引同一项目(analysis id 会变)后
# 仍能接着上次的任务;不同项目的同名函数不会串状态。
serve_args=(--port "$port" --worker "$WORKER" --project "$PROJECT")
# 声明的测试命令(不是 shell 字符串):验证时会在隔离副本里执行它,退出码作为
# 观测证据。未声明时验证如实写"没有跑任何测试,这不是通过"。
if [ -n "${ATLAS_TEST_ARGV:-}" ]; then
  # shellcheck disable=SC2086
  node -e 'const a=JSON.parse(process.argv[1]);if(!Array.isArray(a)||!a.length||a.some(x=>typeof x!=="string")){console.error("ATLAS_TEST_ARGV 必须是非空 JSON 字符串数组");process.exit(1)}' "$ATLAS_TEST_ARGV" || exit 1
  serve_args+=(--test-argv "$ATLAS_TEST_ARGV")
fi
if [ -n "${ATLAS_TEST_TIMEOUT_MS:-}" ];then serve_args+=(--test-timeout-ms "$ATLAS_TEST_TIMEOUT_MS");fi

index_out="$(mktemp)"
serve_out="$(mktemp)"
cleanup_files() { rm -f "$index_out" "$serve_out"; }
trap cleanup_files EXIT

# --- 索引(Ctrl-C 即取消,signal 处理由二进制内置)-----------------------------
echo "正在索引 ${PROJECT} …"
"$DIST/atlas" --store "$STORE" index "$PROJECT" --worker "$WORKER" >"$index_out"
analysis_id="$(sed -n -E 's/.*"id"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$index_out" | head -n 1)"
if [ -z "$analysis_id" ]; then
  echo "错误:索引输出中没有 analysis id,原始输出如下:" >&2
  cat "$index_out" >&2
  exit 1
fi
echo "索引完成:analysis id = ${analysis_id}"

# --- 启动服务 ----------------------------------------------------------------
"$DIST/atlas" --store "$STORE" serve "$analysis_id" "${serve_args[@]}" --allow-writes "$PROJECT" >"$serve_out" 2>&1 &
serve_pid=$!
stopped=0
shutdown() {
  [ "$stopped" -eq 1 ] && return 0
  stopped=1
  kill "$serve_pid" 2>/dev/null || true
  wait "$serve_pid" 2>/dev/null || true
  echo
  echo "服务已停止。索引与运行记录都保留在 ${STORE},再次启动会复用。"
}
trap shutdown EXIT INT TERM

for _ in $(seq 1 100); do
  [ -s "$serve_out" ] && break
  kill -0 "$serve_pid" 2>/dev/null || break
  sleep 0.1
done

session_file="$(sed -n -E 's/.*"session_file"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$serve_out" | head -n 1)"
if [ -z "$session_file" ] || [ ! -f "$session_file" ]; then
  echo "错误:服务启动失败,输出如下:" >&2
  cat "$serve_out" >&2
  exit 1
fi
url="$(sed -n -E 's/.*"url"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$session_file" | head -n 1)"
token="$(sed -n -E 's/.*"token"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$session_file" | head -n 1)"

echo
echo "Atlas 已就绪,在浏览器打开:"
echo "  ${url}#token=${token}"
echo "(会话令牌只经本机 URL fragment 传递,不进入任何 HTTP 请求或日志,等同启动密钥)"
echo "Ctrl-C 停止服务;数据保留在 ${STORE}。"
echo "停止后再启动同一项目会回到同一个端口与同一份上次任务(选区/页签/输入草稿)。"
echo "若上一个实例仍占着该端口,本次会回退到随机端口:页面照常可用,只是浏览器本地缓存不再共享。"
if [ "$run_capable" = "no" ];then
  echo
  echo "注意:当前 node(${node_version}) 的权限模型没有真的拒绝未授权写入,"
  echo "因此「运行函数」会被 Atlas 拒绝(查找、关系、源码、提案审阅仍可用)。"
  echo "请安装 Node.js >= 20 后重开终端再启动。"
else
  echo "受控运行能力:已实测权限模型会拒绝未授权写入(${node_version})。"
fi
echo

wait "$serve_pid"
START_SH
chmod +x "$dist/start.sh"

cat > "$dist/README.md" <<'README_MD'
# Atlas 本地分发包

## 这是什么

Atlas 是一个完全本地的代码探索、执行与变更评审工作台。这个包内含一个独立的
`atlas` 可执行文件(网页界面已内嵌其中)和 TypeScript 索引 worker(自带
typescript 5.9.3)。不需要源码仓库,不需要 Cargo 或 Python。

## 最短启动

把整个目录拷贝到任意位置后,在目录里执行:

    ./start.sh /path/to/your/project

(路径省略时索引当前目录。)索引完成后,脚本会打印形如
`http://127.0.0.1:<端口>/#token=…` 的地址,在浏览器打开即可。
会话令牌只经本机 URL fragment 传递,等同启动密钥。
索引与运行记录保存在 `~/.atlas/store`(可用环境变量 `ATLAS_STORE` 覆盖),
跨次运行保留;Ctrl-C 停止服务,数据不丢失。

## 打开自己的项目后的几条说明

- **受控运行**在函数自己的隔离副本里执行,权限由 Node 权限模型强制。启动脚本会
  实测一次「未授权写入确实被拒绝」;不通过时会明确告诉你「运行函数」不可用,
  而查找、关系、源码与提案审阅仍然可用。实测通过意味着当前 Node(通常 >= 20)
  具备这个能力。
- **验证提案**会从不可变快照物化隔离副本并重新派生分析。想让验证同时跑测试,
  用 `ATLAS_TEST_ARGV='["node","--test"]' ./start.sh <项目>` 声明(必须是 JSON
  数组,不是 shell 字符串)。未声明时验证如实写「没有跑任何测试,这不是通过」。
  也可以稍后在页面「项目 → 项目设置」里声明或更新测试命令:保存即对之后的
  每一次验证生效,并随 store 保留(重启服务后仍然有效)。
- **停止再启动**:同一项目会回到同一个端口,并恢复上次的选区、任务页签和输入
  草稿(按项目身份保存在 store 里,不同项目互不串用)。若上一个实例还占着该端口,
  本次会回退到随机端口——页面照常可用,只是浏览器自身的本地缓存不再共享。
- **写入**:只有启动时指定的项目目录可以被写入,页面必须逐字回显它;其他路径
  一律拒绝。

## 已验证平台与依赖

- 已验证平台:macOS darwin-x64(Node 26.5.1)
- 依赖:Node.js >= 18(索引)/ >= 20(受控运行,且以启动时的实测探针为准)
- 无需:Cargo、Python、Atlas 仓库源码
- 未验证:Windows、Linux、其他架构、干净机器首次启动
README_MD

echo "==> done: $dist"
du -sh "$dist"
