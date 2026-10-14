"""
Excalidraw バックエンド API サーバー (FastAPI)

ローカルの図面ファイルを読み書きし、OS と連携する API を提供する。
本番では dist/ のビルド済みフロントエンド（PWA）も同じサーバーから配信する。
各 API の仕様は docs/api.md を参照。

モジュール構成:
- main.py               ルーティング（このファイル）
- models.py             リクエスト・レスポンスのデータモデル
- storage.py            原子的な書き込み・バックアップ・JSON検証・アップロード先
- obsidian_markdown.py  Obsidian 形式(.excalidraw.md)の解析・生成
- obsidian_files.py     Obsidian の埋め込み画像の解決・書き出し
- system_open.py        OS の既定アプリで開く・コマンド実行

起動方法（どちらでも動く）:
- プロジェクトルートから:  python -m uvicorn backend.main:app --port 3001
- backend/ から:           python -m uvicorn main:app --port 3001
"""
import asyncio
import json
import logging
import re
import shutil
import time
import urllib.parse
from contextlib import asynccontextmanager
from datetime import datetime
from html import escape, unescape
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response

try:
    from . import system_open
    from .models import (
        ArchiveFileRequest, ArchiveFileResponse, DirectoryEntry, EmailSaveResponse,
        ExcalidrawFileData, FileUploadResponse, FolderShortcutResponse, ListDirectoryRequest,
        ListDirectoryResponse, OpenEditorRequest, OpenEditorResponse, OpenFileRequest,
        OpenFileResponse, OpenFolderRequest, OpenFolderResponse, RunCommandRequest,
        RunCommandResponse, SaveEmailRequest, SaveFileRequest, SaveLibraryRequest,
        SaveLibraryResponse, SaveSvgRequest,
    )
    from .obsidian_files import (
        export_embedded_images, find_embedded_markdown_candidates, hydrate_obsidian_files,
        resolve_embedded_file_path,
    )
    from .obsidian_markdown import (
        embed_json_into_markdown, extract_json_from_markdown, has_excalidraw_plugin_marker,
        is_excalidraw_markdown_file, is_obsidian_path, parse_embedded_files_section,
    )
    from .storage import (
        atomic_write_text, clean_surrogates, compute_relative_path, create_backup,
        create_empty_scene_data, get_upload_directory, load_json_file, sanitize_filename,
        unique_timestamped_path, validate_json_with_details,
    )
except ImportError:  # backend/ をカレントにして `uvicorn main:app` で起動した場合
    import system_open
    from models import (
        ArchiveFileRequest, ArchiveFileResponse, DirectoryEntry, EmailSaveResponse,
        ExcalidrawFileData, FileUploadResponse, FolderShortcutResponse, ListDirectoryRequest,
        ListDirectoryResponse, OpenEditorRequest, OpenEditorResponse, OpenFileRequest,
        OpenFileResponse, OpenFolderRequest, OpenFolderResponse, RunCommandRequest,
        RunCommandResponse, SaveEmailRequest, SaveFileRequest, SaveLibraryRequest,
        SaveLibraryResponse, SaveSvgRequest,
    )
    from obsidian_files import (
        export_embedded_images, find_embedded_markdown_candidates, hydrate_obsidian_files,
        resolve_embedded_file_path,
    )
    from obsidian_markdown import (
        embed_json_into_markdown, extract_json_from_markdown, has_excalidraw_plugin_marker,
        is_excalidraw_markdown_file, is_obsidian_path, parse_embedded_files_section,
    )
    from storage import (
        atomic_write_text, clean_surrogates, compute_relative_path, create_backup,
        create_empty_scene_data, get_upload_directory, load_json_file, sanitize_filename,
        unique_timestamped_path, validate_json_with_details,
    )

# テストや外部スクリプトが backend.main から import している名前を再公開する
__all__ = [
    "app", "embed_json_into_markdown", "extract_json_from_markdown", "is_obsidian_path",
    "resolve_embedded_file_path", "ExcalidrawFileData",
]

