"""
休日・出張日のテキストファイル（backend/data/*.txt）の読み書き。

- holidays.txt: 1行1日付（YYYY-MM-DD）
- business_trips.txt: 1行 "YYYY-MM-DD,type"（type は normal_trip / day_trip）
読み込み時に重複排除・日付順ソートで正規化し、内容が変わる場合はファイルも書き戻す。
"""
import re
from datetime import datetime
from pathlib import Path

from config import DATA_DIR

HOLIDAYS_FILE_PATH = DATA_DIR / "holidays.txt"
BUSINESS_TRIPS_FILE_PATH = DATA_DIR / "business_trips.txt"

DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
BUSINESS_TRIP_TYPES = {"normal_trip", "day_trip"}
# 旧名称で保存されたデータの読み替え
BUSINESS_TRIP_TYPE_ALIASES = {"previous_day": "day_trip"}


class CalendarValidationError(ValueError):
    """日付や出張種別の形式が不正。メッセージはそのままAPIのエラー詳細になる。"""


def validate_date(date_str: str) -> str:
    normalized = (date_str or "").strip()
    if not DATE_PATTERN.fullmatch(normalized):
        raise CalendarValidationError("date must be in YYYY-MM-DD format")

    try:
        datetime.strptime(normalized, "%Y-%m-%d")
    except ValueError as exc:
        raise CalendarValidationError("date is invalid") from exc
    return normalized


def validate_business_trip_type(trip_type: str) -> str:
    normalized = (trip_type or "").strip()
    normalized = BUSINESS_TRIP_TYPE_ALIASES.get(normalized, normalized)
    if normalized not in BUSINESS_TRIP_TYPES:
        raise CalendarValidationError("type must be normal_trip or day_trip")
    return normalized


def _read_text(path: Path) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text("", encoding="utf-8")
    return path.read_text(encoding="utf-8")


def _write_text(path: Path, normalized_text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(normalized_text + ("\n" if normalized_text else ""), encoding="utf-8")


def _rewrite_if_not_normalized(path: Path, raw_text: str, normalized_text: str) -> None:
    if raw_text != normalized_text and raw_text != normalized_text + "\n":
        _write_text(path, normalized_text)


# --- 休日 ---

def parse_holiday_lines(raw_text: str) -> list[str]:
    """空行を無視し、重複を除いて日付順に並べた休日リストを返す。"""
    holidays = {validate_date(line) for line in raw_text.splitlines() if line.strip()}
    return sorted(holidays)


def load_holidays() -> tuple[list[str], str]:
    """(休日リスト, 正規化済みテキスト) を返す。"""
    raw_text = _read_text(HOLIDAYS_FILE_PATH)
    holidays = parse_holiday_lines(raw_text)
    normalized_text = "\n".join(holidays)
    _rewrite_if_not_normalized(HOLIDAYS_FILE_PATH, raw_text, normalized_text)
    return holidays, normalized_text


def save_holidays(holidays: list[str]) -> tuple[list[str], str]:
    """休日リストを正規化して保存し、(保存した休日リスト, テキスト) を返す。"""
    normalized = sorted(set(holidays))
    normalized_text = "\n".join(normalized)
    _write_text(HOLIDAYS_FILE_PATH, normalized_text)
    return normalized, normalized_text


# --- 出張 ---

def parse_business_trip_lines(raw_text: str) -> list[dict[str, str]]:
    """同じ日付は後勝ちでまとめ、日付順に並べた出張エントリを返す。"""
    entries_by_date: dict[str, str] = {}
    for line in raw_text.splitlines():
        normalized = line.strip()
        if not normalized:
            continue
        if "," not in normalized:
            raise CalendarValidationError("business trip line must be YYYY-MM-DD,type")
        date_part, type_part = normalized.split(",", 1)
        entries_by_date[validate_date(date_part)] = validate_business_trip_type(type_part)

    return [
        {"date": date_str, "type": trip_type}
        for date_str, trip_type in sorted(entries_by_date.items())
    ]


def format_business_trip_entries(entries: list[dict[str, str]]) -> str:
    return "\n".join(f"{entry['date']},{entry['type']}" for entry in entries)


def load_business_trips() -> tuple[list[dict[str, str]], str]:
    """(出張エントリ, 正規化済みテキスト) を返す。"""
    raw_text = _read_text(BUSINESS_TRIPS_FILE_PATH)
    entries = parse_business_trip_lines(raw_text)
    normalized_text = format_business_trip_entries(entries)
    _rewrite_if_not_normalized(BUSINESS_TRIPS_FILE_PATH, raw_text, normalized_text)
    return entries, normalized_text


def save_business_trips(entries: list[dict[str, str]]) -> tuple[list[dict[str, str]], str]:
    """出張エントリを正規化して保存し、(保存したエントリ, テキスト) を返す。"""
    normalized_entries = parse_business_trip_lines(format_business_trip_entries(entries))
    normalized_text = format_business_trip_entries(normalized_entries)
    _write_text(BUSINESS_TRIPS_FILE_PATH, normalized_text)
    return normalized_entries, normalized_text
