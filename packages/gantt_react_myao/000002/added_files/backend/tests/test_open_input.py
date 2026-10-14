"""
open-input（外部からタスク入力画面を開かせる）APIと、ブラウザを前面に出す処理のテスト。
実際のブラウザ・OSコマンドは conftest.py で無効化されている。
"""
from types import SimpleNamespace

import pytest

from routers import open_input
from services import browser_window


@pytest.fixture
def show_window_result(monkeypatch):
    """try_show_gantt_window の結果を固定し、渡された引数を記録する。"""
    calls = []

    def _set(result: tuple[bool, str | None]):
        def fake(frontend_url, frontend_is_alive):
            calls.append((frontend_url, frontend_is_alive))
            return result
        monkeypatch.setattr(browser_window, "try_show_gantt_window", fake)
        return calls

    return _set


# --- API ---

def test_open_input_stores_request_until_acknowledged(client, create_task, show_window_result):
    show_window_result((True, None))
    task = create_task("Open Me")

    open_res = client.post(f"/api/tasks/{task['id']}/open-input")

    assert open_res.status_code == 200
    payload = open_res.json()
    assert payload["status"] == "ok"
    assert payload["task_id"] == task["id"]
    assert payload["input_opened"] is True
    assert payload["gantt_visible"] is True
    assert payload["visibility_error"] is None
    assert payload["request"]["task_id"] == task["id"]
    assert payload["request"]["request_id"] > 0

    assert client.get("/api/tasks/open-input-request").json() == payload["request"]

    ack_res = client.post(f"/api/tasks/open-input-request/{payload['request']['request_id']}/ack")
    assert ack_res.json()["cleared"] is True
    assert client.get("/api/tasks/open-input-request").json() is None


def test_open_input_reports_window_activation_failure(client, create_task, show_window_result):
    show_window_result((False, "activation failed"))
    task = create_task("学校", id=154, kind_task=2)

    payload = client.post(f"/api/tasks/{task['id']}/open-input").json()

    assert payload["input_opened"] is True
    assert payload["gantt_visible"] is False
    assert payload["visibility_error"] == "activation failed"


def test_acknowledge_ignores_stale_request_id(client, create_task, show_window_result):
    show_window_result((True, None))
    task = create_task("Open Me")
    request_payload = client.post(f"/api/tasks/{task['id']}/open-input").json()["request"]

    ack_res = client.post(f"/api/tasks/open-input-request/{request_payload['request_id'] + 1}/ack")

    assert ack_res.json()["cleared"] is False
    assert client.get("/api/tasks/open-input-request").json() == request_payload


def test_newer_request_replaces_older_one(client, create_task, show_window_result):
    show_window_result((True, None))
    first = create_task("First")
    second = create_task("Second")

    first_request = client.post(f"/api/tasks/{first['id']}/open-input").json()["request"]
    second_request = client.post(f"/api/tasks/{second['id']}/open-input").json()["request"]

    assert second_request["request_id"] > first_request["request_id"]
    assert client.get("/api/tasks/open-input-request").json() == second_request


def test_request_ids_keep_increasing_after_backend_restart(client, create_task, show_window_result, monkeypatch):
    """再起動で状態が消えても、以前より小さいIDを採番しない（フロントエンドが処理済みと誤認するため）。"""
    show_window_result((True, None))
    task = create_task()

    def request_id_at(clock_seconds: float) -> int:
        monkeypatch.setattr(open_input, "time", SimpleNamespace(time=lambda: clock_seconds))
        return client.post(f"/api/tasks/{task['id']}/open-input").json()["request"]["request_id"]

    first = request_id_at(1_700_000_000.0)
    second = request_id_at(1_700_000_000.0)
    open_input.reset_state()  # 再起動に相当
    after_restart = request_id_at(1_700_000_005.0)

    assert first < second < after_restart


def test_open_input_returns_404_for_missing_task(client):
    assert client.post("/api/tasks/999999/open-input").status_code == 404
    assert client.get("/api/tasks/open-input-request").json() is None


