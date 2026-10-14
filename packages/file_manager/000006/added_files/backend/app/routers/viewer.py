"""
ファイル配信・インライン表示 APIルーター
- GET /api/download: ダウンロード
- GET /api/view-pdf: PDF のインライン表示
- GET /api/view-html: HTML のインラインプレビュー
- GET /api/view-image: 画像のインライン表示（Obsidian Vault 内の画像・Excalidraw プレビューを自動解決）
- GET /api/folder-images: フォルダ内画像一覧（階層指定、.git / node_modules を除外）
"""
import html
import os
import urllib.parse
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from app.services.obsidian import (
    find_file_in_vault,
    find_obsidian_vault_root,
    resolve_excalidraw_preview_image,
)
from app.services.paths import (
    normalize_path,
)

router = APIRouter()


class FolderImageItem(BaseModel):
    """フォルダ内画像アイテムのスキーマ"""

    name: str
    type: str = "file"
    path: str
    size: Optional[int] = None
    modified: Optional[str] = None
    relativePath: str


class FolderImagesResponse(BaseModel):
    """フォルダ内画像一覧のレスポンススキーマ"""

    path: str
    depth: int
    total: int
    images: List[FolderImageItem]


@router.get("/download")
def download_file(path: str = Query(..., description="ダウンロードするファイルのパス")):
    """
    ファイルをダウンロード
    """
    target_path = normalize_path(path)
    
    if not target_path.exists():
        raise HTTPException(status_code=404, detail="ファイルが見つかりません")
    
    if target_path.is_dir():
         raise HTTPException(status_code=400, detail="ディレクトリはダウンロードできません（ZIP機能未実装）")

    return FileResponse(
        path=target_path,
        filename=target_path.name,
        media_type='application/octet-stream'
    )


@router.get("/view-pdf")
def view_pdf(path: str = Query(..., description="表示するPDFファイルのパス")):
    """
    PDFファイルをブラウザ内で表示（ダウンロードではなくインライン表示）
    """
    target_path = normalize_path(path)

    if not target_path.exists():
        raise HTTPException(status_code=404, detail="ファイルが見つかりません")

    if target_path.is_dir():
        raise HTTPException(status_code=400, detail="ディレクトリは表示できません")

    if not target_path.name.lower().endswith('.pdf'):
        raise HTTPException(status_code=400, detail="PDFファイルではありません")

    # 日本語ファイル名に対応するため、RFC 2231形式でエンコード
    encoded_filename = urllib.parse.quote(target_path.name)

    return FileResponse(
        path=target_path,
        filename=target_path.name,
        media_type='application/pdf',
        headers={"Content-Disposition": f"inline; filename*=UTF-8''{encoded_filename}"}
    )


@router.get("/view-html")
def view_html(path: str = Query(..., description="表示するHTMLファイルのパス")):
    """
    HTMLファイルをブラウザ内で表示（ソースコードではなくレンダリングプレビュー表示）
    """
    target_path = normalize_path(path)

    if not target_path.exists():
        raise HTTPException(status_code=404, detail="ファイルが見つかりません")

    if target_path.is_dir():
        raise HTTPException(status_code=400, detail="ディレクトリは表示できません")

    name_lower = target_path.name.lower()
    if not (name_lower.endswith('.html') or name_lower.endswith('.htm')):
        raise HTTPException(status_code=400, detail="HTMLファイルではありません")

    # 日本語ファイル名に対応するため、RFC 2231形式でエンコード
    encoded_filename = urllib.parse.quote(target_path.name)

    return FileResponse(
        path=target_path,
        filename=target_path.name,
        media_type='text/html; charset=utf-8',
        headers={"Content-Disposition": f"inline; filename*=UTF-8''{encoded_filename}"}
    )


IMAGE_MEDIA_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".avif": "image/avif",
}


