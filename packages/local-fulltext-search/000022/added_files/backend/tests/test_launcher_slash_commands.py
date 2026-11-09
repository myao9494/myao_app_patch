"""
ランチャーの OpenCode ペインで使う、このアプリ独自のスラッシュコマンド（/pass など）の保存を検証する。

【仕様】
- 保存先は data_dir 配下の launcher_slash_commands.json（人が読める JSON）。読み書きは AppSettingsStore 経由。
- 1 件は name（先頭の / は外す）・prompt・description。名前は大文字小文字を区別せず重複させない（先に来た方を残す）。
- 名前に空白や / を含むもの、プロンプトが空のものは受け付けない（API は 422）。
- 一覧は名前順。ファイルが無い・壊れているときは空の一覧として扱う（ランチャーを止めない）。
"""

from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from app.api.index import get_launcher_slash_commands, update_launcher_slash_commands
from app.config import settings
from app.models.indexing import LauncherSlashCommandsUpdateRequest, SlashCommandItem
from app.services.app_settings_store import AppSettingsStore


def test_store_round_trip_normalizes_and_sorts() -> None:
    """先頭の / を外し、名前順に並べ、重複（大文字小文字違いを含む）は先の 1 件だけ残して保存する。"""
    store = AppSettingsStore()

    saved = store.write_launcher_slash_commands([
        {"name": "/pass", "prompt": "パスワード表から $ARGUMENTS を探して", "description": "パスワード取得"},
        {"name": "daily", "prompt": "今日の作業をまとめて"},
        {"name": "PASS", "prompt": "重複"},
    ])

    assert saved == [
        {"name": "daily", "prompt": "今日の作業をまとめて", "description": ""},
        {"name": "pass", "prompt": "パスワード表から $ARGUMENTS を探して", "description": "パスワード取得"},
    ]
    assert store.read_launcher_slash_commands() == saved
    stored = json.loads(settings.launcher_slash_commands_path.read_text(encoding="utf-8"))
    assert stored == saved


def test_store_drops_invalid_entries() -> None:
    """名前やプロンプトが空のもの、名前に空白を含むものは保存しない。"""
    store = AppSettingsStore()

    saved = store.write_launcher_slash_commands([
        {"name": "", "prompt": "名前なし"},
        {"name": "empty", "prompt": "   "},
        {"name": "two words", "prompt": "空白入り"},
        {"name": "ok", "prompt": "  前後の空白は取る  "},
    ])

    assert saved == [{"name": "ok", "prompt": "前後の空白は取る", "description": ""}]


def test_store_reads_missing_or_broken_file_as_empty() -> None:
    """ファイルが無い・JSON として読めないときは空の一覧（例外にしない）。"""
    store = AppSettingsStore()
    assert store.read_launcher_slash_commands() == []

    settings.launcher_slash_commands_path.parent.mkdir(parents=True, exist_ok=True)
    settings.launcher_slash_commands_path.write_text("{壊れた", encoding="utf-8")
    assert store.read_launcher_slash_commands() == []


def test_request_model_rejects_invalid_name_and_empty_prompt() -> None:
    """API の要求は、名前の空白・/・空、プロンプトの空を 422（ValidationError）にする。先頭の / は外す。"""
    assert SlashCommandItem(name=" /pass ", prompt="x").name == "pass"
    for bad in ({"name": "two words", "prompt": "x"}, {"name": "a/b", "prompt": "x"}, {"name": " ", "prompt": "x"}, {"name": "ok", "prompt": "  "}):
        with pytest.raises(ValidationError):
            SlashCommandItem.model_validate(bad)


class StubSlashCommandService:
    """スラッシュコマンドの保存だけを持つ IndexService の代わり。"""

    def __init__(self) -> None:
        self.saved: list[dict[str, str]] = [{"name": "pass", "prompt": "p", "description": ""}]

    def get_launcher_slash_commands(self) -> list[dict[str, str]]:
        return self.saved

    def save_launcher_slash_commands(self, commands: list[dict[str, str]]) -> list[dict[str, str]]:
        self.saved = commands
        return commands


def test_endpoints_read_and_save_commands() -> None:
    """GET は一覧を、PUT は保存後の一覧を {"commands": [...]} で返す。"""
    service = StubSlashCommandService()

    assert get_launcher_slash_commands(service) == {"commands": [{"name": "pass", "prompt": "p", "description": ""}]}
    request = LauncherSlashCommandsUpdateRequest(commands=[SlashCommandItem(name="/daily", prompt="まとめて", description="日報")])
    payload = update_launcher_slash_commands(request, service)

    assert payload == {"commands": [{"name": "daily", "prompt": "まとめて", "description": "日報"}]}
    assert service.saved == payload["commands"]
