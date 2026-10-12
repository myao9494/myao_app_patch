#!/bin/zsh

# サーバー一括起動スクリプト（M1 Mac / Python標準ライブラリ対応）
# バックエンドサーバー1つでAPI＋フロントエンド（PWA）を配信

set -e

echo "=== Excalidraw サーバーの起動を開始します ==="

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

# 変更の反映忘れを防ぐため、ビルド可能な環境では常にフロントエンドをビルドする。
# npm または node_modules がない環境（ビルドできない社内PCなど）では、
# git管理されているビルド済み dist/ をそのまま配信する。
if command -v npm >/dev/null 2>&1 && [ -d node_modules ]; then
    echo "フロントエンドのビルドを実行しています..."
    npm run build
elif [ -f dist/index.html ]; then
    echo "npm または node_modules が見つからないため、ビルド済みの dist/ を使用します。"
else
    echo "エラー: ビルド環境がなく、ビルド済みの dist/index.html も見つかりません。"
    exit 1
fi

# ビルド成功後に旧サーバーを停止し、停止時間を最小限にする
free_port 3001

# バックエンドサーバーの起動（port 3001）
# フロントエンド（dist/）も同じサーバーから配信
echo "サーバーを起動中... (port 3001)"
cd backend
if [ -d ".venv" ]; then
    .venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 3001 &
elif [ -d "venv" ]; then
    ./venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 3001 &
else
    python -m uvicorn main:app --host 0.0.0.0 --port 3001 &
fi
BACKEND_PID=$!
cd ..

# プロセス終了処理
cleanup() {
    echo ""
    echo "=== サーバーを停止しています ==="
    kill $BACKEND_PID 2>/dev/null || true
    echo "サーバーが停止されました"
    exit 0
}

# Ctrl+Cで終了時にクリーンアップ
trap cleanup SIGINT SIGTERM

# 起動プロセスが生存し、実際にHTTP応答するまで最大10秒待つ。
SERVER_READY=0
for _ in {1..100}; do
    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
        wait "$BACKEND_PID" 2>/dev/null || true
        echo "エラー: サーバープロセスが起動途中で終了しました。"
        exit 1
    fi
    if curl -fsS http://127.0.0.1:3001/ >/dev/null 2>&1; then
        SERVER_READY=1
        break
    fi
    sleep 0.1
done

if [ "$SERVER_READY" -ne 1 ]; then
    echo "エラー: サーバーが10秒以内に応答しませんでした。"
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
    exit 1
fi

echo ""
echo "=== サーバー起動完了 ==="
echo "アプリケーション: http://localhost:3001"
echo "バックエンド API: http://localhost:3001/api/"
echo ""
echo "※ PWA対応: バックエンドからフロントエンドを配信"
echo "停止するには Ctrl+C を押してください"

# バックグラウンドプロセスの完了を待機
wait "$BACKEND_PID"
