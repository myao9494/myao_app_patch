"""ローカルのファイル検索の本体 (標準ライブラリだけで動く)。

2 つの検索サーバーを、読み取り専用で呼ぶ。
  - Local-fulltext-search : 中身 (全文) の検索。POST /api/search/indexed (再インデックスをしない)
  - Everything            : ファイル名・フォルダ名の検索。HTTP サーバー機能の JSON 出力

対象の限定は、この中で強制する。
  - 設定の roots に無い場所は、検索の対象にも、結果にも出さない
  - 引数で別の場所を指定されても、roots の外なら拒否する
  - 全文検索には、空の folder_path (インデックス全体の検索) を、決して送らない
検索のパスの検査は文字列だけで行う (ファイルシステムには触れない)。検索結果は、サーバーが返した
インデックス上のパスで、利用者が与えたパスではないため、シンボリックリンクの解決は不要。
見つけたテキストのファイルを読む read_text だけは、ファイルを開くので、リンクを解いた後の場所でも roots の中かを確かめる。
"""
from __future__ import annotations

import base64
import fnmatch
import json
import os
import posixpath
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

DEFAULT_LIMITS = {"max_results": 30, "snippet_chars": 160, "timeout_sec": 15}
HARD_MAX_RESULTS = 100
CONFIG_ENV = "OPENCODE_FINDER_CONFIG"
FILETIME_EPOCH = datetime(1601, 1, 1, tzinfo=timezone.utc)


class ConfigError(ValueError):
    """設定の誤り (利用者が直す)。"""


class BackendError(RuntimeError):
    """検索サーバーに接続できない、または異常な応答。"""


# ---------------------------------------------------------------------------
# パスの扱い
# ---------------------------------------------------------------------------

def norm_path(path: str) -> str:
    """区切りを / にそろえ、'..' を畳み、末尾の / を除く。UNC (//server/share) の先頭は保つ。"""
    text = path.strip().replace("\\", "/")
    if not text:
        return ""
    unc = text.startswith("//")
    text = posixpath.normpath(text)
    if unc and not text.startswith("//"):
        text = "/" + text
    if re.fullmatch(r"[A-Za-z]:", text):
        text += "/"  # ドライブの直下は 'C:/' の形にそろえる (normpath は 'C:' にしてしまう)
    elif len(text) > 1 and text.endswith("/"):
        text = text.rstrip("/")
    return text


def is_under(path: str, root: str) -> bool:
    """path が root そのもの、または root の配下か (大文字小文字は区別しない)。"""
    p, r = norm_path(path).casefold(), norm_path(root).casefold()
    if not p or not r:
        return False
    if p == r:
        return True
    prefix = r if r.endswith("/") else r + "/"
    return p.startswith(prefix)


def under_any(path: str, roots: list[str]) -> bool:
    return any(is_under(path, root) for root in roots)


def is_excluded(path: str, patterns: list[str]) -> bool:
    """パスのどれかの階層の名前が、除外パターン (fnmatch) に一致するか。"""
    segments = [s for s in norm_path(path).casefold().split("/") if s]
    for pattern in patterns:
        pat = pattern.casefold()
        if any(fnmatch.fnmatchcase(segment, pat) for segment in segments):
            return True
    return False


def to_windows(path: str) -> str:
    return norm_path(path).replace("/", "\\")


# ---------------------------------------------------------------------------
# 設定
# ---------------------------------------------------------------------------

@dataclass
class Config:
    roots: list[str]
    exclude: list[str] = field(default_factory=list)
    everything_url: str = ""
    everything_user: str = ""
    everything_password_env: str = "EVERYTHING_PASSWORD"
    fulltext_url: str = ""
    fulltext_folders: list[str] = field(default_factory=list)
    limits: dict[str, int] = field(default_factory=lambda: dict(DEFAULT_LIMITS))

    @property
    def everything_password(self) -> str:
        return os.environ.get(self.everything_password_env, "")


def default_config_path() -> Path:
    override = os.environ.get(CONFIG_ENV)
    return Path(override) if override else Path(__file__).resolve().parents[1] / "config.local.json"


