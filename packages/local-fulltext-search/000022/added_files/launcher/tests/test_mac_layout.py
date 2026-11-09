"""
macOS ネイティブ版の 2×2 ペイン配置が、パネルからはみ出さず部品どうしが重ならないことを検証する。
AppKit を使わない配置計算なので、macOS 以外でも実行できる。
"""

from itertools import combinations

from launcher_app.ui.mac_layout import (
    PANE_CONTROLS,
    RESULT_CARD_HEIGHT,
    Rect,
    four_pane_layout,
    result_card_layout,
)


def test_panes_form_two_by_two_grid_inside_panel() -> None:
    """検索=左上、OpenCode=右上、常時保持メモ=左下、gantt=右下に、パネル内へ重ならず並ぶ。"""
    layout = four_pane_layout(1170, 780)
    panel = Rect(0, 0, 1170, 780)
    search, opencode, scratchpad, gantt = (
        layout["search_pane"], layout["opencode_pane"], layout["scratchpad_pane"], layout["gantt_pane"],
    )

    for pane in (search, opencode, scratchpad, gantt):
        assert panel.contains(pane)
    # Cocoa は左下原点なので、上段ほど y が大きい
    assert search.x < opencode.x and search.y == opencode.y
    assert scratchpad.x < gantt.x and scratchpad.y == gantt.y
    assert search.y > scratchpad.y
    for first, second in combinations((search, opencode, scratchpad, gantt), 2):
        assert not first.intersects(second)
    assert not layout["status_label"].intersects(scratchpad)
    assert not layout["status_label"].intersects(gantt)


def test_controls_stay_inside_their_pane_without_overlapping() -> None:
    """各ペインの入力欄・ボタンは自分のペインの中に収まり、互いに重ならない。"""
    layout = four_pane_layout(1170, 780)

    for pane_name, control_names in PANE_CONTROLS.items():
        pane = layout[pane_name]
        for name in control_names:
            assert pane.contains(layout[name]), f"{name} が {pane_name} からはみ出している"
        for first, second in combinations(control_names, 2):
            assert not layout[first].intersects(layout[second]), f"{first} と {second} が重なっている"


def test_result_card_fits_search_pane_with_buttons_on_own_row() -> None:
    """検索結果カードは検索ペインの幅に収まり、操作ボタンは文字と重ならない別の行に置く。"""
    layout = four_pane_layout(1170, 780)
    card_width = layout["results_scroll"].width - 18
    card = result_card_layout(card_width)
    card_rect = Rect(0, 0, card_width, RESULT_CARD_HEIGHT)

    texts = ("icon", "title", "path", "snippet")
    buttons = ("copy_button", "reveal_button", "folder_button")
    for name in (*texts, *buttons, "gantt_link_button", "open_area"):
        assert card_rect.contains(card[name]), f"{name} がカードからはみ出している"
    for text in texts:
        for button in (*buttons, "gantt_link_button"):
            assert not card[text].intersects(card[button])
    for first, second in combinations(buttons, 2):
        assert not card[first].intersects(card[second])
    # 透明なクリック領域はボタンを覆わない
    for button in (*buttons, "gantt_link_button"):
        assert not card["open_area"].intersects(card[button])


def test_opencode_pane_has_chat_toolbar_controls() -> None:
    """OpenCode ペインは Claudian 風に、スラッシュコマンド登録・会話履歴・新規会話・モデル・Plan・自動承認・作業状況・使用量を持つ。"""
    expected = {
        "opencode_menu_button",
        "opencode_commands_button",
        "opencode_history_popup",
        "opencode_new_chat_button",
        "opencode_model_popup",
        "opencode_plan_checkbox",
        "opencode_auto_checkbox",
        "opencode_output_scroll",
        "opencode_activity_label",
        "opencode_prompt_scroll",
        "opencode_usage_label",
        "opencode_submit_button",
    }
    assert expected <= set(PANE_CONTROLS["opencode_pane"])
    layout = four_pane_layout(1170, 780)
    # 会話の表示欄がペインの大半を使い、指示欄はその下、送信ボタンは最下段
    assert layout["opencode_output_scroll"].height >= 200
    assert layout["opencode_prompt_scroll"].top <= layout["opencode_activity_label"].y
    assert layout["opencode_activity_label"].top <= layout["opencode_output_scroll"].y
    assert layout["opencode_submit_button"].top <= layout["opencode_prompt_scroll"].y
