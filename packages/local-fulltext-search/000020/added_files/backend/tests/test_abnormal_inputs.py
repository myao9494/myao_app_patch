"""
異常な入力とファイルを受けても、サーバーエラーにならないことのテスト。

仕様:
- 検索語の NUL 文字は区切りとして扱う（FTS5 は NUL で文字列が終わるため、そのまま渡すと構文エラーになる）。
- SQLite の整数に収まらない file_id、NUL を含むパスは入力エラー（4xx）で返す。
- 本文を読めなかったファイルも、ファイル名では検索できる。読めるようになれば本文も検索できる。
- フォルダのジャンクションはシンボリックリンクと同じくたどらない（ループで同じファイルを何度も処理しない）。
- 更新日時が 1970 年より前や遠い将来のファイルがあっても検索できる（Windows の時刻変換は範囲外で失敗する）。
- 日付条件はどの日付でも受け付ける。
- 保存先を作れないときは、理由を付けて入力エラーで返す。長いファイル名は保存できる長さへ切り詰める。
- 設定ファイルは UTF-8 以外で保存されていても読める。保存は途中で失敗しても元の内容を残す。
- ファイルの物理削除は expected_path が無ければ受け付けない。
- Web ページの charset が不正でも、文字コードを判定して読む。
"""

import io
import json
import os
import sqlite3
import subprocess
import threading
from collections.abc import Iterator
from email.message import Message
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import main as app_main
from app.config import settings
from app.db.schema import initialize_schema
from app.services.app_settings_store import read_settings_file, write_settings_file
from app.services import web_pages
from app.services.index_service import IndexService

SQLITE_INTEGER_OVERFLOW = 2**63


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app_main.create_app(), raise_server_exceptions=False) as test_client:
        yield test_client


