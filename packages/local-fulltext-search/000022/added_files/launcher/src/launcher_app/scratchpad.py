"""
ランチャーの常時保持メモ（Scratchpad）の自動保存を管理する（macOS 版）。

【仕様】
- 入力のたびに update() を呼ぶと、最後の入力から delay 秒後に 1 回だけ保存する（デバウンス）。
- 非表示・終了時は flush() で即座に保存する。flush() は同時に 1 つしか走らない。
- 保存の通信中に入力された内容は「未保存」のまま残し、次の保存で必ず届ける（版番号で判定する）。
- 保存に失敗したら未保存のまま残し、状態を「保存失敗: 理由」にする。
- load() はサーバーから読んだ値を未保存扱いにせず反映する。手元で一度でも編集した後は何もしない
  （ランチャー自身の編集を正とし、行き違った古い値で上書きしない）。
"""

from __future__ import annotations

from collections.abc import Callable
import threading
from typing import Any

SAVED_STATUS = "保存済み"
DIRTY_STATUS = "未保存..."


class ScratchpadAutosave:
    """常時保持メモの本文・未保存状態・保存タイマーをまとめる。"""

    def __init__(
        self,
        save: Callable[[str], Any],
        *,
        delay: float = 0.6,
        timer_factory: Callable[[float, Callable[[], None]], Any] = threading.Timer,
        on_status: Callable[[str], None] = lambda status: None,
    ) -> None:
        self._save = save
        self._delay = delay
        self._timer_factory = timer_factory
        self._on_status = on_status
        self._state_lock = threading.Lock()
        self._save_lock = threading.Lock()
        self._text = ""
        self._revision = 0
        self._saved_revision = 0
        self._timer: Any = None

    @property
    def text(self) -> str:
        """現在のメモ本文。"""
        return self._text

    @property
    def dirty(self) -> bool:
        """まだバックエンドへ届いていない編集があるか。"""
        return self._revision != self._saved_revision

    def load(self, text: str) -> bool:
        """
        サーバーから読んだメモを反映する。手元で一度も編集していないときだけ反映し、反映したら True を返す。
        （編集した後は、読み込みと保存が行き違って新しい内容を古い値で消さないよう反映しない）
        """
        with self._state_lock:
            if self._revision != 0:
                return False
            self._text = str(text or "")
            return True

    def update(self, text: str) -> None:
        """入力された本文を記録し、保存タイマーを掛け直す。"""
        with self._state_lock:
            self._text = str(text or "")
            self._revision += 1
            self._cancel_timer_locked()
            timer = self._timer_factory(self._delay, self.flush)
            timer.daemon = True
            self._timer = timer
        self._on_status(DIRTY_STATUS)
        timer.start()

    def cancel(self) -> None:
        """保存タイマーを止める（未保存の状態は残す）。"""
        with self._state_lock:
            self._cancel_timer_locked()

    def flush(self) -> bool:
        """未保存の編集があれば保存する。保存できた（または保存不要だった）ら True。"""
        with self._save_lock:
            with self._state_lock:
                self._cancel_timer_locked()
                if self._revision == self._saved_revision:
                    return True
                text, revision = self._text, self._revision
            try:
                self._save(text)
            except Exception as error:  # 通信・サーバーの失敗はすべて「未保存のまま」で扱う
                self._on_status(f"保存失敗: {error}")
                return False
            with self._state_lock:
                self._saved_revision = max(self._saved_revision, revision)
                still_dirty = self._revision != self._saved_revision
            self._on_status(DIRTY_STATUS if still_dirty else SAVED_STATUS)
            return True

    def _cancel_timer_locked(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
