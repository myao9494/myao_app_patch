"""Obsidian のコマンド (プラグインが登録したものを含む) を、許可リストにあるものだけ実行する (スキル obsidian-run から呼ぶ)。

  check    : Obsidian (Local REST API プラグイン) への接続と、設定の確認
  list     : 許可したコマンドの一覧 (設定ファイルの内容)
  commands : Obsidian にある全コマンドの ID を探す (実行はできない。許可リストに足す ID を見つけるため)
  run      : 許可したコマンドを 1 つ実行し、監視するフォルダの変化 (新規・更新・削除) を報告する
  open     : Vault にある (既にある) ノートを、Obsidian の画面で開く。許可リストは要らない (開くだけで、ファイルは変えない)

Local REST API は、コマンドの実行結果を返さない (成功したかどうかだけ)。そのため、コマンドの前後で
Vault のフォルダを比べて、できたファイルを知らせる。結果の中身は、あとで人が (または別のエージェントが) ファイルとして読む。

使うのは GET / と GET /commands/ と POST /commands/<id>/ と POST /open/<パス> だけ。接続先は自分の PC (127.0.0.1 など) に限る。
POST /open/ は、無いパスを渡すと Obsidian が新しいノートを作る。そのため、ここで実在を確かめたファイルだけを渡す。
API キーは環境変数から読み、設定ファイルにも画面にも出さない。
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import ssl
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, TextIO

SKILL_DIR = Path(__file__).resolve().parents[1]
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
ALIAS_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
COMMAND_ID_RE = re.compile(r"^[^\s/?#%]{1,200}$")
MAX_SNAPSHOT_FILES = 20000
SHOW_LIMIT = 30
# open で開いてよい種類 (Obsidian の画面で表示できるもの)。それ以外は、外部のアプリで開かれることがあるので扱わない
OPENABLE_SUFFIXES = {".md", ".canvas", ".base", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp",
                     ".mp3", ".wav", ".m4a", ".ogg", ".mp4", ".webm", ".mov", ".drawio"}
# 探さないフォルダ (ドットで始まるものに加えて)
SKIP_DIRS = {"node_modules", "__pycache__"}
# Obsidian のリンクとして読まれる文字。パスに入っていると、別のノートを開いたり、作ったりするおそれがある
LINK_SPECIAL = set("#^|[]")
CANDIDATE_LIMIT = 10
MAX_SCAN_FILES = 200000


class ConfigError(Exception):
    """利用者に見せてよいメッセージ。"""


class ApiError(Exception):
    pass


@dataclass
class CommandSpec:
    alias: str
    id: str
    description: str
    watch: list[str]
    settle_sec: float
    wait_sec: float


@dataclass
class Config:
    url: str
    key_env: str
    ca_file: str | None
    verify_tls: bool
    vault: Path
    commands: dict[str, CommandSpec] = field(default_factory=dict)
    timeout_sec: float = 10.0


# ---------------------------------------------------------------------------
# 設定
# ---------------------------------------------------------------------------

def load_config(path: Path | None = None) -> Config:
    path = path or SKILL_DIR / "config.local.json"
    if not path.is_file():
        raise ConfigError(f"設定ファイルがありません: {path}\nconfig.sample.json をコピーして config.local.json を作り、書き換えてください")
    try:
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise ConfigError(f"設定ファイルを読めません: {exc}") from exc
    if not isinstance(raw, dict):
        raise ConfigError("設定ファイルは、JSON のオブジェクトにしてください")
    api = raw.get("api", {})
    if not isinstance(api, dict):
        raise ConfigError("api は、オブジェクトにしてください")
    if "key" in api:
        raise ConfigError("API キーは、設定ファイルに書かないでください。環境変数に設定し、api.key_env にその名前を書きます")
    url = str(api.get("url", "https://127.0.0.1:27124")).rstrip("/")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ConfigError(f"api.url が正しくありません: {url}")
    if parsed.hostname not in LOOPBACK:
        raise ConfigError(f"api.url は、この PC の中 (127.0.0.1 / localhost) だけを指定できます: {parsed.hostname}。API キーを外へ送らないための制限です")
    ca_file = api.get("ca_file")
    if ca_file is not None and not (isinstance(ca_file, str) and Path(ca_file).is_file()):
        raise ConfigError(f"api.ca_file のファイルがありません: {ca_file}")
    verify_tls = api.get("verify_tls", True)
    if not isinstance(verify_tls, bool):
        raise ConfigError("api.verify_tls は true / false にしてください")
    key_env = str(api.get("key_env", "OBSIDIAN_API_KEY"))
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key_env):
        raise ConfigError(f"api.key_env が環境変数の名前として正しくありません: {key_env}")
    vault = Path(str(raw.get("vault", "")))
    if not str(raw.get("vault", "")).strip() or not vault.is_dir():
        raise ConfigError(f"vault のフォルダがありません: {raw.get('vault', '')!r}")
    if not (vault / ".obsidian").is_dir():
        raise ConfigError(f"vault に .obsidian フォルダがありません (Vault のルートを指定してください): {vault}")
    commands: dict[str, CommandSpec] = {}
    for alias, item in (raw.get("commands") or {}).items():
        if not ALIAS_RE.match(str(alias)):
            raise ConfigError(f"commands の名前は、英小文字・数字・ハイフンだけにしてください: {alias!r}")
        if not isinstance(item, dict) or not COMMAND_ID_RE.match(str(item.get("id", ""))):
            raise ConfigError(f"commands.{alias}.id が正しくありません")
        watch = item.get("watch", [])
        if not isinstance(watch, list) or not all(isinstance(w, str) for w in watch):
            raise ConfigError(f"commands.{alias}.watch は、フォルダ名の配列にしてください")
        settle, wait = item.get("settle_sec", 2), item.get("wait_sec", 15)
        if not (isinstance(settle, (int, float)) and 0 <= settle <= 60 and isinstance(wait, (int, float)) and 1 <= wait <= 300):
            raise ConfigError(f"commands.{alias} の settle_sec (0〜60) か wait_sec (1〜300) が正しくありません")
        commands[alias] = CommandSpec(alias, str(item["id"]), str(item.get("description", "")), [normalize_watch(vault, w, alias) for w in watch], float(settle), float(wait))
    return Config(url, key_env, ca_file, verify_tls, vault, commands)


def normalize_watch(vault: Path, watch: str, alias: str) -> str:
    """監視するフォルダ (Vault からの相対) を検査して、/ 区切りに直す。"""
    cleaned = watch.replace("\\", "/").strip("/")
    parts = [p for p in cleaned.split("/") if p and p != "."]
    if watch.strip() in ("", ".", "/") or not parts:
        return "."
    if ":" in watch or watch.startswith(("/", "\\")) or ".." in parts:
        raise ConfigError(f"commands.{alias}.watch は、Vault からの相対のフォルダにしてください: {watch!r}")
    resolved = (vault / Path(*parts)).resolve()
    if not is_within(resolved, vault.resolve()):
        raise ConfigError(f"commands.{alias}.watch が Vault の外を指しています: {watch!r}")
    return "/".join(parts)


def is_within(path: Path, root: Path) -> bool:
    path_s, root_s = os.path.normcase(str(path)), os.path.normcase(str(root))
    return path_s == root_s or path_s.startswith(root_s.rstrip("\\/") + os.sep)


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

class Api:
    """GET / と GET /commands/ と POST /commands/<id>/ と POST /open/<パス> だけを呼ぶ。"""

    def __init__(self, config: Config, key: str | None) -> None:
        self.config = config
        self.key = key
        self.context: ssl.SSLContext | None = None
        if config.url.startswith("https://"):
            if config.ca_file:
                self.context = ssl.create_default_context(cafile=config.ca_file)
            elif not config.verify_tls:
                self.context = ssl._create_unverified_context()  # noqa: S323 - 接続先は自分の PC に限っている
            else:
                self.context = ssl.create_default_context()

    def _call(self, method: str, path: str, auth: bool) -> tuple[int, bytes]:
        request = urllib.request.Request(self.config.url + path, method=method)
        if auth:
            if not self.key:
                raise ApiError(f"API キーがありません。環境変数 {self.config.key_env} に設定してください (Obsidian の設定 → Local REST API に表示されます)")
            request.add_header("Authorization", f"Bearer {self.key}")
        try:
            with urllib.request.urlopen(request, timeout=self.config.timeout_sec, context=self.context) as response:
                return response.status, response.read(2_000_000)
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read(10_000)
        except ssl.SSLError as exc:
            raise ApiError("TLS の検証に失敗しました。Local REST API の証明書 (CA) をダウンロードして api.ca_file に指定するか、プラグインの設定で HTTP を有効にして api.url を http://127.0.0.1:27123 にしてください") from exc
        except (urllib.error.URLError, OSError) as exc:
            reason = getattr(exc, "reason", exc)
            if isinstance(reason, ssl.SSLError):
                raise ApiError("TLS の検証に失敗しました。api.ca_file の指定か、HTTP への切り替えが必要です") from exc
            raise ApiError(f"Obsidian に接続できません ({reason})。Obsidian が起動していて、Local REST API プラグインが有効か、URL とポートが合っているか確認してください") from exc

    def status(self) -> dict[str, Any]:
        code, body = self._call("GET", "/", auth=False)
        if code != 200:
            raise ApiError(f"GET / が {code} を返しました")
        try:
            data = json.loads(body)
        except ValueError as exc:
            raise ApiError("GET / の応答を読めません (Local REST API ではない相手かもしれません)") from exc
        return data if isinstance(data, dict) else {}

    def list_commands(self) -> list[dict[str, str]]:
        code, body = self._call("GET", "/commands/", auth=True)
        if code in (401, 403):
            raise ApiError("API キーが正しくありません (401/403)。環境変数の値を確認してください")
        if code != 200:
            raise ApiError(f"GET /commands/ が {code} を返しました")
        try:
            items = json.loads(body)["commands"]
            return [{"id": str(i["id"]), "name": str(i.get("name", ""))} for i in items]
        except (ValueError, KeyError, TypeError) as exc:
            raise ApiError("コマンド一覧の応答を読めません") from exc

    def execute(self, command_id: str) -> int:
        code, _ = self._call("POST", "/commands/" + urllib.parse.quote(command_id, safe=":") + "/", auth=True)
        if code in (401, 403):
            raise ApiError("API キーが正しくありません (401/403)")
        if code == 404:
            raise ApiError(f"Obsidian に、そのコマンドがありません: {command_id}")
        if code not in (200, 204):
            raise ApiError(f"コマンドの実行が {code} を返しました")
        return code

    def open_file(self, rel_path: str, new_tab: bool) -> int:
        """rel_path は、resolve_note で実在を確かめた、Vault からの相対パス (/ 区切り)。"""
        code, _ = self._call("POST", "/open/" + urllib.parse.quote(rel_path, safe="/") + ("?newLeaf=true" if new_tab else ""), auth=True)
        if code in (401, 403):
            raise ApiError("API キーが正しくありません (401/403)")
        if code == 404:
            raise ApiError("この版の Local REST API には、ノートを開く機能 (POST /open/) がありません")
        if code not in (200, 204):
            raise ApiError(f"ノートを開く操作が {code} を返しました")
        return code


# ---------------------------------------------------------------------------
# 前後の比較
# ---------------------------------------------------------------------------

Snapshot = dict[str, tuple[int, int]]  # Vault からの相対パス → (更新時刻 ns, サイズ)


def take_snapshot(vault: Path, watch: list[str]) -> Snapshot:
    result: Snapshot = {}
    for entry in watch:
        base = vault if entry == "." else vault / entry
        if not base.is_dir():
            continue
        for directory, dirnames, filenames in os.walk(base, followlinks=False):
            dirnames[:] = [d for d in dirnames if not d.startswith(".") and not (Path(directory) / d).is_symlink()]
            for name in filenames:
                if name.startswith(".") or fnmatch.fnmatch(name, "~$*"):
                    continue
                path = Path(directory) / name
                try:
                    info = path.lstat()
                except OSError:
                    continue
                if path.is_symlink():
                    continue
                result[path.relative_to(vault).as_posix()] = (info.st_mtime_ns, info.st_size)
                if len(result) > MAX_SNAPSHOT_FILES:
                    raise ConfigError(f"監視するフォルダのファイルが {MAX_SNAPSHOT_FILES} 個を超えました。watch をもっと狭くしてください")
    return result


def diff(before: Snapshot, after: Snapshot) -> dict[str, list[str]]:
    return {
        "新規": sorted(p for p in after if p not in before),
        "更新": sorted(p for p in after if p in before and after[p] != before[p]),
        "削除": sorted(p for p in before if p not in after),
    }


def human_size(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB"):
        if value < 1024:
            return f"{int(value)} B" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} GB"


def wait_for_changes(vault: Path, spec: CommandSpec, before: Snapshot, clock: Callable[[], float], sleep: Callable[[float], None], poll: float = 0.5) -> tuple[Snapshot, float]:
    """最初の変化を spec.wait_sec まで待ち、変化が出たあとは spec.settle_sec の間、変化が止まるまで待つ。"""
    start = clock()
    last = before
    changed_at: float | None = None
    while True:
        sleep(poll)
        now = clock()
        current = take_snapshot(vault, spec.watch)
        if current != last:
            changed_at = now
            last = current
        elapsed = now - start
        if changed_at is not None and now - changed_at >= spec.settle_sec:
            return last, elapsed
        if changed_at is None and elapsed >= spec.wait_sec:
            return last, elapsed
        if elapsed >= spec.wait_sec + 120:  # 変化が止まらないときの上限
            return last, elapsed


# ---------------------------------------------------------------------------
# サブコマンド
# ---------------------------------------------------------------------------

def get_key(config: Config) -> str | None:
    value = os.environ.get(config.key_env, "").strip()
    return value or None


def cmd_check(config: Config, api: Api, out: TextIO) -> int:
    out.write(f"設定: OK (vault: {config.vault} / 接続先: {config.url} / 許可したコマンド: {len(config.commands)} 個)\n")
    status = api.status()
    manifest = status.get("manifest") if isinstance(status.get("manifest"), dict) else {}
    version = f" (プラグイン {manifest['version']})" if manifest.get("version") else ""
    out.write(f"Local REST API: 接続OK{version}\n")
    if not api.key:
        out.write(f"API キー: 環境変数 {config.key_env} が未設定です\n")
        return 3
    available = {c["id"] for c in api.list_commands()}
    out.write(f"API キー: OK (Obsidian のコマンド {len(available)} 個)\n")
    bad = 0
    for spec in config.commands.values():
        ok = spec.id in available
        bad += 0 if ok else 1
        out.write(f"  {spec.alias}: {'Obsidian にあります' if ok else 'Obsidian にありません → id を確認'} ({spec.id})\n")
    return 3 if bad else 0


def cmd_list(config: Config, out: TextIO) -> int:
    if not config.commands:
        out.write("許可したコマンドはありません (config.local.json の commands に書く)\n")
        return 0
    for spec in config.commands.values():
        watch = ", ".join(spec.watch) if spec.watch else "(監視なし)"
        out.write(f"{spec.alias}: {spec.description or '(説明なし)'}\n    id: {spec.id} / 結果を探す場所: {watch}\n")
    return 0


def cmd_commands(config: Config, api: Api, grep: str | None, limit: int, out: TextIO) -> int:
    commands = api.list_commands()
    allowed = {s.id: s.alias for s in config.commands.values()}
    words = [w.lower() for w in (grep or "").split()]
    hits = [c for c in commands if all(w in (c["id"] + " " + c["name"]).lower() for w in words)]
    out.write(f"Obsidian のコマンド: 全部で {len(commands)} 個 / 該当 {len(hits)} 個" + (f" ('{grep}')" if grep else "") + "\n")
    for command in hits[:limit]:
        mark = f"  ← 許可済み ({allowed[command['id']]})" if command["id"] in allowed else ""
        out.write(f"  {command['id']} | {command['name']}{mark}\n")
    if len(hits) > limit:
        out.write(f"  … ほか {len(hits) - limit} 個 (語を足して絞る)\n")
    out.write("これらは一覧です。実行できるのは、config.local.json の commands に書いたものだけです\n")
    return 0


def cmd_run(config: Config, api: Api, alias: str, dry_run: bool, out: TextIO, clock: Callable[[], float], sleep: Callable[[float], None]) -> int:
    spec = config.commands.get(alias)
    if spec is None:
        names = ", ".join(config.commands) or "(なし)"
        raise ConfigError(f"'{alias}' は、許可したコマンドにありません。許可したもの: {names}。許可は人間が config.local.json に書きます。回避しないでください")
    if dry_run:
        out.write(f"[試行] 実行するコマンド: {spec.alias} ({spec.id})\n")
        out.write(f"  {spec.description or '(説明なし)'}\n  結果を探す場所: {', '.join(spec.watch) or '(監視なし)'}\n実際には何も実行していません\n")
        return 0
    available = {c["id"] for c in api.list_commands()}
    if spec.id not in available:
        raise ApiError(f"Obsidian に、そのコマンドがありません: {spec.id} (プラグインが無効か、id が違います)")
    before = take_snapshot(config.vault, spec.watch)
    api.execute(spec.id)
    out.write(f"実行しました: {spec.alias} ({spec.id})\n")
    if not spec.watch:
        out.write("結果の検出: 監視するフォルダが未設定です。結果の場所は、人に確認してください\n")
        return 0
    after, elapsed = wait_for_changes(config.vault, spec, before, clock, sleep)
    changes = diff(before, after)
    total = sum(len(v) for v in changes.values())
    if not total:
        out.write(f"変化: 検出できませんでした ({elapsed:.0f} 秒待ちました)。コマンドがファイルを作らない、時間がかかっている、結果が監視の外に出ている、対象のノートが開かれていない、のどれかの可能性があります。成功とは言い切れません\n")
        return 0
    out.write(f"変化: {total} 件 ({elapsed:.1f} 秒) — 中身は、あとでファイルとして読む\n")
    shown = 0
    for label, paths in changes.items():
        for path in paths:
            if shown >= SHOW_LIMIT:
                break
            size = f" ({human_size(after[path][1])})" if path in after else ""
            out.write(f"  {label}: {path}{size}\n")
            shown += 1
    if total > SHOW_LIMIT:
        out.write(f"  … ほか {total - SHOW_LIMIT} 件\n")
    return 0


def _norm(text: str) -> str:
    """比べるための形 (Mac のファイル名の濁点の分解、全角半角でない大文字小文字の違いをそろえる)。"""
    return unicodedata.normalize("NFC", text).casefold()


def iter_vault_files(vault: Path) -> list[str]:
    """Vault のファイル (Vault からの相対、/ 区切り)。ドットで始まる場所、node_modules、シンボリックリンクは除く。"""
    result: list[str] = []
    for directory, dirnames, filenames in os.walk(vault, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d not in SKIP_DIRS and not (Path(directory) / d).is_symlink())
        for name in sorted(filenames):
            if name.startswith(".") or (Path(directory) / name).is_symlink():
                continue
            result.append((Path(directory) / name).relative_to(vault).as_posix())
            if len(result) > MAX_SCAN_FILES:
                raise ConfigError(f"Vault のファイルが {MAX_SCAN_FILES} 個を超えました。フォルダつきのパスで指定してください")
    return result


def clean_target(target: str, vault: Path) -> str:
    """[[ノート名|別名]]、[[ノート名#見出し]]、\\ 区切り、Vault の中の絶対パスを、Vault からの相対の形にする。"""
    text = target.strip().strip('"').strip("'").strip()
    if text.startswith("![["):
        text = text[1:]
    if text.startswith("[[") and text.endswith("]]"):
        text = text[2:-2]
        text = re.split(r"[|#^]", text, maxsplit=1)[0]  # 別名・見出し・ブロックは捨てる (ノートの先頭を開く)
    text = text.strip()
    if not text:
        raise ConfigError("開くノートを指定してください (ノート名、Vault からのパス、[[ノート名]] のどれか)")
    path = Path(text)
    if path.is_absolute() or re.match(r"^[A-Za-z]:", text):
        root = vault.resolve()
        resolved = path.resolve()
        if not is_within(resolved, root):
            raise ConfigError(f"Vault の外のファイルは開けません: {text}")
        text = resolved.relative_to(root).as_posix()
    parts = [p for p in text.replace("\\", "/").split("/") if p not in ("", ".")]
    if ".." in parts:
        raise ConfigError(f"'..' を含むパスは使えません: {text}")
    if any(p.startswith(".") for p in parts):
        raise ConfigError(f"ドットで始まる場所 (.obsidian など) は開けません: {text}")
    if not parts:
        raise ConfigError("開くノートを指定してください")
    return "/".join(parts)


def find_notes(files: list[str], key: str) -> list[str]:
    """ノート名 (拡張子なしでもよい) か、Vault からのパス (途中からでもよい) に合うファイル。完全に合うものがあれば、それだけ。"""
    wanted = {_norm(key), _norm(key + ".md")}
    hits = [f for f in files if _norm(f) in wanted or any(_norm(f).endswith("/" + w) for w in wanted)]
    exact = [f for f in hits if _norm(f) in wanted]
    return exact or hits


def link_form(rel: str, files: list[str]) -> str:
    """Obsidian のリンクの形。同じ名前のファイルが他にもあれば、フォルダつきにする。"""
    name = rel.rsplit("/", 1)[-1]
    same = [f for f in files if _norm(f.rsplit("/", 1)[-1]) == _norm(name)]
    text = rel if len(same) > 1 else name
    if text.lower().endswith(".md"):
        text = text[:-3]
    return f"[[{text}]]"


def cmd_open(config: Config, api: Api, target: str, new_tab: bool, dry_run: bool, out: TextIO) -> int:
    key = clean_target(target, config.vault)
    files = iter_vault_files(config.vault)
    hits = find_notes(files, key)
    if not hits:
        raise ConfigError(f"Vault に見つかりません: {target}。開くだけなので、ノートは作りません。名前を確かめるか、探してから (vault-notes の related など)、パスで指定してください")
    if len(hits) > 1:
        out.write(f"候補が {len(hits)} 個あります。開いていません。どれかをパスで指定し直してください:\n")
        for rel in hits[:CANDIDATE_LIMIT]:
            out.write(f"  {rel}  {link_form(rel, files)}\n")
        if len(hits) > CANDIDATE_LIMIT:
            out.write(f"  … ほか {len(hits) - CANDIDATE_LIMIT} 個 (フォルダを足して絞る)\n")
        return 2
    rel = hits[0]
    if Path(rel).suffix.lower() not in OPENABLE_SUFFIXES:
        raise ConfigError(f"この種類のファイルは、Obsidian で開く対象にしていません: {rel}")
    if LINK_SPECIAL & set(rel):
        raise ConfigError(f"名前に # ^ | [ ] のどれかが入っていて、Obsidian が別のノートとして読むおそれがあるので、開きません: {rel}。人が Obsidian で開いてください")
    resolved = (config.vault / rel).resolve()
    if not (is_within(resolved, config.vault.resolve()) and resolved.is_file()):
        raise ConfigError(f"Vault の中のファイルとして確かめられませんでした: {rel}")
    link = link_form(rel, files)
    where = "新しいタブ" if new_tab else "いまのタブ"
    if dry_run:
        out.write(f"[試行] 開くノート: {rel} ({where})\n  リンク: {link}\n実際には開いていません\n")
        return 0
    api.open_file(rel, new_tab)
    out.write(f"開きました: {rel} ({where})\n  リンク: {link}\n")
    out.write("  Obsidian は、画面に出たかどうかを返しません。出ていなければ、Obsidian の画面を確認してもらってください\n")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="obsidian_cli", description="Obsidian のコマンドを、許可リストにあるものだけ実行する")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check", help="接続と設定の確認")
    sub.add_parser("list", help="許可したコマンドの一覧")
    commands = sub.add_parser("commands", help="Obsidian の全コマンドの ID を探す (実行はできない)")
    commands.add_argument("--grep", help="絞り込む語 (スペースで AND)")
    commands.add_argument("--limit", type=int, default=40)
    run = sub.add_parser("run", help="許可したコマンドを実行する")
    run.add_argument("alias")
    run.add_argument("--dry-run", action="store_true", help="実行せずに、何をするかだけ表示する")
    open_ = sub.add_parser("open", help="Vault にあるノートを、Obsidian の画面で開く (無いノートは作らない)")
    open_.add_argument("note", help="ノート名 (拡張子なしでよい)、Vault からのパス、または [[ノート名]]")
    open_.add_argument("--new-tab", action="store_true", help="新しいタブで開く (既定は、いまのタブ)")
    open_.add_argument("--dry-run", action="store_true", help="開かずに、どのファイルを開くかだけ表示する")
    return parser


def main(argv: list[str] | None = None, stdout: TextIO | None = None, stderr: TextIO | None = None, config_path: Path | None = None,
         clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep) -> int:
    out = stdout or sys.stdout
    err = stderr or sys.stderr
    if stdout is None:
        for stream in (sys.stdout, sys.stderr):
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8")  # Windows の標準出力の文字化けを防ぐ
    args = build_parser().parse_args(argv)
    try:
        config = load_config(config_path)
        if args.command == "list":
            return cmd_list(config, out)
        if args.command == "run" and args.dry_run:
            return cmd_run(config, Api(config, None), args.alias, True, out, clock, sleep)
        if args.command == "open":
            return cmd_open(config, Api(config, None if args.dry_run else get_key(config)), args.note, args.new_tab, args.dry_run, out)
        api = Api(config, get_key(config))
        if args.command == "check":
            return cmd_check(config, api, out)
        if args.command == "commands":
            return cmd_commands(config, api, args.grep, max(1, min(args.limit, 200)), out)
        return cmd_run(config, api, args.alias, False, out, clock, sleep)
    except ConfigError as exc:
        err.write(f"エラー: {exc}\n")
        return 2
    except ApiError as exc:
        err.write(f"エラー: {exc}\n")
        return 3


if __name__ == "__main__":
    sys.exit(main())