logger = logging.getLogger("excalidraw")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DIST_PATH = PROJECT_ROOT / "dist"
LIBRARY_PATH = PROJECT_ROOT / "public" / "excalidraw_lib" / "my_lib.excalidrawlib"

HASHED_ASSET_PATTERN = re.compile(r".*-[0-9A-Za-z]{6,}\.(js|css|mjs)$")
ALLOWED_EXTERNAL_URL_SCHEMES = {"http", "https", "mailto", "obsidian"}

# ファイルがロックされている場合（Windows・同期ソフト等）の保存リトライ
SAVE_MAX_RETRIES = 10
SAVE_RETRY_DELAY_SECONDS = 0.2


class CacheControlledStaticFiles(StaticFiles):
    """PWA の更新が反映されるよう、配信ファイルごとにキャッシュヘッダーを付ける。"""

    @staticmethod
    def build_static_cache_headers(path: Path | str) -> dict[str, str]:
        static_path = Path(path)
        if static_path.name in {"index.html", "sw.js", "manifest.webmanifest", "manifest.json"}:
            return {"Cache-Control": "no-cache, no-store, must-revalidate"}
        if HASHED_ASSET_PATTERN.fullmatch(static_path.name):
            return {"Cache-Control": "public, max-age=31536000, immutable"}
        return {"Cache-Control": "public, max-age=3600"}

    def file_response(self, full_path, stat_result, scope, status_code: int = 200) -> Response:
        response = super().file_response(full_path, stat_result, scope, status_code)
        static_path = Path(full_path)
        response.headers.update(self.build_static_cache_headers(static_path))
        if static_path.name == "sw.js":
            response.headers["Service-Worker-Allowed"] = "/"
        return response


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """uvicorn とアプリのログを同じ形式（日時付き）で出力する。"""
    formatter = logging.Formatter("%(asctime)s %(levelname)s: %(message)s", "%Y-%m-%d %H:%M:%S")
    for logger_name in ("uvicorn.access", "uvicorn.error"):
        for handler in logging.getLogger(logger_name).handlers:
            handler.setFormatter(formatter)
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(formatter)
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
    yield


app = FastAPI(title="Excalidraw File API", lifespan=lifespan)

# 開発時(Vite)・LAN・Tailscale(100.x.x.x) からのアクセスを許可する
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3001",
        "http://127.0.0.1:3001",
        "http://0.0.0.0:3001",
    ],
    allow_origin_regex=r"https?://(?:localhost|127\.0\.0\.1|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100(?:\.\d{1,3}){3})(?::\d+)?",
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    """ビルド済みフロントエンドがあれば index.html を返す（PWA）。"""
    dist_index = DIST_PATH / "index.html"
    if dist_index.exists():
        return FileResponse(
            str(dist_index),
            media_type="text/html",
            headers=CacheControlledStaticFiles.build_static_cache_headers(dist_index),
        )
    return {"message": "Excalidraw File API"}


# ========================================
# 図面ファイルの読み込み・保存
# ========================================

def _load_markdown_drawing(file_path: Path, content: Optional[str]) -> dict:
    """Excalidraw Markdown を読み込み、埋め込み画像も解決して返す。"""
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Obsidian file not found")
    if content is None:
        content = file_path.read_text(encoding="utf-8")

    if not content.strip():
        return {
            "data": create_empty_scene_data(),
            "modified": file_path.stat().st_mtime,
            "resolvedPath": str(file_path),
            "shouldMigrateToMarkdown": False,
        }

    try:
        json_str = extract_json_from_markdown(content)
    except ValueError as e:
        raise HTTPException(status_code=400, detail={"error_type": "json_syntax", "message": str(e)}) from e

    data, validation_error = validate_json_with_details(json_str)
    if validation_error:
        raise HTTPException(status_code=400, detail=validation_error.model_dump())

    embedded_file_paths = hydrate_obsidian_files(file_path, data, parse_embedded_files_section(content))
    # SVGスナップショットしか残っていない埋め込みは、同じフォルダの候補ノートから元を探す
    embedded_markdown_candidates = (
        find_embedded_markdown_candidates(file_path)
        if any(path.lower().endswith(".svg") for path in embedded_file_paths.values())
        else []
    )

    return {
        "data": clean_surrogates(data),
        "modified": file_path.stat().st_mtime,
        "resolvedPath": str(file_path),
        "embeddedFilePaths": embedded_file_paths,
        "embeddedMarkdownCandidates": embedded_markdown_candidates,
        "shouldMigrateToMarkdown": False,
    }


