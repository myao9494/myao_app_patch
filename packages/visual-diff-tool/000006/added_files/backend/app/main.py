"""
Visual Diff Tool APIサーバーのエントリポイント。
- 機能ごとの APIRouter（routes/）を登録し、ビルド済みフロントエンド（frontend/dist）を配信する
  - routes/images.py   : ファイル差分（アップロード画像の比較）
  - routes/git.py      : Git差分（Obsidian Markdown起点を含む）
  - routes/three_d.py  : 3D CAD差分（STEP比較・非同期ジョブ）
  - routes/settings.py : サーバー設定とHTMLレポート保存
- 起動は backend/run.py（127.0.0.1:8078）
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .routes import git, images, settings, three_d

DIST_DIR = Path(__file__).resolve().parents[2] / "frontend" / "dist"
ASSETS_DIR = DIST_DIR / "assets"

app = FastAPI(title="Visual Diff Tool API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8078",
        "http://127.0.0.1:8078",
        "app://obsidian.md",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


for module in (images, git, three_d, settings):
    app.include_router(module.router)


# --- フロントエンド配信（APIルートの登録後に置く。末尾の catch-all がAPIを覆わないようにするため） ---

if ASSETS_DIR.exists():
    app.mount("/assets", StaticFiles(directory=ASSETS_DIR), name="assets")


@app.get("/")
def serve_frontend() -> FileResponse:
    index = DIST_DIR / "index.html"
    if not index.exists():
        raise HTTPException(status_code=404, detail="frontend/dist/index.html not found. Run npm run build in frontend.")
    return FileResponse(index)


@app.get("/api-guide", include_in_schema=False)
def serve_api_guide() -> FileResponse:
    return serve_frontend()


@app.get("/{filename}", include_in_schema=False)
def serve_frontend_file(filename: str) -> FileResponse:
    path = _resolve_dist_file(filename)
    if path is None:
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(path)


def _resolve_dist_file(filename: str) -> Path | None:
    """dist 直下のファイルだけを返す。Windows では "\\" もパス区切りになるため、解決後の位置で判定する。"""
    dist_root = DIST_DIR.resolve()
    path = (dist_root / filename).resolve()
    if path.parent == dist_root and path.is_file():
        return path
    return None


@app.get("/{path:path}", include_in_schema=False)
def serve_spa(path: str) -> FileResponse:
    if path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Not found")
    index = DIST_DIR / "index.html"
    if not index.exists():
        raise HTTPException(status_code=404, detail="frontend/dist/index.html not found. Run npm run build in frontend.")
    return FileResponse(index)