@pytest.fixture
def connection(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    db = sqlite3.connect(tmp_path / "search.db")
    db.row_factory = sqlite3.Row
    initialize_schema(db)
    yield db
    db.close()


def _index(connection: sqlite3.Connection, target: Path, depth: int = 40) -> None:
    IndexService(connection=connection).ensure_fresh_target(
        full_path=target.as_posix(), refresh_window_minutes=0, index_depth=depth
    )


@pytest.mark.parametrize("query", ["\x00", "寿司\x00", "a\x00b", "-\x00", '"\x00', "\x00 OR \x00"])
@pytest.mark.parametrize("search_type", ["keyword", "hybrid"])
def test_nul_in_query_is_not_a_server_error(client: TestClient, query: str, search_type: str) -> None:
    response = client.post(
        "/api/search", json={"q": query, "search_all_enabled": True, "skip_refresh": True, "search_type": search_type}
    )

    assert response.status_code < 500


def test_nul_separates_search_terms(client: TestClient, tmp_path: Path) -> None:
    target = (tmp_path / "work").resolve()
    target.mkdir()
    (target / "note.md").write_text("寿司 と 天ぷら", encoding="utf-8")
    client.post("/api/index/search-targets", json={"folder_path": target.as_posix(), "index_depth": 5})
    client.post("/api/index/search-targets/reindex", json={"folder_paths": [target.as_posix()]})

    response = client.post(
        "/api/search", json={"q": "寿司\x00天ぷら", "search_all_enabled": True, "skip_refresh": True, "search_type": "keyword"}
    )

    assert response.status_code == 200
    assert response.json()["total"] == 1


def test_everything_compatible_search_rejects_an_empty_query(client: TestClient) -> None:
    assert client.get("/api/index?search=").status_code == 422


def test_file_id_outside_the_sqlite_range_is_rejected(client: TestClient) -> None:
    assert client.post("/api/search/click", json={"file_id": SQLITE_INTEGER_OVERFLOW}).status_code == 422
    assert client.delete(f"/api/files/{SQLITE_INTEGER_OVERFLOW}").status_code == 422


@pytest.mark.parametrize(
    "path",
    ["/api/export/resolve-links", "/api/export/ai-html", "/api/export/ai-bundle/generate"],
)
@pytest.mark.parametrize(
    "body",
    [
        {"file_paths": ["bad\x00.md"]},
        {"file_paths": ["a.md"], "vault_path": "\x00"},
        {"file_paths": ["a.md"], "excluded_file_paths": ["\x00"]},
    ],
)
def test_nul_in_export_paths_is_rejected(client: TestClient, path: str, body: dict[str, object]) -> None:
    assert client.post(path, json=body).status_code == 422


def test_nul_in_a_page_url_is_not_a_server_error(client: TestClient) -> None:
    assert client.get("/%00").status_code < 500
    assert client.get("/assets/%00").status_code < 500


def test_too_long_model_path_is_rejected(client: TestClient) -> None:
    assert client.post("/api/vector/index/pending-deletions", json={"model_path": "x" * 3000}).status_code == 422


def test_unreadable_file_is_still_found_by_name(tmp_path: Path, connection: sqlite3.Connection) -> None:
    target = (tmp_path / "work").resolve()
    target.mkdir()
    (target / "壊れた契約書.pdf").write_bytes(b"%PDF-1.7\n1 0 obj\n<<garbage")

    _index(connection, target)

    row = connection.execute("SELECT file_name, last_error FROM files").fetchone()
    assert row["file_name"] == "壊れた契約書.pdf"
    assert row["last_error"]
    assert connection.execute("SELECT COUNT(*) FROM failed_files").fetchone()[0] == 1
    assert connection.execute("SELECT COUNT(*) FROM file_segments WHERE segment_type = 'body'").fetchone()[0] == 0


def test_file_that_becomes_readable_gets_its_body_indexed(tmp_path: Path, connection: sqlite3.Connection) -> None:
    target = (tmp_path / "work").resolve()
    target.mkdir()
    path = target / "data.json"
    path.write_text("{}", encoding="utf-8")
    deep = "[" * 200000 + "]" * 200000
    path.write_text(deep, encoding="utf-8")
    _index(connection, target)
    assert connection.execute("SELECT last_error FROM files").fetchone()[0]

    path.write_text('{"a": "社内規程"}', encoding="utf-8")
    os.utime(path, (path.stat().st_atime, path.stat().st_mtime + 10))
    _index(connection, target)

    assert connection.execute("SELECT last_error FROM files").fetchone()[0] is None
    assert connection.execute("SELECT COUNT(*) FROM failed_files").fetchone()[0] == 0
    assert "社内規程" in connection.execute("SELECT content FROM file_segments WHERE segment_type = 'body'").fetchone()[0]


@pytest.mark.skipif(os.name != "nt", reason="ジャンクションは Windows の機能")
def test_junction_loop_is_not_followed(tmp_path: Path, connection: sqlite3.Connection) -> None:
    target = (tmp_path / "work").resolve()
    (target / "sub").mkdir(parents=True)
    (target / "note.md").write_text("zebra", encoding="utf-8")
    subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(target / "sub" / "back"), str(target)], check=True, capture_output=True
    )

    _index(connection, target)

    assert connection.execute("SELECT COUNT(*) FROM files").fetchone()[0] == 1
    assert connection.execute("SELECT COUNT(*) FROM failed_files").fetchone()[0] == 0
    (target / "sub" / "back").rmdir()


@pytest.fixture
def indexed_times(client: TestClient, tmp_path: Path) -> dict[str, float]:
    """極端な更新日時のファイルをインデックスする。"""
    target = (tmp_path / "times").resolve()
    target.mkdir()
    times = {"past": -315619200.0, "epoch": 0.0, "future": 48281000000.0}
    for name, value in times.items():
        path = target / f"{name}.md"
        path.write_text(f"zebra {name}", encoding="utf-8")
        os.utime(path, (value, value))
    client.post("/api/index/search-targets", json={"folder_path": target.as_posix(), "index_depth": 5})
    client.post("/api/index/search-targets/reindex", json={"folder_paths": [target.as_posix()]})
    return times