@app.get("/api/load-file")
def load_file(filepath: str):
    """
    図面を読み込む。

    - .excalidraw.md / Front Matter に `excalidraw-plugin: parsed` を持つ .md は Obsidian 形式として読む
    - .excalidraw に移行済みの .excalidraw.md があれば、そちらを読む（resolvedPath で通知）
    - Vault 内（またはパスに 'obsidian' を含む）の .excalidraw は shouldMigrateToMarkdown=true
    - 空ファイルは空の図面として返す
    - 404: ファイルなし / 400: JSON不正（詳細付き） / 500: その他
    """
    try:
        # クエリパラメーターは FastAPI がデコード済みなので二重デコードしない
        file_path = Path(filepath)
        markdown_content: Optional[str] = None
        if file_path.suffix.lower() == ".md" and file_path.exists():
            try:
                markdown_content = file_path.read_text(encoding="utf-8")
            except (OSError, UnicodeError):
                markdown_content = None

        should_migrate_to_markdown = (
            file_path.suffix.lower() == ".excalidraw" and is_obsidian_path(str(file_path))
        )
        if should_migrate_to_markdown:
            migrated_path = file_path.with_suffix(".excalidraw.md")
            if migrated_path.exists():
                file_path = migrated_path
                should_migrate_to_markdown = False

        if is_excalidraw_markdown_file(file_path, markdown_content):
            return _load_markdown_drawing(file_path, markdown_content)

        if not file_path.exists():
            raise HTTPException(status_code=404, detail="File not found")

        return {
            "data": clean_surrogates(load_json_file(file_path)),
            # 外部更新検知の基準になるため、実際の更新日時を返す（0だと誤検知する）
            "modified": file_path.stat().st_mtime,
            "resolvedPath": str(file_path),
            "shouldMigrateToMarkdown": should_migrate_to_markdown,
        }

    except HTTPException:
        raise
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="File not found")
    except Exception as e:
        logger.exception("Unexpected error in load_file")
        raise HTTPException(status_code=500, detail=f"Error loading file: {e}")


@app.get("/api/file-info")
def get_file_info(filepath: str):
    """ファイルの存在と更新日時を返す。外部更新の検知で頻繁に呼ばれるため軽量にしている。"""
    try:
        file_path = Path(filepath)
        if not file_path.exists():
            return {"modified": 0, "exists": False}
        return {
            "modified": file_path.stat().st_mtime,
            "exists": True,
            # 通常の .md を開くとき、Excalidraw ノートかどうかの判定に使う
            "isExcalidraw": is_excalidraw_markdown_file(file_path),
        }
    except Exception:
        logger.exception("Unexpected error in get_file_info")
        return {"modified": 0, "exists": False}


