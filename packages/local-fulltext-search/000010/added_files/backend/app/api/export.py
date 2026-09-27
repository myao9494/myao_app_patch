"""
AIコンテキストエクスポートAPIルーター。
仕様:
- 選択された複数ドキュメントから「統合マークダウンファイル」および「結合画像ファイル」を生成・保存する。
- 統合マークダウンは生のリンク記法を維持し、Obsidianコピペ互換性を保証。
- 結合画像は全図面を縦連結し、社内チャットの4.5MB制限を自動クリアする。
- 指定された専用フォルダへの一括保存およびOSのフォルダオープン（Finder / Explorer）を提供。
- 自己完結HTMLのエクスポートも継続サポート。
"""

import io
import os
import platform
import re
import subprocess
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from app.config import settings
from app.vector.html_exporter import export_documents_to_html
from app.vector.markdown_image_exporter import export_documents_to_markdown_and_image

router = APIRouter(prefix="/api/export", tags=["export"])

DEFAULT_EXPORT_FOLDER = "~/Desktop/AI_Inputs"
DEFAULT_SELECT_COUNT = 10


def get_persisted_export_folder() -> str:
    """サーバーに永続化されたエクスポート先フォルダパスを取得する（未設定時は既定値を返却）"""
    try:
        path = settings.ai_export_folder_path
        if path.exists():
            content = path.read_text(encoding="utf-8").strip()
            if content:
                return content
    except Exception:
        pass
    return DEFAULT_EXPORT_FOLDER


def persist_export_folder(folder_path: str) -> str:
    """指定されたエクスポート先フォルダパスをサーバーに永続保存する"""
    cleaned = folder_path.strip() if folder_path else ""
    if not cleaned:
        cleaned = DEFAULT_EXPORT_FOLDER
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.ai_export_folder_path.write_text(cleaned, encoding="utf-8")
    return cleaned


def get_persisted_default_select_count() -> int:
    """サーバーに永続化されたデフォルト選択数を取得する（未設定・不正時は既定値10を返却）"""
    try:
        path = settings.ai_default_select_count_path
        if path.exists():
            val = int(path.read_text(encoding="utf-8").strip())
            return max(0, val)
    except Exception:
        pass
    return DEFAULT_SELECT_COUNT


def persist_default_select_count(count: int) -> int:
    """指定されたデフォルト選択数をサーバーに永続保存する"""
    val = max(0, int(count))
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.ai_default_select_count_path.write_text(str(val), encoding="utf-8")
    return val


class ExportConfigRequest(BaseModel):
    export_folder: Optional[str] = None
    default_select_count: Optional[int] = None


class OpenFolderRequest(BaseModel):
    folder_path: Optional[str] = ""


class SaveAiHtmlRequest(BaseModel):
    html_content: str
    file_name: Optional[str] = "ai_context_document.html"
    target_dir: Optional[str] = ""


class ResolveLinksRequest(BaseModel):
    file_paths: Optional[List[str]] = None
    file_depths: Optional[Dict[str, int]] = None
    vault_path: Optional[str] = ""
    excluded_file_paths: Optional[List[str]] = None


class AiHtmlExportRequest(BaseModel):
    file_paths: Optional[List[str]] = None
    file_depths: Optional[Dict[str, int]] = None
    vault_path: Optional[str] = ""
    relative_paths: Optional[List[str]] = None
    excluded_file_paths: Optional[List[str]] = None
    prompt: Optional[str] = ""
    title: Optional[str] = "AIコンテキスト統合ドキュメント"
    include_raw_markdown: bool = False
    include_images: bool = True
    include_linked_emails: bool = True
    optimize_tokens: bool = True


class SaveAiBundleRequest(BaseModel):
    file_paths: Optional[List[str]] = None
    file_depths: Optional[Dict[str, int]] = None
    vault_path: Optional[str] = ""
    excluded_file_paths: Optional[List[str]] = None
    title: Optional[str] = "AIコンテキスト統合ドキュメント"
    file_base_name: Optional[str] = "AI_Context_Document"
    target_dir: Optional[str] = ""
    optimize_tokens: bool = True
    include_linked_emails: bool = True


@router.get("/config")
def get_export_config_endpoint() -> Dict[str, Any]:
    """現在設定・永続化されているエクスポート先フォルダパスおよびデフォルト選択数を返却する"""
    return {
        "export_folder": get_persisted_export_folder(),
        "default_select_count": get_persisted_default_select_count(),
    }


