"""
SQLite 接続設定。

- DBファイルは既定で backend/gantt.db。起動時のカレントディレクトリには依存しない。
- 環境変数 GANTT_DATABASE_URL で接続先を差し替えられる（テストは必ずこれで一時DBに隔離する）。
"""
import os

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, declarative_base

from config import BACKEND_DIR

DEFAULT_DATABASE_URL = f"sqlite:///{(BACKEND_DIR / 'gantt.db').as_posix()}"
SQLALCHEMY_DATABASE_URL = os.getenv("GANTT_DATABASE_URL", DEFAULT_DATABASE_URL)

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={"check_same_thread": False}
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    """Dependency for getting database session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """Initialize database tables."""
    Base.metadata.create_all(bind=engine)
    # is_pinned 追加前に作られたDBへの後方互換マイグレーション
    with engine.begin() as connection:
        for table_name in ("tasks", "grid_tasks"):
            columns = {
                row[1]
                for row in connection.execute(text(f"PRAGMA table_info({table_name})"))
            }
            if "is_pinned" not in columns:
                connection.execute(
                    text(f"ALTER TABLE {table_name} ADD COLUMN is_pinned INTEGER DEFAULT 0")
                )
