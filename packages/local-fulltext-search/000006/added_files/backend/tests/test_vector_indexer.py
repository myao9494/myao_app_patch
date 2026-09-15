"""
ベクトルインデクサー（VectorIndexManager）の単体テスト。
多拡張子（Markdown、テキスト、画像）、差分走査、スキップ判定、単一ファイル更新を検証する。
"""

import time
from pathlib import Path
import pytest
from app.vector.db import get_db_stats, init_db
from app.vector.embedder import MockEmbedder
from app.vector.indexer import VectorIndexManager


@pytest.fixture
def sample_folder(tmp_path: Path) -> Path:
    vault = tmp_path / "sample_vault"
    vault.mkdir()

    # 1. Markdown
    (vault / "note.md").write_text("# メモ\nこれはMarkdownメモです。", encoding="utf-8")

    # 2. テキストファイル
    (vault / "readme.txt").write_text("テキストファイルの内容です。", encoding="utf-8")

    # 3. 画像ファイル（ファイル名のみ対象）
    (vault / "diagram.png").write_bytes(b"\x89PNG\r\n\x1a\n")

    return vault


def test_vector_indexer_full_and_incremental(tmp_path: Path, sample_folder: Path) -> None:
    """初回インデックスで全ファイルが登録され、2回目で全スキップされることを検証する"""
    db_file = str(tmp_path / "test_indexer.db")
    embedder = MockEmbedder(dim=64)
    manager = VectorIndexManager(
        target_folders=[str(sample_folder)],
        db_path=db_file,
        embedder=embedder,
    )

    # 1. 初回インデックス
    res1 = manager.index_all(force_reindex=False)
    assert res1.new_count == 3
    assert res1.updated_count == 0
    assert res1.skipped_count == 0

    stats1 = get_db_stats(db_file)
    assert stats1["document_count"] == 3
    assert stats1["chunk_count"] >= 3

    # 2. 2回目（変更なし）
    res2 = manager.index_all(force_reindex=False)
    assert res2.new_count == 0
    assert res2.updated_count == 0
    assert res2.skipped_count == 3

    # 3. ファイル変更
    time.sleep(0.01)
    (sample_folder / "note.md").write_text("# メモ更新\n内容が変更されました。", encoding="utf-8")
    res3 = manager.index_all(force_reindex=False)
    assert res3.updated_count == 1
    assert res3.skipped_count == 2


def test_update_single_file(tmp_path: Path, sample_folder: Path) -> None:
    """単一ファイルの更新が高速に処理されることを検証する"""
    db_file = str(tmp_path / "test_single_file.db")
    embedder = MockEmbedder(dim=64)
    manager = VectorIndexManager(
        target_folders=[str(sample_folder)],
        db_path=db_file,
        embedder=embedder,
    )

    note_path = str(sample_folder / "note.md")
    res = manager.update_single_file(note_path)
    assert res.status == "created"
    assert res.chunk_count >= 1

    # 再度更新（変更なし）
    res_skip = manager.update_single_file(note_path)
    assert res_skip.status == "skipped"


def test_vector_indexer_selected_and_custom_extensions(tmp_path: Path) -> None:
    """インデックス対象拡張子および追加拡張子の指定がベクトルインデックスに適用されることを検証する"""
    vault = tmp_path / "custom_vault"
    vault.mkdir()
    (vault / "doc.md").write_text("# 文書\nMarkdownです。", encoding="utf-8")
    (vault / "script.py").write_text("print('Python')", encoding="utf-8")
    (vault / "note.txt").write_text("テキストです。", encoding="utf-8")
    (vault / "image.png").write_bytes(b"\x89PNG")
    (vault / "other.xyz").write_text("その他", encoding="utf-8")

    db_file = str(tmp_path / "test_custom_ext.db")
    embedder = MockEmbedder(dim=64)

    # 1. selected_extensions に .md と .py のみを指定し、.py をカスタム本文拡張子として渡す
    manager = VectorIndexManager(
        target_folders=[str(vault)],
        db_path=db_file,
        embedder=embedder,
        selected_extensions=[".md", ".py"],
        custom_content_extensions=[".py"],
    )

    scanned = manager.scan_files()
    scanned_names = {p.name for p in scanned}
    # doc.md と script.py のみが対象となり、note.txt, image.png, other.xyz は除外される
    assert scanned_names == {"doc.md", "script.py"}

    res = manager.index_all(force_reindex=False)
    assert res.new_count == 2
    stats = get_db_stats(db_file)
    assert stats["document_count"] == 2


def test_vector_indexer_preserves_files_by_default_when_missing_from_scan(tmp_path: Path) -> None:
    """
    走査対象からファイルが見つからなくなっても、既定（clean_deleted_files=False）では
    インデックス済みドキュメントを勝手に削除せず保持することを検証する。
    """
    vault = tmp_path / "vault"
    vault.mkdir()
    file_a = vault / "a.md"
    file_b = vault / "b.md"
    file_a.write_text("file A", encoding="utf-8")
    file_b.write_text("file B", encoding="utf-8")

    db_file = str(tmp_path / "test_preserve.db")
    embedder = MockEmbedder(dim=64)
    manager = VectorIndexManager(
        target_folders=[str(vault)],
        db_path=db_file,
        embedder=embedder,
    )

    # 1. 初回インデックス (2件)
    res1 = manager.index_all(force_reindex=False)
    assert res1.new_count == 2
    assert get_db_stats(db_file)["document_count"] == 2

    # 2. ファイル B を削除（または移動）
    file_b.unlink()

    # 削除候補の事前検知 (pending deletions)
    pending = manager.get_pending_deletions()
    assert str(file_b.resolve()) in pending
    assert len(pending) == 1

    # 3. 差分インデックス（既定: clean_deleted_files=False）
    # 許可なく勝手に削除せず、既存インデックスレコードを保持する
    res2 = manager.index_all(force_reindex=False, clean_deleted_files=False)
    assert res2.deleted_count == 0
    # document_count は 2 のまま保持されていること！
    assert get_db_stats(db_file)["document_count"] == 2

    # 4. ユーザーが明示的に削除を許可した場合のみ削除（clean_deleted_files=True）
    res3 = manager.index_all(force_reindex=False, clean_deleted_files=True)
    assert res3.deleted_count == 1
    assert get_db_stats(db_file)["document_count"] == 1


