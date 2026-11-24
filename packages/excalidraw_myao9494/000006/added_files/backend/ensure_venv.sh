#!/bin/bash
# backend/.venv を用意する（macOS / Linux 用）。
#
# start_servers.sh・start_dev.sh・backend/start_server.sh が起動前に実行する。単独で実行してもよい。
# 終わったら backend/.venv/bin/python で fastapi / uvicorn が動く状態になっている（失敗したら終了コード 1）。
#
# 仕様:
# - .venv の Python が動かない・3.14 でない（3.12 で作った古い venv など）ときは
#   python3（3.14）で `python3 -m venv --clear` して作り直す。消すのは .venv の中身だけ
# - requirements-lock.txt（版固定）を pip で入れる。入れたあと .venv/.requirements-lock.installed を置き、
#   requirements-lock.txt がそれより新しくなったときだけ入れ直す（毎回の起動では pip を呼ばない）
# - uv は使わない（Windows の setup_windows.bat と同じ手順・同じ版にそろえるため）

set -Eeuo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$BACKEND_DIR/.venv"
VENV_PY="$VENV_DIR/bin/python"
LOCK_FILE="$BACKEND_DIR/requirements-lock.txt"
MARKER="$VENV_DIR/.requirements-lock.installed"
IS_314='import sys; sys.exit(0 if sys.version_info[:2] == (3, 14) else 1)'

if ! "$VENV_PY" -c "$IS_314" >/dev/null 2>&1; then
    if ! python3 -c "$IS_314" >/dev/null 2>&1; then
        echo "エラー: Python 3.14 の python3 が見つかりません（現在: $(python3 -V 2>&1 || echo なし)）。" >&2
        exit 1
    fi
    echo "backend/.venv を $(python3 -V 2>&1) で作成します..."
    python3 -m venv --clear "$VENV_DIR"
    rm -f "$MARKER"
fi

if [ ! -f "$MARKER" ] || [ "$LOCK_FILE" -nt "$MARKER" ]; then
    echo "backend/.venv に requirements-lock.txt を入れます..."
    "$VENV_PY" -m pip install --quiet --upgrade pip
    "$VENV_PY" -m pip install --quiet -r "$LOCK_FILE"
    touch "$MARKER"
fi

if ! "$VENV_PY" -c "import fastapi, uvicorn, lzstring, multipart" >/dev/null 2>&1; then
    echo "エラー: backend/.venv に必要なパッケージが入っていません。backend/.venv を消してやり直してください。" >&2
    exit 1
fi
echo "Python: $("$VENV_PY" -V 2>&1) ($VENV_PY)"
