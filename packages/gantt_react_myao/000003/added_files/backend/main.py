"""
FastAPIバックエンドアプリケーションのエントリポイント。
各APIルーターの登録と、ビルド済みフロントエンド（frontend/dist）の静的配信を行う。
APIの実装は routers/、共通ロジックは services/ にある。
"""
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from config import FRONTEND_DIST_DIR
from database import init_db
from routers import calendar, csv_io, grid, links, open_input, synonyms, tasks
from services import update_sequence

APP_VERSION = "1.0.0"

UPDATE_SEQUENCE_HEADER = "X-Update-Sequence"

# Viteが出力するハッシュ付きアセット（例: index-CYeIsup6.js、UniverSheet-DompA_P1.js）
HASHED_ASSET_PATTERN = re.compile(r".*-[0-9A-Za-z_-]{6,}\.(js|css|mjs)$")
# 更新を即時に検知させるため、常に再検証させるファイル
NO_CACHE_FILENAMES = {"index.html", "sw.js", "manifest.webmanifest", "manifest.json"}


def build_static_cache_headers(path: Path) -> dict[str, str]:
    """配信ファイル種別ごとに適切なキャッシュヘッダーを返す。"""
    if path.name in NO_CACHE_FILENAMES:
        return {"Cache-Control": "no-cache, no-store, must-revalidate"}

    if HASHED_ASSET_PATTERN.fullmatch(path.name):
        return {"Cache-Control": "public, max-age=31536000, immutable"}

    return {"Cache-Control": "public, max-age=3600"}


def resolve_static_file(dist_dir: Path, request_path: str) -> Path | None:
    """
    リクエストパスに対応する dist 配下の実ファイルを返す。
    dist の外を指すパス（../ などによるディレクトリトラバーサル）や、存在しないファイルは None。
    """
    dist_root = dist_dir.resolve()
    candidate = (dist_root / request_path).resolve()
    if not candidate.is_relative_to(dist_root) or not candidate.is_file():
        return None
    return candidate


def _static_file_response(file_path: Path) -> FileResponse:
    headers = build_static_cache_headers(file_path)
    # Service WorkerとmanifestのMIMEタイプを正しく設定（PWA対応）
    if file_path.suffix == ".webmanifest":
        return FileResponse(file_path, media_type="application/manifest+json", headers=headers)
    if file_path.name == "sw.js" or file_path.name.startswith("workbox-"):
        return FileResponse(
            file_path,
            media_type="application/javascript",
            headers={**headers, "Service-Worker-Allowed": "/"},
        )
    return FileResponse(file_path, headers=headers)


def register_frontend(app: FastAPI, dist_dir: Path) -> None:
    """
    ビルド済みフロントエンドをSPAとして配信する。
    APIルートを優先させるため、必ず全ルーターの登録後に呼ぶこと。
    """
    if not dist_dir.is_dir():
        @app.get("/")
        async def serve_root():
            return {"message": "Gantt Chart API (Frontend not found)"}
        return

    assets_dir = dist_dir / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    index_path = dist_dir / "index.html"

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        # distに実ファイルがあればそれを返し（vite.svg, sw.js など）、なければSPAのindex.htmlを返す
        file_path = resolve_static_file(dist_dir, full_path)
        return _static_file_response(file_path or index_path)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    init_db()
    yield


def create_app(frontend_dist: Path = FRONTEND_DIST_DIR) -> FastAPI:
    app = FastAPI(
        title="Gantt Chart API",
        description="API for Gantt Chart application",
        version=APP_VERSION,
        lifespan=lifespan,
    )

    # CORS configuration - allow all origins (個人利用のため無制限)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=[UPDATE_SEQUENCE_HEADER],
    )

    @app.middleware("http")
    async def add_update_sequence_header(request: Request, call_next):
        """
        API応答に現在の更新シーケンス番号を付ける。
        フロントエンドは、自分の変更で番号が1つだけ進んだとき、それを他の変更と区別して再取得を省く。
        """
        response = await call_next(request)
        if request.url.path.startswith("/api/"):
            response.headers[UPDATE_SEQUENCE_HEADER] = str(update_sequence.current())
        return response

    @app.get("/api/health")
    def health_check():
        """Health check endpoint."""
        return {"status": "ok", "version": APP_VERSION}

    # open_input は /api/tasks/{task_id} より先にマッチさせるため、tasks より前に登録する
    app.include_router(open_input.router)
    app.include_router(tasks.router)
    app.include_router(links.router)
    app.include_router(grid.router)
    app.include_router(calendar.router)
    app.include_router(synonyms.router)
    app.include_router(csv_io.router)

    register_frontend(app, frontend_dist)
    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
