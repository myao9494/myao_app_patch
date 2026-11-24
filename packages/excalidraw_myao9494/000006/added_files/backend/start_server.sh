#!/bin/bash
# FastAPI だけを開発用（port 8008、自動リロード）で起動する。backend/.venv の Python を使う
set -e
cd "$(dirname "$0")"
./ensure_venv.sh
.venv/bin/python -m uvicorn main:app --reload --host 0.0.0.0 --port 8008
