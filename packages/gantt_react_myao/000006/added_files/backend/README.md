# Backend (FastAPI + SQLite)

ガントチャートアプリケーションのバックエンドAPIです。
APIの一覧と仕様は [../docs/SPECIFICATION.md](../docs/SPECIFICATION.md)、コードの構成は [../CLAUDE.md](../CLAUDE.md) を参照してください。

## 起動

```bash
./ensure_venv.sh   # .venv（Python 3.14）を用意する（Windows はルートの setup_windows.bat）
.venv/bin/python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

- Swagger UI: http://localhost:8000/docs
- `../frontend/dist` があれば、ビルド済みフロントエンドも同じポートで配信します。

## データベース

- SQLite。既定では `backend/gantt.db`（起動時のカレントディレクトリには依存しません）。無ければ起動時に作成します。
- 接続先は環境変数 `GANTT_DATABASE_URL` で変更できます（例: `sqlite:////tmp/verify.db`）。
- `gantt.db` は `.gitignore` の対象です。

## テスト

```bash
.venv/bin/python -m pytest
```

`tests/conftest.py` が接続先を一時DBへ差し替えるため、`gantt.db` には触れません。

## 運用スクリプト

いずれも接続先のDBを直接書き換えます。実データに対して実行する前に `gantt.db` を退避してください。

| スクリプト | 内容 |
| --- | --- |
| `.venv/bin/python restore_from_csv.py [obsidian_home]` | Obsidian Vault の `70_gantt_csv/` に保存されたCSVから、タスク・リンクを復元する |
| `.venv/bin/python generate_load_test_data.py` | 負荷テスト用のタスクを3000件追加する |
| `.venv/bin/python sample_data.py` | 既存データを消してサンプルデータを入れる |
