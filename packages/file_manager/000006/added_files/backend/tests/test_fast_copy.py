"""
高速ファイルコピー機能のテスト

プラットフォーム固有のI/O最適化を使用した高速コピー関数をテストする。
- macOS: clonefile (APFS Copy-on-Write)
- Windows: CopyFileEx API
- Linux: sendfile システムコール
"""
import pytest
import os
import hashlib
from pathlib import Path
from app.services.transfer import fast_copy_file


def calculate_checksum(file_path: Path) -> str:
    """ファイルのSHA256チェックサムを計算"""
    sha256_hash = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            sha256_hash.update(chunk)
    return sha256_hash.hexdigest()


class TestFastCopyFile:
    """fast_copy_file関数のテストクラス"""

    def test_copy_small_file(self, tmp_path):
        """小さなファイル（< 1MB）のコピーをテスト"""
        # Arrange: 100KBのテストファイルを作成
        src = tmp_path / "small_source.txt"
        dest = tmp_path / "small_dest.txt"
        test_data = b"test data " * 10240  # 約100KB
        src.write_bytes(test_data)

        # Act: 高速コピーを実行
        result = fast_copy_file(src, dest)

        # Assert: コピーが成功し、内容が一致することを確認
        assert result is True
        assert dest.exists()
        assert dest.stat().st_size == src.stat().st_size
        assert calculate_checksum(src) == calculate_checksum(dest)

    def test_copy_large_file(self, tmp_path):
        """大きなファイル（> 10MB）のコピーをテスト"""
        # Arrange: 10MBのテストファイルを作成
        src = tmp_path / "large_source.bin"
        dest = tmp_path / "large_dest.bin"
        test_data = os.urandom(10 * 1024 * 1024)  # 10MB
        src.write_bytes(test_data)

        # Act: 高速コピーを実行
        result = fast_copy_file(src, dest)

        # Assert: コピーが成功し、内容が一致することを確認
        assert result is True
        assert dest.exists()
        assert dest.stat().st_size == src.stat().st_size
        assert calculate_checksum(src) == calculate_checksum(dest)

    def test_copy_preserves_timestamps(self, tmp_path):
        """タイムスタンプが保持されることをテスト"""
        # Arrange
        src = tmp_path / "source_with_timestamp.txt"
        dest = tmp_path / "dest_with_timestamp.txt"
        src.write_text("test content")

        # 元ファイルのタイムスタンプを取得
        original_mtime = src.stat().st_mtime

        # Act
        result = fast_copy_file(src, dest)

        # Assert: タイムスタンプが保持されている（許容誤差1秒）
        assert result is True
        assert abs(dest.stat().st_mtime - original_mtime) < 1.0

    def test_copy_nonexistent_source(self, tmp_path):
        """存在しないソースファイルのコピーでエラーハンドリングをテスト"""
        # Arrange
        src = tmp_path / "nonexistent.txt"
        dest = tmp_path / "dest.txt"

        # Act & Assert: FileNotFoundErrorまたはFalseが返される
        with pytest.raises(FileNotFoundError):
            fast_copy_file(src, dest)

    def test_copy_to_existing_destination_overwrites(self, tmp_path):
        """既存のコピー先ファイルを上書きすることをテスト"""
        # Arrange
        src = tmp_path / "new_source.txt"
        dest = tmp_path / "existing_dest.txt"
        src.write_text("new content")
        dest.write_text("old content")

        # Act
        result = fast_copy_file(src, dest)

        # Assert: 上書きされて新しい内容になっている
        assert result is True
        assert dest.read_text() == "new content"

    def test_copy_empty_file(self, tmp_path):
        """空ファイルのコピーをテスト"""
        # Arrange
        src = tmp_path / "empty_source.txt"
        dest = tmp_path / "empty_dest.txt"
        src.touch()

        # Act
        result = fast_copy_file(src, dest)

        # Assert
        assert result is True
        assert dest.exists()
        assert dest.stat().st_size == 0

    def test_copy_binary_file(self, tmp_path):
        """バイナリファイルのコピーをテスト"""
        # Arrange
        src = tmp_path / "binary_source.bin"
        dest = tmp_path / "binary_dest.bin"
        binary_data = bytes(range(256)) * 100  # バイナリデータ
        src.write_bytes(binary_data)

        # Act
        result = fast_copy_file(src, dest)

        # Assert
        assert result is True
        assert dest.read_bytes() == binary_data

    def test_copy_unicode_filename(self, tmp_path):
        """Unicode文字を含むファイル名のコピーをテスト"""
        # Arrange
        src = tmp_path / "日本語ファイル名.txt"
        dest = tmp_path / "コピー先_日本語.txt"
        src.write_text("テスト内容", encoding="utf-8")

        # Act
        result = fast_copy_file(src, dest)

        # Assert
        assert result is True
        assert dest.read_text(encoding="utf-8") == "テスト内容"
