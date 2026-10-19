"""
AIインプット書き出しの、項目ごとの時間制限と「処理できなかったリンク」の記録。

仕様:
- 書き出しは、ノート・リンク先ノート・画像・図面・メールなどの項目を 1 つずつ処理する。社内のネットワークドライブなどで
  1 つの項目が終わらないと、書き出し全体が返ってこなくなる。それを避けるため、`export_guard_scope(制限秒)` の中では
  `run_guarded(処理, 種類, 対象)` が処理を別スレッドで動かし、制限時間（既定 10 秒）を超えたら待たずに既定値を返す。
  止まった処理のスレッドは止められないため、デーモンスレッドとして放置する（応答を返すことを優先する）。
- 処理が例外を出したときも、既定値を返して続ける。
- 飛ばした項目は、種類・対象・リンク元・理由（not_found / timeout / error）・詳細・秒数をスコープの一覧へ記録する。
  同じ項目（種類・対象・リンク元・理由）は 1 度だけ記録する。見つからなかったリンクは呼び出し側が `record_skip` で記録する。
- スコープの外では、`run_guarded` はその場でそのまま実行し、`record_skip` は何もしない（従来の挙動を変えない）。
  入れ子のスコープは外側へ記録する。
- スレッドへはコンテキスト（段階別の計測・ファイル名索引）を引き継ぐ。記録はロックで守る。
"""

from __future__ import annotations

import contextvars
import logging
import threading
import time
from contextlib import contextmanager
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple, TypeVar

logger = logging.getLogger(__name__)

DEFAULT_ITEM_TIMEOUT_SECONDS = 10.0

SKIP_NOT_FOUND = "not_found"
SKIP_TIMEOUT = "timeout"
SKIP_ERROR = "error"

_T = TypeVar("_T")


class _Guard:
    def __init__(self, timeout_seconds: float) -> None:
        self.timeout_seconds = timeout_seconds
        self.skipped: List[Dict[str, Any]] = []
        self.seen: set[Tuple[str, str, str, str]] = set()
        self.lock = threading.Lock()

    def add(self, item: Dict[str, Any]) -> None:
        key = (item["kind"], item["target"], item["source"], item["reason"])
        with self.lock:
            if key in self.seen:
                return
            self.seen.add(key)
            self.skipped.append(item)


_guard: contextvars.ContextVar[Optional[_Guard]] = contextvars.ContextVar("export_guard", default=None)


@contextmanager
def export_guard_scope(timeout_seconds: float = DEFAULT_ITEM_TIMEOUT_SECONDS) -> Iterator[List[Dict[str, Any]]]:
    """このブロックの間、項目ごとの時間制限を有効にし、飛ばした項目の一覧を返す。入れ子のときは外側の一覧を使う。"""
    current = _guard.get()
    if current is not None:
        yield current.skipped
        return
    guard = _Guard(timeout_seconds)
    token = _guard.set(guard)
    try:
        yield guard.skipped
    finally:
        _guard.reset(token)


def record_skip(
    kind: str,
    target: str,
    reason: str,
    source: str = "",
    detail: str = "",
    seconds: float = 0.0,
) -> None:
    """処理できなかった項目を記録する。スコープの外では何もしない。"""
    guard = _guard.get()
    if guard is None:
        return
    guard.add({
        "kind": kind,
        "target": target,
        "source": source,
        "reason": reason,
        "detail": detail,
        "seconds": round(seconds, 2),
    })


def run_guarded(
    func: Callable[[], _T],
    kind: str,
    target: str,
    source: str = "",
    default: Any = None,
) -> Any:
    """
    func を制限時間つきで実行する。時間切れ・例外のときは default を返し、飛ばした項目として記録する。
    スコープの外では func をそのまま実行して結果を返す（例外もそのまま出す）。
    """
    guard = _guard.get()
    if guard is None:
        return func()

    ctx = contextvars.copy_context()
    box: Dict[str, Any] = {}

    def runner() -> None:
        try:
            box["value"] = ctx.run(func)
        except Exception as exc:  # 項目の失敗は書き出し全体を止めない
            box["error"] = exc

    started = time.perf_counter()
    worker = threading.Thread(target=runner, name=f"export-guard:{kind}", daemon=True)
    worker.start()
    worker.join(guard.timeout_seconds)
    elapsed = time.perf_counter() - started

    if worker.is_alive():
        logger.warning("Export item timed out after %.1fs and was skipped: %s %s (source: %s)", elapsed, kind, target, source)
        record_skip(kind, target, SKIP_TIMEOUT, source=source, detail=f"{guard.timeout_seconds:g} 秒で打ち切り", seconds=elapsed)
        return default
    if "error" in box:
        exc = box["error"]
        logger.warning("Export item failed and was skipped: %s %s (source: %s)", kind, target, source, exc_info=exc)
        record_skip(kind, target, SKIP_ERROR, source=source, detail=f"{type(exc).__name__}: {exc}", seconds=elapsed)
        return default
    return box.get("value")