@pytest.mark.parametrize("sort_by", ["default", "modified", "created"])
def test_files_with_extreme_times_are_searchable(
    client: TestClient, indexed_times: dict[str, float], sort_by: str
) -> None:
    response = client.post(
        "/api/search",
        json={"q": "zebra", "search_all_enabled": True, "skip_refresh": True, "search_type": "keyword", "sort_by": sort_by},
    )

    assert response.status_code == 200
    assert response.json()["total"] == len(indexed_times)
    assert {item["mtime"][:4] for item in response.json()["items"]} == {"1960", "1970", "3499"}


@pytest.mark.parametrize(
    ("created_from", "created_to", "expected"),
    [
        ("1900-01-01", None, 3),
        (None, "9999-12-31", 3),
        ("0001-01-01", "9999-12-31", 3),
        ("9999-12-31", None, 0),
        (None, "1900-01-01", 0),
        (None, "1959-12-31", 0),
        (None, "1960-01-01", 1),
        ("3000-01-01", None, 1),
    ],
)
def test_any_date_filter_is_accepted(
    client: TestClient,
    indexed_times: dict[str, float],
    created_from: str | None,
    created_to: str | None,
    expected: int,
) -> None:
    response = client.post(
        "/api/search",
        json={
            "q": "zebra",
            "search_all_enabled": True,
            "skip_refresh": True,
            "search_type": "keyword",
            "date_field": "modified",
            "created_from": created_from,
            "created_to": created_to,
        },
    )

    assert response.status_code == 200
    assert response.json()["total"] == expected


@pytest.mark.skipif(os.name != "nt", reason="「/」が絶対パスでないのは Windows だけ")
@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/api/search", {"q": "a", "full_path": "/", "skip_refresh": True}),
        ("/api/search/indexed", {"q": "a", "folder_path": "/"}),
    ],
)
def test_path_without_a_drive_is_rejected(client: TestClient, path: str, body: dict[str, object]) -> None:
    assert client.post(path, json=body).status_code == 422


def test_too_deep_index_depth_is_rejected(client: TestClient, tmp_path: Path) -> None:
    response = client.post(
        "/api/index/search-targets", json={"folder_path": tmp_path.as_posix(), "index_depth": 2**63}
    )

    assert response.status_code == 422


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/api/export/ai-html/save", {"html_content": "<p>x</p>"}),
        ("/api/export/ai-html/save-parts", {"html_parts": ["<p>x</p>"]}),
        ("/api/export/ai-bundle/save", {"file_paths": ["a.md"]}),
    ],
)
def test_unusable_save_folder_is_an_input_error(
    client: TestClient, tmp_path: Path, path: str, body: dict[str, object]
) -> None:
    blocker = tmp_path / "file.txt"
    blocker.write_text("x", encoding="utf-8")

    assert client.post(path, json={**body, "target_dir": "\x00"}).status_code == 422
    response = client.post(path, json={**body, "target_dir": (blocker / "sub").as_posix()})

    assert response.status_code == 400
    assert "保存先" in response.json()["detail"]


def test_too_long_file_name_is_shortened_when_saving(client: TestClient, tmp_path: Path) -> None:
    html = client.post(
        "/api/export/ai-html/save",
        json={"html_content": "<p>x</p>", "file_name": "長" * 3000, "target_dir": tmp_path.as_posix()},
    )
    parts = client.post(
        "/api/export/ai-html/save-parts",
        json={"html_parts": ["<p>x</p>"], "file_name": "長" * 3000, "target_dir": tmp_path.as_posix()},
    )

    assert html.status_code == 200
    assert parts.status_code == 200
    assert Path(html.json()["saved_path"]).is_file()
    assert json.dumps(parts.json())


@pytest.mark.parametrize(
    "raw",
    ["秘密フォルダ".encode("cp932"), "秘密フォルダ".encode("utf-8-sig"), "秘密フォルダ".encode("utf-16")],
    ids=["cp932", "utf8bom", "utf16"],
)
def test_settings_file_in_another_encoding_is_readable(client: TestClient, raw: bytes) -> None:
    settings.exclude_keywords_path.write_bytes(raw)

    response = client.get("/api/index/settings")

    assert response.status_code == 200
    assert response.json()["exclude_keywords"] == "秘密フォルダ"


