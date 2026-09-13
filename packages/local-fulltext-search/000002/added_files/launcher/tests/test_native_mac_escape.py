"""
macOS ネイティブランチャーの Escape キーによる非表示および画面遷移、ホットキー状態管理を検証するテスト。

【仕様】
- LauncherPanel.keyDown_ において、Escape キー（keyCode 53 または "\\x1b"）が押下された場合：
  - 現在の画面が memo 画面であれば、検索画面へ復帰する（_switch_screen("search")）。
  - 現在の画面が search 画面であれば、パネルを非表示にする（hide_panel()）。
- フォーカスが検索欄以外のボタンやビューにあっても、Escape キーで確実に非表示にできること。
- hide_panel() 呼び出し時に hotkey_activated フラグが False にリセットされること。
"""

from unittest.mock import MagicMock
import pytest

from launcher_app.ui import native_mac


def test_launcher_panel_keydown_escape_in_search_screen():
    """
    検索画面で Escape キーが押下された場合、hide_panel() が呼ばれることを検証する。
    """
    panel = native_mac.LauncherPanel.alloc().init()
    delegate = MagicMock()
    delegate.active_screen = "search"
    panel.setDelegate_(delegate)

    # keyCode 53 は macOS の Escape キー
    event = MagicMock()
    event.keyCode.return_value = 53
    event.characters.return_value = "\x1b"

    panel.keyDown_(event)

    delegate.hide_panel.assert_called_once()
    delegate._switch_screen.assert_not_called()


def test_launcher_panel_keydown_escape_in_memo_screen():
    """
    gantt メモ画面で Escape キーが押下された場合、検索画面へ切り替わることを検証する。
    """
    panel = native_mac.LauncherPanel.alloc().init()
    delegate = MagicMock()
    delegate.active_screen = "memo"
    panel.setDelegate_(delegate)

    event = MagicMock()
    event.keyCode.return_value = 53
    event.characters.return_value = "\x1b"

    panel.keyDown_(event)

    delegate._switch_screen.assert_called_once_with("search")
    delegate.hide_panel.assert_not_called()


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
    # 2回目の呼び出しは無視されるため、show_panel (orderFront等) は呼ばれない
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

    # キー押下時: active=True -> hotkey_activated=True
    delegate._handle_modifier_flags(cmd_opt_flags)
    assert delegate.hotkey_activated is True

    # パネルが hide されても、キーが押されたままなら hotkey_activated は True のまま
    delegate.hide_panel()
    assert delegate.hotkey_activated is True

    # 押下継続中の再チェックでも hotkey_activated は True を維持
    delegate._handle_modifier_flags(cmd_opt_flags)
    assert delegate.hotkey_activated is True

    # キーを離したとき (active=False) に False にリセットされる
    delegate._handle_modifier_flags(0)
    assert delegate.hotkey_activated is False
