"""
ユーザー設定ファイル (spoonfeeder_configs.json) の読み書きモジュール (settings_store.py)

仕様:
1. 設定ファイルの場所は環境変数 SPOONFEEDER_CONFIGS_FILE で切り替えられる（既定はプロジェクト直下）。
2. 読み込み→変更→保存はプロセス内ロックの下で行い（settings_transaction）、保存は一時ファイル経由のアトミック置換とする。
3. JSONが壊れていた場合は `<name>.corrupt[.N]` へ退避してから空の設定を返し、履歴や選択状態が上書きで消えないようにする。
"""

from __future__ import annotations

import json
import os
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .repository import read_text_file

ROOT = Path(__file__).resolve().parents[1]
SETTINGS_LOCK = threading.RLock()


def get_settings_file() -> Path:
    return Path(os.environ.get("SPOONFEEDER_CONFIGS_FILE", ROOT / "spoonfeeder_configs.json"))


def _quarantine_corrupt_settings(path: Path) -> None:
    with SETTINGS_LOCK:
        if not path.exists():
            return
        for index in range(100):
            backup = path.with_name(f"{path.name}.corrupt" + (f".{index}" if index else ""))
            if not backup.exists():
                try:
                    os.replace(path, backup)
                except OSError:
                    pass
                return


def load_settings(path: Path) -> dict:
    if not path.exists():
        return {"repositories": {}, "ui": {"show_ignored": False}}
    try:
        data = json.loads(read_text_file(path)[0])
    except json.JSONDecodeError:
        _quarantine_corrupt_settings(path)
        return {"repositories": {}, "ui": {}}
    except OSError:
        return {"repositories": {}, "ui": {}}
    return data if isinstance(data, dict) else {"repositories": {}, "ui": {}}


def save_settings(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    with SETTINGS_LOCK:
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, path)


@contextmanager
def settings_transaction() -> Iterator[dict]:
    """設定を読み込んで渡し、ブロックを正常に抜けたときだけ保存する。"""
    with SETTINGS_LOCK:
        path = get_settings_file()
        settings = load_settings(path)
        yield settings
        save_settings(path, settings)


def repository_config(settings: dict, root: Path) -> dict:
    """読み取り専用で、リポジトリごとの設定辞書を返す（なければ空辞書）。"""
    config = settings.get("repositories", {}).get(str(root), {})
    return config if isinstance(config, dict) else {}


def remember_repository(root: Path, selected_files: list[str] | None = None, show_ignored: bool | None = None) -> None:
    with settings_transaction() as settings:
        config = settings.setdefault("repositories", {}).setdefault(str(root), {})
        if selected_files is not None:
            config["selected_files"] = selected_files
        if show_ignored is not None:
            config["show_ignored"] = show_ignored


def manual_references(settings: dict, root: Path) -> dict[str, str]:
    """手動で対応付けた {モジュール名: 参照リポジトリのパス} を、空要素を除いて返す。"""
    raw = repository_config(settings, root).get("manual_references", {})
    if not isinstance(raw, dict):
        return {}
    return {str(module): str(path) for module, path in raw.items() if str(module).strip() and str(path).strip()}
