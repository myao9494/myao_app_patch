"""
コード反映を許可する外部ライブラリルートの検出モジュール (external_roots.py)

仕様:
1. PYTHONPATH、手動参照リポジトリ設定、メインリポジトリ内コードの sys.path.append / insert 指定先を、
   メインリポジトリ以外で反映を許可するルートとして列挙する。
2. sys.path の走査は Git 管理（または無視設定適用後）のファイルだけを対象とし、.venv や node_modules を辿らない。
"""

from __future__ import annotations

import os
from pathlib import Path

from .references import extract_sys_path_entries
from .repository import list_repository_entries
from .settings_store import get_settings_file, load_settings, manual_references


def get_external_roots(root: Path) -> list[Path]:
    """PYTHONPATH、手動参照設定、およびコード内のsys.path追加先から外部ライブラリのルート一覧を取得する。"""
    root = root.resolve()
    roots: list[Path] = []

    def add(raw: str) -> None:
        candidate = Path(raw).expanduser().resolve()
        if candidate.is_dir() and candidate != root:
            roots.append(candidate)

    for raw in os.environ.get("PYTHONPATH", "").split(os.pathsep):
        if raw.strip():
            add(raw)
    try:
        for ref_path in manual_references(load_settings(get_settings_file()), root).values():
            add(ref_path)
    except (OSError, RuntimeError):
        pass
    try:
        entries, _ = list_repository_entries(root)
        py_files = [root / entry.path for entry in entries if entry.kind == "file" and entry.path.endswith(".py")]
        for entry in extract_sys_path_entries(root, py_files):
            add(str(entry))
    except (OSError, RuntimeError):
        pass
    return list(dict.fromkeys(roots))
