"""
たどらなかったフォルダのリンクを利用者へ案内するためのテスト。

ジャンクション（Windows）とフォルダのシンボリックリンク（全 OS）の先は走査しない。
その先にある文書は検索できないので、見つけたら画面で案内する。

仕様:
- 走査で見つけたリンクの場所・元のフォルダ・種類を記録する。リンクの中へは入らない。
- 元のフォルダが無いリンク、除外されたリンク、階層の上限より深いリンクは案内しない。
- 確認済みにしたリンクは再び案内しない。元のフォルダが変わったら、また案内する。
- 走査でリンクが無くなっていたら、記録を消す。読めなかったフォルダがある走査では消さない。
- 検索対象から外したフォルダのリンクは案内しない。
- 元のフォルダが検索対象に含まれるときは is_covered を返す（案内の文面を変えるため）。
"""

import os
import sqlite3
import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import main as app_main
from app.db.schema import initialize_schema, reset_schema
from app.services import exclude_rules
from app.services.file_walker import SkippedLink, walk_indexable_files
from app.services.index_service import IndexService
from app.services.skipped_link_store import SkippedLinkStore


def _make_junction(link: Path, target: Path) -> None:
    if os.name != "nt":
        pytest.skip("ジャンクションは Windows の機能")
    subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], check=True, capture_output=True)


def _make_symlink(link: Path, target: Path) -> None:
    try:
        os.symlink(target, link, target_is_directory=True)
    except OSError as error:
        pytest.skip(f"シンボリックリンクを作れない環境: {error}")


MAKE_LINK = [
    pytest.param(_make_junction, "junction", id="junction"),
    pytest.param(_make_symlink, "symlink", id="symlink"),
]


def _walk(
    root: Path,
    *,
    keywords: str = "",
    max_depth: int = 5,
) -> tuple[list[Path], dict[str, SkippedLink]]:
    keyword_set, substring_keywords, excluded_path_prefixes = exclude_rules.compile_exclude_keywords(
        exclude_rules.parse_exclude_keywords(keywords)
    )
    skipped: dict[str, SkippedLink] = {}
    found = list(
        walk_indexable_files(
            root,
            keyword_set,
            substring_keywords,
            excluded_path_prefixes=excluded_path_prefixes,
            auto_excluded_paths=set(),
            allowed_extensions=frozenset({".md"}),
            sorted_allowed_extensions=(".md",),
            max_depth=max_depth,
            skipped_links=skipped,
        )
    )
    return found, skipped


@pytest.fixture
def folders(tmp_path: Path) -> tuple[Path, Path]:
    """検索対象のフォルダと、その外にある元のフォルダを作る。"""
    target = (tmp_path / "work").resolve()
    outside = (tmp_path / "outside").resolve()
    target.mkdir()
    outside.mkdir()
    (target / "note.md").write_text("zebra", encoding="utf-8")
    (outside / "linked.md").write_text("linked", encoding="utf-8")
    return target, outside


@pytest.fixture
def connection(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    db = sqlite3.connect(tmp_path / "search.db")
    db.row_factory = sqlite3.Row
    initialize_schema(db)
    yield db
    db.close()


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app_main.create_app(), raise_server_exceptions=False) as test_client:
        yield test_client


def _register_and_index(client: TestClient, target: Path) -> None:
    client.post("/api/index/search-targets", json={"folder_path": target.as_posix(), "index_depth": 5})
    response = client.post("/api/index/search-targets/reindex", json={"folder_paths": [target.as_posix()]})
    assert response.status_code == 200


def _items(client: TestClient) -> list[dict[str, object]]:
    response = client.get("/api/index/skipped-links")
    assert response.status_code == 200
    return response.json()["items"]


@pytest.mark.parametrize(("make_link", "link_type"), MAKE_LINK)
def test_walker_records_the_link_and_does_not_enter_it(
    folders: tuple[Path, Path], make_link, link_type: str
) -> None:
    target, outside = folders
    link = target / "shared"
    make_link(link, outside)

    found, skipped = _walk(target)

    assert [path.name for path in found] == ["note.md"]
    assert list(skipped.values()) == [SkippedLink(link.as_posix(), outside.as_posix(), link_type)]


def test_walker_records_nothing_for_a_normal_folder(folders: tuple[Path, Path]) -> None:
    target, _ = folders
    (target / "sub").mkdir()
    (target / "sub" / "deep.md").write_text("deep", encoding="utf-8")

    found, skipped = _walk(target)

    assert sorted(path.name for path in found) == ["deep.md", "note.md"]
    assert skipped == {}


def test_walker_ignores_a_link_to_a_missing_folder(folders: tuple[Path, Path], tmp_path: Path) -> None:
    target, _ = folders
    gone = tmp_path / "gone"
    gone.mkdir()
    _make_symlink(target / "broken", gone)
    gone.rmdir()

    _, skipped = _walk(target)

    assert skipped == {}


def test_walker_ignores_an_excluded_link(folders: tuple[Path, Path]) -> None:
    target, outside = folders
    _make_symlink(target / "backup", outside)

    _, skipped = _walk(target, keywords="backup")

    assert skipped == {}


def test_walker_ignores_a_link_deeper_than_the_limit(folders: tuple[Path, Path]) -> None:
    target, outside = folders
    (target / "sub").mkdir()
    _make_symlink(target / "sub" / "shared", outside)

    assert _walk(target, max_depth=1)[1] == {}
    assert len(_walk(target, max_depth=2)[1]) == 1


