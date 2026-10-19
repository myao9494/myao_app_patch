"""
書き出しの段階別所要時間（app.vector.export_timing）のテスト。

仕様:
- スコープ内の `stage(名前, 詳細)` で、段階ごとの合計秒・回数・遅い上位の詳細を集計する。
- スコープ外の `stage` は何もしない（例外も出さない）。
- スコープ終了時に集計を返し、`format_report` で人が読める表にできる。
- `timed_export` で包んだ関数は、戻り値の stats に `timings` を足し、データフォルダへレポートを追記する。
"""

from __future__ import annotations

from pathlib import Path

from app.vector.export_timing import (
    TIMING_LOG_FILE_NAME,
    format_report,
    stage,
    timed_export,
    timing_scope,
)


def test_stage_outside_scope_is_noop() -> None:
    with stage("画像解決", "a.png"):
        pass


def test_scope_aggregates_count_total_and_slowest(monkeypatch) -> None:
    clock = iter([0.0, 0.0, 1.0, 1.0, 4.0, 4.0, 4.5, 4.5])
    monkeypatch.setattr("app.vector.export_timing.time.perf_counter", lambda: next(clock))
    with timing_scope() as result:
        with stage("画像解決", "a.png"):
            pass
        with stage("画像解決", "b.png"):
            pass
        with stage("メール解析", "m.msg"):
            pass
    images = result["stages"]["画像解決"]
    assert images["count"] == 2
    assert images["seconds"] == 4.0
    assert images["slowest"][0] == {"detail": "b.png", "seconds": 3.0}
    assert result["stages"]["メール解析"]["count"] == 1


def test_nested_stage_is_recorded_independently(monkeypatch) -> None:
    with timing_scope() as result:
        with stage("外側"):
            with stage("内側"):
                pass
    assert set(result["stages"]) == {"外側", "内側"}


def test_format_report_lists_stages_sorted_by_time() -> None:
    report = format_report(
        {
            "total_seconds": 10.0,
            "stages": {
                "速い": {"count": 1, "seconds": 1.0, "slowest": []},
                "遅い": {"count": 3, "seconds": 8.0, "slowest": [{"detail": "x.png", "seconds": 5.0}]},
            },
        },
        label="export",
    )
    assert report.index("遅い") < report.index("速い")
    assert "x.png" in report


def test_timed_export_adds_timings_and_writes_report(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("app.vector.export_timing.get_timing_log_dir", lambda: tmp_path)

    @timed_export("テスト書き出し")
    def run():
        with stage("画像解決", "a.png"):
            pass
        return "body", {"total_documents": 1}

    body, stats = run()
    assert body == "body"
    assert "画像解決" in stats["timings"]["stages"]
    log_text = (tmp_path / TIMING_LOG_FILE_NAME).read_text(encoding="utf-8")
    assert "テスト書き出し" in log_text and "画像解決" in log_text


def test_timed_export_survives_log_write_failure(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("app.vector.export_timing.get_timing_log_dir", lambda: tmp_path / "missing" / "dir")

    @timed_export("x")
    def run():
        return "b", {}

    assert run()[0] == "b"


def test_html_export_stats_include_stage_timings(tmp_path: Path) -> None:
    from app.vector.html_exporter import export_documents_to_html

    note = tmp_path / "note.md"
    note.write_text("# t\n![[missing.png]]\n", encoding="utf-8")
    _, stats = export_documents_to_html(file_paths=[str(note)], include_images=True)

    stages = stats["timings"]["stages"]
    assert "画像・図面の埋め込み" in stages
    assert "Markdown→HTML変換" in stages
    assert stats["timings"]["total_seconds"] >= 0


def test_timed_export_report_lists_skipped_links(tmp_path: Path, monkeypatch) -> None:
    """stats に skipped_links があれば、処理できなかったリンクをレポートへ並べる。"""
    monkeypatch.setattr("app.vector.export_timing.get_timing_log_dir", lambda: tmp_path)

    @timed_export("テスト書き出し")
    def run():
        skipped = [{"kind": "image", "target": "slow.png", "source": "note.md", "reason": "timeout", "detail": "10 秒で打ち切り", "seconds": 10.0}]
        return "body", {"skipped_links": skipped}

    run()
    log_text = (tmp_path / TIMING_LOG_FILE_NAME).read_text(encoding="utf-8")
    assert "処理できなかったリンク: 1 件" in log_text
    assert "timeout" in log_text and "slow.png" in log_text and "note.md" in log_text
