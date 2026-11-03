"""
ファイルの時刻（Unix 時刻）の変換。

Windows の datetime.fromtimestamp と astimezone は、1970 年より前と 3000 年より後の時刻で OSError になる。
そうした日時のファイルは実在する（古いメディアからのコピーや壊れた時刻）ので、OS の時刻変換を使わずに計算する。
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_NAIVE_EPOCH = datetime(1970, 1, 1)


def utc_datetime(timestamp: float) -> datetime:
    """Unix 時刻を UTC の datetime にする。datetime で表せない時刻は 1970 年 1 月 1 日にする。"""
    try:
        return _EPOCH + timedelta(seconds=timestamp)
    except OverflowError:
        return _EPOCH


def local_midnight_timestamp(value: date) -> float:
    """ローカルタイムゾーンでのその日の 00:00:00 の Unix 時刻を返す。"""
    midnight = datetime.combine(value, time.min)
    try:
        return midnight.astimezone().timestamp()
    except (OSError, OverflowError, ValueError):
        # OS が扱えない範囲の日付は、現在の時差で計算する
        offset = datetime.now().astimezone().utcoffset() or timedelta()
        return (midnight - _NAIVE_EPOCH - offset).total_seconds()
