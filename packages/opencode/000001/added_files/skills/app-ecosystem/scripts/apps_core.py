"""自作の Web アプリ (エコシステム) を呼ぶ共通の部品 (標準ライブラリだけ)。

アプリと既定の場所 (会社と同じポート。config.local.json の apps で変えられる):
  search  全文検索 (Local-fulltext-search)  http://127.0.0.1:8079
  gantt   ガントチャート                    http://127.0.0.1:8000
  files   ファイルマネージャー              http://127.0.0.1:8001
  diff    Visual Diff Tool                  http://127.0.0.1:8078
  draw    Excalidraw                        http://127.0.0.1:3001
各アプリの GET /api/ecosystem (エコシステム API 1。ハーネスの docs/apps.md) で、起動・版・深いリンクを知る。

安全の決まり:
  - 呼ぶ先は、この PC (127.0.0.1 / localhost / ::1) だけ。設定で外の住所を書いても拒否する (データを外へ送らない)
  - 呼ぶのは、ここに書いた操作だけ (読み取り、タスクの作成・更新、差分)。削除・コマンド実行・OS のアプリ起動は呼ばない
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

SKILL_DIR = Path(__file__).resolve().parents[1]
ECOSYSTEM_VERSION = 1
DEFAULT_APPS = {
    "search": "http://127.0.0.1:8079",
    "gantt": "http://127.0.0.1:8000",
    "files": "http://127.0.0.1:8001",
    "diff": "http://127.0.0.1:8078",
    "draw": "http://127.0.0.1:3001",
}
TITLES = {"search": "全文検索", "gantt": "ガントチャート", "files": "ファイルマネージャー", "diff": "差分 (Visual Diff Tool)", "draw": "Excalidraw"}
# アプリが古くて /api/ecosystem が無いときに使う、人が開く画面のひな形 (各アプリの実装に合わせたもの)
DEFAULT_LINKS = {
    "search": {"home": "/", "search": "/?q={q}&search_all=1", "search_in": "/?q={q}&full_path={folder}"},
    "gantt": {"home": "/"},
    "files": {"home": "/", "folder": "/?path={path}"},
    "diff": {"home": "/", "result": "/?result_id={result_id}", "markdown": "/?markdown_path={path}", "git": "/?git_path={path}"},
    "draw": {"home": "/", "open": "/?filepath={path}"},
}
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
DEFAULT_TIMEOUT = 5.0
DIFF_TIMEOUT = 120.0  # PDF・CAD の変換と位置合わせは時間がかかる


class AppsError(Exception):
    """利用者に見せてよいメッセージ (終了コード 2: 使い方・設定の誤り)。"""


class AppUnavailable(AppsError):
    """アプリに接続できない (終了コード 3)。"""


@dataclass
class Config:
    apps: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_APPS))
    timeout: float = DEFAULT_TIMEOUT


def check_base_url(name: str, url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise AppsError(f"apps.{name} の URL が正しくありません: {url!r} (例: http://127.0.0.1:8000)")
    if parsed.hostname.lower() not in LOOPBACK_HOSTS:
        raise AppsError(f"apps.{name} は、この PC (127.0.0.1 / localhost) だけにしてください: {url!r} (データを外へ送らないため)")
    return url.rstrip("/")


def load_config(path: Path | None = None) -> Config:
    """config.local.json があれば、apps と timeout_sec を上書きする (無ければ既定のまま)。"""
    config = Config()
    target = path or SKILL_DIR / "config.local.json"
    if target.is_file():
        try:
            data = json.loads(target.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as exc:
            raise AppsError(f"設定ファイルを読めません: {target}: {exc}") from exc
        for name, url in (data.get("apps") or {}).items():
            if name not in DEFAULT_APPS:
                raise AppsError(f"知らないアプリの名前です: {name} (使えるもの: {', '.join(DEFAULT_APPS)})")
            config.apps[name] = str(url)
        if "timeout_sec" in data:
            config.timeout = float(data["timeout_sec"])
    config.apps = {name: check_base_url(name, url) for name, url in config.apps.items()}
    return config


def request_json(config: Config, app: str, method: str, path: str, *, query: dict[str, Any] | None = None, body: Any = None, timeout: float | None = None) -> Any:
    """アプリの API を呼び、JSON を返す。HTTP のエラーは、アプリの detail を添えて AppsError にする。"""
    url = config.apps[app] + path
    if query:
        url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None and v != ""})
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Accept": "application/json", **({"Content-Type": "application/json"} if data else {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout or config.timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            payload = json.loads(exc.read().decode("utf-8", "replace"))
            detail = payload.get("detail") if isinstance(payload, dict) else ""
        except ValueError:
            pass
        if isinstance(detail, list):  # FastAPI の入力検証のエラー
            detail = "; ".join(str(item.get("msg", item)) for item in detail if isinstance(item, dict)) or str(detail)
        raise AppsError(f"{TITLES[app]} がエラーを返しました (HTTP {exc.code}){': ' + str(detail) if detail else ''}") from exc
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        raise AppUnavailable(f"{TITLES[app]} ({config.apps[app]}) に接続できません: {reason}。アプリが起動しているか確認してください") from exc
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError as exc:
        raise AppsError(f"{TITLES[app]} の応答が JSON ではありません ({path})。版が古いか、別のアプリがそのポートを使っています") from exc


@dataclass
class AppStatus:
    name: str
    base_url: str
    running: bool
    manifest: dict[str, Any] | None = None
    note: str = ""


def probe(config: Config, name: str) -> AppStatus:
    """/api/ecosystem で名乗りを聞く。HTTP の応答はあるのに名乗りが無ければ、古い版のアプリとして扱う。"""
    base = config.apps[name]
    try:
        manifest = request_json(config, name, "GET", "/api/ecosystem", timeout=min(config.timeout, 3.0))
    except AppUnavailable as exc:
        return AppStatus(name, base, False, note=str(exc))
    except AppsError:
        # 404 などが返る = 何かが動いている。/api/health が無いアプリもあるので、ここで起動中と判断する
        return AppStatus(name, base, True, note="起動しているが、エコシステム API がありません (古い版か、別のアプリ)。links は既定のひな形を使います")
    if not isinstance(manifest, dict) or manifest.get("app") != name:
        return AppStatus(name, base, True, note=f"別のアプリが応答しました (app={manifest.get('app') if isinstance(manifest, dict) else '?'})。ポートの設定を確認してください")
    note = "" if manifest.get("ecosystem") == ECOSYSTEM_VERSION else f"エコシステム API の版が違います ({manifest.get('ecosystem')}。このスキルは {ECOSYSTEM_VERSION})"
    return AppStatus(name, base, True, manifest, note)


def link_templates(status: AppStatus) -> dict[str, str]:
    links = dict(DEFAULT_LINKS[status.name])
    if status.manifest and isinstance(status.manifest.get("links"), dict):
        links.update({k: v for k, v in status.manifest["links"].items() if isinstance(v, str)})
    return links


def fill(base_url: str, template: str, **values: str) -> str:
    """ひな形の {名前} を、URL エンコードした値で埋める。"""
    text = template
    for key, value in values.items():
        text = text.replace("{" + key + "}", urllib.parse.quote(value, safe=""))
    return base_url + text
