"""
AIコンテキストエクスポートAPIルーター。
仕様:
- 選択された複数ドキュメントから自己完結型HTMLを生成する。
- HTMLコード生成およびファイルダウンロードレスポンスを提供。
"""

from pathlib import Path
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from app.vector.html_exporter import export_documents_to_html

router = APIRouter(prefix="/api/export", tags=["export"])


class AiHtmlExportRequest(BaseModel):
    file_paths: Optional[List[str]] = None
    vault_path: Optional[str] = ""
    relative_paths: Optional[List[str]] = None
    prompt: Optional[str] = ""
    title: Optional[str] = "AIコンテキスト統合ドキュメント"
    include_raw_markdown: bool = True
    include_images: bool = True
    include_linked_emails: bool = True


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
    )

    return Response(
        content=html_content.encode("utf-8"),
        media_type="text/html; charset=utf-8",
        headers={
            "Content-Disposition": 'attachment; filename="ai_context_document.html"'
        },
    )
