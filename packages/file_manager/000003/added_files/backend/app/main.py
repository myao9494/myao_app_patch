"""
FastAPI ファイルマネージャー メインアプリケーション
- ファイル一覧取得
- ファイル操作（コピー、移動、削除、リネーム）
- CORS対応（個人利用・VPN内利用前提）
- PWA: フロントエンドのビルド済みファイルを静的配信
- PWA更新反映: HTML/Service Workerは再検証、ハッシュ付きアセットは長期キャッシュ

注: インデックス検索機能は外部サービス（file_index_service）に移行
"""
import re
from pathlib import Path
from typing import Optional
import urllib.request
import urllib.error
import socket
import os
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel

from app.config import get_editor_preferences, save_editor_preferences, settings
from app.routers import files, everything, history, clipboard, terminal, fulltext
from fastapi.exceptions import RequestValidationError
from fastapi import Request
import mimetypes

# Windows環境でSVGのMIMEタイプが正しく認識されない場合があるため明示的に設定
mimetypes.add_type("image/svg+xml", ".svg")

# フロントエンドのビルドディレクトリ（backend/の親ディレクトリ → frontend/dist）
FRONTEND_DIST_DIR = Path(__file__).parent.parent.parent / "frontend" / "dist"
QUICK_DIST_DIR = Path(__file__).parent.parent.parent / "frontend-quick" / "dist"
HASHED_ASSET_PATTERN = re.compile(r".*-[0-9A-Za-z]{6,}\.(js|css|mjs)$")

app = FastAPI(
    title="File Manager API",
    description="軽量ファイルマネージャー API",
    version="2.0.0",
)


def build_static_cache_headers(path: Path) -> dict[str, str]:
    """配信ファイル種別ごとに適切なキャッシュヘッダーを返す"""
    if path.name in {"index.html", "sw.js", "manifest.json"}:
        return {"Cache-Control": "no-cache, no-store, must-revalidate"}

    if HASHED_ASSET_PATTERN.fullmatch(path.name):
        return {"Cache-Control": "public, max-age=31536000, immutable"}

    return {"Cache-Control": "public, max-age=3600"}

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    import sys
    print(f"[ValidationError] {exc.errors()}", file=sys.stderr)
    try:
        if hasattr(exc, "body"):
             print(f"[ValidationErrorBody] {exc.body}", file=sys.stderr)
    except:
        pass
    return JSONResponse(
        status_code=422,
        content={"detail": exc.errors()},
    )

# CORS設定（個人利用のため全てのオリジンからのアクセスを許可）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ルーター登録
app.include_router(files.router, prefix="/api", tags=["files"])
app.include_router(everything.router, prefix="/api", tags=["everything"])
app.include_router(fulltext.router, prefix="/api", tags=["fulltext"])
app.include_router(history.router, prefix="/api", tags=["history"])
app.include_router(clipboard.router, prefix="/api", tags=["clipboard"])
app.include_router(terminal.router, prefix="/api", tags=["terminal"])


class EditorPreferencesRequest(BaseModel):
    """エディタ設定更新リクエスト"""

    textFileOpenMode: str
    markdownOpenMode: str
    apiTimeout: int = 10
    folderLatestModifiedMaxEntries: int = 20_000
    defaultTextFileExtension: str = "txt"
    pathMappings: Optional[dict[str, str]] = None


@app.get("/api/config")
async def get_config():
    """
    フロントエンド用設定を取得
    - defaultBasePath: デフォルトのベースディレクトリ
    - isWindows: Windows環境かどうか
    """
    return {
        "defaultBasePath": settings.start_dir.as_posix(),
        "isWindows": settings.is_windows,
        **get_editor_preferences(),
    }


@app.post("/api/config/preferences")
async def update_editor_preferences(request: EditorPreferencesRequest):
    """エディタ設定を設定ファイルへ保存する"""
    return save_editor_preferences(
        text_file_open_mode=request.textFileOpenMode,  # type: ignore[arg-type]
        markdown_open_mode=request.markdownOpenMode,  # type: ignore[arg-type]
        api_timeout=request.apiTimeout,
        path_mappings=request.pathMappings,
        folder_latest_modified_max_entries=request.folderLatestModifiedMaxEntries,
        default_text_file_extension=request.defaultTextFileExtension,
    )


class ConnectionTestRequest(BaseModel):
    """接続性検証リクエスト"""
    paths: list[str]


