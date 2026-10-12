"""
設定APIのテスト
エディタ設定の取得・保存と設定ファイル反映を確認する
"""


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


class TestPreferencesCache:
    """設定ファイルの読み込みキャッシュ（パス正規化のたびにファイルを読まない）"""

    def test_reads_file_once_until_it_changes(self, isolated_preferences, monkeypatch):
        import json
        import os

        from app import config

        isolated_preferences.write_text(json.dumps({"apiTimeout": 12}), encoding="utf-8")
        reads = []
        original_loads = config.json.loads
        monkeypatch.setattr(config.json, "loads", lambda text: reads.append(text) or original_loads(text))

        assert config.get_editor_preferences()["apiTimeout"] == 12
        assert config.get_editor_preferences()["apiTimeout"] == 12
        assert len(reads) == 1

        isolated_preferences.write_text(json.dumps({"apiTimeout": 30}), encoding="utf-8")
        stat = isolated_preferences.stat()
        os.utime(isolated_preferences, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))

        assert config.get_editor_preferences()["apiTimeout"] == 30
        assert len(reads) == 2

    def test_returned_preferences_cannot_corrupt_cache(self, isolated_preferences):
        import json

        from app import config

        isolated_preferences.write_text(json.dumps({"pathMappings": {"/new": "/old"}}), encoding="utf-8")

        config.get_editor_preferences()["pathMappings"]["/evil"] = "/x"

        assert config.get_editor_preferences()["pathMappings"] == {"/new": "/old"}

    def test_save_is_atomic_and_visible_immediately(self, isolated_preferences):
        from app import config

        config.get_editor_preferences()
        config.save_editor_preferences("vscode", "web", api_timeout=20)

        assert config.get_editor_preferences()["apiTimeout"] == 20
        assert sorted(p.name for p in isolated_preferences.parent.iterdir()) == ["settings.json"]


class TestLocalPreferencesFile:
    """設定は git 管理外の settings.local.json に保存し、既存の settings.json から引き継ぐ"""

    def test_default_path_is_git_ignored_local_file(self, monkeypatch):
        from app import config

        monkeypatch.setattr(config.settings, "_preferences_file_override", None)
        monkeypatch.delenv("FILE_MANAGER_PREFERENCES_FILE", raising=False)

        assert config.settings.preferences_file_path.name == "settings.local.json"

    def test_reads_legacy_settings_until_first_save(self, tmp_path, monkeypatch):
        import json

        from app import config

        legacy = tmp_path / "settings.json"
        local = tmp_path / "settings.local.json"
        legacy.write_text(json.dumps({"apiTimeout": 42, "pathMappings": {"/new": "/old"}}), encoding="utf-8")
        monkeypatch.setattr(config.settings, "_preferences_file_override", None)
        monkeypatch.delenv("FILE_MANAGER_PREFERENCES_FILE", raising=False)
        monkeypatch.setattr(config, "BACKEND_DIR", tmp_path)

        prefs = config.get_editor_preferences()
        assert prefs["apiTimeout"] == 42
        assert prefs["pathMappings"] == {"/new": "/old"}

        config.save_editor_preferences("web", "web", api_timeout=15, path_mappings=prefs["pathMappings"])

        assert json.loads(local.read_text(encoding="utf-8"))["apiTimeout"] == 15
        assert json.loads(legacy.read_text(encoding="utf-8"))["apiTimeout"] == 42  # 既存ファイルは変更しない
        assert config.get_editor_preferences()["apiTimeout"] == 15
