"""依存関係マップ(analysis)の統合テスト。"""

from __future__ import annotations

from pathlib import Path

from backend.analysis import build_dependency_map


def _edges(result: dict, kind: str) -> set[tuple[str, str]]:
    return {(e["source"], e["target"]) for e in result["edges"] if e["type"] == kind}


def test_Pythonのimportとファイル内の関数呼び出しを辺として出力する(tmp_path: Path):
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "__init__.py").write_text("", encoding="utf-8")
    (tmp_path / "pkg" / "util.py").write_text("def helper():\n    return 1\n", encoding="utf-8")
    (tmp_path / "app.py").write_text("from pkg.util import helper\n\ndef run():\n    return helper()\n", encoding="utf-8")
    result = build_dependency_map(tmp_path)
    assert ("app.py", "pkg/util.py") in _edges(result, "import")
    assert ("app.py:run", "pkg/util.py:helper") in _edges(result, "calls")


def test_クラスのメソッドはクラスノードの子として含まれる(tmp_path: Path):
    (tmp_path / "svc.py").write_text("class Service:\n    def go(self):\n        return 1\n", encoding="utf-8")
    result = build_dependency_map(tmp_path)
    assert ("svc.py:Service", "svc.py:Service:go") in _edges(result, "contains")


def test_CSharpのusingと一意なメソッド呼び出しを辺として出力する(tmp_path: Path):
    (tmp_path / "A.cs").write_text("namespace Demo.A;\npublic class Svc { public static int Helper(int y) => y; }\n", encoding="utf-8")
    (tmp_path / "B.cs").write_text("using Demo.A;\nnamespace Demo.B;\npublic class Caller { public void Go() { Helper(2); } }\n", encoding="utf-8")
    result = build_dependency_map(tmp_path)
    assert ("B.cs", "A.cs") in _edges(result, "import")
    assert ("B.cs:Caller:Go", "A.cs:Svc:Helper") in _edges(result, "calls")


def test_構文エラーのPythonファイルがあってもマップを生成する(tmp_path: Path):
    (tmp_path / "broken.py").write_text("def (:\n", encoding="utf-8")
    (tmp_path / "ok.py").write_text("def fine():\n    pass\n", encoding="utf-8")
    ids = {node["id"] for node in build_dependency_map(tmp_path)["nodes"]}
    assert {"broken.py", "ok.py", "ok.py:fine"} <= ids
