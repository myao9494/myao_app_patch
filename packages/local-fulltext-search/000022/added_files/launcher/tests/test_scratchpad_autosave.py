"""
常時保持メモ（Scratchpad）の自動保存が、入力の取りこぼしや二重保存なくバックエンドへ届くことを検証する。
"""

from __future__ import annotations

from typing import Any

from launcher_app.scratchpad import ScratchpadAutosave


class FakeTimer:
    """threading.Timer の代わりに、テストから明示的に発火させるタイマー。"""

    created: list["FakeTimer"] = []

    def __init__(self, interval: float, function: Any) -> None:
        self.interval = interval
        self.function = function
        self.cancelled = False
        self.daemon = False
        FakeTimer.created.append(self)

    def start(self) -> None:
        return None

    def cancel(self) -> None:
        self.cancelled = True

    def fire(self) -> None:
        if not self.cancelled:
            self.function()


def make_autosave(save: Any) -> tuple[ScratchpadAutosave, list[str]]:
    FakeTimer.created = []
    statuses: list[str] = []
    autosave = ScratchpadAutosave(save, delay=0.6, timer_factory=FakeTimer, on_status=statuses.append)
    return autosave, statuses


def test_load_does_not_mark_dirty_and_update_debounces_save() -> None:
    """読み込んだメモは保存せず、入力は最後のタイマーだけが保存する。"""
    saved: list[str] = []
    autosave, statuses = make_autosave(saved.append)

    autosave.load("サーバーのメモ")
    assert autosave.text == "サーバーのメモ"
    assert autosave.dirty is False
    assert autosave.flush() is True
    assert saved == []

    autosave.update("a")
    autosave.update("ab")
    assert FakeTimer.created[0].cancelled is True
    FakeTimer.created[-1].fire()

    assert saved == ["ab"]
    assert autosave.dirty is False
    assert statuses[-1] == "保存済み"


def test_edit_during_save_is_not_lost() -> None:
    """保存の通信中に入力した内容は、次の保存で必ずバックエンドへ届く。"""
    saved: list[str] = []
    autosave_ref: list[ScratchpadAutosave] = []

    def slow_save(text: str) -> None:
        saved.append(text)
        if len(saved) == 1:
            # 1 回目の保存の通信中に利用者が追記する
            autosave_ref[0].update("1行目\n2行目")

    autosave, _ = make_autosave(slow_save)
    autosave_ref.append(autosave)

    autosave.update("1行目")
    FakeTimer.created[0].fire()

    assert saved == ["1行目"]
    assert autosave.dirty is True
    FakeTimer.created[-1].fire()
    assert saved == ["1行目", "1行目\n2行目"]
    assert autosave.dirty is False


def test_failed_save_stays_dirty_and_reports_error() -> None:
    """保存に失敗したら未保存のまま残し、次の flush で再送する。"""
    attempts: list[str] = []

    def flaky_save(text: str) -> None:
        attempts.append(text)
        if len(attempts) == 1:
            raise OSError("接続できません")

    autosave, statuses = make_autosave(flaky_save)
    autosave.update("メモ")

    assert autosave.flush() is False
    assert autosave.dirty is True
    assert statuses[-1] == "保存失敗: 接続できません"
    assert autosave.flush() is True
    assert attempts == ["メモ", "メモ"]