@router.get("/view-image")
def view_image(
    path: str = Query(..., description="表示する画像ファイルのパス"),
    baseDir: Optional[str] = Query(None, description="基準ディレクトリ（Obsidianノート等の親ディレクトリ）"),
):
    """
    画像ファイルをブラウザ内でインライン表示
    Obsidian Vault 内の画像パスや Excalidraw プレビューの自動解決に対応
    """
    raw_path_str = path.strip()
    base_dir_path: Optional[Path] = None
    vault_root: Optional[Path] = None

    if baseDir:
        try:
            base_dir_path = normalize_path(baseDir)
            if base_dir_path.exists():
                vault_root = find_obsidian_vault_root(base_dir_path)
        except Exception:
            pass

    # パスの正規化
    target_path: Optional[Path] = None
    try:
        candidate = normalize_path(raw_path_str)
        if candidate.exists():
            target_path = candidate
    except Exception:
        pass

    # 存在しない場合、baseDirからの相対パスやVaultルートからの相対パスを試行
    if not target_path or not target_path.exists():
        if base_dir_path and base_dir_path.is_dir():
            candidate = base_dir_path / raw_path_str
            if candidate.exists():
                target_path = candidate

        if (not target_path or not target_path.exists()) and vault_root and vault_root.is_dir():
            candidate = vault_root / raw_path_str
            if candidate.exists():
                target_path = candidate

    # .excalidraw ファイルで .excalidraw.md が存在する場合のフォールバック
    if not target_path or not target_path.exists():
        if raw_path_str.endswith(".excalidraw"):
            try:
                candidate = normalize_path(raw_path_str + ".md")
                if candidate.exists():
                    target_path = candidate
            except Exception:
                pass

            if not target_path:
                for base in [base_dir_path, vault_root]:
                    if base and base.is_dir():
                        candidate = base / (raw_path_str + ".md")
                        if candidate.exists():
                            target_path = candidate
                            break

    # ファイル名のみの指定で Vault 内を検索（ファイル名索引をキャッシュして高速化）
    if (not target_path or not target_path.exists()) and vault_root and "/" not in raw_path_str and "\\" not in raw_path_str:
        target_path = find_file_in_vault(vault_root, raw_path_str)
        if not target_path and (raw_path_str.endswith(".excalidraw") or "." not in raw_path_str):
            target_path = find_file_in_vault(vault_root, f"{raw_path_str}.md")

    if not target_path or not target_path.exists():
        raise HTTPException(status_code=404, detail="ファイルが見つかりません")

    if target_path.is_dir():
        raise HTTPException(status_code=400, detail="ディレクトリは表示できません")

    # Excalidraw ファイル判定
    is_excalidraw = (
        target_path.name.lower().endswith(".excalidraw.md")
        or target_path.name.lower().endswith(".excalidraw")
    )
    if is_excalidraw:
        preview_image = resolve_excalidraw_preview_image(target_path, vault_root)
        if preview_image and preview_image.is_file():
            target_path = preview_image
        else:
            # キャッシュ画像がない場合、簡易SVGを動的生成して返す
            title = html.escape(target_path.stem.replace(".excalidraw", ""))
            svg_content = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500" width="100%" height="100%">
  <rect width="100%" height="100%" fill="#1e1e1e" rx="12" stroke="#333" stroke-width="2"/>
  <text x="50%" y="45%" fill="#66ff69" font-family="sans-serif" font-size="28" font-weight="bold" text-anchor="middle">🎨 Excalidraw Drawing</text>
  <text x="50%" y="58%" fill="#d4d4d4" font-family="sans-serif" font-size="20" text-anchor="middle">{title}</text>
  <text x="50%" y="70%" fill="#888" font-family="sans-serif" font-size="14" text-anchor="middle">（プレビューキャッシュ未生成 - タップしてExcalidrawで開く）</text>
</svg>'''
            return Response(content=svg_content, media_type="image/svg+xml")

    ext = target_path.suffix.lower()
    media_type = IMAGE_MEDIA_TYPES.get(ext)
    if not media_type:
        raise HTTPException(status_code=400, detail="画像ファイルではありません")

    encoded_filename = urllib.parse.quote(target_path.name)
    return FileResponse(
        path=target_path,
        filename=target_path.name,
        media_type=media_type,
        headers={
            "Content-Disposition": f"inline; filename*=UTF-8''{encoded_filename}",
            "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
        }
    )


@router.get("/folder-images", response_model=FolderImagesResponse)
def get_folder_images(
    path: str = Query(..., description="画像一覧を取得するディレクトリのパス"),
    depth: int = Query(0, ge=0, le=10, description="走査階層（0=直下のみ、1=1階層下まで...）"),
    ignore: str = Query("", description="除外パターン（カンマ区切り）"),
) -> FolderImagesResponse:
    """
    指定ディレクトリ配下の画像ファイル一覧を取得する（階層指定対応）
    """
    raw_path_str = path.strip()
    try:
        target_path = normalize_path(raw_path_str)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    if not target_path.exists():
        raise HTTPException(status_code=404, detail="ディレクトリが見つかりません")

    if not target_path.is_dir():
        raise HTTPException(status_code=400, detail="ディレクトリを指定してください")

    default_ignores = {".git", ".svn", "__pycache__", ".DS_Store", "node_modules", ".venv", "venv", ".idea", ".vscode"}
    custom_ignores = {p.strip() for p in ignore.split(",") if p.strip()}
    ignore_set = default_ignores | custom_ignores

    found_images: List[FolderImageItem] = []
    base_path_str = str(target_path)

    def scan_dir(current_dir: Path, current_depth: int) -> None:
        try:
            with os.scandir(current_dir) as entries:
                sub_dirs: List[Path] = []
                for entry in entries:
                    try:
                        if entry.name in ignore_set or (entry.name.startswith(".") and entry.is_dir(follow_symlinks=False)):
                            continue

                        if entry.is_file(follow_symlinks=False):
                            ext = os.path.splitext(entry.name)[1].lower()
                            if ext in IMAGE_MEDIA_TYPES:
                                stat = entry.stat()
                                mtime_str = datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S")
                                rel_path = os.path.relpath(entry.path, base_path_str)
                                found_images.append(
                                    FolderImageItem(
                                        name=entry.name,
                                        type="file",
                                        path=entry.path,
                                        size=stat.st_size,
                                        modified=mtime_str,
                                        relativePath=rel_path,
                                    )
                                )
                        elif entry.is_dir(follow_symlinks=False) and current_depth < depth:
                            sub_dirs.append(Path(entry.path))
                    except (PermissionError, OSError):
                        continue

                for sd in sorted(sub_dirs, key=lambda p: p.name.lower()):
                    scan_dir(sd, current_depth + 1)
        except (PermissionError, OSError):
            pass

    scan_dir(target_path, 0)
    found_images.sort(key=lambda img: (img.relativePath.lower(), img.name.lower()))

    return FolderImagesResponse(
        path=str(target_path),
        depth=depth,
        total=len(found_images),
        images=found_images,
    )
