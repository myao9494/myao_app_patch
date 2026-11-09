"""
macOS ネイティブ版ランチャーの 1 ページ 4 ペイン（2×2）配置を計算する。AppKit に依存しない。

【仕様】
- パネル（既定 1170×780）を 2×2 に分け、左上=検索、右上=OpenCode CLI、左下=常時保持メモ、右下=gantt メモを置く。
- 座標は Cocoa と同じ左下原点（y が大きいほど上）。最下部に全幅の状態表示欄を置く。
- 各ペインの入力欄・ボタンは自分のペインの内側に収め、互いに重ねない。
- 検索結果カード（FlippedView 内、左上原点）は検索ペインの幅に合わせ、操作ボタンを文字と別の行に置く。
"""

from __future__ import annotations

from dataclasses import dataclass

PANEL_WIDTH = 1170
PANEL_HEIGHT = 780
RESULT_CARD_HEIGHT = 84
RESULT_CARD_SPACING = 8

_MARGIN = 16
_GAP = 12
_PADDING = 8
_STATUS_Y = 10
_STATUS_HEIGHT = 20
_BOTTOM_ROW_Y = 38
_BOTTOM_ROW_HEIGHT = 300
_BUTTON_WIDTH = 88
_BUTTON_HEIGHT = 26


@dataclass(frozen=True)
class Rect:
    """矩形（x, y, 幅, 高さ）。辺が接するだけの場合は重なりとみなさない。"""

    x: float
    y: float
    width: float
    height: float

    @property
    def right(self) -> float:
        return self.x + self.width

    @property
    def top(self) -> float:
        return self.y + self.height

    def contains(self, other: "Rect") -> bool:
        """other が自分の内側（辺上を含む）に収まるか。"""
        return self.x <= other.x and self.y <= other.y and other.right <= self.right and other.top <= self.top

    def intersects(self, other: "Rect") -> bool:
        """面積を持って重なるか。"""
        return self.x < other.right and other.x < self.right and self.y < other.top and other.y < self.top


PANE_CONTROLS: dict[str, tuple[str, ...]] = {
    "search_pane": (
        "search_field",
        "extension_filter",
        "search_type_segmented",
        "gui_button",
        "gantt_checkbox",
        "path_in_filename_checkbox",
        "results_scroll",
    ),
    "opencode_pane": (
        "opencode_menu_button",
        "opencode_title_label",
        "opencode_commands_button",
        "opencode_history_popup",
        "opencode_new_chat_button",
        "opencode_model_popup",
        "opencode_plan_checkbox",
        "opencode_auto_checkbox",
        "opencode_dir_label",
        "opencode_output_scroll",
        "opencode_activity_label",
        "opencode_prompt_scroll",
        "opencode_usage_label",
        "opencode_submit_button",
    ),
    "scratchpad_pane": (
        "scratchpad_title_label",
        "scratchpad_status_label",
        "scratchpad_scroll",
    ),
    "gantt_pane": (
        "memo_title_label",
        "memo_parent_label",
        "memo_title_field",
        "memo_scroll",
        "memo_status_label",
        "memo_cancel_button",
        "memo_submit_button",
    ),
}


def four_pane_layout(width: float = PANEL_WIDTH, height: float = PANEL_HEIGHT) -> dict[str, Rect]:
    """パネルの大きさから、4 つのペインと各コントロールの矩形を返す。"""
    pane_width = (width - 2 * _MARGIN - _GAP) / 2
    inner_width = pane_width - 2 * _PADDING
    left_x = _MARGIN
    right_x = _MARGIN + pane_width + _GAP
    top_row_y = _BOTTOM_ROW_Y + _BOTTOM_ROW_HEIGHT + _GAP
    top_row_height = height - _MARGIN - top_row_y
    layout: dict[str, Rect] = {
        "status_label": Rect(_MARGIN, _STATUS_Y, width - 2 * _MARGIN, _STATUS_HEIGHT),
        "search_pane": Rect(left_x, top_row_y, pane_width, top_row_height),
        "opencode_pane": Rect(right_x, top_row_y, pane_width, top_row_height),
        "scratchpad_pane": Rect(left_x, _BOTTOM_ROW_Y, pane_width, _BOTTOM_ROW_HEIGHT),
        "gantt_pane": Rect(right_x, _BOTTOM_ROW_Y, pane_width, _BOTTOM_ROW_HEIGHT),
    }
    layout.update(_search_controls(left_x + _PADDING, top_row_y, top_row_y + top_row_height, inner_width))
    layout.update(_opencode_controls(right_x + _PADDING, top_row_y, top_row_y + top_row_height, inner_width))
    layout.update(_scratchpad_controls(left_x + _PADDING, _BOTTOM_ROW_Y, _BOTTOM_ROW_Y + _BOTTOM_ROW_HEIGHT, inner_width))
    layout.update(_gantt_controls(right_x + _PADDING, _BOTTOM_ROW_Y, _BOTTOM_ROW_Y + _BOTTOM_ROW_HEIGHT, inner_width))
    return layout


def _search_controls(x: float, bottom: float, top: float, inner_width: float) -> dict[str, Rect]:
    """検索ペイン: 検索欄＋拡張子欄 / 検索方式＋Web GUI / 絞り込み / 結果一覧。"""
    extension_width = 110
    field_y = top - _PADDING - 32
    segmented_y = field_y - 8 - 24
    checkbox_y = segmented_y - 6 - 22
    results_y = bottom + _PADDING
    return {
        "search_field": Rect(x, field_y, inner_width - extension_width - 8, 32),
        "extension_filter": Rect(x + inner_width - extension_width, field_y, extension_width, 32),
        "search_type_segmented": Rect(x, segmented_y, 250, 24),
        "gui_button": Rect(x + inner_width - 90, segmented_y, 90, 24),
        "gantt_checkbox": Rect(x, checkbox_y, 70, 22),
        "path_in_filename_checkbox": Rect(x + 78, checkbox_y, 160, 22),
        "results_scroll": Rect(x, results_y, inner_width, checkbox_y - 6 - results_y),
    }


