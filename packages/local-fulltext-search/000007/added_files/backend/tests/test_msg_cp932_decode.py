"""
Outlook MSGファイルのCP932ベストエフォートデコード単体テスト
仕様:
- プロパティコードページがcp1252と指定されているか未指定のMSGファイルにおいて、
  件名・差出人・本文・HTML本文等に含まれる日本語文字列（CP932/Shift_JIS）が
  UnicodeDecodeErrorを起こさず、正常にCP932で復旧・デコードされることを検証する。
- openMsgのオープン時にUnicodeDecodeErrorが発生した場合、overrideEncoding='cp932'で自動再試行されることを検証する。
- HTMLエクスポート処理（export_documents_to_html）がMSGの文字コード例外で中断せず、自己完結型HTMLを生成できることを検証する。
- 検索テキスト抽出（extract_text）においてもCP932フォールバックによりインデックス用テキストが正しく抽出されることを検証する。
"""

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.vector.html_exporter import (
    decode_best_effort_text,
    mojibake_score,
    parse_msg_file,
    export_documents_to_html,
)
from app.extractors.text_extractor import extract_text


def test_mojibake_score_prefers_clean_japanese_over_garbled() -> None:
    """文字化けスコアが自然な日本語文字列に対して低く（良質と判定）なること"""
    clean_ja = "【重要】来週の打ち合わせ（連絡）について"
    # cp932のバイト列をcp1252/latin1等で誤ってデコードした典型的な文字化け
    garbled = clean_ja.encode("cp932").decode("latin1", errors="replace")

    assert mojibake_score(clean_ja) < mojibake_score(garbled)


def test_decode_best_effort_text_decodes_cp932_correctly() -> None:
    """CP932バイト列がdecode_best_effort_textによって正しくデコードされること"""
    expected = "打ち合わせ（連絡）の件"
    cp932_bytes = expected.encode("cp932")

    decoded = decode_best_effort_text(cp932_bytes)
    assert decoded == expected


def test_parse_msg_file_recovers_from_property_cp1252_decode_error(tmp_path: Path) -> None:
    """
    属性アクセス時にcp1252のUnicodeDecodeErrorが発生しても、
    生ストリームからCP932で復旧して正常にメタデータと本文が取得できること
    """
    msg_path = tmp_path / "meeting.msg"
    msg_path.write_bytes(b"dummy msg binary")

    expected_subject = "【重要】打ち合わせ日程"
    expected_body = "来週の打ち合わせ（連絡）について相談させてください。"
    expected_sender = "山田 太郎"
    expected_to = "佐藤 次郎"

    class FakeBrokenMsg:
        @property
        def subject(self) -> str:
            # 0x8d は cp1252 で未定義のため例外が発生
            raise UnicodeDecodeError("charmap", b"\x8d", 0, 1, "character maps to <undefined>")

        @property
        def sender(self) -> str:
            raise UnicodeDecodeError("charmap", b"\x81", 0, 1, "character maps to <undefined>")

        @property
        def to(self) -> str:
            raise UnicodeDecodeError("charmap", b"\x81", 0, 1, "character maps to <undefined>")

        @property
        def body(self) -> str:
            raise UnicodeDecodeError("charmap", b"\x8d", 0, 1, "character maps to <undefined>")

        @property
        def htmlBody(self) -> None:
            return None

        date = "2026-09-15 10:00:00"
        attachments = []

        def getStream(self, name: str, prefix: bool = True) -> bytes | None:
            # ANSIストリーム (001E) としてCP932バイト列を返す
            if name.endswith("0037001E"):  # subject
                return expected_subject.encode("cp932")
            elif name.endswith("0C1A001E"):  # sender
                return expected_sender.encode("cp932")
            elif name.endswith("0E04001E"):  # display to
                return expected_to.encode("cp932")
            elif name.endswith("1000001E"):  # body
                return expected_body.encode("cp932")
            return None

        def close(self) -> None:
            pass

    def fake_open_msg(path: str, **kwargs):
        return FakeBrokenMsg()

    with patch.dict("sys.modules", {"extract_msg": SimpleNamespace(openMsg=fake_open_msg, Message=fake_open_msg)}):
        result = parse_msg_file(msg_path)

    assert result is not None
    assert result["subject"] == expected_subject
    assert result["sender"] == expected_sender
    assert result["to"] == expected_to
    assert result["body_plain"] == expected_body