@router.post("/config")
def save_export_config_endpoint(req: ExportConfigRequest) -> Dict[str, Any]:
    """エクスポート先フォルダパスおよびデフォルト選択数をサーバーに永続保存する"""
    res: Dict[str, Any] = {"success": True}
    if req.export_folder is not None:
        saved_folder = persist_export_folder(req.export_folder)
        res["export_folder"] = saved_folder
    else:
        res["export_folder"] = get_persisted_export_folder()

    if req.default_select_count is not None:
        saved_count = persist_default_select_count(req.default_select_count)
        res["default_select_count"] = saved_count
    else:
        res["default_select_count"] = get_persisted_default_select_count()

    return res


@router.post("/open-folder")
def open_folder_endpoint(req: OpenFolderRequest) -> Dict[str, Any]:
    """指定されたローカルフォルダをOSのファイルマネージャー（Finder / Explorer）で開く"""
    folder_path_str = req.folder_path.strip() if req.folder_path else ""
    if not folder_path_str:
        folder_path_str = get_persisted_export_folder()

    folder_path = Path(folder_path_str).expanduser().resolve()
    folder_path.mkdir(parents=True, exist_ok=True)

    system = platform.system()
    try:
        if system == "Darwin":
            subprocess.Popen(["open", str(folder_path)])
        elif system == "Windows":
            os.startfile(str(folder_path))  # type: ignore[attr-defined]
        else:
            subprocess.Popen(["xdg-open", str(folder_path)])
        return {"success": True, "opened_path": str(folder_path)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"フォルダを開けませんでした: {e}")


@router.post("/resolve-links")
def resolve_links_endpoint(req: ResolveLinksRequest) -> Dict[str, Any]:
    """各ノートの階層数設定に基づき展開される全ファイル一覧と統計情報を返却する"""
    from app.vector.link_expander import expand_linked_files
    paths = req.file_paths or []
    if not paths:
        return {"success": True, "expanded_file_paths": [], "stats": {}}
    expanded, meta = expand_linked_files(
        file_paths=paths,
        file_depths=req.file_depths,
        vault_path=req.vault_path or "",
        excluded_paths=req.excluded_file_paths,
    )
    return {
        "success": True,
        "expanded_file_paths": expanded,
        "stats": meta,
    }


@router.post("/ai-bundle/save")
def save_ai_bundle_endpoint(req: SaveAiBundleRequest) -> Dict[str, Any]:
    """統合マークダウンと結合画像をローカル指定フォルダに保存する"""
    paths = req.file_paths or []
    if not paths:
        raise HTTPException(status_code=400, detail="対象ファイルが指定されていません")

    md_content, img_bytes, stats = export_documents_to_markdown_and_image(
        file_paths=paths,
        vault_path=req.vault_path or "",
        file_depths=req.file_depths,
        excluded_file_paths=req.excluded_file_paths,
        title=req.title or "AIコンテキスト統合ドキュメント",
        optimize_tokens=req.optimize_tokens,
        include_linked_emails=req.include_linked_emails,
    )

    if req.target_dir and req.target_dir.strip():
        save_dir = Path(req.target_dir.strip()).expanduser().resolve()
    else:
        fallback_str = get_persisted_export_folder()
        save_dir = Path(fallback_str).expanduser().resolve()


    save_dir.mkdir(parents=True, exist_ok=True)

    base_name = re.sub(r'[\/:*?"<>|]', "_", (req.file_base_name or "AI_Context").strip())
    if base_name.endswith(".md"):
        base_name = base_name[:-3]

    # 1. マークダウン保存
    md_file = save_dir / f"{base_name}_context.md"
    md_file.write_text(md_content, encoding="utf-8")

    # 2. 結合画像保存（存在する場合）
    saved_img_path = None
    saved_img_name = None
    if img_bytes is not None and len(img_bytes) > 0:
        # PNGヘッダーチェック
        ext = ".png" if img_bytes.startswith(b"\x89PNG\r\n\x1a\n") else ".jpg"
        img_file = save_dir / f"{base_name}_images{ext}"
        img_file.write_bytes(img_bytes)
        saved_img_path = str(img_file.resolve())
        saved_img_name = img_file.name

    return {
        "success": True,
        "folder_path": str(save_dir.resolve()),
        "markdown_path": str(md_file.resolve()),
        "markdown_name": md_file.name,
        "image_path": saved_img_path,
        "image_name": saved_img_name,
        "has_images": img_bytes is not None and len(img_bytes) > 0,
        "stats": stats,
    }