@app.post("/api/config/test-connections")
async def test_connections(request: ConnectionTestRequest):
    """
    指定された新サーバー（パスやURL）の接続性を検証する
    """
    results = {}
    
    def _test_single(path_or_url: str) -> dict:
        path_or_url = path_or_url.strip()
        if not path_or_url:
            return {"alive": False, "error": "アドレスが空です"}
            
        # URLの検証 (http:// または https://)
        if path_or_url.startswith(("http://", "https://")):
            try:
                # 3秒タイムアウトで接続を試みる
                req = urllib.request.Request(path_or_url, method="HEAD")
                req.add_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
                with urllib.request.urlopen(req, timeout=3.0) as response:
                    status = response.status
                    if 200 <= status < 400:
                        return {"alive": True, "type": "url", "status": status}
                    else:
                        return {"alive": False, "type": "url", "error": f"HTTP ステータス {status}"}
            except urllib.error.HTTPError as e:
                # HTTPErrorでも接続はできている（ステータス応答あり）
                return {"alive": True, "type": "url", "status": e.code, "note": f"HTTPError: {e.reason}"}
            except (urllib.error.URLError, socket.timeout, Exception) as e:
                return {"alive": False, "type": "url", "error": str(e)}
        
        # カスタムURI (obsidian://) の検証は形式チェックのみで True とする
        elif "://" in path_or_url:
            if path_or_url.startswith("obsidian://"):
                return {"alive": True, "type": "custom_scheme"}
            return {"alive": False, "type": "unsupported_scheme", "error": "サポートされていないスキームです"}

        # ローカルパス・UNCパスの検証
        else:
            try:
                expanded = os.path.expandvars(os.path.expanduser(path_or_url))
                
                # Windows UNCプレフィックスのバックスラッシュ統一
                if settings.is_windows and expanded.startswith("//") and not expanded.startswith("///"):
                    expanded = expanded.replace("/", "\\")
                
                path_obj = Path(expanded)
                if path_obj.exists():
                    ptype = "directory" if path_obj.is_dir() else "file"
                    return {"alive": True, "type": ptype}
                else:
                    return {"alive": False, "type": "path", "error": "パスが見つかりません"}
            except Exception as e:
                return {"alive": False, "type": "path", "error": str(e)}

    # 非同期スレッドプールで検証を実行
    import asyncio
    loop = asyncio.get_running_loop()
    with ThreadPoolExecutor() as pool:
        tasks = []
        for path in request.paths:
            tasks.append(loop.run_in_executor(pool, _test_single, path))
        
        task_results = await asyncio.gather(*tasks)
        
        for path, res in zip(request.paths, task_results):
            results[path] = res
            
    return results


# --- PWA: quickアプリ (frontend-quick) 配信 ---
@app.api_route("/quick", methods=["GET", "HEAD"])
async def redirect_quick():
    """末尾スラッシュなしの /quick を /quick/ にリダイレクト"""
    return RedirectResponse(url="/quick/", status_code=307)


@app.api_route("/quick/{full_path:path}", methods=["GET", "HEAD"])
async def serve_quick_spa(full_path: str = ""):
    """
    quick アプリの SPA / 静的配信
    - /quick/assets/... など静的ファイルが存在すればそれを返す
    - 存在しなければ quick/dist/index.html を返す（SPAフォールバック）
    """
    if not QUICK_DIST_DIR.is_dir():
        return JSONResponse(status_code=404, content={"detail": "Quick app dist not found"})

    if full_path:
        file_path = QUICK_DIST_DIR / full_path
        if file_path.is_file():
            return FileResponse(file_path, headers=build_static_cache_headers(file_path))

    index_path = QUICK_DIST_DIR / "index.html"
    if index_path.is_file():
        return FileResponse(index_path, headers=build_static_cache_headers(index_path))

    return JSONResponse(status_code=404, content={"detail": "Not found"})


# --- PWA: フロントエンド配信 (本体) ---
# frontend/dist/ が存在する場合のみ、静的ファイル配信を有効化
if FRONTEND_DIST_DIR.is_dir():
    # SPAフォールバック: /api以外のGETリクエストでファイルが見つからない場合はindex.htmlを返す
    @app.api_route("/{full_path:path}", methods=["GET", "HEAD"])
    async def serve_spa(full_path: str):
        """
        SPAフォールバック
        - 静的ファイルが存在すればそのファイルを返す
        - 存在しなければ index.html を返す（SPA対応）
        """
        # 静的ファイルが存在すればそのファイルを返す
        file_path = FRONTEND_DIST_DIR / full_path
        if file_path.is_file():
            return FileResponse(file_path, headers=build_static_cache_headers(file_path))

        # index.html を返す（SPAルーティング対応）
        index_path = FRONTEND_DIST_DIR / "index.html"
        if index_path.is_file():
            return FileResponse(index_path, headers=build_static_cache_headers(index_path))

        return JSONResponse(status_code=404, content={"detail": "Not found"})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port, reload=True)
