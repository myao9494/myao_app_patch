"""
走査でたどらなかったフォルダのリンク（ジャンクション・シンボリックリンク）の記録（skipped_links テーブル）。

リンクの先にある文書は検索できないので、見つけたものを画面で利用者へ案内する。

仕様:
- 走査のたびに、その走査で見たリンクへ記録を揃える。
- 確認済みのリンクは再び案内しない。元のフォルダが変わったら、また案内する。
- 走査で見つからなかったリンクは記録を消す。ただし、読めなかったフォルダがある走査と、
  走査の階層より深いリンクは、無くなったとは言えないので残す。
- 検索対象から外したフォルダのリンクは案内しない。
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from datetime import UTC, datetime
from sqlite3 import Connection

from app.models.indexing import SkippedLinkItem, SkippedLinkListResponse
from app.services import exclude_rules
from app.services.file_walker import SkippedLink
from app.services.index_scope import is_path_within_index_depth
from app.services.path_service import get_descendant_path_range


class SkippedLinkStore:
    """たどらなかったリンクの記録を読み書きする。"""

    def __init__(self, connection: Connection) -> None:
        self.connection = connection

    def sync(
        self,
        root_path: str,
        index_depth: int,
        links: Mapping[str, SkippedLink],
        *,
        keep_missing: bool,
    ) -> None:
        """root_path の走査で見つけたリンクへ記録を揃える。"""
        detected_at = datetime.now(UTC).isoformat()
        self.connection.executemany(
            """
            INSERT INTO skipped_links(link_path, target_path, link_type, detected_at, acknowledged_at)
            VALUES (?, ?, ?, ?, NULL)
            ON CONFLICT(link_path) DO UPDATE SET
                link_type = excluded.link_type,
                acknowledged_at = CASE
                    WHEN skipped_links.target_path = excluded.target_path THEN skipped_links.acknowledged_at
                END,
                target_path = excluded.target_path
            """,
            [(link.link_path, link.target_path, link.link_type, detected_at) for link in links.values()],
        )
        if not keep_missing:
            self._delete_missing(root_path, index_depth, links)
        self.connection.commit()

    def _delete_missing(self, root_path: str, index_depth: int, links: Mapping[str, SkippedLink]) -> None:
        """走査の範囲にあるはずなのに見つからなかったリンクの記録を消す。"""
        lower, upper = get_descendant_path_range(root_path)
        rows = self.connection.execute(
            "SELECT link_path FROM skipped_links WHERE link_path >= ? AND link_path < ?",
            (lower, upper),
        ).fetchall()
        # リンクの中へ入るのは階層の上限より浅いときだけなので、記録されるのも 1 つ浅い階層まで
        missing = [
            str(row[0])
            for row in rows
            if str(row[0]) not in links
            and is_path_within_index_depth(str(row[0]), root_path=root_path, index_depth=index_depth - 1)
        ]
        self.connection.executemany("DELETE FROM skipped_links WHERE link_path = ?", [(path,) for path in missing])

    def list_unacknowledged(self, search_roots: Sequence[str]) -> SkippedLinkListResponse:
        """検索対象にあるリンクのうち、まだ確認していないものを返す。"""
        rows = self.connection.execute(
            """
            SELECT link_path, target_path, link_type
            FROM skipped_links
            WHERE acknowledged_at IS NULL
            ORDER BY link_path
            """
        ).fetchall()
        return SkippedLinkListResponse(
            items=[
                SkippedLinkItem(
                    link_path=str(row[0]),
                    target_path=str(row[1]),
                    link_type=str(row[2]),
                    is_covered=bool(exclude_rules.find_enclosing_root(str(row[1]), search_roots)),
                )
                for row in rows
                if exclude_rules.find_enclosing_root(str(row[0]), search_roots)
            ]
        )

    def acknowledge(self, link_paths: Iterable[str]) -> int:
        """リンクを確認済みにして、確認済みになった件数を返す。"""
        acknowledged_at = datetime.now(UTC).isoformat()
        count = 0
        for link_path in link_paths:
            cursor = self.connection.execute(
                "UPDATE skipped_links SET acknowledged_at = ? WHERE link_path = ? AND acknowledged_at IS NULL",
                (acknowledged_at, link_path),
            )
            count += cursor.rowcount
        self.connection.commit()
        return count