@router.post("/ai-bundle/generate")
def generate_ai_bundle_endpoint(req: SaveAiBundleRequest) -> Dict[str, Any]:
    """プレビュー用マークダウンおよび統計情報を生成して返す"""
    paths = req.file_paths or []
    if not paths:
        raise HTTPException(status_code=400, detail="対象ファイルが指定されていません")

    md_content, img_bytes, stats = export_documents_to_markdown_and_image(
        file_paths=paths,
        vault_path=req.vault_path or "",
        file_depths=req.file_depths,
        excluded_file_paths=req.excluded_file_paths,
        title=req.title or "AIコンテキスト統合ドキュメント",
        optimize_tokens=req.optimize_tokens,
        include_linked_emails=req.include_linked_emails,
    )

    return {
        "markdown_content": md_content,
        "has_images": img_bytes is not None and len(img_bytes) > 0,
        "image_size_bytes": len(img_bytes) if img_bytes else 0,
        "stats": stats,
    }


@router.post("/ai-html")
def generate_ai_html_endpoint(req: AiHtmlExportRequest) -> Dict[str, Any]:
    """自己完結HTMLを生成してJSONで返す"""
    paths = req.file_paths or []
    if not paths and not req.relative_paths:
        raise HTTPException(status_code=400, detail="対象ファイルが指定されていません")

    html_content, stats = export_documents_to_html(
        vault_path=req.vault_path or "",
        relative_paths=req.relative_paths,
        file_paths=paths,
        file_depths=req.file_depths,
        excluded_file_paths=req.excluded_file_paths,
        prompt=req.prompt or "",
        title=req.title or "AIコンテキスト統合ドキュメント",
        include_raw_markdown=req.include_raw_markdown,
        include_images=req.include_images,
        include_linked_emails=req.include_linked_emails,
        optimize_tokens=req.optimize_tokens,
    )

    return {
        "html_content": html_content,
        "file_name": "ai_context_document.html",
        "total_documents": stats.get("total_documents", 0),
        "total_linked_emails": stats.get("total_linked_emails", 0),
        "total_images_embedded": stats.get("total_images_embedded", 0),
        "size_bytes": len(html_content.encode("utf-8")),
        "expanded_nodes": stats.get("expanded_nodes", []),
    }


@router.post("/ai-html/download")
def download_ai_html_endpoint(req: AiHtmlExportRequest) -> Response:
    """自己完結HTMLをダウンロードファイルとして返却する"""
    paths = req.file_paths or []
    if not paths and not req.relative_paths:
        raise HTTPException(status_code=400, detail="対象ファイルが指定されていません")

    html_content, _ = export_documents_to_html(
        vault_path=req.vault_path or "",
        relative_paths=req.relative_paths,
        file_paths=paths,
        file_depths=req.file_depths,
        excluded_file_paths=req.excluded_file_paths,
        prompt=req.prompt or "",
        title=req.title or "AIコンテキスト統合ドキュメント",
        include_raw_markdown=req.include_raw_markdown,
        include_images=req.include_images,
        include_linked_emails=req.include_linked_emails,
        optimize_tokens=req.optimize_tokens,
    )

    safe_title = re.sub(r'[\/:*?"<>|]', "_", req.title or "ai_context_document").strip()
    if not safe_title.lower().endswith(".html"):
        safe_title += ".html"

    return Response(
        content=html_content.encode("utf-8"),
        media_type="text/html; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{safe_title}"'
        },
    )


@router.post("/ai-html/save")
def save_ai_html_endpoint(req: SaveAiHtmlRequest) -> Dict[str, Any]:
    """生成された自己完結HTMLをローカルファイルに直接保存し、絶対パスを返却する"""
    if not req.html_content or not req.html_content.strip():
        raise HTTPException(status_code=400, detail="HTMLコンテンツが空です")

    if req.target_dir and req.target_dir.strip():
        save_dir = Path(req.target_dir.strip()).expanduser().resolve()
    else:
        downloads_dir = Path.home() / "Downloads"
        if downloads_dir.is_dir():
            save_dir = downloads_dir
        else:
            save_dir = Path.cwd()

    save_dir.mkdir(parents=True, exist_ok=True)

    raw_name = (req.file_name or "ai_context_document.html").strip()
    raw_name = re.sub(r'[\/:*?"<>|]', "_", raw_name)
    if not raw_name.lower().endswith(".html"):
        raw_name += ".html"

    base_stem = Path(raw_name).stem
    ext = Path(raw_name).suffix

    target_file = save_dir / raw_name
    counter = 1
    while target_file.exists():
        target_file = save_dir / f"{base_stem} ({counter}){ext}"
        counter += 1

    target_file.write_text(req.html_content, encoding="utf-8")

    return {
        "success": True,
        "saved_path": str(target_file.resolve()),
        "file_name": target_file.name,
        "size_bytes": target_file.stat().st_size,
    }
