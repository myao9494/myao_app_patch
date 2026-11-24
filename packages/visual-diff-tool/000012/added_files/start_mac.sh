#!/usr/bin/env bash
#
# 画像差分ツール (Visual Diff Tool) サーバー起動スクリプト (macOS用)
# - 指定したポートで稼働中の既存のサーバープロセスを終了させる
# - Python仮想環境 (.venv) が Python 3.14 で動くか確認し、壊れている・版が違う場合は再作成する
# - 版を固定した依存パッケージ（requirements-lock.txt）をインストールし、Backend APIを起動する
#
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-8078}"
PIDS="$(lsof -ti tcp:"$PORT" || true)"
if [ -n "$PIDS" ]; then
  echo "Stopping existing server on port $PORT: $PIDS"
  kill $PIDS || true
  sleep 1
  REMAINING_PIDS="$(lsof -ti tcp:"$PORT" || true)"
  if [ -n "$REMAINING_PIDS" ]; then
    echo "Force stopping server on port $PORT: $REMAINING_PIDS"
    kill -9 $REMAINING_PIDS || true
  fi
fi

# Python は 3.14（.python-version）。.venv が無い・壊れている・3.14 でない（古い Python で作った）ときは作り直す
IS_314='import sys; sys.exit(0 if sys.version_info[:2] == (3, 14) else 1)'
if ! .venv/bin/python -c "$IS_314" >/dev/null 2>&1; then
  if ! python3 -c "$IS_314" >/dev/null 2>&1; then
    echo "Error: Python 3.14 の python3 が見つかりません（現在: $(python3 -V 2>&1 || echo なし)）" >&2
    exit 1
  fi
  echo "Creating .venv with $(python3 -V 2>&1)..."
  python3 -m venv --clear .venv
fi

# 版を固定した一覧を入れる（Windows の setup_windows.bat と同じ。入っていれば何もしない）
.venv/bin/python -m pip install -r requirements-lock.txt
cd backend
../.venv/bin/python run.py
