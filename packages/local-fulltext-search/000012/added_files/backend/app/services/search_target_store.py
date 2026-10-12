"""
検索対象（targets テーブル）の登録・状態・更新要否の判定。

検索対象はローカルフォルダまたは Web URL。対象ごとに、最後に走査した条件（除外キーワード・階層・拡張子）と
時刻を保存し、条件が変わったとき・更新間隔を過ぎたとき・変更通知で dirty になったときだけ再走査する。
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from sqlite3 import Connection, OperationalError

from fastapi import HTTPException, status

from app.models.indexing import SearchTargetItem, SearchTargetListResponse
from app.services import app_settings_store, exclude_rules, index_scope, web_pages
from app.services.path_service import AbsolutePathRequiredError, normalize_path

# 索引の作り方を変えたときに上げる。保存済みの値がこれより小さい対象は次回必ず再走査する。
CURRENT_TARGET_INDEX_VERSION = 1


def is_existing_directory(path: Path) -> bool:
    """
    権限不足や未接続 UNC パスを存在しないディレクトリとして扱う。
    """
    try:
        return path.exists() and path.is_dir()
    except OSError:
        return False


def normalize_target_path_or_raise(full_path: str) -> str:
    """
    対象パスを正規化し、絶対パス以外は 400 エラーに変換する。
    """
    try:
        return normalize_path(full_path).as_posix()
    except AbsolutePathRequiredError as error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Folder path must be an absolute path or Windows UNC path.",
        ) from error


def normalize_target_identifier_or_raise(full_path: str) -> tuple[str, str]:
    """
    ローカルフォルダまたは Web URL を検索対象識別子として正規化する。
    """
    if web_pages.is_web_url(full_path):
        return web_pages.normalize_web_url(full_path), "web"
    return normalize_target_path_or_raise(full_path), "local"


class SearchTargetStore:
    """targets テーブルと、変更追跡の dirty 状態（target_change_states）を扱う。"""

    def __init__(self, connection: Connection) -> None:
        self.connection = connection

    def ensure_target(
        self,
        *,
        full_path: str,
        exclude_keywords: str,
        index_depth: int,
        selected_extensions: str,
    ) -> dict[str, object]:
        """検索対象の行を返す。未登録なら有効な検索対象として登録する。ローカルは実在するフォルダだけを受け付ける。"""
        normalized_identifier, source_type = normalize_target_identifier_or_raise(full_path)
        if source_type == "local":
            normalized_path = normalize_path(normalized_identifier)
            if not is_existing_directory(normalized_path):
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Folder path must be an existing directory.")
            stored_path = normalized_path.as_posix()
        else:
            stored_path = normalized_identifier

        row = self.connection.execute(
            """
            SELECT
                id, full_path, last_indexed_at, exclude_keywords, index_depth, selected_extensions,
                is_search_target_enabled,
                indexed_file_count, index_version, source_type, created_at, updated_at
            FROM targets
            WHERE full_path = ?
            """,
            (stored_path,),
        ).fetchone()
        if row is not None:
            return dict(row)

        now = datetime.now(UTC).isoformat()
        cursor = self.connection.execute(
            """
            INSERT INTO targets(
                full_path, last_indexed_at, exclude_keywords, index_depth, selected_extensions,
                is_search_target_enabled, indexed_file_count, index_version, source_type, created_at, updated_at
            )
            VALUES (?, NULL, ?, ?, ?, 1, 0, 0, ?, ?, ?)
            """,
            (stored_path, exclude_keywords, index_depth, selected_extensions, source_type, now, now),
        )
        self.connection.commit()
        created = self.connection.execute(
            """
            SELECT
                id, full_path, last_indexed_at, exclude_keywords, index_depth, selected_extensions,
                is_search_target_enabled,
                indexed_file_count, index_version, source_type, created_at, updated_at
            FROM targets
            WHERE id = ?
            """,
            (cursor.lastrowid,),
        ).fetchone()
        return dict(created)

    def needs_refresh(
        self,
        target: dict[str, object],
        refresh_window_minutes: int,
        exclude_keywords: str,
        index_depth: int,
        selected_extensions: str,
    ) -> bool:
        """
        検索対象を走査し直す必要があるかを返す。
        未走査・走査条件の変更・索引形式の更新があれば True。変更追跡中の対象は dirty かどうかで決め、
        それ以外は前回の走査から refresh_window_minutes 分を過ぎていれば True。
        """
        last_indexed_at = target["last_indexed_at"]
        if last_indexed_at is None:
            return True
        if str(target.get("exclude_keywords") or "") != exclude_keywords:
            return True
        if int(target.get("index_depth") or 0) != index_depth:
            return True
        if str(target.get("selected_extensions") or "") != selected_extensions:
            return True
        if int(target.get("index_version") or 0) < CURRENT_TARGET_INDEX_VERSION:
            return True
        change_state = self.connection.execute(
            "SELECT is_tracking, is_dirty FROM target_change_states WHERE target_id = ?",
            (int(target["id"]),),
        ).fetchone()
        if change_state is not None and bool(change_state["is_tracking"]):
            return bool(change_state["is_dirty"])
        indexed_at = datetime.fromisoformat(str(last_indexed_at))
        elapsed_seconds = (datetime.now(UTC) - indexed_at).total_seconds()
        return elapsed_seconds > refresh_window_minutes * 60

    def resolve_enabled_covering_path(self, normalized_path: str, *, source_type: str = "local") -> str | None:
        """
        有効な検索対象フォルダのうち、指定パスを包含する最も深い親フォルダを返す。
        """
        try:
            enabled_rows = self.connection.execute(
                """
                SELECT full_path
                FROM targets
                WHERE is_search_target_enabled = 1
                  AND source_type = ?
                ORDER BY length(full_path) DESC
                """,
                (source_type,),
            ).fetchall()
        except OperationalError as error:
            if "no such column: is_search_target_enabled" in str(error) or "no such column: source_type" in str(error):
                return None
            raise
        for row in enabled_rows:
            root_path = str(row["full_path"])
            if normalized_path == root_path or normalized_path.startswith(f"{root_path}/"):
                return root_path
        return None

    def assert_indexing_allowed(self, full_path: str, *, source_type: str = "local") -> None:
        """
        検索対象フォルダが設定済みなら、その配下パスだけをインデックス許可する。
        """
        normalized_path = web_pages.normalize_web_url(full_path) if source_type == "web" else normalize_target_path_or_raise(full_path)
        covering_path = self.resolve_enabled_covering_path(normalized_path, source_type=source_type)
        if covering_path is not None:
            return
        try:
            enabled_count = self.connection.execute(
                "SELECT COUNT(*) AS count FROM targets WHERE is_search_target_enabled = 1 AND source_type = ?",
                (source_type,),
            ).fetchone()
        except OperationalError as error:
            if "no such column: is_search_target_enabled" in str(error) or "no such column: source_type" in str(error):
                return
            raise
        if enabled_count is None or int(enabled_count["count"] or 0) == 0:
            return
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Folder path is outside enabled search target folders.",
        )

    def mark_indexed(
        self,
        target_id: int,
        *,
        exclude_keywords: str,
        index_depth: int,
        selected_extensions: str,
        indexed_file_count: int,
    ) -> None:
        """走査した条件と時刻を保存し、変更追跡の dirty 状態を解除する。commit まで行う。"""
        now = datetime.now(UTC).isoformat()
        self.connection.execute(
            """
            UPDATE targets
            SET last_indexed_at = ?, exclude_keywords = ?, index_depth = ?, selected_extensions = ?,
                indexed_file_count = ?, index_version = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                now,
                exclude_keywords,
                index_depth,
                selected_extensions,
                indexed_file_count,
                CURRENT_TARGET_INDEX_VERSION,
                now,
                target_id,
            ),
        )
        self.connection.execute(
            "UPDATE target_change_states SET is_dirty = 0 WHERE target_id = ? AND is_tracking = 1",
            (target_id,),
        )
        self.connection.commit()

    def mark_overlapping_stale(self, folder_path: str) -> None:
        """
        削除対象と重なる targets は、次回検索時に必ず再インデックスされるよう last_indexed_at を外す。
        """
        rows = self.connection.execute(
            """
            SELECT id, full_path
            FROM targets
            """
        ).fetchall()
        now = datetime.now(UTC).isoformat()
        for row in rows:
            target_path = str(row["full_path"])
            if index_scope.paths_overlap(folder_path, target_path):
                self.connection.execute(
                    """
                    UPDATE targets
                    SET last_indexed_at = NULL, indexed_file_count = 0, updated_at = ?
                    WHERE id = ?
                    """,
                    (now, int(row["id"])),
                )

    def sync_exclude_keywords(self, *, old_global_keywords: str, new_global_keywords: str) -> None:
        """
        グローバル除外キーワードの削除を、既存の local ターゲット保存値へ反映する。
        ターゲット固有の追加除外や自動除外パスは維持する。
        """
        old_keywords = exclude_rules.parse_exclude_keywords(old_global_keywords)
        new_keywords = exclude_rules.parse_exclude_keywords(new_global_keywords)
        old_keys = {exclude_rules.normalize_keyword_identity(keyword) for keyword in old_keywords}
        new_keys = {exclude_rules.normalize_keyword_identity(keyword) for keyword in new_keywords}
        removed_keys = old_keys - new_keys
        if not removed_keys and not new_keywords:
            return

        rows = self.connection.execute(
            """
            SELECT id, exclude_keywords
            FROM targets
            WHERE source_type = 'local'
            """
        ).fetchall()
        for row in rows:
            target_keywords = exclude_rules.parse_exclude_keywords(str(row["exclude_keywords"] or ""))
            retained = [
                keyword for keyword in target_keywords if exclude_rules.normalize_keyword_identity(keyword) not in removed_keys
            ]
            merged = exclude_rules.normalize_keyword_list([*retained, *new_keywords])
            if merged == str(row["exclude_keywords"] or ""):
                continue
            self.connection.execute(
                """
                UPDATE targets
                SET exclude_keywords = ?, updated_at = ?
                WHERE id = ?
                """,
                (merged, datetime.now(UTC).isoformat(), int(row["id"])),
            )
        self.connection.commit()

    def sync_selected_extensions(self, *, new_selected_extensions: str) -> None:
        """
        グローバルインデックス対象拡張子の変更を、targets テーブルの selected_extensions へ同期する。
        ターゲット固有の拡張子指定がある場合は除外された拡張子を除去し、未指定のものは新設定で同期する。
        """
        new_ext_set = set(app_settings_store.parse_extension_entries(new_selected_extensions))
        rows = self.connection.execute(
            """
            SELECT id, selected_extensions
            FROM targets
            WHERE source_type = 'local'
            """
        ).fetchall()
        for row in rows:
            target_exts = app_settings_store.parse_extension_entries(str(row["selected_extensions"] or ""))
            if target_exts:
                retained = [ext for ext in target_exts if ext in new_ext_set]
                synced = "\n".join(sorted(retained))
            else:
                synced = new_selected_extensions
            if synced == str(row["selected_extensions"] or ""):
                continue
            self.connection.execute(
                """
                UPDATE targets
                SET selected_extensions = ?, updated_at = ?
                WHERE id = ?
                """,
                (synced, datetime.now(UTC).isoformat(), int(row["id"])),
            )
        self.connection.commit()

    def list_all(self) -> SearchTargetListResponse:
        """
        検索対象フォルダ一覧を返す。インデックス対象有効フラグも含める。
        """
        rows = self.connection.execute(
            """
            SELECT full_path, source_type, is_search_target_enabled, last_indexed_at, indexed_file_count
            FROM targets
            ORDER BY is_search_target_enabled DESC, full_path ASC
            """
        ).fetchall()
        items = [
            SearchTargetItem(
                full_path=str(row["full_path"]),
                source_type=str(row["source_type"] or "local"),
                is_enabled=bool(row["is_search_target_enabled"]),
                last_indexed_at=row["last_indexed_at"],
                indexed_file_count=int(row["indexed_file_count"] or 0),
            )
            for row in rows
        ]
        return SearchTargetListResponse(items=items)

    def list_registered_paths(self, *, enabled_only: bool, source_type: str = "local") -> list[str]:
        """
        検索対象フォルダとして登録済みのパス一覧を返す。
        有効対象が 0 件のときは、無効化済みフォルダもフォールバック候補として使う。
        """
        where_clause = "WHERE source_type = ?"
        if enabled_only:
            where_clause += " AND is_search_target_enabled = 1"
        try:
            rows = self.connection.execute(
                f"""
                SELECT full_path
                FROM targets
                {where_clause}
                ORDER BY full_path
                """,
                (source_type,),
            ).fetchall()
        except OperationalError as error:
            if "no such column: source_type" in str(error):
                return []
            raise
        if source_type == "web":
            return [web_pages.normalize_web_url(str(row["full_path"])) for row in rows]
        return [normalize_path(str(row["full_path"])).as_posix() for row in rows]

    def list_search_scope_paths(self, *, source_type: str = "local") -> list[str]:
        """
        フォルダ未指定の検索で対象にするパス一覧を返す。
        有効な検索対象があればそれを、1 件も無ければ登録済みの検索対象すべてを使う。
        """
        return self.list_registered_paths(enabled_only=True, source_type=source_type) or self.list_registered_paths(
            enabled_only=False, source_type=source_type
        )

    def set_enabled(self, target_id: int, *, is_enabled: bool, index_depth: int | None = None) -> None:
        """検索対象の有効 / 無効を切り替える。index_depth を渡したときは階層数も更新する。commit まで行う。"""
        now = datetime.now(UTC).isoformat()
        if index_depth is not None:
            self.connection.execute(
                """
                UPDATE targets
                SET is_search_target_enabled = ?, index_depth = ?, updated_at = ?
                WHERE id = ?
                """,
                (1 if is_enabled else 0, index_depth, now, target_id),
            )
        else:
            self.connection.execute(
                """
                UPDATE targets
                SET is_search_target_enabled = ?, updated_at = ?
                WHERE id = ?
                """,
                (1 if is_enabled else 0, now, target_id),
            )
        self.connection.commit()

    def delete(self, full_paths: list[str]) -> int:
        """検索対象の登録だけを外し、外した件数を返す（インデックスデータは消さない）。commit まで行う。"""
        deleted_count = 0
        for full_path in full_paths:
            cursor = self.connection.execute("DELETE FROM targets WHERE full_path = ?", (full_path,))
            deleted_count += int(cursor.rowcount or 0)
        self.connection.commit()
        return deleted_count

    def get_enabled_scan_settings(self, full_path: str, *, source_type: str) -> tuple[int, str] | None:
        """有効な検索対象に保存されている（階層数, 対象拡張子）を返す。未登録・無効なら None。"""
        row = self.connection.execute(
            """
            SELECT index_depth, selected_extensions
            FROM targets
            WHERE full_path = ? AND is_search_target_enabled = 1
              AND source_type = ?
            """,
            (full_path, source_type),
        ).fetchone()
        if row is None:
            return None
        return int(row["index_depth"] or 1), str(row["selected_extensions"] or "")
