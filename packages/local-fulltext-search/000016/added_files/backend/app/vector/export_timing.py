"""
AIインプット書き出しの段階別所要時間の計測。

仕様:
- `timing_scope()` の中で `stage(名前, 詳細)` を使うと、段階ごとに合計秒・回数・遅い上位 5 件の詳細を集計する。
  スコープの外では `stage` は何もしない（計測を入れた関数を単体で呼んでも安全）。
- `@timed_export(ラベル)` で包んだ書き出し関数は、戻り値の stats（2 番目の要素）へ `timings` を足し、
  集計表を INFO ログと `<データフォルダ>/export_timing.log` へ追記する。レポート書き込みの失敗は書き出しを妨げない。
  stats に `skipped_links`（時間切れ・見つからないなどで飛ばした項目。app.vector.export_guard）があれば、レポートの末尾へ並べる。
- 目的は、遅い環境（社内 Windows・ネットワークドライブ）でどの段階が支配的かを実測すること。
  計測のオーバーヘッドは 1 回あたりマイクロ秒単位で、出力内容は変えない。
- 別スレッドからの計測にも耐えるよう、集計はロックで守る。スレッドへはコンテキストを引き継いで使う。
"""

from __future__ import annotations

import contextvars
import functools
import logging
import threading
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, TypeVar

logger = logging.getLogger(__name__)

TIMING_LOG_FILE_NAME = "export_timing.log"
_SLOWEST_KEEP = 5

_collector: contextvars.ContextVar[Optional["_Collector"]] = contextvars.ContextVar("export_timing_collector", default=None)


class _Collector:
    def __init__(self) -> None:
        self.stages: Dict[str, Dict[str, Any]] = {}
        self.lock = threading.Lock()

    def add(self, name: str, detail: str, seconds: float) -> None:
        with self.lock:
            entry = self.stages.setdefault(name, {"count": 0, "seconds": 0.0, "slowest": []})
            entry["count"] += 1
            entry["seconds"] += seconds
            slowest: List[Dict[str, Any]] = entry["slowest"]
            slowest.append({"detail": detail, "seconds": seconds})
            slowest.sort(key=lambda item: item["seconds"], reverse=True)
            del slowest[_SLOWEST_KEEP:]


@contextmanager
def stage(name: str, detail: str = "") -> Iterator[None]:
    """1 段階の所要時間を計測する。計測スコープの外では何もしない。"""
    collector = _collector.get()
    if collector is None:
        yield
        return
    started = time.perf_counter()
    try:
        yield
    finally:
        collector.add(name, detail, time.perf_counter() - started)


@contextmanager
def timing_scope() -> Iterator[Dict[str, Any]]:
    """計測スコープ。ブロックを抜けたとき、戻した辞書に集計が入る。入れ子のときは外側へ集計する。"""
    result: Dict[str, Any] = {"total_seconds": 0.0, "stages": {}}
    if _collector.get() is not None:
        yield result
        return
    collector = _Collector()
    token = _collector.set(collector)
    started = time.perf_counter()
    try:
        yield result
    finally:
        result["total_seconds"] = time.perf_counter() - started
        result["stages"] = collector.stages
        _collector.reset(token)


def format_report(timings: Dict[str, Any], label: str = "") -> str:
    """集計を、合計時間の長い順に並べた人が読める表にする。"""
    lines = [f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {label} total={timings.get('total_seconds', 0.0):.2f}s"]
    stages: Dict[str, Dict[str, Any]] = timings.get("stages", {})
    for name, entry in sorted(stages.items(), key=lambda kv: kv[1]["seconds"], reverse=True):
        lines.append(f"  {name}: {entry['seconds']:.2f}s / {entry['count']}回")
        for item in entry.get("slowest", []):
            if item["detail"]:
                lines.append(f"      {item['seconds']:.2f}s  {item['detail']}")
    return "\n".join(lines)


def format_skipped_links(skipped: List[Dict[str, Any]]) -> str:
    """飛ばした項目を、理由・秒数・種類・対象・リンク元の 1 行ずつにする。"""
    lines = [f"  処理できなかったリンク: {len(skipped)} 件"]
    for item in skipped:
        source = f"  (リンク元: {item['source']})" if item.get("source") else ""
        detail = f"  {item['detail']}" if item.get("detail") else ""
        lines.append(f"      [{item['reason']}] {item.get('seconds', 0.0):.2f}s  {item['kind']}  {item['target']}{source}{detail}")
    return "\n".join(lines)


def get_timing_log_dir() -> Path:
    """レポートの書き出し先（データフォルダ）。"""
    from app.config import settings

    return Path(settings.data_dir)


_F = TypeVar("_F", bound=Callable[..., Any])


def timed_export(label: str) -> Callable[[_F], _F]:
    """書き出し関数（戻り値が (本体, stats)）の所要時間を計測して stats["timings"] へ入れるデコレーター。"""

    def decorator(func: _F) -> _F:
        @functools.wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            with timing_scope() as timings:
                result = func(*args, **kwargs)
            # スコープを抜けた後に集計が入る。入れ子で外側へ集計された場合は空のため何もしない
            if timings["stages"] or timings["total_seconds"]:
                _attach_and_report(result, timings, label)
            return result

        return wrapper  # type: ignore[return-value]

    return decorator


def _attach_and_report(result: Any, timings: Dict[str, Any], label: str) -> None:
    if isinstance(result, tuple) and result and isinstance(result[-1], dict):
        result[-1]["timings"] = timings
    report = format_report(timings, label)
    if isinstance(result, tuple) and result and isinstance(result[-1], dict) and result[-1].get("skipped_links"):
        report += "\n" + format_skipped_links(result[-1]["skipped_links"])
    logger.info("\n%s", report)
    try:
        log_path = get_timing_log_dir() / TIMING_LOG_FILE_NAME
        with log_path.open("a", encoding="utf-8") as fh:
            fh.write(report + "\n")
    except OSError:
        logger.debug("Failed to write the export timing report.", exc_info=True)