def load_config(path: Path | None = None) -> Config:
    path = path or default_config_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError as exc:
        raise ConfigError(f"設定ファイルがありません: {path}\n(config.sample.json をコピーして config.local.json を作り、roots を書いてください)") from exc
    except ValueError as exc:
        raise ConfigError(f"設定ファイルの JSON が正しくありません: {path} ({exc})") from exc
    if not isinstance(raw, dict):
        raise ConfigError("設定ファイルの最上位は、オブジェクトにしてください")

    roots = [norm_path(str(r)) for r in raw.get("roots", []) if str(r).strip() and "<" not in str(r)]
    if not roots:
        raise ConfigError("roots (検索してよいフォルダ) が空です。config.local.json に、絶対パスで書いてください")
    for root in roots:
        if not (re.match(r"^[A-Za-z]:/", root + "/") or root.startswith("/")):
            raise ConfigError(f"roots は絶対パスで書いてください: {root}")

    everything = raw.get("everything", {}) or {}
    fulltext = raw.get("fulltext", {}) or {}
    folders = [norm_path(str(f)) for f in fulltext.get("folders", []) if str(f).strip()]
    for folder in folders:
        if not under_any(folder, roots):
            raise ConfigError(f"fulltext.folders のフォルダが、roots の外にあります: {folder}")
    limits = dict(DEFAULT_LIMITS)
    limits.update({k: int(v) for k, v in (raw.get("limits", {}) or {}).items() if k in DEFAULT_LIMITS})
    limits["max_results"] = max(1, min(limits["max_results"], HARD_MAX_RESULTS))
    return Config(
        roots=roots,
        exclude=[str(e) for e in raw.get("exclude", [])],
        everything_url=str(everything.get("url", "")).rstrip("/"),
        everything_user=str(everything.get("user", "")),
        everything_password_env=str(everything.get("password_env", "EVERYTHING_PASSWORD")),
        fulltext_url=str(fulltext.get("url", "")).rstrip("/"),
        fulltext_folders=folders,
        limits=limits,
    )


def resolve_scope(config: Config, folder: str | None) -> list[str]:
    """--folder があれば、roots の中であることを確かめて、そのフォルダだけを対象にする。"""
    if not folder:
        return list(config.roots)
    if not under_any(folder, config.roots):
        raise ConfigError(f"'{folder}' は、検索してよいフォルダ (roots) の外です。対象: {', '.join(config.roots)}")
    return [norm_path(folder)]


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def http_json(url: str, *, data: dict | None = None, headers: dict | None = None, timeout: int = 15) -> Any:
    body = json.dumps(data).encode("utf-8") if data is not None else None
    request = urllib.request.Request(url, data=body, method="POST" if data is not None else "GET")
    request.add_header("Accept", "application/json")
    if body is not None:
        request.add_header("Content-Type", "application/json; charset=utf-8")
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:200]
        raise BackendError(f"サーバーがエラーを返しました (HTTP {exc.code}): {url} {detail}") from exc
    except urllib.error.URLError as exc:
        raise BackendError(f"サーバーに接続できません: {url} ({exc.reason})") from exc
    except (TimeoutError, OSError) as exc:
        raise BackendError(f"サーバーが応答しません: {url} ({exc})") from exc
    except ValueError as exc:
        raise BackendError(f"サーバーの応答が JSON ではありません: {url}") from exc


# ---------------------------------------------------------------------------
# 全文検索 (Local-fulltext-search)
# ---------------------------------------------------------------------------

def normalize_ext(value: str) -> str:
    return value.strip().lstrip(".").casefold()


def parse_exts(text: str | None) -> list[str]:
    return [e for e in (normalize_ext(p) for p in re.split(r"[,\s;]+", text or "")) if e]


def collapse(text: str, limit: int) -> str:
    flat = re.sub(r"\s+", " ", text or "").strip()
    return flat if len(flat) <= limit else flat[:limit] + "…"


AI_NOTE_HEAD_BYTES = 4096


