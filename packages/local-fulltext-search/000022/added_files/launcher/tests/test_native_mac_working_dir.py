"""
macOS ランチャーの ☰ メニュー「opencode 実行フォルダ」の保存処理を検証する。
フォルダ選択ダイアログ（NSOpenPanel）は開かず、選んだ後に保存して画面へ反映する部分だけを確かめる。
"""

from typing import Any

import pytest

pytest.importorskip("AppKit")

from launcher_app.config import LauncherConfig
from launcher_app.ui.native_mac import LauncherDelegate


class SpyClient:
    """保存先と保存結果を記録する API クライアントの代役。"""

    def __init__(self, *, saved: str | None = None, error: Exception | None = None) -> None:
        self.saved = saved
        self.error = error
        self.calls: list[str] = []

    def get_app_settings(self) -> dict[str, Any]:
        return {}

    def save_opencode_working_dir(self, path: str) -> str:
        self.calls.append(path)
        if self.error:
            raise self.error
        return self.saved if self.saved is not None else path


def _delegate(client: SpyClient) -> Any:
    return LauncherDelegate.alloc().initWithClient_config_(client, LauncherConfig())


def test_apply_working_dir_saves_and_updates_session(tmp_path) -> None:
    """選んだフォルダを保存し、OpenCode の作業フォルダと表示用の状態へ反映する。"""
    client = SpyClient()
    delegate = _delegate(client)

    message = delegate._apply_opencode_working_dir(str(tmp_path))

    assert client.calls == [str(tmp_path)]
    assert delegate.opencode_working_dir == str(tmp_path)
    assert delegate.opencode_session.working_dir == str(tmp_path)
    assert str(tmp_path) in message


def test_apply_working_dir_uses_default_returned_by_backend_when_cleared() -> None:
    """空欄（既定へ戻す）で保存すると、バックエンドが補った既定フォルダを採用する。"""
    client = SpyClient(saved="/default/dir")
    delegate = _delegate(client)

    delegate._apply_opencode_working_dir("")

    assert client.calls == [""]
    assert delegate.opencode_working_dir == "/default/dir"
    assert delegate.opencode_session.working_dir == "/default/dir"


def test_apply_working_dir_keeps_old_value_when_save_fails() -> None:
    """保存に失敗したら今の作業フォルダを変えず、理由を返す。"""
    client = SpyClient(error=RuntimeError("接続できません"))
    delegate = _delegate(client)
    delegate.opencode_working_dir = "/old"
    delegate.opencode_session.set_working_dir("/old")

    message = delegate._apply_opencode_working_dir("/new")

    assert delegate.opencode_working_dir == "/old"
    assert delegate.opencode_session.working_dir == "/old"
    assert "接続できません" in message
