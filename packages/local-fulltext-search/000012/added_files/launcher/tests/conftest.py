"""
ランチャーテスト共通の後始末。

仕様:
- 検索入力のデバウンスは threading.Timer で遅延実行される。テストが終わったあとにタイマーが発火すると、
  すでに閉じられた出力へログを書こうとしてエラーが出る（テスト結果とは無関係なノイズになる）。
- 各テストの終了時に、残っているタイマーを取り消して終了を待つ。
"""

import threading

import pytest


@pytest.fixture(autouse=True)
def cancel_pending_timers():
    """テスト中に開始され、まだ発火していないタイマーを取り消す。"""
    yield
    for thread in threading.enumerate():
        if isinstance(thread, threading.Timer):
            thread.cancel()
            thread.join(timeout=1.0)