def _opencode_controls(x: float, bottom: float, top: float, inner_width: float) -> dict[str, Rect]:
    """
    OpenCode ペイン（Claudian 風）: 見出し＋コマンド登録＋会話履歴＋新規 / モデル＋Plan＋自動承認 / 作業フォルダ /
    会話（チャット表示）/ 作業状況 / 指示入力 / 使用量＋送信（実行中は停止）。
    """
    title_y = top - _PADDING - 24
    toolbar_y = title_y - 4 - 24
    dir_y = toolbar_y - 4 - 16
    row_y = bottom + _PADDING
    prompt_y = row_y + _BUTTON_HEIGHT + 6
    prompt_height = 54
    activity_y = prompt_y + prompt_height + 4
    output_y = activity_y + 16 + 4
    new_chat_width = 56
    history_width = 104
    commands_width = 78
    plan_width = 62
    auto_width = 86
    model_width = inner_width - plan_width - auto_width - 16
    menu_width = 32
    title_x = x + menu_width + 8
    return {
        "opencode_menu_button": Rect(x, title_y, menu_width, 24),
        "opencode_title_label": Rect(title_x, title_y, x + inner_width - new_chat_width - history_width - commands_width - 24 - title_x, 22),
        "opencode_commands_button": Rect(x + inner_width - new_chat_width - history_width - commands_width - 16, title_y, commands_width, 24),
        "opencode_history_popup": Rect(x + inner_width - new_chat_width - 8 - history_width, title_y, history_width, 24),
        "opencode_new_chat_button": Rect(x + inner_width - new_chat_width, title_y, new_chat_width, 24),
        "opencode_model_popup": Rect(x, toolbar_y, model_width, 24),
        "opencode_plan_checkbox": Rect(x + model_width + 8, toolbar_y, plan_width, 24),
        "opencode_auto_checkbox": Rect(x + inner_width - auto_width, toolbar_y, auto_width, 24),
        "opencode_dir_label": Rect(x, dir_y, inner_width, 16),
        "opencode_output_scroll": Rect(x, output_y, inner_width, dir_y - 6 - output_y),
        "opencode_activity_label": Rect(x, activity_y, inner_width, 16),
        "opencode_prompt_scroll": Rect(x, prompt_y, inner_width, prompt_height),
        "opencode_usage_label": Rect(x, row_y, inner_width - _BUTTON_WIDTH - 8, _BUTTON_HEIGHT),
        "opencode_submit_button": Rect(x + inner_width - _BUTTON_WIDTH, row_y, _BUTTON_WIDTH, _BUTTON_HEIGHT),
    }


def _scratchpad_controls(x: float, bottom: float, top: float, inner_width: float) -> dict[str, Rect]:
    """常時保持メモペイン: 見出し＋保存状態 / 本文。"""
    title_y = top - _PADDING - 22
    scroll_y = bottom + _PADDING
    return {
        "scratchpad_title_label": Rect(x, title_y, 150, 22),
        "scratchpad_status_label": Rect(x + 158, title_y, inner_width - 158, 22),
        "scratchpad_scroll": Rect(x, scroll_y, inner_width, title_y - 6 - scroll_y),
    }


def _gantt_controls(x: float, bottom: float, top: float, inner_width: float) -> dict[str, Rect]:
    """gantt ペイン: 見出し＋parent / タスク名 / 本文 / 状態＋クリア＋送信。"""
    title_y = top - _PADDING - 22
    field_y = title_y - 6 - 28
    row_y = bottom + _PADDING
    scroll_y = row_y + _BUTTON_HEIGHT + 6
    submit_x = x + inner_width - _BUTTON_WIDTH
    cancel_x = submit_x - 8 - _BUTTON_WIDTH
    return {
        "memo_title_label": Rect(x, title_y, 120, 22),
        "memo_parent_label": Rect(x + inner_width - 180, title_y, 180, 22),
        "memo_title_field": Rect(x, field_y, inner_width, 28),
        "memo_scroll": Rect(x, scroll_y, inner_width, field_y - 6 - scroll_y),
        "memo_status_label": Rect(x, row_y, cancel_x - 8 - x, _BUTTON_HEIGHT),
        "memo_cancel_button": Rect(cancel_x, row_y, _BUTTON_WIDTH, _BUTTON_HEIGHT),
        "memo_submit_button": Rect(submit_x, row_y, _BUTTON_WIDTH, _BUTTON_HEIGHT),
    }


def result_card_layout(card_width: float) -> dict[str, Rect]:
    """
    検索結果カード内の配置（左上原点）。1〜3 行目にアイコン・題名・パス・抜粋、4 行目に操作ボタンを置く。
    open_area は結果を開く透明ボタンで、操作ボタンの行には掛けない。
    """
    button_y = 60
    return {
        "icon": Rect(12, 6, 20, 20),
        "title": Rect(38, 6, card_width - 50, 20),
        "path": Rect(12, 28, card_width - 24, 14),
        "snippet": Rect(12, 44, card_width - 24, 14),
        "open_area": Rect(0, 0, card_width, 58),
        "copy_button": Rect(12, button_y, 72, 20),
        "reveal_button": Rect(90, button_y, 96, 20),
        "folder_button": Rect(192, button_y, 104, 20),
        "gantt_link_button": Rect(12, button_y, 160, 20),
    }
