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
# Pythonは常に .venv（Python 3.14）を使う。Windowsの setup_windows.bat と同じ手順で用意する。
# - .venv のPythonが動かない・3.14でないときは python3（3.14）で作り直す（消すのは .venv の中身だけ）
# - backend/requirements-lock.txt が前回入れたときより新しければ入れ直す（.venv/.requirements-lock.installed で判定）
PYTHON=.venv/bin/python
IS_314='import sys; sys.exit(0 if sys.version_info[:2] == (3, 14) else 1)'
MARKER=.venv/.requirements-lock.installed
if ! "$PYTHON" -c "$IS_314" >/dev/null 2>&1; then
  if ! python3 -c "$IS_314" >/dev/null 2>&1; then
    echo "Python 3.14 の python3 が見つかりません（現在: $(python3 -V 2>&1 || echo なし)）。" >&2
    exit 1
  fi
  echo "Python 3.14 で .venv を作成します..."
  python3 -m venv --clear .venv
  rm -f "$MARKER"
fi
if [ ! -f "$MARKER" ] || [ backend/requirements-lock.txt -nt "$MARKER" ]; then
  echo "backend/requirements-lock.txt を .venv に入れます..."
  "$PYTHON" -m pip install --quiet --upgrade pip
  "$PYTHON" -m pip install --quiet -r backend/requirements-lock.txt
  touch "$MARKER"
fi
exec "$PYTHON" -m uvicorn backend.main:app --host "$HOST" --port "$PORT"
