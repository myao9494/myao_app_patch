"""
macOS Spaces 上でも現在のデスクトップへ表示できる Cocoa ネイティブランチャーを提供する（1ページ4ペイン版）。

【仕様】
- 1170×780 のパネルを 2×2 に分け、左上=検索、右上=OpenCode CLI、左下=常時保持メモ、右下=gantt メモを同時に表示する。
  配置は AppKit に依存しない `ui/mac_layout.py` で計算する。画面の切り替えはない。
- Tab / Shift+Tab の巡回順と Enter の動作は `ui/four_pane.py` に従う。複数行の入力欄の Enter は改行、
  Cmd / Ctrl + Enter か送信ボタン上の Return で送信する。
- Escape はどのペインからでも、未保存の常時保持メモを保存してからパネルを隠す。再表示時は検索欄へフォーカスする。
- 常時保持メモは入力のたびにメモ専用 API へデバウンス保存する（`ScratchpadAutosave`）。
- opencode の実行と共有設定の再取得は裏スレッドで行い、画面の更新は AppHelper.callAfter でメインスレッドへ戻す。
- OpenCode ペインは Claudian 風のチャット（`ui/opencode_view.py` の描画を NSTextView へ流し込む）。
  指示欄は Enter で送信・Shift+Enter で改行・↑↓で過去の指示。実行中の送信は待ち行列へ入り、送信ボタンは「停止」になる。
  見出し行に会話履歴（再開）と新規、ツールバーにモデル・Plan・自動承認、下端に作業状況と使用量を出す。
- スラッシュコマンド（このアプリ独自の定型作業）: 「コマンド」で登録画面（mac_slash_editor.py）を開く。
  指示欄の / の語の中で Tab を押すと、候補が 1 つならすぐ補完、複数なら macOS 標準の補完一覧（↑↓で選択・Return で確定・Esc で閉じる）を出す。
  登録画面を開いている間は、フォーカスを失ってもランチャーを隠さない。
- ホットキーは Command + Option、または Shift の 2 回押し（`DoubleShiftDetector`、400ms 以内）。
  押下中の誤再トリガーを防ぐため hotkey_activated はキー解放時のみリセットし、toggle_panel() に 350ms のクールダウンを設ける。
"""

from __future__ import annotations

import platform
import threading
import time
from typing import Any
import webbrowser

import AppKit
import objc
try:
    import Quartz
except ImportError:  # pragma: no cover - macOS 以外のテスト環境向け
    Quartz = None
from PyObjCTools import AppHelper

from launcher_app.api.client import LauncherApiClient
from launcher_app.config import LauncherConfig
from launcher_app.file_icons import catppuccin_icon_path
from launcher_app.gantt_task import build_gantt_task_payload, normalize_parent_id
from launcher_app.models import SearchResultItem
from launcher_app.opencode_chat import format_relative_time
from launcher_app.opencode_runner import OpenCodeError, OpenCodeSession, resolve_opencode_executable, warm_up_opencode_service
from launcher_app.slash_commands import SlashCommand, apply_completion, completion_words, find_candidates, slash_query
from launcher_app.scratchpad import ScratchpadAutosave
from launcher_app.services.hotkeys import DoubleShiftDetector, hotkey_spec_for_platform
from launcher_app.ui.four_pane import BUTTON_STOPS, enter_action, next_focus_stop
from launcher_app.ui.mac_slash_editor import SlashCommandEditor
from launcher_app.ui.opencode_view import render_chat
from launcher_app.ui.mac_layout import (
    RESULT_CARD_HEIGHT,
    RESULT_CARD_SPACING,
    Rect,
    four_pane_layout,
    result_card_layout,
)
from launcher_app.ui.urls import (
    folder_path_for_item,
    folder_web_url_for_item,
    full_path_web_url,
    primary_web_url_for_item,
    open_with_system_file_launcher,
    uses_system_file_launcher,
)
from launcher_app.utils import strip_html


PANEL_WIDTH = 1170
PANEL_HEIGHT = 780
HOTKEY_WATCHDOG_INTERVAL_SECONDS = 0.08
NEWLINE_SELECTORS = frozenset({"insertNewline:", "insertLineBreak:", "insertNewlineIgnoringFieldEditor:"})
TEXT_COLOR = (0.9, 0.94, 1.0, 1.0)
MUTED_TEXT_COLOR = (0.58, 0.64, 0.73, 1.0)
PANE_BACKGROUND_COLOR = (0.07, 0.09, 0.15, 1.0)
INPUT_BACKGROUND_COLOR = (0.11, 0.14, 0.2, 1.0)
_delegate_ref: Any | None = None

class FlippedView(AppKit.NSView):
    def isFlipped(self) -> bool:
        return True


class LauncherPanel(AppKit.NSPanel):
    """
    ボーダーレスでも検索フィールドへキー入力できるランチャー用パネル。
    """

    def canBecomeKeyWindow(self) -> bool:
        """
        NSSearchField が入力フォーカスを受け取れるようにする。
        """
        return True

    def canBecomeMainWindow(self) -> bool:
        """
        アプリを前面化したときにメインウィンドウとして扱えるようにする。
        """
        return True

    def keyDown_(self, event: Any) -> None:
        """
        Escape はどのペインからでもパネルを隠す。ボタン上の Return はそのボタンの操作、Tab / Shift+Tab は巡回順で移動する。
        それ以外のキーは標準の処理に任せる。
        """
        chars = event.characters()
        key_code = getattr(event, "keyCode", None)
        is_escape = (key_code() == 53 if callable(key_code) else key_code == 53) or chars == "\x1b"
        delegate = self.delegate()
        if delegate is not None:
            if is_escape:
                delegate.hide_panel()
                return
            stop_name = delegate._focus_stop_name(self.firstResponder())
            if stop_name in BUTTON_STOPS:
                if chars in ("\t", "\x19"):
                    delegate._move_focus_from(stop_name, chars == "\x19")
                    return
                if chars in ("\r", "\n", "\x03"):
                    delegate._run_enter_action(enter_action(stop_name, submit_modifier=False))
                    return
        objc.super(LauncherPanel, self).keyDown_(event)

    def performKeyEquivalent_(self, event: Any) -> bool:
        """
        Cmd + Return を、フォーカスのあるペインの送信（OpenCode / gantt）として扱う。
        """
        is_return = event.keyCode() in (36, 76)
        has_command = bool(event.modifierFlags() & AppKit.NSEventModifierFlagCommand)
        delegate = self.delegate()
        if is_return and has_command and delegate is not None:
            action = enter_action(delegate._focus_stop_name(self.firstResponder()), submit_modifier=True)
            if action != "newline":
                delegate._run_enter_action(action)
                return True
        return bool(objc.super(LauncherPanel, self).performKeyEquivalent_(event))


