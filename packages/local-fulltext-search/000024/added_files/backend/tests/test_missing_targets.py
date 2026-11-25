"""
見つからない検索対象フォルダを利用者へ案内するためのテスト。

登録した検索対象フォルダが、移動・削除・未接続のドライブなどで見つからないと、
その配下は更新されない。気づけるように画面のポップアップで案内する。

仕様:
- 有効なローカルの検索対象のうち、フォルダが見つからないものを返す。
- 確認済みにしたフォルダは再び案内しない。
- フォルダが見つかるようになったら確認済みを解除し、また見つからなくなったら案内する。
- 無効にした検索対象と、フォルダのある検索対象は案内しない。
- 検索対象を削除すると、確認済みの記録も消える（同じパスを登録し直したら、また案内する）。
"""

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import main as app_main


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app_main.create_app(), raise_server_exceptions=False) as test_client:
        yield test_client


def _register(client: TestClient, folder: Path) -> None:
    response = client.post("/api/index/search-targets", json={"folder_path": folder.as_posix(), "index_depth": 1})
    assert response.status_code == 200


def _missing_paths(client: TestClient) -> list[str]:
    response = client.get("/api/index/missing-targets")
    assert response.status_code == 200
    return [str(item["full_path"]) for item in response.json()["items"]]


def _acknowledge(client: TestClient, *folders: Path) -> int:
    response = client.post(
        "/api/index/missing-targets/acknowledge",
        json={"full_paths": [folder.as_posix() for folder in folders]},
    )
    assert response.status_code == 200
    return int(response.json()["acknowledged_count"])


def _make_folder(tmp_path: Path, name: str) -> Path:
    folder = (tmp_path / name).resolve()
    folder.mkdir()
    return folder


def test_missing_folder_is_announced(client: TestClient, tmp_path: Path) -> None:
    missing = _make_folder(tmp_path, "moved")
    present = _make_folder(tmp_path, "present")
    _register(client, missing)
    _register(client, present)
    missing.rmdir()

    assert _missing_paths(client) == [missing.as_posix()]


def test_nothing_is_announced_when_every_folder_exists(client: TestClient, tmp_path: Path) -> None:
    _register(client, _make_folder(tmp_path, "present"))

    assert _missing_paths(client) == []


def test_acknowledged_folder_is_not_announced_again(client: TestClient, tmp_path: Path) -> None:
    missing = _make_folder(tmp_path, "moved")
    _register(client, missing)
    missing.rmdir()

    assert _acknowledge(client, missing) == 1
    assert _missing_paths(client) == []
    assert _acknowledge(client, missing) == 0  # 二度目は数えない


def test_folder_is_announced_again_after_it_comes_back_and_goes_missing(client: TestClient, tmp_path: Path) -> None:
    folder = _make_folder(tmp_path, "network-drive")
    _register(client, folder)
    folder.rmdir()
    _acknowledge(client, folder)

    folder.mkdir()  # 再接続した
    assert _missing_paths(client) == []

    folder.rmdir()  # また切断した
    assert _missing_paths(client) == [folder.as_posix()]


def test_disabled_target_is_not_announced(client: TestClient, tmp_path: Path) -> None:
    missing = _make_folder(tmp_path, "moved")
    _register(client, missing)
    response = client.put("/api/index/search-targets", json={"folder_path": missing.as_posix(), "is_enabled": False})
    assert response.status_code == 200
    missing.rmdir()

    assert _missing_paths(client) == []


def test_reregistered_target_is_announced_again(client: TestClient, tmp_path: Path) -> None:
    folder = _make_folder(tmp_path, "moved")
    _register(client, folder)
    folder.rmdir()
    _acknowledge(client, folder)

    response = client.request("DELETE", "/api/index/search-targets", json={"folder_paths": [folder.as_posix()]})
    assert response.status_code == 200
    folder.mkdir()
    _register(client, folder)
    folder.rmdir()

    assert _missing_paths(client) == [folder.as_posix()]


def _write_note(folder: Path, relative: str) -> None:
    path = folder / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("zebra", encoding="utf-8")


def test_search_target_list_marks_missing_folder(client: TestClient, tmp_path: Path) -> None:
    """検索対象フォルダの一覧で、フォルダが見つからない行に is_missing を立てる（画面で × と赤字にする）。"""
    missing = _make_folder(tmp_path, "moved")
    present = _make_folder(tmp_path, "present")
    _register(client, missing)
    _register(client, present)
    missing.rmdir()

    response = client.get("/api/index/search-targets")
    assert response.status_code == 200
    flags = {item["full_path"]: item["is_missing"] for item in response.json()["items"]}
    assert flags == {missing.as_posix(): True, present.as_posix(): False}


def test_indexed_folder_list_marks_folders_under_a_missing_target(client: TestClient, tmp_path: Path) -> None:
    """
    インデックス済みフォルダの一覧で、見つからない検索対象の配下にある行に is_missing を立てる。
    インデックスは消さない（利用者が一覧から選んで削除する）。
    """
    import shutil

    missing = _make_folder(tmp_path, "moved")
    present = _make_folder(tmp_path, "present")
    _write_note(missing, "sub/a.md")
    _write_note(present, "b.md")
    for folder in (missing, present):
        client.post("/api/index/search-targets", json={"folder_path": folder.as_posix(), "index_depth": 5})
        response = client.post("/api/index/search-targets/reindex", json={"folder_paths": [folder.as_posix()]})
        assert response.status_code == 200
    shutil.rmtree(missing)

    response = client.get("/api/index/targets")
    assert response.status_code == 200
    flags = {item["full_path"]: item["is_missing"] for item in response.json()["items"]}
    assert flags[(missing / "sub").as_posix()] is True
    assert flags[present.as_posix()] is False