@app.post("/api/save-file")
def save_file(request: SaveFileRequest):
    """
    図面を保存する。

    - 内容を一時ファイルに書いてから置換する（途中で中断しても既存ファイルを壊さない）
    - 通常ファイル: 保存前に backup/ へバックアップ（自動保存は10分間隔、force_backup で強制）
    - Obsidian 形式(.md): Markdown 本文・Front Matter を維持して図面データだけ更新し、
      画像は外部ファイルとして書き出す（バックアップは作らない）
    - Vault 内の .excalidraw も JSON のまま保存する（Markdown を書き込むと読めなくなるため）
    """
    try:
        file_path = Path(request.filepath)
        data_to_save = request.data.model_dump()
        file_path.parent.mkdir(parents=True, exist_ok=True)

        is_markdown_target = file_path.suffix.lower() == ".md"
        is_obsidian = is_markdown_target and is_obsidian_path(str(file_path))
        original_md_content: Optional[str] = None

        # 通常の名前の .md でも、既存ノートが Excalidraw プラグイン形式なら Obsidian 形式で更新する
        if is_markdown_target and not is_obsidian and file_path.exists():
            try:
                original_md_content = file_path.read_text(encoding="utf-8")
                is_obsidian = has_excalidraw_plugin_marker(original_md_content)
            except (OSError, UnicodeError) as e:
                logger.warning("Failed to inspect existing markdown file: %s", e)

        if is_obsidian:
            if original_md_content is None and file_path.exists():
                try:
                    original_md_content = file_path.read_text(encoding="utf-8")
                except Exception as e:
                    logger.warning("Failed to read existing obsidian file: %s", e)

            existing_embedded_files = (
                parse_embedded_files_section(original_md_content) if original_md_content else {}
            )
            image_files_map = export_embedded_images(
                file_path, data_to_save.get("files") or {}, existing_embedded_files,
            )
            serialized_content = embed_json_into_markdown(
                original_md_content,
                json.dumps(data_to_save, ensure_ascii=False),
                image_files_map or None,
            )
        else:
            if not create_backup(request.filepath, force=request.force_backup):
                logger.warning("Backup creation failed, but continuing with file save")
            serialized_content = json.dumps(data_to_save, ensure_ascii=False, indent=2)

        for attempt in range(SAVE_MAX_RETRIES):
            try:
                atomic_write_text(file_path, serialized_content)
                break
            except PermissionError:
                if attempt == SAVE_MAX_RETRIES - 1:
                    raise HTTPException(status_code=500, detail="Failed to save file due to a persistent file lock.")
                time.sleep(SAVE_RETRY_DELAY_SECONDS)

        return {
            "success": True,
            "message": f"File saved to {request.filepath}",
            "modified": file_path.stat().st_mtime,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error saving file")
        raise HTTPException(status_code=500, detail=f"Error saving file: {e}")


@app.post("/api/archive-file", response_model=ArchiveFileResponse)
def archive_file(request: ArchiveFileRequest):
    """ファイルを同じフォルダの backup/<名前>_<日時><拡張子> へ移動する。"""
    try:
        file_path = Path(request.filepath)
        if not file_path.exists():
            return ArchiveFileResponse(success=False, error="File not found")

        backup_dir = file_path.parent / "backup"
        backup_dir.mkdir(exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = unique_timestamped_path(backup_dir, file_path.stem, file_path.suffix, timestamp)

        shutil.move(str(file_path), str(backup_path))
        logger.info("[Archive] Moved %s to %s", file_path, backup_path)
        return ArchiveFileResponse(
            success=True,
            archivedPath=str(backup_path),
            message=f"File archived to {backup_path.name}",
        )
    except Exception as e:
        logger.exception("Error archiving file")
        return ArchiveFileResponse(success=False, error=str(e))


@app.post("/api/save-svg")
def save_svg(request: SaveSvgRequest):
    """SVG を保存する。"""
    try:
        atomic_write_text(Path(request.filepath), request.svg_content)
        return {"success": True, "message": f"SVG file saved to {request.filepath}"}
    except Exception as e:
        logger.exception("Error saving SVG file")
        raise HTTPException(status_code=500, detail=f"Error saving SVG file: {e}")


@app.get("/excalidraw_lib/my_lib.excalidrawlib")
def load_library():
    """
    共有ライブラリを public/ から直接返す。
    dist/ にはビルド時点のコピーしかないため、保存した最新の内容を返すにはこちらを使う。
    """
    if not LIBRARY_PATH.exists():
        raise HTTPException(status_code=404, detail="Library not found")
    return FileResponse(
        str(LIBRARY_PATH),
        media_type="application/json",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


@app.post("/save-library")
def save_library(request: SaveLibraryRequest):
    """共有ライブラリ public/excalidraw_lib/my_lib.excalidrawlib を保存する（他のパスは拒否）。"""
    file_path = (PROJECT_ROOT / request.file_path).resolve()
    if file_path != LIBRARY_PATH.resolve():
        raise HTTPException(status_code=403, detail="Library path is not allowed")
    try:
        atomic_write_text(file_path, json.dumps(request.data, ensure_ascii=False, indent=2))
        return SaveLibraryResponse(success=True, message=f"Library saved to {file_path}")
    except Exception as e:
        logger.exception("Error saving library")
        return SaveLibraryResponse(success=False, error=f"Error saving library: {e}")


@app.post("/api/list-directory", response_model=ListDirectoryResponse)
def list_directory(request: ListDirectoryRequest):
    """フォルダ内のサブフォルダと図面ファイルを一覧する（フォルダ優先・名前順）。"""
    try:
        target_path = Path(request.path).expanduser() if request.path else Path.cwd()
        if not target_path.exists():
            raise HTTPException(status_code=404, detail="Directory not found")
        if not target_path.is_dir():
            raise HTTPException(status_code=400, detail="Target path is not a directory")

        resolved_path = target_path.resolve()
        entries: List[DirectoryEntry] = []
        for entry in resolved_path.iterdir():
            if not request.show_hidden and entry.name.startswith("."):
                continue
            try:
                is_dir = entry.is_dir()
            except (PermissionError, FileNotFoundError):
                continue

            if not is_dir:
                name_lower = entry.name.lower()
                is_drawing = (
                    name_lower.endswith(".excalidraw")
                    or name_lower.endswith(".excalidraw.md")
                    or (name_lower.endswith(".md") and is_excalidraw_markdown_file(entry))
                )
                if not is_drawing:
                    continue

            try:
                stat = entry.stat()
            except (PermissionError, FileNotFoundError):
                continue
            entries.append(DirectoryEntry(
                name=entry.name,
                path=str(entry.resolve()),
                is_dir=is_dir,
                size=None if is_dir else stat.st_size,
                modified=stat.st_mtime,
            ))

        entries.sort(key=lambda item: (not item.is_dir, item.name.lower()))
        parent_path = str(resolved_path.parent) if resolved_path.parent != resolved_path else None
        return ListDirectoryResponse(success=True, path=str(resolved_path), parentPath=parent_path, entries=entries)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error listing directory: {e}")


# ========================================
# ドラッグ&ドロップされたファイルの保存
# ========================================

def _timestamp() -> str:
    return str(int(time.time()))


@app.post("/api/upload-files")
async def upload_files(
    files: List[UploadFile] = File(...),
    current_path: str = Form(...),
    file_type: str = Form("general"),
):
    """ファイルを uploads/<種類>/<名前>_<UNIX時刻><拡張子> に保存し、図面からの相対パスを返す。"""
    try:
        if not files:
            raise HTTPException(status_code=400, detail="No files provided")

        upload_dir = get_upload_directory(current_path, file_type)
        uploaded_files = []
        for file in files:
            if not file.filename:
                continue
            content = await file.read()
            safe_name = Path(sanitize_filename(file.filename))
            file_path = unique_timestamped_path(upload_dir, safe_name.stem, safe_name.suffix, _timestamp())
            await asyncio.to_thread(file_path.write_bytes, content)
            uploaded_files.append({
                "name": file.filename,
                "path": compute_relative_path(current_path, str(file_path)),
                "size": len(content),
            })

        return FileUploadResponse(success=True, files=uploaded_files)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Upload error")
        raise HTTPException(status_code=500, detail=f"Error uploading files: {e}")


@app.post("/api/create-folder-shortcut")
def create_folder_shortcut(folder_path: str = Form(...), current_path: str = Form(...)):
    """ドロップされたフォルダのショートカット(.txt)を uploads/folders/ に作る。"""
    try:
        upload_dir = get_upload_directory(current_path, "folder")
        folder_name = Path(folder_path.rstrip("/\\")).name or "folder"
        shortcut_path = unique_timestamped_path(upload_dir, sanitize_filename(folder_name), ".txt", _timestamp())
        shortcut_path.write_text(
            f"Folder Shortcut\nPath: {folder_path}\nCreated: {time.strftime('%Y-%m-%d %H:%M:%S')}",
            encoding="utf-8",
        )
        return FolderShortcutResponse(
            success=True,
            folderPath=compute_relative_path(current_path, str(shortcut_path)),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error creating folder shortcut: {e}")


@app.post("/api/save-email")
def save_email(request: SaveEmailRequest):
    """Outlook からドロップされたメール本文を uploads/emails/<件名>_<UNIX時刻>.eml に保存する。"""
    try:
        upload_dir = get_upload_directory(request.currentPath, "email")
        email_path = unique_timestamped_path(upload_dir, sanitize_filename(request.subject), ".eml", _timestamp())
        email_path.write_text(
            f"Subject: {request.subject}\n"
            f"Date: {time.strftime('%Y-%m-%d %H:%M:%S')}\n"
            "Content-Type: text/plain; charset=utf-8\n\n"
            f"{request.emailData}",
            encoding="utf-8",
        )
        return EmailSaveResponse(
            success=True,
            savedPath=compute_relative_path(request.currentPath, str(email_path)),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error saving email: {e}")


@app.get("/api/file/{file_path:path}")
def serve_uploaded_file(file_path: str):
    """プロジェクト直下の uploads/ と upload_local/ のファイルだけを配信する。"""
    try:
        path_parts = Path(file_path).parts
        if len(path_parts) < 2 or path_parts[0] not in {"uploads", "upload_local"}:
            raise HTTPException(status_code=403, detail="Access denied")

        allowed_root = (PROJECT_ROOT / path_parts[0]).resolve()
        actual_file_path = (allowed_root / Path(*path_parts[1:])).resolve()
        if not actual_file_path.is_relative_to(allowed_root):
            raise HTTPException(status_code=403, detail="Access denied")
        if not actual_file_path.exists():
            raise HTTPException(status_code=404, detail="File not found")

        return FileResponse(
            path=str(actual_file_path),
            filename=actual_file_path.name,
            media_type="application/octet-stream",
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error serving file %s", file_path)
        raise HTTPException(status_code=500, detail=f"Error serving file: {e}")


# ========================================
# OS 連携
# ========================================

def _open_path_via_os(raw_path: str) -> OpenFileResponse:
    if not raw_path:
        raise HTTPException(status_code=400, detail="File path is required")

    target_path = Path(system_open.normalize_filepath(raw_path))
    if target_path.is_dir():
        target_type = "directory"
    elif target_path.is_file():
        target_type = "file"
    else:
        raise HTTPException(status_code=404, detail="File or directory not found")

    try:
        system_open.launch_with_system(str(target_path))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="File or directory not found")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to open {target_type}: {exc}")

    return OpenFileResponse(
        success=True,
        targetType=target_type,
        resolvedPath=str(target_path),
        message=f"Opened {target_type} via system handler.",
    )


@app.post("/api/open-file", response_model=OpenFileResponse)
def open_file_post(request: OpenFileRequest):
    """ファイル・フォルダを OS の既定アプリで開く。"""
    return _open_path_via_os(request.filepath)


def _simple_html(title: str, message: str, auto_close: bool) -> str:
    script = (
        "<script>window.addEventListener('DOMContentLoaded', () => "
        "{ setTimeout(() => { window.close(); }, 50); });</script>"
        if auto_close else ""
    )
    return (
        '<!DOCTYPE html>\n<html lang="ja">\n  <head>\n    <meta charset="utf-8" />\n'
        f"    <title>{title}</title>\n    {script}\n  </head>\n"
        f"  <body>\n    <p>{escape(message)}</p>\n  </body>\n</html>"
    )


@app.get("/api/open-file")
def open_file_get(filepath: str):
    """ブラウザのタブから開く版。開いたらタブを自動で閉じる HTML を返す。"""
    try:
        result = _open_path_via_os(filepath)
    except HTTPException as exc:
        message = exc.detail if isinstance(exc.detail, str) else "Failed to open path"
        return HTMLResponse(content=_simple_html("Open File Error", message, False), status_code=exc.status_code)
    return HTMLResponse(content=_simple_html("Open File", result.message or "Opened path via system handler.", True))


@app.get("/api/open-url")
async def open_url(url: str):
    """URL（obsidian:// など）を OS の既定ハンドラーで開く。許可したスキームのみ。"""
    parsed_url = urllib.parse.urlparse(url)
    if parsed_url.scheme.lower() not in ALLOWED_EXTERNAL_URL_SCHEMES:
        raise HTTPException(status_code=400, detail="URL scheme is not allowed")
    try:
        await asyncio.to_thread(system_open.launch_with_system, url)
        return {"success": True, "url": url, "message": "Opened URL with system handler"}
    except Exception as e:
        logger.exception("Error opening URL")
        raise HTTPException(status_code=500, detail=f"Failed to open URL: {e}")


@app.post("/api/open-folder", response_model=OpenFolderResponse)
def open_folder(request: OpenFolderRequest):
    """フォルダを OS のファイルマネージャーで開く（ファイルを指定した場合はその親フォルダ）。"""
    try:
        if not request.path:
            raise HTTPException(status_code=400, detail="Folder path is required")
        target_path = Path(request.path).expanduser()
        if target_path.is_file():
            target_path = target_path.parent
        resolved_path = target_path.resolve()
        system_open.open_folder_in_file_manager(resolved_path)
        return OpenFolderResponse(success=True, openedPath=str(resolved_path))
    except HTTPException:
        raise
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Folder not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error opening folder: {e}")


@app.post("/api/open-in-editor", response_model=OpenEditorResponse)
def open_in_editor(request: OpenEditorRequest):
    """フォルダを VS Code で開く。VS Code がなければ OS のファイルマネージャーで開く。"""
    if not request.path:
        raise HTTPException(status_code=400, detail="Folder path is required")

    target_path = Path(system_open.normalize_filepath(request.path))
    if target_path.is_file():
        target_path = target_path.parent
    if not target_path.is_dir():
        raise HTTPException(status_code=404, detail="Folder not found")
    resolved_path = target_path.resolve()

    try:
        code_executable = system_open.find_vscode_executable()
        if code_executable:
            system_open.spawn_detached([code_executable, str(resolved_path)])
            return OpenEditorResponse(
                success=True,
                openedPath=str(resolved_path),
                fallbackUsed=False,
                message="Opened folder in Visual Studio Code.",
            )

        system_open.launch_with_system(str(resolved_path))
        return OpenEditorResponse(
            success=True,
            openedPath=str(resolved_path),
            fallbackUsed=True,
            message="Visual Studio Code was not found; opened the system file manager instead.",
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Error opening editor or folder: {exc}")


@app.post("/api/run-command", response_model=RunCommandResponse)
def run_command(request: RunCommandRequest):
    """
    図形リンク `cmd <コマンド>` を実行する（終了を待たない）。
    HTMLエンティティ・全角クォート・円記号を正規化し、作業フォルダは図面のフォルダ。
    """
    command = system_open.normalize_command_for_platform(
        system_open.strip_cmd_prefix(unescape(request.command))
    )
    if not command:
        raise HTTPException(status_code=400, detail="Command is empty or missing after removing prefix")

    working_directory: Optional[str] = None
    if request.working_directory:
        normalized_workdir = system_open.normalize_filepath(request.working_directory)
        if system_open.is_windows():
            normalized_workdir = system_open.normalize_windows_path_separators(normalized_workdir)
        if normalized_workdir and not Path(normalized_workdir).exists():
            raise HTTPException(status_code=400, detail="Specified working directory does not exist")
        working_directory = normalized_workdir or None

    logger.info("[run-command] %s (cwd=%s)", command, working_directory)
    try:
        process = system_open.spawn_system_command(command, cwd=working_directory)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Failed to locate command: {exc}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to execute command: {exc}")

    return RunCommandResponse(success=True, command=command, pid=process.pid)


# ========================================
# フロントエンド配信（PWA）
# ========================================
# API ルートの後にマウントするので /api/* は通常どおり処理される
if DIST_PATH.exists():
    app.mount("/", CacheControlledStaticFiles(directory=str(DIST_PATH), html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=3001)
