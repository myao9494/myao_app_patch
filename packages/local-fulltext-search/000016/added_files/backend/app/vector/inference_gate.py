"""
Embedding 推論の順番待ち。

仕様:
- 推論は同時に 1 つだけ実行する（Sentence Transformers のモデルはスレッド安全ではなく、MPS では並行実行で落ちる）。
- 検索クエリの推論（query）を、インデックス作成の推論（batch）より優先する。
  順番待ちの検索クエリがある間は、インデックス作成は次の区切りを始めない。
- インデックス作成は推論を小さな区切りに分けて区切りごとに batch() を取り直す。
  これにより、検索クエリが待つのは「いま実行中の 1 区切り」だけになり、大きなファイルの推論完了を待たない。
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager


class InferenceGate:
    """推論を 1 つずつ実行し、検索クエリを優先する順番待ち。"""

    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._busy = False
        self._pending_queries = 0

    @property
    def pending_queries(self) -> int:
        """順番待ちをしている検索クエリの数。"""
        with self._condition:
            return self._pending_queries

    @contextmanager
    def query(self) -> Iterator[None]:
        """検索クエリの推論区間。実行中の区切りが終われば、待っているインデックス作成より先に実行する。"""
        with self._condition:
            self._pending_queries += 1
            try:
                while self._busy:
                    self._condition.wait()
            finally:
                self._pending_queries -= 1
            self._busy = True
        try:
            yield
        finally:
            self._release()

    @contextmanager
    def batch(self) -> Iterator[None]:
        """インデックス作成の推論 1 区切り分の区間。順番待ちの検索クエリが無くなるまで始めない。"""
        with self._condition:
            while self._busy or self._pending_queries:
                self._condition.wait()
            self._busy = True
        try:
            yield
        finally:
            self._release()

    def _release(self) -> None:
        with self._condition:
            self._busy = False
            self._condition.notify_all()
