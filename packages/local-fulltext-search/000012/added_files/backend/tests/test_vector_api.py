"""
ベクトル管理およびAIエクスポートAPIの単体テスト。
モデルロード、インデックス進捗・統計、AI HTML生成の各エンドポイントを検証する。
"""

from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.vector.state import vector_state


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_vector_model_load_and_status(client: TestClient) -> None:
    """Mockモデルをロードして状態を取得できること"""
    res = client.post("/api/vector/model/load", json={"use_mock": True, "mock_dim": 64})
    assert res.status_code == 200
    data = res.json()
    assert data["loaded"] is True
    assert data["dim"] == 64

    res_st = client.get("/api/vector/model/status")
    assert res_st.status_code == 200
    st_data = res_st.json()
    assert st_data["loaded"] is True
    assert st_data["dim"] == 64
    assert "has_faiss" in st_data
    assert isinstance(st_data["has_faiss"], bool)


def test_vector_index_stats(client: TestClient) -> None:
    """インデックス統計およびモデル別統計が取得できること"""
    res = client.get("/api/vector/index/stats")
    assert res.status_code == 200
    data = res.json()
    assert "document_count" in data
    assert "chunk_count" in data
    assert "models" in data
    assert "ruri-v3-30m" in data["models"]
    assert "ruri-v3-310m" in data["models"]



def test_ai_html_export_api(client: TestClient, tmp_path: Path) -> None:
    """AI向けHTMLエクスポートエンドポイントを検証する"""
    doc = tmp_path / "test_export.md"
    doc.write_text("# テスト\nエクスポート内容", encoding="utf-8")

    res = client.post("/api/export/ai-html", json={
        "file_paths": [str(doc)],
        "prompt": "要約してください",
        "title": "テストドキュメント",
    })
    assert res.status_code == 200
    data = res.json()
    assert "<!DOCTYPE html>" in data["html_content"]
    assert data["total_documents"] == 1


def test_ai_html_save_api(client: TestClient, tmp_path: Path) -> None:
    """AI向けHTMLのローカルファイル保存と絶対パス返却を検証する"""
    html = "<!DOCTYPE html><html><body><h1>AI Context</h1></body></html>"

    # 1. 正常保存
    res = client.post("/api/export/ai-html/save", json={
        "html_content": html,
        "file_name": "my_ai_doc.html",
        "target_dir": str(tmp_path),
    })
    assert res.status_code == 200
    data = res.json()
    assert data["success"] is True
    assert "saved_path" in data
    assert data["file_name"] == "my_ai_doc.html"
    saved_file = Path(data["saved_path"])
    assert saved_file.is_file()
    assert saved_file.read_text(encoding="utf-8") == html

    # 2. 同名ファイル存在時の連番自動インクリメント
    res2 = client.post("/api/export/ai-html/save", json={
        "html_content": html,
        "file_name": "my_ai_doc.html",
        "target_dir": str(tmp_path),
    })
    assert res2.status_code == 200
    data2 = res2.json()
    assert data2["success"] is True
    assert data2["file_name"] == "my_ai_doc (1).html"
    saved_file2 = Path(data2["saved_path"])
    assert saved_file2.is_file()
    assert saved_file2.name == "my_ai_doc (1).html"
    assert saved_file2 != saved_file

    # 3. html_content が空の場合は 400 エラー
    res3 = client.post("/api/export/ai-html/save", json={
        "html_content": "",
        "file_name": "empty.html",
    })
    assert res3.status_code == 400



def test_vector_index_start_without_explicit_folders(client: TestClient, monkeypatch, tmp_path: Path) -> None:
    """target_folders 未指定時にDBの有効なローカルターゲットから正常にインデックス開始できること"""
    from unittest.mock import MagicMock

    from app.db.connection import get_connection
    from app.db.schema import initialize_schema

    enabled_folder = (tmp_path / "enabled").as_posix()
    connection = get_connection()
    try:
        initialize_schema(connection)
        connection.executemany(
            """
            INSERT INTO targets(
                full_path, exclude_keywords, index_depth, selected_extensions,
                is_search_target_enabled, source_type, created_at, updated_at
            )
            VALUES (?, '', 1, '', ?, ?, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')
            """,
            [
                (enabled_folder, 1, "local"),
                ((tmp_path / "disabled").as_posix(), 0, "local"),
                ("https://example.com/docs", 1, "web"),
            ],
        )
        connection.commit()
    finally:
        connection.close()
    monkeypatch.setattr(vector_state, "sync_index", MagicMock(return_value=None))

    res = client.post("/api/vector/index/start", json={"force_reindex": False})
    assert res.status_code == 200
    data = res.json()
    assert data["target_folders"] == [enabled_folder]
    assert data["message"] == "インデックス処理を開始しました"


