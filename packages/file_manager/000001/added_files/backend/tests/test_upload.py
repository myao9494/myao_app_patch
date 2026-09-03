"""
ファイル・フォルダアップロードAPIのテスト
TDD: まずテストを作成し、失敗を確認してから実装を進める
"""
import io
import pytest
from pathlib import Path


class TestUploadFiles:
    """POST /api/upload エンドポイントのテスト"""

    def test_upload_single_file(self, client, temp_dir):
        """通常の単一ファイルアップロードができる"""
        target_path = str(temp_dir)
        file_content = b"hello world"
        files = [
            ("files", ("test_upload.txt", io.BytesIO(file_content), "text/plain"))
        ]

        response = client.post(
            "/api/upload",
            params={"path": target_path},
            files=files,
        )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "success"
        uploaded_file = temp_dir / "test_upload.txt"
        assert uploaded_file.exists()
        assert uploaded_file.read_bytes() == file_content

    def test_upload_files_with_relative_paths(self, client, temp_dir):
        """相対パス（階層構造）付きでファイルをアップロードすると、サブディレクトリが自動作成される"""
        target_path = str(temp_dir)
        file1_content = b"content in subfolder"
        file2_content = b"content in deep subfolder"

        files = [
            ("files", ("sub.txt", io.BytesIO(file1_content), "text/plain")),
            ("files", ("deep.txt", io.BytesIO(file2_content), "text/plain")),
        ]
        data = {
            "relative_paths": ["my_folder/sub.txt", "my_folder/deep/level/deep.txt"],
        }

        response = client.post(
            "/api/upload",
            params={"path": target_path},
            files=files,
            data=data,
        )

        assert response.status_code == 200
        resp_data = response.json()
        assert resp_data["status"] == "success"

        file1 = temp_dir / "my_folder" / "sub.txt"
        file2 = temp_dir / "my_folder" / "deep" / "level" / "deep.txt"
        assert file1.exists()
        assert file1.read_bytes() == file1_content
        assert file2.exists()
        assert file2.read_bytes() == file2_content

    def test_upload_empty_directories(self, client, temp_dir):
        """空ディレクトリ情報（empty_directories）を送信すると空ディレクトリが作成される"""
        target_path = str(temp_dir)
        data = {
            "empty_directories": ["empty_folder", "parent_folder/nested_empty"],
        }

        response = client.post(
            "/api/upload",
            params={"path": target_path},
            data=data,
        )

        assert response.status_code == 200
        resp_data = response.json()
        assert resp_data["status"] == "success"

        dir1 = temp_dir / "empty_folder"
        dir2 = temp_dir / "parent_folder" / "nested_empty"
        assert dir1.exists()
        assert dir1.is_dir()
        assert dir2.exists()
        assert dir2.is_dir()

    def test_upload_path_traversal_protection(self, client, temp_dir):
        """パストラバーサル（..を含む不正な相対パス）を含む場合はエラーになるか安全に拒否される"""
        target_path = str(temp_dir)
        files = [
            ("files", ("hacked.txt", io.BytesIO(b"evil"), "text/plain")),
        ]
        data = {
            "relative_paths": ["../../../evil.txt"],
        }

        response = client.post(
            "/api/upload",
            params={"path": target_path},
            files=files,
            data=data,
        )

        # 400エラーまたはエラーレスポンスで親ディレクトリ外への書き込みが防止される
        assert response.status_code in [400, 200]
        if response.status_code == 200:
            assert response.json()["status"] in ["error", "partial_success"]
        # 親の外側に evil.txt が作成されていないこと
        evil_path = temp_dir.parent / "evil.txt"
        assert not evil_path.exists()
