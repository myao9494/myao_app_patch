"""同一リポジトリ内の呼び出されているモジュール自動解決テスト。

仕様:
1. 現在選択されているファイル群（selected_files）から、同一リポジトリ内でインポートされているモジュールを再帰的（推移的）に探索する。
2. 相対インポート（from .xxx import yyy、from ..zzz import aaa）および絶対インポート（import lib.util など）に対応する。
3. 循環参照（A -> B -> A）が存在しても無限ループにならずにすべての関連モジュールを収集する。
4. APIエンドポイント POST /api/auto_select_modules で現在選択中のファイルに加えて解決された全ファイル一覧を返す。
"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from backend.main import app
from backend.references import discover_internal_modules


def _git_marker(root: Path) -> None:
    (root / ".git").mkdir(parents=True, exist_ok=True)


def test_同一リポジトリ内の呼び出されているモジュールを再帰的に検出する(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    (root / "src" / "pkg").mkdir(parents=True)
    _git_marker(root)

    # main.py -> src/pkg/service.py -> src/pkg/helper.py
    (root / "main.py").write_text(
        "from src.pkg.service import run_service\nrun_service()\n",
        encoding="utf-8",
    )
    (root / "src" / "pkg" / "__init__.py").write_text("", encoding="utf-8")
    (root / "src" / "pkg" / "service.py").write_text(
        "from .helper import calculate\ndef run_service():\n    return calculate(10)\n",
        encoding="utf-8",
    )
    (root / "src" / "pkg" / "helper.py").write_text(
        "def calculate(x):\n    return x * 2\n",
        encoding="utf-8",
    )
    (root / "src" / "pkg" / "unrelated.py").write_text(
        "def ignored():\n    pass\n",
        encoding="utf-8",
    )

    result = discover_internal_modules(root, ["main.py"])

    # 選択された main.py から呼ばれている service.py, helper.py が検出され、unrelated.py は含まれない
    assert "src/pkg/service.py" in result
    assert "src/pkg/helper.py" in result
    assert "src/pkg/unrelated.py" not in result


def test_同一リポジトリ内の循環参照があっても無限ループにならず完了する(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    root.mkdir(parents=True)
    _git_marker(root)

    # a.py -> b.py -> a.py
    (root / "a.py").write_text(
        "import b\ndef fn_a():\n    return b.fn_b()\n",
        encoding="utf-8",
    )
    (root / "b.py").write_text(
        "import a\ndef fn_b():\n    return 42\n",
        encoding="utf-8",
    )

    result = discover_internal_modules(root, ["a.py"])

    assert "b.py" in result


def test_auto_select_modules_APIで合算されたファイル一覧が返る(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    root.mkdir(parents=True)
    _git_marker(root)

    (root / "entry.py").write_text("import util\nutil.do_work()\n", encoding="utf-8")
    (root / "util.py").write_text("def do_work(): pass\n", encoding="utf-8")

    client = TestClient(app)
    response = client.post(
        "/api/auto_select_modules",
        json={"library_path": str(root), "selected_files": ["entry.py"]},
    )

    assert response.status_code == 200
    data = response.json()
    assert set(data["selected_files"]) == {"entry.py", "util.py"}
    assert data["added_files"] == ["util.py"]
