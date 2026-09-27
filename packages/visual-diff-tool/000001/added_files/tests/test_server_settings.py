"""
サーバー設定ファイル（.visual-diff-settings.json）の管理・整合性仕様。

- backend/.visual-diff-settings.json が存在し、有効なJSON形式であること。
- デフォルトの設定キー（obsidian_folder, obsidian_report_folder）が含まれていること。
- 初期値として個人環境に依存した絶対パスが含まれておらず、安全なデフォルト値であること。
- .gitignore に backend/.visual-diff-settings.json が指定されておらず、Git管理（追跡）対象となっていること。
- 設定読み込み関数および設定取得APIがデフォルト設定を正常に取得できること。
"""

import json
import os
import unittest
from pathlib import Path
from fastapi.testclient import TestClient

from backend.app.main import app, SERVER_SETTINGS_PATH, _load_server_settings


class TestServerSettingsIntegrity(unittest.TestCase):
    def setUp(self):
        self.repo_root = Path(__file__).resolve().parents[1]
        self.settings_file = self.repo_root / "backend" / ".visual-diff-settings.json"
        self.gitignore_file = self.repo_root / ".gitignore"
        self.client = TestClient(app)

    def test_settings_file_exists_and_is_valid_json(self):
        """設定ファイルがリポジトリ内に存在し、有効なJSONであることを検証する"""
        self.assertTrue(self.settings_file.exists(), f"{self.settings_file} が存在しません")
        content = self.settings_file.read_text(encoding="utf-8")
        data = json.loads(content)
        self.assertIsInstance(data, dict)

    def test_settings_file_has_required_keys_with_safe_defaults(self):
        """設定ファイルに必要なキーが含まれ、個人環境依存のパスではなく安全な初期値であることを検証する"""
        self.assertTrue(self.settings_file.exists())
        data = json.loads(self.settings_file.read_text(encoding="utf-8"))
        self.assertIn("obsidian_folder", data)
        self.assertIn("obsidian_report_folder", data)
        # 個人環境の絶対パス（/Users/... など）が含まれていないことを検証
        for key in ["obsidian_folder", "obsidian_report_folder"]:
            val = data[key]
            self.assertFalse(
                isinstance(val, str) and val.startswith("/Users/"),
                f"{key} にローカル個人環境の絶対パス '{val}' が残っています。安全なデフォルト値である必要があります。"
            )

    def test_settings_file_is_not_gitignored(self):
        """.gitignore に backend/.visual-diff-settings.json が含まれておらず、Git管理対象であることを検証する"""
        self.assertTrue(self.gitignore_file.exists())
        lines = self.gitignore_file.read_text(encoding="utf-8").splitlines()
        ignored_entries = [line.strip() for line in lines if line.strip() and not line.strip().startswith("#")]
        self.assertNotIn(
            "backend/.visual-diff-settings.json",
            ignored_entries,
            "backend/.visual-diff-settings.json が .gitignore に指定されています。Git管理対象に含める必要があります。"
        )
        self.assertNotIn(
            ".visual-diff-settings.json",
            ignored_entries,
            ".visual-diff-settings.json が .gitignore に指定されています。"
        )

    def test_load_server_settings_default_behavior(self):
        """サーバー設定読み込み関数およびAPIが正常に動作することを検証する"""
        settings = _load_server_settings()
        self.assertIsInstance(settings, dict)
        response = self.client.get("/api/settings/obsidian")
        self.assertEqual(response.status_code, 200)
        json_data = response.json()
        self.assertIn("obsidian_folder", json_data)
        self.assertIn("obsidian_report_folder", json_data)


if __name__ == "__main__":
    unittest.main()
