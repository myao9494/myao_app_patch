"""自然言語の予定入力からOutlook予定に必要な情報を抽出する。"""
from __future__ import annotations

import calendar
import re
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

JST = ZoneInfo("Asia/Tokyo")
WEEKDAYS = {
    "月": 0,
    "火": 1,
    "水": 2,
    "木": 3,
    "金": 4,
    "土": 5,
    "日": 6,
}


# 全角の英数記号（！〜～の範囲）を半角へ
FULLWIDTH_TO_HALFWIDTH = str.maketrans({chr(0xFF01 + i): chr(0x21 + i) for i in range(94)})
# 時間範囲の区切りとして使われる各種ダッシュを半角ハイフンへ（長音符「ー」は件名の語を壊すので含めない）
DASH_TO_HYPHEN = str.maketrans(dict.fromkeys("－−–—―‐‑‒", "-"))

# 明示的な日付。例: 2026年5月28日(木) / 2026/5/28 / 2026.5.28 / 5-28木（年と曜日は省略可）
DATE_PATTERN = re.compile(
    r"(?:(20\d{2})\s*[年/\-.])?"  # 年（省略可）
    r"\s*(1[0-2]|0?[1-9])\s*[月/\-.]"  # 月
    r"\s*(3[01]|[12]\d|0?[1-9])\s*日?"  # 日
    r"\s*(?:[(（]?[月火水木金土日]曜?(?:日)?[)）]?)?"  # 日付直後の曜日（除去する）
)


@dataclass(frozen=True)
class TimeRange:
    """本文から抽出した時刻。時刻が無い（終日）場合は start_time が None。"""

    text: str
    start_time: time | None
    duration_minutes: int


@dataclass(frozen=True)
class ParsedEvent:
    start: datetime
    end: datetime
    subject: str
    location: str
    body: str
    all_day: bool
    duration_minutes: int
    normalized_text: str

    def to_dict(self) -> dict[str, object]:
        payload = asdict(self)
        payload["start"] = self.start.isoformat(timespec="minutes")
        payload["end"] = self.end.isoformat(timespec="minutes")
        return payload


def normalize_text(text: str) -> str:
    normalized = text.translate(FULLWIDTH_TO_HALFWIDTH)
    normalized = normalized.replace("　", " ")
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized.strip(" ,、。")


