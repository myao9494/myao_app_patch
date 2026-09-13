"""
アプリケーションエントリポイント。
起動時にDBスキーマを初期化し、リクエストごとに短命のDB接続を利用する。
"""

import os

# Mac / Apple Silicon 上での OpenMP (libomp) および HuggingFace Tokenizers の並列スレッド競合クラッシュを防止
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("VECLIB_MAXIMUM_THREADS", "1")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

try:
    import torch
    torch.set_num_threads(1)
except ImportError:
    pass

from contextlib import asynccontextmanager
import logging
from logging.handlers import QueueHandler, QueueListener
from pathlib import Path
from queue import SimpleQueue
import re

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from app.api.files import router as files_router
from app.api.folders import router as folders_router
from app.api.index import router as index_router
from app.api.launcher import router as launcher_router
from app.api.search import router as search_router
from app.api.vector import router as vector_router
from app.api.export import router as export_router

from app.config import BACKEND_DIR, settings
from app.db.connection import get_connection
from app.db.schema import initialize_schema
from app.services.scheduler_service import SchedulerMonitor
from app.services.launcher_service import LauncherManager
from app.services.change_tracking_service import ChangeTrackingService
from app.services.index_service import IndexService


def configure_logging() -> QueueListener:
    """
    INFO以上のログを標準出力とファイルへ非同期に流し、検索処理をディスクI/Oで待たせない。
    """
    formatter = logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(formatter)
    file_handler = logging.FileHandler(BACKEND_DIR / "backend.log", encoding="utf-8")
    file_handler.setFormatter(formatter)

    log_queue: SimpleQueue[logging.LogRecord] = SimpleQueue()
    queue_handler = QueueHandler(log_queue)
    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    root_logger.setLevel(logging.INFO)
    root_logger.addHandler(queue_handler)

    listener = QueueListener(log_queue, stream_handler, file_handler, respect_handler_level=True)
    listener.start()
    return listener


logger = logging.getLogger(__name__)
HASHED_ASSET_PATTERN = re.compile(r".*-[0-9A-Za-z]{6,}\.(js|css|mjs)$")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """起動時にDBスキーマとスケジューラーモニターを準備する。"""
    log_listener = configure_logging()
    scheduler_monitor = None
    change_tracking_service = None
    launcher_manager = LauncherManager()
    try:
        startup_connection = get_connection()
        try:
            initialize_schema(startup_connection)
            IndexService(connection=startup_connection).recover_interrupted_indexing()
        finally:
            startup_connection.close()
        scheduler_monitor = SchedulerMonitor()
        scheduler_monitor.start()
        change_tracking_service = ChangeTrackingService()
        change_tracking_service.start()
        app.state.scheduler_monitor = scheduler_monitor
        app.state.change_tracking_service = change_tracking_service
        app.state.launcher_manager = launcher_manager
        app.state.log_listener = log_listener
        launcher_manager.autostart_if_enabled()

        # 起動時に前回保存されたベクトルモデルを自動ロード（未設定時は超軽量モデル）
        from app.vector.state import vector_state
        try:
            vector_state.load_saved_model()
            logger.info("起動時ベクトルモデル自動ロード完了: %s", vector_state.model_path)
        except Exception as e:
            logger.warning("起動時のベクトルモデル自動ロードに失敗しました: %s", e)

        yield
    finally:
        launcher_manager.stop()
        if scheduler_monitor is not None:
            scheduler_monitor.stop()
        if change_tracking_service is not None:
            change_tracking_service.stop()
        log_listener.stop()


def create_app() -> FastAPI:
    app = FastAPI(title=settings.app_name, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(files_router)
    app.include_router(folders_router)
    app.include_router(index_router)
    app.include_router(launcher_router)
    app.include_router(search_router)
    app.include_router(vector_router)
    app.include_router(export_router)


    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    frontend_dist = settings.frontend_dist_dir
    index_file = frontend_dist / "index.html"

    def build_static_cache_headers(path: Path) -> dict[str, str]:
        """配信ファイル種別ごとに適切なキャッシュヘッダーを返す。"""
        if path.name in {"index.html", "sw.js", "manifest.webmanifest", "manifest.json"}:
            return {"Cache-Control": "no-cache, no-store, must-revalidate"}

        if HASHED_ASSET_PATTERN.fullmatch(path.name):
            return {"Cache-Control": "public, max-age=31536000, immutable"}

        return {"Cache-Control": "public, max-age=3600"}

    if frontend_dist.exists() and index_file.exists():
        @app.get("/", include_in_schema=False)
        async def serve_frontend_root() -> FileResponse:
            return FileResponse(index_file, headers=build_static_cache_headers(index_file))

        @app.get("/{full_path:path}", include_in_schema=False)
        async def serve_frontend(full_path: str) -> FileResponse:
            if full_path.startswith("api/"):
                raise HTTPException(status_code=404, detail="Not found")

            requested_path = (frontend_dist / full_path).resolve()
            try:
                requested_path.relative_to(frontend_dist.resolve())
            except ValueError as error:
                raise HTTPException(status_code=404, detail="Not found") from error

            if requested_path.is_file():
                return FileResponse(requested_path, headers=build_static_cache_headers(requested_path))

            return FileResponse(index_file, headers=build_static_cache_headers(index_file))

    return app


app = create_app()
