"""参照リポジトリの自動解決とコンテキスト統合テスト。"""

from __future__ import annotations

from pathlib import Path

from backend.references import discover_reference_modules
from backend.repository import build_context


def _git_marker(root: Path) -> None:
    (root / ".git").mkdir(parents=True)


def test_python環境から使用中モジュールだけを再帰検出する(tmp_path: Path, monkeypatch) -> None:
    main = tmp_path / "main_repo"
    reference = tmp_path / "shared_repo"
    (main / "src").mkdir(parents=True)
    (reference / "src" / "shared").mkdir(parents=True)
    _git_marker(main); _git_marker(reference)
    (main / "src" / "app.py").write_text(
        "import shared.math as math\nimport unused.package as unused\nprint(math.add(2))\n",
        encoding="utf-8",
    )
    (reference / "src" / "shared" / "__init__.py").write_text("", encoding="utf-8")
    (reference / "src" / "shared" / "math.py").write_text(
        "from .helper import double\ndef add(value):\n    return double(value)\n",
        encoding="utf-8",
    )
    (reference / "src" / "shared" / "helper.py").write_text(
        "def double(value):\n    return value * 2\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("PYTHONPATH", str(reference / "src"))

    result = discover_reference_modules(main, ["src/app.py"])

    assert result["enabled"] is True
    assert len(result["repositories"]) == 1
    assert set(result["repositories"][0]["files"]) == {
        "src/shared/math.py", "src/shared/helper.py",
    }
    assert all(item["module"] != "unused.package" for item in result["unresolved"])


def test_embedded_pythonでは参照解析を無効化する(tmp_path: Path) -> None:
    result = discover_reference_modules(tmp_path, [], python_mode="embedded")
    assert result == {"enabled": False, "repositories": [], "unresolved": [], "warnings": []}


def test_csharpのProjectReferenceから使用型のファイルだけを検出する(tmp_path: Path) -> None:
    main = tmp_path / "main_repo"
    reference = tmp_path / "shared_repo"
    main.mkdir(); reference.mkdir()
    _git_marker(main); _git_marker(reference)
    (main / "Main.csproj").write_text(
        '<Project><ItemGroup><ProjectReference Include="../shared_repo/Shared.csproj" /></ItemGroup></Project>',
        encoding="utf-8",
    )
    (main / "Program.cs").write_text(
        "using Company.Shared;\nnamespace App;\npublic class Program { Widget value = new Widget(); }\n",
        encoding="utf-8",
    )
    (reference / "Shared.csproj").write_text("<Project />", encoding="utf-8")
    (reference / "Widget.cs").write_text(
        "namespace Company.Shared;\npublic class Widget { }\n",
        encoding="utf-8",
    )
    (reference / "Unused.cs").write_text(
        "namespace Company.Shared;\npublic class Unused { }\n",
        encoding="utf-8",
    )

    result = discover_reference_modules(main, ["Program.cs"])

    assert len(result["repositories"]) == 1
    assert result["repositories"][0]["files"] == ["Widget.cs"]


def test_csharpの同一プロジェクト内依存と循環参照を有限に追跡する(tmp_path: Path) -> None:
    main = tmp_path / "main_repo"
    shared = tmp_path / "shared_repo"
    deep = tmp_path / "deep_repo"
    main.mkdir(); shared.mkdir(); deep.mkdir()
    _git_marker(main); _git_marker(shared); _git_marker(deep)
    (main / "Main.csproj").write_text(
        '<Project><ItemGroup><ProjectReference Include="../shared_repo/Shared.csproj" /></ItemGroup></Project>',
        encoding="utf-8",
    )
    (main / "Program.cs").write_text(
        "using Company.Shared;\npublic class Program { Widget value = new Widget(); }\n",
        encoding="utf-8",
    )
    (shared / "Shared.csproj").write_text(
        '<Project><ItemGroup><ProjectReference Include="../deep_repo/Deep.csproj" /></ItemGroup></Project>',
        encoding="utf-8",
    )
    (shared / "Widget.cs").write_text(
        "namespace Company.Shared;\npublic class Widget { Helper value = new Helper(); }\n",
        encoding="utf-8",
    )
    (shared / "Helper.cs").write_text(
        "using Company.Deep;\nnamespace Company.Shared;\npublic class Helper { Transitive value = new Transitive(); }\n",
        encoding="utf-8",
    )
    (deep / "Deep.csproj").write_text(
        '<Project><ItemGroup><ProjectReference Include="../shared_repo/Shared.csproj" /></ItemGroup></Project>',
        encoding="utf-8",
    )
    (deep / "Transitive.cs").write_text(
        "namespace Company.Deep;\npublic class Transitive { }\n",
        encoding="utf-8",
    )

    result = discover_reference_modules(main, ["Program.cs"])
    by_name = {repository["name"]: set(repository["files"]) for repository in result["repositories"]}

    assert by_name["shared_repo"] == {"Widget.cs", "Helper.cs"}
    assert by_name["deep_repo"] == {"Transitive.cs"}


def test_同じ未解決Pythonモジュールの呼出元をすべて保持する(tmp_path: Path) -> None:
    main = tmp_path / "main_repo"
    main.mkdir()
    _git_marker(main)
    for name in ("one.py", "two.py"):
        (main / name).write_text("import missing_company_lib\nprint(missing_company_lib.value)\n", encoding="utf-8")

    result = discover_reference_modules(main, ["one.py", "two.py"])
    missing = next(item for item in result["unresolved"] if item["module"] == "missing_company_lib")

    assert missing["source_files"] == ["one.py", "two.py"]


def test_参照リポジトリを読み取り専用としてコンテキストへ分離する(tmp_path: Path) -> None:
    main = tmp_path / "main_repo"
    reference = tmp_path / "shared_repo"
    main.mkdir(); reference.mkdir()
    (main / "main.py").write_text("from shared import value\n", encoding="utf-8")
    (reference / "shared.py").write_text("value = 1\n", encoding="utf-8")
    (reference / "README.md").write_text("含めない\n", encoding="utf-8")

    context, main_count, reference_count = build_context(
        main,
        ["main.py"],
        [{"repository_path": str(reference), "files": ["shared.py", "README.md"]}],
    )

    assert main_count == 1 and reference_count == 1
    assert '<reference_repository name="shared_repo" read_only="true">' in context
    assert "変更案と変更先は main_repository 内だけ" in context
    assert "README.md" not in context


def test_会社チャット向けのコード出力契約をコンテキストへ含める(tmp_path: Path) -> None:
    (tmp_path / "main.py").write_text("def run():\n    return True\n", encoding="utf-8")

    context, _, _ = build_context(tmp_path, ["main.py"])

    assert all(rule in context for rule in (
        "関数変更は形式1を最優先",
        '<change_manifest format="yaml">',
        "- path: src/example.py",
        "pytest.mark.skipif",
        "1テスト1確認",
        "reference_repositoriesは読み取り専用",
        "<response_reminder>",
    ))


def test_envフォルダのPythonも仮想環境として検出する(tmp_path):
    import os
    from backend.references import _python_executable

    executable_dir = "Scripts" if os.name == "nt" else "bin"
    executable_name = "python.exe" if os.name == "nt" else "python"
    target = tmp_path / "env" / executable_dir / executable_name
    target.parent.mkdir(parents=True)
    target.write_text("", encoding="utf-8")
    assert _python_executable(tmp_path) == target
