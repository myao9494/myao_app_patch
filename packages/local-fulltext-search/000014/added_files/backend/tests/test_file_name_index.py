"""
ファイル名索引（app.vector.file_name_index）のテスト。

仕様:
- 同じ根フォルダへの探索は、スコープ内では 1 回の走査結果を共有する（os.walk を繰り返さない）。
- 候補名が複数あるときは、走査順で先に現れるフォルダを優先し、同じフォルダ内では候補の並び順を優先する。
- スコープ外では従来どおり早期終了する走査で、結果は同じになる。
- 隠しフォルダの扱いは hidden 指定（skip_files / prune / none）で従来の各探索と一致させる。
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.vector import file_name_index
from app.vector.file_name_index import find_file_by_names, file_name_index_scope


def _make_tree(root: Path) -> None:
    (root / "a").mkdir()
    (root / "b").mkdir()
    (root / ".hidden").mkdir()
    (root / "a" / "pic.png").write_bytes(b"a")
    (root / "b" / "pic.png").write_bytes(b"b")
    (root / "b" / "pic.svg").write_bytes(b"s")
    (root / ".hidden" / "only.png").write_bytes(b"h")


def test_finds_first_match_in_walk_order(tmp_path: Path) -> None:
    _make_tree(tmp_path)
    found = find_file_by_names(tmp_path, ["pic.png"])
    assert found is not None and found.name == "pic.png"
    assert found.parent.name in {"a", "b"}


def test_candidate_priority_within_same_directory(tmp_path: Path) -> None:
    (tmp_path / "d").mkdir()
    (tmp_path / "d" / "x.png").write_bytes(b"1")
    (tmp_path / "d" / "x.svg").write_bytes(b"2")
    assert find_file_by_names(tmp_path, ["x.svg", "x.png"]).name == "x.svg"
    with file_name_index_scope():
        assert find_file_by_names(tmp_path, ["x.svg", "x.png"]).name == "x.svg"
        assert find_file_by_names(tmp_path, ["x.png", "x.svg"]).name == "x.png"


def test_scope_and_unscoped_give_same_result(tmp_path: Path) -> None:
    _make_tree(tmp_path)
    names = ["missing.png", "pic.svg", "pic.png"]
    plain = find_file_by_names(tmp_path, names)
    with file_name_index_scope():
        scoped = find_file_by_names(tmp_path, names)
    assert plain == scoped


def test_hidden_modes(tmp_path: Path) -> None:
    _make_tree(tmp_path)
    for scoped in (False, True):
        def run(hidden: str):
            if scoped:
                with file_name_index_scope():
                    return find_file_by_names(tmp_path, ["only.png"], hidden=hidden)
            return find_file_by_names(tmp_path, ["only.png"], hidden=hidden)

        assert run("skip_files") is None
        assert run("prune") is None
        assert run("none") is not None


def test_missing_returns_none(tmp_path: Path) -> None:
    _make_tree(tmp_path)
    with file_name_index_scope():
        assert find_file_by_names(tmp_path, ["nope.png"]) is None
    assert find_file_by_names(tmp_path / "does-not-exist", ["x"]) is None


def test_scope_walks_each_root_only_once(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _make_tree(tmp_path)
    calls = {"n": 0}
    real_walk = os.walk

    def counting_walk(*args, **kwargs):
        calls["n"] += 1
        return real_walk(*args, **kwargs)

    monkeypatch.setattr(file_name_index.os, "walk", counting_walk)
    with file_name_index_scope():
        for _ in range(20):
            find_file_by_names(tmp_path, ["missing.png"])
            find_file_by_names(tmp_path, ["pic.png"])
    assert calls["n"] == 1


def test_nested_scope_shares_outer_index(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _make_tree(tmp_path)
    calls = {"n": 0}
    real_walk = os.walk

    def counting_walk(*args, **kwargs):
        calls["n"] += 1
        return real_walk(*args, **kwargs)

    monkeypatch.setattr(file_name_index.os, "walk", counting_walk)
    with file_name_index_scope():
        find_file_by_names(tmp_path, ["pic.png"])
        with file_name_index_scope():
            find_file_by_names(tmp_path, ["pic.svg"])
    assert calls["n"] == 1


def test_scope_does_not_leak_after_exit(tmp_path: Path) -> None:
    _make_tree(tmp_path)
    with file_name_index_scope():
        assert find_file_by_names(tmp_path, ["late.png"]) is None
    (tmp_path / "a" / "late.png").write_bytes(b"x")
    assert find_file_by_names(tmp_path, ["late.png"]) is not None


def test_html_export_walks_vault_once_for_many_missing_images(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """見つからない画像が多数あっても、書き出し 1 回で同じフォルダの走査は 1 回だけ（根ごと）。"""
    from app.vector.html_exporter import export_documents_to_html

    note = tmp_path / "note.md"
    note.write_text("\n".join(f"![[missing_{i}.png]]" for i in range(30)), encoding="utf-8")

    walked: list[str] = []
    real_walk = os.walk

    def recording_walk(top, *args, **kwargs):
        walked.append(str(top))
        return real_walk(top, *args, **kwargs)

    monkeypatch.setattr(file_name_index.os, "walk", recording_walk)
    export_documents_to_html(file_paths=[str(note)], include_images=True)

    assert len(walked) == len(set(walked)), walked
