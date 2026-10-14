"""
pytest 実行時のグローバル設定およびテスト環境隔離 fixture。

仕様:
- 全テストにおいて、実環境の `backend/data`（検索DB・設定ファイル・ベクトルDB）を読み書きしないよう、
  `settings.data_dir` と `vector_state.data_dir` をテストごとの一時ディレクトリへ隔離する。
- アプリの起動処理（lifespan）を通すテストが実環境の `backend.log` へ書き込まないよう、ログ出力先も隔離する。
- テスト終了後に元の状態へ復元する。
- セッション終了時に実環境の設定ファイルが変化していないことを検査し、隔離漏れを検知する。
"""

from pathlib import Path

import pytest

from app import main as app_main
from app.config import settings
from app.services.background_tasks import wait_for_background_tasks
from app.vector.state import vector_state

REAL_DATA_DIR = settings.data_dir
REAL_BACKEND_LOG_PATH = app_main.BACKEND_DIR / "backend.log"
_GUARDED_SETTING_PATTERNS = ("*.txt", "config.json")


def _snapshot_real_settings() -> dict[str, tuple[int, int]]:
    """実環境の設定ファイルの更新時刻とサイズを記録する。"""
    snapshot: dict[str, tuple[int, int]] = {}
    if not REAL_DATA_DIR.is_dir():
        return snapshot
    for pattern in _GUARDED_SETTING_PATTERNS:
        for path in REAL_DATA_DIR.glob(pattern):
            stat = path.stat()
            snapshot[path.name] = (stat.st_mtime_ns, stat.st_size)
    return snapshot


def _resolve_inode(path: Path) -> int | None:
    try:
        return path.stat().st_ino
    except OSError:
        return None


@pytest.fixture(scope="session", autouse=True)
def guard_real_data_dir():
    """
    テストが実環境の設定ファイルを書き換えていないことをセッション終了時に検査する。
    隔離 fixture を経由しない書き込み（モジュールスコープの処理など）を早期に検知するための安全網。
    """
    before = _snapshot_real_settings()
    log_inode_before = _resolve_inode(REAL_BACKEND_LOG_PATH)
    yield
    after = _snapshot_real_settings()
    # ログは稼働中のアプリが追記するためサイズでは判定できない。テストによるローテーション（別ファイルへの置き換え）だけを検知する
    assert _resolve_inode(REAL_BACKEND_LOG_PATH) == log_inode_before, (
        f"テスト実行中に実環境のログファイルが置き換えられました: {REAL_BACKEND_LOG_PATH}。"
        "テストがログ出力先の隔離を経由せずにファイルログを設定した可能性があります。"
    )
    changed = sorted(name for name in before.keys() | after.keys() if before.get(name) != after.get(name))
    assert not changed, (
        f"テスト実行中に実環境の設定ファイルが変更されました: {changed} ({REAL_DATA_DIR})。"
        "テストの隔離漏れ、またはテスト実行中にアプリ側で設定を保存した可能性があります。"
    )


@pytest.fixture(autouse=True)
def isolate_app_data_for_tests(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """
    テスト実行時に実環境の検索DB・設定ファイル・ベクトルDBが汚染されるのを防止する。
    """
    test_data_dir = tmp_path / "app_data"
    test_data_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "data_dir", test_data_dir)
    test_log_dir = tmp_path / "app_logs"
    test_log_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(app_main, "BACKEND_DIR", test_log_dir)

    orig_data_dir = vector_state.data_dir
    orig_config_path = vector_state.config_path
    orig_model_path = vector_state.model_path
    orig_embedder = vector_state.embedder
    orig_glossary = vector_state.glossary
    orig_searcher = vector_state.searcher

    vector_state.data_dir = test_data_dir
    vector_state.config_path = test_data_dir / "config.json"

    try:
        yield
    finally:
        # 検索が起動したバックグラウンド処理が、隔離解除後に実環境のDBへ接続しないよう完了を待つ
        background_tasks_finished = wait_for_background_tasks()
        vector_state.data_dir = orig_data_dir
        vector_state.config_path = orig_config_path
        vector_state.model_path = orig_model_path
        vector_state.embedder = orig_embedder
        vector_state.glossary = orig_glossary
        vector_state.searcher = orig_searcher
    assert background_tasks_finished, "検索のバックグラウンド処理がテスト終了までに完了しませんでした。"
