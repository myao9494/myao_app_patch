"""
ベクトルインデックス作成における除外キーワード適用の単体テスト。
仕様:
- VectorState.sync_index は exclude_keywords が未指定の場合、AppSettings の exclude_keywords を自動で取得して適用する。
- VectorIndexManager.scan_files は絶対パス、ディレクトリ名、相対パスの除外キーワードを正しく認識し対象から除外する。誤爆（secretary_notes vs secret）を防ぐ。
- 以前インデックスされていたファイルが後から除外キーワードに合致した場合、差分同期時にベクトルDBから削除（パージ）される。
- IndexService.update_app_settings で除外キーワードが追加された場合、ベクトルDBから除外対象ファイルが即時クリーンアップされる。
"""

import sqlite3
from pathlib import Path
import pytest

from app.config import settings
from app.db.schema import initialize_schema
from app.services.index_service import IndexService
from app.vector.indexer import VectorIndexManager
from app.vector.state import VectorState
from app.vector.db import get_model_db_path, get_all_documents_metadata


def _create_db(tmp_path: Path) -> sqlite3.Connection:
    db_path = tmp_path / "search.db"
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    initialize_schema(conn)
    return conn


def test_vector_state_sync_index_respects_app_settings_exclude_keywords(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """VectorState.sync_index が未指定時に AppSettings の exclude_keywords を自動適用すること"""
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True)
    monkeypatch.setattr(settings, "data_dir", data_dir)

    target_dir = tmp_path / "targets"
    target_dir.mkdir(parents=True)

    normal_file = target_dir / "report.md"
    normal_file.write_text("This is a normal document.", encoding="utf-8")

    ignored_dir = target_dir / "backup"
    ignored_dir.mkdir(parents=True)
    ignored_file = ignored_dir / "backup_data.md"
    ignored_file.write_text("This should be excluded by keywords.", encoding="utf-8")

    # 除外キーワードに backup を設定
    conn = _create_db(tmp_path)
    svc = IndexService(connection=conn)
    svc.update_app_settings(exclude_keywords="backup")

    state = VectorState(data_dir=data_dir)
    state.load_model(use_mock=True, mock_dim=64)

    # exclude_keywords を渡さずに sync_index を実行
    res = state.sync_index(target_folders=[str(target_dir)], force=True)
    assert res is not None
    # normal_file のみインデックスされ、backup は除外されていること
    assert res.total_files == 1
    assert res.new_count == 1

    ident = "mock_model"
    db_path = get_model_db_path(ident, data_dir=data_dir)
    docs = get_all_documents_metadata(db_path)
    assert str(normal_file.resolve()) in docs
    assert str(ignored_file.resolve()) not in docs


def test_vector_indexer_scan_files_with_various_exclude_patterns(tmp_path: Path) -> None:
    """VectorIndexManager.scan_files が絶対パス・フォルダ名・Windows/POSIX区切りの除外を正しく処理すること"""
    base_dir = tmp_path / "project"
    base_dir.mkdir()

    valid_file = base_dir / "valid.md"
    valid_file.write_text("valid content", encoding="utf-8")

    # 1. フォルダ名除外
    backup_dir = base_dir / "backup"
    backup_dir.mkdir()
    (backup_dir / "old.md").write_text("old", encoding="utf-8")

    # 2. 絶対パス除外
    abs_exclude_dir = base_dir / "specific_ignore"
    abs_exclude_dir.mkdir()
    (abs_exclude_dir / "doc.md").write_text("doc", encoding="utf-8")

    # 3. 類似語名だが誤爆しないファイル（secretary_notes は secret を除外しても残るべき）
    sec_file = base_dir / "secretary_notes.md"
    sec_file.write_text("secretary", encoding="utf-8")

    db_path = str(tmp_path / "test.db")
    exclude_text = f"backup\n{abs_exclude_dir.resolve().as_posix()}\nsecret"

    manager = VectorIndexManager(
        target_folders=[str(base_dir)],
        db_path=db_path,
        exclude_keywords=exclude_text,
    )

    scanned = manager.scan_files()
    scanned_names = {p.name for p in scanned}

    assert "valid.md" in scanned_names
    assert "secretary_notes.md" in scanned_names
    assert "old.md" not in scanned_names
    assert "doc.md" not in scanned_names


def test_vector_index_purges_excluded_files_on_sync(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """すでにインデックスされたファイルが除外キーワード追加後の差分同期でパージされること"""
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True)
    monkeypatch.setattr(settings, "data_dir", data_dir)

    target_dir = tmp_path / "workspace"
    target_dir.mkdir(parents=True)

    file_a = target_dir / "file_a.md"
    file_a.write_text("File A", encoding="utf-8")
    file_b = target_dir / "file_b.md"
    file_b.write_text("File B", encoding="utf-8")

    state = VectorState(data_dir=data_dir)
    state.load_model(use_mock=True, mock_dim=64)

    # 1回目: 除外なしで両方インデックス
    res1 = state.sync_index(target_folders=[str(target_dir)], force=True, exclude_keywords="")
    assert res1 is not None
    assert res1.total_files == 2
    assert res1.new_count == 2

    # 2回目: file_b を除外キーワードに指定して差分同期
    res2 = state.sync_index(target_folders=[str(target_dir)], force=False, exclude_keywords="file_b")
    assert res2 is not None
    # file_b は走査から外れ、クリーンアップ（deleted）されること
    assert res2.total_files == 1
    assert res2.deleted_count == 1

    ident = "mock_model"
    db_path = get_model_db_path(ident, data_dir=data_dir)
    docs = get_all_documents_metadata(db_path)
    assert str(file_a.resolve()) in docs
    assert str(file_b.resolve()) not in docs


def test_update_app_settings_cleans_up_newly_excluded_keyword_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """update_app_settings で除外キーワードが追加された際にベクトルDBからも即時削除されること"""
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True)
    monkeypatch.setattr(settings, "data_dir", data_dir)

    target_dir = tmp_path / "notes"
    target_dir.mkdir(parents=True)

    file_keep = target_dir / "keep.md"
    file_keep.write_text("Keep this", encoding="utf-8")
    file_drop = target_dir / "archive_temp.md"
    file_drop.write_text("Drop this", encoding="utf-8")

    state = VectorState(data_dir=data_dir)
    state.load_model(use_mock=True, mock_dim=64)
    # まずインデックス
    state.sync_index(target_folders=[str(target_dir)], force=True, exclude_keywords="")

    ident = "mock_model"
    db_path = get_model_db_path(ident, data_dir=data_dir)
    docs = get_all_documents_metadata(db_path)
    assert str(file_drop.resolve()) in docs

    # update_app_settings で archive_temp を除外キーワードに追加
    conn = _create_db(tmp_path)
    svc = IndexService(connection=conn)
    # targets テーブルに target_dir を登録
    conn.execute(
        "INSERT INTO targets (full_path, source_type, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))",
        (str(target_dir), "local")
    )
    conn.commit()

    svc.update_app_settings(exclude_keywords="archive_temp")

    # ベクトルDBから file_drop がクリーンアップされていること
    docs_after = get_all_documents_metadata(db_path)
    assert str(file_keep.resolve()) in docs_after
    assert str(file_drop.resolve()) not in docs_after
