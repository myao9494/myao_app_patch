"""
フォルダ内画像一覧取得API (/api/folder-images) のテスト
- 正常系: depth=0 で直下のみの画像一覧を取得できること
- 正常系: depth=1 で1階層下のサブフォルダ内の画像も含めて取得できること
- 正常系: depth=2 で2階層下のサブフォルダ内の画像も含めて取得できること
- 正常系: 非画像ファイルおよび除外フォルダ (.git, node_modules等) が除外されること
- 正常系: 相対パス (relativePath) が正しく付与されていること
- 異常系: 存在しないパス (404)
- 異常系: ファイルパスの指定 (400)
"""
import urllib.parse
from pathlib import Path
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_folder_images_depth_0(tmp_path: Path):
    """depth=0 で直下の画像のみが取得され、サブフォルダの画像は含まれないこと"""
    # 直下の画像
    (tmp_path / "img1.png").write_bytes(b"dummy png 1")
    (tmp_path / "img2.jpg").write_bytes(b"dummy jpg 2")
    (tmp_path / "text.txt").write_text("dummy text")

    # サブフォルダとその中の画像
    sub_dir = tmp_path / "sub1"
    sub_dir.mkdir()
    (sub_dir / "sub_img.png").write_bytes(b"sub dummy png")

    encoded_path = urllib.parse.quote(str(tmp_path))
    response = client.get(f"/api/folder-images?path={encoded_path}&depth=0")

    assert response.status_code == 200
    data = response.json()
    assert data["path"] == str(tmp_path)
    assert data["depth"] == 0
    assert data["total"] == 2
    names = [img["name"] for img in data["images"]]
    assert "img1.png" in names
    assert "img2.jpg" in names
    assert "sub_img.png" not in names
    assert "text.txt" not in names
    # relativePath の検証
    for img in data["images"]:
        assert img["relativePath"] == img["name"]


def test_folder_images_depth_1(tmp_path: Path):
    """depth=1 で直下＋1階層下の画像が含まれ、2階層下の画像は含まれないこと"""
    # 直下
    (tmp_path / "root.png").write_bytes(b"root")

    # 1階層下
    sub1 = tmp_path / "sub1"
    sub1.mkdir()
    (sub1 / "level1.png").write_bytes(b"level1")

    # 2階層下
    sub2 = sub1 / "sub2"
    sub2.mkdir()
    (sub2 / "level2.png").write_bytes(b"level2")

    encoded_path = urllib.parse.quote(str(tmp_path))
    response = client.get(f"/api/folder-images?path={encoded_path}&depth=1")

    assert response.status_code == 200
    data = response.json()
    assert data["depth"] == 1
    assert data["total"] == 2
    names = [img["name"] for img in data["images"]]
    assert "root.png" in names
    assert "level1.png" in names
    assert "level2.png" not in names

    # relativePath の検証
    rel_paths = [img["relativePath"] for img in data["images"]]
    assert "root.png" in rel_paths
    assert str(Path("sub1") / "level1.png") in rel_paths


def test_folder_images_depth_2(tmp_path: Path):
    """depth=2 で2階層下までの画像がすべて含まれること"""
    (tmp_path / "root.png").write_bytes(b"root")
    sub1 = tmp_path / "sub1"
    sub1.mkdir()
    (sub1 / "level1.png").write_bytes(b"level1")
    sub2 = sub1 / "sub2"
    sub2.mkdir()
    (sub2 / "level2.png").write_bytes(b"level2")

    # 3階層下
    sub3 = sub2 / "sub3"
    sub3.mkdir()
    (sub3 / "level3.png").write_bytes(b"level3")

    encoded_path = urllib.parse.quote(str(tmp_path))
    response = client.get(f"/api/folder-images?path={encoded_path}&depth=2")

    assert response.status_code == 200
    data = response.json()
    assert data["depth"] == 2
    assert data["total"] == 3
    names = [img["name"] for img in data["images"]]
    assert "root.png" in names
    assert "level1.png" in names
    assert "level2.png" in names
    assert "level3.png" not in names


def test_folder_images_filters_ignored_dirs(tmp_path: Path):
    """除外フォルダ (.git, node_modules等) 内の画像は取得されないこと"""
    git_dir = tmp_path / ".git"
    git_dir.mkdir()
    (git_dir / "git_img.png").write_bytes(b"git")

    node_dir = tmp_path / "node_modules"
    node_dir.mkdir()
    (node_dir / "pkg_img.png").write_bytes(b"pkg")

    (tmp_path / "valid.png").write_bytes(b"valid")

    encoded_path = urllib.parse.quote(str(tmp_path))
    response = client.get(f"/api/folder-images?path={encoded_path}&depth=3")

    assert response.status_code == 200
    data = response.json()
    assert data["total"] == 1
    assert data["images"][0]["name"] == "valid.png"


def test_folder_images_not_found():
    """存在しないパスが指定された場合は 404 を返すこと"""
    response = client.get("/api/folder-images?path=/non/existent/path/for/sure")
    assert response.status_code == 404


def test_folder_images_file_target_rejected(tmp_path: Path):
    """ファイルパスが指定された場合は 400 を返すこと"""
    test_file = tmp_path / "sample.png"
    test_file.write_bytes(b"data")

    encoded_path = urllib.parse.quote(str(test_file))
    response = client.get(f"/api/folder-images?path={encoded_path}")
    assert response.status_code == 400
