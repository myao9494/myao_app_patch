#!/bin/zsh
set -e
cd "$(dirname "$0")"

BASE_PORT=8765
MAX_OFFSET=20
HOST=127.0.0.1
PORT=$BASE_PORT

if [ ! -f dist/index.html ]; then
  echo "dist/index.html が見つかりません。フロントエンドをビルドします。"
  npm ci
  npm run build
fi

if lsof -ti tcp:$BASE_PORT >/dev/null 2>&1; then
  PIDS=($(lsof -ti tcp:$BASE_PORT | sort -u))
  if [ ${#PIDS[@]} -gt 0 ]; then
    echo "ポート $BASE_PORT を使用中のプロセスを停止します: ${PIDS[*]}"
    kill "${PIDS[@]}" 2>/dev/null || true
    sleep 1
    if lsof -ti tcp:$BASE_PORT >/dev/null 2>&1; then
      PIDS=($(lsof -ti tcp:$BASE_PORT | sort -u))
      echo "通常停止できなかったため強制停止します: ${PIDS[*]}"
      kill -9 "${PIDS[@]}" 2>/dev/null || true
      sleep 1
    fi
  fi
fi

for offset in $(seq 0 $MAX_OFFSET); do
  candidate=$((BASE_PORT + offset))
  if ! lsof -iTCP:$candidate -sTCP:LISTEN >/dev/null 2>&1; then
    PORT=$candidate
    break
  fi
done

if lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "$BASE_PORT 番以降で空きポートを見つけられませんでした。"
  exit 1
fi

# バックエンドは常に .venv（Python 3.14）で起動する。.venv が無い・壊れている・3.14 でないときは作り直す。
# backend/requirements-lock.txt が前回入れたときより新しければ入れ直す（Mac では入るものが無くても同じ手順にしておく）。
IS_314='import sys; sys.exit(0 if sys.version_info[:2] == (3, 14) else 1)'
MARKER=.venv/.requirements-lock.installed
if ! .venv/bin/python -c "$IS_314" >/dev/null 2>&1; then
  if ! python3 -c "$IS_314" >/dev/null 2>&1; then
    echo "Python 3.14 の python3 が見つかりません（現在: $(python3 -V 2>&1 || echo なし)）。"
    exit 1
  fi
  echo "Python 3.14 で .venv を作成します。"
  python3 -m venv --clear .venv
  rm -f "$MARKER"
fi
if [ ! -f "$MARKER" ] || [ backend/requirements-lock.txt -nt "$MARKER" ]; then
  .venv/bin/python -m pip install --quiet -r backend/requirements-lock.txt
  touch "$MARKER"
fi

echo "Outlook宛先作成アプリを起動します。"
echo "ブラウザで http://$HOST:$PORT を開いてください。"
OUTLOOK_ADDRESS_HOST=$HOST OUTLOOK_ADDRESS_PORT=$PORT .venv/bin/python backend/server.py