@pytest.mark.parametrize(("make_link", "link_type"), MAKE_LINK)
def test_found_link_is_announced_with_its_original_folder(
    client: TestClient, folders: tuple[Path, Path], make_link, link_type: str
) -> None:
    target, outside = folders
    make_link(target / "shared", outside)

    _register_and_index(client, target)

    assert _items(client) == [
        {
            "link_path": (target / "shared").as_posix(),
            "target_path": outside.as_posix(),
            "link_type": link_type,
            "is_covered": False,
        }
    ]


def test_link_to_a_searched_folder_is_marked_as_covered(client: TestClient, folders: tuple[Path, Path]) -> None:
    target, _ = folders
    (target / "sub").mkdir()
    _make_symlink(target / "sub" / "back", target)

    _register_and_index(client, target)

    assert [item["is_covered"] for item in _items(client)] == [True]


def test_acknowledged_link_is_not_announced_again(client: TestClient, folders: tuple[Path, Path]) -> None:
    target, outside = folders
    link = target / "shared"
    _make_symlink(link, outside)
    _register_and_index(client, target)

    response = client.post("/api/index/skipped-links/acknowledge", json={"link_paths": [link.as_posix()]})
    _register_and_index(client, target)

    assert response.status_code == 200
    assert response.json() == {"acknowledged_count": 1}
    assert _items(client) == []


def test_link_is_announced_again_when_its_folder_changes(
    client: TestClient, folders: tuple[Path, Path], tmp_path: Path
) -> None:
    target, outside = folders
    link = target / "shared"
    _make_symlink(link, outside)
    _register_and_index(client, target)
    client.post("/api/index/skipped-links/acknowledge", json={"link_paths": [link.as_posix()]})
    other = (tmp_path / "other").resolve()
    other.mkdir()
    os.rmdir(link) if os.name == "nt" else link.unlink()
    _make_symlink(link, other)

    _register_and_index(client, target)

    assert [item["target_path"] for item in _items(client)] == [other.as_posix()]


def test_removed_link_is_forgotten(client: TestClient, folders: tuple[Path, Path]) -> None:
    target, outside = folders
    link = target / "shared"
    _make_symlink(link, outside)
    _register_and_index(client, target)
    os.rmdir(link) if os.name == "nt" else link.unlink()

    _register_and_index(client, target)

    assert _items(client) == []


def test_link_is_kept_when_part_of_the_folder_could_not_be_read(connection: sqlite3.Connection) -> None:
    store = SkippedLinkStore(connection)
    link = SkippedLink("C:/work/shared", "D:/data", "junction")
    store.sync("C:/work", 5, {link.link_path: link}, keep_missing=False)
    store.acknowledge([link.link_path])

    store.sync("C:/work", 5, {}, keep_missing=True)
    store.sync("C:/work", 5, {link.link_path: link}, keep_missing=False)

    assert store.list_unacknowledged(["C:/work"]).items == []


def test_shallow_scan_keeps_links_it_did_not_reach(connection: sqlite3.Connection) -> None:
    store = SkippedLinkStore(connection)
    link = SkippedLink("C:/work/a/b/shared", "D:/data", "junction")
    store.sync("C:/work", 5, {link.link_path: link}, keep_missing=False)

    store.sync("C:/work", 0, {}, keep_missing=False)

    assert len(store.list_unacknowledged(["C:/work"]).items) == 1


def test_scan_of_another_folder_keeps_links(connection: sqlite3.Connection) -> None:
    store = SkippedLinkStore(connection)
    link = SkippedLink("C:/work/shared", "D:/data", "junction")
    store.sync("C:/work", 5, {link.link_path: link}, keep_missing=False)

    store.sync("C:/workspace", 5, {}, keep_missing=False)

    assert len(store.list_unacknowledged(["C:/work"]).items) == 1


def test_link_of_a_removed_search_target_is_not_announced(client: TestClient, folders: tuple[Path, Path]) -> None:
    target, outside = folders
    _make_symlink(target / "shared", outside)
    _register_and_index(client, target)

    client.request("DELETE", "/api/index/search-targets", json={"folder_paths": [target.as_posix()]})

    assert _items(client) == []


def test_reset_clears_links(connection: sqlite3.Connection) -> None:
    store = SkippedLinkStore(connection)
    link = SkippedLink("C:/work/shared", "D:/data", "junction")
    store.sync("C:/work", 5, {link.link_path: link}, keep_missing=False)

    reset_schema(connection)

    assert store.list_unacknowledged(["C:/work"]).items == []


def test_existing_database_gets_the_table_and_keeps_its_rows(tmp_path: Path) -> None:
    db = sqlite3.connect(tmp_path / "old.db")
    db.row_factory = sqlite3.Row
    initialize_schema(db)
    target = (tmp_path / "work").resolve()
    target.mkdir()
    (target / "note.md").write_text("zebra", encoding="utf-8")
    IndexService(connection=db).ensure_fresh_target(full_path=target.as_posix(), refresh_window_minutes=0, index_depth=5)
    db.execute("DROP TABLE skipped_links")
    db.commit()

    initialize_schema(db)

    assert db.execute("SELECT COUNT(*) FROM files").fetchone()[0] == 1
    assert db.execute("SELECT COUNT(*) FROM skipped_links").fetchone()[0] == 0
    db.close()
