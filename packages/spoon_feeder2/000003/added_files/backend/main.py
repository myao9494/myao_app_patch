"""
Spoonfeeder2 FastAPI メインアプリケーション (main.py)

仕様:
1. 各APIルーター（backend/api/*）と対話型ターミナルのWebSocketを /api 配下に登録する。
   - repositories: リポジトリ履歴・ツリー・コンテキストXML・ファイルプレビュー・依存マップ・呼び出しモジュール/リンク先MDの自動選択
   - ignore: 無視リスト（.spoonfeeder.json）の取得・保存・削除
   - references: 参照リポジトリ解析と手動対応付け
   - mkdocs: MkDocs統合マークダウン＋結合画像の生成・保存
   - patch: AI出力の差分プレビューと反映（外部ライブラリ対応）
   - tools: テスト実行・テスト結果フィードバック・Git差分/初期化・VS Code起動
2. SPOONFEEDER_CONFIGS_FILE 環境変数による設定ファイルの動的切り替えに対応（settings_store）。
3. HostGuardMiddleware で不正なHostヘッダー（DNSリバインディング）を拒否する（security.py）。
4. frontend/dist が存在する場合、静的ファイル配信と依存マップ画面（/map）を提供する。
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .api import ignore, mkdocs, patch, references, repositories, tools
from .security import HostGuardMiddleware
from .terminal import router as terminal_router

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "frontend" / "dist"

app = FastAPI(title="Spoonfeeder2", version="2.0.0")
app.add_middleware(HostGuardMiddleware)
for module in (repositories, ignore, references, mkdocs, patch, tools):
    app.include_router(module.router, prefix="/api")
app.include_router(terminal_router, prefix="/api")

if DIST.exists():
    @app.get("/map")
    def map_page():
        return FileResponse(DIST / "index.html")

    app.mount("/", StaticFiles(directory=DIST, html=True), name="frontend")
