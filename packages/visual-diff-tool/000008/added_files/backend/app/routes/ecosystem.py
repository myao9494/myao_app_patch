"""
エコシステム API (ハーネスの LLM や、ほかの自作アプリから使う共通の入口)。
共通の形は、ハーネス (opencode) の docs/apps.md の「エコシステム API 1」。

- GET  /api/ecosystem       : アプリの名乗り。版、人が開く深いリンクのひな形、使ってよい操作の一覧
- POST /api/ecosystem/diff  : ローカルのファイルのパスを 2 つ受け取り、画像の差分を「数値と位置の言葉」で返す
    入力: {"path_a", "path_b", "page_a"=0, "page_b"=0, "category"="汎用", "threshold"=0.1,
           "max_rects"=10, "open_browser"=false}
    出力: result_id、画面の URL、大きさ、位置合わせの結果、差分の画素数と割合、
          差分の領域 (大きい順。位置は 3x3 の「上左」〜「下右」、面積の割合つき)、変換の注意
    画像の中身 (base64) は返さない。画像を見られない LLM が、トークンを使わずに差分を理解するため。
    ブラウザは、open_browser が true で、localhost からの呼び出しのときだけ開く (既存の /api/diff と同じ決まり)。
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from pydantic import BaseModel, Field

from ..diff_pipeline import build_diff_response, schedule_open_result
from ..image_io import MAX_UPLOAD_BYTES

router = APIRouter()

ECOSYSTEM_VERSION = 1
APP_ID = "diff"
APP_TITLE = "Visual Diff Tool (画像・図面・3D の差分)"
APP_VERSION = "0.1.0"

OPERATIONS = [
    {"id": "diff.files", "method": "POST", "path": "/api/ecosystem/diff", "effect": "read"},
    {"id": "diff.result", "method": "GET", "path": "/api/diff/{result_id}", "effect": "read"},
    # Obsidian のノートを起点にした Git の変更一覧 (ノート・埋め込みの図・画像) と、人が開く画面の diff_url。読み取りだけ
    {"id": "git.markdown", "method": "GET", "path": "/api/git/markdown", "effect": "read"},
]
# コミット・書き戻し (/api/git/commit・save-text・revert-line) は、外から使わせないので載せない
LINKS = {"home": "/", "result": "/?result_id={result_id}", "markdown": "/?markdown_path={path}"}


class EcosystemDiffRequest(BaseModel):
    path_a: str = Field(min_length=1)
    path_b: str = Field(min_length=1)
    page_a: int = Field(0, ge=0)
    page_b: int = Field(0, ge=0)
    category: str = "汎用"
    threshold: float = Field(0.1, ge=0.0, le=1.0)
    max_rects: int = Field(10, ge=0, le=100)
    open_browser: bool = False


def _base_url(request: Request) -> str:
    return str(request.base_url).rstrip("/")


@router.get("/api/ecosystem")
def ecosystem_manifest(request: Request) -> dict:
    """アプリの名乗り (エコシステム API 1 の共通の形)。"""
    return {
        "ecosystem": ECOSYSTEM_VERSION,
        "app": APP_ID,
        "title": APP_TITLE,
        "version": APP_VERSION,
        "base_url": _base_url(request),
        "links": LINKS,
        "operations": OPERATIONS,
    }


def _read_local_file(raw: str) -> tuple[str, bytes]:
    """ローカルのファイルを読む。無い・フォルダ・大きすぎるものは拒否する。"""
    path = Path(raw).expanduser()
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"ファイルがありません: {raw}")
    if not path.is_file():
        raise HTTPException(status_code=400, detail=f"ファイルではありません: {raw}")
    size = path.stat().st_size
    if size > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"ファイルが大きすぎます。上限は1ファイル {MAX_UPLOAD_BYTES / (1024 * 1024):.0f} MB です")
    return path.name, path.read_bytes()


def position_label(x: int, y: int, width: int, height: int, image_width: int, image_height: int) -> str:
    """領域の中心が、画像を 3x3 に分けたどこにあるかを「上左」〜「下右」で返す。"""
    cx = (x + width / 2) / max(1, image_width)
    cy = (y + height / 2) / max(1, image_height)
    row = "上" if cy < 1 / 3 else "中" if cy < 2 / 3 else "下"
    col = "左" if cx < 1 / 3 else "中" if cx < 2 / 3 else "右"
    return row + col


@router.post("/api/ecosystem/diff")
def ecosystem_diff(payload: EcosystemDiffRequest, request: Request, background_tasks: BackgroundTasks) -> dict:
    """2 つのローカルのファイルの差分を、画像なしの要約で返す。"""
    name_a, content_a = _read_local_file(payload.path_a)
    name_b, content_b = _read_local_file(payload.path_b)
    response = build_diff_response(
        filename_a=name_a,
        content_a=content_a,
        filename_b=name_b,
        content_b=content_b,
        category=payload.category,
        diff_threshold=payload.threshold,
        page_a=payload.page_a,
        page_b=payload.page_b,
    )
    if payload.open_browser:
        schedule_open_result(background_tasks, request, response.result_id)
    total = max(1, response.width * response.height)
    rects = sorted(response.diff_rects, key=lambda r: r.area, reverse=True)
    alignment = response.alignment
    return {
        "result_id": response.result_id,
        "ui_url": f"{_base_url(request)}/?result_id={response.result_id}" if response.result_id else None,
        "filename_a": name_a,
        "filename_b": name_b,
        "page_a": response.page_a,
        "page_b": response.page_b,
        "width": response.width,
        "height": response.height,
        "alignment": {
            "success": alignment.success,
            "method": alignment.method,
            "warning": alignment.warning,
            "matches": alignment.matches,
            "inliers": alignment.inliers,
        },
        "diff_pixels": response.diff_pixels,
        "diff_ratio": response.diff_ratio,
        "threshold": response.diff_threshold,
        "rect_count": len(rects),
        "rects": [
            {
                "x": r.x,
                "y": r.y,
                "width": r.width,
                "height": r.height,
                "area": r.area,
                "area_ratio": round(r.area / total, 6),
                "position": position_label(r.x, r.y, r.width, r.height, response.width, response.height),
            }
            for r in rects[: payload.max_rects]
        ],
        "warnings": list(response.conversion_warnings),
    }
