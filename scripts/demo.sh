#!/usr/bin/env bash
# 打开就能玩：索引随仓库附带的演示项目，起本地服务，打印**带会话令牌的地址**。
#
# 为什么要有这一条：Atlas 的价值只有在屏幕上才能被判断，而此前要看到它，
# 得先自己造项目、自己 index、自己 serve、再去 session 文件里抄 token。
# 那段仪式感不是安全设计的一部分——令牌仍然只存在于本地会话文件里、
# 仍然只经 URL fragment 传递（fragment 不进 HTTP 请求），只是不用手抄了。
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${ATLAS_DEMO_PORT:-0}"   # 0 = 由系统挑一个空闲端口，避免撞上别的 atlas
STORE="${ATLAS_DEMO_STORE:-local-state/demo-tour}"
PROJECT="examples/tour"
BIN="./target/debug/atlas"

if [ ! -x "$BIN" ]; then
  echo "先构建：cargo build" >&2
  exit 1
fi
if [ ! -d "$PROJECT" ]; then
  echo "找不到演示项目 ${PROJECT}" >&2
  exit 1
fi

echo "① 索引演示项目 ${PROJECT} → ${STORE}"
ANALYSIS=$("$BIN" --store "$STORE" index "$PROJECT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "   分析版本 ${ANALYSIS:0:12}…"

# 清掉上一轮遗留的会话文件：被强杀的服务不会自己清理它，
# 而脚本会把它当成"这一轮的会话"，于是打印出一个**已经死掉的地址**——第一版就踩了这个坑。
rm -f "${STORE}"/web-session-*.json

echo "② 起服务（端口 ${PORT}）。停止：Ctrl-C"
"$BIN" --store "$STORE" serve "$ANALYSIS" --port "${PORT}" >/tmp/atlas-demo-serve.log 2>&1 &
SERVE_PID=$!
trap 'kill ${SERVE_PID} 2>/dev/null || true' EXIT

# 等会话文件出现；同时盯着服务进程——端口被占之类的失败要当场说出来，
# 而不是让脚本报"服务没起来"、而浏览器其实连到了**另一个** atlas 实例上。
for _ in $(seq 1 60); do
  if ! kill -0 "${SERVE_PID}" 2>/dev/null; then
    echo "服务启动失败：" >&2
    tail -3 /tmp/atlas-demo-serve.log >&2
    exit 1
  fi
  SESSION=$(ls -t "${STORE}"/web-session-*.json 2>/dev/null | head -1 || true)
  [ -n "${SESSION:-}" ] && break
  sleep 0.25
done
if [ -z "${SESSION:-}" ]; then
  echo "服务没有在 15 秒内写出会话文件，看 /tmp/atlas-demo-serve.log" >&2
  exit 1
fi
# 地址与令牌都从会话文件里读回来：脚本不猜端口，也不猜令牌。
read -r BASE TOKEN < <(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["url"],d["token"])' "$SESSION")

cat <<TXT

────────────────────────────────────────────────────────────
  打开这一行（已带令牌，fragment 不会进入 HTTP 请求）：

  ${BASE}#token=${TOKEN}

  想先看 3D：把路径换成 /city3d （同样带令牌）
────────────────────────────────────────────────────────────

页面上有一条"试这五步"的引导；每一步都能自己点。做不到的地方页面会明说。
服务在前台运行，Ctrl-C 结束。
TXT

wait ${SERVE_PID}
