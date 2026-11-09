"""
macOS 版ランチャーの、OpenCode ペインの独自スラッシュコマンド（/pass など）の登録画面（NSPanel）。

【仕様】（WPF 版 SlashCommandsWindow と同じ）
- 上の選択欄で登録済みのコマンドを選ぶと、コマンド名・説明・プロンプトの欄へ読み込む。「＋ 新規」で欄を空にする。
- 「保存」は入力をチェック（slash_commands.validate_command）してから、選択中のコマンドの書き換え（名前の変更も可）
  または追加として一覧ごとバックエンドへ保存する。保存は裏スレッドで行い、結果はメインスレッドで表示する。
- 「削除」は確認してから一覧ごと保存する。保存に失敗したら理由を表示し、一覧は変えない。
- ウィンドウレベルはランチャー本体（NSStatusWindowLevel）より上にし、全デスクトップ・フルスクリーン上でも本体の前に出す。
- 「閉じる」（Esc）で閉じる。開いている間はランチャー本体をフォーカス喪失で隠さない（native_mac 側で判定）。
"""

from __future__ import annotations

from collections.abc import Callable
import threading
from typing import Any

import AppKit
import objc
from PyObjCTools import AppHelper

from launcher_app.slash_commands import SlashCommand, normalize_name, validate_command

EDITOR_WIDTH = 600
EDITOR_HEIGHT = 440
# ランチャー本体は NSStatusWindowLevel。登録画面はその 1 つ上、確認ダイアログはさらに 1 つ上にして必ず手前に出す
EDITOR_WINDOW_LEVEL = AppKit.NSStatusWindowLevel + 1
ALERT_WINDOW_LEVEL = EDITOR_WINDOW_LEVEL + 1
NEW_ITEM_TITLE = "＋ 新規"


