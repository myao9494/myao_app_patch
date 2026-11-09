"""
macOS ランチャーの「コマンド」登録画面が、ランチャー本体の前に出ることを検証する。
（ランチャー本体は NSStatusWindowLevel で常に手前に出るため、登録画面はそれより上でないと後ろに隠れる）
"""

import pytest

pytest.importorskip("AppKit")

import AppKit

from launcher_app.slash_commands import SlashCommand
from launcher_app.ui.mac_slash_editor import SlashCommandEditor


def _editor() -> SlashCommandEditor:
    editor = SlashCommandEditor.alloc().init()
    editor.setup([SlashCommand("pass", "p", "d")], lambda commands: commands, lambda commands: None)
    return editor


def test_editor_window_level_is_above_launcher_panel() -> None:
    """登録画面のウィンドウレベルは、ランチャー本体（NSStatusWindowLevel）より上。"""
    assert _editor().panel.level() > AppKit.NSStatusWindowLevel


def test_editor_follows_launcher_across_spaces() -> None:
    """ランチャー本体と同じく、全デスクトップ・フルスクリーン上でも表示でき、他アプリが前面でも隠れない。"""
    editor = _editor()
    behavior = editor.panel.collectionBehavior()

    assert behavior & AppKit.NSWindowCollectionBehaviorCanJoinAllSpaces
    assert behavior & AppKit.NSWindowCollectionBehaviorFullScreenAuxiliary
    assert editor.panel.hidesOnDeactivate() is False


def test_delete_confirmation_alert_level_is_above_editor() -> None:
    """削除の確認ダイアログは登録画面より上のレベルで出す（でないと登録画面の後ろに隠れて操作できない）。"""
    from launcher_app.ui import mac_slash_editor

    assert mac_slash_editor.ALERT_WINDOW_LEVEL > _editor().panel.level()
