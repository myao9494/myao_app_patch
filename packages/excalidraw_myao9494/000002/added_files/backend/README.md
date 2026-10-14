# backend（FastAPI）

ローカルの図面ファイルの読み書きと OS 連携を行う API サーバー。本番では `dist/` のフロントエンドも配信する。

- API 仕様: [docs/api.md](../docs/api.md)
- モジュール構成: [docs/architecture.md](../docs/architecture.md#バックエンド)

## セットアップと起動

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
./start_server.sh                                  # 開発用（port 8008、自動リロード）
.venv/bin/python -m uvicorn main:app --port 3001   # 本番相当（通常はプロジェクトルートの start_servers.sh を使う）
```

## テスト

```bash
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest ../tests
```