class SlashCommandEditor(AppKit.NSObject):
    """スラッシュコマンドの登録画面。setup() で一覧と保存処理を受け取り、show() で表示する。"""

    @objc.python_method
    def setup(
        self,
        commands: list[SlashCommand],
        save: Callable[[list[SlashCommand]], list[SlashCommand]],
        on_saved: Callable[[list[SlashCommand]], None],
    ) -> None:
        """一覧・保存処理（裏スレッドで呼ぶ）・保存後の通知（メインスレッド）を受け取り、画面を作る。"""
        self.commands = sorted(commands, key=lambda command: command.name.lower())
        self.save = save
        self.on_saved = on_saved
        self.editing_name: str | None = None
        if getattr(self, "panel", None) is None:
            self._build()
        self._render_list(None)
        self._clear_editor()

    @objc.python_method
    def _build(self) -> None:
        style = AppKit.NSWindowStyleMaskTitled | AppKit.NSWindowStyleMaskClosable | AppKit.NSWindowStyleMaskResizable
        self.panel = AppKit.NSPanel.alloc().initWithContentRect_styleMask_backing_defer_(
            AppKit.NSMakeRect(0, 0, EDITOR_WIDTH, EDITOR_HEIGHT), style, AppKit.NSBackingStoreBuffered, False
        )
        self.panel.setTitle_("スラッシュコマンド")
        # ランチャー本体は NSStatusWindowLevel なので、それより上にしないと登録画面が本体の後ろに隠れる
        self.panel.setLevel_(EDITOR_WINDOW_LEVEL)
        self.panel.setHidesOnDeactivate_(False)
        self.panel.setCollectionBehavior_(
            AppKit.NSWindowCollectionBehaviorCanJoinAllSpaces | AppKit.NSWindowCollectionBehaviorFullScreenAuxiliary
        )
        self.panel.setReleasedWhenClosed_(False)
        content = self.panel.contentView()
        top = EDITOR_HEIGHT - 16

        self.list_popup = AppKit.NSPopUpButton.alloc().initWithFrame_pullsDown_(AppKit.NSMakeRect(16, top - 28, EDITOR_WIDTH - 32, 26), False)
        self.list_popup.setTarget_(self)
        self.list_popup.setAction_("selectCommand:")
        content.addSubview_(self.list_popup)

        content.addSubview_(_label("コマンド名（/ の後ろ。空白と / は使えません）", AppKit.NSMakeRect(16, top - 54, 400, 18)))
        self.name_field = AppKit.NSTextField.alloc().initWithFrame_(AppKit.NSMakeRect(16, top - 80, 220, 24))
        self.name_field.setPlaceholderString_("pass")
        content.addSubview_(self.name_field)

        content.addSubview_(_label("説明（候補に表示）", AppKit.NSMakeRect(16, top - 106, 400, 18)))
        self.description_field = AppKit.NSTextField.alloc().initWithFrame_(AppKit.NSMakeRect(16, top - 132, EDITOR_WIDTH - 32, 24))
        self.description_field.setPlaceholderString_("エクセルからパスワードを取得")
        content.addSubview_(self.description_field)

        content.addSubview_(_label("プロンプト（$ARGUMENTS はコマンドの後ろに打った文字に置き換わります）", AppKit.NSMakeRect(16, top - 158, EDITOR_WIDTH - 32, 18)))
        prompt_height = top - 166 - 96
        scroll = AppKit.NSScrollView.alloc().initWithFrame_(AppKit.NSMakeRect(16, 96, EDITOR_WIDTH - 32, prompt_height))
        scroll.setBorderType_(AppKit.NSBezelBorder)
        scroll.setHasVerticalScroller_(True)
        size = scroll.contentSize()
        self.prompt_view = AppKit.NSTextView.alloc().initWithFrame_(AppKit.NSMakeRect(0, 0, size.width, size.height))
        self.prompt_view.setRichText_(False)
        self.prompt_view.setFont_(AppKit.NSFont.systemFontOfSize_(13))
        self.prompt_view.setAutoresizingMask_(AppKit.NSViewWidthSizable)
        scroll.setDocumentView_(self.prompt_view)
        content.addSubview_(scroll)

        hint = _label(
            "使い方: 指示欄で /pass gmail と打って送信 → $ARGUMENTS が gmail に置き換わったプロンプトを opencode へ送ります。"
            "$ARGUMENTS が無いときは、後ろの文字をプロンプトの末尾に足します。",
            AppKit.NSMakeRect(16, 52, EDITOR_WIDTH - 32, 36),
        )
        hint.setLineBreakMode_(AppKit.NSLineBreakByWordWrapping)
        content.addSubview_(hint)

        self.status_label = _label("", AppKit.NSMakeRect(16, 16, EDITOR_WIDTH - 300, 24))
        content.addSubview_(self.status_label)
        self.delete_button = _button("削除", AppKit.NSMakeRect(EDITOR_WIDTH - 276, 12, 80, 30), self, "deleteCommand:")
        content.addSubview_(self.delete_button)
        self.save_button = _button("保存", AppKit.NSMakeRect(EDITOR_WIDTH - 188, 12, 80, 30), self, "saveCommand:")
        self.save_button.setKeyEquivalent_("\r")
        content.addSubview_(self.save_button)
        close_button = _button("閉じる", AppKit.NSMakeRect(EDITOR_WIDTH - 100, 12, 84, 30), self, "closeEditor:")
        close_button.setKeyEquivalent_("\x1b")
        content.addSubview_(close_button)

    @objc.python_method
    def show(self) -> None:
        self.panel.center()
        AppKit.NSApp.activateIgnoringOtherApps_(True)
        self.panel.makeKeyAndOrderFront_(None)
        self.panel.orderFrontRegardless()
        self.panel.makeFirstResponder_(self.name_field)

    @objc.python_method
    def is_visible(self) -> bool:
        panel = getattr(self, "panel", None)
        return bool(panel is not None and panel.isVisible())

    @objc.python_method
    def _render_list(self, select_name: str | None) -> None:
        """選択欄の先頭は「＋ 新規」、続けて「/名前  説明」を名前順に並べる。"""
        self.list_popup.removeAllItems()
        self.list_popup.addItemWithTitle_(NEW_ITEM_TITLE)
        for command in self.commands:
            title = f"/{command.name}  {command.description}" if command.description else f"/{command.name}"
            self.list_popup.addItemWithTitle_(title)
            self.list_popup.lastItem().setRepresentedObject_(command.name)
        index = next((i + 1 for i, command in enumerate(self.commands) if command.name == select_name), 0)
        self.list_popup.selectItemAtIndex_(index)
        self.delete_button.setEnabled_(index > 0)

    @objc.python_method
    def _clear_editor(self) -> None:
        self.editing_name = None
        self.name_field.setStringValue_("")
        self.description_field.setStringValue_("")
        self.prompt_view.setString_("")
        self.delete_button.setEnabled_(False)

    def selectCommand_(self, sender: Any) -> None:
        """選択欄で選んだコマンドを入力欄へ読み込む（「＋ 新規」なら空にする）。"""
        item = sender.selectedItem()
        name = item.representedObject() if item is not None else None
        command = next((c for c in self.commands if c.name == name), None)
        if command is None:
            self._clear_editor()
            self.status_label.setStringValue_("新しいコマンドを入力して「保存」を押してください")
            self.panel.makeFirstResponder_(self.name_field)
            return
        self.editing_name = command.name
        self.name_field.setStringValue_(command.name)
        self.description_field.setStringValue_(command.description)
        self.prompt_view.setString_(command.prompt)
        self.delete_button.setEnabled_(True)
        self.status_label.setStringValue_("")

    def saveCommand_(self, sender: Any) -> None:
        """入力をチェックし、選択中の書き換えまたは追加として一覧ごと保存する。"""
        name = str(self.name_field.stringValue() or "")
        prompt = str(self.prompt_view.string() or "")
        others = [c for c in self.commands if self.editing_name is None or c.name.lower() != self.editing_name.lower()]
        problem = validate_command(name, prompt, [c.name for c in others])
        if problem:
            self.status_label.setStringValue_(problem)
            return
        command = SlashCommand(normalize_name(name), prompt.strip(), str(self.description_field.stringValue() or "").strip())
        self._save_async([*others, command], select_name=command.name, done=f"/{command.name} を保存しました")

    def deleteCommand_(self, sender: Any) -> None:
        """確認してから、選択中のコマンドを除いた一覧を保存する。"""
        if self.editing_name is None:
            return
        name = self.editing_name
        alert = AppKit.NSAlert.alloc().init()
        alert.setMessageText_(f"/{name} を削除しますか？")
        alert.addButtonWithTitle_("削除")
        alert.addButtonWithTitle_("キャンセル")
        alert.window().setLevel_(ALERT_WINDOW_LEVEL)
        if alert.runModal() != AppKit.NSAlertFirstButtonReturn:
            return
        self._save_async([c for c in self.commands if c.name != name], select_name=None, done=f"/{name} を削除しました")

    def closeEditor_(self, sender: Any) -> None:
        self.panel.orderOut_(None)

    @objc.python_method
    def _save_async(self, commands: list[SlashCommand], *, select_name: str | None, done: str) -> None:
        """裏スレッドで保存し、成功したら一覧を描き直して通知する。失敗したら理由を出して一覧は変えない。"""
        self.save_button.setEnabled_(False)
        self.status_label.setStringValue_("保存しています…")

        def _work() -> None:
            try:
                saved = self.save(commands)
            except Exception as error:  # 通信の失敗は画面に出して続ける
                AppHelper.callAfter(self._finish_save, None, select_name, f"保存できません: {error}")
                return
            AppHelper.callAfter(self._finish_save, saved, select_name, done)

        threading.Thread(target=_work, daemon=True).start()

    @objc.python_method
    def _finish_save(self, saved: list[SlashCommand] | None, select_name: str | None, message: str) -> None:
        self.save_button.setEnabled_(True)
        self.status_label.setStringValue_(message)
        if saved is None:
            return
        self.commands = sorted(saved, key=lambda command: command.name.lower())
        self.on_saved(self.commands)
        self._render_list(select_name)
        if select_name is None:
            self._clear_editor()
        else:
            self.editing_name = select_name


def _label(text: str, frame: Any) -> Any:
    label = AppKit.NSTextField.labelWithString_(text)
    label.setFrame_(frame)
    label.setFont_(AppKit.NSFont.systemFontOfSize_(11))
    label.setTextColor_(AppKit.NSColor.secondaryLabelColor())
    return label


def _button(title: str, frame: Any, target: Any, action: str) -> Any:
    button = AppKit.NSButton.buttonWithTitle_target_action_(title, target, action)
    button.setFrame_(frame)
    button.setBezelStyle_(AppKit.NSBezelStyleRounded)
    return button