def ai_note_status(path: str) -> str | None:
    """Obsidian のノートが AI のまとめかを、frontmatter で見る (読み取りだけ。先頭 4 KB)。
    'unreviewed' (ai_generated があり、ai_reviewed が true でない) / 'reviewed' (ai_reviewed: true) / None (人のノート)。
    'edited' は、人のノートを AI が直して、まだレビューされていないもの (ai_edited。根拠には使ってよい)。
    10_summary/ (Vault の決まりで AI の要約の置き場) は、印が無くても AI のまとめとして扱う。"""
    if not path.lower().endswith(".md"):
        return None
    try:
        with open(path, "rb") as handle:
            head = handle.read(AI_NOTE_HEAD_BYTES).decode("utf-8", "replace").lstrip("\ufeff")
    except OSError:
        return None
    front = ""
    if head.startswith("---"):
        end = head.find("\n---", 3)
        front = head[3:end] if end != -1 else ""
    generated = re.search(r"(?m)^ai_generated:[ \t]*\S", front) is not None
    reviewed = re.search(r"(?mi)^ai_reviewed:[ \t]*(true|yes)[ \t\r]*$", front) is not None
    in_summary = "/10_summary/" in "/" + path.replace("\\", "/").lstrip("/")
    if not (generated or in_summary):
        if re.search(r"(?m)^ai_edited:[ \t]*\S", front) and not reviewed:
            return "edited"  # 人のノートを AI が直した (未レビュー)。根拠には使ってよい
        return None
    return "reviewed" if reviewed else "unreviewed"


def fulltext_search(config: Config, query: str, folder: str | None = None, exts: list[str] | None = None, mode: str = "keyword", limit: int | None = None) -> dict[str, Any]:
    if not config.fulltext_url:
        raise ConfigError("fulltext.url が設定されていません")
    if not query.strip():
        raise ConfigError("検索語を指定してください")
    scope = resolve_scope(config, folder)
    if folder is None and config.fulltext_folders:
        scope = list(config.fulltext_folders)
    limit = min(limit or config.limits["max_results"], config.limits["max_results"])
    exts = exts or []
    timeout = config.limits["timeout_sec"]

    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    dropped = 0
    for target in scope:
        if len(items) >= limit:
            break
        payload: dict[str, Any] = {
            "q": query, "folder_path": target, "limit": min(limit * 3 if exts else limit, HARD_MAX_RESULTS),
            "offset": 0, "source_type": "local", "search_type": mode,
        }
        if exts:
            payload["extensions"] = ",".join(exts)
        data = http_json(f"{config.fulltext_url}/api/search/indexed", data=payload, timeout=timeout)
        for entry in data.get("items", []):
            path = norm_path(str(entry.get("full_path", "")))
            key = path.casefold()
            if (entry.get("source_type", "local") != "local" or not path or key in seen
                    or not under_any(path, config.roots) or is_excluded(path, config.exclude)):
                dropped += 1  # roots の外・除外・重複は、結果に出さない
                continue
            ext = normalize_ext(str(entry.get("file_ext", "")) or posixpath.splitext(path)[1])
            if exts and ext not in exts:
                continue
            seen.add(key)
            items.append({
                "path": path, "kind": entry.get("result_kind", "file"), "ext": ext,
                "modified": str(entry.get("mtime", ""))[:10],
                "snippet": collapse(str(entry.get("salient_sentence") or entry.get("snippet") or ""), config.limits["snippet_chars"]),
                # 一致の種類: both (語と意味) / keyword_only (語) / vector_only (意味だけ。語を含まない)
                "match": entry.get("match_type"),
                "score": next((entry.get(k) for k in ("hybrid_score", "vector_score", "keyword_score") if isinstance(entry.get(k), (int, float))), None),
                "ai": ai_note_status(path),
            })
            if len(items) >= limit:
                break
    return {"query": query, "scope": scope, "mode": mode, "items": items, "dropped": dropped}


