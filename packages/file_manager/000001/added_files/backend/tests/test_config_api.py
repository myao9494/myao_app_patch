"""
設定APIのテスト
エディタ設定の取得・保存と設定ファイル反映を確認する
"""
from pathlib import Path


class TestConfigApi:
    """/api/config 系エンドポイントのテスト"""

    def test_get_config_returns_editor_preferences(self, client, temp_dir, monkeypatch):
        """設定ファイルのエディタ設定を取得できる"""
        from app import config

        preferences_path = temp_dir / "settings.json"
        preferences_path.write_text(
            '{\n  "textFileOpenMode": "vscode",\n  "markdownOpenMode": "external",\n  "apiTimeout": 15\n}\n',
            encoding="utf-8",
        )

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        monkeypatch.setattr(config.settings, "_preferences_file_override", preferences_path)

        response = client.get("/api/config")

        assert response.status_code == 200
        data = response.json()
        assert data["textFileOpenMode"] == "vscode"
        assert data["markdownOpenMode"] == "external"
        assert data["apiTimeout"] == 15

    def test_get_config_returns_default_timeout_when_missing(self, client, temp_dir, monkeypatch):
        """設定ファイルにapiTimeoutがない場合、デフォルト値（10秒）が返る"""
        from app import config

        preferences_path = temp_dir / "settings.json"
        preferences_path.write_text(
            '{\n  "textFileOpenMode": "vscode",\n  "markdownOpenMode": "external"\n}\n',
            encoding="utf-8",
        )

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        monkeypatch.setattr(config.settings, "_preferences_file_override", preferences_path)

        response = client.get("/api/config")

        assert response.status_code == 200
        data = response.json()
        assert data["apiTimeout"] == 10

    def test_update_editor_preferences_saves_settings_file(self, client, temp_dir, monkeypatch):
        """エディタ設定更新で設定ファイルへ保存される（apiTimeout含む）"""
        from app import config

        preferences_path = temp_dir / "settings.json"

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        monkeypatch.setattr(config.settings, "_preferences_file_override", preferences_path)

        response = client.post(
            "/api/config/preferences",
            json={
                "textFileOpenMode": "vscode",
                "markdownOpenMode": "external",
                "apiTimeout": 20,
            },
        )

        assert response.status_code == 200
        assert response.json()["textFileOpenMode"] == "vscode"
        assert response.json()["markdownOpenMode"] == "external"
        assert response.json()["apiTimeout"] == 20
        assert preferences_path.exists()
        saved = preferences_path.read_text(encoding="utf-8")
        assert '"textFileOpenMode": "vscode"' in saved
        assert '"markdownOpenMode": "external"' in saved
        assert '"apiTimeout": 20' in saved

    def test_update_editor_preferences_supports_obsidian_or_web(self, client, temp_dir, monkeypatch):
        """Markdownモードとして obsidian_or_web を保存・取得できる"""
        from app import config

        preferences_path = temp_dir / "settings.json"
        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        monkeypatch.setattr(config.settings, "_preferences_file_override", preferences_path)

        response = client.post(
            "/api/config/preferences",
            json={
                "textFileOpenMode": "web",
                "markdownOpenMode": "obsidian_or_web",
            },
        )

        assert response.status_code == 200
        assert response.json()["markdownOpenMode"] == "obsidian_or_web"
        saved = preferences_path.read_text(encoding="utf-8")
        assert '"markdownOpenMode": "obsidian_or_web"' in saved

    def test_folder_latest_modified_entry_limit_is_saved_and_returned(self, client, temp_dir, monkeypatch):
        """フォルダ最新日時の走査上限を設定として保存・取得できる"""
        from app import config

        preferences_path = temp_dir / "settings.json"
        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        monkeypatch.setattr(config.settings, "_preferences_file_override", preferences_path)

        response = client.post(
            "/api/config/preferences",
            json={
                "textFileOpenMode": "web",
                "markdownOpenMode": "web",
                "apiTimeout": 10,
                "folderLatestModifiedMaxEntries": 50_000,
            },
        )

        assert response.status_code == 200
        assert response.json()["folderLatestModifiedMaxEntries"] == 50_000
        assert '"folderLatestModifiedMaxEntries": 50000' in preferences_path.read_text(encoding="utf-8")

    def test_default_text_file_extension_is_saved_and_returned(self, client, temp_dir, monkeypatch):
        """テキストファイル作成時の既定拡張子を設定として保存・取得できる"""
        from app import config

        preferences_path = temp_dir / "settings.json"
        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        monkeypatch.setattr(config.settings, "_preferences_file_override", preferences_path)

        response = client.post(
            "/api/config/preferences",
            json={
                "textFileOpenMode": "web",
                "markdownOpenMode": "web",
                "apiTimeout": 10,
                "defaultTextFileExtension": "md",
            },
        )

        assert response.status_code == 200
        assert response.json()["defaultTextFileExtension"] == "md"
        assert '"defaultTextFileExtension": "md"' in preferences_path.read_text(encoding="utf-8")
