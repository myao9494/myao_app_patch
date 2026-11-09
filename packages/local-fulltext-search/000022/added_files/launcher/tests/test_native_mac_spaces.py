"""
macOS ランチャーを現在の仮想デスクトップへ表示するための処理を検証する。
"""

from types import SimpleNamespace

import pytest

pytest.importorskip("AppKit")

from launcher_app.ui import native_mac


class FakePanel:
    """
    NSPanel に設定された表示属性を記録する。
    """

    def __init__(self, *, miniaturized: bool = False) -> None:
        self.behavior = None
        self.level = None
        self.hides_on_deactivate = None
        self.miniaturized = miniaturized
        self.deminiaturized = False

    def setCollectionBehavior_(self, behavior: int) -> None:
        self.behavior = behavior

    def setLevel_(self, level: int) -> None:
        self.level = level

    def setHidesOnDeactivate_(self, enabled: bool) -> None:
        self.hides_on_deactivate = enabled

    def isMiniaturized(self) -> bool:
        return self.miniaturized

    def deminiaturize_(self, sender: object | None) -> None:
        self.deminiaturized = True


class FakeProcessInfo:
    """
    App Nap 抑止 activity の開始を記録する。
    """

    def __init__(self) -> None:
        self.started: list[tuple[int, str]] = []

    def beginActivityWithOptions_reason_(self, options: int, reason: str) -> str:
        self.started.append((options, reason))
        return "activity-token"


def test_prepare_panel_for_active_space_reapplies_window_behavior(monkeypatch) -> None:
    """
    表示直前に Space 関連の window behavior と level を張り直す。
    """
    appkit = SimpleNamespace(
        NSWindowCollectionBehaviorCanJoinAllSpaces=1,
        NSWindowCollectionBehaviorFullScreenAuxiliary=2,
        NSWindowCollectionBehaviorStationary=4,
        NSWindowCollectionBehaviorTransient=8,
        NSStatusWindowLevel=99,
    )
    monkeypatch.setattr(native_mac, "AppKit", appkit)
    panel = FakePanel(miniaturized=True)
    delegate = SimpleNamespace(panel=panel)
    delegate._panel_collection_behavior = native_mac.LauncherDelegate._panel_collection_behavior.__get__(delegate)
    delegate._prepare_panel_for_active_space = native_mac.LauncherDelegate._prepare_panel_for_active_space.__get__(delegate)

    delegate._prepare_panel_for_active_space()

    assert panel.behavior == 15
    assert panel.level == 99
    assert panel.hides_on_deactivate is False
    assert panel.deminiaturized is True


def test_begin_activity_starts_app_nap_prevention_once(monkeypatch) -> None:
    """
    常駐ランチャー用の App Nap 抑止 activity は一度だけ開始する。
    """
    process_info = FakeProcessInfo()
    appkit = SimpleNamespace(
        NSActivityUserInitiatedAllowingIdleSystemSleep=16,
        NSActivityLatencyCritical=32,
        NSProcessInfo=SimpleNamespace(processInfo=lambda: process_info),
    )
    monkeypatch.setattr(native_mac, "AppKit", appkit)
    delegate = SimpleNamespace(activity_token=None)
    delegate._begin_activity = native_mac.LauncherDelegate._begin_activity.__get__(delegate)

    delegate._begin_activity()
    delegate._begin_activity()

    assert delegate.activity_token == "activity-token"
    assert process_info.started == [(48, "Local Fulltext Search launcher hotkey monitor")]


def test_show_panel_always_focuses_search_field_and_refreshes_settings(monkeypatch) -> None:
    """
    4ペイン画面では、どのペインで隠しても再表示時は検索欄へ focus し、共有設定の再取得を裏で始める。
    """
    calls: list[str] = []

    class FakePanel:
        def __init__(self) -> None:
            self.first_responder = None

        def orderOut_(self, sender: object | None) -> None:
            calls.append("order-out")

        def setAlphaValue_(self, value: float) -> None:
            calls.append(f"alpha:{value}")

        def makeKeyWindow(self) -> None:
            calls.append("key-window")

        def makeKeyAndOrderFront_(self, sender: object | None) -> None:
            calls.append("front")

        def orderFrontRegardless(self) -> None:
            calls.append("front-regardless")

        def makeFirstResponder_(self, control: object) -> None:
            self.first_responder = control

    fake_ns_app = SimpleNamespace(activateIgnoringOtherApps_=lambda enabled: calls.append(f"activate:{enabled}"))
    monkeypatch.setattr(native_mac, "AppKit", SimpleNamespace(NSApp=fake_ns_app))

    panel = FakePanel()
    delegate = SimpleNamespace(
        panel=panel,
        search_field="search-field",
        memo_title_field="memo-title",
        _prepare_panel_for_active_space=lambda: calls.append("prepare"),
        _center_panel_on_mouse_screen=lambda: calls.append("center"),
        _refresh_shared_settings_async=lambda: calls.append("refresh"),
    )
    delegate.show_panel = native_mac.LauncherDelegate.show_panel.__get__(delegate)

    delegate.show_panel()

    assert panel.first_responder == "search-field"
    assert "refresh" in calls