def fulltext_targets(config: Config) -> dict[str, Any]:
    """アプリが検索対象にしているフォルダと、それが roots の中かを返す。"""
    if not config.fulltext_url:
        raise ConfigError("fulltext.url が設定されていません")
    data = http_json(f"{config.fulltext_url}/api/index/search-targets", timeout=config.limits["timeout_sec"])
    rows = []
    for item in data.get("items", []):
        path = norm_path(str(item.get("full_path", "")))
        if item.get("source_type", "local") != "local":
            continue
        rows.append({
            "path": path, "enabled": bool(item.get("is_enabled")), "files": int(item.get("indexed_file_count") or 0),
            "in_roots": under_any(path, config.roots),
        })
    return {"rows": rows}


# ---------------------------------------------------------------------------
# ファイル名・フォルダ名の検索 (Everything)
# ---------------------------------------------------------------------------

def filetime_to_text(value: Any) -> str:
    """Everything の日時 (FILETIME の数値) を YYYY-MM-DD にする。数値でなければ、そのまま短くして返す。"""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return str(value or "")[:10]
    if number <= 0:
        return ""
    return (FILETIME_EPOCH + timedelta(microseconds=number // 10)).astimezone().strftime("%Y-%m-%d")


def human_size(value: Any) -> str:
    try:
        size = int(value)
    except (TypeError, ValueError):
        return ""
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size}{unit}" if unit == "B" else f"{size:.0f}{unit}"
        size /= 1024  # type: ignore[assignment]
    return ""


def everything_search(config: Config, terms: str, folder: str | None = None, kind: str = "any", exts: list[str] | None = None, limit: int | None = None) -> dict[str, Any]:
    if not config.everything_url:
        raise ConfigError("everything.url が設定されていません")
    if not terms.strip():
        raise ConfigError("検索語を指定してください")
    if re.search(r"\bcontent\s*:", terms, re.IGNORECASE):
        raise ConfigError("Everything の content: は使えません (遅く、対象を絞れないため)。中身の検索は content コマンドを使ってください")
    scope = resolve_scope(config, folder)
    limit = min(limit or config.limits["max_results"], config.limits["max_results"])
    exts = exts or []
    headers: dict[str, str] = {}
    if config.everything_user:
        password = config.everything_password
        if not password:
            raise ConfigError(f"環境変数 {config.everything_password_env} に、Everything のパスワードを設定してください")
        headers["Authorization"] = "Basic " + base64.b64encode(f"{config.everything_user}:{password}".encode("utf-8")).decode("ascii")

    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    dropped = 0
    for root in scope:
        if len(items) >= limit:
            break
        parts = []
        if kind == "file":
            parts.append("file:")
        elif kind == "folder":
            parts.append("folder:")
        if exts:
            parts.append("ext:" + ";".join(exts))
        parts.append(f'"{to_windows(root)}\\"')  # このフォルダの下に絞る (結果は下で、文字列でも検査する)
        parts.append(terms)
        params = {
            "search": " ".join(parts), "json": "1", "path_column": "1", "size_column": "1",
            "date_modified_column": "1", "count": str(min(limit * 3, 300)), "sort": "date_modified", "ascending": "0",  # 新しい順
        }
        data = http_json(f"{config.everything_url}/?{urllib.parse.urlencode(params)}", headers=headers, timeout=config.limits["timeout_sec"])
        for entry in data.get("results", []):
            name = str(entry.get("name", ""))
            directory = str(entry.get("path", ""))
            full = norm_path(f"{directory}/{name}" if directory else name)
            key = full.casefold()
            if not full or key in seen or not under_any(full, scope) or is_excluded(full, config.exclude):
                dropped += 1
                continue
            seen.add(key)
            is_folder = str(entry.get("type", "")).casefold() == "folder"
            items.append({
                "path": full, "kind": "folder" if is_folder else "file", "modified": filetime_to_text(entry.get("date_modified")),
                "size": "" if is_folder else human_size(entry.get("size")),
            })
            if len(items) >= limit:
                break
    return {"terms": terms, "scope": scope, "items": items, "dropped": dropped, "total_hint": data.get("totalResults") if scope else None}


# ---------------------------------------------------------------------------
# 見つけたファイルを読む (テキストだけ。roots の中だけ)
# ---------------------------------------------------------------------------

READ_MAX_BYTES = 2_000_000
READ_MAX_FILES = 5
CONVERT_EXTS = {"docx", "docm", "xlsx", "xlsm", "pptx", "pptm", "pdf", "doc", "xls", "ppt"}
SECRET_PATTERNS = [".env", ".env.*", "*.pem", "*.key", "*.pfx", "*.p12", "id_rsa*", "id_ed25519*", "credentials*", "*.kdbx"]


def read_text(config: Config, raw_path: str, max_chars: int = 12000, from_line: int = 1) -> dict[str, Any]:
    """roots の中のテキストのファイルを、行番号つきで読む。読み取りだけ。

    作業フォルダの外のファイルを、検索の続きで (許可の確認なしに) 読めるようにするためのもの。
    roots の外、除外のパターン、認証情報らしい名前、テキストでないファイルは拒否する。
    """
    path = norm_path(os.path.abspath(raw_path))
    if not under_any(path, config.roots):
        raise ConfigError(f"'{raw_path}' は、検索してよいフォルダ (roots) の外です。対象: {', '.join(config.roots)}")
    if is_excluded(path, config.exclude):
        raise ConfigError(f"'{raw_path}' は、設定の除外 (exclude) に当たるので読めません")
    name = posixpath.basename(path).casefold()
    if any(fnmatch.fnmatchcase(name, pattern) for pattern in SECRET_PATTERNS) and name != ".env.example":
        raise ConfigError(f"'{raw_path}' は、認証情報のファイルらしいので読めません")
    ext = normalize_ext(posixpath.splitext(path)[1])
    if ext in CONVERT_EXTS:
        raise ConfigError(f"'{raw_path}' は、Word・Excel・PowerPoint・PDF です。スキル doc-convert で変換してから読んでください")
    real = norm_path(os.path.realpath(path))
    if not under_any(real, [norm_path(os.path.realpath(root)) for root in config.roots]):
        raise ConfigError(f"'{raw_path}' は、リンクの先が roots の外なので読めません")
    try:
        with open(real, "rb") as handle:
            data = handle.read(READ_MAX_BYTES + 1)
    except IsADirectoryError as exc:
        raise ConfigError(f"'{raw_path}' はフォルダです。ファイルを指定してください") from exc
    except OSError as exc:
        raise ConfigError(f"'{raw_path}' を読めません ({exc.strerror or exc})") from exc
    cut_bytes = len(data) > READ_MAX_BYTES
    data = data[:READ_MAX_BYTES]
    if b"\x00" in data:
        raise ConfigError(f"'{raw_path}' は、テキストのファイルではありません")
    for encoding in ("utf-8-sig", "cp932"):
        try:
            text = data.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        text = data.decode("utf-8", "replace")
    lines = text.splitlines()
    start = max(1, from_line)
    shown: list[str] = []
    used = 0
    for number in range(start, len(lines) + 1):
        line = lines[number - 1]
        if shown and used + len(line) > max_chars:
            break
        shown.append(f"{number}: {line[:max_chars]}")
        used += len(line) + 1
    last = start + len(shown) - 1
    return {
        "path": path, "ai": ai_note_status(real), "total_lines": len(lines), "first": start, "last": last, "lines": shown,
        "next_line": last + 1 if last < len(lines) else None, "cut_bytes": cut_bytes,
    }


def check_backends(config: Config) -> list[tuple[str, bool, str]]:
    """2 つのサーバーに、接続できるかを確かめる。(名前, 成功, 説明) の一覧。"""
    results: list[tuple[str, bool, str]] = []
    if config.fulltext_url:
        try:
            http_json(f"{config.fulltext_url}/api/health", timeout=config.limits["timeout_sec"])
            results.append(("Local-fulltext-search", True, config.fulltext_url))
        except BackendError as exc:
            results.append(("Local-fulltext-search", False, str(exc)))
    if config.everything_url:
        try:
            everything_search(config, "a", limit=1)
            results.append(("Everything", True, config.everything_url))
        except (BackendError, ConfigError) as exc:
            results.append(("Everything", False, str(exc)))
    return results
