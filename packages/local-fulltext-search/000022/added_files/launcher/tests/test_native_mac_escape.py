"""
macOS ネイティブランチャーの Escape キーによる非表示およびホットキー状態管理を検証するテスト。

【仕様】
- 1ページ4ペイン統合により、どのペインにフォーカスがあっても Escape キー（keyCode 53 または "\\x1b"）押下時はパネルを非表示にする（hide_panel()）。
- hide_panel() 呼び出し時にキー押下中であれば hotkey_activated フラグは True を維持し、キー解放時に False にリセットされること。
"""

from unittest.mock import MagicMock
import pytest

pytest.importorskip("AppKit", reason="macOS 専用のテスト")

from launcher_app.ui import native_mac  # noqa: E402


def test_launcher_panel_keydown_escape_hides_panel_from_any_pane():
    """
    1ページ4ペイン統合画面で Escape キーが押下された場合、フォーカス位置に関わらず hide_panel() が呼ばれることを検証する。
    """
    panel = native_mac.LauncherPanel.alloc().init()
    delegate = MagicMock()
    panel.setDelegate_(delegate)

    event = MagicMock()
    event.keyCode.return_value = 53
    event.characters.return_value = "\x1b"

    panel.keyDown_(event)

    delegate.hide_panel.assert_called_once()


def test_toggle_panel_cooldown():
    """
    toggle_panel() は短時間（350ms以内）の連続呼び出しをクールダウンで無視することを検証する。
    """
    client = MagicMock()
    config = MagicMock()
    config.web_base_url = "http://127.0.0.1:8001"
    config.gantt_parent = 0

    delegate = native_mac.LauncherDelegate.alloc().initWithClient_config_(client, config)
    mock_panel = MagicMock()
    mock_panel.isVisible.return_value = True
    delegate.panel = mock_panel

    delegate.toggle_panel()
    assert mock_panel.orderOut_.call_count == 1

    # 連続で呼んでもクールダウンにより orderOut_ / show_panel は呼ばれない
    mock_panel.isVisible.return_value = False
    delegate.toggle_panel()
    assert mock_panel.makeKeyAndOrderFront_.call_count == 0


def test_hotkey_activated_remains_true_while_held_and_resets_on_release():
    """
    キー押下中 (active=True) は hotkey_activated が True に維持され、
    キー解放時 (active=False) に初めて False にリセットされることを検証する。
    """
    client = MagicMock()
    config = MagicMock()
    config.web_base_url = "http://127.0.0.1:8001"
    config.gantt_parent = 0

    delegate = native_mac.LauncherDelegate.alloc().initWithClient_config_(client, config)
    import AppKit
    cmd_opt_flags = AppKit.NSEventModifierFlagCommand | AppKit.NSEventModifierFlagOption

    delegate._handle_modifier_flags(cmd_opt_flags)
    assert delegate.hotkey_activated is True

    delegate.hide_panel()
    assert delegate.hotkey_activated is True

    delegate._handle_modifier_flags(cmd_opt_flags)
    assert delegate.hotkey_activated is True

    delegate._handle_modifier_flags(0)
    assert delegate.hotkey_activated is False


def test_double_shift_toggles_panel_on_second_release(monkeypatch):
    """
    Shift 2 回押しの方式では、400ms 以内に 2 回目の Shift を離したときにパネルを切り替える。
    """
    client = MagicMock()
    client.get_app_settings.return_value = {"launcher_hotkey": "double_shift"}
    config = MagicMock()
    config.web_base_url = "http://127.0.0.1:8001"
    config.gantt_parent = 0
    delegate = native_mac.LauncherDelegate.alloc().initWithClient_config_(client, config)
    toggled: list[bool] = []
    monkeypatch.setattr(native_mac.AppHelper, "callAfter", lambda fn, *args: toggled.append(True))
    times = iter([1.0, 1.05, 1.2, 1.3])
    monkeypatch.setattr(native_mac.time, "monotonic", lambda: next(times))
    import AppKit
    shift = AppKit.NSEventModifierFlagShift

    delegate._handle_modifier_flags(shift)
    delegate._handle_modifier_flags(0)
    delegate._handle_modifier_flags(shift)
    delegate._handle_modifier_flags(0)

    assert toggled == [True]


def test_opencode_and_scratchpad_actions_exist_on_delegate():
    """
    OpenCode の送信・新規会話ボタンが呼ぶ Cocoa アクションと、Enter 判定の実行先が delegate に実装されている。
    """
    for selector_name in ("submitOpenCode_", "resetOpenCode_", "submitMemo_", "clearMemo_"):
        assert callable(getattr(native_mac.LauncherDelegate, selector_name, None)), selector_name
    for method_name in ("_submit_opencode", "_reset_opencode", "_run_enter_action", "_move_focus_from", "_focus_stop_name"):
        assert callable(getattr(native_mac.LauncherDelegate, method_name, None)), method_name