class LauncherDelegate(AppKit.NSObject):
    """
    Cocoa パネルの入力・検索・ホットキー処理をまとめる。
    """

    def initWithClient_config_(self, client: LauncherApiClient, config: LauncherConfig) -> "LauncherDelegate":
        self = objc.super(LauncherDelegate, self).init()
        if self is None:
            return self
        self.client = client
        self.config = config
        self.web_base_url = config.web_base_url
        self.results: list[SearchResultItem] = []
        self.selected_index = 0
        self.search_sequence = 0
        self.search_timer: threading.Timer | None = None
        self.hotkey_monitors: list[Any] = []
        self.hotkey_event_tap = None
        self.hotkey_event_tap_location = None
        self.hotkey_event_tap_source = None
        self.hotkey_event_tap_callback = None
        self.hotkey_watchdog_timer = None
        self.power_notification_center = None
        self.power_notifications_registered = False
        self.activity_token = None
        self.hotkey_activated = False
        self.hotkey_mode = "command_option"
        self.double_shift = DoubleShiftDetector(window_seconds=0.4)
        self.panel = None
        self.search_field = None
        self.extension_filter = None
        self.search_type_segmented = None
        self.search_type = "hybrid"
        self.status_label = None
        self.results_stack = None
        # パネル構築前に作る結果カードも、検索ペインの幅に合わせる
        self.results_card_width = four_pane_layout(PANEL_WIDTH, PANEL_HEIGHT)["results_scroll"].width - 18
        self.gui_button = None
        self.gantt_checkbox = None
        self.path_in_filename_checkbox = None
        self.search_scroll = None
        self.memo_scroll = None
        self.memo_parent_label = None
        self.memo_title_label = None
        self.memo_title_field = None
        self.memo_body_view = None
        self.memo_status_label = None
        self.memo_submit_button = None
        self.memo_cancel_button = None
        self.content_view = None
        self.gantt_parent = config.gantt_parent
        self.opencode_working_dir = ""
        self.opencode_session = OpenCodeSession()
        self.opencode_generation = 0
        self.opencode_timer = None
        self.opencode_models_loaded = False
        self.opencode_dir_label = None
        self.opencode_activity_label = None
        self.opencode_usage_label = None
        self.opencode_history_popup = None
        self.opencode_model_popup = None
        self.opencode_plan_checkbox = None
        self.opencode_auto_checkbox = None
        self.opencode_prompt_view = None
        self.opencode_output_view = None
        self.opencode_submit_button = None
        self.opencode_new_chat_button = None
        self.opencode_commands_button = None
        self.opencode_menu_button = None
        self.slash_editor = None
        self.scratchpad_view = None
        self.scratchpad_status_label = None
        self.autosave = ScratchpadAutosave(
            # 保存するときにクライアントのメソッドを引く（起動時はメモ保存 API を使わない）
            lambda memo: self.client.save_launcher_memo(memo),
            on_status=lambda status: AppHelper.callAfter(self._show_scratchpad_status, status),
        )
        self.include_gantt_tasks = False
        self.include_path_in_filename = True
        self.last_results_time = 0.0
        self.last_toggle_time = 0.0
        try:
            app_settings = client.get_app_settings()
        except Exception:  # バックエンド未起動でもランチャーは起動する
            app_settings = {}
        self.hotkey_mode = str(app_settings.get("launcher_hotkey", "command_option"))
        self._apply_shared_state(app_settings)
        self._load_slash_commands()
        return self

    def applicationDidFinishLaunching_(self, notification: Any) -> None:
        """
        アプリ起動時に Spaces 対応パネルを構築し、ホットキー監視を開始する。
        """
        if self.panel is not None:
            return
        self._begin_activity()
        self._build_panel()
        self._start_hotkey_monitor()
        self._start_power_state_monitor()
        self.status_label.setStringValue_(f"Hotkey: {hotkey_spec_for_platform(mode=self.hotkey_mode)}")
        threading.Thread(target=self._warm_up_opencode, daemon=True).start()
        self.show_panel()

    def controlTextDidChange_(self, notification: Any) -> None:
        """
        検索語・拡張子の変更をデバウンスしてバックエンド検索を実行する。
        gantt のタスク名欄など、検索に関係しない入力欄の変更では検索しない。
        """
        if notification is not None and notification.object() not in (self.search_field, self.extension_filter):
            return
        if self.search_timer is not None:
            self.search_timer.cancel()
        query = str(self.search_field.stringValue()).strip()
        self.search_sequence += 1
        sequence = self.search_sequence
        
        # 検索入力中・通信中はEnterキーを無効化する
        self.last_results_time = float('inf')
        
        if not query:
            self.results = []
            self.status_label.setStringValue_(f"Hotkey: {hotkey_spec_for_platform(mode=self.hotkey_mode)}")
            self.last_results_time = time.time()
            self._render_results()
            return
        self.status_label.setStringValue_("検索中...")
        self.search_timer = threading.Timer(0.18, lambda: self._search(query, sequence))
        self.search_timer.daemon = True
        self.search_timer.start()

    def control_textView_doCommandBySelector_(self, control: Any, textView: Any, commandSelector: Any) -> bool:
        """
        1 行の入力欄（検索欄・拡張子欄・gantt タスク名）の上下キー・Enter・Escape・Tab を処理する。
        """
        selector = str(commandSelector)
        stop_name = self._focus_stop_name(control)
        if not stop_name:
            return False
        if control == self.search_field and selector in ("moveUp:", "moveDown:"):
            self._move_selection(-1 if selector == "moveUp:" else 1)
            return True
        return self._handle_text_command(stop_name, selector, textView, multiline=False)

    def textView_doCommandBySelector_(self, textView: Any, commandSelector: Any) -> bool:
        """
        複数行の入力欄（gantt 本文・常時保持メモ・OpenCode 入力）の Tab / Shift+Tab / Return / Escape を処理する。
        """
        stop_name = self._focus_stop_name(textView)
        if not stop_name:
            return False
        return self._handle_text_command(stop_name, str(commandSelector), textView, multiline=True)

    @objc.python_method
    def _handle_text_command(self, stop_name: str, selector: str, text_view: Any, *, multiline: bool) -> bool:
        """入力欄のコマンドを 4 ペイン共通の規則で処理し、処理したら True を返す。"""
        if selector == "cancelOperation:":
            self.hide_panel()
            return True
        if stop_name == "opencode_prompt" and selector == "insertTab:" and self._complete_slash(text_view):
            return True
        if selector in ("insertTab:", "insertBacktab:"):
            self._move_focus_from(stop_name, selector == "insertBacktab:")
            return True
        if stop_name == "opencode_prompt" and selector in ("moveUp:", "moveDown:"):
            return self._recall_opencode_history(selector)
        if selector in NEWLINE_SELECTORS:
            action = enter_action(
                stop_name,
                submit_modifier=self._current_event_has_submit_modifier(),
                shift=self._current_event_has_shift(),
            )
            if action == "newline":
                if multiline:
                    text_view.insertText_("\n")
                return True
            self._run_enter_action(action)
            return True
        return False

    @objc.python_method
    def _current_event_has_submit_modifier(self) -> bool:
        """処理中のキーイベントに Command か Control が付いているか。"""
        event = AppKit.NSApp.currentEvent()
        if event is None:
            return False
        flags = event.modifierFlags()
        return bool(flags & (AppKit.NSEventModifierFlagCommand | AppKit.NSEventModifierFlagControl))

    @objc.python_method
    def _current_event_has_shift(self) -> bool:
        """処理中のキーイベントに Shift が付いているか（OpenCode 指示欄の Shift+Enter 改行）。"""
        event = AppKit.NSApp.currentEvent()
        return event is not None and bool(event.modifierFlags() & AppKit.NSEventModifierFlagShift)

    def textDidChange_(self, notification: Any) -> None:
        """常時保持メモの入力を記録し、デバウンスして保存する。"""
        if notification.object() == self.scratchpad_view:
            self.autosave.update(str(self.scratchpad_view.string() or ""))

    @objc.python_method
    def _focus_views(self) -> dict[str, Any]:
        """フォーカス位置の名前と Cocoa のビューの対応。"""
        return {
            "query": self.search_field,
            "extension": self.extension_filter,
            "opencode_prompt": self.opencode_prompt_view,
            "opencode_submit": self.opencode_submit_button,
            "opencode_new_chat": self.opencode_new_chat_button,
            "scratchpad": self.scratchpad_view,
            "memo_title": self.memo_title_field,
            "memo_body": self.memo_body_view,
            "memo_submit": self.memo_submit_button,
            "memo_cancel": self.memo_cancel_button,
        }

    @objc.python_method
    def _focus_stop_name(self, responder: Any) -> str:
        """
        first responder（1 行の入力欄では入力中のフィールドエディタ）から、フォーカス位置の名前を返す。
        """
        candidates = [responder]
        delegate_getter = getattr(responder, "delegate", None)
        if callable(delegate_getter):
            candidates.append(delegate_getter())
        for name, view in self._focus_views().items():
            if view is not None and any(candidate is view for candidate in candidates):
                return name
        return ""

    @objc.python_method
    def _move_focus_from(self, stop_name: str, backward: bool) -> None:
        """4 ペインの巡回順で次（backward なら前）の入力へフォーカスを移す。"""
        target = self._focus_views()[next_focus_stop(stop_name, backward=bool(backward))]
        self.panel.makeFirstResponder_(target)

    @objc.python_method
    def _run_enter_action(self, action: str) -> None:
        """`enter_action` が決めた動作を実行する。"""
        if action == "submit_opencode":
            # 送信ボタン上の Return はボタンと同じ（実行中は停止）、指示欄の Enter は送信（実行中は待ち行列）
            if self._focus_stop_name(self.panel.firstResponder()) == "opencode_submit":
                self._press_opencode_button()
            else:
                self._submit_opencode()
        elif action == "reset_opencode":
            self._reset_opencode()
        elif action == "submit_memo":
            self._submit_memo()
        elif action == "clear_memo":
            self._clear_memo()
        elif action == "open_result":
            self._open_selected()
        elif action == "reveal_result" and self.results:
            self._reveal_item(self.results[self.selected_index])

    @objc.python_method
    def _move_selection(self, delta: int) -> None:
        """
        検索結果の選択位置を上下に移動し、必要に応じてスクロールする。
        """
        if not self.results:
            return
            
        scroll_view = self.results_stack.enclosingScrollView()
        saved_y = scroll_view.documentVisibleRect().origin.y if scroll_view else 0

        old_index = self.selected_index
        self.selected_index = (self.selected_index + delta) % len(self.results)
        self._update_card_selection(old_index, self.selected_index)
        
        if scroll_view:
            clip_view = scroll_view.contentView()
            clip_view.setBoundsOrigin_(AppKit.NSMakePoint(0, saved_y))
            
        self._scroll_to_selected()

    @objc.python_method
    def _open_selected(self) -> None:
        """
        現在選択中のアイテムを開く。
        """
        if time.time() - getattr(self, "last_results_time", 0.0) < 0.5:
            return
        if not self.results:
            return
        item = self.results[self.selected_index]
        self._open_item(item)

    @objc.python_method
    def _scroll_to_selected(self) -> None:
        if not self.results:
            return
        card_height = RESULT_CARD_HEIGHT
        spacing = RESULT_CARD_SPACING
        y = self.selected_index * (card_height + spacing)
        
        scroll_view = self.results_stack.enclosingScrollView()
        if not scroll_view:
            return
            
        visible_rect = scroll_view.documentVisibleRect()
        current_top = visible_rect.origin.y
        current_bottom = current_top + visible_rect.size.height
        
        top_edge = y
        bottom_edge = y + card_height
        
        new_y = current_top
        
        if top_edge < current_top:
            # 上にはみ出た場合: 対象の上端に合わせる
            new_y = top_edge - spacing
        elif bottom_edge > current_bottom:
            # 下にはみ出た場合: 次のカードが少し見えるように余分にスクロールする
            new_y = bottom_edge - visible_rect.size.height + spacing + (card_height * 0.6)
            
        new_y = max(0, new_y)
        
        # documentViewの最大スクロール位置を超えないようにする
        max_y = max(0, self.results_stack.frame().size.height - visible_rect.size.height)
        new_y = min(new_y, max_y)
        
        clip_view = scroll_view.contentView()
        clip_view.setBoundsOrigin_(AppKit.NSMakePoint(0, new_y))
        scroll_view.reflectScrolledClipView_(clip_view)

    def toggle_panel(self) -> None:
        """
        パネルの表示・非表示を切り替える。
        チャタリングや重複イベントによる即座の再表示（点滅）を防ぐため、最小クールダウン（350ms）を設ける。
        """
        now = time.monotonic()
        if now - getattr(self, "last_toggle_time", 0.0) < 0.35:
            return
        self.last_toggle_time = now
        if self.panel.isVisible():
            self.hide_panel()
        else:
            self.show_panel()

    @objc.python_method
    def _start_hotkey_monitor(self) -> None:
        """
        セッション全体の入力イベント監視で Command + Option を検出する。
        既に登録済みの場合は二重登録しない。
        """
        if self.hotkey_monitors or self.hotkey_event_tap is not None:
            return
        self._start_hotkey_event_tap()
        self._start_hotkey_watchdog()
        mask = AppKit.NSEventMaskFlagsChanged

        def handler(event: Any) -> Any:
            self._handle_modifier_event(event)
            return event

        global_monitor = AppKit.NSEvent.addGlobalMonitorForEventsMatchingMask_handler_(mask, handler)
        local_monitor = AppKit.NSEvent.addLocalMonitorForEventsMatchingMask_handler_(mask, handler)
        self.hotkey_monitors = [monitor for monitor in (global_monitor, local_monitor) if monitor is not None]

    @objc.python_method
    def _start_hotkey_event_tap(self) -> None:
        """
        アプリに依存しにくい CGEventTap で修飾キー変更を監視する。
        """
        if Quartz is None or self.hotkey_event_tap is not None:
            return

        def callback(proxy: Any, event_type: int, event: Any, refcon: Any) -> Any:
            if event_type == Quartz.kCGEventTapDisabledByTimeout:
                Quartz.CGEventTapEnable(self.hotkey_event_tap, True)
                return event
            if event_type == Quartz.kCGEventFlagsChanged:
                self._handle_modifier_flags(Quartz.CGEventGetFlags(event))
            return event

        event_mask = Quartz.CGEventMaskBit(Quartz.kCGEventFlagsChanged)
        event_tap = None
        event_tap_location = None
        for location in (Quartz.kCGHIDEventTap, Quartz.kCGSessionEventTap):
            event_tap = Quartz.CGEventTapCreate(
                location,
                Quartz.kCGHeadInsertEventTap,
                Quartz.kCGEventTapOptionListenOnly,
                event_mask,
                callback,
                None,
            )
            if event_tap is not None:
                event_tap_location = location
                break
        if event_tap is None:
            return
        source = Quartz.CFMachPortCreateRunLoopSource(None, event_tap, 0)
        Quartz.CFRunLoopAddSource(Quartz.CFRunLoopGetCurrent(), source, Quartz.kCFRunLoopCommonModes)
        Quartz.CGEventTapEnable(event_tap, True)
        self.hotkey_event_tap = event_tap
        self.hotkey_event_tap_location = event_tap_location
        self.hotkey_event_tap_source = source
        self.hotkey_event_tap_callback = callback

    @objc.python_method
    def _start_hotkey_watchdog(self) -> None:
        """
        event tap の取りこぼしに備え、現在の修飾キー状態を定期確認する。
        """
        if self.hotkey_watchdog_timer is not None:
            return
        timer = AppKit.NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            HOTKEY_WATCHDOG_INTERVAL_SECONDS,
            self,
            "pollHotkeyState:",
            None,
            True,
        )
        AppKit.NSRunLoop.currentRunLoop().addTimer_forMode_(timer, AppKit.NSRunLoopCommonModes)
        self.hotkey_watchdog_timer = timer

    @objc.python_method
    def _stop_hotkey_watchdog(self) -> None:
        """
        修飾キー状態の定期確認タイマーを停止する。
        """
        if self.hotkey_watchdog_timer is None:
            return
        self.hotkey_watchdog_timer.invalidate()
        self.hotkey_watchdog_timer = None

    def pollHotkeyState_(self, timer: Any) -> None:
        """
        前面アプリがイベントを握る場合でも現在の Command + Option 状態を読む。
        """
        if Quartz is None:
            return
        if self.hotkey_event_tap is not None:
            Quartz.CGEventTapEnable(self.hotkey_event_tap, True)
        flags = Quartz.CGEventSourceFlagsState(Quartz.kCGEventSourceStateCombinedSessionState)
        self._handle_modifier_flags(flags)

    @objc.python_method
    def _stop_hotkey_monitor(self) -> None:
        """
        登録済みの入力イベント監視を解除する。
        """
        self._stop_hotkey_watchdog()
        for monitor in self.hotkey_monitors:
            AppKit.NSEvent.removeMonitor_(monitor)
        self.hotkey_monitors = []
        if Quartz is not None and self.hotkey_event_tap is not None:
            if self.hotkey_event_tap_source is not None:
                Quartz.CFRunLoopRemoveSource(
                    Quartz.CFRunLoopGetCurrent(),
                    self.hotkey_event_tap_source,
                    Quartz.kCFRunLoopCommonModes,
                )
            Quartz.CFMachPortInvalidate(self.hotkey_event_tap)
        self.hotkey_event_tap = None
        self.hotkey_event_tap_location = None
        self.hotkey_event_tap_source = None
        self.hotkey_event_tap_callback = None
        self.hotkey_activated = False

    @objc.python_method
    def _restart_hotkey_monitor(self) -> None:
        """
        スリープ復帰後に失効することがあるホットキー監視を張り直す。
        """
        self._stop_hotkey_monitor()
        self._start_hotkey_monitor()

    @objc.python_method
    def _start_power_state_monitor(self) -> None:
        """
        macOS のスリープ/復帰通知を監視し、復帰時にホットキーを再登録する。
        """
        if self.power_notifications_registered:
            return
        notification_center = AppKit.NSWorkspace.sharedWorkspace().notificationCenter()
        notification_center.addObserver_selector_name_object_(
            self,
            "workspaceWillSleep:",
            AppKit.NSWorkspaceWillSleepNotification,
            None,
        )
        notification_center.addObserver_selector_name_object_(
            self,
            "workspaceDidWake:",
            AppKit.NSWorkspaceDidWakeNotification,
            None,
        )
        self.power_notification_center = notification_center
        self.power_notifications_registered = True

    def workspaceWillSleep_(self, notification: Any) -> None:
        """
        スリープ直前に修飾キーの押下状態をクリアする。
        """
        self.hotkey_activated = False

    def workspaceDidWake_(self, notification: Any) -> None:
        """
        スリープ復帰後にグローバルホットキー監視を再登録する。
        """
        self._restart_hotkey_monitor()

    @objc.python_method
    def _handle_modifier_event(self, event: Any) -> None:
        """
        Command + Option が揃った瞬間にだけ表示状態を切り替える。
        """
        self._handle_modifier_flags(event.modifierFlags())

    @objc.python_method
    def _handle_modifier_flags(self, flags: int) -> None:
        """
        修飾キーの bit flag から Command + Option の押下状態を判定する。
        """
        if self.hotkey_mode == "double_shift":
            if self.double_shift.update(bool(flags & AppKit.NSEventModifierFlagShift), now=time.monotonic()):
                AppHelper.callAfter(self.toggle_panel)
            return
        required = AppKit.NSEventModifierFlagCommand | AppKit.NSEventModifierFlagOption
        active = (flags & required) == required
        if active and not self.hotkey_activated:
            self.hotkey_activated = True
            AppHelper.callAfter(self.toggle_panel)
        elif not active:
            self.hotkey_activated = False

    @objc.python_method
    def _panel_collection_behavior(self) -> int:
        """
        仮想デスクトップやフルスクリーン上でも表示するための挙動を返す。
        """
        return (
            AppKit.NSWindowCollectionBehaviorCanJoinAllSpaces
            | AppKit.NSWindowCollectionBehaviorFullScreenAuxiliary
            | AppKit.NSWindowCollectionBehaviorStationary
            | getattr(AppKit, "NSWindowCollectionBehaviorTransient", 0)
        )

    @objc.python_method
    def _prepare_panel_for_active_space(self) -> None:
        """
        時間経過後も現在の仮想デスクトップへ出るように表示属性を張り直す。
        """
        self.panel.setCollectionBehavior_(self._panel_collection_behavior())
        self.panel.setLevel_(AppKit.NSStatusWindowLevel)
        self.panel.setHidesOnDeactivate_(False)
        if self.panel.isMiniaturized():
            self.panel.deminiaturize_(None)

    @objc.python_method
    def _begin_activity(self) -> None:
        """
        常駐ランチャーが App Nap で眠らないように activity token を保持する。
        """
        if self.activity_token is not None:
            return
        process_info = AppKit.NSProcessInfo.processInfo()
        options = (
            getattr(AppKit, "NSActivityUserInitiatedAllowingIdleSystemSleep", 0)
            | getattr(AppKit, "NSActivityLatencyCritical", 0)
        )
        self.activity_token = process_info.beginActivityWithOptions_reason_(
            options,
            "Local Fulltext Search launcher hotkey monitor",
        )

    @objc.python_method
    def show_panel(self) -> None:
        """
        現在の仮想デスクトップ上にパネルを表示する。
        """
        self._prepare_panel_for_active_space()
        self.panel.orderOut_(None)
        self._center_panel_on_mouse_screen()
        self.panel.setAlphaValue_(1.0)
        AppKit.NSApp.activateIgnoringOtherApps_(True)
        self.panel.makeKeyWindow()
        self.panel.makeKeyAndOrderFront_(None)
        self.panel.orderFrontRegardless()
        self.panel.makeFirstResponder_(self.search_field)
        self._refresh_shared_settings_async()
        self._refresh_opencode_history_async()
        self._load_opencode_models_async()

    @objc.python_method
    def hide_panel(self) -> None:
        """
        未保存の常時保持メモを保存してから、セッションを維持したままパネルを閉じる。
        キー押下中の再トリガーを防ぐため、hotkey_activated はキー解放時のみリセットされる。
        """
        self.autosave.flush()
        if self.panel is not None:
            self.panel.orderOut_(None)

    def windowDidResignKey_(self, notification: Any) -> None:
        """
        フォーカス喪失時にパネルを自動で隠す。
        """
        if self.slash_editor is not None and self.slash_editor.is_visible():
            # スラッシュコマンドの登録画面を開いている間は隠さない
            return
        if self.panel is not None and self.panel.isVisible():
            self.hide_panel()

    @objc.python_method
    def _build_panel(self) -> None:
        """
        2×2 の 4 ペイン（検索・OpenCode・常時保持メモ・gantt）を持つパネルを構築する。
        各コントロールの位置は `mac_layout.four_pane_layout` で計算する。
        """
        style = (
            AppKit.NSWindowStyleMaskBorderless
            | AppKit.NSWindowStyleMaskFullSizeContentView
        )
        self.panel = LauncherPanel.alloc().initWithContentRect_styleMask_backing_defer_(
            AppKit.NSMakeRect(0, 0, PANEL_WIDTH, PANEL_HEIGHT),
            style,
            AppKit.NSBackingStoreBuffered,
            False,
        )
        self.panel.setLevel_(AppKit.NSFloatingWindowLevel)
        self.panel.setDelegate_(self)
        # 背後の画面が入力欄へ透けないよう、パネル自体を不透明にする。
        self.panel.setOpaque_(True)
        self.panel.setBackgroundColor_(AppKit.NSColor.colorWithCalibratedRed_green_blue_alpha_(0.06, 0.09, 0.16, 1.0))
        self.panel.setHidesOnDeactivate_(False)
        self.panel.setMovableByWindowBackground_(True)
        self.panel.setCollectionBehavior_(self._panel_collection_behavior())

        content = AppKit.NSView.alloc().initWithFrame_(AppKit.NSMakeRect(0, 0, PANEL_WIDTH, PANEL_HEIGHT))
        content.setWantsLayer_(True)
        content.layer().setCornerRadius_(24)
        content.layer().setBackgroundColor_(AppKit.NSColor.colorWithCalibratedRed_green_blue_alpha_(0.06, 0.09, 0.16, 1.0).CGColor())
        content.layer().setBorderColor_(AppKit.NSColor.colorWithCalibratedRed_green_blue_alpha_(0.22, 0.48, 1.0, 0.9).CGColor())
        content.layer().setBorderWidth_(1.0)
        self.panel.setContentView_(content)
        self.content_view = content
        layout = four_pane_layout(PANEL_WIDTH, PANEL_HEIGHT)

        # ペインの背景（先に追加して入力欄の背後に置く）
        for pane_name in ("search_pane", "opencode_pane", "scratchpad_pane", "gantt_pane"):
            pane = AppKit.NSView.alloc().initWithFrame_(_ns_rect(layout[pane_name]))
            pane.setWantsLayer_(True)
            pane.layer().setCornerRadius_(12)
            pane.layer().setBackgroundColor_(_color(PANE_BACKGROUND_COLOR).CGColor())
            pane.layer().setBorderColor_(_color((0.12, 0.16, 0.22, 1.0)).CGColor())
            pane.layer().setBorderWidth_(1.0)
            content.addSubview_(pane)

        self._build_search_pane(content, layout)
        self._build_opencode_pane(content, layout)
        self._build_scratchpad_pane(content, layout)
        self._build_gantt_pane(content, layout)

        self.status_label = _label(f"Hotkey: {hotkey_spec_for_platform(mode=self.hotkey_mode)}", layout["status_label"], size=12, color=MUTED_TEXT_COLOR, bold=True)
        content.addSubview_(self.status_label)

        # Cocoa 標準のフォーカス移動チェーン（Tab の既定動作）も 4 ペインの巡回順にそろえる
        views = self._focus_views()
        for name, view in views.items():
            following = views[next_focus_stop(name, backward=False)]
            if view is not None and following is not None:
                view.setNextKeyView_(following)
        self._render_shared_settings()

    @objc.python_method
    def _build_search_pane(self, content: Any, layout: dict[str, Rect]) -> None:
        """左上: 検索欄・拡張子欄・検索方式・Web GUI・絞り込み・結果一覧。"""
        self.search_field = AppKit.NSSearchField.alloc().initWithFrame_(_ns_rect(layout["search_field"]))
        self.search_field.setDelegate_(self)
        self.search_field.setPlaceholderString_("検索語を入力")
        self.search_field.setToolTip_("検索語を入力（例: keyword, -.png で除外）")
        self.search_field.setFont_(AppKit.NSFont.systemFontOfSize_weight_(17, AppKit.NSFontWeightRegular))
        self.search_field.setTextColor_(_color(TEXT_COLOR))
        self.search_field.setDrawsBackground_(False)
        content.addSubview_(self.search_field)

        self.extension_filter = AppKit.NSTextField.alloc().initWithFrame_(_ns_rect(layout["extension_filter"]))
        self.extension_filter.setDelegate_(self)
        self.extension_filter.setPlaceholderString_(".md, -png")
        self.extension_filter.setToolTip_("拡張子（例: .md, -png）")
        self.extension_filter.setFont_(AppKit.NSFont.systemFontOfSize_(14))
        self.extension_filter.setTextColor_(_color(TEXT_COLOR))
        self.extension_filter.setDrawsBackground_(False)
        content.addSubview_(self.extension_filter)

        # 検索方式切替セグメントコントロール（🔀 ハイブリッド / 🔮 ベクトル / 🏷️ 通常）
        self.search_type_segmented = AppKit.NSSegmentedControl.alloc().initWithFrame_(_ns_rect(layout["search_type_segmented"]))
        self.search_type_segmented.setSegmentCount_(3)
        self.search_type_segmented.setLabel_forSegment_("🔀 ハイブリッド", 0)
        self.search_type_segmented.setLabel_forSegment_("🔮 ベクトル", 1)
        self.search_type_segmented.setLabel_forSegment_("🏷️ 通常", 2)
        self.search_type_segmented.setSelectedSegment_(0)
        self.search_type_segmented.setTarget_(self)
        self.search_type_segmented.setAction_("changeSearchType:")
        content.addSubview_(self.search_type_segmented)

        self.gui_button = AppKit.NSButton.buttonWithTitle_target_action_("Web GUI", self, "openGuiUrl:")
        self.gui_button.setFrame_(_ns_rect(layout["gui_button"]))
        self.gui_button.setBezelStyle_(AppKit.NSBezelStyleRounded)
        content.addSubview_(self.gui_button)

        self.gantt_checkbox = AppKit.NSButton.checkboxWithTitle_target_action_("gantt", self, "toggleGanttSearch:")
        self.gantt_checkbox.setFrame_(_ns_rect(layout["gantt_checkbox"]))
        content.addSubview_(self.gantt_checkbox)

        # ファイル名検索でフォルダ名も対象にする（既定オン）
        self.path_in_filename_checkbox = AppKit.NSButton.checkboxWithTitle_target_action_(
            "フォルダ名も対象", self, "togglePathInFilename:"
        )
        self.path_in_filename_checkbox.setFrame_(_ns_rect(layout["path_in_filename_checkbox"]))
        self.path_in_filename_checkbox.setState_(AppKit.NSControlStateValueOn)
        self.path_in_filename_checkbox.setToolTip_("ファイル名検索でフォルダ名も対象にする（例: 「人事 top」で「人事/top.md」）")
        content.addSubview_(self.path_in_filename_checkbox)

        results_rect = layout["results_scroll"]
        self.results_card_width = results_rect.width - 18
        self.search_scroll = AppKit.NSScrollView.alloc().initWithFrame_(_ns_rect(results_rect))
        self.search_scroll.setDrawsBackground_(False)
        self.search_scroll.setBorderType_(AppKit.NSNoBorder)
        self.search_scroll.setHasVerticalScroller_(True)
        self.results_stack = FlippedView.alloc().initWithFrame_(AppKit.NSMakeRect(0, 0, results_rect.width - 10, results_rect.height))
        self.search_scroll.setDocumentView_(self.results_stack)
        content.addSubview_(self.search_scroll)

    @objc.python_method
    def _build_opencode_pane(self, content: Any, layout: dict[str, Rect]) -> None:
        """
        右上: Claudian 風の OpenCode チャット。
        見出し＋会話履歴＋新規 / モデル＋Plan＋自動承認 / 作業フォルダ / 会話 / 作業状況 / 指示欄 / 使用量＋送信（停止）。
        """
        self.opencode_menu_button = AppKit.NSButton.buttonWithTitle_target_action_("☰", self, "openOpenCodeMenu:")
        self.opencode_menu_button.setFrame_(_ns_rect(layout["opencode_menu_button"]))
        self.opencode_menu_button.setBezelStyle_(AppKit.NSBezelStyleRounded)
        self.opencode_menu_button.setToolTip_("メニュー（opencode 実行フォルダの設定）")
        content.addSubview_(self.opencode_menu_button)
        content.addSubview_(_label("OpenCode", layout["opencode_title_label"], size=14, color=TEXT_COLOR, bold=True))
        self.opencode_commands_button = AppKit.NSButton.buttonWithTitle_target_action_("コマンド", self, "openSlashCommands:")
        self.opencode_commands_button.setFrame_(_ns_rect(layout["opencode_commands_button"]))
        self.opencode_commands_button.setBezelStyle_(AppKit.NSBezelStyleRounded)
        self.opencode_commands_button.setToolTip_("スラッシュコマンド（/pass など、定型作業のプロンプト）を登録・編集する")
        content.addSubview_(self.opencode_commands_button)
        self.opencode_history_popup = AppKit.NSPopUpButton.alloc().initWithFrame_pullsDown_(
            _ns_rect(layout["opencode_history_popup"]), True
        )
        self.opencode_history_popup.addItemWithTitle_("履歴")
        self.opencode_history_popup.setTarget_(self)
        self.opencode_history_popup.setAction_("selectOpenCodeHistory:")
        content.addSubview_(self.opencode_history_popup)
        self.opencode_new_chat_button = AppKit.NSButton.buttonWithTitle_target_action_("新規", self, "resetOpenCode:")
        self.opencode_new_chat_button.setFrame_(_ns_rect(layout["opencode_new_chat_button"]))
        self.opencode_new_chat_button.setBezelStyle_(AppKit.NSBezelStyleRounded)
        content.addSubview_(self.opencode_new_chat_button)

        self.opencode_model_popup = AppKit.NSPopUpButton.alloc().initWithFrame_pullsDown_(
            _ns_rect(layout["opencode_model_popup"]), False
        )
        self.opencode_model_popup.addItemWithTitle_("既定のモデル")
        self.opencode_model_popup.setTarget_(self)
        self.opencode_model_popup.setAction_("selectOpenCodeModel:")
        content.addSubview_(self.opencode_model_popup)
        self.opencode_plan_checkbox = AppKit.NSButton.checkboxWithTitle_target_action_("Plan", self, "toggleOpenCodePlan:")
        self.opencode_plan_checkbox.setFrame_(_ns_rect(layout["opencode_plan_checkbox"]))
        self.opencode_plan_checkbox.setToolTip_("変更せず、調べて計画だけ立てる（--agent plan）")
        content.addSubview_(self.opencode_plan_checkbox)
        self.opencode_auto_checkbox = AppKit.NSButton.checkboxWithTitle_target_action_("自動承認", self, "toggleOpenCodeAuto:")
        self.opencode_auto_checkbox.setFrame_(_ns_rect(layout["opencode_auto_checkbox"]))
        self.opencode_auto_checkbox.setToolTip_("拒否されていない操作の許可を自動で出す（--auto）")
        content.addSubview_(self.opencode_auto_checkbox)

        self.opencode_dir_label = _label("", layout["opencode_dir_label"], size=11, color=(0.58, 0.77, 0.99, 1.0))
        self.opencode_dir_label.setLineBreakMode_(AppKit.NSLineBreakByTruncatingMiddle)
        content.addSubview_(self.opencode_dir_label)

        output_scroll, self.opencode_output_view = _scrolling_text_view(layout["opencode_output_scroll"], editable=False)
        self.opencode_output_view.setRichText_(True)
        self.opencode_output_view.setSelectable_(True)
        self.opencode_output_view.setDelegate_(self)
        self.opencode_output_view.setTextContainerInset_(AppKit.NSMakeSize(4, 6))
        self.opencode_output_view.setLinkTextAttributes_({
            AppKit.NSForegroundColorAttributeName: _color(CHAT_LINK_COLOR),
            AppKit.NSCursorAttributeName: AppKit.NSCursor.pointingHandCursor(),
        })
        content.addSubview_(output_scroll)
        self.opencode_activity_label = _label("", layout["opencode_activity_label"], size=11, color=MUTED_TEXT_COLOR)
        content.addSubview_(self.opencode_activity_label)
        prompt_scroll, self.opencode_prompt_view = _scrolling_text_view(layout["opencode_prompt_scroll"], editable=True)
        self.opencode_prompt_view.setDelegate_(self)
        content.addSubview_(prompt_scroll)

        self.opencode_usage_label = _label("", layout["opencode_usage_label"], size=11, color=MUTED_TEXT_COLOR)
        content.addSubview_(self.opencode_usage_label)
        self.opencode_submit_button = AppKit.NSButton.buttonWithTitle_target_action_("送信", self, "submitOpenCode:")
        self.opencode_submit_button.setFrame_(_ns_rect(layout["opencode_submit_button"]))
        self.opencode_submit_button.setBezelStyle_(AppKit.NSBezelStyleRounded)
        content.addSubview_(self.opencode_submit_button)
        self._render_opencode_chat()

    @objc.python_method
    def _build_scratchpad_pane(self, content: Any, layout: dict[str, Rect]) -> None:
        """左下: 人間が消すまで残る常時保持メモ。"""
        content.addSubview_(_label("メモ（常時保持）", layout["scratchpad_title_label"], size=14, color=TEXT_COLOR, bold=True))
        self.scratchpad_status_label = _label("自動保存", layout["scratchpad_status_label"], size=11, color=MUTED_TEXT_COLOR)
        self.scratchpad_status_label.setAlignment_(AppKit.NSTextAlignmentRight)
        content.addSubview_(self.scratchpad_status_label)
        scratchpad_scroll, self.scratchpad_view = _scrolling_text_view(layout["scratchpad_scroll"], editable=True)
        self.scratchpad_view.setDelegate_(self)
        content.addSubview_(scratchpad_scroll)

    @objc.python_method
    def _build_gantt_pane(self, content: Any, layout: dict[str, Rect]) -> None:
        """右下: gantt タスク名・本文・クリア・送信。"""
        self.memo_title_label = _label("gantt メモ", layout["memo_title_label"], size=14, color=TEXT_COLOR, bold=True)
        content.addSubview_(self.memo_title_label)
        self.memo_parent_label = _label(f"parent: {self.gantt_parent}", layout["memo_parent_label"], size=12, color=TEXT_COLOR)
        self.memo_parent_label.setAlignment_(AppKit.NSTextAlignmentRight)
        content.addSubview_(self.memo_parent_label)

        # タスク名入力欄 (NSTextField)
        self.memo_title_field = AppKit.NSTextField.alloc().initWithFrame_(_ns_rect(layout["memo_title_field"]))
        self.memo_title_field.setPlaceholderString_("タスク名を入力してください...")
        self.memo_title_field.setFont_(AppKit.NSFont.systemFontOfSize_(15))
        self.memo_title_field.setTextColor_(_color(TEXT_COLOR))
        self.memo_title_field.setDrawsBackground_(False)
        self.memo_title_field.setDelegate_(self)
        content.addSubview_(self.memo_title_field)

        # メモ入力部 (NSTextView)。貼り付け元の色などを持ち込まず、常にプレーンテキストとして編集する。
        self.memo_scroll, self.memo_body_view = _scrolling_text_view(layout["memo_scroll"], editable=True)
        self.memo_body_view.setRichText_(False)
        self.memo_body_view.setImportsGraphics_(False)
        self.memo_body_view.setDelegate_(self)
        content.addSubview_(self.memo_scroll)

        self.memo_status_label = _label("", layout["memo_status_label"], size=11, color=MUTED_TEXT_COLOR)
        content.addSubview_(self.memo_status_label)
        self.memo_cancel_button = AppKit.NSButton.buttonWithTitle_target_action_("クリア", self, "clearMemo:")
        self.memo_cancel_button.setFrame_(_ns_rect(layout["memo_cancel_button"]))
        self.memo_cancel_button.setBezelStyle_(AppKit.NSBezelStyleRounded)
        content.addSubview_(self.memo_cancel_button)
        self.memo_submit_button = AppKit.NSButton.buttonWithTitle_target_action_("送信", self, "submitMemo:")
        self.memo_submit_button.setFrame_(_ns_rect(layout["memo_submit_button"]))
        self.memo_submit_button.setBezelStyle_(AppKit.NSBezelStyleRounded)
        content.addSubview_(self.memo_submit_button)

    # --- 共有設定 ---

    @objc.python_method
    def _apply_shared_state(self, settings: Any) -> None:
        """共有設定（gantt parent・opencode 実行フォルダ・常時保持メモ）を状態へ反映する。"""
        if not isinstance(settings, dict):
            return
        self.gantt_parent = normalize_parent_id(settings.get("gantt_parent"), default=self.gantt_parent)
        configured_dir = str(settings.get("opencode_working_dir") or "").strip()
        if configured_dir:
            self.opencode_working_dir = configured_dir
            self.opencode_session.set_working_dir(configured_dir)
        remote_memo = settings.get("launcher_memo")
        if isinstance(remote_memo, str):
            self.autosave.load(remote_memo)

    @objc.python_method
    def _render_shared_settings(self) -> None:
        """共有設定を parent 表示・作業フォルダ表示・常時保持メモ欄へ描く。パネル構築前は何もしない。"""
        if self.panel is None:
            return
        self.memo_parent_label.setStringValue_(f"parent: {self.gantt_parent}")
        self.opencode_dir_label.setStringValue_(
            f"cwd: {self.opencode_working_dir}" if self.opencode_working_dir else "cwd: （☰ メニューから opencode 実行フォルダを指定してください）"
        )
        if not self.autosave.dirty and str(self.scratchpad_view.string() or "") != self.autosave.text:
            self.scratchpad_view.setString_(self.autosave.text)

    @objc.python_method
    def _refresh_shared_settings_async(self) -> None:
        """裏スレッドで共有設定を取り直し、メインスレッドで画面へ反映する。"""

        def _work() -> None:
            try:
                settings = self.client.get_app_settings()
            except Exception:
                return
            AppHelper.callAfter(self._apply_and_render_shared_settings, settings)
            self._load_slash_commands()

        threading.Thread(target=_work, daemon=True).start()

    @objc.python_method
    def _apply_and_render_shared_settings(self, settings: Any) -> None:
        self._apply_shared_state(settings)
        self._render_shared_settings()

    @objc.python_method
    def _show_scratchpad_status(self, status: str) -> None:
        if self.scratchpad_status_label is not None:
            self.scratchpad_status_label.setStringValue_(status)

    # --- gantt メモ ---

    @objc.python_method
    def _submit_memo(self) -> None:
        """メモ入力を gantt タスク作成 API へ送る。"""
        title = str(self.memo_title_field.stringValue() or "").strip()
        memo = str(self.memo_body_view.string() or "").strip()
        if not title:
            self.memo_status_label.setStringValue_("タスク名を入力してください")
            return
        parent = self._load_gantt_parent()
        payload = build_gantt_task_payload(title, memo, parent=parent)
        try:
            self.client.create_gantt_task(payload)
        except Exception as error:
            self.memo_status_label.setStringValue_(f"gantt 追加に失敗しました: {error}")
        else:
            self.memo_title_field.setStringValue_("")
            self.memo_body_view.setString_("")
            self.memo_status_label.setStringValue_("gantt に追加しました")
            self.panel.makeFirstResponder_(self.memo_title_field)

    @objc.python_method
    def _clear_memo(self) -> None:
        """gantt の入力を消してタスク名欄へ戻る。"""
        self.memo_title_field.setStringValue_("")
        self.memo_body_view.setString_("")
        self.memo_status_label.setStringValue_("入力をクリアしました")
        self.panel.makeFirstResponder_(self.memo_title_field)

    def submitMemo_(self, sender: Any) -> None:
        """Cocoa の送信ボタン押下時のアクション。"""
        self._submit_memo()

    def clearMemo_(self, sender: Any) -> None:
        """Cocoa のクリアボタン押下時のアクション。"""
        self._clear_memo()

    # --- OpenCode（Claudian 風チャット） ---

    @objc.python_method
    def _warm_up_opencode(self) -> None:
        """起動時に opencode の常駐サービスを温め、1 回目の応答待ちを短くする。"""
        executable = resolve_opencode_executable()
        if executable:
            warm_up_opencode_service(executable)

    @objc.python_method
    def _submit_opencode(self) -> None:
        """
        指示を裏スレッドで送る。実行中なら待ち行列へ入る（OpenCodeSession.send が判断する）。
        入力欄はすぐ空け、作業フォルダが使えず受け付けなかったときだけ指示を戻す。
        """
        prompt = str(self.opencode_prompt_view.string() or "").strip()
        if not prompt:
            self._show_opencode_activity("指示を入力してください")
            return
        self.opencode_prompt_view.setString_("")
        threading.Thread(target=self._run_opencode, args=(prompt, self.opencode_generation), daemon=True).start()
        self._start_opencode_timer()

    @objc.python_method
    def _run_opencode(self, prompt: str, generation: int) -> None:
        """裏スレッド: 実行中でなければ作業フォルダを取り直し、opencode へ送る。結果はメインスレッドで描く。"""
        if not self.opencode_session.is_running:
            try:
                settings = self.client.get_app_settings()
            except Exception:
                settings = {}
            configured_dir = str(settings.get("opencode_working_dir") or "").strip() if isinstance(settings, dict) else ""
            if configured_dir:
                self.opencode_working_dir = configured_dir
                self.opencode_session.set_working_dir(configured_dir)
        try:
            self.opencode_session.send(
                prompt,
                on_update=lambda: AppHelper.callAfter(self._on_opencode_update, generation),
            )
        except OpenCodeError as error:
            AppHelper.callAfter(self._reject_opencode_prompt, prompt, str(error))
            return
        except Exception as error:  # 想定外の失敗もランチャーを落とさず表示する
            AppHelper.callAfter(self._reject_opencode_prompt, prompt, f"opencode 実行失敗: {error}")
            return
        AppHelper.callAfter(self._finish_opencode, generation)

    @objc.python_method
    def _reject_opencode_prompt(self, prompt: str, message: str) -> None:
        """受け付けなかった指示を入力欄へ戻し、理由を表示する。"""
        if not str(self.opencode_prompt_view.string() or "").strip():
            self.opencode_prompt_view.setString_(prompt)
        self._render_shared_settings()
        self._update_opencode_controls()
        self._show_opencode_activity(message)

    @objc.python_method
    def _on_opencode_update(self, generation: int) -> None:
        """opencode の出力が届くたびにチャットと状態を描き直す。"""
        if generation != self.opencode_generation:
            return
        self._render_opencode_chat()
        self._update_opencode_controls()

    @objc.python_method
    def _finish_opencode(self, generation: int) -> None:
        """1 回分（待ち行列を含む）の実行が終わったら、表示と会話一覧を更新する。"""
        self._render_shared_settings()
        if generation == self.opencode_generation:
            self._render_opencode_chat()
        self._update_opencode_controls()
        self._refresh_opencode_history_async()

    @objc.python_method
    def _reset_opencode(self) -> None:
        """実行中の opencode を止め、表示と待ち行列を消して次回の送信を新規会話へ戻す。"""
        self.opencode_generation += 1
        self.opencode_session.reset()
        self._render_opencode_chat()
        self._update_opencode_controls()
        self._show_opencode_activity("新しい会話を開始します")
        self.panel.makeFirstResponder_(self.opencode_prompt_view)

    @objc.python_method
    def _press_opencode_button(self) -> None:
        """送信ボタン: 実行中は停止（待ち行列も捨てる）、それ以外は送信。"""
        if self.opencode_session.is_running:
            self.opencode_session.cancel()
            self._show_opencode_activity("停止しています…")
        else:
            self._submit_opencode()

    def submitOpenCode_(self, sender: Any) -> None:
        """Cocoa の OpenCode 送信 / 停止ボタン押下時のアクション。"""
        self._press_opencode_button()

    def resetOpenCode_(self, sender: Any) -> None:
        """Cocoa の「新規」ボタン押下時のアクション。"""
        self._reset_opencode()

    def toggleOpenCodePlan_(self, sender: Any) -> None:
        """Plan（変更せず計画だけ立てる）の切り替え。"""
        self.opencode_session.plan_mode = sender.state() == AppKit.NSControlStateValueOn

    def toggleOpenCodeAuto_(self, sender: Any) -> None:
        """自動承認（--auto）の切り替え。"""
        self.opencode_session.auto_approve = sender.state() == AppKit.NSControlStateValueOn

    def selectOpenCodeModel_(self, sender: Any) -> None:
        """モデルの選択。先頭の「既定のモデル」は指定なし。"""
        index = sender.indexOfSelectedItem()
        self.opencode_session.model = None if index <= 0 else str(sender.titleOfSelectedItem())

    def selectOpenCodeHistory_(self, sender: Any) -> None:
        """会話履歴から選んだ会話を裏スレッドで読み込む。"""
        item = sender.selectedItem()
        session_id = item.representedObject() if item is not None else None
        if not session_id:
            return
        self._show_opencode_activity("会話を読み込んでいます…")

        def _work() -> None:
            try:
                self.opencode_session.resume(str(session_id))
            except OpenCodeError as error:
                AppHelper.callAfter(self._show_opencode_activity, str(error))
                return
            AppHelper.callAfter(self._after_opencode_resume)

        threading.Thread(target=_work, daemon=True).start()

    @objc.python_method
    def _after_opencode_resume(self) -> None:
        self.opencode_generation += 1
        self._render_opencode_chat(scroll_to_end=True)
        self._update_opencode_controls()
        self.panel.makeFirstResponder_(self.opencode_prompt_view)

    @objc.python_method
    def _refresh_opencode_history_async(self) -> None:
        """裏スレッドで会話一覧を取り直し、履歴メニューへ並べる。"""

        def _work() -> None:
            try:
                sessions = self.opencode_session.list_sessions()
            except OpenCodeError:
                sessions = []
            AppHelper.callAfter(self._fill_opencode_history, sessions)

        threading.Thread(target=_work, daemon=True).start()

    @objc.python_method
    def _fill_opencode_history(self, sessions: list[Any]) -> None:
        """履歴メニュー（プルダウン）を作り直す。先頭は見出し「履歴」。"""
        popup = self.opencode_history_popup
        if popup is None:
            return
        popup.removeAllItems()
        popup.addItemWithTitle_("履歴")
        now_ms = int(time.time() * 1000)
        for summary in sessions:
            popup.addItemWithTitle_(f"{summary.title or '（無題）'} · {format_relative_time(summary.updated_ms, now_ms)}")
            popup.lastItem().setRepresentedObject_(summary.id)
        if not sessions:
            popup.addItemWithTitle_("（会話はまだありません）")
            popup.lastItem().setEnabled_(False)

    @objc.python_method
    def _load_opencode_models_async(self) -> None:
        """裏スレッドでモデル一覧を 1 度だけ取り、モデル選択へ並べる。"""
        if self.opencode_models_loaded:
            return
        self.opencode_models_loaded = True

        def _work() -> None:
            models = self.opencode_session.list_models()
            AppHelper.callAfter(self._fill_opencode_models, models)

        threading.Thread(target=_work, daemon=True).start()

    @objc.python_method
    def _fill_opencode_models(self, models: list[str]) -> None:
        popup = self.opencode_model_popup
        if popup is None:
            return
        popup.removeAllItems()
        popup.addItemWithTitle_("既定のモデル")
        popup.addItemsWithTitles_(models)
        if self.opencode_session.model in models:
            popup.selectItemWithTitle_(self.opencode_session.model)
        if not models:
            self.opencode_models_loaded = False  # 取れなかったら次の表示で取り直す

    @objc.python_method
    def _start_opencode_timer(self) -> None:
        """実行中の経過時間を 1 秒ごとに表示するタイマーを始める。"""
        if self.opencode_timer is None:
            self.opencode_timer = AppKit.NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
                1.0, self, "tickOpenCode:", None, True
            )
        self._update_opencode_controls()

    def tickOpenCode_(self, timer: Any) -> None:
        """1 秒ごとの状態表示。実行が終わったらタイマーを止める。"""
        self._update_opencode_controls()
        if not self.opencode_session.is_running and self.opencode_timer is not None:
            self.opencode_timer.invalidate()
            self.opencode_timer = None

    @objc.python_method
    def _update_opencode_controls(self) -> None:
        """作業状況・使用量・送信 / 停止ボタンを今の状態に合わせる。"""
        if self.opencode_submit_button is None:
            return
        running = self.opencode_session.is_running
        self.opencode_submit_button.setTitle_("停止" if running else "送信")
        self.opencode_history_popup.setEnabled_(not running)
        self.opencode_activity_label.setStringValue_(self.opencode_session.status_text())
        self.opencode_usage_label.setStringValue_(self.opencode_session.transcript.usage_text())

    @objc.python_method
    def _show_opencode_activity(self, message: str) -> None:
        if self.opencode_activity_label is not None:
            self.opencode_activity_label.setStringValue_(message)

    @objc.python_method
    def _render_opencode_chat(self, *, scroll_to_end: bool = False) -> None:
        """
        チャット（render_chat の Segment 列）を NSTextView へ流し込む。
        読み返し中（下端から 100pt より上）はスクロール位置を保ち、下端付近なら最新へ追従する。
        """
        view = self.opencode_output_view
        if view is None:
            return
        follow = scroll_to_end or _is_scrolled_near_bottom(view)
        attributed = AppKit.NSMutableAttributedString.alloc().init()
        for segment in render_chat(self.opencode_session.transcript):
            attributes = _chat_attributes(segment.style)
            if segment.link:
                attributes[AppKit.NSLinkAttributeName] = segment.link
            attributed.appendAttributedString_(
                AppKit.NSAttributedString.alloc().initWithString_attributes_(segment.text, attributes)
            )
        view.textStorage().setAttributedString_(attributed)
        if follow:
            view.scrollToEndOfDocument_(None)

    def textView_clickedOnLink_atIndex_(self, textView: Any, link: Any, charIndex: int) -> bool:
        """チャット内のリンク: toggle:<ID> は思考・ツールの開閉、copy:<ID> は応答のコピー。"""
        target = str(link.absoluteString() if hasattr(link, "absoluteString") else link)
        kind, _, entry_id = target.partition(":")
        if kind == "toggle":
            if self.opencode_session.transcript.toggle(entry_id):
                self._render_opencode_chat()
            return True
        if kind == "copy":
            pasteboard = AppKit.NSPasteboard.generalPasteboard()
            pasteboard.clearContents()
            pasteboard.setString_forType_(self.opencode_session.transcript.copy_text(entry_id), AppKit.NSPasteboardTypeString)
            self._show_opencode_activity("応答をコピーしました")
            return True
        return False

    # --- スラッシュコマンド ---

    @objc.python_method
    def _load_slash_commands(self) -> None:
        """独自スラッシュコマンドをバックエンドから読む（古いバックエンドで API が無くても止めない）。"""
        getter = getattr(self.client, "get_slash_commands", None)
        if getter is None:
            return
        try:
            self.opencode_session.slash_commands = list(getter())
        except Exception:
            pass

    @objc.python_method
    def _complete_slash(self, text_view: Any) -> bool:
        """
        指示欄の / の語の中の Tab。候補が 1 つならすぐ補完し、複数なら macOS 標準の補完一覧を出す。
        補完したら True。/ の語の外や候補が無いときは False（普段どおり Tab でペインを移動する）。
        """
        text = str(text_view.string() or "")
        caret = int(text_view.selectedRange().location)
        query = slash_query(text, caret)
        if query is None:
            return False
        candidates = find_candidates(self.opencode_session.slash_commands, query)
        if not candidates:
            return False
        if len(candidates) == 1:
            completed, new_caret = apply_completion(text, caret, candidates[0].name)
            text_view.setString_(completed)
            text_view.setSelectedRange_(AppKit.NSMakeRange(new_caret, 0))
            return True
        text_view.complete_(None)
        return True

    def textView_completions_forPartialWordRange_indexOfSelectedItem_(
        self, textView: Any, words: Any, charRange: Any, index: Any
    ) -> Any:
        """標準の補完一覧の候補。指示欄ではスラッシュコマンドの名前（前方一致 → 途中一致）、それ以外は標準のまま。"""
        if textView is not self.opencode_prompt_view:
            return (list(words or []), index)
        text = str(textView.string() or "")
        location, length = int(charRange.location), int(charRange.length)
        partial = text[location:location + length]
        return (completion_words(partial, self.opencode_session.slash_commands), 0)

    def openOpenCodeMenu_(self, sender: Any) -> None:
        """☰: opencode 実行フォルダの設定メニュー（現在のフォルダ表示・選ぶ・既定に戻す）を開く。"""
        menu = AppKit.NSMenu.alloc().initWithTitle_("OpenCode")
        menu.setAutoenablesItems_(False)
        current = self.opencode_working_dir or "（未設定）"
        header = menu.addItemWithTitle_action_keyEquivalent_(f"実行フォルダ: {current}", None, "")
        header.setEnabled_(False)
        menu.addItem_(AppKit.NSMenuItem.separatorItem())
        for title, action in (("実行フォルダを選ぶ…", "chooseOpenCodeWorkingDir:"), ("実行フォルダを既定に戻す", "resetOpenCodeWorkingDir:")):
            item = menu.addItemWithTitle_action_keyEquivalent_(title, action, "")
            item.setTarget_(self)
            item.setEnabled_(True)
        menu.popUpMenuPositioningItem_atLocation_inView_(None, AppKit.NSMakePoint(0, sender.bounds().size.height + 2), sender)

    def chooseOpenCodeWorkingDir_(self, sender: Any) -> None:
        """「実行フォルダを選ぶ…」: フォルダ選択ダイアログで選んだフォルダを opencode 実行フォルダとして保存する。"""
        dialog = AppKit.NSOpenPanel.openPanel()
        dialog.setCanChooseDirectories_(True)
        dialog.setCanChooseFiles_(False)
        dialog.setCanCreateDirectories_(True)
        dialog.setAllowsMultipleSelection_(False)
        dialog.setMessage_("OpenCode を実行するフォルダを選んでください")
        dialog.setPrompt_("選択")
        if self.opencode_working_dir:
            dialog.setDirectoryURL_(AppKit.NSURL.fileURLWithPath_isDirectory_(self.opencode_working_dir, True))
        if dialog.runModal() != AppKit.NSModalResponseOK:
            return
        self._save_opencode_working_dir_async(str(dialog.URL().path()))

    def resetOpenCodeWorkingDir_(self, sender: Any) -> None:
        """「実行フォルダを既定に戻す」: 空欄で保存し、バックエンドの既定フォルダへ戻す。"""
        self._save_opencode_working_dir_async("")

    @objc.python_method
    def _save_opencode_working_dir_async(self, path: str) -> None:
        """裏スレッドで保存し、結果の案内をメインスレッドで作業状況欄と cwd 表示へ出す。"""

        def _work() -> None:
            message = self._apply_opencode_working_dir(path)
            AppHelper.callAfter(self._after_opencode_working_dir_saved, message)

        threading.Thread(target=_work, daemon=True).start()

    @objc.python_method
    def _apply_opencode_working_dir(self, path: str) -> str:
        """
        opencode 実行フォルダを保存して OpenCode の作業フォルダへ反映し、利用者へ見せる案内文を返す。
        実行中は変更しない（会話が途中で新規に戻るため）。保存に失敗したら今のフォルダを変えない。
        """
        if self.opencode_session.is_running:
            return "OpenCode の実行中は実行フォルダを変更できません"
        try:
            saved = self.client.save_opencode_working_dir(path)
        except Exception as error:
            return f"実行フォルダの保存に失敗しました: {error}"
        self.opencode_working_dir = saved
        self.opencode_session.set_working_dir(saved)
        return f"実行フォルダを変更しました: {saved}" if saved else "実行フォルダを既定に戻しました"

    @objc.python_method
    def _after_opencode_working_dir_saved(self, message: str) -> None:
        """メインスレッド: cwd 表示を更新し、保存結果を作業状況欄へ出す。"""
        self._render_shared_settings()
        self._show_opencode_activity(message)

    def openSlashCommands_(self, sender: Any) -> None:
        """「コマンド」: スラッシュコマンドの登録画面を開く。保存した一覧はすぐ指示欄の補完と送信に使う。"""
        if self.slash_editor is None:
            self.slash_editor = SlashCommandEditor.alloc().init()

        def _save(commands: list[SlashCommand]) -> list[SlashCommand]:
            return self.client.save_slash_commands(commands)

        def _on_saved(commands: list[SlashCommand]) -> None:
            self.opencode_session.slash_commands = list(commands)

        self.slash_editor.setup(list(self.opencode_session.slash_commands), _save, _on_saved)
        self.slash_editor.show()

    @objc.python_method
    def _recall_opencode_history(self, selector: str) -> bool:
        """
        指示欄の ↑（1 行目にカーソルがあるとき）で前の指示、↓（最終行）で次の指示を呼び出す。
        呼び出したら True。それ以外はカーソル移動に任せる。
        """
        view = self.opencode_prompt_view
        text = str(view.string() or "")
        caret = int(view.selectedRange().location)
        history = self.opencode_session.history
        if selector == "moveUp:" and "\n" not in text[:caret]:
            recalled = history.previous(text)
        elif selector == "moveDown:" and "\n" not in text[caret:]:
            recalled = history.next()
        else:
            return False
        if recalled is None:
            return False
        view.setString_(recalled)
        view.setSelectedRange_(AppKit.NSMakeRange(len(recalled), 0))
        return True

    @objc.python_method
    def _load_gantt_parent(self) -> int:
        """
        Web の設定ドロワーで保存した gantt parent ID を取得する。
        """
        try:
            app_settings = self.client.get_app_settings()
        except Exception:
            return self.gantt_parent
        self.gantt_parent = normalize_parent_id(app_settings.get("gantt_parent"), default=self.gantt_parent)
        self.memo_parent_label.setStringValue_(f"parent: {self.gantt_parent}")
        return self.gantt_parent

    @objc.python_method
    def _center_panel_on_mouse_screen(self) -> None:
        """
        マウスカーソルがある画面の中央上寄りへパネルを移動する。
        """
        mouse = AppKit.NSEvent.mouseLocation()
        target_screen = AppKit.NSScreen.mainScreen()
        for screen in AppKit.NSScreen.screens():
            if AppKit.NSPointInRect(mouse, screen.frame()):
                target_screen = screen
                break
        frame = target_screen.visibleFrame()
        x = frame.origin.x + (frame.size.width - PANEL_WIDTH) / 2
        y = frame.origin.y + frame.size.height - PANEL_HEIGHT - 120
        self.panel.setFrame_display_(AppKit.NSMakeRect(x, y, PANEL_WIDTH, PANEL_HEIGHT), True)

    @objc.python_method
    def _search(self, query: str, sequence: int) -> None:
        """
        バックグラウンド検索を実行し、結果更新はメインスレッドへ戻す。
        """
        try:
            search_options: dict[str, Any] = {
                "limit": self.config.search_limit,
                "include_gantt_tasks": self.include_gantt_tasks,
                "types": str(self.extension_filter.stringValue()).strip(),
                "search_type": getattr(self, "search_type", "hybrid"),
                "include_path_in_filename": getattr(self, "include_path_in_filename", True),
            }
            import inspect
            if hasattr(self.client, "search") and callable(self.client.search):
                sig = inspect.signature(self.client.search)
                has_var_keyword = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())
                if not has_var_keyword:
                    search_options = {k: v for k, v in search_options.items() if k in sig.parameters}
            response = self.client.search(query, **search_options)
        except Exception as error:
            AppHelper.callAfter(self._show_search_error, sequence, str(error))
        else:
            AppHelper.callAfter(self._show_search_results, sequence, response.total, response.items)

    @objc.python_method
    def _show_search_error(self, sequence: int, message: str) -> None:
        """
        最新検索のエラーだけをステータスへ表示する。
        """
        if sequence != self.search_sequence:
            return
        self.results = []
        self.status_label.setStringValue_(f"検索に失敗しました: {message}")
        self.last_results_time = time.time()
        self._render_results()

    @objc.python_method
    def _show_search_results(self, sequence: int, total: int, items: list[SearchResultItem]) -> None:
        """
        最新検索の結果だけを結果リストへ反映する。
        """
        if sequence != self.search_sequence:
            return
        self.results = items
        self.selected_index = 0
        self.status_label.setStringValue_(f"{total} 件")
        self.last_results_time = time.time()
        self._render_results()

    @objc.python_method
    def _render_results(self) -> None:
        """
        現在の検索結果をクリック可能なカードとして描画する。
        """
        for view in list(self.results_stack.subviews()):
            view.removeFromSuperview()
        
        card_height = RESULT_CARD_HEIGHT
        spacing = RESULT_CARD_SPACING
        total_height = len(self.results) * (card_height + spacing)
        visible_height = self.search_scroll.frame().size.height
        new_height = max(visible_height, total_height)
        self.results_stack.setFrameSize_(AppKit.NSMakeSize(self.results_stack.frame().size.width, new_height))

        for index, item in enumerate(self.results):
            card = self._make_result_card(item, index, index == self.selected_index)
            card.setFrameOrigin_(AppKit.NSMakePoint(4, index * (card_height + spacing)))
            self.results_stack.addSubview_(card)

    @objc.python_method
    def _update_card_selection(self, old_index: int, new_index: int) -> None:
        """
        選択変更時にカード全体を再構築せず、背景色とボーダー色のみを更新する。
        """
        subviews = self.results_stack.subviews()
        count = len(subviews)
        if old_index < count:
            self._apply_card_style(subviews[old_index], selected=False)
        if new_index < count:
            self._apply_card_style(subviews[new_index], selected=True)

    @objc.python_method
    def _apply_card_style(self, card: AppKit.NSView, *, selected: bool) -> None:
        """
        カードの背景色・ボーダー色・パスラベル色・タイトル色を選択状態に応じて更新する。
        """
        bg = (0.11, 0.31, 0.85, 0.98) if selected else (0.07, 0.09, 0.15, 0.98)
        border = (0.38, 0.65, 0.98, 0.9) if selected else (0.12, 0.16, 0.22, 0.9)
        card.layer().setBackgroundColor_(AppKit.NSColor.colorWithCalibratedRed_green_blue_alpha_(*bg).CGColor())
        card.layer().setBorderColor_(AppKit.NSColor.colorWithCalibratedRed_green_blue_alpha_(*border).CGColor())
        
        subviews = card.subviews()
        # サブビュー順序: 0: title, 1: path, 2: snippet, 以降はアイコンと操作ボタン。
        if len(subviews) > 1:
            # Title
            title_color = (1.0, 1.0, 1.0, 1.0) if selected else (0.38, 0.80, 0.98, 1.0) # 選択時は白、非選択時は水色(リンク風)
            subviews[0].setTextColor_(AppKit.NSColor.colorWithCalibratedRed_green_blue_alpha_(*title_color))
            
            # Path
            path_color = (0.7, 0.8, 1.0, 1.0) if selected else (0.58, 0.64, 0.73, 1.0)
            subviews[1].setTextColor_(AppKit.NSColor.colorWithCalibratedRed_green_blue_alpha_(*path_color))

    @objc.python_method
    def _make_result_card(self, item: SearchResultItem, index: int, selected: bool) -> AppKit.NSView:
        """
        検索結果 1 件を Web アプリの結果カードに近い操作群として描画する。
        ボタンの tag にはリスト内インデックスを使い、file_id 衝突を回避する。
        """
        card_layout = result_card_layout(self.results_card_width)
        card = FlippedView.alloc().initWithFrame_(AppKit.NSMakeRect(0, 0, self.results_card_width, RESULT_CARD_HEIGHT))
        card.setWantsLayer_(True)
        color = (0.11, 0.31, 0.85, 0.98) if selected else (0.07, 0.09, 0.15, 0.98)
        card.layer().setBackgroundColor_(AppKit.NSColor.colorWithCalibratedRed_green_blue_alpha_(*color).CGColor())
        card.layer().setCornerRadius_(8)
        border_color = (0.38, 0.65, 0.98, 0.9) if selected else (0.12, 0.16, 0.22, 0.9)
        card.layer().setBorderColor_(AppKit.NSColor.colorWithCalibratedRed_green_blue_alpha_(*border_color).CGColor())
        card.layer().setBorderWidth_(1.0)

        badge_text = ""
        match_source = getattr(item, "match_source", None)
        if match_source == "both":
            badge_text = "  🌟両方一致"
        elif match_source == "vector":
            badge_text = "  🔮意味一致"
        elif match_source == "keyword":
            badge_text = "  🏷️通常一致"
        display_title = f"{item.file_name}{badge_text}"

        title_label = AppKit.NSTextField.labelWithString_(display_title)
        title_label.setFrame_(_ns_rect(card_layout["title"]))
        title_color = (1.0, 1.0, 1.0, 1.0) if selected else (0.38, 0.80, 0.98, 1.0) # 水色でリンクっぽく
        title_label.setTextColor_(AppKit.NSColor.colorWithCalibratedRed_green_blue_alpha_(*title_color))
        title_label.setFont_(AppKit.NSFont.boldSystemFontOfSize_(14))
        title_label.setLineBreakMode_(AppKit.NSLineBreakByTruncatingTail)
        card.addSubview_(title_label)

        path_label = AppKit.NSTextField.labelWithString_(item.full_path)
        path_label.setFrame_(_ns_rect(card_layout["path"]))
        path_color = (0.7, 0.8, 1.0, 1.0) if selected else (0.58, 0.64, 0.73, 1.0)
        path_label.setTextColor_(AppKit.NSColor.colorWithCalibratedRed_green_blue_alpha_(*path_color))
        path_label.setFont_(AppKit.NSFont.systemFontOfSize_(10))
        path_label.setLineBreakMode_(AppKit.NSLineBreakByTruncatingMiddle)
        card.addSubview_(path_label)

        salient = getattr(item, "salient_sentence", None)
        if salient:
            snippet = f"💡 {salient}"[:120]
        else:
            snippet = strip_html(item.snippet)[:120].replace("\n", " ")
        snippet_label = AppKit.NSTextField.labelWithString_(snippet)
        snippet_label.setFrame_(_ns_rect(card_layout["snippet"]))
        snippet_label.setTextColor_(AppKit.NSColor.colorWithCalibratedRed_green_blue_alpha_(0.8, 0.83, 0.88, 1.0))
        snippet_label.setFont_(AppKit.NSFont.systemFontOfSize_(11))
        snippet_label.setLineBreakMode_(AppKit.NSLineBreakByTruncatingTail)
        snippet_label.setMaximumNumberOfLines_(1)
        card.addSubview_(snippet_label)

        # タイトル左に同梱 Catppuccin SVG を表示し、拡張子ごとの識別性を高める。
        icon = AppKit.NSImage.alloc().initWithContentsOfFile_(str(catppuccin_icon_path(item)))
        if icon is not None:
            icon_view = AppKit.NSImageView.alloc().initWithFrame_(_ns_rect(card_layout["icon"]))
            icon_view.setImage_(icon)
            icon_view.setImageScaling_(AppKit.NSImageScaleProportionallyUpOrDown)
            card.addSubview_(icon_view)

        # クリック全体を覆う透明ボタンを前面（テキストの上）に配置
        invisible_button = AppKit.NSButton.alloc().initWithFrame_(_ns_rect(card_layout["open_area"]))
        invisible_button.setTitle_("")
        invisible_button.setTransparent_(True)
        invisible_button.setTarget_(self)
        invisible_button.setAction_("openResult:")
        invisible_button.setTag_(index)
        card.addSubview_(invisible_button)

        if item.source_type == "gantt":
            if item.gantt_link:
                link_button = AppKit.NSButton.buttonWithTitle_target_action_("ganttのリンクを開く", self, "openGanttLinkResult:")
                link_button.setFrame_(_ns_rect(card_layout["gantt_link_button"]))
                link_button.setTag_(index)
                link_button.setBezelStyle_(AppKit.NSBezelStyleRounded)
                card.addSubview_(link_button)
        else:
            copy_button = AppKit.NSButton.buttonWithTitle_target_action_("フルパス", self, "copyPathResult:")
            copy_button.setFrame_(_ns_rect(card_layout["copy_button"]))
            copy_button.setTag_(index)
            copy_button.setBezelStyle_(AppKit.NSBezelStyleRounded)
            card.addSubview_(copy_button)

            finder_button = AppKit.NSButton.buttonWithTitle_target_action_("Finderで開く", self, "revealResult:")
            finder_button.setFrame_(_ns_rect(card_layout["reveal_button"]))
            finder_button.setTag_(index)
            finder_button.setBezelStyle_(AppKit.NSBezelStyleRounded)
            card.addSubview_(finder_button)

            folder_button = AppKit.NSButton.buttonWithTitle_target_action_("フォルダを開く", self, "openFolderResult:")
            folder_button.setFrame_(_ns_rect(card_layout["folder_button"]))
            folder_button.setTag_(index)
            folder_button.setBezelStyle_(AppKit.NSBezelStyleRounded)
            card.addSubview_(folder_button)
        
        return card

    def openResult_(self, sender: Any) -> None:
        """
        Web アプリのタイトルリンクと同じ URL を既定ブラウザで開く。
        """
        index = int(sender.tag())
        if index < 0 or index >= len(self.results):
            return
        self._open_item(self.results[index])

    @objc.python_method
    def _open_item(self, item: SearchResultItem) -> None:
        try:
            if item.source_type == "gantt":
                self.client.open_gantt_task_input(abs(item.file_id))
                self.hide_panel()
                return
            if uses_system_file_launcher(item.full_path):
                open_with_system_file_launcher(item.full_path)
            else:
                webbrowser.open(primary_web_url_for_item(item, self.web_base_url))
            if item.result_kind == "file" and item.source_type != "gantt" and item.file_id > 0:
                query = str(self.search_field.stringValue()).strip() if self.search_field is not None else ""
                self.client.record_click(item.file_id, query)
            self.hide_panel()
        except Exception as error:
            self.status_label.setStringValue_(f"ファイルを開けませんでした: {error}")

    def revealResult_(self, sender: Any) -> None:
        """
        Web アプリの Finder で開くボタンと同じ backend API を呼ぶ。
        """
        index = int(sender.tag())
        if index < 0 or index >= len(self.results):
            return
        self._reveal_item(self.results[index])

    @objc.python_method
    def _reveal_item(self, item: SearchResultItem) -> None:
        """結果の保存場所（フォルダ）を Finder で開く。"""
        target_path = item.full_path if item.result_kind == "folder" else folder_path_for_item(item)
        try:
            self.client.open_location(target_path)
        except Exception as error:
            self.status_label.setStringValue_(f"保存場所を開けませんでした: {error}")

    def copyPathResult_(self, sender: Any) -> None:
        """
        フルパスをクリップボードにコピーする。
        """
        index = int(sender.tag())
        if index < 0 or index >= len(self.results):
            return
        item = self.results[index]
        pasteboard = AppKit.NSPasteboard.generalPasteboard()
        pasteboard.clearContents()
        pasteboard.setString_forType_(item.full_path, AppKit.NSPasteboardTypeString)
        self.status_label.setStringValue_("クリップボードにコピーしました")

    def changeSearchType_(self, sender: Any) -> None:
        """
        検索方式（ハイブリッド / ベクトル / 通常）を切り替えて再検索を実行する。
        """
        try:
            idx = int(sender.selectedSegment())
        except Exception:
            idx = 0
        mapping = ["hybrid", "vector", "keyword"]
        if 0 <= idx < len(mapping):
            self.search_type = mapping[idx]
        if self.search_field is not None and str(self.search_field.stringValue() or "").strip():
            self.controlTextDidChange_(None)

    def togglePathInFilename_(self, sender: Any) -> None:
        """
        macOS ランチャーで、ファイル名検索にフォルダ名を含めるかを切り替える。
        """
        self.include_path_in_filename = bool(sender.state())
        if self.search_field is not None and str(self.search_field.stringValue()).strip():
            self.controlTextDidChange_(None)

    def toggleGanttSearch_(self, sender: Any) -> None:
        """
        macOS ランチャーで gantt タスク検索の有効/無効を切り替える。
        """
        self.include_gantt_tasks = bool(sender.state())
        if self.search_field is not None and str(self.search_field.stringValue()).strip():
            self.controlTextDidChange_(None)

    def openFolderResult_(self, sender: Any) -> None:
        """
        Web アプリのフォルダリンクと同じ URL を既定ブラウザで開く。
        """
        index = int(sender.tag())
        if index < 0 or index >= len(self.results):
            return
        item = self.results[index]
        webbrowser.open(folder_web_url_for_item(item, self.web_base_url))

    def openGanttLinkResult_(self, sender: Any) -> None:
        """
        gantt タスクに設定されているリンクを既定ブラウザで開く。
        """
        index = int(sender.tag())
        if index < 0 or index >= len(self.results):
            return
        item = self.results[index]
        if item.gantt_link:
            webbrowser.open(item.gantt_link)

    def openGuiUrl_(self, sender: Any) -> None:
        """
        GUIへのリンクを既定ブラウザで開く。
        """
        webbrowser.open(f"{self.config.api_base_url.rstrip('/')}/")
        self.hide_panel()


