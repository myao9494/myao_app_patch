"""
4ペイン画面（macOS 版）のフォーカス巡回順・送信先の判定と、Shift 2 回押しの判定を検証する。
"""

from launcher_app.services.hotkeys import DoubleShiftDetector
from launcher_app.ui.four_pane import FOUR_PANE_TAB_ORDER, enter_action, next_focus_stop


def test_tab_order_cycles_search_opencode_scratchpad_gantt() -> None:
    """左上:検索 → 右上:OpenCode → 左下:常時保持メモ → 右下:gantt の順に循環する。"""
    assert FOUR_PANE_TAB_ORDER == (
        "query",
        "extension",
        "opencode_prompt",
        "opencode_submit",
        "scratchpad",
        "memo_title",
        "memo_body",
        "memo_submit",
    )
    assert next_focus_stop("query", backward=False) == "extension"
    assert next_focus_stop("memo_submit", backward=False) == "query"
    assert next_focus_stop("query", backward=True) == "memo_submit"
    assert next_focus_stop("scratchpad", backward=True) == "opencode_submit"
    # 巡回順にないボタン（クリア・新規会話）からは、属するペインの次の入力へ進む
    assert next_focus_stop("memo_cancel", backward=False) == "memo_submit"
    assert next_focus_stop("opencode_new_chat", backward=False) == "opencode_prompt"
    assert next_focus_stop("unknown", backward=False) == "extension"


def test_enter_action_by_focus_and_modifier() -> None:
    """
    OpenCode の指示欄は Claudian と同じく Enter で送信し、Shift+Enter で改行する（Cmd+Enter でも送信）。
    gantt の入力欄の Enter は改行に任せ、Ctrl / Cmd + Enter かボタン上の Enter だけ送信する。
    """
    assert enter_action("opencode_prompt", submit_modifier=False) == "submit_opencode"
    assert enter_action("opencode_prompt", submit_modifier=False, shift=True) == "newline"
    assert enter_action("opencode_prompt", submit_modifier=True) == "submit_opencode"
    assert enter_action("memo_body", submit_modifier=False, shift=True) == "newline"
    assert enter_action("opencode_submit", submit_modifier=False) == "submit_opencode"
    assert enter_action("opencode_new_chat", submit_modifier=False) == "reset_opencode"
    assert enter_action("scratchpad", submit_modifier=False) == "newline"
    assert enter_action("scratchpad", submit_modifier=True) == "newline"
    assert enter_action("memo_title", submit_modifier=False) == "newline"
    assert enter_action("memo_body", submit_modifier=True) == "submit_memo"
    assert enter_action("memo_submit", submit_modifier=False) == "submit_memo"
    assert enter_action("memo_cancel", submit_modifier=False) == "clear_memo"
    assert enter_action("query", submit_modifier=False) == "open_result"
    assert enter_action("query", submit_modifier=True) == "reveal_result"
    assert enter_action("extension", submit_modifier=False) == "open_result"


def test_double_shift_detector_fires_on_second_release_within_window() -> None:
    """Shift を 400ms 以内に 2 回押して離したときだけ反応し、3 回目は新しい 1 回目として数える。"""
    detector = DoubleShiftDetector(window_seconds=0.4)

    assert detector.update(True, now=1.0) is False
    assert detector.update(False, now=1.05) is False
    assert detector.update(True, now=1.2) is False
    assert detector.update(False, now=1.3) is True
    # 発火直後の押下は 1 回目として扱う
    assert detector.update(True, now=1.35) is False
    assert detector.update(False, now=1.4) is False


def test_double_shift_detector_ignores_slow_second_press() -> None:
    """間隔が空いた 2 回目は 1 回目として数え直す。"""
    detector = DoubleShiftDetector(window_seconds=0.4)

    detector.update(True, now=1.0)
    detector.update(False, now=1.1)
    detector.update(True, now=2.0)
    assert detector.update(False, now=2.1) is False
    detector.update(True, now=2.2)
    assert detector.update(False, now=2.3) is True


def test_double_shift_detector_ignores_repeated_flag_events() -> None:
    """押しっぱなしで同じ状態が続けて届いても回数に数えない。"""
    detector = DoubleShiftDetector(window_seconds=0.4)

    detector.update(True, now=1.0)
    detector.update(True, now=1.01)
    detector.update(False, now=1.05)
    assert detector.update(False, now=1.06) is False
    detector.update(True, now=1.1)
    assert detector.update(False, now=1.15) is True
