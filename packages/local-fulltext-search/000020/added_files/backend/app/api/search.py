"""
検索API エンドポイント。リクエスト単位のDB接続を依存性注入で受け取る。
通常キーワード検索、ベクトル検索、ハイブリッド検索（デフォルト）の3方式を提供し、
方式ごとの実行と結果整形は app.services.search_dispatcher に委譲する。
"""

from collections.abc import Callable
from datetime import date

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.concurrency import run_in_threadpool

from app.api.deps import get_search_service
from app.api.search_cancellation import SearchCancelled, can_cancel_search, run_cancellable
from app.models.search import (
    IndexedSearchRequest,
    SearchClickRequest,
    SearchClickResponse,
    SearchQueryParams,
    SearchRequest,
    SearchResponse,
)
from app.services.search_dispatcher import dispatch_search as _dispatch_search
from app.services.search_service import SearchService

router = APIRouter(prefix="/api", tags=["search"])

# クライアントが切断した（取り消した）ため検索を中断したときの応答。誰にも届かないが、ログ上で区別できる。
CLIENT_CLOSED_REQUEST = 499


async def _run_search(
    request: Request,
    params: SearchQueryParams | IndexedSearchRequest,
    service: SearchService,
    run: Callable[[], SearchResponse],
) -> SearchResponse | Response:
    """
    検索を実行する。インデックス更新を伴わない検索は、クライアントが切断したら中断する。
    取り消された検索が実行され続けると、入力のたびに検索が滞留して画面が「検索中」のまま止まるため。
    中断しない検索もワーカースレッドで実行する（イベントループの上で動かすと、終わるまで他の検索が受け付けられない）。
    """
    if not can_cancel_search(params):
        return await run_in_threadpool(run)
    try:
        return await run_cancellable(request, service.connection, run)
    except SearchCancelled:
        return Response(status_code=CLIENT_CLOSED_REQUEST)


@router.get("/search", response_model=SearchResponse)
def search(
    q: str = Query(..., min_length=1),
    full_path: str = Query(default=""),
    search_all_enabled: bool = Query(default=False),
    skip_refresh: bool = Query(default=False),
    source_type: str = Query(default="local"),
    index_depth: int | None = Query(default=None, ge=0, le=99999),
    refresh_window_minutes: int = Query(default=0, ge=0, le=1440),
    regex_enabled: bool = Query(default=False),
    search_target: str = Query(default="all"),
    include_path_in_filename: bool = Query(default=True),
    index_types: str | None = None,
    types: str | None = None,
    exclude_keywords: str | None = None,
    date_field: str = Query(default="created"),
    sort_by: str = Query(default="default"),
    sort_order: str = Query(default="desc"),
    created_from: date | None = None,
    created_to: date | None = None,
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    include_gantt_tasks: bool = Query(default=False),
    search_type: str = Query(default="hybrid"),
    service: SearchService = Depends(get_search_service),
) -> SearchResponse:
    params = SearchQueryParams(
        q=q,
        full_path=full_path,
        search_all_enabled=search_all_enabled,
        skip_refresh=skip_refresh,
        source_type=source_type,
        index_depth=index_depth,
        refresh_window_minutes=refresh_window_minutes,
        regex_enabled=regex_enabled,
        search_target=search_target,
        include_path_in_filename=include_path_in_filename,
        index_types=index_types,
        types=types,
        exclude_keywords=exclude_keywords,
        date_field=date_field,
        sort_by=sort_by,
        sort_order=sort_order,
        created_from=created_from,
        created_to=created_to,
        limit=limit,
        offset=offset,
        include_gantt_tasks=include_gantt_tasks,
        search_type=search_type,
    )
    return _dispatch_search(params, service)


def search_with_body(
    params: SearchRequest,
    service: SearchService = Depends(get_search_service),
) -> SearchResponse:
    return _dispatch_search(params, service)


def search_existing_index(
    params: IndexedSearchRequest,
    service: SearchService = Depends(get_search_service),
) -> SearchResponse:
    """
    既存インデックスだけを使って検索し、必要な再インデックスは行わない。
    """
    return _dispatch_search(params, service)


@router.post("/search", response_model=SearchResponse)
async def post_search(
    request: Request,
    params: SearchRequest,
    service: SearchService = Depends(get_search_service),
) -> SearchResponse | Response:
    return await _run_search(request, params, service, lambda: search_with_body(params, service))


@router.post("/search/indexed", response_model=SearchResponse)
async def post_search_existing_index(
    request: Request,
    params: IndexedSearchRequest,
    service: SearchService = Depends(get_search_service),
) -> SearchResponse | Response:
    """
    既存インデックスだけを使って検索し、必要な再インデックスは行わない。
    クライアントが切断したら検索を中断する。
    """
    return await _run_search(request, params, service, lambda: search_existing_index(params, service))


@router.post("/search/click", response_model=SearchClickResponse)
def record_search_click(
    payload: SearchClickRequest,
    service: SearchService = Depends(get_search_service),
) -> SearchClickResponse:
    return SearchClickResponse(file_id=payload.file_id, click_count=service.record_click(payload.file_id, payload.query))


@router.post("/gantt/tasks/{task_id}/open-input")
def open_gantt_task_input(
    task_id: int,
    service: SearchService = Depends(get_search_service),
) -> dict[str, object]:
    """
    Web/ランチャーから gantt タスク入力画面表示 API を呼び出す。
    """
    service.open_gantt_task_input(task_id)
    return {"status": "ok", "task_id": task_id}
