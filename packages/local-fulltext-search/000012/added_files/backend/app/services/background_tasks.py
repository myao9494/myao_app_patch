"""
応答を待たせない後処理（検索後の再インデックス、Obsidian 同期）を実行するバックグラウンドスレッドの管理。

デーモンスレッドで実行し、テストの後始末で完了を待てるよう、実行中のスレッドを追跡する。
"""

from __future__ import annotations

import threading
import time as time_module
from collections.abc import Callable

_BACKGROUND_THREADS_LOCK = threading.Lock()
_BACKGROUND_THREADS: set[threading.Thread] = set()


def start_background_thread(target: Callable[[], None], *, name: str) -> None:
    """target をデーモンスレッドで実行する。"""

    def run() -> None:
        try:
            target()
        finally:
            with _BACKGROUND_THREADS_LOCK:
                _BACKGROUND_THREADS.discard(threading.current_thread())

    thread = threading.Thread(target=run, name=name, daemon=True)
    with _BACKGROUND_THREADS_LOCK:
        _BACKGROUND_THREADS.add(thread)
    thread.start()


def wait_for_background_tasks(timeout: float = 10.0) -> bool:
    """
    実行中のバックグラウンド処理がすべて終わるまで待つ。
    制限時間内にすべて完了した場合だけ True を返す。
    """
    deadline = time_module.monotonic() + timeout
    while True:
        with _BACKGROUND_THREADS_LOCK:
            threads = list(_BACKGROUND_THREADS)
        if not threads:
            return True
        for thread in threads:
            thread.join(timeout=max(deadline - time_module.monotonic(), 0.0))
        if time_module.monotonic() >= deadline:
            with _BACKGROUND_THREADS_LOCK:
                return not _BACKGROUND_THREADS
