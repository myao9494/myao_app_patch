#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"
PORT="${SPOONFEEDER_PORT:-8077}"
HOST="${SPOONFEEDER_HOST:-127.0.0.1}"

# 既存のリスナーを起動前に終了する。lsofがない環境では安全のため何もしない。
if command -v lsof >/dev/null 2>&1; then
  EXISTING_PIDS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  for PID in $EXISTING_PIDS; do
    [ "$PID" = "$$" ] && continue
    kill "$PID" 2>/dev/null || true
  done
  for PID in $EXISTING_PIDS; do
    [ "$PID" = "$$" ] && continue
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$PID" 2>/dev/null; then
      kill -KILL "$PID" 2>/dev/null || true
    fi
  done
fi
if [ ! -f frontend/dist/index.html ]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "frontend/dist がありません。Node.jsを導入してフロントエンドをビルドしてください。" >&2
    exit 1
  fi
  npm install --prefix frontend
  npm run build --prefix frontend
fi
if [ ! -f frontend/dist/index.html ]; then
  echo "フロントエンドのビルドに失敗しました。" >&2
  exit 1
fi
if [ -x .venv/bin/python ]; then PYTHON=.venv/bin/python
elif [ -x venv/bin/python ]; then PYTHON=venv/bin/python
else PYTHON=python3
fi
exec "$PYTHON" -m uvicorn backend.main:app --host "$HOST" --port "$PORT"
