#!/bin/bash
# backend/.venv を用意する（macOS / Linux 用）。
#
# start_app.sh / start_dev.sh から source して ensure_backend_venv を呼ぶ。単独で実行してもよい。
# 呼んだあとは BACKEND_PYTHON に backend/.venv/bin/python が入り、サーバーはこの Python で起動する
# （uv run やシステムの python には頼らない）。
#
# 仕様:
# - uv がある場合: 毎回 `uv sync --frozen --inexact` で uv.lock どおりに揃える。
#   Python は backend/.python-version（3.14.9）を使う。venv が壊れている・版が違うときは uv が作り直す。
#   --inexact なので、手で追加したパッケージは消さない。
# - uv がない場合: .venv の Python が動かない・3.14 でないときは python3（3.14）で
#   `python3 -m venv --clear` して作り直し、fastapi / uvicorn / sqlalchemy が import できなければ
#   requirements-lock.txt（uv.lock と同じ版）を pip で入れる。Windows の setup_windows.bat と同じ手順。

ensure_backend_venv() {
    local backend_dir
    backend_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local venv_python="$backend_dir/.venv/bin/python"
    local is_314='import sys; sys.exit(0 if sys.version_info[:2] == (3, 14) else 1)'
    local check_imports='import fastapi, uvicorn, sqlalchemy, multipart'

    if command -v uv >/dev/null 2>&1; then
        echo "Syncing backend/.venv with uv.lock..."
        (cd "$backend_dir" && uv sync --frozen --inexact --quiet) || return 1
    else
        if ! "$venv_python" -c "$is_314" >/dev/null 2>&1; then
            if ! python3 -c "$is_314" >/dev/null 2>&1; then
                echo "エラー: Python 3.14 の python3 が見つかりません（現在: $(python3 -V 2>&1 || echo なし)）。" >&2
                return 1
            fi
            echo "Creating backend/.venv with $(python3 -V 2>&1)..."
            python3 -m venv --clear "$backend_dir/.venv" || return 1
        fi
        if ! "$venv_python" -c "$check_imports" >/dev/null 2>&1; then
            echo "Installing backend/requirements-lock.txt into backend/.venv..."
            "$venv_python" -m pip install --quiet --upgrade pip
            "$venv_python" -m pip install -r "$backend_dir/requirements-lock.txt" || return 1
        fi
    fi

    if ! "$venv_python" -c "$check_imports" >/dev/null 2>&1; then
        echo "エラー: backend/.venv の準備に失敗しました: $venv_python" >&2
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