def parse_event_text(text: str, base_time: datetime | None = None) -> ParsedEvent:
    normalized = normalize_text(text)
    if not normalized:
        raise ValueError("予定内容を入力してください")

    base = base_time or datetime.now(JST)
    if base.tzinfo is None:
        base = base.replace(tzinfo=JST)

    date_value, without_date = extract_date(normalized, base)
    time_result = extract_time_range(without_date)
    subject_source = time_result.text.strip(" ,、。")
    subject, location = extract_subject_and_location(subject_source)

    if not subject:
        raise ValueError("予定名を読み取れませんでした")

    if time_result.start_time is None:
        start = datetime.combine(date_value, time.min, tzinfo=base.tzinfo)
        end = start + timedelta(days=1)
        all_day = True
    else:
        start = datetime.combine(date_value, time_result.start_time, tzinfo=base.tzinfo)
        end = start + timedelta(minutes=time_result.duration_minutes)
        all_day = False

    return ParsedEvent(
        start=start,
        end=end,
        subject=subject,
        location=location,
        body="",
        all_day=all_day,
        duration_minutes=max(1, int((end - start).total_seconds() // 60)),
        normalized_text=normalized,
    )


def extract_date(text: str, base: datetime) -> tuple[date, str]:
    # 件名に含まれる「今日」や補足用の日付より、先頭の明示的な日付を優先する。
    # 例: "2026年7月14日 15:00 今日から始めるxxx(7/17)"。
    match = DATE_PATTERN.search(text)
    if match:
        year = int(match.group(1) or base.year)
        month = int(match.group(2))
        day = int(match.group(3))
        try:
            value = date(year, month, day)
            if match.group(1) is None and value < base.date():
                value = date(year + 1, month, day)
        except ValueError:
            raise ValueError(f"日付が正しくありません: {month}月{day}日") from None
        return value, remove_span(text, match.span())

    patterns: list[tuple[str, Callable[[re.Match[str]], date]]] = [
        (r"明後日|あさって", lambda _m: base.date() + timedelta(days=2)),
        (r"明日|あした", lambda _m: base.date() + timedelta(days=1)),
        (r"今日|本日", lambda _m: base.date()),
        (r"(\d{1,3})日後", lambda m: base.date() + timedelta(days=int(m.group(1)))),
        (r"(\d{1,3})週間?後", lambda m: base.date() + timedelta(weeks=int(m.group(1)))),
    ]
    for pattern, resolver in patterns:
        match = re.search(pattern, text)
        if match:
            return resolver(match), remove_span(text, match.span())

    match = re.search(r"(再来週|来週|今週|次)?(?:の)?([月火水木金土日])曜(?:日)?", text)
    if match:
        value = resolve_weekday(base, match.group(2), match.group(1) or "")
        return value.date(), remove_span(text, match.span())

    match = re.search(r"月末", text)
    if match:
        last_day = calendar.monthrange(base.year, base.month)[1]
        return base.replace(day=last_day).date(), remove_span(text, match.span())

    return base.date(), text


def resolve_weekday(base: datetime, weekday_char: str, prefix: str) -> datetime:
    target_weekday = WEEKDAYS[weekday_char]
    start_of_week = base - timedelta(days=base.weekday())
    if prefix == "再来週":
        return start_of_week + timedelta(days=target_weekday, weeks=2)
    if prefix == "来週":
        return start_of_week + timedelta(days=target_weekday, weeks=1)
    if prefix in {"今週", "次"}:
        candidate = start_of_week + timedelta(days=target_weekday)
        if candidate.date() < base.date():
            return candidate + timedelta(weeks=1)
        return candidate

    days_ahead = (target_weekday - base.weekday()) % 7
    if days_ahead == 0:
        days_ahead = 7
    return base + timedelta(days=days_ahead)


def extract_time_range(text: str) -> TimeRange:
    working = text.replace("正午", "12:00")
    working = working.translate(DASH_TO_HYPHEN)
    working = re.sub(r"\s*:\s*", ":", working)
    working = re.sub(r"([0-2]?\d)\s*時半", r"\1:30", working)
    working = re.sub(r"([0-2]?\d)\s*時\s*([0-5]?\d)\s*分", r"\1:\2", working)
    working = re.sub(r"([0-2]?\d)\s*時(?!\d)", r"\1:00", working)

    time_sep = r"(?:\s*(?:から|より|to|[-－ー―—–−‐‑‒~～〜∼])\s*)"
    pattern = re.compile(
        r"(?<!\d)(?:(午前|午後|夕方|夜|昼)\s*)?([01]?\d|2[0-3])(?::([0-5]?\d))?"
        rf"(?:{time_sep}"
        r"(?:(午前|午後|夕方|夜|昼)\s*)?([01]?\d|2[0-3])(?::([0-5]?\d))?)?"
        r"(?!\d)",
        re.IGNORECASE,
    )
    match = next((candidate for candidate in pattern.finditer(working) if looks_like_time(candidate)), None)
    if not match:
        return TimeRange(text=text, start_time=None, duration_minutes=0)

    start_hour = adjust_hour(int(match.group(2)), match.group(1))
    start_minute = int(match.group(3) or 0)
    start_time = time(start_hour, start_minute)
    duration_minutes = 60

    if match.group(5):
        end_hour = adjust_hour(int(match.group(5)), match.group(4) or match.group(1))
        end_minute = int(match.group(6) or 0)
        # 日付は関係ない（日をまたぐかの判定だけ）ので、固定の日付で比較する
        reference_day = date(2000, 1, 1)
        start_dt = datetime.combine(reference_day, start_time)
        end_dt = datetime.combine(reference_day, time(end_hour, end_minute))
        if end_dt <= start_dt:
            end_dt += timedelta(days=1)
        duration_minutes = int((end_dt - start_dt).total_seconds() // 60)

    return TimeRange(text=remove_span(working, match.span()), start_time=start_time, duration_minutes=duration_minutes)


def looks_like_time(match: re.Match[str]) -> bool:
    return bool(match.group(1) or match.group(3) is not None or match.group(5))


def adjust_hour(hour: int, prefix: str | None) -> int:
    if prefix in {"午後", "夕方", "夜"} and hour < 12:
        return hour + 12
    return hour


def extract_subject_and_location(text: str) -> tuple[str, str]:
    cleaned = re.sub(r"^(から|に|は|の|が|を|へ)\s*", "", text).strip(" ,、。")
    location = ""
    location_match = re.search(r"(?:場所|会場|於|@)\s*[:：]?\s*([^,、。\s]+)", cleaned)
    if location_match:
        location = location_match.group(1).strip()
        cleaned = (cleaned[: location_match.start()] + cleaned[location_match.end() :]).strip(" ,、。")
    elif "出張" in cleaned:
        trip_match = re.match(r"(.+?)出張", cleaned)
        if trip_match:
            location = trip_match.group(1).strip(" ,、。")

    return cleaned, location


def remove_span(text: str, span: tuple[int, int]) -> str:
    return (text[: span[0]] + " " + text[span[1] :]).strip()
