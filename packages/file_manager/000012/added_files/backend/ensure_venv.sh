#!/bin/bash
# backend/.venv を用意する（macOS/Linux 用）。
#
# start.sh / start_dev.sh から source して ensure_backend_venv を呼ぶ。単独で実行してもよい。
# 呼んだあとは BACKEND_PYTHON に backend/.venv/bin/python が入り、サーバーはこの Python で起動する
# （uv run やシステムの python には頼らない）。
#
# 仕様:
# - uv がある場合: 毎回 `uv sync --frozen --inexact` で uv.lock どおりに揃える。
#   Python は backend/.python-version（3.14.9）を使う。venv が壊れている・バージョンが違う場合は uv が作り直す。
#   --inexact なので、手で追加したパッケージは消さない。
# - uv がない場合: .venv の Python が動かなければ `python3 -m venv --clear` で作り直し、
#   fastapi / uvicorn が import できなければ requirements.txt を pip で入れる。

ensure_backend_venv() {
    local backend_dir
    backend_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local venv_python="$backend_dir/.venv/bin/python"

    if command -v uv >/dev/null 2>&1; then
        echo "Syncing backend/.venv with uv.lock..."
        (cd "$backend_dir" && uv sync --frozen --inexact --quiet)
    else
        if ! "$venv_python" -c "" >/dev/null 2>&1; then
            echo "Creating backend/.venv with $(python3 -V 2>&1)..."
            python3 -m venv --clear "$backend_dir/.venv"
        fi
        if ! "$venv_python" -c "import fastapi, uvicorn" >/dev/null 2>&1; then
            echo "Installing backend requirements into backend/.venv..."
            "$venv_python" -m pip install -r "$backend_dir/requirements.txt"
        fi
    fi

    if ! "$venv_python" -c "import fastapi, uvicorn" >/dev/null 2>&1; then
        echo "backend/.venv の準備に失敗しました: $venv_python" >&2
        return 1
    fi
    BACKEND_PYTHON="$venv_python"
    echo "Backend Python: $("$BACKEND_PYTHON" -V 2>&1) ($BACKEND_PYTHON)"
}

# 単独で実行されたときは venv を用意するだけ
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    set -Eeuo pipefail
    ensure_backend_venv
fi
