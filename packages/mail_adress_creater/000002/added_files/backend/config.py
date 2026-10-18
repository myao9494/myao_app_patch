"""パス・既定設定・ログ設定など、バックエンド全体で共有する定義。"""
from __future__ import annotations

import logging
import logging.handlers
from datetime import datetime, UTC
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]


PUBLIC_CSV_PATH = BASE_DIR / "public" / "send_mail-ranking_tabulator.csv"


DIST_CSV_PATH = BASE_DIR / "dist" / "send_mail-ranking_tabulator.csv"


DB_PATH = BASE_DIR / "backend" / "data" / "app.sqlite3"


LOG_PATH = BASE_DIR / "backend" / "logs" / "app.log"


LOGGER = logging.getLogger("outlook_address_maker")
# ライブラリとして読み込まれた場合（テスト等）に、ハンドラ未設定の警告出力が標準エラーへ出ないようにする
LOGGER.addHandler(logging.NullHandler())
_logging_configured = False


DEFAULT_SETTINGS = {
    "keywords": ["棚卸", "棚おろし", "ユーザID"],
    "address_interval_minutes": 43200,
    "keyword_interval_minutes": 60,
    "my_email": "",
    "my_phone": "",
    "my_address": "",
    "my_dept": "",
    "my_home_email": "",
}


def setup_logging() -> None:
    global _logging_configured
    if _logging_configured:
        return
    _logging_configured = True

    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOGGER.setLevel(logging.INFO)
    formatter = logging.Formatter(
        "%(asctime)s %(levelname)s [%(threadName)s] %(message)s",
        "%Y-%m-%d %H:%M:%S",
    )
    file_handler = logging.handlers.RotatingFileHandler(
        LOG_PATH,
        maxBytes=1_000_000,
        backupCount=3,
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)
    LOGGER.addHandler(file_handler)

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)
    LOGGER.addHandler(console_handler)


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")
