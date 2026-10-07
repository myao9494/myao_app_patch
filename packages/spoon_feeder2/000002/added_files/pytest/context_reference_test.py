"""外部モジュールを含む場合のコンテキスト生成およびシステム指示文テスト。

仕様:
1. build_context において、reference_files が含まれている場合、system_instructions の対象範囲指示が「main_repository および reference_repositories のファイルが変更対象」となり、外部ライブラリの修正も含めてよいことが明記される。
2. reference_repository タグの属性または説明で、外部ライブラリが編集可能であることが示される。
3. reference_files が空の場合は、外部リポジトリに関するブロックは含まれず、メインリポジトリのみが出力される。
"""

from __future__ import annotations

from pathlib import Path

from backend.repository import build_context


def _git_marker(root: Path) -> None:
    (root / ".git").mkdir(parents=True, exist_ok=True)


def test_参照モジュールを含む場合に外部ライブラリも変更対象とする指示が出力される(tmp_path: Path) -> None:
    main_repo = tmp_path / "main_repo"
    common_repo = tmp_path / "common_lib"
    main_repo.mkdir(); common_repo.mkdir()
    _git_marker(main_repo); _git_marker(common_repo)

    (main_repo / "main.py").write_text("print('hello')\n", encoding="utf-8")
    (common_repo / "util.py").write_text("def helper(): pass\n", encoding="utf-8")

    reference_files = [
        {"repository_path": str(common_repo), "files": ["util.py"]}
    ]

    context, file_count, ref_count = build_context(main_repo, ["main.py"], reference_files)

    assert file_count == 1
    assert ref_count == 1
    assert "<reference_repository" in context
    # 外部ライブラリも変更対象に含めてよい指示になっていること
    assert "reference_repositories" in context
    assert "外部ライブラリ" in context or "reference_repositories" in context
    assert "読み取り専用ライブラリであり、変更案・テスト・変更先に含めてはいけません" not in context
    assert "変更案" in context


def test_参照モジュールが空の場合はメインリポジトリのみ出力される(tmp_path: Path) -> None:
    main_repo = tmp_path / "main_repo"
    main_repo.mkdir()
    _git_marker(main_repo)
    (main_repo / "main.py").write_text("print('hello')\n", encoding="utf-8")

    context, file_count, ref_count = build_context(main_repo, ["main.py"], [])

    assert file_count == 1
    assert ref_count == 0
    assert "<reference_repositories>\n\n</reference_repositories>" in context or "<reference_repository" not in context
