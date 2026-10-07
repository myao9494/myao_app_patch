"""コード内の sys.path 追加箇所の自動検出と外部ライブラリ解決テスト。

仕様:
1. コード内で sys.path.append() または sys.path.insert() で追加されているディレクトリパスを静的解析（AST）で抽出する。
2. 文字列リテラル、相対パス（Path(__file__).parent / ... や os.path.join など）を解決してインポート検索ルートに加える。
3. そのディレクトリ（Git管理下の外部ライブラリ）内のモジュールを discover_reference_modules で正しく参照先として検出する。
4. pip等でインストールされた site-packages 内のライブラリは対象外とする。
"""

from __future__ import annotations

from pathlib import Path

from backend.references import discover_reference_modules, extract_sys_path_entries


def _git_marker(root: Path) -> None:
    (root / ".git").mkdir(parents=True, exist_ok=True)


def test_コード内のsys_path_appendとsys_path_insertからパスを抽出する(tmp_path: Path) -> None:
    main_repo = tmp_path / "main_repo"
    main_repo.mkdir()
    code_file = main_repo / "run.py"
    code_file.write_text(
        'import sys\n'
        'import os\n'
        'from pathlib import Path\n'
        'sys.path.append("../common_lib")\n'
        'sys.path.insert(0, str(Path(__file__).parent / "extra_lib"))\n'
        'sys.path.append("/opt/custom_lib")\n',
        encoding="utf-8",
    )

    entries = extract_sys_path_entries(main_repo, [code_file])

    expected_common = (main_repo / "../common_lib").resolve()
    expected_extra = (main_repo / "extra_lib").resolve()
    assert expected_common in entries or str(expected_common) in [str(p) for p in entries]
    assert expected_extra in entries or str(expected_extra) in [str(p) for p in entries]


def test_sys_path_appendされた外部ライブラリのモジュールが検出される(tmp_path: Path) -> None:
    main = tmp_path / "main_repo"
    common = tmp_path / "common_lib"
    main.mkdir(); (common / "common_pkg").mkdir(parents=True)
    _git_marker(main); _git_marker(common)

    (main / "app.py").write_text(
        'import sys\n'
        'sys.path.append("../common_lib")\n'
        'import common_pkg.utils as utils\n'
        'print(utils.greet())\n',
        encoding="utf-8",
    )
    (common / "common_pkg" / "__init__.py").write_text("", encoding="utf-8")
    (common / "common_pkg" / "utils.py").write_text(
        'def greet(): return "hello"\n',
        encoding="utf-8",
    )

    result = discover_reference_modules(main, ["app.py"])

    assert result["enabled"] is True
    assert len(result["repositories"]) == 1
    repo = result["repositories"][0]
    assert Path(repo["path"]).resolve() == common.resolve()
    assert "common_pkg/utils.py" in repo["files"]
