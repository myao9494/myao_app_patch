"""
Obsidian（sidebar-explorer プラグイン）の利用状況を、検索順位の補助スコアとして取り込む。

- プラグインの data.json から、ノートごとのアクセス数と重要度（被リンク数・最終閲覧日など）を読み、
  files.obsidian_click_count / obsidian_rank_score へ保存する。
- 同期は検索の完了後にバックグラウンドで行い、次回以降の検索順位へ反映する。同時に走るのは 1 本だけ。
- data.json と Vault 配下のインデックス内容が前回の同期から変わっていなければ、DB へは書き込まない。
- 連携先が未設定・存在しない・Vault を特定できない場合は何もしない。
"""

from __future__ import annotations

import json
import logging
import math
import threading
import time as time_module
from pathlib import Path
from sqlite3 import Connection

from app.db.connection import get_connection
from app.services.background_tasks import start_background_thread
from app.services.path_service import get_descendant_path_range, normalize_path_str

OBSIDIAN_RANK_SCORE_SCALE = 1000.0
logger = logging.getLogger(__name__)

_OBSIDIAN_SYNC_LOCK = threading.Lock()
_OBSIDIAN_SYNC_RUNNING = False
# (DB の識別子, data.json のパス) ごとに、最後に同期した入力の状態を覚える
_OBSIDIAN_SYNC_LAST_STATES: dict[tuple[str, str], tuple[int, int, int, int]] = {}


def schedule_obsidian_access_sync(configured_data_path: str) -> None:
    """
    Obsidian の利用状況同期は検索完了後に非同期で行い、次回検索の順位へ反映する。
    連携先が未設定のときは何もしない（検索のたびにスレッドとDB接続を作らない）。
    """
    if not configured_data_path:
        return
    global _OBSIDIAN_SYNC_RUNNING
    with _OBSIDIAN_SYNC_LOCK:
        if _OBSIDIAN_SYNC_RUNNING:
            return
        _OBSIDIAN_SYNC_RUNNING = True

    def run_sync() -> None:
        connection: Connection | None = None
        try:
            connection = get_connection()
            sync_obsidian_access_counts(connection, configured_data_path)
        except Exception:
            logger.warning("Obsidian access sync failed.", exc_info=True)
        finally:
            if connection is not None:
                connection.close()
            global _OBSIDIAN_SYNC_RUNNING
            with _OBSIDIAN_SYNC_LOCK:
                _OBSIDIAN_SYNC_RUNNING = False

    start_background_thread(run_sync, name="search-obsidian-sync")