def test_open_input_passes_frontend_url_and_heartbeat_state(client, create_task, show_window_result, monkeypatch):
    calls = show_window_result((True, None))
    monkeypatch.setenv("GANTT_FRONTEND_URL", "http://localhost:9000/")
    task = create_task()

    client.post(f"/api/tasks/{task['id']}/open-input")
    client.post("/api/tasks/open-input-client-heartbeat")
    client.post(f"/api/tasks/{task['id']}/open-input")

    assert calls == [("http://localhost:9000/", False), ("http://localhost:9000/", True)]


def test_frontend_url_defaults_to_localhost_8000(client, create_task, show_window_result, monkeypatch):
    calls = show_window_result((True, None))
    monkeypatch.delenv("GANTT_FRONTEND_URL", raising=False)
    task = create_task()

    client.post(f"/api/tasks/{task['id']}/open-input")

    assert calls == [("http://localhost:8000/", False)]


def test_heartbeat_expires_after_ttl(client, monkeypatch):
    client.post("/api/tasks/open-input-client-heartbeat")
    assert open_input.has_recent_frontend_heartbeat() is True

    monkeypatch.setattr(open_input, "FRONTEND_HEARTBEAT_TTL_SECONDS", -1)
    assert open_input.has_recent_frontend_heartbeat() is False


# --- ブラウザを前面に出す処理 ---

@pytest.fixture
def browser(monkeypatch):
    """OS種別と各手段の成否を指定して、開かれたURLを記録するスタブを組み立てる。"""
    opened_urls: list[str] = []

    def _configure(platform: str, tab_activated: bool = False, window_activated: bool = False):
        monkeypatch.setattr(browser_window, "sys", SimpleNamespace(platform=platform))
        monkeypatch.setattr(
            browser_window, "try_activate_existing_browser_tab", lambda url: (tab_activated, None)
        )
        monkeypatch.setattr(
            browser_window, "try_activate_existing_browser_window", lambda: (window_activated, None)
        )
        monkeypatch.setattr(
            browser_window,
            "webbrowser",
            SimpleNamespace(open=lambda url, new=0, autoraise=True: opened_urls.append(url) or True),
        )
        return opened_urls

    return _configure


def test_existing_browser_tab_is_preferred_over_opening_url(browser):
    opened_urls = browser("darwin", tab_activated=True)

    assert browser_window.try_show_gantt_window("http://localhost:8000/", False) == (True, None)
    assert opened_urls == []


def test_macos_opens_url_when_existing_tab_not_found(browser):
    opened_urls = browser("darwin")

    assert browser_window.try_show_gantt_window("http://localhost:8000/", True) == (True, None)
    assert opened_urls == ["http://localhost:8000/"]


def test_windows_activates_existing_window_when_frontend_is_alive(browser):
    opened_urls = browser("win32", window_activated=True)

    assert browser_window.try_show_gantt_window("http://localhost:8000/", True) == (True, None)
    assert opened_urls == []


def test_windows_does_not_open_new_tab_when_alive_frontend_window_cannot_be_activated(browser):
    opened_urls = browser("win32", window_activated=False)

    visible, error = browser_window.try_show_gantt_window("http://localhost:8000/", True)

    assert visible is False
    assert "no browser window was activated" in error
    assert opened_urls == []


def test_windows_opens_url_when_frontend_is_not_alive(browser):
    opened_urls = browser("win32")

    assert browser_window.try_show_gantt_window("http://localhost:8000/", False) == (True, None)
    assert opened_urls == ["http://localhost:8000/"]


def test_reports_error_when_browser_cannot_be_opened(browser, monkeypatch):
    browser("darwin")
    monkeypatch.setattr(browser_window, "webbrowser", SimpleNamespace(open=lambda *a, **k: False))

    assert browser_window.try_show_gantt_window("http://localhost:8000/", False) == (
        False,
        "webbrowser.open returned false",
    )
