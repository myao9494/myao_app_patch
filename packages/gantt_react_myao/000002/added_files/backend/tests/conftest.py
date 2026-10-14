"""
テスト共通設定。

【重要】本番DB（backend/gantt.db）を絶対に触らないための隔離をここで行う。
アプリのモジュールを import する「前」に GANTT_DATABASE_URL を一時ディレクトリのDBへ向けるので、
テストから使われる engine / SessionLocal / get_db はすべて一時DBを指す。
各テストの前にテーブルを作り直し、インメモリ状態・データファイル・ブラウザ操作も差し替える。
"""
import os
import shutil
import tempfile
from pathlib import Path
from types import SimpleNamespace

_TEST_DB_DIR = Path(tempfile.mkdtemp(prefix="gantt_test_db_"))
os.environ["GANTT_DATABASE_URL"] = f"sqlite:///{(_TEST_DB_DIR / 'test.db').as_posix()}"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402,F401  (テーブル定義を Base に登録する)
from main import app  # noqa: E402
from routers import open_input  # noqa: E402
from services import browser_window, calendar_files, update_sequence  # noqa: E402

# 隔離に失敗した状態でテストが走らないようにする安全装置
assert _TEST_DB_DIR.as_posix() in str(database.engine.url), (
    f"テストが一時DB以外に接続しようとしています: {database.engine.url}"
)


def pytest_sessionfinish(session, exitstatus):
    database.engine.dispose()
    shutil.rmtree(_TEST_DB_DIR, ignore_errors=True)


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch, tmp_path):
    """各テストを、空のDB・初期化済みのインメモリ状態・一時データファイルで開始する。"""
    database.Base.metadata.drop_all(bind=database.engine)
    database.Base.metadata.create_all(bind=database.engine)
    update_sequence.reset()
    open_input.reset_state()

    monkeypatch.setattr(calendar_files, "HOLIDAYS_FILE_PATH", tmp_path / "holidays.txt")
    monkeypatch.setattr(calendar_files, "BUSINESS_TRIPS_FILE_PATH", tmp_path / "business_trips.txt")

    # 実際のブラウザやOSコマンドを起動させない（必要なテストは browser_stub で挙動を差し替える）
    monkeypatch.setattr(browser_window, "webbrowser", SimpleNamespace(open=lambda *a, **k: True))
    monkeypatch.setattr(browser_window, "_run_activation_command", lambda command, label: (False, None))
    monkeypatch.setattr(browser_window, "os", SimpleNamespace(startfile=lambda url: None))
    monkeypatch.setattr(
        browser_window,
        "subprocess",
        SimpleNamespace(run=lambda *a, **k: None, DEVNULL=None),
    )
    yield


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def db():
    session = database.SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def create_task(client):
    """APIでタスクを作成してレスポンスJSONを返すヘルパー。"""
    def _create(text: str = "Task", **fields) -> dict:
        payload = {
            "text": text,
            "start_date": "2024-01-01 00:00:00",
            "end_date": "2024-01-02 00:00:00",
            **fields,
        }
        response = client.post("/api/tasks", json=payload)
        assert response.status_code == 200, response.text
        return response.json()
    return _create
