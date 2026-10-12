"""
インデックス済みファイル（files / file_segments / failed_files テーブル）の読み書き。

- file_segments は必ず明示的に DELETE してから files を消す（FTS5 の削除トリガーを確実に発火させるため）。
- 配下ファイルの検索は LIKE ではなく範囲条件を使い、normalized_path の索引を使う。
- commit の単位は呼び出し側が決める（走査中はまとめて commit する）。自分で commit するメソッドはその旨を書く。
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from sqlite3 import Connection

from app.extractors.obsidian_properties import extract_obsidian_title_and_aliases, has_obsidian_top_tag
from app.models.indexing import (
    FailedFileItem,
    FailedFileListResponse,
    IndexedTargetItem,
    IndexedTargetListResponse,
)
from app.services import index_scope, web_pages
from app.services.cjk_bigram import build_cjk_bigram_index_content
from app.services.path_service import get_descendant_path_range, normalize_path

DELETE_CHUNK_SIZE = 500


@dataclass(frozen=True)
class IndexedFileCandidate:
    """
    インデックス対象ファイルの事前計算済みメタデータを保持する。
    """

    path: Path
    normalized_path: str
    created_at: float
    mtime: float
    size: int
    file_ext: str
    existing_id: int | None


@dataclass(frozen=True)
class IndexedWebPageCandidate:
    """
    Web ページのメタデータと抽出済み本文を保持する。
    """

    url: str
    title: str
    content: str
    fetched_at: float
    size: int
    existing_id: int | None


class IndexedFileStore:
    """files / file_segments / failed_files テーブルを扱う。"""

    def __init__(self, connection: Connection) -> None:
        self.connection = connection

    def commit(self) -> None:
        self.connection.commit()

    def rollback(self) -> None:
        self.connection.rollback()

    def load_existing_files(self, root_path: str) -> dict[str, dict[str, object]]:
        """
        対象ルート配下の既存メタデータを一括取得し、差分判定を高速化する。
        LIKE の代わりに範囲クエリを使い B-tree インデックスを活用する。
        Web ページ URL が root_path そのものとして登録される場合もあるため、完全一致も含める。
        """
        prefix_start, prefix_end = get_descendant_path_range(root_path)
        rows = self.connection.execute(
            """
            SELECT id, normalized_path, mtime, size, last_error, file_ext
            FROM files
            WHERE normalized_path = ?
               OR (normalized_path >= ? AND normalized_path < ?)
            """,
            (root_path, prefix_start, prefix_end),
        ).fetchall()
        return {str(row["normalized_path"]): dict(row) for row in rows}

    def load_failed_file_times(self, root_path: str) -> dict[str, float]:
        """
        対象ルート配下の失敗ファイルについて、最後に失敗した時刻（UNIX 秒）を返す。
        """
        prefix_start, prefix_end = get_descendant_path_range(root_path)
        rows = self.connection.execute(
            """
            SELECT normalized_path, last_failed_at
            FROM failed_files
            WHERE normalized_path >= ? AND normalized_path < ?
            """,
            (prefix_start, prefix_end),
        ).fetchall()
        failed_times: dict[str, float] = {}
        for row in rows:
            try:
                failed_times[str(row["normalized_path"])] = datetime.fromisoformat(str(row["last_failed_at"])).timestamp()
            except ValueError:
                continue
        return failed_times

    def upsert_file(self, *, candidate: IndexedFileCandidate, content: str | None) -> None:
        """
        ファイルメタデータと本文セグメントを upsert する。
        画像など本文を持たないファイルは files テーブルだけへ登録する。
        """
        indexed_at = datetime.now(UTC).isoformat()
        has_top_tag = int(candidate.file_ext == ".md" and content is not None and has_obsidian_top_tag(content))
        obsidian_title, obsidian_aliases = (
            extract_obsidian_title_and_aliases(content)
            if candidate.file_ext == ".md" and content is not None
            else ("", ())
        )
        obsidian_aliases_text = "\n".join(obsidian_aliases)
        if candidate.existing_id is not None:
            file_id = candidate.existing_id
            self.connection.execute(
                """
                UPDATE files
                SET full_path = ?, file_name = ?, file_ext = ?,
                    created_at = ?, mtime = ?, size = ?, indexed_at = ?, last_error = NULL,
                    has_obsidian_top_tag = ?,
                    obsidian_title = ?, obsidian_aliases = ?,
                    source_type = 'local'
                WHERE id = ?
                """,
                (
                    candidate.normalized_path,
                    candidate.path.name,
                    candidate.file_ext,
                    candidate.created_at,
                    candidate.mtime,
                    candidate.size,
                    indexed_at,
                    has_top_tag,
                    obsidian_title,
                    obsidian_aliases_text,
                    file_id,
                ),
            )
            # 明示的 DELETE で FTS5 の AFTER DELETE トリガーを確実に発火させる
            self.connection.execute("DELETE FROM file_segments WHERE file_id = ?", (file_id,))
        else:
            cursor = self.connection.execute(
                """
                INSERT INTO files(
                    full_path, normalized_path,
                    file_name, file_ext, created_at, mtime, size, indexed_at, last_error,
                    has_obsidian_top_tag, obsidian_title, obsidian_aliases, source_type
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'local')
                """,
                (
                    candidate.normalized_path,
                    candidate.normalized_path,
                    candidate.path.name,
                    candidate.file_ext,
                    candidate.created_at,
                    candidate.mtime,
                    candidate.size,
                    indexed_at,
                    has_top_tag,
                    obsidian_title,
                    obsidian_aliases_text,
                ),
            )
            file_id = int(cursor.lastrowid)

        if content is not None and content.strip():
            self.connection.execute(
                """
                INSERT INTO file_segments(file_id, segment_type, segment_label, content)
                VALUES (?, ?, ?, ?)
                """,
                (file_id, "body", candidate.normalized_path, content),
            )
            cjk_bigram_content = build_cjk_bigram_index_content(content)
            if cjk_bigram_content:
                self.connection.execute(
                    """
                    INSERT INTO file_segments(file_id, segment_type, segment_label, content)
                    VALUES (?, ?, ?, ?)
                    """,
                    (file_id, "cjk_bigram", candidate.normalized_path, cjk_bigram_content),
                )

    def upsert_web_page(self, candidate: IndexedWebPageCandidate) -> None:
        """
        Web ページを files と本文セグメントへ upsert する。
        """
        indexed_at = datetime.now(UTC).isoformat()
        if candidate.existing_id is not None:
            file_id = candidate.existing_id
            self.connection.execute(
                """
                UPDATE files
                SET full_path = ?, file_name = ?, file_ext = ?,
                    created_at = ?, mtime = ?, size = ?, indexed_at = ?, last_error = NULL,
                    source_type = 'web'
                WHERE id = ?
                """,
                (
                    candidate.url,
                    candidate.title,
                    ".html",
                    candidate.fetched_at,
                    candidate.fetched_at,
                    candidate.size,
                    indexed_at,
                    file_id,
                ),
            )
            self.connection.execute("DELETE FROM file_segments WHERE file_id = ?", (file_id,))
        else:
            cursor = self.connection.execute(
                """
                INSERT INTO files(
                    full_path, normalized_path,
                    file_name, file_ext, created_at, mtime, size, indexed_at, last_error, source_type
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'web')
                """,
                (
                    candidate.url,
                    candidate.url,
                    candidate.title,
                    ".html",
                    candidate.fetched_at,
                    candidate.fetched_at,
                    candidate.size,
                    indexed_at,
                ),
            )
            file_id = int(cursor.lastrowid)

        if candidate.content.strip():
            self.connection.execute(
                """
                INSERT INTO file_segments(file_id, segment_type, segment_label, content)
                VALUES (?, ?, ?, ?)
                """,
                (file_id, "body", candidate.url, candidate.content),
            )
            cjk_bigram_content = build_cjk_bigram_index_content(candidate.content)
            if cjk_bigram_content:
                self.connection.execute(
                    """
                    INSERT INTO file_segments(file_id, segment_type, segment_label, content)
                    VALUES (?, ?, ?, ?)
                    """,
                    (file_id, "cjk_bigram", candidate.url, cjk_bigram_content),
                )

    def record_file_error(self, path: Path, error: Exception) -> None:
        """本文抽出の失敗を failed_files へ記録する。既に files に行があれば、その行にも失敗を残す。"""
        normalized_path = path.resolve().as_posix()
        error_message = str(error)
        row = self.connection.execute("SELECT id FROM files WHERE normalized_path = ?", (normalized_path,)).fetchone()
        if row is not None:
            self.connection.execute(
                "UPDATE files SET last_error = ? WHERE id = ?",
                (error_message, int(row["id"])),
            )
        self.connection.execute(
            """
            INSERT INTO failed_files(normalized_path, file_name, error_message, last_failed_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(normalized_path) DO UPDATE SET
                file_name = excluded.file_name,
                error_message = excluded.error_message,
                last_failed_at = excluded.last_failed_at
            """,
            (
                normalized_path,
                path.name,
                error_message,
                datetime.now(UTC).isoformat(),
            ),
        )

    def record_web_error(self, url: str, error: Exception) -> None:
        """
        Web ページ取得失敗を failed_files へ記録する。
        """
        self.connection.execute(
            """
            INSERT INTO failed_files(normalized_path, file_name, error_message, last_failed_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(normalized_path) DO UPDATE SET
                file_name = excluded.file_name,
                error_message = excluded.error_message,
                last_failed_at = excluded.last_failed_at
            """,
            (
                url,
                web_pages.resolve_web_file_name(url),
                str(error),
                datetime.now(UTC).isoformat(),
            ),
        )

    def remove_deleted_files(
        self,
        normalized_paths: set[str],
        *,
        root_path: str,
        index_depth: int | None = None,
        allowed_extensions: frozenset[str] | None = None,
        preloaded_existing_files: dict[str, dict[str, object]] | None = None,
        keyword_set: frozenset[str] | None = None,
        substring_keywords: list[str] | None = None,
        excluded_path_prefixes: tuple[str, ...] | None = None,
    ) -> None:
        """
        DB 上に存在するが今回の走査責任範囲に含まれなくなったレコードをバッチ削除する。
        file_segments を先に明示的に DELETE して FTS5 トリガーを発火させてから files を削除する。
        """
        if preloaded_existing_files is None:
            prefix_start, prefix_end = get_descendant_path_range(root_path)
            rows = self.connection.execute(
                """
                SELECT id, normalized_path, file_ext
                FROM files
                WHERE normalized_path = ?
                   OR (normalized_path >= ? AND normalized_path < ?)
                """,
                (root_path, prefix_start, prefix_end),
            ).fetchall()
        else:
            rows = tuple(preloaded_existing_files.values())
        deleted_ids = [
            int(row["id"])
            for row in rows
            if str(row["normalized_path"]) not in normalized_paths
            and index_scope.is_path_within_index_depth(
                str(row["normalized_path"]),
                root_path=root_path,
                index_depth=index_depth,
            )
            and index_scope.is_path_within_extension_scope(
                str(row["normalized_path"]),
                file_ext=str(row["file_ext"] or ""),
                allowed_extensions=allowed_extensions,
            )
            and not index_scope.is_path_excluded_from_current_scope(
                str(row["normalized_path"]),
                keyword_set=keyword_set,
                substring_keywords=substring_keywords,
                excluded_path_prefixes=excluded_path_prefixes,
            )
        ]
        self.delete_file_rows(deleted_ids)

    def clear_resolved_failed_files(
        self,
        *,
        root_path: str,
        failed_paths: set[str],
        index_depth: int | None = None,
        allowed_extensions: frozenset[str] | None = None,
        keyword_set: frozenset[str] | None = None,
        substring_keywords: list[str] | None = None,
        excluded_path_prefixes: tuple[str, ...] | None = None,
    ) -> None:
        """
        今回失敗していない過去ログを対象ルート配下の走査責任範囲から掃除する。
        成功済み・削除済みファイルが一覧に残り続けないようにする。
        """
        prefix_start, prefix_end = get_descendant_path_range(root_path)
        rows = self.connection.execute(
            """
            SELECT normalized_path
            FROM failed_files
            WHERE normalized_path = ?
               OR (normalized_path >= ? AND normalized_path < ?)
            """,
            (root_path, prefix_start, prefix_end),
        ).fetchall()
        stale_paths = [
            str(row["normalized_path"])
            for row in rows
            if str(row["normalized_path"]) not in failed_paths
            and index_scope.is_path_within_index_depth(
                str(row["normalized_path"]),
                root_path=root_path,
                index_depth=index_depth,
            )
            and index_scope.is_path_within_extension_scope(
                str(row["normalized_path"]),
                allowed_extensions=allowed_extensions,
            )
            and not index_scope.is_path_excluded_from_current_scope(
                str(row["normalized_path"]),
                keyword_set=keyword_set,
                substring_keywords=substring_keywords,
                excluded_path_prefixes=excluded_path_prefixes,
            )
        ]
        if not stale_paths:
            return
        for index in range(0, len(stale_paths), DELETE_CHUNK_SIZE):
            chunk = stale_paths[index : index + DELETE_CHUNK_SIZE]
            placeholders = ",".join("?" * len(chunk))
            self.connection.execute(f"DELETE FROM failed_files WHERE normalized_path IN ({placeholders})", chunk)

    def delete_rows_under(self, root_path: str) -> None:
        """
        対象フォルダ配下の files / file_segments / failed_files をまとめて削除する。
        """
        prefix_start, prefix_end = get_descendant_path_range(root_path)
        rows = self.connection.execute(
            """
            SELECT id
            FROM files
            WHERE normalized_path = ?
               OR (normalized_path >= ? AND normalized_path < ?)
            """,
            (root_path, prefix_start, prefix_end),
        ).fetchall()
        self._delete_files_by_ids([int(row["id"]) for row in rows])

        self.connection.execute(
            """
            DELETE FROM failed_files
            WHERE normalized_path = ?
               OR (normalized_path >= ? AND normalized_path < ?)
            """,
            (root_path, prefix_start, prefix_end),
        )

    def delete_file_rows(self, file_ids: Iterable[int]) -> None:
        """
        files 行をまとめて削除する。
        file_segments を先に明示的に DELETE して FTS5 トリガーを発火させてから files を削除する。
        """
        target_ids = list(file_ids)
        if not target_ids:
            return
        self._delete_files_by_ids(target_ids)
        self.connection.commit()

    def _delete_files_by_ids(self, file_ids: list[int]) -> None:
        """files 行を分割して削除する（commit はしない）。file_segments を先に消して FTS5 の削除トリガーを発火させる。"""
        for start in range(0, len(file_ids), DELETE_CHUNK_SIZE):
            chunk = file_ids[start : start + DELETE_CHUNK_SIZE]
            placeholders = ",".join("?" * len(chunk))
            self.connection.execute(f"DELETE FROM file_segments WHERE file_id IN ({placeholders})", chunk)
            self.connection.execute(f"DELETE FROM files WHERE id IN ({placeholders})", chunk)

    def delete_failed_file_rows(self, should_delete: Callable[[str], bool]) -> None:
        """failed_files のうち、条件に合致するパスの行をまとめて削除する。"""
        rows = self.connection.execute("SELECT id, normalized_path FROM failed_files").fetchall()
        target_ids = [int(row["id"]) for row in rows if should_delete(str(row["normalized_path"]))]
        if not target_ids:
            return
        for start in range(0, len(target_ids), DELETE_CHUNK_SIZE):
            chunk = target_ids[start : start + DELETE_CHUNK_SIZE]
            placeholders = ",".join("?" * len(chunk))
            self.connection.execute(f"DELETE FROM failed_files WHERE id IN ({placeholders})", chunk)
        self.connection.commit()

    def list_failed_files(self) -> FailedFileListResponse:
        """
        直近のインデックス処理で取得に失敗したファイル一覧を返す。
        """
        rows = self.connection.execute(
            """
            SELECT normalized_path, file_name, error_message, last_failed_at
            FROM failed_files
            ORDER BY last_failed_at DESC, normalized_path ASC
            """
        ).fetchall()
        return FailedFileListResponse(items=[FailedFileItem.model_validate(dict(row)) for row in rows])

    def list_indexed_targets(self, *, source_type: str = "local") -> IndexedTargetListResponse:
        """
        UI 向けに、実際にインデックス済みファイルが存在する全フォルダ一覧を返す。
        件数は各フォルダ直下のファイル数とし、子孫フォルダの件数は親へ合算しない。
        """
        if source_type == "web":
            rows = self.connection.execute(
                """
                SELECT normalized_path, indexed_at
                FROM files
                WHERE source_type = 'web'
                ORDER BY indexed_at DESC, normalized_path ASC
                """
            ).fetchall()
            return IndexedTargetListResponse(
                items=[
                    IndexedTargetItem(
                        full_path=str(row["normalized_path"]),
                        source_type="web",
                        last_indexed_at=row["indexed_at"],
                        indexed_file_count=1,
                    )
                    for row in rows
                ]
            )

        rows = self.connection.execute(
            """
            SELECT
                normalized_path,
                indexed_at
            FROM files
            WHERE source_type = 'local'
            ORDER BY normalized_path ASC
            """
        ).fetchall()
        target_rows = self.connection.execute(
            """
            SELECT full_path
            FROM targets
            WHERE last_indexed_at IS NOT NULL
              AND source_type = 'local'
            ORDER BY length(full_path) DESC
            """
        ).fetchall()
        target_roots = [str(row["full_path"]) for row in target_rows]
        folder_map: dict[str, dict[str, object]] = {}
        for row in rows:
            file_path = normalize_path(str(row["normalized_path"]))
            expanded_paths = index_scope.expand_indexed_folder_paths(file_path, target_roots)
            direct_folder_path = str(Path(file_path).parent.as_posix())
            indexed_at = row["indexed_at"]
            for folder_path in expanded_paths:
                folder_entry = folder_map.get(folder_path)
                if folder_entry is None:
                    folder_map[folder_path] = {
                        "full_path": folder_path,
                        "source_type": "local",
                        "last_indexed_at": indexed_at,
                        "indexed_file_count": 0,
                    }
                    folder_entry = folder_map[folder_path]
                if folder_path == direct_folder_path:
                    folder_entry["indexed_file_count"] = int(folder_entry["indexed_file_count"]) + 1
                current_last = folder_entry["last_indexed_at"]
                if current_last is None or str(indexed_at) > str(current_last):
                    folder_entry["last_indexed_at"] = indexed_at

        items = [
            IndexedTargetItem.model_validate(item)
            for item in sorted(
                folder_map.values(),
                key=lambda item: (str(item["last_indexed_at"]), str(item["full_path"])),
                reverse=True,
            )
        ]
        return IndexedTargetListResponse(items=items)
