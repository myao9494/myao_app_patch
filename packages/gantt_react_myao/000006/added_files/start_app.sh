#!/bin/bash

# スクリプトの場所（プロジェクトルート）を基準に動く。バックエンドは backend/.venv の Python で起動する
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

BACKEND_PORT=8000

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting Gantt Chart Application...${NC}"

# Function to kill process on a port
kill_port() {
    local port=$1
    local pid=$(lsof -t -i:$port)
    if [ -n "$pid" ]; then
        echo -e "${RED}Port $port is in use by PID $pid. Killing it...${NC}"
        kill -9 $pid
    else
        echo "Port $port is free."
    fi
}

echo "-----------------------------------"
echo "Cleaning up ports..."
echo "-----------------------------------"
kill_port $BACKEND_PORT

echo ""
echo "-----------------------------------"
echo "Building Frontend..."
echo "-----------------------------------"
cd frontend
# 依存関係のインストール（必要に応じて）
npm install
npm run build
cd ..

echo ""
echo "-----------------------------------"
echo "Starting Backend (Serving Frontend)..."
echo "-----------------------------------"
# backend/.venv（Python 3.14）を用意する（詳細は backend/ensure_venv.sh）
source "$ROOT_DIR/backend/ensure_venv.sh"
ensure_backend_venv || exit 1
cd backend
"$BACKEND_PYTHON" -m uvicorn main:app --reload --host 0.0.0.0 --port $BACKEND_PORT &
BACKEND_PID=$!
cd ..

echo ""
echo -e "${GREEN}Application started!${NC}"
echo "Backend PID: $BACKEND_PID"
echo "Access URL: http://localhost:$BACKEND_PORT"
echo ""
echo "Press Ctrl+C to stop the server."

# Trap to kill process when script exits
trap "echo 'Stopping server...'; kill $BACKEND_PID; exit" EXIT

# Wait for process
wait $BACKEND_PID