def test_open_msg_unicode_decode_error_retries_with_override_encoding(tmp_path: Path) -> None:
    """
    openMsg(path) の初期オープンでUnicodeDecodeErrorが発生した場合、
    overrideEncoding='cp932'で自動再試行されること
    """
    msg_path = tmp_path / "ansi_sjis.msg"
    msg_path.write_bytes(b"dummy")

    call_history = []

    class FakeWorkingMsg:
        subject = "議事録送付"
        sender = "tanaka@example.com"
        to = "all@example.com"
        date = "2026-09-16 15:00:00"
        body = "本日の打ち合わせ内容です。"
        htmlBody = None
        attachments = []

        def close(self) -> None:
            pass

    def fake_open_msg(path: str, **kwargs):
        call_history.append(kwargs)
        if "overrideEncoding" not in kwargs:
            # 初回はcp1252エラーを模倣
            raise UnicodeDecodeError("charmap", b"\x8d\x87", 0, 1, "character maps to <undefined>")
        return FakeWorkingMsg()

    with patch.dict("sys.modules", {"extract_msg": SimpleNamespace(openMsg=fake_open_msg, Message=fake_open_msg)}):
        result = parse_msg_file(msg_path)

    assert result is not None
    assert result["subject"] == "議事録送付"
    assert result["body_plain"] == "本日の打ち合わせ内容です。"
    # 2回呼ばれ、2回目でoverrideEncoding='cp932'が渡されたこと
    assert len(call_history) >= 2
    assert call_history[1].get("overrideEncoding") == "cp932"


def test_export_documents_to_html_succeeds_even_when_msg_has_cp1252_error(tmp_path: Path) -> None:
    """
    Markdown内でリンクされたMSGファイルがcp1252例外を起こす場合でも、
    HTMLエクスポート全体が中断せず、APPENDIXにメールが展開されること
    """
    msg_file = tmp_path / "report.msg"
    msg_file.write_bytes(b"dummy")

    doc = tmp_path / "summary.md"
    doc.write_text("# 業務報告\n\n詳細は [[report.msg]] を確認してください。", encoding="utf-8")

    class FakeBrokenMsg:
        @property
        def subject(self) -> str:
            raise UnicodeDecodeError("charmap", b"\x81", 0, 1, "character maps to <undefined>")

        @property
        def sender(self) -> str:
            raise UnicodeDecodeError("charmap", b"\x81", 0, 1, "character maps to <undefined>")

        to = "boss@example.com"
        date = "2026-09-16 18:00:00"

        @property
        def body(self) -> str:
            raise UnicodeDecodeError("charmap", b"\x8d", 0, 1, "character maps to <undefined>")

        @property
        def htmlBody(self) -> None:
            return None

        attachments = []

        def getStream(self, name: str, prefix: bool = True) -> bytes | None:
            if name.endswith("0037001E"):
                return "週次進捗報告（完了）".encode("cp932")
            elif name.endswith("0C1A001E"):
                return "鈴木 開発担当".encode("cp932")
            elif name.endswith("1000001E"):
                return "今週の進捗はオンスケジュールです。".encode("cp932")
            return None

        def close(self) -> None:
            pass

    def fake_open_msg(path: str, **kwargs):
        return FakeBrokenMsg()

    with patch.dict("sys.modules", {"extract_msg": SimpleNamespace(openMsg=fake_open_msg, Message=fake_open_msg)}):
        html_content, stats = export_documents_to_html(
            file_paths=[str(doc)],
            title="プロジェクトサマリー",
            include_images=True,
            include_linked_emails=True,
        )

    assert "週次進捗報告（完了）" in html_content
    assert "鈴木 開発担当" in html_content
    assert "今週の進捗はオンスケジュールです。" in html_content
    assert stats.get("total_linked_emails") == 1


def test_text_extractor_recovers_from_msg_cp1252_decode_error(tmp_path: Path) -> None:
    """
    検索テキスト抽出（extract_text）において、MSGファイルがcp1252例外を起こしても
    CP932フォールバックによりインデックス用テキストを抽出できること
    """
    msg_path = tmp_path / "index_target.msg"
    msg_path.write_bytes(b"dummy")

    class FakeWorkingMsg:
        subject = "顧客仕様変更のご連絡"
        sender = "client@example.jp"
        to = "dev@example.jp"
        cc = None
        date = "2026-09-16 11:00:00"
        body = "仕様変更に関する補足事項です。"

        def close(self) -> None:
            pass

    def fake_open_msg(path: str, **kwargs):
        if "overrideEncoding" not in kwargs:
            raise UnicodeDecodeError("charmap", b"\x8d", 0, 1, "character maps to <undefined>")
        return FakeWorkingMsg()

    with patch.dict("sys.modules", {"extract_msg": SimpleNamespace(openMsg=fake_open_msg)}):
        extracted = extract_text(msg_path)

    assert "Subject: 顧客仕様変更のご連絡" in extracted
    assert "仕様変更に関する補足事項です。" in extracted
