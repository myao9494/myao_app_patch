"""
全文検索プロキシ
Local-fulltext-search のAPIを file_manager の全文検索UIで扱いやすい形式に変換して返す
"""
from datetime import datetime
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.config import settings

router = APIRouter()

TIMEOUT = 10.0


class FulltextStatusResponse(BaseModel):
    ready: bool
    total_indexed: int
    is_running: bool = False
    last_error: str | None = None


class FulltextSearchItem(BaseModel):
    name: str
    path: str
    type: str
    size: Optional[int] = None
    date_modified: Optional[float] = None
    snippet: str | None = None


class FulltextSearchResponse(BaseModel):
    totalResults: int
    results: list[FulltextSearchItem]


@router.get("/fulltext-search/status", response_model=FulltextStatusResponse)
async def get_status() -> FulltextStatusResponse:
    """
    全文検索サービスの稼働状態を取得する。
    """
    try:
        async with httpx.AsyncClient(trust_env=False) as client:
            response = await client.get(
                f"{settings.fulltext_service_url}/api/index/status",
                timeout=TIMEOUT,
            )
            response.raise_for_status()
            payload = response.json()
    except Exception:
        return FulltextStatusResponse(
            ready=False,
            total_indexed=0,
            is_running=False,
            last_error=None,
        )

    return FulltextStatusResponse(
        ready=True,
        total_indexed=int(payload.get("total_files", 0) or 0),
        is_running=bool(payload.get("is_running", False)),
        last_error=payload.get("last_error"),
    )


@router.get("/fulltext-search", response_model=FulltextSearchResponse)
async def search_fulltext(
    search: str = Query(..., min_length=1, description="検索クエリ"),
    path: str = Query("", description="検索対象フォルダ。空文字なら全体検索"),
    depth: int = Query(1, ge=0, description="検索階層"),
    count: int = Query(100, ge=1, le=1000, description="取得件数"),
    offset: int = Query(0, ge=0, description="オフセット"),
    file_type: str = Query("all", description="種別フィルタ"),
) -> FulltextSearchResponse:
    """
    全文検索サービスへ検索を委譲し、既存フロントエンドが扱う形式へ整形する。
    """
    if file_type == "directory":
        return FulltextSearchResponse(totalResults=0, results=[])

    # depth=0 は無制限階層を意味するため、全文検索サービスへは十分な深さ（20）を渡す
    actual_depth = 20 if depth == 0 else depth

    request_body = {
        "q": search,
        "full_path": path,
        "index_depth": actual_depth,
        "refresh_window_minutes": settings.fulltext_refresh_window_minutes,
        "regex_enabled": False,
        "limit": count,
        "offset": offset,
    }

    try:
        payload = await _search_with_legacy_limit_fallback(request_body)
    except httpx.HTTPStatusError as error:
        detail = _extract_error_detail(error.response) if error.response is not None else str(error)
        raise HTTPException(status_code=502, detail=f"全文検索サービスエラー: {detail}") from error
    except httpx.RequestError as error:
        raise HTTPException(status_code=503, detail=f"全文検索サービスに接続できません: {error}") from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"全文検索プロキシエラー: {error}") from error

    results = [
        FulltextSearchItem(
            name=str(item["file_name"]),
            path=str(item["full_path"]),
            type="file",
            size=None,
            date_modified=_parse_timestamp(item.get("mtime")),
            snippet=str(item["snippet"]) if item.get("snippet") is not None else None,
        )
        for item in payload.get("items", [])
    ]
    return FulltextSearchResponse(
        totalResults=int(payload.get("total", 0) or 0),
        results=results,
    )


def _parse_timestamp(value: object) -> float | None:
    """
    ISO形式の更新日時を Unix timestamp に変換する。
    """
    if not isinstance(value, str) or not value:
        return None
    return datetime.fromisoformat(value).timestamp()


async def _search_with_legacy_limit_fallback(request_body: dict[str, object]) -> dict[str, object]:
    """
    古い全文検索サービスが limit<=100 の場合は、自動的に 100 件へ落として再試行する。
    """
    async with httpx.AsyncClient(trust_env=False) as client:
        response = await client.post(
            f"{settings.fulltext_service_url}/api/search",
            json=request_body,
            timeout=TIMEOUT,
        )
        if response.status_code == 422 and _is_legacy_limit_validation_error(response):
            fallback_body = {**request_body, "limit": 100}
            response = await client.post(
                f"{settings.fulltext_service_url}/api/search",
                json=fallback_body,
                timeout=TIMEOUT,
            )

        response.raise_for_status()
        return response.json()


def _is_legacy_limit_validation_error(response: httpx.Response) -> bool:
    """
    limit の上限が 100 の旧サーバーで弾かれた 422 かどうかを判定する。
    """
    try:
        payload = response.json()
    except ValueError:
        return False

    detail = payload.get("detail")
    if not isinstance(detail, list):
        return False

    return any(
        isinstance(item, dict)
        and item.get("type") == "less_than_equal"
        and item.get("loc") == ["body", "limit"]
        and item.get("ctx", {}).get("le") == 100
        for item in detail
    )


def _extract_error_detail(response: httpx.Response) -> str:
    """
    JSON detail を優先して、利用者向けに読めるエラーメッセージへ整形する。
    """
    try:
        payload = response.json()
    except ValueError:
        return response.text

    detail = payload.get("detail")
    if isinstance(detail, str):
        return detail
    if isinstance(detail, list):
        messages = [str(item.get("msg")) for item in detail if isinstance(item, dict) and item.get("msg")]
        if messages:
            return " ".join(messages)
    return response.text
