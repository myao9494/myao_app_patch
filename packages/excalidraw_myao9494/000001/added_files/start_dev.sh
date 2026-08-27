#!/bin/zsh

# 開発用サーバー一括起動スクリプト
# Vite開発サーバー(HMR, port 3001)とバックエンドAPIサーバー(FastAPI, port 8008)を同時に起動
# 起動時に使用中ポート（3001, 8008）の既存プロセスを自動解放し、終了時にも確実にクリーンアップを行う

set -e

echo "=== Excalidraw 開発用サーバーの起動を開始します ==="

# プロジェクトディレクトリに移動
cd "$(dirname "$0")"

# 指定portの待受プロセスを停止する。まずTERMで正常終了を待ち、
# 残った場合だけKILLする。
free_port() {
    local port=$1
    local pids
    pids=$(lsof -tiTCP:$port -sTCP:LISTEN 2>/dev/null || true)
    if [ -z "$pids" ]; then
        return 0
    fi

    echo "Port $port の既存プロセスを停止します (PID: $pids)..."
    echo "$pids" | xargs kill 2>/dev/null || true

    local remaining
    for _ in {1..50}; do
        remaining=$(lsof -tiTCP:$port -sTCP:LISTEN 2>/dev/null || true)
        if [ -z "$remaining" ]; then
            echo "Port $port を解放しました。"
            return 0
        fi
        sleep 0.1
    done

    echo "正常終了しなかったプロセスを強制停止します (PID: $remaining)..."
    echo "$remaining" | xargs kill -9 2>/dev/null || true
    sleep 0.2

    remaining=$(lsof -tiTCP:$port -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "$remaining" ]; then
        echo "エラー: Port $port を解放できませんでした (PID: $remaining)。"
        exit 1
    fi
}

# 使用ポートの事前解放（ViteとFastAPIは別ポート）
free_port 3001
free_port 8008

# バックエンドサーバーの起動（Vite proxy先）
echo "バックエンドサーバーを起動中... (port 8008)"
(cd backend && {
    if [ -d ".venv" ]; then
        .venv/bin/python -m uvicorn main:app --reload --host 0.0.0.0 --port 8008
    elif [ -d "venv" ]; then
        ./venv/bin/python -m uvicorn main:app --reload --host 0.0.0.0 --port 8008
    else
        python -m uvicorn main:app --reload --host 0.0.0.0 --port 8008
    fi
}) &
BACKEND_PID=$!

# フロントエンド開発サーバーの起動（Vite）
echo "フロントエンド開発サーバーを起動中... (Vite)"
npm start & # package.jsonの "start": "vite" を実行
FRONTEND_PID=$!

# プロセス終了処理
cleanup() {
    echo ""
    echo "=== サーバーを停止しています ==="
    kill $BACKEND_PID 2>/dev/null || true
    kill $FRONTEND_PID 2>/dev/null || true
    # 子プロセスが残存している場合に備えてポートを解放
    free_port 3001
    free_port 8008
    echo "すべてのサーバーが停止されました"
    exit 0
}

# Ctrl+Cで終了時にクリーンアップ
trap cleanup SIGINT SIGTERM

echo ""
echo "=== 開発用サーバー起動完了 ==="
echo "フロントエンド (Vite): http://localhost:3001"
echo "バックエンド API:    http://localhost:8008 (Viteからproxy)"
echo ""
echo "※ 本番PWAはFastAPIのみをport 3001で起動します。"
echo "停止するには Ctrl+C を押してください"

# バックグラウンドプロセスの完了を待機
wait

