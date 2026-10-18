"""
pytest 共通フィクスチャおよびテストセッション初期化設定。

仕様:
1. テスト実行時に本番用の spoonfeeder_configs.json が汚染されないよう、
   SPOONFEEDER_CONFIGS_FILE 環境変数をテスト用の一時ファイル (pytest/.test_configs.json) に固定する。
2. TestClient の既定Host (testserver) を SPOONFEEDER_ALLOWED_HOSTS で許可する。
"""

from __future__ import annotations

import os
from pathlib import Path
import pytest

TEST_CONFIGS_FILE = Path(__file__).parent / ".test_configs.json"
os.environ["SPOONFEEDER_CONFIGS_FILE"] = str(TEST_CONFIGS_FILE)
# TestClient の既定Host(testserver)を許可する。Host検証そのものは security_test.py で確認する。
os.environ.setdefault("SPOONFEEDER_ALLOWED_HOSTS", "testserver")


@pytest.fixture(autouse=True)
def isolate_test_configs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """各テストごとに独立した設定ファイルを用意してテスト間の干渉を防ぐ"""
    configs_path = tmp_path / "test_spoonfeeder_configs.json"
    configs_path.write_text('{"repositories": {}, "ui": {}}', encoding="utf-8")
    monkeypatch.setenv("SPOONFEEDER_CONFIGS_FILE", str(configs_path))
