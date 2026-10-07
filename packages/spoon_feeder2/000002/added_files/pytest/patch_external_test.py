"""外部ライブラリ（PYTHONPATH・sys.path対象）に対するコード反映テスト。

仕様:
1. prepare_preview および apply_preview がメインリポジトリだけでなく、許可された外部ライブラリ（extra_roots）配下のファイルも受け付ける。
2. safe_target で外部ライブラリ配下のファイルパスが正しく解決・検証される。
3. AI出力が外部ライブラリの関数・クラス変更、または <file path="common_lib/..."> である場合に反映先を特定できる。
4. API /api/patch/preview および /api/patch/apply で外部ライブラリへのパッチが正常に適用・ロールバックできる。
"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from backend.main import app
from backend.patcher import apply_preview, prepare_preview, safe_target


def _git_marker(root: Path) -> None:
    (root / ".git").mkdir(parents=True, exist_ok=True)


def test_外部ライブラリのsafe_targetが正常に解決される(tmp_path: Path) -> None:
    main_repo = tmp_path / "main_repo"
    common_repo = tmp_path / "common_lib"
    main_repo.mkdir(); common_repo.mkdir()

    # extra_roots に common_repo を含めた場合、common_lib 以下のパスが安全と判定される
    target = safe_target(main_repo, "sub/helper.py", extra_roots=[common_repo])
    assert target == (main_repo / "sub/helper.py").resolve()

    # 外部リポジトリ名付き、または外部リポジトリ相対パス
    target_external = safe_target(main_repo, f"{common_repo.name}/utils.py", extra_roots=[common_repo])
    assert target_external == (common_repo / "utils.py").resolve()

    target_direct = safe_target(main_repo, str(common_repo / "utils.py"), extra_roots=[common_repo])
    assert target_direct == (common_repo / "utils.py").resolve()


def test_外部ライブラリのファイルに対するパッチプレビューと適用(tmp_path: Path) -> None:
    main_repo = tmp_path / "main_repo"
    common_repo = tmp_path / "common_lib"
    main_repo.mkdir(); common_repo.mkdir()
    _git_marker(main_repo); _git_marker(common_repo)

    common_file = common_repo / "math_utils.py"
    common_file.write_text(
        "def add(a, b):\n    return a + b\n",
        encoding="utf-8",
    )

    ai_output = (
        f'<file path="{common_repo.name}/math_utils.py" action="modify">\n'
        "def add(a, b):\n    return a + b + 1\n"
        "</file>"
    )

    preview = prepare_preview(main_repo, ai_output, extra_roots=[common_repo])
    assert preview["status"] == "success"
    assert len(preview["changes"]) == 1
    assert "return a + b + 1" in preview["changes"][0]["diff"]

    result = apply_preview(main_repo, preview, extra_roots=[common_repo])
    assert result["status"] == "success"
    assert "return a + b + 1" in common_file.read_text(encoding="utf-8")


def test_API経由でPYTHONPATHの外部ライブラリへパッチが適用される(tmp_path: Path, monkeypatch) -> None:
    main_repo = tmp_path / "main_repo"
    common_repo = tmp_path / "common_lib"
    main_repo.mkdir(); common_repo.mkdir()
    _git_marker(main_repo); _git_marker(common_repo)

    target_file = common_repo / "service.py"
    target_file.write_text("def run():\n    return False\n", encoding="utf-8")

    monkeypatch.setenv("PYTHONPATH", str(common_repo))

    client = TestClient(app)
    ai_output = (
        f'```python path: {common_repo.name}/service.py\n'
        "def run():\n    return True\n"
        "```"
    )

    preview_resp = client.post(
        "/api/patch/preview",
        json={"library_path": str(main_repo), "ai_output": ai_output},
    )
    assert preview_resp.status_code == 200
    preview_data = preview_resp.json()
    assert preview_data["status"] == "success"

    apply_resp = client.post(
        "/api/patch/apply",
        json={"library_path": str(main_repo), "ai_output": ai_output},
    )
    assert apply_resp.status_code == 200
    assert "return True" in target_file.read_text(encoding="utf-8")