def sync_obsidian_access_counts(connection: Connection, configured_path: str) -> None:
    """
    sidebar-explorer の data.json からアクセス数と重要度スコアを files へ同期する。
    data.json と Vault 配下のインデックス内容が前回同期時から変わっていなければ、
    同じ値を書き直すだけになるため DB への書き込みを省略する。
    """
    if not configured_path:
        return

    data_path = Path(configured_path)
    if not data_path.exists():
        # 指定されたパスが存在しない場合は何もしない
        return

    # .obsidian ディレクトリの親を Vault ルートとして特定する。
    data_path_abs = data_path.resolve()
    vault_root_path: Path | None = None
    for parent in data_path_abs.parents:
        if (parent / ".obsidian").is_dir():
            vault_root_path = parent
            break

    if vault_root_path is None:
        # Vaultルート（.obsidianの親）が特定できない場合は、不正な構造とみなして終了する
        return

    vault_root = normalize_path_str(vault_root_path)
    prefix_start, prefix_end = get_descendant_path_range(vault_root)
    sync_state = _resolve_obsidian_sync_state(connection, data_path_abs, prefix_start, prefix_end)
    state_key = (_resolve_database_identity(connection), str(data_path_abs))
    with _OBSIDIAN_SYNC_LOCK:
        if sync_state is not None and _OBSIDIAN_SYNC_LAST_STATES.get(state_key) == sync_state:
            return

    try:
        payload = json.loads(data_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        # 読み取り失敗時は静かに終了する
        return

    raw_metrics = payload.get("fileMetrics") or payload.get("files") or payload.get("metrics")
    raw_access_counts = payload.get("accessCounts")
    if raw_metrics is not None and not isinstance(raw_metrics, dict):
        raw_metrics = None
    if raw_metrics is None and not isinstance(raw_access_counts, dict):
        return

    connection.execute(
        """
        UPDATE files
        SET obsidian_click_count = 0,
            obsidian_rank_score = 0.0
        WHERE normalized_path >= ? AND normalized_path < ?
        """,
        (prefix_start, prefix_end),
    )

    updates: list[tuple[int, float, str]] = []
    raw_items = raw_metrics if isinstance(raw_metrics, dict) else raw_access_counts
    for relative_path, raw_value in raw_items.items():
        if not isinstance(relative_path, str):
            continue
        metrics = raw_value if isinstance(raw_value, dict) else {"accessCount": raw_value}
        access_count = _coerce_non_negative_int(
            metrics.get("accessCount", raw_access_counts.get(relative_path) if isinstance(raw_access_counts, dict) else 0)
        )
        rank_score = calculate_obsidian_rank_score(metrics)
        normalized_full_path = normalize_path_str(Path(vault_root) / Path(relative_path))
        updates.append((access_count, rank_score, normalized_full_path))

    if updates:
        connection.executemany(
            "UPDATE files SET obsidian_click_count = ?, obsidian_rank_score = ? WHERE normalized_path = ?",
            updates,
        )
    connection.commit()
    if sync_state is not None:
        with _OBSIDIAN_SYNC_LOCK:
            _OBSIDIAN_SYNC_LAST_STATES[state_key] = sync_state
    logger.info("Synced %d Obsidian ranking metrics from %s", len(updates), vault_root)


def _resolve_database_identity(connection: Connection) -> str:
    """接続先DBファイルを識別する文字列を返す（同期済み状態をDBごとに覚えるため）。"""
    row = connection.execute("PRAGMA database_list").fetchone()
    return str(row[2]) if row is not None and row[2] else f"memory:{id(connection)}"


def _resolve_obsidian_sync_state(connection: Connection, data_path: Path, prefix_start: str, prefix_end: str
) -> tuple[int, int, int, int] | None:
    """
    同期結果を左右する入力（data.json の更新時刻・サイズ、Vault 配下の件数と最大ID）を返す。
    ファイルの追加・削除・再作成があれば値が変わり、同期をやり直す。
    """
    try:
        stat = data_path.stat()
    except OSError:
        return None
    row = connection.execute(
        """
        SELECT COUNT(*) AS file_count, COALESCE(MAX(id), 0) AS max_id
        FROM files
        WHERE normalized_path >= ? AND normalized_path < ?
        """,
        (prefix_start, prefix_end),
    ).fetchone()
    return (stat.st_mtime_ns, stat.st_size, int(row["file_count"]), int(row["max_id"]))


def calculate_obsidian_rank_score(metrics: dict[str, object]) -> float:
    """
    Obsidian ノートの重要度を、検索語一致を壊さない補助スコアへ正規化する。
    """
    now_ms = time_module.time() * 1000
    access_score = _log_score(metrics.get("accessCount"))
    backlink_score = _log_score(metrics.get("backlinkCount"))
    last_opened_score = _recency_score(metrics.get("lastOpenedAt"), now_ms, half_life_days=21)
    modified_score = _recency_score(metrics.get("modifiedAt"), now_ms, half_life_days=45)
    outgoing_score = _log_score(metrics.get("outgoingLinkCount"))
    attachment_score = _log_score(metrics.get("attachmentCount"))
    heading_score = _log_score(metrics.get("headingCount"))
    tag_score = _log_score(metrics.get("tagCount"))

    return round(
        OBSIDIAN_RANK_SCORE_SCALE
        * (
            0.28 * backlink_score
            + 0.22 * access_score
            + 0.16 * last_opened_score
            + 0.1 * modified_score
            + 0.08 * outgoing_score
            + 0.06 * tag_score
            + 0.05 * heading_score
            + 0.05 * attachment_score
        ),
        6,
    )


def _log_score(value: object) -> float:
    return min(1.0, math.log1p(_coerce_non_negative_int(value)) / math.log1p(50))


def _recency_score(value: object, now_ms: float, *, half_life_days: int) -> float:
    timestamp = _coerce_non_negative_float(value)
    if timestamp <= 0 or timestamp > now_ms:
        return 0.0
    age_days = (now_ms - timestamp) / (1000 * 60 * 60 * 24)
    return 0.5 ** (age_days / half_life_days)


def _coerce_non_negative_int(value: object) -> int:
    try:
        return max(int(value), 0)
    except (TypeError, ValueError):
        return 0


def _coerce_non_negative_float(value: object) -> float:
    try:
        return max(float(value), 0.0)
    except (TypeError, ValueError):
        return 0.0
