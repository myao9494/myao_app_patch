"""ドキュメントとコードの整合性テスト（コードを正として、記載漏れ・リンク切れを検出する）。"""

from __future__ import annotations

import re
from pathlib import Path

from backend.main import app

ROOT = Path(__file__).resolve().parents[1]
DEV_SPEC = (ROOT / "claude.md").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")


def _documented_paths() -> set[str]:
    """claude.md のAPI一覧表（`| メソッド | `/path` | ...`）に載っているパス。"""
    return set(re.findall(r"^\| [A-Z /]+ \| `([^`]+)`", DEV_SPEC, flags=re.MULTILINE))


def test_すべてのAPIエンドポイントが開発仕様書のAPI一覧に載っている():
    documented = _documented_paths()
    missing = []
    for path in app.openapi()["paths"]:
        listed = path if path == "/map" else path.removeprefix("/api")
        if listed not in documented:
            missing.append(path)
    assert not missing, f"claude.md のAPI一覧に未記載: {missing}"


def test_開発仕様書のAPI一覧に存在しないエンドポイントは載っていない():
    actual = {path if path == "/map" else path.removeprefix("/api") for path in app.openapi()["paths"]}
    actual.add("/terminal/ws")  # WebSocketはOpenAPIに現れない
    stale = sorted(path for path in _documented_paths() if path not in actual)
    assert not stale, f"claude.md に載っているが実装にない: {stale}"


def test_コードが参照するSPOONFEEDER環境変数がすべて開発仕様書に載っている():
    used: set[str] = set()
    for source in list((ROOT / "backend").rglob("*.py")) + [ROOT / "start.sh", ROOT / "start.bat"]:
        used |= set(re.findall(r"SPOONFEEDER_[A-Z_]+", source.read_text(encoding="utf-8")))
    missing = sorted(name for name in used if f"`{name}`" not in DEV_SPEC)
    assert not missing, f"claude.md の環境変数表に未記載: {missing}"


def test_READMEのローカルリンク先が存在する():
    broken = []
    for target in re.findall(r"\]\(([^)#]+)\)", README):
        if not target.startswith(("http://", "https://")) and not (ROOT / target).exists():
            broken.append(target)
    assert not broken, f"README のリンク切れ: {broken}"


def _table_section(start: str, end: str) -> str:
    return DEV_SPEC[DEV_SPEC.index(start):DEV_SPEC.index(end)]


def test_開発仕様書のバックエンド構成表にあるモジュールがすべて存在する():
    section = _table_section("### backend/", "### frontend/src/")
    names = {name for row in re.findall(r"^\| ([^|]+) \|", section, flags=re.MULTILINE) for name in re.findall(r"`([^`]+)`", row)}
    names -= {"モジュール"}
    missing = sorted(name for name in names if not (ROOT / "backend" / name).exists())
    assert names and not missing, f"claude.md のバックエンド構成表にあるが存在しない: {missing}"


def test_開発仕様書のフロントエンド構成表にある場所がすべて存在する():
    section = _table_section("### frontend/src/", "## 4.")
    names = {name for row in re.findall(r"^\| ([^|]+) \|", section, flags=re.MULTILINE) for name in re.findall(r"`([^`]+)`", row)}
    names = {name for name in names if name.endswith("/") or name.endswith((".jsx", ".js"))}
    missing = sorted(name for name in names if not (ROOT / "frontend" / "src" / name).exists())
    assert names and not missing, f"claude.md のフロントエンド構成表にあるが存在しない: {missing}"
