"""
全文検索DBとベクトルDBの空き領域を回収する保守スクリプト。

使い方（アプリを停止してから実行する）:
    python compact_db.py

- 全文検索DB（search.db）は FTS5 索引を統合してから VACUUM する。
- データフォルダ内の全モデル分のベクトルDB（vector_index_*.db）を VACUUM する。
- アプリが稼働中（待受ポートに接続できる）の場合は何もせず終了する。
- 検索結果・クリック履歴・設定は変更しない。処理中は一時的に DB と同程度の空きディスクを使う。
"""

import socket
import sys

from app.config import settings
from app.db.maintenance import DatabaseBusyError, compact_search_database, compact_vector_database
from app.vector.db import list_vector_db_paths


def _is_app_running() -> bool:
    """待受ポートへ接続できる場合は、アプリが稼働中とみなす。"""
    try:
        with socket.create_connection(("127.0.0.1", settings.bind_port), timeout=1.0):
            return True
    except OSError:
        return False


def _format_size(size_bytes: int) -> str:
    return f"{size_bytes / (1024 * 1024):,.1f} MB"


def main() -> int:
    if _is_app_running():
        print(f"アプリが稼働中です（ポート {settings.bind_port}）。停止してから実行してください。")
        return 1

    targets = []
    if settings.database_path.exists():
        targets.append((settings.database_path, compact_search_database))
    targets.extend((path, compact_vector_database) for path in list_vector_db_paths(settings.data_dir))
    if not targets:
        print(f"保守対象の DB がありません: {settings.data_dir}")
        return 0

    for path, compact in targets:
        try:
            result = compact(path)
        except DatabaseBusyError as error:
            print(f"スキップ: {path} ({error})")
            continue
        print(
            f"{result.path}: {_format_size(result.size_before)} -> {_format_size(result.size_after)}"
            f" (回収 {_format_size(result.reclaimed_bytes)})"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
