"""
書き出しの項目ごとの時間制限と、処理できなかったリンクの記録（app.vector.export_guard）のテスト。

仕様:
- スコープ内の `run_guarded` は、処理を別スレッドで動かし、制限時間を超えたら待たずに既定値を返して「時間切れ」と記録する。
- 処理が例外を出したら、既定値を返して「エラー」と記録する。
- スコープ外の `run_guarded` は、その場でそのまま実行する（時間制限も記録もしない。例外もそのまま出す）。
- `record_skip` は同じ項目（種類・対象・リンク元・理由）を 1 度だけ記録する。スコープ外では何もしない。
- スレッドへはコンテキストを引き継ぐ（段階別の計測などがスレッド内でも効く）。
"""

from __future__ import annotations

import contextvars
import threading
import time

import pytest

from app.vector.export_guard import (
    DEFAULT_ITEM_TIMEOUT_SECONDS,
    export_guard_scope,
    record_skip,
    run_guarded,
)


def test_default_timeout_is_ten_seconds() -> None:
    assert DEFAULT_ITEM_TIMEOUT_SECONDS == 10.0


def test_returns_value_when_finished_in_time() -> None:
    with export_guard_scope(1.0) as skipped:
        assert run_guarded(lambda: 42, kind="image", target="a.png") == 42
    assert skipped == []


def test_timeout_returns_default_without_waiting_and_records_skip() -> None:
    release = threading.Event()
    with export_guard_scope(0.1) as skipped:
        started = time.perf_counter()
        value = run_guarded(lambda: release.wait(5), kind="image", target="slow.png", source="note.md", default="fallback")
        elapsed = time.perf_counter() - started
    release.set()
    assert value == "fallback"
    assert elapsed < 2.0
    assert len(skipped) == 1
    item = skipped[0]
    assert (item["kind"], item["target"], item["source"], item["reason"]) == ("image", "slow.png", "note.md", "timeout")
    assert item["seconds"] >= 0.1


def test_exception_returns_default_and_records_error() -> None:
    def boom() -> None:
        raise ValueError("壊れた画像")

    with export_guard_scope(1.0) as skipped:
        assert run_guarded(boom, kind="image", target="bad.png", default=None) is None
    assert [(s["reason"], s["detail"]) for s in skipped] == [("error", "ValueError: 壊れた画像")]


def test_outside_scope_runs_inline_and_raises() -> None:
    assert run_guarded(lambda: threading.current_thread(), kind="image", target="a.png") is threading.current_thread()
    with pytest.raises(ValueError):
        run_guarded(lambda: (_ for _ in ()).throw(ValueError("x")), kind="image", target="a.png")


def test_record_skip_deduplicates_and_is_noop_outside_scope() -> None:
    record_skip("linked_note", "missing", "not_found", source="a.md")
    with export_guard_scope(1.0) as skipped:
        record_skip("linked_note", "missing", "not_found", source="a.md")
        record_skip("linked_note", "missing", "not_found", source="a.md")
        record_skip("linked_note", "missing", "not_found", source="b.md")
    assert [(s["target"], s["source"]) for s in skipped] == [("missing", "a.md"), ("missing", "b.md")]


def test_context_is_carried_into_worker_thread() -> None:
    marker: contextvars.ContextVar[str] = contextvars.ContextVar("marker", default="none")
    marker.set("outer")
    with export_guard_scope(1.0):
        assert run_guarded(marker.get, kind="image", target="a.png") == "outer"


def test_nested_scope_records_into_outer() -> None:
    with export_guard_scope(1.0) as outer:
        with export_guard_scope(1.0) as inner:
            record_skip("image", "x.png", "not_found")
        assert inner is outer
    assert len(outer) == 1
