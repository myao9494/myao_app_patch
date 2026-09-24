"""
AIコンテキストエクスポートAPIルーター。
仕様:
- 選択された複数ドキュメントから自己完結型HTMLを生成する。
- HTMLコード生成およびファイルダウンロードレスポンスを提供。
- 生成された自己完結型HTMLをローカルディスク（Downloads等）に直接保存し、絶対ファイルパスを返却する。
"""

import re
from pathlib import Path
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from app.vector.html_exporter import export_documents_to_html
from app.services.pdf_converter import convert_html_to_pdf, PdfConverterError

router = APIRouter(prefix="/api/export", tags=["export"])


class SaveAiHtmlRequest(BaseModel):
    html_content: str
    file_name: Optional[str] = "ai_context_document.html"
    target_dir: Optional[str] = ""


class SaveAiPdfRequest(BaseModel):
    html_content: Optional[str] = None
    file_paths: Optional[List[str]] = None
    vault_path: Optional[str] = ""
    relative_paths: Optional[List[str]] = None
    prompt: Optional[str] = ""
    title: Optional[str] = "AIコンテキスト統合ドキュメント"
    file_name: Optional[str] = "ai_context_document.pdf"
    target_dir: Optional[str] = ""
    include_raw_markdown: bool = False
    include_images: bool = True
    include_linked_emails: bool = True
    optimize_tokens: bool = True


class AiPdfExportRequest(BaseModel):
    html_content: Optional[str] = None
    file_paths: Optional[List[str]] = None
    vault_path: Optional[str] = ""
    relative_paths: Optional[List[str]] = None
    prompt: Optional[str] = ""
    title: Optional[str] = "AIコンテキスト統合ドキュメント"
    file_name: Optional[str] = "ai_context_document.pdf"
    include_raw_markdown: bool = False
    include_images: bool = True
    include_linked_emails: bool = True
    optimize_tokens: bool = True


class AiHtmlExportRequest(BaseModel):
    file_paths: Optional[List[str]] = None
    vault_path: Optional[str] = ""
    relative_paths: Optional[List[str]] = None
    prompt: Optional[str] = ""
    title: Optional[str] = "AIコンテキスト統合ドキュメント"
    include_raw_markdown: bool = False
    include_images: bool = True
    include_linked_emails: bool = True
    optimize_tokens: bool = True


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
        prompt=req.prompt or "",
        title=req.title or "AIコンテキスト統合ドキュメント",
        include_raw_markdown=req.include_raw_markdown,
        include_images=req.include_images,
        include_linked_emails=req.include_linked_emails,
        optimize_tokens=req.optimize_tokens,
    )

    return Response(
        content=html_content.encode("utf-8"),
        media_type="text/html; charset=utf-8",
        headers={
            "Content-Disposition": 'attachment; filename="ai_context_document.html"'
        },
    )


@router.post("/ai-html/save")
def save_ai_html_endpoint(req: SaveAiHtmlRequest) -> Dict[str, Any]:
    """自己完結HTMLをローカルファイルに保存し、絶対パスを返却する"""
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


@router.post("/ai-pdf/download")
def download_ai_pdf_endpoint(req: AiPdfExportRequest) -> Response:
    """自己完結ドキュメントから高精度PDFを生成してダウンロードファイルとして返却する"""
    html_content = req.html_content
    if not html_content or not html_content.strip():
        paths = req.file_paths or []
        if not paths and not req.relative_paths:
            raise HTTPException(status_code=400, detail="対象ドキュメントまたはHTMLが指定されていません")
        html_content, _ = export_documents_to_html(
            vault_path=req.vault_path or "",
            relative_paths=req.relative_paths,
            file_paths=paths,
            prompt=req.prompt or "",
            title=req.title or "AIコンテキスト統合ドキュメント",
            include_raw_markdown=req.include_raw_markdown,
            include_images=req.include_images,
            include_linked_emails=req.include_linked_emails,
            optimize_tokens=req.optimize_tokens,
        )

    try:
        pdf_bytes = convert_html_to_pdf(html_content)
    except PdfConverterError as e:
        raise HTTPException(status_code=500, detail=str(e))

    raw_name = (req.file_name or f"{req.title or 'ai_context_document'}.pdf").strip()
    raw_name = re.sub(r'[\/:*?"<>|]', "_", raw_name)
    if not raw_name.lower().endswith(".pdf"):
        raw_name += ".pdf"

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{raw_name}"'
        },
    )


@router.post("/ai-pdf/save")
def save_ai_pdf_endpoint(req: SaveAiPdfRequest) -> Dict[str, Any]:
    """高精度PDFをローカルファイルに保存し、絶対パスを返却する"""
    html_content = req.html_content
    if not html_content or not html_content.strip():
        paths = req.file_paths or []
        if not paths and not req.relative_paths:
            raise HTTPException(status_code=400, detail="対象ドキュメントまたはHTMLが指定されていません")
        html_content, _ = export_documents_to_html(
            vault_path=req.vault_path or "",
            relative_paths=req.relative_paths,
            file_paths=paths,
            prompt=req.prompt or "",
            title=req.title or "AIコンテキスト統合ドキュメント",
            include_raw_markdown=req.include_raw_markdown,
            include_images=req.include_images,
            include_linked_emails=req.include_linked_emails,
            optimize_tokens=req.optimize_tokens,
        )

    try:
        pdf_bytes = convert_html_to_pdf(html_content)
    except PdfConverterError as e:
        raise HTTPException(status_code=500, detail=str(e))

    if req.target_dir and req.target_dir.strip():
        save_dir = Path(req.target_dir.strip()).expanduser().resolve()
    else:
        downloads_dir = Path.home() / "Downloads"
        if downloads_dir.is_dir():
            save_dir = downloads_dir
        else:
            save_dir = Path.cwd()

    save_dir.mkdir(parents=True, exist_ok=True)

    raw_name = (req.file_name or f"{req.title or 'ai_context_document'}.pdf").strip()
    raw_name = re.sub(r'[\/:*?"<>|]', "_", raw_name)
    if not raw_name.lower().endswith(".pdf"):
        raw_name += ".pdf"

    base_stem = Path(raw_name).stem
    ext = Path(raw_name).suffix

    target_file = save_dir / raw_name
    counter = 1
    while target_file.exists():
        target_file = save_dir / f"{base_stem} ({counter}){ext}"
        counter += 1

    target_file.write_bytes(pdf_bytes)

    return {
        "success": True,
        "saved_path": str(target_file.resolve()),
        "file_name": target_file.name,
        "size_bytes": target_file.stat().st_size,
    }