def test_broken_settings_file_does_not_stop_search(client: TestClient) -> None:
    settings.exclude_keywords_path.write_bytes(bytes(range(128, 256)))
    settings.confirm_index_deletion_path.write_bytes(bytes(range(128, 256)))

    assert client.get("/api/index/settings").status_code == 200
    assert client.post("/api/search", json={"q": "a", "search_all_enabled": True, "skip_refresh": True}).status_code == 200


def test_failed_save_keeps_the_previous_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    folder = tmp_path / "settings"
    folder.mkdir()
    path = folder / "exclude_keywords.txt"
    path.write_text("old value", encoding="utf-8")

    def fail(_source: object, _destination: object) -> None:
        raise OSError("disk error")

    monkeypatch.setattr(os, "replace", fail)
    with pytest.raises(OSError, match="disk error"):
        write_settings_file(path, "new value")

    assert path.read_text(encoding="utf-8") == "old value"
    assert [item.name for item in folder.iterdir()] == [path.name]


def test_save_waits_for_a_file_in_use(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    folder = tmp_path / "settings"
    folder.mkdir()
    path = folder / "exclude_keywords.txt"
    path.write_text("old value", encoding="utf-8")
    real_replace = os.replace
    attempts: list[object] = []

    def busy_twice(source: str, destination: Path) -> None:
        attempts.append(source)
        if len(attempts) <= 2:
            raise PermissionError("in use")
        real_replace(source, destination)

    monkeypatch.setattr(os, "replace", busy_twice)
    write_settings_file(path, "new value")

    assert path.read_text(encoding="utf-8") == "new value"
    assert len(attempts) == 3
    assert [item.name for item in folder.iterdir()] == [path.name]


def test_deleting_a_file_requires_the_expected_path(client: TestClient, tmp_path: Path) -> None:
    target = (tmp_path / "work").resolve()
    target.mkdir()
    file = target / "note.md"
    file.write_text("zebra", encoding="utf-8")
    client.post("/api/index/search-targets", json={"folder_path": target.as_posix(), "index_depth": 5})
    client.post("/api/index/search-targets/reindex", json={"folder_paths": [target.as_posix()]})
    file_id = client.post(
        "/api/search", json={"q": "zebra", "search_all_enabled": True, "skip_refresh": True, "search_type": "keyword"}
    ).json()["items"][0]["file_id"]

    response = client.delete(f"/api/files/{file_id}")

    assert response.status_code == 422
    assert file.exists()


def test_read_waits_while_the_file_is_being_replaced(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Windows では置き換えの最中に開くと PermissionError になる。"""
    path = tmp_path / "exclude_keywords.txt"
    path.write_text("value", encoding="utf-8")
    real_read_bytes = Path.read_bytes
    attempts: list[Path] = []

    def busy_twice(self: Path) -> bytes:
        attempts.append(self)
        if len(attempts) <= 2:
            raise PermissionError("replacing")
        return real_read_bytes(self)

    monkeypatch.setattr(Path, "read_bytes", busy_twice)

    assert read_settings_file(path) == "value"
    assert len(attempts) == 3


def test_read_and_save_at_the_same_time(tmp_path: Path) -> None:
    path = tmp_path / "exclude_keywords.txt"
    write_settings_file(path, "value")
    errors: list[BaseException] = []
    done = threading.Event()

    def reader() -> None:
        while not done.is_set():
            try:
                assert read_settings_file(path) == "value"
            except BaseException as error:  # noqa: BLE001
                errors.append(error)
                return

    threads = [threading.Thread(target=reader) for _ in range(4)]
    for thread in threads:
        thread.start()
    try:
        for _ in range(300):
            write_settings_file(path, "value")
    finally:
        done.set()
        for thread in threads:
            thread.join()

    assert errors == []


def test_web_page_with_an_unknown_charset_is_readable(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeResponse(io.BytesIO):
        headers = Message()

    FakeResponse.headers["Content-Type"] = "text/html; charset=x-unknown-charset"
    monkeypatch.setattr(web_pages, "urlopen", lambda *_args, **_kwargs: FakeResponse("社内規程".encode("cp932")))

    assert web_pages.fetch_web_page("http://example.test/") == "社内規程"