def _ns_rect(rect: Rect) -> Any:
    """配置計算の矩形を NSRect にする。"""
    return AppKit.NSMakeRect(rect.x, rect.y, rect.width, rect.height)


def _color(rgba: tuple[float, float, float, float]) -> Any:
    return AppKit.NSColor.colorWithCalibratedRed_green_blue_alpha_(*rgba)


def _label(text: str, rect: Rect, *, size: float, color: tuple[float, float, float, float], bold: bool = False) -> Any:
    """1 行の表示専用ラベルを作る。"""
    label = AppKit.NSTextField.labelWithString_(text)
    label.setFrame_(_ns_rect(rect))
    label.setTextColor_(_color(color))
    label.setFont_(AppKit.NSFont.boldSystemFontOfSize_(size) if bold else AppKit.NSFont.systemFontOfSize_(size))
    label.setLineBreakMode_(AppKit.NSLineBreakByTruncatingTail)
    return label


def _scrolling_text_view(rect: Rect, *, editable: bool) -> tuple[Any, Any]:
    """
    スクロールできる複数行のプレーンテキスト欄を作り、(スクロールビュー, テキストビュー) を返す。
    貼り付け元の文字色や背景色を持ち込まないよう、リッチテキストと画像の取り込みを無効にする。
    """
    scroll = AppKit.NSScrollView.alloc().initWithFrame_(_ns_rect(rect))
    scroll.setBorderType_(AppKit.NSBezelBorder)
    scroll.setHasVerticalScroller_(True)
    scroll.setDrawsBackground_(True)
    scroll.setBackgroundColor_(_color(INPUT_BACKGROUND_COLOR))
    content_size = scroll.contentSize()
    text_view = AppKit.NSTextView.alloc().initWithFrame_(AppKit.NSMakeRect(0, 0, content_size.width, content_size.height))
    font = AppKit.NSFont.systemFontOfSize_(13)
    text_view.setEditable_(editable)
    text_view.setRichText_(False)
    text_view.setImportsGraphics_(False)
    text_view.setUsesFontPanel_(False)
    text_view.setFont_(font)
    text_view.setTextColor_(_color(TEXT_COLOR))
    text_view.setBackgroundColor_(_color(INPUT_BACKGROUND_COLOR))
    text_view.setDrawsBackground_(True)
    text_view.setTypingAttributes_({
        AppKit.NSFontAttributeName: font,
        AppKit.NSForegroundColorAttributeName: _color(TEXT_COLOR),
        AppKit.NSBackgroundColorAttributeName: AppKit.NSColor.clearColor(),
    })
    text_view.setInsertionPointColor_(_color((0.38, 0.65, 0.98, 1.0)))
    text_view.setVerticallyResizable_(True)
    text_view.setHorizontallyResizable_(False)
    text_view.setAutoresizingMask_(AppKit.NSViewWidthSizable)
    text_view.textContainer().setWidthTracksTextView_(True)
    scroll.setDocumentView_(text_view)
    return scroll, text_view


