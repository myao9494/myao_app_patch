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




def _write(path: Path, text: str = "本文") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def test_scan_files_respects_folder_depth(tmp_path: Path) -> None:
    """階層数を指定した対象フォルダでは、全文インデックスと同じ深さまでしか走査しない。"""
    vault = tmp_path / "vault"
    _write(vault / "root.md")
    _write(vault / "sub" / "child.md")
    _write(vault / "sub" / "deep" / "grandchild.md")

    manager = VectorIndexManager(
        target_folders=[str(vault)],
        db_path=str(tmp_path / "depth.db"),
        embedder=MockEmbedder(dim=64),
        folder_depths={str(vault): 1},
    )

    assert {path.name for path in manager.scan_files()} == {"root.md", "child.md"}


def test_scan_files_uses_the_same_scope_as_the_fulltext_index(tmp_path: Path) -> None:
    """ドット始まりのフォルダや dist なども、除外キーワードに無ければ全文インデックスと同じく対象にする。"""
    vault = tmp_path / "vault"
    _write(vault / "note.md")
    _write(vault / ".notes" / "hidden.md")
    _write(vault / "dist" / "built.md")
    db_file = str(tmp_path / "scope.db")

    without_keywords = VectorIndexManager(target_folders=[str(vault)], db_path=db_file, embedder=MockEmbedder(dim=64))
    with_keywords = VectorIndexManager(
        target_folders=[str(vault)],
        db_path=db_file,
        embedder=MockEmbedder(dim=64),
        exclude_keywords=".notes\ndist",
    )

    assert {path.name for path in without_keywords.scan_files()} == {"note.md", "hidden.md", "built.md"}
    assert {path.name for path in with_keywords.scan_files()} == {"note.md"}


def test_index_all_stops_when_cancel_is_requested(tmp_path: Path) -> None:
    """中止を要求されたら次のファイルへ進まずに終わる。そこまでに保存した文書は残る。"""
    vault = tmp_path / "vault"
    for index in range(5):
        _write(vault / f"{index}.md", f"本文 {index}")
    db_file = str(tmp_path / "cancel.db")
    manager = VectorIndexManager(target_folders=[str(vault)], db_path=db_file, embedder=MockEmbedder(dim=64))
    processed: list[str] = []

    result = manager.index_all(
        progress_callback=lambda progress: processed.append(progress.current_file),
        should_cancel=lambda: len(processed) >= 2,
    )

    assert result.cancelled is True
    assert result.new_count == 2
    assert get_db_stats(db_file)["document_count"] == 2


def test_force_reindex_keeps_existing_documents_until_they_are_replaced(tmp_path: Path) -> None:
    """全件再作成は最初に全データを消さない。途中で中止しても、検索できる状態のまま残る。"""
    vault = tmp_path / "vault"
    for index in range(3):
        _write(vault / f"{index}.md", f"本文 {index}")
    db_file = str(tmp_path / "force.db")
    manager = VectorIndexManager(target_folders=[str(vault)], db_path=db_file, embedder=MockEmbedder(dim=64))
    manager.index_all()

    cancelled = manager.index_all(force_reindex=True, should_cancel=lambda: True)

    assert cancelled.cancelled is True
    assert get_db_stats(db_file)["document_count"] == 3


def test_force_reindex_re_embeds_every_file_and_removes_stale_documents(tmp_path: Path) -> None:
    """全件再作成が最後まで終わったら、すべてのファイルを作り直し、もう存在しない文書を消す。"""
    vault = tmp_path / "vault"
    files = [_write(vault / f"{index}.md", f"本文 {index}") for index in range(3)]
    db_file = str(tmp_path / "force_full.db")
    manager = VectorIndexManager(target_folders=[str(vault)], db_path=db_file, embedder=MockEmbedder(dim=64))
    manager.index_all()
    files[0].unlink()

    result = manager.index_all(force_reindex=True)

    assert result.cancelled is False
    assert result.skipped_count == 0
    assert result.updated_count == 2
    assert result.deleted_count == 1
    assert get_db_stats(db_file)["document_count"] == 2


def test_force_reindex_keeps_documents_under_unreachable_folders(tmp_path: Path) -> None:
    """全件再作成でも、到達できない対象フォルダ（未接続のドライブ等）の文書は消さない。"""
    reachable = tmp_path / "reachable"
    offline = tmp_path / "offline"
    _write(reachable / "a.md")
    _write(offline / "b.md")
    db_file = str(tmp_path / "force_offline.db")
    VectorIndexManager(
        target_folders=[str(reachable), str(offline)], db_path=db_file, embedder=MockEmbedder(dim=64)
    ).index_all()
    (offline / "b.md").unlink()
    offline.rmdir()

    result = VectorIndexManager(
        target_folders=[str(reachable), str(offline)], db_path=db_file, embedder=MockEmbedder(dim=64)
    ).index_all(force_reindex=True)

    assert result.deleted_count == 0
    assert get_db_stats(db_file)["document_count"] == 2


def test_measure_text_reports_timings_without_touching_the_index(tmp_path: Path) -> None:
    """本文を渡す測定は、チャンク化と推論の時間だけを測り、インデックスには何も保存しない。"""
    db_file = str(tmp_path / "measure.db")
    manager = VectorIndexManager(target_folders=[], db_path=db_file, embedder=MockEmbedder(dim=64))

    result = manager.measure_text("sample.md", "# 見出し\n\n本文です。\n\n## 次の見出し\n\n続きの本文です。")
    empty = manager.measure_text("empty.md", "")

    assert result.status == "measured"
    assert result.relative_path == "sample.md"
    assert result.chunk_count >= 1
    assert result.db_time_ms == 0.0
    assert empty.status == "measured"
    assert empty.chunk_count == 0
    assert get_db_stats(db_file)["document_count"] == 0
