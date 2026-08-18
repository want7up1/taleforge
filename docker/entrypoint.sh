#!/usr/bin/env bash
# 依次拉起 dsh 运行时与 BFF；任一进程退出即整体退出，交给 Docker restart 策略。
set -euo pipefail

cd /app
mkdir -p "$DSH_HOME"

echo "[entrypoint] 启动 dsh 运行时…"
node_modules/.bin/dsh web --patch runtime/patch.web.yml &
DSH_PID=$!

echo "[entrypoint] 等待 dsh 网关就绪…"
for _ in $(seq 1 90); do
  if node -e "fetch('http://127.0.0.1:3090/').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "[entrypoint] dsh 已就绪"
    break
  fi
  if ! kill -0 "$DSH_PID" 2>/dev/null; then
    echo "[entrypoint] dsh 启动失败，退出" >&2
    exit 1
  fi
  sleep 1
done

echo "[entrypoint] 启动 BFF…"
node apps/bff/src/index.ts &
BFF_PID=$!

trap 'kill -TERM "$DSH_PID" "$BFF_PID" 2>/dev/null || true' TERM INT

wait -n "$DSH_PID" "$BFF_PID"
EXIT=$?
echo "[entrypoint] 有子进程退出（code=$EXIT），停止容器"
kill -TERM "$DSH_PID" "$BFF_PID" 2>/dev/null || true
exit "$EXIT"
