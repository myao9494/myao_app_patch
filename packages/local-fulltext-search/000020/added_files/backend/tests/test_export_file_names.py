"""
AIインプットの保存・ダウンロードのファイル名のテスト。

仕様:
- ダウンロードは日本語の題名でも失敗しない（HTTP ヘッダーは ASCII なので RFC 5987 の filename* で渡す）。
- 保存のファイル名に区切り文字があっても、保存先フォルダの外へ書かない。
"""

from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


@pytest.fixture
def note(tmp_path: Path) -> Path:
    path = tmp_path / "note.md"
    path.write_text("# 見出し\n本文\n", encoding="utf-8")
    return path


def test_download_accepts_a_japanese_title(client: TestClient, note: Path) -> None:
    response = client.post("/api/export/ai-html/download", json={"file_paths": [note.as_posix()], "title": "検証ドキュメント"})

    assert response.status_code == 200
    disposition = response.headers["content-disposition"]
    assert f"filename*=UTF-8''{quote('検証ドキュメント.html')}" in disposition
    assert disposition.isascii()


def test_download_keeps_an_ascii_title(client: TestClient, note: Path) -> None:
    response = client.post("/api/export/ai-html/download", json={"file_paths": [note.as_posix()], "title": "plain"})

    assert response.status_code == 200
    assert 'filename="plain.html"' in response.headers["content-disposition"]


@pytest.mark.parametrize(
    "file_name", ["..\\外.html", "../外.html", "a\\b.html", "a/b.html", "C:\\外.html", "制御\x08文字.html"]
)
def test_saved_html_stays_in_the_target_folder(client: TestClient, tmp_path: Path, file_name: str) -> None:
    target = (tmp_path / "out").resolve()

    response = client.post(
        "/api/export/ai-html/save", json={"html_content": "<p>x</p>", "file_name": file_name, "target_dir": target.as_posix()}
    )

    assert response.status_code == 200
    assert Path(response.json()["saved_path"]).parent == target


@pytest.mark.parametrize("file_name", ["..\\外.html", "../外.html", "a\\b.html"])
def test_saved_html_parts_stay_in_the_target_folder(client: TestClient, tmp_path: Path, file_name: str) -> None:
    target = (tmp_path / "out").resolve()

    response = client.post(
        "/api/export/ai-html/save-parts",
        json={"html_parts": ["<p>1</p>", "<p>2</p>"], "file_name": file_name, "target_dir": target.as_posix()},
    )

    assert response.status_code == 200
    assert {Path(path).parent for path in response.json()["saved_paths"]} == {target}
