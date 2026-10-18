"""APIから呼ばれるユースケース。DB・CSV・Outlookを組み合わせた処理を行う。"""
from __future__ import annotations

from collections import Counter
from datetime import datetime
from typing import Any

from backend import config, db, outlook
from backend.config import LOGGER
from backend.event_parser import JST, ParsedEvent, parse_event_text


def seed_dummy_data() -> dict[str, int]:
    """Outlookを使えない検証環境向けに、画面確認用のサンプルデータを保存する。"""
    db.ensure_db()
    recipients = [
        ("山田 太郎", 12),
        ("佐藤 一郎", 8),
        ("職アド 管理者", 5),
        ("テスト 利用者", 0),
    ]
    matches = [
        db.KeywordMatch(
            received_time="2026-05-14T09:30:00+09:00",
            subject="職アドからのお知らせ: 棚卸対応",
            line="棚卸の回答期限は本日17時です。",
            keyword="棚卸",
            is_new=False,
        ),
        db.KeywordMatch(
            received_time="2026-05-13T16:45:00+09:00",
            subject="職アドからのお知らせ: ユーザID確認",
            line="ユーザIDの申請内容を確認してください。",
            keyword="ユーザID",
            is_new=False,
        ),
        db.KeywordMatch(
            received_time="2026-05-12T11:15:00+09:00",
            subject="職アドからのお知らせ: 棚おろし準備",
            line="棚おろし前の事前チェックをお願いします。",
            keyword="棚おろし",
            is_new=False,
        ),
    ]
    db.save_recipients(recipients)
    persisted_matches = db.persist_keyword_matches(matches)
    db.record_job_run("refresh_addresses", "success", "ダミーデータを保存しました")
    db.record_job_run("check_keywords", "success", f"ダミーデータ {len(matches)}件を保存しました")
    db.write_recipients_csv(recipients)
    return {
        "recipients": len(recipients),
        "keyword_matches": sum(1 for match in persisted_matches if match.is_new),
        "job_runs": 2,
    }


def count_and_sort_recipients(recipients: list[str]) -> list[tuple[str, int]]:
    return sorted(Counter(recipients).items(), key=lambda item: (-item[1], item[0]))


def refresh_addresses(limit: int = 150) -> dict[str, Any]:
    db.ensure_db()
    LOGGER.info("Refreshing addresses from sent items: limit=%s", limit)
    recipients = outlook.get_sent_item_recipients(limit)
    if not recipients:
        LOGGER.warning("No sent item recipients were found")
        raise RuntimeError("送信済みアイテムフォルダにメールがありません")

    # CSVとDBのどちらか一方にしか無い既存アドレスも、0回で残す
    old_names = set(db.read_recipients_csv(config.PUBLIC_CSV_PATH)) | db.list_recipient_names()
    new_counts = dict(count_and_sort_recipients(recipients))
    all_names = old_names | set(new_counts)
    merged_rows = sorted(
        ((name, int(new_counts.get(name, 0))) for name in all_names),
        key=lambda item: (-item[1], item[0]),
    )
    db.save_recipients(merged_rows)
    db.write_recipients_csv(merged_rows)
    db.record_job_run("refresh_addresses", "success", f"{len(merged_rows)}件を保存しました")
    LOGGER.info(
        "Refreshed addresses: saved_count=%s zero_count=%s csv_path=%s",
        len(merged_rows),
        sum(1 for _, count in merged_rows if count == 0),
        config.PUBLIC_CSV_PATH,
    )
    return {
        "saved_count": len(merged_rows),
        "zero_count": sum(1 for _, count in merged_rows if count == 0),
        "csv_path": str(config.PUBLIC_CSV_PATH),
    }


def parse_schedule(payload: dict[str, Any]) -> dict[str, Any]:
    text = str(payload.get("text") or "")
    parsed = parse_event_text(text)
    return {"event": parsed.to_dict()}


def add_schedule(payload: dict[str, Any]) -> dict[str, Any]:
    parsed = schedule_event_from_payload(payload)
    outlook.save_outlook_event(parsed)
    db.record_job_run("add_schedule", "success", f"{parsed.subject} を追加しました")
    return {"event": parsed.to_dict(), "saved": True}


def schedule_event_from_payload(payload: dict[str, Any]) -> ParsedEvent:
    event_payload = payload.get("event")
    if event_payload is None:
        return parse_event_text(str(payload.get("text") or ""))
    if not isinstance(event_payload, dict):
        raise ValueError("event must be an object")

    subject = str(event_payload.get("subject") or "").strip()
    if not subject:
        raise ValueError("件名を入力してください")

    start = parse_schedule_datetime(event_payload.get("start"))
    end = parse_schedule_datetime(event_payload.get("end"))
    all_day = bool(event_payload.get("all_day", False))
    if end <= start:
        raise ValueError("終了日時は開始日時より後にしてください")

    return ParsedEvent(
        start=start,
        end=end,
        subject=subject,
        location=str(event_payload.get("location") or "").strip(),
        body=str(event_payload.get("body") or "").strip(),
        all_day=all_day,
        duration_minutes=max(1, int((end - start).total_seconds() // 60)),
        normalized_text=str(event_payload.get("normalized_text") or payload.get("text") or ""),
    )


def parse_schedule_datetime(value: Any) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("日時を入力してください")
    text = value.strip()
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ValueError("日時の形式が正しくありません") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=JST)
    return parsed.astimezone(JST)


def check_keywords(limit: int = 500) -> dict[str, Any]:
    db.ensure_db()
    keywords = db.get_settings()["keywords"]
    LOGGER.info("Checking keyword matches: limit=%s keywords=%s", limit, keywords)
    matches = db.persist_keyword_matches(outlook.find_keyword_matches(keywords, limit))
    new_matches = [match for match in matches if match.is_new]
    db.record_job_run("check_keywords", "success", f"新規{len(new_matches)}件 / 合計{len(matches)}件")
    LOGGER.info("Checked keyword matches: total=%s new=%s", len(matches), len(new_matches))
    return {
        "matches": [match.__dict__ for match in matches],
        "new_matches": [match.__dict__ for match in new_matches],
        "keywords": keywords,
    }
