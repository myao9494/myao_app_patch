"""
macOS ランチャーが .py の検索結果を、共有設定の venv（python_venv_path）を添えて開くことを検証する。
venv の選び方そのものは test_python_env.py で確かめる。
"""

from typing import Any

import pytest

pytest.importorskip("AppKit")

from launcher_app.config import LauncherConfig
from launcher_app.models import SearchResultItem
from launcher_app.python_env import PythonEnvError
from launcher_app.ui import native_mac
from launcher_app.ui.native_mac import LauncherDelegate


class SpyClient:
    """アクセス数の記録だけを受け取る API クライアントの代役。"""

    def __init__(self) -> None:
        self.clicks: list[int] = []

    def get_app_settings(self) -> dict[str, Any]:
        return {}

    def record_click(self, file_id: int, query: str = "") -> int:
        self.clicks.append(file_id)
        return 1


class SpyLabel:
    def __init__(self) -> None:
        self.text = ""

    def setStringValue_(self, text: str) -> None:
        self.text = text


def _delegate(client: SpyClient) -> Any:
    return LauncherDelegate.alloc().initWithClient_config_(client, LauncherConfig())


def _python_item(path: str = "/work/tools/job.py") -> SearchResultItem:
    return SearchResultItem(
        file_id=7,
        result_kind="file",
        source_type="local",
        target_path="/work",
        file_name="job.py",
        full_path=path,
        file_ext=".py",
        created_at="",
        mtime="",
        click_count=0,
        snippet="",
    )


def test_shared_settings_keep_python_venv_path_and_allow_clearing() -> None:
    delegate = _delegate(SpyClient())

    delegate._apply_shared_state({"python_venv_path": "  /venvs/tool/.venv  "})
    assert delegate.python_venv_path == "/venvs/tool/.venv"

    delegate._apply_shared_state({"gantt_parent": 3})
    assert delegate.python_venv_path == "/venvs/tool/.venv", "項目が無い応答では今の値を保つ"

    delegate._apply_shared_state({"python_venv_path": ""})
    assert delegate.python_venv_path == "", "空欄で保存されたら設定なしに戻す"


def test_opening_python_result_passes_configured_venv(monkeypatch) -> None:
    client = SpyClient()
    delegate = _delegate(client)
    delegate._apply_shared_state({"python_venv_path": "/venvs/tool/.venv"})
    opened: list[tuple[str, str]] = []
    monkeypatch.setattr(native_mac, "open_python_script", lambda path, venv: opened.append((path, venv)))

    delegate._open_item(_python_item())

    assert opened == [("/work/tools/job.py", "/venvs/tool/.venv")]
    assert client.clicks == [7]


def test_unusable_venv_is_shown_in_alert_and_script_is_not_run(monkeypatch) -> None:
    """設定した venv が使えないときは、理由をポップアップ（とステータス）で知らせ、実行もアクセス数の記録もしない。"""
    client = SpyClient()
    delegate = _delegate(client)
    delegate.status_label = SpyLabel()
    alerts: list[tuple[str, str]] = []
    monkeypatch.setattr(native_mac, "show_error_alert", lambda title, message: alerts.append((title, message)))

    def _fail(path: str, venv: str) -> None:
        raise PythonEnvError("Python 実行環境（.venv）が見つかりません: /missing/.venv")

    monkeypatch.setattr(native_mac, "open_python_script", _fail)

    delegate._open_item(_python_item())

    assert alerts == [("Python を実行できません", "Python 実行環境（.venv）が見つかりません: /missing/.venv")]
    assert "Python 実行環境（.venv）が見つかりません" in delegate.status_label.text
    assert client.clicks == []


def test_failure_to_start_python_is_shown_in_alert(monkeypatch) -> None:
    """ターミナルの起動など、実行の手前で失敗したときもポップアップで知らせる。"""
    delegate = _delegate(SpyClient())
    delegate.status_label = SpyLabel()
    alerts: list[tuple[str, str]] = []
    monkeypatch.setattr(native_mac, "show_error_alert", lambda title, message: alerts.append((title, message)))

    def _fail(path: str, venv: str) -> None:
        raise FileNotFoundError("osascript")

    monkeypatch.setattr(native_mac, "open_python_script", _fail)

    delegate._open_item(_python_item())

    assert len(alerts) == 1 and "osascript" in alerts[0][1]


def test_other_files_do_not_use_python_alert(monkeypatch) -> None:
    """.py 以外を開けなかったときは、これまでどおりステータスだけに出す。"""
    delegate = _delegate(SpyClient())
    delegate.status_label = SpyLabel()
    alerts: list[tuple[str, str]] = []
    monkeypatch.setattr(native_mac, "show_error_alert", lambda title, message: alerts.append((title, message)))

    def _fail(path: str) -> None:
        raise OSError("cannot start")

    monkeypatch.setattr(native_mac, "open_with_system_file_launcher", _fail)

    delegate._open_item(_python_item("/work/tools/job.bat"))

    assert alerts == []
    assert "cannot start" in delegate.status_label.text
