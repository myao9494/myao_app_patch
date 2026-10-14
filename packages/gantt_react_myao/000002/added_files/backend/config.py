"""
バックエンド全体で共有するパス・環境変数の設定。

- パスはすべてこのファイルの位置を基準にした絶対パスで、起動時のカレントディレクトリに依存しない。
- 環境変数は呼び出し時に読む（テストや起動スクリプトから差し替えられるようにするため）。
"""
import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
DATA_DIR = BACKEND_DIR / "data"
FRONTEND_DIST_DIR = BACKEND_DIR.parent / "frontend" / "dist"

# フロントエンドが obsidian_home を送ってこなかった場合のフォールバック先
LEGACY_OBSIDIAN_HOME = "/Users/mine/000_work/obsidian-dagnetz"

# Obsidian Vault 内の CSV 定期保存先ディレクトリ名
OBSIDIAN_CSV_DIRNAME = "70_gantt_csv"


def default_obsidian_home() -> str:
    """環境変数 OBSIDIAN_HOME、なければ従来の既定パスを返す。"""
    return os.environ.get("OBSIDIAN_HOME", LEGACY_OBSIDIAN_HOME)


def gantt_frontend_url() -> str:
    """open-input でブラウザに表示させる Gantt 画面のURL（GANTT_FRONTEND_URL で上書き可）。"""
    return os.getenv("GANTT_FRONTEND_URL", "").strip() or "http://localhost:8000/"


def synonym_api_url() -> str:
    """同義語グループを提供する外部 Local-fulltext-search API のURL。"""
    return os.getenv("SYNONYM_API_URL", "http://127.0.0.1:8079/api/index/synonyms")
