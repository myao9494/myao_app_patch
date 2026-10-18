"""バックエンドのテストで共有するヘルパー（テストケース基底クラスとOutlook COMの偽物）。"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend import config


class TempEnvironmentTestCase(unittest.TestCase):
    """DBと送信履歴CSVのパスを一時領域へ差し替え、実データに触れないようにする。"""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.db_path = self.root / "backend" / "data" / "app.sqlite3"
        self.public_csv = self.root / "public" / "recipients.csv"
        self.dist_csv = self.root / "dist" / "recipients.csv"
        self.public_csv.parent.mkdir()
        self.dist_csv.parent.mkdir()
        for target, value in (
            ("DB_PATH", self.db_path),
            ("PUBLIC_CSV_PATH", self.public_csv),
            ("DIST_CSV_PATH", self.dist_csv),
        ):
            patcher = patch.object(config, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)


class FakeRange:
    def __init__(self) -> None:
        self.inserted_content: str | None = None

    def InsertFile(self, filepath: str) -> None:
        self.inserted_content = Path(filepath).read_text(encoding="utf-8")


class FakeWordEditor:
    def __init__(self) -> None:
        self._range = FakeRange()

    def Range(self) -> FakeRange:
        return self._range


class FakeInspector:
    def __init__(self) -> None:
        self.WordEditor = FakeWordEditor()


class FakeAppointment:
    """Outlookの予定アイテムの偽物。設定された属性はそのまま読み取れる。"""

    Subject: str
    Start: str
    Duration: int
    Location: str
    ReminderSet: bool
    ReminderMinutesBeforeStart: int
    AllDayEvent: bool
    BusyStatus: int

    def __init__(self) -> None:
        self.Body = ""
        self.GetInspector = FakeInspector()
        self.saved = False

    def Save(self) -> None:
        self.saved = True


class FakeOutlook:
    def __init__(self, appointment: FakeAppointment) -> None:
        self.appointment = appointment
        self.item_type: int | None = None

    def CreateItem(self, item_type: int) -> FakeAppointment:
        self.item_type = item_type
        return self.appointment