CHAT_LINK_COLOR = (0.38, 0.65, 0.98, 1.0)
_CHAT_STYLES: dict[str, tuple[str, float, tuple[float, float, float, float], tuple[float, float, float, float] | None]] = {
    # 書式名: (字体 system / bold / mono, 大きさ, 文字色, 背景色)
    "user_label": ("bold", 11, (0.58, 0.77, 0.99, 1.0), None),
    "user": ("system", 13, TEXT_COLOR, (0.11, 0.25, 0.55, 0.55)),
    "assistant_label": ("bold", 11, (0.55, 0.85, 0.65, 1.0), None),
    "assistant": ("system", 13, TEXT_COLOR, None),
    "bold": ("bold", 13, TEXT_COLOR, None),
    "heading": ("bold", 14, TEXT_COLOR, None),
    "inline_code": ("mono", 12, (0.86, 0.9, 0.74, 1.0), (0.04, 0.06, 0.1, 1.0)),
    "code": ("mono", 12, (0.86, 0.9, 0.74, 1.0), (0.04, 0.06, 0.1, 1.0)),
    "muted": ("system", 12, MUTED_TEXT_COLOR, None),
    "toggle": ("system", 12, MUTED_TEXT_COLOR, None),
    "tool": ("system", 12, (0.7, 0.8, 0.95, 1.0), None),
    "tool_error": ("system", 12, (0.97, 0.45, 0.45, 1.0), None),
    "detail": ("mono", 11, MUTED_TEXT_COLOR, (0.04, 0.06, 0.1, 1.0)),
    "notice": ("system", 11, MUTED_TEXT_COLOR, None),
    "error": ("system", 12, (0.97, 0.45, 0.45, 1.0), None),
    "link": ("system", 11, CHAT_LINK_COLOR, None),
}


