"""
グローバルホットキー定義が OS ごとの仕様に合うことを検証する。
"""

from launcher_app.services.hotkeys import (
    hotkey_spec_for_platform,
    modifier_names_for_platform,
)


def test_hotkey_spec_for_macos() -> None:
    """
    macOS では Command + Option を表示名として返す。
    """
    assert hotkey_spec_for_platform("Darwin") == "Command + Option"
    assert modifier_names_for_platform("Darwin") == frozenset({"cmd", "alt"})


def test_hotkey_spec_for_windows() -> None:
    """
    Windows では Windows + Alt を表示名として返す。
    """
    assert hotkey_spec_for_platform("Windows") == "Windows + Alt"
    assert modifier_names_for_platform("Windows") == frozenset({"cmd", "alt"})


def test_hotkey_spec_for_linux() -> None:
    """
    Linux では Ctrl + Shift を表示名として返す。
    """
    assert hotkey_spec_for_platform("Linux") == "Ctrl + Shift"
    assert modifier_names_for_platform("Linux") == frozenset({"ctrl", "shift"})
