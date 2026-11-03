"""
検索の切断時中断（app.api.search_cancellation）のテスト。
クライアントが取り消した/諦めた検索をサーバーが最後まで実行し続けると、検索が滞留して
後続の検索まで遅くなる。切断を検知したら実行中の SQLite クエリを中断し、ワーカーを空ける。
"""

from __future__ import annotations

import asyncio
import sqlite3
import threading
import time

import pytest

from app.api import search as search_api
from app.api.search_cancellation import SearchCancelled, can_cancel_search, run_cancellable
from app.models.search import IndexedSearchRequest, SearchRequest, SearchResponse

# 数十秒かかる重いクエリ（中断されなければテストがタイムアウトする）
HEAVY_QUERY = """
    WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counter WHERE n < 2000000000)
    SELECT count(*) FROM counter
"""


class FakeRequest:
    """is_disconnected だけを持つ最小のリクエスト。disconnect_after 秒後に切断済みを返す。"""

    def __init__(self, disconnect_after: float | None) -> None:
        self._deadline = None if disconnect_after is None else time.monotonic() + disconnect_after

    async def is_disconnected(self) -> bool:
        return self._deadline is not None and time.monotonic() >= self._deadline


def _connection() -> sqlite3.Connection:
    return sqlite3.connect(":memory:", check_same_thread=False)


def test_result_is_returned_while_the_client_stays_connected() -> None:
    connection = _connection()

    def work() -> int:
        time.sleep(0.3)
        return connection.execute("SELECT 41 + 1").fetchone()[0]

    result = asyncio.run(run_cancellable(FakeRequest(None), connection, work, poll_seconds=0.05))

    assert result == 42


def test_heavy_query_is_aborted_when_the_client_disconnects() -> None:
    connection = _connection()
    started = time.monotonic()

    with pytest.raises(SearchCancelled):
        asyncio.run(
            run_cancellable(
                FakeRequest(0.2),
                connection,
                lambda: connection.execute(HEAVY_QUERY).fetchall(),
                poll_seconds=0.05,
            )
        )

    assert time.monotonic() - started < 5


def test_connection_is_usable_after_cancellation_and_after_normal_completion() -> None:
    """中断用の progress handler を残さない（残ると以降のクエリが中断され続ける）。"""
    connection = _connection()
    with pytest.raises(SearchCancelled):
        asyncio.run(
            run_cancellable(
                FakeRequest(0.1),
                connection,
                lambda: connection.execute(HEAVY_QUERY).fetchall(),
                poll_seconds=0.05,
            )
        )
    quick = "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 300000) SELECT count(*) FROM c"

    assert connection.execute(quick).fetchone()[0] == 300000
    assert asyncio.run(run_cancellable(FakeRequest(None), connection, lambda: connection.execute(quick).fetchone()[0])) == 300000
    assert connection.execute(quick).fetchone()[0] == 300000


def test_errors_from_the_work_are_raised_to_the_caller() -> None:
    connection = _connection()

    def work() -> None:
        raise ValueError("検索失敗")

    with pytest.raises(ValueError, match="検索失敗"):
        asyncio.run(run_cancellable(FakeRequest(None), connection, work, poll_seconds=0.05))


def test_search_that_refreshes_the_index_does_not_block_the_event_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    インデックス更新を伴う検索は中断しないが、イベントループの上で実行してもいけない。
    ループが止まると、切断の検知も他の検索の受け付けも、その検索が終わるまで止まる。
    """
    threads: dict[str, int] = {}

    def fake_dispatch(params: SearchRequest, service: object) -> SearchResponse:
        threads["search"] = threading.get_ident()
        return SearchResponse(total=0, items=[])

    monkeypatch.setattr(search_api, "_dispatch_search", fake_dispatch)

    async def post() -> object:
        threads["event_loop"] = threading.get_ident()
        return await search_api.post_search(FakeRequest(None), SearchRequest(q="a"), service=object())

    response = asyncio.run(post())

    assert isinstance(response, SearchResponse)
    assert threads["search"] != threads["event_loop"]


def test_only_searches_that_do_not_refresh_the_index_can_be_cancelled() -> None:
    """インデックス更新を伴う検索を途中で中断すると更新が中途半端になるため、中断の対象にしない。"""
    assert can_cancel_search(IndexedSearchRequest(q="a", folder_path=""))
    assert can_cancel_search(SearchRequest(q="a", skip_refresh=True))
    assert can_cancel_search(SearchRequest(q="a", search_all_enabled=True))
    assert not can_cancel_search(SearchRequest(q="a", skip_refresh=False, search_all_enabled=False))
