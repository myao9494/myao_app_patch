"""
ランチャー表示を切り替えるホットキーの表示名と、Shift 2 回押しの判定を提供する。

【仕様】
- 監視そのものは各ランチャー（macOS: CGEventTap、Windows WPF: 低レベルキーボードフック）が行う。
- ここには OS に依存しない判定と表示名だけを置く。
"""

import platform
import time


def hotkey_spec_for_platform(system_name: str | None = None, mode: str = "command_option") -> str:
    """
    OS ごとの仕様に合う表示用ホットキー名を返す。
    """
    if mode == "double_shift":
        return "Shift × 2"
    name = system_name or platform.system()
    if name == "Darwin":
        return "Command + Option"
    if name == "Windows":
        return "Windows + Alt"
    return "Ctrl + Shift"


def modifier_names_for_platform(system_name: str | None = None) -> frozenset[str]:
    """
    ランチャー表示トグルに使う修飾キー名を OS ごとに返す。

    macOS は Command + Option、Windows は Windows + Alt、その他 OS は Ctrl + Shift を使う。
    """
    name = system_name or platform.system()
    if name == "Darwin":
        return frozenset({"cmd", "alt"})
    if name == "Windows":
        return frozenset({"cmd", "alt"})
    return frozenset({"ctrl", "shift"})


class DoubleShiftDetector:
    """
    Shift の 2 回押し（1 回目を離してから window_seconds 以内に 2 回目を離す）を検出する。
    macOS ネイティブ版の修飾キー監視から、Shift の押下状態が変わるたびに update() を呼ぶ。
    同じ状態が続けて届いた場合（押しっぱなしの重複通知）は回数に数えない。
    発火した直後の押下は、新しい 1 回目として数える。
    """

    def __init__(self, *, window_seconds: float = 0.4) -> None:
        self.window_seconds = window_seconds
        self.shift_down = False
        self.first_released_at: float | None = None

    def update(self, shift_active: bool, *, now: float) -> bool:
        """Shift の現在の押下状態を渡し、2 回押しが成立したら True を返す。"""
        if shift_active == self.shift_down:
            return False
        self.shift_down = shift_active
        if shift_active:
            return False
        if self.first_released_at is not None and now - self.first_released_at <= self.window_seconds:
            self.first_released_at = None
            return True
        self.first_released_at = now
        return False

    def reset(self) -> None:
        """押下状態と 1 回目の記録を消す。"""
        self.shift_down = False
        self.first_released_at = None
