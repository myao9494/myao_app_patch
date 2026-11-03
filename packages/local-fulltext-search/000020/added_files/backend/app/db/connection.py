"""
全文検索DB（SQLite）への接続生成。
接続はスレッド間で共有せず、リクエスト・バックグラウンド処理ごとに開いて閉じる。
"""

import sqlite3

from app.config import settings


def ensure_data_dir() -> None:
    """設定の読み込みごとに呼ばれるので、既にあれば作成を試みない（Windows の mkdir は失敗の処理に時間がかかる）。"""
    if not settings.data_dir.is_dir():
        settings.data_dir.mkdir(parents=True, exist_ok=True)


def get_connection() -> sqlite3.Connection:
    """
    SQLite接続を作成し、パフォーマンス最適化PRAGMAを設定する。
    - WAL: 読み書き並行性向上
    - synchronous=NORMAL: WAL併用時に安全かつ高速
    - cache_size: 64MBに拡大してI/O削減
    - temp_store=MEMORY: 一時テーブルをメモリ上に配置
    - mmap_size: 256MBのメモリマップ読み取り
    """
    ensure_data_dir()
    connection = sqlite3.connect(settings.database_path, check_same_thread=False, timeout=30.0)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON;")
    connection.execute("PRAGMA journal_mode = WAL;")
    connection.execute("PRAGMA synchronous = NORMAL;")
    connection.execute("PRAGMA cache_size = -64000;")
    connection.execute("PRAGMA temp_store = MEMORY;")
    connection.execute("PRAGMA mmap_size = 268435456;")
    return connection