class FakeKeyDelegate:
    """LauncherPanel.keyDown_ が呼ぶ delegate の操作だけを記録する。"""

    def __init__(self, stop_name: str) -> None:
        self.stop_name = stop_name
        self.actions: list[str] = []
        self.moves: list[tuple[str, bool]] = []
        self.hidden = False

    def _focus_stop_name(self, responder: object) -> str:
        return self.stop_name

    def _run_enter_action(self, action: str) -> None:
        self.actions.append(action)

    def _move_focus_from(self, stop_name: str, backward: bool) -> None:
        self.moves.append((stop_name, backward))

    def hide_panel(self) -> None:
        self.hidden = True


def _key_event(characters: str, key_code: int):
    import AppKit

    return AppKit.NSEvent.keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode_(
        AppKit.NSEventTypeKeyDown,
        AppKit.NSMakePoint(0, 0),
        0,
        0.0,
        0,
        None,
        characters,
        characters,
        False,
        key_code,
    )


def _panel_with_delegate(monkeypatch, delegate: FakeKeyDelegate) -> tuple[object, list[bool]]:
    import AppKit

    panel = native_mac.LauncherPanel.alloc().initWithContentRect_styleMask_backing_defer_(
        AppKit.NSMakeRect(0, 0, 100, 100),
        AppKit.NSWindowStyleMaskBorderless,
        AppKit.NSBackingStoreBuffered,
        False,
    )
    panel.setDelegate_(delegate)
    monkeypatch.setattr(panel, "firstResponder", lambda: object())
    super_called: list[bool] = []
    monkeypatch.setattr(native_mac, "objc", SimpleNamespace(
        super=lambda cls, self: SimpleNamespace(keyDown_=lambda ev: super_called.append(True))
    ))
    return panel, super_called


def test_launcher_panel_key_down_runs_button_actions_on_return(monkeypatch) -> None:
    """
    送信・クリア・新規会話の各ボタンにフォーカスがある状態の Return は、そのボタンの操作を実行する。
    """
    for stop_name, expected in (
        ("memo_submit", "submit_memo"),
        ("memo_cancel", "clear_memo"),
        ("opencode_submit", "submit_opencode"),
        ("opencode_new_chat", "reset_opencode"),
    ):
        delegate = FakeKeyDelegate(stop_name)
        panel, super_called = _panel_with_delegate(monkeypatch, delegate)

        panel.keyDown_(_key_event("\r", 36))

        assert delegate.actions == [expected]
        assert super_called == []


def test_launcher_panel_key_down_moves_focus_from_buttons_on_tab(monkeypatch) -> None:
    """ボタン上の Tab / Shift+Tab は 4 ペインの巡回順で次の入力へ移る。"""
    delegate = FakeKeyDelegate("opencode_submit")
    panel, super_called = _panel_with_delegate(monkeypatch, delegate)

    panel.keyDown_(_key_event("\t", 48))
    panel.keyDown_(_key_event("\x19", 48))

    assert delegate.moves == [("opencode_submit", False), ("opencode_submit", True)]
    assert super_called == []


def test_launcher_panel_key_down_falls_back_for_other_keys(monkeypatch) -> None:
    """
    文字キーや、入力欄にフォーカスがあるときの Return は親クラス (super) の keyDown_ に任せる。
    """
    delegate = FakeKeyDelegate("memo_submit")
    panel, super_called = _panel_with_delegate(monkeypatch, delegate)
    panel.keyDown_(_key_event("a", 0))

    text_delegate = FakeKeyDelegate("memo_body")
    text_panel, text_super_called = _panel_with_delegate(monkeypatch, text_delegate)
    text_panel.keyDown_(_key_event("\r", 36))

    assert delegate.actions == []
    assert super_called == [True]
    assert text_delegate.actions == []
    assert text_super_called == [True]


def test_launcher_panel_key_down_escape_hides_from_any_pane(monkeypatch) -> None:
    """どのペインにフォーカスがあっても Escape でパネルを隠す。"""
    delegate = FakeKeyDelegate("scratchpad")
    panel, super_called = _panel_with_delegate(monkeypatch, delegate)

    panel.keyDown_(_key_event("\x1b", 53))

    assert delegate.hidden is True
    assert super_called == []
