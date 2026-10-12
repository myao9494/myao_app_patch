"""
インデックス実行状態（index_runs テーブル）と中止要求の管理。

実行中フラグは DB に 1 行だけ持ち、検索前更新・変更通知・スケジューラーなど複数の契機が
同時に走査を始めないようにする。中止要求は同じプロセス内ではメモリ上のフラグで、
別プロセス・別接続からは DB のフラグで受け取る。
"""

from __future__ import annotations

import threading
import time as time_module
from dataclasses import dataclass
from datetime import UTC, datetime
from sqlite3 import Connection

from fastapi import HTTPException, status

from app.models.indexing import IndexStatusResponse

# 別接続からの中止要求を DB へ確認しに行く最短間隔。走査速度へ影響しない程度に間引く。
CANCEL_DATABASE_POLL_INTERVAL_SECONDS = 0.25


class IndexingCancelledError(Exception):
    """
    利用者がインデックス中止を要求したことを表す。
    """


class IndexAlreadyRunningError(Exception):
    """
    別のインデックス処理が実行中のため、新しい走査を開始できなかったことを表す。
    """


class IndexRunController:
    """
    DB接続ごとに、インデックス中止要求の状態を保持する。
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cancel_requested = False
        self._last_database_check_at = 0.0

    def reset(self) -> None:
        with self._lock:
            self._cancel_requested = False
            self._last_database_check_at = 0.0

    def request_cancel(self) -> None:
        with self._lock:
            self._cancel_requested = True

    def is_cancel_requested(self) -> bool:
        with self._lock:
            return self._cancel_requested

    def should_check_database_cancel(self, *, now: float, interval_seconds: float) -> bool:
        with self._lock:
            if now - self._last_database_check_at < interval_seconds:
                return False
            self._last_database_check_at = now
            return True


@dataclass(frozen=True)
class TargetIndexResult:
    """
    1 つの検索対象を走査した結果。
    exclude_keywords は、走査中に自動で除外したパス（到達不能な共有先など）を加えた除外条件。
    """

    file_count: int
    error_count: int
    exclude_keywords: str


class IndexRunState:
    """index_runs テーブルの 1 行と、この接続で受けた中止要求を扱う。"""

    def __init__(self, connection: Connection) -> None:
        self.connection = connection
        self.controller = IndexRunController()

    def is_running(self) -> bool:
        """インデックス処理が実行中かを返す。"""
        row = self.connection.execute("SELECT is_running FROM index_runs WHERE id = 1").fetchone()
        return bool(row["is_running"]) if row else False

    def try_begin(self, *, started_at: str) -> bool:
        """
        実行中フラグを「未実行のときだけ」立てる。立てられた場合だけ True を返す。
        確認と設定を 1 つの UPDATE で行うため、複数の契機（検索前更新・変更通知・スケジューラー）が
        同時に走査を始めることはない。
        """
        cursor = self.connection.execute(
            """
            UPDATE index_runs
            SET is_running = 1,
                cancel_requested = 0,
                last_started_at = ?,
                last_error = NULL
            WHERE id = 1 AND is_running = 0
            """,
            (started_at,),
        )
        self.connection.commit()
        return cursor.rowcount == 1

    def update(
        self,
        *,
        is_running: bool | None = None,
        cancel_requested: bool | None = None,
        last_started_at: str | None = None,
        last_finished_at: str | None = None,
        last_error: str | None = None,
        total_files: int | None = None,
        error_count: int | None = None,
    ) -> None:
        """
        インデックス実行ステータスを更新する。
        """
        self.connection.execute(
            """
            UPDATE index_runs
            SET is_running = COALESCE(?, is_running),
                cancel_requested = COALESCE(?, cancel_requested),
                last_started_at = COALESCE(?, last_started_at),
                last_finished_at = COALESCE(?, last_finished_at),
                last_error = ?,
                total_files = COALESCE(?, total_files),
                error_count = COALESCE(?, error_count)
            WHERE id = 1
            """,
            (
                int(is_running) if is_running is not None else None,
                int(cancel_requested) if cancel_requested is not None else None,
                last_started_at,
                last_finished_at,
                last_error,
                total_files,
                error_count,
            ),
        )
        self.connection.commit()

    def get_status(self) -> IndexStatusResponse:
        """直近の実行状態（開始・終了時刻、件数、エラー）を返す。"""
        row = self.connection.execute(
            """
            SELECT last_started_at, last_finished_at, total_files, error_count, is_running, last_error
                   , cancel_requested
            FROM index_runs
            WHERE id = 1
            """
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Index status unavailable.")
        return IndexStatusResponse.model_validate(dict(row))

    def request_cancel(self) -> None:
        """
        実行中インデックスへ中止要求を送る。
        """
        self.controller.request_cancel()
        self.update(cancel_requested=True)

    def raise_if_cancel_requested(self) -> None:
        """
        中止要求が来ていたら即座に処理を打ち切る。
        別プロセス・別接続からの要求は、速度影響を避けるため短い間隔で DB を確認する。
        """
        if self.controller.is_cancel_requested():
            raise IndexingCancelledError("Indexing was cancelled.")
        should_check_database = self.controller.should_check_database_cancel(
            now=time_module.monotonic(),
            interval_seconds=CANCEL_DATABASE_POLL_INTERVAL_SECONDS,
        )
        if should_check_database and self._is_cancel_requested_in_database():
            raise IndexingCancelledError("Indexing was cancelled.")

    def _is_cancel_requested_in_database(self) -> bool:
        """
        プロセスをまたいで共有される中止要求フラグを読み取る。
        """
        row = self.connection.execute("SELECT cancel_requested FROM index_runs WHERE id = 1").fetchone()
        return bool(row["cancel_requested"]) if row else False

    def recover_interrupted(self) -> bool:
        """前回プロセスの終了で残った実行中状態を、起動時に安全に解除する。"""
        if not self.is_running():
            return False
        self.update(
            is_running=False,
            cancel_requested=False,
            last_finished_at=datetime.now(UTC).isoformat(),
            last_error="Indexing was interrupted by application restart.",
        )
        return True
