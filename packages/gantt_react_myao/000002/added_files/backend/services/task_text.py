"""
タスク名（text）と日付まわりの共通ロジック。

Gantt/Grid のUIからコピーされたタスク名には、先頭にインデント用の空白やアイコン絵文字が
混入することがあるため、DBに保存する前に必ずここで除去する。
"""
import re
from datetime import datetime

# 先頭の空白類（全角スペース含む）と、UIがタスク名の前に付けるアイコン絵文字
LEADING_NOISE_RE = re.compile(r'^[\s\u3000📁📄📅🔍📝📌]+')
DEFAULT_TASK_TEXT = "新規タスク"
DATETIME_FORMAT = "%Y-%m-%d %H:%M:%S"


def strip_leading_noise(text: str | None) -> str:
    """先頭のインデント・アイコンだけを取り除く（空になってもそのまま返す）。"""
    return LEADING_NOISE_RE.sub('', text or '')


def sanitize_task_text(text: str | None) -> str:
    """保存用のタスク名に整形する。空になった場合は既定名を返す。"""
    return strip_leading_noise(text).strip() or DEFAULT_TASK_TEXT


def now_string() -> str:
    """created_at / updated_at 用の現在時刻文字列。"""
    return datetime.now().strftime(DATETIME_FORMAT)


def calculate_duration(start_date: str, end_date: str) -> int:
    """開始日と終了日の日数差（最低1日）。パースできない場合は1を返す。"""
    try:
        start = datetime.strptime(start_date.split(" ")[0], "%Y-%m-%d")
        end = datetime.strptime(end_date.split(" ")[0], "%Y-%m-%d")
        return max(1, (end - start).days)
    except (ValueError, AttributeError, IndexError):
        return 1
