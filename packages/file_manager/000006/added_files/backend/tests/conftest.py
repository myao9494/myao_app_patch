"""
テスト用のフィクスチャと共通設定
"""
import shutil
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def anyio_backend():
    """asyncio固有APIを使うバックエンド実装の非同期テストをasyncioで実行する。"""
    return "asyncio"


@pytest.fixture
def client():
    """テスト用のFastAPIクライアント"""
    return TestClient(app)


@pytest.fixture
def temp_dir():
    """テスト用の一時ディレクトリを作成"""
    with tempfile.TemporaryDirectory() as tmpdir:
        # テスト用のファイルとフォルダを作成
        test_dir = Path(tmpdir)

        # フォルダ作成
        (test_dir / "folder1").mkdir()
        (test_dir / "folder2").mkdir()

        # ファイル作成
        (test_dir / "file1.txt").write_text("test content 1")
        (test_dir / "file2.md").write_text("# Markdown")
        (test_dir / "folder1" / "nested.txt").write_text("nested content")

        yield test_dir


@pytest.fixture(autouse=True)
def isolated_preferences(monkeypatch, tmp_path_factory):
    """リポジトリの settings.json（利用者のパス置換設定など）をテストで読み書きしない"""
    from app import config

    preferences_path = tmp_path_factory.mktemp("prefs") / "settings.json"
    monkeypatch.setattr(config.settings, "_preferences_file_override", preferences_path)
    return preferences_path


@pytest.fixture(autouse=True)
def fake_trash(monkeypatch, tmp_path_factory):
    """
    実際のゴミ箱を汚さないよう send2trash を一時フォルダへの移動に差し替える。
    trash.items には (元のパス, 退避先パス) が記録される。
    """
    import send2trash

    trash_dir = tmp_path_factory.mktemp("trash")
    state = SimpleNamespace(dir=trash_dir, items=[], fail=False)

    def fake_send2trash(path):
        if state.fail:
            raise OSError("trash unavailable")
        src = Path(path)
        dest = trash_dir / f"{len(state.items)}_{src.name}"
        shutil.move(str(src), str(dest))
        state.items.append((str(src), dest))

    monkeypatch.setattr(send2trash, "send2trash", fake_send2trash)
    return state
