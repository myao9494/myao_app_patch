#!/bin/bash
set -Eeuo pipefail

# サーバー起動スクリプト (開発用)
# 指定されたポートが使用されている場合はプロセスを終了してから、
# バックエンドとフロントエンドdevサーバーを両方起動する。
#
# 使用方法:
#   ./start_dev.sh

BACKEND_PORT=8001
FRONTEND_PORT=5173
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_PID=""
FRONTEND_PID=""

# 関数: ポートを使用しているプロセスを終了する
kill_port_process() {
    local port=$1
    echo "Checking port $port..."
    local pids
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$pids" ]; then
        echo "Port $port is in use by PID(s): $pids. Killing processes..."
        kill $pids 2>/dev/null || true
        for _ in {1..20}; do
            if ! lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
                echo "Port $port is now free."
                return
            fi
            sleep 0.25
        done
        echo "Graceful shutdown timed out. Forcing remaining process(es) to stop..."
        pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
        if [ -n "$pids" ]; then
            kill -9 $pids 2>/dev/null || true
        fi
        echo "Port $port is now free."
    else
        echo "Port $port is free."
    fi
}

cleanup() {
    for pid in "$FRONTEND_PID" "$BACKEND_PID"; do
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
        fi
    done
}

trap cleanup EXIT INT TERM

cd "$PROJECT_DIR"

echo "Stopping existing servers..."
kill_port_process $BACKEND_PORT
kill_port_process $FRONTEND_PORT

echo "Starting Backend server (Port $BACKEND_PORT)..."
cd "$PROJECT_DIR/backend"

# backend/.venv を用意し、その Python で起動する（詳細は backend/ensure_venv.sh）
source "$PROJECT_DIR/backend/ensure_venv.sh"
ensure_backend_venv
PYTHONPATH=. "$BACKEND_PYTHON" -m uvicorn app.main:app --reload --host 127.0.0.1 --port $BACKEND_PORT &
BACKEND_PID=$!
cd "$PROJECT_DIR"

# バックエンドが起動するのを待つ
echo "Waiting for Backend to respond on http://localhost:$BACKEND_PORT ..."
max_attempts=15
attempt=1
while ! curl --fail --silent "http://127.0.0.1:$BACKEND_PORT/api/config" > /dev/null; do
    if [ $attempt -ge $max_attempts ]; then
        echo "Backend failed to start in time."
        exit 1
    fi
    printf "."
    sleep 1
    attempt=$((attempt + 1))
done
echo " Backend is ready!"

# 開発モード: フロントエンドdevサーバーも起動
echo "Starting Frontend server (Port $FRONTEND_PORT)..."
cd "$PROJECT_DIR/frontend"

# フロントエンド起動コマンドの決定
if command -v pnpm >/dev/null 2>&1; then
    echo "Using pnpm for frontend..."
    pnpm run dev &
else
    echo "pnpm not found. Falling back to npm..."
    npm run dev &
fi
FRONTEND_PID=$!
cd "$PROJECT_DIR"

echo "---------------------------------------"
echo "Development mode: Servers are running."
echo "Frontend: http://localhost:$FRONTEND_PORT"
echo "Backend API: http://localhost:$BACKEND_PORT/api"
echo "Press Ctrl+C to stop both servers."
echo "---------------------------------------"

# Trap CTRL+C to kill both background processes
wait -n "$BACKEND_PID" "$FRONTEND_PID"
