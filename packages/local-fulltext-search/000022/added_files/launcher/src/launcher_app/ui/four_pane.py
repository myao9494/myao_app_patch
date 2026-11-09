"""
1ページ4ペイン画面（macOS 版）のフォーカス巡回順と Enter キーの動作を決める。

【仕様】
- Tab / Shift+Tab の巡回順は「検索欄 → 拡張子欄 → OpenCode入力 → OpenCode送信 → 常時保持メモ →
  ganttタスク名 → ganttメモ本文 → gantt送信 → 検索欄」。
- 巡回順にないボタン（gantt のクリア、OpenCode の新規会話）からの Tab は、属するペインの次の入力へ進む。
- Enter の動作:
  - OpenCode の指示欄は Claudian と同じく Enter で送信、Shift+Enter で改行（Cmd + Enter でも送信）。
  - gantt の入力欄（タスク名・本文）は改行。Ctrl / Cmd + Enter で送信する。
  - 常時保持メモは常に改行（送信先がない）。
  - ボタン上の Enter はそのボタンの操作（送信・クリア・新規会話）。
  - 検索欄・拡張子欄は選択中の結果を開き、Ctrl / Cmd + Enter は保存場所を開く。
"""

from __future__ import annotations

FOUR_PANE_TAB_ORDER: tuple[str, ...] = (
    "query",
    "extension",
    "opencode_prompt",
    "opencode_submit",
    "scratchpad",
    "memo_title",
    "memo_body",
    "memo_submit",
)

# 巡回順にないボタンは、巡回順の直前の位置にあるものとして扱う
_OFF_ORDER_ANCHORS = {
    "memo_cancel": "memo_body",
    "opencode_new_chat": "extension",
}

_SUBMIT_TARGETS = {
    "opencode_prompt": "submit_opencode",
    "memo_title": "submit_memo",
    "memo_body": "submit_memo",
}

_BUTTON_ACTIONS = {
    "opencode_submit": "submit_opencode",
    "opencode_new_chat": "reset_opencode",
    "memo_submit": "submit_memo",
    "memo_cancel": "clear_memo",
}

BUTTON_STOPS = frozenset(_BUTTON_ACTIONS)


def next_focus_stop(current: str, *, backward: bool) -> str:
    """現在のフォーカス位置から、Tab（backward=True なら Shift+Tab）で移る先を返す。"""
    anchor = _OFF_ORDER_ANCHORS.get(current, current)
    if anchor not in FOUR_PANE_TAB_ORDER:
        anchor = "query"
    index = FOUR_PANE_TAB_ORDER.index(anchor)
    if current in _OFF_ORDER_ANCHORS and backward:
        # 巡回順にないボタンからの Shift+Tab は、属するペインの直前の入力へ戻る
        return anchor
    step = -1 if backward else 1
    return FOUR_PANE_TAB_ORDER[(index + step) % len(FOUR_PANE_TAB_ORDER)]


def enter_action(focused: str, *, submit_modifier: bool, shift: bool = False) -> str:
    """
    フォーカス位置と Ctrl / Cmd・Shift の有無から Enter の動作名を返す。
    戻り値: newline / submit_opencode / reset_opencode / submit_memo / clear_memo / open_result / reveal_result
    """
    if focused in _BUTTON_ACTIONS:
        return _BUTTON_ACTIONS[focused]
    if focused == "opencode_prompt":
        return "newline" if shift and not submit_modifier else "submit_opencode"
    if focused in _SUBMIT_TARGETS:
        return _SUBMIT_TARGETS[focused] if submit_modifier else "newline"
    if focused == "scratchpad":
        return "newline"
    return "reveal_result" if submit_modifier else "open_result"
