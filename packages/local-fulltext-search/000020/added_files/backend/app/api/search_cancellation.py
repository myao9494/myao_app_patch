"""
検索の切断時中断。

ランチャーや Web 画面は、入力のたびに前の検索を取り消して新しい検索を送る。
サーバーが取り消された検索を最後まで実行し続けると、検索が滞留して後続の検索まで遅くなり、
画面が「検索中」のまま止まって見える。クライアントの切断を検知したら、実行中の SQLite クエリを
progress handler で中断し、ワーカーを空ける。

インデックス更新を伴う検索は、更新が中途半端になるため中断の対象にしない（can_cancel_search）。
"""

from __future__ import annotations

import asyncio
import contextlib
import threading
from collections.abc import Callable
from sqlite3 import Connection
from typing import Protocol, TypeVar

from fastapi.concurrency import run_in_threadpool

from app.models.search import IndexedSearchRequest, SearchQueryParams

T = TypeVar("T")

# 切断の確認間隔（秒）。取り消された検索を 1 秒以内に止められれば、滞留しない。
DEFAULT_POLL_SECONDS = 0.2
# progress handler を呼ぶ SQLite VM 命令の間隔。小さいほど中断が早いが、検索自体が少し遅くなる。
PROGRESS_HANDLER_INTERVAL = 2000


class SearchCancelled(Exception):
    """クライアントが切断したため、検索を中断した。"""


class DisconnectAware(Protocol):
    async def is_disconnected(self) -> bool: ...


def can_cancel_search(params: SearchQueryParams | IndexedSearchRequest) -> bool:
    """既存インデックスだけを読む検索か（インデックス更新を伴わず、途中で中断しても安全か）を返す。"""
    if isinstance(params, IndexedSearchRequest):
        return True
    return params.search_all_enabled or params.skip_refresh


async def run_cancellable(
    request: DisconnectAware,
    connection: Connection,
    work: Callable[[], T],
    *,
    poll_seconds: float = DEFAULT_POLL_SECONDS,
) -> T:
    """
    work をワーカースレッドで実行する。クライアントが切断したら connection の実行中クエリを中断し、
    SearchCancelled を送出する。work が終わるまで待ってから戻るため、呼び出し元は接続を安全に閉じられる。
    """
    cancel_requested = threading.Event()
    connection.set_progress_handler(lambda: 1 if cancel_requested.is_set() else 0, PROGRESS_HANDLER_INTERVAL)
    task = asyncio.ensure_future(run_in_threadpool(work))
    try:
        while not task.done():
            await asyncio.wait({task}, timeout=poll_seconds)
            if not task.done() and await request.is_disconnected():
                cancel_requested.set()
                # 中断されたクエリの例外は呼び出し元へ伝えず、ワーカーが止まるのを待つ。
                with contextlib.suppress(Exception):
                    await task
                raise SearchCancelled
        return task.result()
    except asyncio.CancelledError:
        # サーバー側の取り消し。ワーカーが接続を使い終えるまで待ってから伝播する。
        cancel_requested.set()
        with contextlib.suppress(BaseException):
            await asyncio.shield(task)
        raise
    finally:
        connection.set_progress_handler(None, 0)