def _chat_attributes(style: str) -> dict[Any, Any]:
    """チャットの書式名から NSAttributedString の属性を作る。"""
    face, size, color, background = _CHAT_STYLES.get(style, _CHAT_STYLES["assistant"])
    if face == "bold":
        font = AppKit.NSFont.boldSystemFontOfSize_(size)
    elif face == "mono":
        font = AppKit.NSFont.userFixedPitchFontOfSize_(size) or AppKit.NSFont.systemFontOfSize_(size)
    else:
        font = AppKit.NSFont.systemFontOfSize_(size)
    paragraph = AppKit.NSMutableParagraphStyle.alloc().init()
    paragraph.setParagraphSpacing_(3)
    attributes: dict[Any, Any] = {
        AppKit.NSFontAttributeName: font,
        AppKit.NSForegroundColorAttributeName: _color(color),
        AppKit.NSParagraphStyleAttributeName: paragraph,
    }
    if background is not None:
        attributes[AppKit.NSBackgroundColorAttributeName] = _color(background)
    return attributes


def _is_scrolled_near_bottom(text_view: Any, threshold: float = 100.0) -> bool:
    """テキストビューが下端から threshold 以内まで表示しているか（読み返し中は追従しない）。"""
    scroll = text_view.enclosingScrollView()
    if scroll is None:
        return True
    visible = scroll.documentVisibleRect()
    document_height = text_view.frame().size.height
    return visible.origin.y + visible.size.height >= document_height - threshold


