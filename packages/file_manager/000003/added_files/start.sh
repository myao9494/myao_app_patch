#!/bin/bash
set -Eeuo pipefail

# サーバー起動スクリプト (本番用 / PWA配信)
# 指定されたポートが使用されている場合はプロセスを終了してから、
# バックエンドを起動し、フロントエンドのビルド済みファイルを配信する。
#
# 使用方法:
#   ./start.sh

BACKEND_PORT=8001
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_PID=""

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
    if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
        echo "Stopping server..."
        kill "$BACKEND_PID" 2>/dev/null || true
        wait "$BACKEND_PID" 2>/dev/null || true
    fi
}

trap cleanup EXIT INT TERM

cd "$PROJECT_DIR"

echo "Stopping existing server..."
kill_port_process $BACKEND_PORT

# フロントエンドのビルドを実行（常に実行して最新の変更を反映）
echo "Building frontend..."
cd "$PROJECT_DIR/frontend"
npm run build
cd "$PROJECT_DIR"

if [ -d "$PROJECT_DIR/frontend-quick" ]; then
    echo "Building frontend-quick..."
    cd "$PROJECT_DIR/frontend-quick"
    npm run build
    cd "$PROJECT_DIR"
fi

echo "Starting Backend server (Port $BACKEND_PORT)..."
cd "$PROJECT_DIR/backend"

# バックエンド起動コマンドの決定
if command -v uv >/dev/null 2>&1; then
    echo "Using uv for backend..."
    uv run uvicorn app.main:app --host 0.0.0.0 --port $BACKEND_PORT &
else
    if [ -d ".venv" ]; then
        source .venv/bin/activate
    fi
    PYTHONPATH=. python -m uvicorn app.main:app --host 0.0.0.0 --port $BACKEND_PORT &
fi
BACKEND_PID=$!
cd ..

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

# 本番モード: バックエンドのみ（フロントエンドはビルド済みから配信）
echo "---------------------------------------"
echo "Production mode: Backend is serving the frontend."
echo "App:   http://localhost:$BACKEND_PORT"
echo "Quick: http://localhost:$BACKEND_PORT/quick/"
echo "API:   http://localhost:$BACKEND_PORT/api"
echo "Press Ctrl+C to stop the server."
echo "---------------------------------------"

wait "$BACKEND_PID"
