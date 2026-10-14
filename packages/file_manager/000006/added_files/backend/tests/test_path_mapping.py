"""
 * URL・パスマッピングによるリンク切れ防止機能のテスト
 * - settings.json から pathMappings を正しくロード・セーブできること
 * - convert_storage_path がファイルパス・URL・UNCパス・大文字小文字・区切り文字を適切に処理し、カンマ区切り設定を展開して変換できること
 * - open_smart に古いリンクが渡された際、新しい有効なリンクに変換されて開かれること
"""
import pytest
from unittest.mock import patch, MagicMock
from app.config import settings, save_editor_preferences
from app.services.paths import convert_storage_path

class TestPathMapping:
    """URL・パスマッピング機能のテスト"""

    @pytest.fixture(autouse=True)
    def setup_mocks(self, temp_dir, monkeypatch):
        """テスト用の設定ファイルをモック化"""
        self.preferences_path = temp_dir / "settings.json"
        monkeypatch.setattr(settings, "_base_dir_override", temp_dir)
        monkeypatch.setattr(settings, "_preferences_file_override", self.preferences_path)

    def test_config_api_supports_path_mappings(self, client):
        """設定APIがpathMappingsの取得と更新をサポートしていることを確認"""
        # 初期状態では空
        response = client.get("/api/config")
        assert response.status_code == 200
        data = response.json()
        assert "pathMappings" in data
        assert data["pathMappings"] == {}

        # 更新
        mappings = {
            "\\\\new-server\\share": "\\\\old-1\\share,\\\\old-2\\share",
            "http://new-wiki/": "http://old-wiki-1/,http://old-wiki-2/"
        }
        
        response = client.post(
            "/api/config/preferences",
            json={
                "textFileOpenMode": "web",
                "markdownOpenMode": "web",
                "apiTimeout": 10,
                "pathMappings": mappings
            }
        )
        assert response.status_code == 200
        assert response.json()["pathMappings"] == mappings

        # ファイルに書き込まれていることの確認
        assert self.preferences_path.exists()
        import json
        saved_data = json.loads(self.preferences_path.read_text(encoding="utf-8"))
        assert saved_data["pathMappings"] == mappings

    def test_convert_storage_path_with_file_paths(self):
        """ファイルパスやUNCパスの置換が正常に機能することを確認"""
        # テスト用のマッピングを設定
        mappings = {
            "\\\\new-server\\share": "\\\\old-1\\share,\\\\old-2\\share",
            "C:\\new-local": "D:\\old-local-1,D:\\old-local-2"
        }
        save_editor_preferences("web", "web", 10, path_mappings=mappings)

        # 1. UNCパスの置換 (旧1)
        res = convert_storage_path(r"\\old-1\share\subfolder\file.txt")
        assert res == r"\\new-server\share\subfolder\file.txt"

        # 2. UNCパスの置換 (旧2)
        res = convert_storage_path(r"\\old-2\share\another.txt")
        assert res == r"\\new-server\share\another.txt"

        # 3. ローカルパスの置換 (大文字小文字無視の確認)
        res = convert_storage_path(r"d:\OLD-LOCAL-1\some\path.xlsx")
        assert res.lower() == r"c:\new-local\some\path.xlsx".lower()

        # 4. スラッシュ・バックスラッシュの混在と正規化
        res = convert_storage_path("D:/old-local-2/mixed/path.txt")
        # 区切り文字が入力に合わせられる、または正しく結合されることを確認
        assert "new-local" in res
        assert "mixed" in res

        # 5. マッチしないパスはそのまま
        res = convert_storage_path(r"C:\unmatched\path.txt")
        assert res == r"C:\unmatched\path.txt"

    def test_convert_storage_path_with_urls(self):
        """Web URLやカスタムURIの置換が正常に機能することを確認"""
        mappings = {
            "http://new-wiki.internal/": "http://old-wiki-1.internal/,http://old-wiki-2.internal/",
            "obsidian://open?vault=new-vault": "obsidian://open?vault=old-vault-1,obsidian://open?vault=old-vault-2"
        }
        save_editor_preferences("web", "web", 10, path_mappings=mappings)

        # 1. HTTP URL の置換
        res = convert_storage_path("http://old-wiki-1.internal/pages/home")
        assert res == "http://new-wiki.internal/pages/home"

        # 2. カスタムURI の置換
        res = convert_storage_path("obsidian://open?vault=old-vault-2&file=notes/todo")
        assert res == "obsidian://open?vault=new-vault&file=notes/todo"

    @patch("webbrowser.open")
    def test_open_smart_with_mapped_url_bypasses_normalize(self, mock_webbrowser_open, client):
        """open_smart がURLマッピング時に normalize_path をバイパスして直接開くことを確認"""
        # URLマッピングを設定
        mappings = {
            "http://new-server.internal/": "http://old-server.internal/"
        }
        save_editor_preferences("web", "web", 10, path_mappings=mappings)

        # テスト用の古いURLを投げる
        response = client.post(
            "/api/open/smart",
            json={"path": "http://old-server.internal/test-document"}
        )
        
        assert response.status_code == 200
        assert response.json()["status"] == "success"
        assert response.json()["action"] == "opened"
        
        # モックされたブラウザオープンが新しいURLで呼ばれたことを確認
        mock_webbrowser_open.assert_called_once_with("http://new-server.internal/test-document")

    @patch("urllib.request.urlopen")
    def test_connection_verification_api(self, mock_urlopen, client, temp_dir):
        """接続性検証APIがURLとローカルパスの接続性を確認し結果を返すことを確認"""
        # Mock urllib.request.urlopen for URL tests
        mock_response = MagicMock()
        mock_response.status = 200
        mock_urlopen.return_value.__enter__.return_value = mock_response

        # ローカルにテスト用の実フォルダと、存在しないフォルダを用意
        existing_dir = temp_dir / "existing_test_dir"
        existing_dir.mkdir()
        non_existing_dir = temp_dir / "non_existing_test_dir"

        # 検証対象のリスト
        targets = [
            str(existing_dir),
            str(non_existing_dir),
            "http://alive-server.com",
            "invalid_scheme://test"
        ]

        response = client.post(
            "/api/config/test-connections",
            json={"paths": targets}
        )

        assert response.status_code == 200
        data = response.json()

        # 実フォルダは alive
        assert data[str(existing_dir)]["alive"] is True
        # 存在しないフォルダは dead
        assert data[str(non_existing_dir)]["alive"] is False
        # URL (mocked) は alive
        assert data["http://alive-server.com"]["alive"] is True
        # 不正なスキーム/その他は dead
        assert data["invalid_scheme://test"]["alive"] is False