def run_native_mac_app(config: LauncherConfig | None = None) -> None:
    """
    macOS ネイティブパネルとしてランチャーを起動する。
    """
    if platform.system() != "Darwin":
        raise RuntimeError("Native macOS launcher is only available on Darwin.")
    app_config = config or LauncherConfig.from_env()
    client = LauncherApiClient(
        app_config.api_base_url,
        gantt_api_base_url=app_config.gantt_api_base_url,
        timeout=app_config.request_timeout,
    )
    global _delegate_ref
    app = AppKit.NSApplication.sharedApplication()
    app.setActivationPolicy_(AppKit.NSApplicationActivationPolicyAccessory)

    # Cmd+C, Cmd+V などの標準ショートカットを有効にするため、ダミーのEditメニューを登録する
    menubar = AppKit.NSMenu.alloc().init()
    app_menu_item = AppKit.NSMenuItem.alloc().init()
    menubar.addItem_(app_menu_item)
    
    edit_menu_item = AppKit.NSMenuItem.alloc().init()
    edit_menu = AppKit.NSMenu.alloc().initWithTitle_("Edit")
    edit_menu.addItemWithTitle_action_keyEquivalent_("Cut", "cut:", "x")
    edit_menu.addItemWithTitle_action_keyEquivalent_("Copy", "copy:", "c")
    edit_menu.addItemWithTitle_action_keyEquivalent_("Paste", "paste:", "v")
    edit_menu.addItemWithTitle_action_keyEquivalent_("Select All", "selectAll:", "a")
    edit_menu.addItemWithTitle_action_keyEquivalent_("Undo", "undo:", "z")
    edit_menu_item.setSubmenu_(edit_menu)
    menubar.addItem_(edit_menu_item)
    app.setMainMenu_(menubar)

    delegate = LauncherDelegate.alloc().initWithClient_config_(client, app_config)
    _delegate_ref = delegate
    delegate._begin_activity()
    delegate._build_panel()
    delegate._start_hotkey_monitor()
    delegate._start_power_state_monitor()
    delegate.status_label.setStringValue_(f"Hotkey: {hotkey_spec_for_platform(mode=delegate.hotkey_mode)}")
    app.setDelegate_(delegate)
    delegate.show_panel()
    AppHelper.runEventLoop()
