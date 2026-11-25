"""
見つからない検索対象フォルダの案内（missing_target_acknowledgements テーブル）。

登録した検索対象フォルダが、移動・削除・未接続のドライブ・権限不足で見つからないと、
その配下は更新されない（変更追跡も見送る）。気づけるように画面で利用者へ案内する。

仕様:
- 有効なローカルの検索対象のうち、フォルダが見つからないものを案内する。
- 確認済みにしたフォルダは再び案内しない。
- フォルダが見つかるようになったら確認済みを解除する（また見つからなくなったら案内する）。
- 確認済みは targets.id に紐づけ、検索対象を削除すると一緒に消える。
- インデックスや検索対象の登録は消さない（到達不能な対象を「消えた」と扱わない約束による）。
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from sqlite3 import Connection

from app.models.indexing import MissingTargetItem, MissingTargetListResponse
from app.services.path_service import AbsolutePathRequiredError, normalize_path
from app.services.search_target_store import is_existing_directory


class MissingTargetStore:
    """見つからない検索対象と、その確認済みの記録を扱う。"""

    def __init__(self, connection: Connection) -> None:
        self.connection = connection

    def list_unacknowledged(self) -> MissingTargetListResponse:
        """フォルダが見つからず、まだ確認していない有効なローカル検索対象を返す。"""
        rows = self.connection.execute(
            """
            SELECT t.id, t.full_path, a.target_id IS NOT NULL AS is_acknowledged
            FROM targets t
            LEFT JOIN missing_target_acknowledgements a ON a.target_id = t.id
            WHERE t.source_type = 'local' AND t.is_search_target_enabled = 1
            ORDER BY t.full_path
            """
        ).fetchall()
        items: list[MissingTargetItem] = []
        found_again: list[int] = []
        for row in rows:
            if is_existing_directory(Path(str(row[1]))):
                if row[2]:
                    found_again.append(int(row[0]))
            elif not row[2]:
                items.append(MissingTargetItem(full_path=normalize_path(str(row[1])).as_posix()))
        if found_again:
            self.connection.executemany(
                "DELETE FROM missing_target_acknowledgements WHERE target_id = ?",
                [(target_id,) for target_id in found_again],
            )
            self.connection.commit()
        return MissingTargetListResponse(items=items)

    def acknowledge(self, full_paths: Iterable[str]) -> int:
        """案内したフォルダを確認済みにして、新しく確認済みになった件数を返す。"""
        acknowledged_at = datetime.now(UTC).isoformat()
        count = 0
        for full_path in full_paths:
            try:
                normalized_path = normalize_path(full_path).as_posix()
            except AbsolutePathRequiredError:
                continue
            row = self.connection.execute(
                "SELECT id FROM targets WHERE full_path = ? AND source_type = 'local'",
                (normalized_path,),
            ).fetchone()
            if row is None:
                continue
            cursor = self.connection.execute(
                """
                INSERT INTO missing_target_acknowledgements(target_id, acknowledged_at) VALUES (?, ?)
                ON CONFLICT(target_id) DO NOTHING
                """,
                (int(row[0]), acknowledged_at),
            )
            count += cursor.rowcount
        self.connection.commit()
        return count
