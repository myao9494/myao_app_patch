"""外部ライブラリルート検出(external_roots)の統合テスト。"""

from __future__ import annotations

from pathlib import Path

from backend.external_roots import get_external_roots


def _make_repo(tmp_path: Path) -> tuple[Path, Path]:
    repo = tmp_path / "main_repo"
    repo.mkdir()
    lib = tmp_path / "common_lib"
    lib.mkdir()
    return repo, lib


def test_コード内のsys_pathの追加先を外部ルートとして検出する(tmp_path: Path):
    repo, lib = _make_repo(tmp_path)
    (repo / "app.py").write_text("import sys\nsys.path.append('../common_lib')\n", encoding="utf-8")
    assert lib.resolve() in get_external_roots(repo)


def test_ファイル数が多くても後ろのファイルのsys_pathを検出する(tmp_path: Path):
    repo, lib = _make_repo(tmp_path)
    for index in range(80):
        (repo / f"module_{index:03d}.py").write_text("VALUE = 1\n", encoding="utf-8")
    (repo / "zz_last.py").write_text("import sys\nsys.path.insert(0, '../common_lib')\n", encoding="utf-8")
    assert lib.resolve() in get_external_roots(repo)


def test_仮想環境内のファイルのsys_pathは外部ルートにしない(tmp_path: Path):
    repo, lib = _make_repo(tmp_path)
    venv_pkg = repo / ".venv" / "lib" / "pkg"
    venv_pkg.mkdir(parents=True)
    (venv_pkg / "hack.py").write_text("import sys\nsys.path.append('../../../../common_lib')\n", encoding="utf-8")
    assert get_external_roots(repo) == []


def test_PYTHONPATHのディレクトリを外部ルートに含める(tmp_path: Path, monkeypatch):
    repo, lib = _make_repo(tmp_path)
    monkeypatch.setenv("PYTHONPATH", str(lib))
    assert get_external_roots(repo) == [lib.resolve()]
