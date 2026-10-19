"""
AI用HTMLの書き出しで、処理できなかったリンクを飛ばして出力を優先する挙動のテスト。

仕様:
- 選んだノート・リンク先ノート・埋め込み画像・メールのうち、見つからないものは飛ばし、「見つからない」と記録する。
- 1 項目の処理が制限時間（既定 10 秒、`item_timeout_seconds` で変更可）を超えたら、待たずに飛ばして「時間切れ」と記録する。
  ほかの項目はそのまま出力する。画像が時間切れのときは、ノート本文は出し、画像の記法をそのまま残す。
- 記録は stats["skipped_links"] と API 応答の `skipped_links` に入る（種類・対象・リンク元・理由・詳細・秒数）。
- 通常の（埋め込みでない）ノートへのリンクは、画像として見つからなくても記録しない。
"""

from __future__ import annotations

import threading
from email.message import EmailMessage
from pathlib import Path
from typing import Any, Dict, List

import pytest
from fastapi.testclient import TestClient

from app.vector.html_exporter import export_documents_to_html

FAST_TIMEOUT = 0.2


@pytest.fixture
def release_slow_workers():
    """時間切れにしたスレッドを、テストの終わりに解放する。"""
    event = threading.Event()
    yield event
    event.set()


def _skips(stats: Dict[str, Any]) -> List[tuple]:
    return [(s["kind"], s["target"], s["source"], s["reason"]) for s in stats["skipped_links"]]


def test_missing_selected_note_is_skipped_and_reported(tmp_path: Path) -> None:
    ok = tmp_path / "ok.md"
    ok.write_text("# 生きているノート\n本文", encoding="utf-8")
    missing = tmp_path / "gone.md"

    html, stats = export_documents_to_html(file_paths=[str(missing), str(ok)], file_depths={})

    assert "生きているノート" in html
    assert stats["total_documents"] == 1
    assert ("note", str(missing), "", "not_found") in _skips(stats)


def test_missing_linked_note_and_image_are_reported(tmp_path: Path) -> None:
    (tmp_path / "exists.md").write_text("# あるノート", encoding="utf-8")
    root = tmp_path / "root.md"
    root.write_text("# 親\n[[exists]] と [[ないノート]]\n![[ない画像.png]]\n", encoding="utf-8")

    html, stats = export_documents_to_html(file_paths=[str(root)], file_depths={str(root): 1})

    skips = _skips(stats)
    assert ("linked_note", "ないノート", "root.md", "not_found") in skips
    assert ("image", "ない画像.png", "root.md", "not_found") in skips
    assert not any(target == "exists" for _, target, _, _ in skips), "見つかったリンクは記録しない"
    assert "あるノート" in html


def test_slow_note_read_times_out_and_other_notes_are_output(tmp_path: Path, monkeypatch, release_slow_workers) -> None:
    slow = tmp_path / "slow.md"
    slow.write_text("# 遅いノート", encoding="utf-8")
    fast = tmp_path / "fast.md"
    fast.write_text("# 速いノート", encoding="utf-8")

    from app.vector import html_exporter

    original = html_exporter.read_export_document_text

    def read(path: Path):
        if path.name == "slow.md":
            release_slow_workers.wait(5)
        return original(path)

    monkeypatch.setattr(html_exporter, "read_export_document_text", read)

    html, stats = export_documents_to_html(
        file_paths=[str(slow), str(fast)],
        item_timeout_seconds=FAST_TIMEOUT,
    )

    assert "速いノート" in html
    assert "遅いノート" not in html
    assert stats["total_documents"] == 1
    timeouts = [s for s in stats["skipped_links"] if s["reason"] == "timeout"]
    assert [(s["kind"], Path(s["target"]).name) for s in timeouts] == [("note", "slow.md")]


def test_slow_image_times_out_but_note_body_is_output(tmp_path: Path, monkeypatch, release_slow_workers) -> None:
    note = tmp_path / "note.md"
    note.write_text("# 画像つきノート\n![[slow.png]]\n", encoding="utf-8")

    from app.vector import figure_assets

    def slow_resolve(*_args, **_kwargs):
        release_slow_workers.wait(5)
        return None, False

    monkeypatch.setattr(figure_assets, "resolve_image_or_figure_data_url", slow_resolve)

    html, stats = export_documents_to_html(file_paths=[str(note)], item_timeout_seconds=FAST_TIMEOUT)

    assert "画像つきノート" in html
    assert stats["total_documents"] == 1
    assert ("image", "slow.png", "note.md", "timeout") in _skips(stats)


def test_slow_email_times_out_and_is_reported(tmp_path: Path, monkeypatch, release_slow_workers) -> None:
    msg = EmailMessage()
    msg["Subject"] = "遅いメール"
    msg["From"] = "a@example.com"
    msg["To"] = "b@example.com"
    msg.set_content("本文")
    (tmp_path / "mail.eml").write_bytes(bytes(msg))
    note = tmp_path / "note.md"
    note.write_text("# メールつきノート\n[[mail.eml]]\n", encoding="utf-8")

    from app.vector import html_exporter

    def slow_parse(_path):
        release_slow_workers.wait(5)
        return None

    monkeypatch.setattr(html_exporter, "parse_email_file", slow_parse)

    html, stats = export_documents_to_html(file_paths=[str(note)], item_timeout_seconds=FAST_TIMEOUT)

    assert "メールつきノート" in html
    assert stats["total_linked_emails"] == 0
    assert ("email", "mail.eml", "note.md", "timeout") in [
        (k, Path(t).name, s, r) for k, t, s, r in _skips(stats)
    ]


def test_missing_linked_email_is_reported(tmp_path: Path) -> None:
    note = tmp_path / "note.md"
    note.write_text("# ノート\n[[ないメール.msg]]\n", encoding="utf-8")

    _, stats = export_documents_to_html(file_paths=[str(note)])

    assert ("email", "ないメール.msg", "note.md", "not_found") in _skips(stats)


def test_api_returns_skipped_links(tmp_path: Path) -> None:
    from app.main import app

    note = tmp_path / "note.md"
    note.write_text("# ノート\n![[ない画像.png]]\n", encoding="utf-8")

    resp = TestClient(app).post("/api/export/ai-html", json={"file_paths": [str(note)], "file_depths": {str(note): 1}})

    assert resp.status_code == 200
    skipped = resp.json()["skipped_links"]
    assert [(s["kind"], s["target"], s["reason"]) for s in skipped] == [("image", "ない画像.png", "not_found")]


def test_link_to_existing_folder_is_not_reported(tmp_path: Path) -> None:
    """フォルダへのリンクはノートへのリンクではないため、見つからないとして記録しない。"""
    folder = tmp_path / "project_dir"
    folder.mkdir()
    root = tmp_path / "root.md"
    root.write_text(f"# 親\n[フォルダ]({folder})\n", encoding="utf-8")

    _, stats = export_documents_to_html(file_paths=[str(root)], file_depths={str(root): 1})

    assert stats["skipped_links"] == []