def test_vector_index_start_without_registered_folders_returns_400(client: TestClient, monkeypatch) -> None:
    """有効なローカルターゲットが未登録のときは、インデックスを開始せず 400 を返すこと"""
    from unittest.mock import MagicMock

    from app.db.connection import get_connection
    from app.db.schema import initialize_schema

    connection = get_connection()
    try:
        initialize_schema(connection)
    finally:
        connection.close()
    sync_index = MagicMock(return_value=None)
    monkeypatch.setattr(vector_state, "sync_index", sync_index)

    res = client.post("/api/vector/index/start", json={"force_reindex": False})
    assert res.status_code == 400
    sync_index.assert_not_called()


def test_vector_index_start_with_model_path(client: TestClient, monkeypatch) -> None:
    """model_path を指定してインデックス開始できること"""
    from unittest.mock import MagicMock
    mock_load = MagicMock(return_value={"loaded": True, "dim": 256})
    mock_sync = MagicMock(return_value=None)
    monkeypatch.setattr(vector_state, "load_model", mock_load)
    monkeypatch.setattr(vector_state, "sync_index", mock_sync)

    res = client.post("/api/vector/index/start", json={
        "force_reindex": True,
        "model_path": "models/ruri-v3-310m",
        "target_folders": ["/test/folder"],
    })
    assert res.status_code == 200
    data = res.json()
    assert data["target_folders"] == ["/test/folder"]


def test_vector_index_pending_deletions_endpoint(client: TestClient, monkeypatch) -> None:
    """削除候補ファイル一覧を取得できること"""
    from unittest.mock import MagicMock
    mock_get = MagicMock(return_value=["/test/deleted1.md", "/test/deleted2.md"])
    monkeypatch.setattr(vector_state, "get_pending_deletions", mock_get)

    res = client.post("/api/vector/index/pending-deletions", json={
        "target_folders": ["/test/folder"],
        "model_path": "models/ruri-v3-30m",
    })
    assert res.status_code == 200
    data = res.json()
    assert data["count"] == 2
    assert data["pending_deletions"] == ["/test/deleted1.md", "/test/deleted2.md"]


def test_vector_index_start_accepts_clean_deleted_files(client: TestClient, monkeypatch) -> None:
    """clean_deleted_files 引数を受け取ってインデックスを開始できること"""
    from unittest.mock import MagicMock
    mock_sync = MagicMock(return_value=None)
    monkeypatch.setattr(vector_state, "sync_index", mock_sync)

    res = client.post("/api/vector/index/start", json={
        "force_reindex": False,
        "clean_deleted_files": False,
        "target_folders": ["/test/folder"],
    })
    assert res.status_code == 200




def test_vector_index_cancel_endpoint(client: TestClient, monkeypatch) -> None:
    """実行中のベクトルインデックス作成へ中止を要求できること"""
    from unittest.mock import MagicMock
    request_cancel = MagicMock(return_value=True)
    monkeypatch.setattr(vector_state, "request_cancel", request_cancel)

    res = client.post("/api/vector/index/cancel")

    assert res.status_code == 200
    assert res.json() == {"cancel_requested": True}
    request_cancel.assert_called_once_with()


def test_vector_index_start_passes_registered_folder_depths(client: TestClient, monkeypatch, tmp_path: Path) -> None:
    """登録済みの検索対象から開始するときは、各フォルダの階層数も渡すこと"""
    from unittest.mock import MagicMock
    from app.db.connection import get_connection
    from app.db.schema import initialize_schema

    folder = str(tmp_path / "depth_folder")
    connection = get_connection()
    try:
        initialize_schema(connection)
        connection.execute(
            "INSERT INTO targets (full_path, index_depth, created_at, updated_at) VALUES (?, 2, 'now', 'now')",
            (folder,),
        )
        connection.commit()
    finally:
        connection.close()
    sync_index = MagicMock(return_value=None)
    monkeypatch.setattr(vector_state, "sync_index", sync_index)

    res = client.post("/api/vector/index/start", json={"force_reindex": False})

    assert res.status_code == 200
    assert sync_index.call_args.kwargs["folder_depths"] == {folder: 2}


def test_vector_measure_text_endpoint_does_not_change_the_index(client: TestClient, monkeypatch, tmp_path: Path) -> None:
    """画面で作った本文の測定は、ファイルもインデックスも変更しないこと"""
    from app.vector.db import get_db_stats, get_model_db_path

    monkeypatch.setattr(vector_state, "data_dir", tmp_path)
    vector_state.load_model(use_mock=True, mock_dim=64)
    try:
        res = client.post("/api/vector/benchmark/text", json={"name": "preset.md", "content": "# 見出し\n\n本文です。"})
    finally:
        vector_state.embedder = None
        vector_state.searcher = None
        vector_state.model_path = None

    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "measured"
    assert data["chunk_count"] >= 1
    assert get_db_stats(get_model_db_path("mock_model", data_dir=tmp_path))["document_count"] == 0
