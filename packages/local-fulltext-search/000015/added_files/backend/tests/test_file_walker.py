"""
file_walker の走査中エラーの扱いのテスト。

- WinError 59（到達不能な共有先）: そのフォルダを auto_excluded_paths へ追加して走査を続ける。
- WinError 3（走査中に消えた / 開けない名前のフォルダ）: そのフォルダだけ読み飛ばす。
  一時的な事象なので auto_excluded_paths へは追加しない（除外設定へ永続化させない）。
- 対象フォルダ自体が見つからない場合は握りつぶさず例外にする。
"""

from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import patch

import pytest

from app.services import file_walker


def _walk(root: Path, auto_excluded: set[str]) -> list[str]:
    return sorted(
        path.name
        for path in file_walker.walk_indexable_files(
            root,
            frozenset(),
            [],
            excluded_path_prefixes=(),
            auto_excluded_paths=auto_excluded,
            allowed_extensions=frozenset({".md"}),
            sorted_allowed_extensions=(".md",),
            max_depth=5,
        )
    )


def _make_tree(tmp_path: Path) -> Path:
    root = tmp_path / "docs"
    (root / "broken").mkdir(parents=True)
    (root / "ok.md").write_text("a", encoding="utf-8")
    (root / "broken" / "inside.md").write_text("b", encoding="utf-8")
    return root


def _scandir_failing_for(name: str, winerror: int, exc_type: type[OSError]):
    original = os.scandir

    def fake(path):
        if Path(path).name == name:
            error = exc_type(f"[WinError {winerror}]")
            error.winerror = winerror
            raise error
        return original(path)

    return fake


def test_winerror_3_in_subfolder_is_skipped_without_auto_exclude(tmp_path: Path) -> None:
    root = _make_tree(tmp_path)
    auto_excluded: set[str] = set()

    with patch("app.services.file_walker.os.scandir", side_effect=_scandir_failing_for("broken", 3, FileNotFoundError)):
        names = _walk(root, auto_excluded)

    assert names == ["ok.md"]
    assert auto_excluded == set()


def test_winerror_59_in_subfolder_is_auto_excluded(tmp_path: Path) -> None:
    root = _make_tree(tmp_path)
    auto_excluded: set[str] = set()

    with patch("app.services.file_walker.os.scandir", side_effect=_scandir_failing_for("broken", 59, OSError)):
        names = _walk(root, auto_excluded)

    assert names == ["ok.md"]
    assert len(auto_excluded) == 1


def test_missing_root_still_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        _walk(tmp_path / "does-not-exist", set())


def test_unreadable_entry_does_not_abort_siblings(tmp_path: Path) -> None:
    """1 つのエントリの判定が OSError になっても、同じフォルダの残りのエントリは走査する。"""
    root = tmp_path / "docs"
    (root / "a").mkdir(parents=True)
    (root / "z.md").write_text("z", encoding="utf-8")
    (root / "a" / "in.md").write_text("i", encoding="utf-8")
    original = os.scandir

    class _Entry:
        def __init__(self, real):
            self._real = real
            self.name = real.name
            self.path = real.path

        def is_dir(self, follow_symlinks=True):
            if self.name == "a":
                raise OSError(22, "invalid")
            return self._real.is_dir(follow_symlinks=follow_symlinks)

        def is_file(self, follow_symlinks=True):
            return self._real.is_file(follow_symlinks=follow_symlinks)

    class _Scan:
        def __init__(self, real):
            self._real = real

        def __enter__(self):
            self._entries = [_Entry(e) for e in self._real.__enter__()]
            return iter(self._entries)

        def __exit__(self, *args):
            return self._real.__exit__(*args)

    def fake(path):
        return _Scan(original(path))

    with patch("app.services.file_walker.os.scandir", side_effect=fake):
        names = _walk(root, set())

    assert "z.md" in names


def test_other_oserror_in_subfolder_is_skipped(tmp_path: Path) -> None:
    """配下フォルダの想定外の OSError で走査全体を止めない（対象フォルダ自体は例外にする）。"""
    root = _make_tree(tmp_path)
    auto_excluded: set[str] = set()

    with patch("app.services.file_walker.os.scandir", side_effect=_scandir_failing_for("broken", 22, OSError)):
        names = _walk(root, auto_excluded)

    assert names == ["ok.md"]
    assert auto_excluded == set()
