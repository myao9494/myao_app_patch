"""登場人物を覚えるための補助コマンド (スキル people から呼ぶ)。

  who        : 人物ノートの要点と、メールのキャッシュから集計したやり取りを、短く返す (読み取りだけ)
               who 名前・アドレス… / who --mail メールID (そのメールの全員) / who --self (自分)
  candidates : やり取りが多いのに人物ノートが無い人の一覧 (登録の候補。読み取りだけ)
  new        : 人物ノートを作る (05_people/氏名.md)。同じ氏名・同じアドレスがあれば作らない
  set        : 人物ノートの項目を直す・足す (所属、役割、関係、別名、アドレス、要点)
  memo       : 人物ノートの「やり取りのメモ」に、日付と出典つきで 1 行足す
  check      : 点検 (アドレスの重複、アドレスが無い、確かめた日が古い、未レビュー)

人が判断する情報は、Vault の人物ノート (Markdown) に置く。メールから分かる事実 (件数、最後の連絡、よく一緒の人、最近の件) は、
保存せず、outlook-mail のキャッシュ (SQLite) を読み取り専用で開いて、そのつど集計する。
AI が作ったノートは ai_generated: opencode / ai_reviewed: false。AI が直したノートは ai_edited を付け、ai_reviewed: false に戻す。
書き込むのは、Vault の人物ノートのフォルダーの中だけ。削除はしない。標準ライブラリだけで動く。
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import os
import re
import sqlite3
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import TextIO

SKILL_DIR = Path(__file__).resolve().parents[1]
DEFAULT_PEOPLE_DIR = "05_people"
RELATIONS = ("自分", "上司", "同僚", "社内", "客先", "協力会社", "その他")
STALE_DAYS = 180           # check で「確かめた日が古い」とする日数
WHO_MAX_PEOPLE = 10        # who で一度に返す人数の上限 (窓が狭いモデルのため)
POINTS_SHOWN = 5           # who で見せる要点の行数
MEMOS_SHOWN = 3            # who で見せる、最近のメモの行数
THREADS_SHOWN = 3          # who で見せる、最近の件の数
RESERVED = {"CON", "PRN", "AUX", "NUL"} | {f"COM{i}" for i in range(1, 10)} | {f"LPT{i}" for i in range(1, 10)}
POINT_HEADING = "## 要点"
MEMO_HEADING = "## やり取りのメモ"
# 書かないもの (電話番号、郵便番号・住所) の簡単な検査。完全ではないので、人のレビューで補う
FORBIDDEN = [
    (re.compile(r"(?<!\d)0\d{1,4}[-(（ ]\d{1,4}[-)） ]\d{3,4}(?!\d)"), "電話番号"),
    (re.compile(r"(?<!\d)0[789]0\d{8}(?!\d)"), "電話番号"),
    (re.compile(r"〒|(?<!\d)\d{3}-\d{4}(?!\d)"), "郵便番号・住所"),
]


class PeopleError(Exception):
    """利用者に見せてよいメッセージ。"""


# ---------------------------------------------------------------------------
# 設定と場所
# ---------------------------------------------------------------------------

def load_config(config_path: Path | None) -> dict:
    path = config_path or SKILL_DIR / "config.local.json"
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise PeopleError(f"設定ファイルを読めません: {exc}") from exc
    if not isinstance(data, dict):
        raise PeopleError("設定ファイルの形が違います ({ \"vault\": \"...\" } の形にする)")
    return data


def find_vault(config: dict, cwd: Path) -> Path:
    """Vault の場所: 環境変数 OPENCODE_VAULT → 設定の vault → いまのフォルダーから上へたどって .obsidian のあるフォルダー。"""
    for raw in (os.environ.get("OPENCODE_VAULT"), config.get("vault")):
        if raw:
            vault = Path(str(raw)).expanduser()
            if not (vault / ".obsidian").is_dir():
                raise PeopleError(f"指定された Vault に .obsidian がありません: {vault}")
            return vault.resolve()
    current = cwd.resolve()
    for candidate in [current, *current.parents]:
        if (candidate / ".obsidian").is_dir():
            return candidate
    raise PeopleError("Vault が見つかりません。スキルのフォルダーの config.local.json に {\"vault\": \"Vault のフォルダー\"} を書くか、Vault の中で実行してください")


def people_folder(vault: Path, config: dict) -> Path:
    relative = str(config.get("people_dir") or DEFAULT_PEOPLE_DIR).replace("\\", "/")
    parts = [p for p in relative.split("/") if p and p != "."]
    if not parts or relative.startswith("/") or ":" in relative or ".." in parts or any(p.startswith(".") for p in parts):
        raise PeopleError(f"people_dir が正しくありません: {relative!r} (Vault からの相対。ドットで始まる場所は使えない)")
    return vault / Path(*parts)


def mail_cache_path() -> Path:
    """outlook-mail のキャッシュの場所 (outlook_cache.cache_db_path と同じ決め方。変えたら両方を直す)。"""
    override = os.environ.get("OPENCODE_OUTLOOK_MAILCACHE")
    if override:
        return Path(override)
    base = os.environ.get("LOCALAPPDATA")
    root = Path(base) if base else Path.home() / ".cache"
    return root / "opencode-harness" / "outlook-mail-cache.sqlite3"


# ---------------------------------------------------------------------------
# 照合用の文字列
# ---------------------------------------------------------------------------

def norm_key(text: str) -> str:
    """照合用: NFKC (全角・半角)、小文字、空白と引用符を除く。"""
    return re.sub(r"[\s'\"「」]", "", unicodedata.normalize("NFKC", text or "").casefold())


def name_variants(display: str) -> set[str]:
    """表示名の言い換え: そのまま、括弧の中を除いたもの、/ の前 (山田 太郎/設計部 のような社内の表示名)。"""
    base = unicodedata.normalize("NFKC", display or "").strip().strip("'\"")
    variants = {base, re.sub(r"\([^)]*\)", "", base), re.split(r"[/／]", base)[0], re.sub(r"<[^>]*>", "", base)}
    angle = re.search(r"<([^>]+@[^>]+)>", base)
    if angle:
        variants.add(angle.group(1))
    return {norm_key(v) for v in variants if norm_key(v)}


def split_people(field_text: str) -> list[str]:
    """Outlook の To・CC の文字列 (「山田 太郎; 鈴木 花子」) を、1 人ずつに分ける。"""
    return [p.strip() for p in re.split(r"[;；]", field_text or "") if p.strip()]


def check_forbidden(*texts: str) -> None:
    for text in texts:
        for pattern, label in FORBIDDEN:
            if text and pattern.search(text):
                raise PeopleError(f"{label}のような文字列は、人物ノートに書きません: {text!r}")


# ---------------------------------------------------------------------------
# frontmatter (人物ノートで使う形だけを読む・書く。知らない項目は、元の行のまま残す)
# ---------------------------------------------------------------------------

LIST_KEYS = ("tags", "aliases", "emails")


def split_note(text: str) -> tuple[list[str], str]:
    """(frontmatter の行, 本文)。frontmatter が無ければ ([], 全文)。"""
    text = text.lstrip("﻿")
    if not text.startswith("---"):
        return [], text
    lines = text.split("\n")
    for number in range(1, len(lines)):
        if lines[number].rstrip("\r") == "---":
            return [l.rstrip("\r") for l in lines[1:number]], "\n".join(lines[number + 1:])
    return [], text


def front_blocks(lines: list[str]) -> list[tuple[str | None, list[str]]]:
    """frontmatter を、項目ごとの (キー, 行) に分ける。キーの無い行 (コメントなど) は (None, [行])。"""
    blocks: list[tuple[str | None, list[str]]] = []
    for line in lines:
        match = re.match(r"([A-Za-z_][\w-]*):(\s|$)", line)
        if match:
            blocks.append((match.group(1), [line]))
        elif blocks and blocks[-1][0] is not None and (line.startswith((" ", "\t")) or not line.strip()):
            blocks[-1][1].append(line)
        else:
            blocks.append((None, [line]))
    return blocks


def unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        return value[1:-1]
    return value


def block_value(lines: list[str]) -> str | list[str]:
    first = lines[0].split(":", 1)[1].strip()
    if first.startswith("[") and first.endswith("]"):
        return [unquote(v) for v in first[1:-1].split(",") if v.strip()]
    items = [re.match(r"\s*-\s+(.*)$", l) for l in lines[1:] if l.strip()]
    if not first and items and all(items):
        return [unquote(m.group(1)) for m in items if m]
    if not first and not any(l.strip() for l in lines[1:]):
        return ""
    if first and not any(l.strip() for l in lines[1:]):
        return unquote(first)
    return "\x00complex"  # 入れ子など、ここでは扱わない形


def parse_front(lines: list[str]) -> dict[str, str | list[str]]:
    return {key: block_value(body) for key, body in front_blocks(lines) if key}


def yaml_scalar(value: str) -> str:
    if value == "" or re.search(r"^[\s\[\]{}>|*&!%@`#,?:-]|:\s|\s#|\s$", value) or value.lower() in ("true", "false", "yes", "no", "null", "~"):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return value


def render_block(key: str, value: str | list[str]) -> list[str]:
    if isinstance(value, list):
        return [f"{key}:"] + [f"  - {yaml_scalar(v)}" for v in value]
    if key in ("ai_reviewed", "self") and value in ("true", "false"):
        return [f"{key}: {value}"]
    if key in ("created", "checked", "ai_edited") and re.fullmatch(r"\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?", value):
        return [f"{key}: {value}"]
    return [f"{key}: {yaml_scalar(value)}"]


def update_front(lines: list[str], values: dict[str, str | list[str]]) -> list[str]:
    """指定の項目だけを書き直し、ほかの行はそのまま残す。無い項目は末尾に足す。"""
    blocks = front_blocks(lines)
    for key, body in blocks:
        if key in values and block_value(body) == "\x00complex":
            raise PeopleError(f"frontmatter の {key} が、自動では直せない形です。人が直してください")
    out: list[str] = []
    done = set()
    for key, body in blocks:
        if key in values and key not in done:
            out += render_block(key, values[key])
            done.add(key)
        elif key in values:
            continue  # 同じキーが 2 回あるときは、1 つにまとめる
        else:
            out += body
    for key, value in values.items():
        if key not in done:
            out += render_block(key, value)
    return out


def join_note(front: list[str], body: str) -> str:
    return "\n".join(["---", *front, "---"]) + "\n" + body  # 本文は、元のまま (新しいノートは、空行から始まる)


# ---------------------------------------------------------------------------
# 人物ノート
# ---------------------------------------------------------------------------

@dataclass
class Person:
    path: Path
    name: str
    front: dict[str, str | list[str]]
    body: str
    keys: set[str] = field(default_factory=set)

    def text(self, key: str) -> str:
        value = self.front.get(key, "")
        return value if isinstance(value, str) and value != "\x00complex" else ""

    def items(self, key: str) -> list[str]:
        value = self.front.get(key, [])
        if isinstance(value, list):
            return value
        return [value] if value and value != "\x00complex" else []

    @property
    def is_self(self) -> bool:
        return self.text("self").lower() in ("true", "yes") or self.text("relation") == "自分"

    @property
    def status(self) -> str:
        """'unreviewed' (AI が作り、人が未確認。根拠にしない) / 'edited' (AI が直し、人が未確認) / 'ok'。"""
        reviewed = self.text("ai_reviewed").lower() in ("true", "yes")
        if reviewed:
            return "ok"
        if self.text("ai_generated"):
            return "unreviewed"
        if self.text("ai_edited"):
            return "edited"
        return "ok"

    def section(self, heading: str) -> list[str]:
        lines = self.body.split("\n")
        try:
            start = next(i for i, l in enumerate(lines) if l.strip() == heading)
        except StopIteration:
            return []
        items = []
        for line in lines[start + 1:]:
            if line.startswith("## "):
                break
            if line.strip().startswith("- "):
                items.append(line.strip()[2:].strip())
        return items


def load_people(folder: Path) -> list[Person]:
    people = []
    if not folder.is_dir():
        return people
    for path in sorted(folder.rglob("*.md")):
        if any(p.startswith(".") for p in path.relative_to(folder).parts):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        lines, body = split_note(text)
        front = parse_front(lines)
        name = front.get("name") if isinstance(front.get("name"), str) and front.get("name") != "\x00complex" else ""
        person = Person(path, str(name or path.stem), front, body)
        person.keys = {norm_key(person.name)} | {norm_key(a) for a in person.items("aliases")} | {norm_key(e) for e in person.items("emails")}
        person.keys.discard("")
        people.append(person)
    return people


def safe_file_name(name: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f#^\[\]\s]', "", unicodedata.normalize("NFKC", name)).strip(".")[:60]
    if not cleaned:
        raise PeopleError("氏名が空です (使えない文字だけの氏名は使えません)")
    if cleaned.split(".")[0].upper() in RESERVED:
        cleaned = "_" + cleaned
    return cleaned


def find_person(people: list[Person], query: str) -> Person:
    """氏名・別名・アドレスが一致する 1 人 (書き込み用。あいまいなら止める)。"""
    key = norm_key(query)
    exact = [p for p in people if key in p.keys or norm_key(p.path.stem) == key]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise PeopleError(f"{query!r} に合う人が {len(exact)} 人います: " + ", ".join(p.name for p in exact) + " (氏名かアドレスで指定する)")
    raise PeopleError(f"{query!r} の人物ノートがありません (先に new で作る)")


def stamp(now: dt.datetime) -> str:
    return now.strftime("%Y-%m-%d %H:%M:%S")


def write_note(path: Path, text: str) -> None:
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def add_to_section(body: str, heading: str, line: str) -> str:
    """見出しの節の最後の箇条書きの後に 1 行足す。節が無ければ、本文の末尾に節を作る。"""
    lines = body.rstrip("\n").split("\n")
    try:
        start = next(i for i, l in enumerate(lines) if l.strip() == heading)
    except StopIteration:
        return body.rstrip("\n") + f"\n\n{heading}\n\n- {line}\n"
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if lines[i].startswith("## "):
            end = i
            break
    insert = end
    while insert > start + 1 and not lines[insert - 1].strip():
        insert -= 1
    if insert == start + 1:
        lines[insert:insert] = ["", f"- {line}"]
    else:
        lines[insert:insert] = [f"- {line}"]
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# メールのキャッシュの集計
# ---------------------------------------------------------------------------

@dataclass
class Party:
    display: str
    addr: str
    role: str  # 差出人 / 宛先 / CC

    @property
    def keys(self) -> set[str]:
        keys = name_variants(self.display)
        if self.addr:
            keys.add(norm_key(self.addr))
        return keys

    @property
    def label(self) -> str:
        return unicodedata.normalize("NFKC", self.display).strip().strip("'\"") or self.addr

    @property
    def group(self) -> str:
        """候補をまとめるキー (表示名。表示名が無ければアドレス)。"""
        return norm_key(re.sub(r"\([^)]*\)", "", unicodedata.normalize("NFKC", self.display))) or norm_key(self.addr)


@dataclass
class Mail:
    alias: str
    kind: str
    time: str
    subject: str
    thread: str
    parties: list[Party]


class MailCache:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.mails: list[Mail] = []
        self.error = ""
        self.self_keys: set[str] = set()
        self.entry_alias: dict[str, str] = {}
        if not path.is_file():
            self.error = f"メールのキャッシュがありません ({path})。集計は省きます (outlook-mail の cache-sync で作られる)"
            return
        try:
            db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
            try:
                rows = db.execute("SELECT alias, entry_id, kind, time, sender, sender_addr, recipients, cc, subject, thread FROM mails").fetchall()
            finally:
                db.close()
        except sqlite3.Error as exc:
            self.error = f"メールのキャッシュを読めません ({exc})。集計は省きます"
            return
        for alias, entry_id, kind, time, sender, sender_addr, recipients, cc, subject, thread in rows:
            parties = [Party(sender or "", sender_addr or "", "差出人")]
            parties += [Party(p, p if "@" in p and " " not in p else "", "宛先") for p in split_people(recipients)]
            parties += [Party(p, p if "@" in p and " " not in p else "", "CC") for p in split_people(cc)]
            self.mails.append(Mail(alias, kind, time, subject or "", thread or "", parties))
            self.entry_alias[entry_id] = alias
            if kind == "sent" and (sender or sender_addr):
                self.self_keys |= parties[0].keys  # 送信済みの差出人は自分
        self.mails.sort(key=lambda m: m.time, reverse=True)

    def span(self) -> str:
        if not self.mails:
            return "キャッシュは空"
        return f"キャッシュ {self.mails[-1].time[:10]}〜{self.mails[0].time[:10]}、{len(self.mails)} 通"

    def find(self, ref: str) -> Mail | None:
        ref = ref.strip()
        alias = self.entry_alias.get(ref, ref)
        return next((m for m in self.mails if m.alias == alias), None)


def is_self(party: Party, cache: MailCache, me: Person | None) -> bool:
    keys = party.keys
    return bool(keys & cache.self_keys) or bool(me and keys & me.keys)


def stats_lines(match_keys: set[str], cache: MailCache, me: Person | None) -> list[str]:
    if cache.error:
        return [f"メール: {cache.error}"]
    hits = [m for m in cache.mails if any(p.keys & match_keys for p in m.parties)]
    if not hits:
        return [f"メール: やり取りなし ({cache.span()})"]
    inbox = sum(1 for m in hits if m.kind == "inbox")
    sent = sum(1 for m in hits if m.kind == "sent")
    together: collections.Counter = collections.Counter()
    labels: dict[str, str] = {}
    for mail in hits:
        seen = set()
        for party in mail.parties:
            if party.keys & match_keys or is_self(party, cache, me) or party.group in seen:
                continue
            seen.add(party.group)
            together[party.group] += 1
            labels.setdefault(party.group, party.label)
    threads: dict[str, str] = {}  # 件 (RE: などを除いた件名) → 最新の件名。新しい順
    for mail in hits:
        if len(threads) >= THREADS_SHOWN:
            break
        threads.setdefault(mail.thread, mail.subject)
    lines = [f"メール: 受信 {inbox}・送信 {sent} / 最後 {hits[0].time[:10]} ({cache.span()})"]
    if together:
        lines.append("よく一緒に入る人: " + "、".join(f"{labels[k]} ({n})" for k, n in together.most_common(3)))
    lines.append("最近の件: " + " / ".join(threads.values()))
    return lines


def addresses_seen(match_keys: set[str], cache: MailCache) -> list[str]:
    found: list[str] = []
    for mail in cache.mails:
        for party in mail.parties:
            if party.addr and party.keys & match_keys and party.addr not in found:
                found.append(party.addr)
    return found


def addr_label(addr: str) -> str:
    if addr.lower().startswith("/o="):
        return "社内 (Exchange の形のアドレス)"
    return addr


# ---------------------------------------------------------------------------
# 表示
# ---------------------------------------------------------------------------

STATUS_NOTE = {
    "unreviewed": " [未レビュー: AI が作った。根拠にしない。手がかりとして示し、ユーザーに確かめる]",
    "edited": " [AI が直した・人が未確認]",
    "ok": "",
}


def person_block(person: Person, vault: Path, cache: MailCache, me: Person | None, role: str = "") -> list[str]:
    head = " / ".join(v for v in (person.text("relation"), person.text("role")) if v)
    lines = [f"## {person.name}" + (f" ({head})" if head else "") + (f" — {role}" if role else "") + STATUS_NOTE[person.status]]
    facts = []
    if person.text("org"):
        facts.append(f"所属: {person.text('org')}")
    if person.items("aliases"):
        facts.append("呼び方: " + "、".join(person.items("aliases")))
    if person.text("checked"):
        facts.append(f"確かめた日: {person.text('checked')}")
    if facts:
        lines.append("- " + " / ".join(facts))
    points = person.section(POINT_HEADING)
    for point in points[:POINTS_SHOWN]:
        lines.append(f"- 要点: {point}")
    if len(points) > POINTS_SHOWN:
        lines.append(f"- 要点は、ほか {len(points) - POINTS_SHOWN} 行 (ノートを読む)")
    for memo in person.section(MEMO_HEADING)[-MEMOS_SHOWN:]:
        lines.append(f"- メモ: {memo}")
    if not person.is_self:
        lines += [f"- {l}" for l in stats_lines(person.keys, cache, me)]
    lines.append(f"- ノート: {person.path.relative_to(vault).as_posix()}")
    return lines


def unregistered_block(party: Party, cache: MailCache, me: Person | None, role: str = "") -> list[str]:
    keys = party.keys
    lines = [f"## {party.label} (未登録)" + (f" — {role}" if role else "")]
    addrs = addresses_seen(keys, cache) or ([party.addr] if party.addr else [])
    if addrs:
        lines.append("- アドレス: " + "、".join(addr_label(a) for a in addrs[:3]))
    lines += [f"- {l}" for l in stats_lines(keys, cache, me)]
    return lines


def matching_people(people: list[Person], keys: set[str]) -> list[Person]:
    return [p for p in people if p.keys & keys]


def cmd_who(vault: Path, people: list[Person], cache: MailCache, queries: list[str], mail_ref: str | None, self_only: bool, out: TextIO) -> int:
    me_list = [p for p in people if p.is_self]
    me = me_list[0] if me_list else None
    blocks: list[list[str]] = []
    if self_only:
        if not me:
            out.write("自分の人物ノートがありません。/people で、自分のことのインタビューから始める (new 氏名 --self)\n")
            return 0
        out.write("\n".join(person_block(me, vault, cache, None)) + "\n")
        rest = [l for l in me.body.split("\n") if l.strip()]
        if rest:
            out.write("\n## 自分のノートの本文\n" + "\n".join(rest[:40]) + "\n")
        return 0
    if mail_ref:
        if cache.error:
            raise PeopleError(cache.error)
        mail = cache.find(mail_ref)
        if not mail:
            raise PeopleError(f"メール {mail_ref} がキャッシュにありません (cache-search で ID を確かめる)")
        out.write(f"メール {mail.alias} | {mail.time} | {mail.subject}\n\n")
        seen: set[str] = set()
        for party in mail.parties:
            if party.group in seen or not party.group:
                continue
            seen.add(party.group)
            if is_self(party, cache, me):
                blocks.append([f"## {party.label} — {party.role} (自分)"])
                continue
            found = matching_people(people, party.keys)
            if len(found) == 1:
                blocks.append(person_block(found[0], vault, cache, me, party.role))
            elif len(found) > 1:
                blocks.append([f"## {party.label} — {party.role} (判別できない: " + "、".join(p.name for p in found) + " のどれか。ノートの別名を見直す)"])
            else:
                blocks.append(unregistered_block(party, cache, me, party.role))
    for query in queries:
        key = norm_key(query)
        if not key:
            continue
        found = [p for p in people if any(key in k for k in p.keys) or key in norm_key(p.path.stem)]
        if found:
            blocks += [person_block(p, vault, cache, me) for p in found]
            continue
        parties: dict[str, Party] = {}
        for mail in cache.mails:
            for party in mail.parties:
                if party.group not in parties and any(key in k for k in party.keys) and not is_self(party, cache, me):
                    parties[party.group] = party
        if parties:
            blocks += [unregistered_block(p, cache, me) for p in list(parties.values())[:3]]
        else:
            blocks.append([f"## {query}: 人物ノートにも、メールのキャッシュにも見つかりません"])
    if not blocks:
        raise PeopleError("名前・アドレス、--mail、--self のどれかを指定してください")
    shown = blocks[:WHO_MAX_PEOPLE]
    out.write("\n\n".join("\n".join(b) for b in shown) + "\n")
    if len(blocks) > len(shown):
        out.write(f"\nほか {len(blocks) - len(shown)} 人 (名前を指定して引く)\n")
    return 0


def cmd_candidates(people: list[Person], cache: MailCache, since_days: int, minimum: int, limit: int, now: dt.datetime, out: TextIO) -> int:
    if cache.error:
        raise PeopleError(cache.error)
    me = next((p for p in people if p.is_self), None)
    since = stamp(now - dt.timedelta(days=since_days))
    counts: dict[str, dict] = {}
    for mail in cache.mails:
        if mail.time < since:
            continue
        seen = set()
        for party in mail.parties:
            group = party.group
            if not group or group in seen or is_self(party, cache, me) or matching_people(people, party.keys):
                continue
            seen.add(group)
            item = counts.setdefault(group, {"label": party.label, "inbox": 0, "sent": 0, "last": mail.time, "subjects": [], "addrs": []})
            item["inbox" if mail.kind == "inbox" else "sent"] += 1
            if party.addr and party.addr not in item["addrs"]:
                item["addrs"].append(party.addr)
            if mail.subject not in item["subjects"] and len(item["subjects"]) < 2:
                item["subjects"].append(mail.subject)
    rows = sorted((v for v in counts.values() if v["inbox"] + v["sent"] >= minimum), key=lambda v: (-(v["inbox"] + v["sent"]), v["label"]))
    out.write(f"未登録で、やり取りが {minimum} 通以上の人 (直近 {since_days} 日。{cache.span()}): {len(rows)} 人\n")
    if not me:
        out.write("※ 自分の人物ノートがまだありません。先に自分のインタビューをする (new 氏名 --self)\n")
    for item in rows[:limit]:
        addr = "、".join(addr_label(a) for a in item["addrs"][:2]) or "宛先・CC だけ (アドレス不明)"
        out.write(f"- {item['label']} | {addr} | 受信 {item['inbox']}・送信 {item['sent']} | 最後 {item['last'][:10]} | 件: {' / '.join(item['subjects'])}\n")
    if len(rows) > limit:
        out.write(f"- ほか {len(rows) - limit} 人 (--limit で増やす)\n")
    return 0


# ---------------------------------------------------------------------------
# 書き込み
# ---------------------------------------------------------------------------

def split_list(values: list[str] | None) -> list[str]:
    items: list[str] = []
    for value in values or []:
        for piece in re.split(r"[,、]", value):
            if piece.strip() and piece.strip() not in items:
                items.append(piece.strip())
    return items


def check_relation(relation: str | None) -> None:
    if relation and relation not in RELATIONS:
        raise PeopleError(f"relation は {' / '.join(RELATIONS)} のどれか: {relation!r}")


def cmd_new(folder: Path, vault: Path, people: list[Person], args: argparse.Namespace, now: dt.datetime, out: TextIO) -> int:
    name = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", args.name)).strip()
    emails, aliases, points = split_list(args.email), split_list(args.alias), [p.strip() for p in args.point or [] if p.strip()]
    relation = "自分" if args.self else args.relation
    check_relation(relation)
    check_forbidden(name, args.kana or "", args.org or "", args.role or "", *aliases, *points)
    if args.self and any(p.is_self for p in people):
        raise PeopleError("自分の人物ノートは、もうあります: " + next(p.path.relative_to(vault).as_posix() for p in people if p.is_self))
    keys = {norm_key(name)} | {norm_key(e) for e in emails}
    for person in people:
        if person.keys & keys:
            raise PeopleError(f"同じ氏名かアドレスの人物ノートがあります: {person.path.relative_to(vault).as_posix()} (直すときは set)")
    target = folder / f"{safe_file_name(name)}.md"
    if target.exists():
        raise PeopleError(f"同じ名前のファイルがあります: {target.relative_to(vault).as_posix()}")
    values: dict[str, str | list[str]] = {"created": stamp(now), "tags": ["人物"], "type": "person", "name": name}
    if args.kana:
        values["kana"] = args.kana.strip()
    values["aliases"] = aliases
    values["emails"] = emails
    for key in ("org", "role"):
        if getattr(args, key):
            values[key] = getattr(args, key).strip()
    if relation:
        values["relation"] = relation
    values["self"] = "true" if args.self else "false"
    if args.checked:
        values["checked"] = now.strftime("%Y-%m-%d")
    values["ai_generated"] = "opencode"
    values["ai_reviewed"] = "false"
    body = f"\n{POINT_HEADING}\n\n" + "".join(f"- {p}\n" for p in points) + f"\n{MEMO_HEADING}\n\n## 関連\n"
    text = join_note(update_front([], values), body)
    relative = target.relative_to(vault).as_posix()
    if args.dry_run:
        out.write(f"(試行。作っていません) {relative}\n{text}")
        return 0
    folder.mkdir(parents=True, exist_ok=True)
    write_note(target, text)
    out.write(f"人物ノートを作りました: {relative}\n  ai_reviewed: false (人が Obsidian で確かめて ✓ にするまで、根拠にしない)\n")
    return 0


def mark_edit(front: list[str], values: dict[str, str | list[str]], now: dt.datetime) -> list[str]:
    values = dict(values)
    values["ai_edited"] = stamp(now)
    values["ai_reviewed"] = "false"
    return update_front(front, values)


def cmd_set(vault: Path, people: list[Person], args: argparse.Namespace, now: dt.datetime, out: TextIO) -> int:
    person = find_person(people, args.person)
    check_relation(args.relation)
    aliases, emails, points = split_list(args.alias), split_list(args.email), [p.strip() for p in args.point or [] if p.strip()]
    check_forbidden(args.kana or "", args.org or "", args.role or "", *aliases, *points)
    for other in people:
        if other is not person and other.keys & {norm_key(e) for e in emails}:
            raise PeopleError(f"そのアドレスは、別の人物ノートにあります: {other.path.relative_to(vault).as_posix()}")
    values: dict[str, str | list[str]] = {}
    for key in ("kana", "org", "role", "relation"):
        if getattr(args, key):
            values[key] = getattr(args, key).strip()
    if aliases:
        values["aliases"] = person.items("aliases") + [a for a in aliases if a not in person.items("aliases")]
    if emails:
        values["emails"] = person.items("emails") + [e for e in emails if e not in person.items("emails")]
    if args.checked:
        values["checked"] = now.strftime("%Y-%m-%d")
    if not values and not points:
        raise PeopleError("直す項目がありません (--org、--role、--relation、--alias、--email、--point、--checked など)")
    text = person.path.read_text(encoding="utf-8", errors="replace")
    front, body = split_note(text)
    for point in points:
        body = add_to_section(body, POINT_HEADING, point)
    updated = join_note(mark_edit(front, values, now), body)
    relative = person.path.relative_to(vault).as_posix()
    changed = sorted(values) + (["要点"] if points else [])
    if args.dry_run:
        out.write(f"(試行。直していません) {relative}: {', '.join(changed)}\n{updated}")
        return 0
    write_note(person.path, updated)
    out.write(f"直しました: {relative} ({', '.join(changed)})\n  ai_edited: {stamp(now)} / ai_reviewed: false (人が確かめて ✓ にする)\n")
    return 0


def cmd_memo(vault: Path, people: list[Person], args: argparse.Namespace, now: dt.datetime, out: TextIO) -> int:
    person = find_person(people, args.person)
    memo = re.sub(r"\s+", " ", args.text).strip()
    if not memo:
        raise PeopleError("メモが空です")
    check_forbidden(memo)
    source = re.sub(r"\s+", " ", args.source or "").strip()
    line = f"{now:%Y-%m-%d} {memo}" + (f"(出典: {source})" if source else "")
    text = person.path.read_text(encoding="utf-8", errors="replace")
    front, body = split_note(text)
    updated = join_note(mark_edit(front, {}, now), add_to_section(body, MEMO_HEADING, line))
    relative = person.path.relative_to(vault).as_posix()
    if args.dry_run:
        out.write(f"(試行。足していません) {relative}\n- {line}\n")
        return 0
    write_note(person.path, updated)
    out.write(f"メモを足しました: {relative}\n- {line}\n  ai_reviewed: false (人が確かめて ✓ にする)\n")
    return 0


def cmd_check(vault: Path, people: list[Person], now: dt.datetime, out: TextIO) -> int:
    problems: list[str] = []
    owners: dict[str, list[str]] = {}
    for person in people:
        relative = person.path.relative_to(vault).as_posix()
        for email in person.items("emails"):
            owners.setdefault(norm_key(email), []).append(relative)
        if not person.items("emails") and not person.is_self:
            problems.append(f"アドレスが無い (メールと照合できない): {relative}")
        if person.text("relation") and person.text("relation") not in RELATIONS:
            problems.append(f"relation が決まった値でない ({person.text('relation')}): {relative}")
        checked = person.text("checked")
        try:
            old = not checked or (now.date() - dt.date.fromisoformat(checked[:10])).days > STALE_DAYS
        except ValueError:
            old = True
        if old:
            problems.append(f"確かめた日が無いか {STALE_DAYS} 日より前 ({checked or 'なし'}): {relative}")
        if person.status == "unreviewed":
            problems.append(f"未レビュー (AI が作った。✓ まで根拠にしない): {relative}")
        elif person.status == "edited":
            problems.append(f"AI が直した・人が未確認: {relative}")
        if any(v == "\x00complex" for v in person.front.values()):
            problems.append(f"frontmatter に、自動では直せない形の項目がある: {relative}")
    for email, paths in owners.items():
        if len(paths) > 1:
            problems.append(f"同じアドレスが 2 人以上にある ({email}): " + "、".join(paths))
    selves = [p.path.relative_to(vault).as_posix() for p in people if p.is_self]
    if not selves:
        problems.append("自分の人物ノートが無い (new 氏名 --self)")
    elif len(selves) > 1:
        problems.append("自分の人物ノートが 2 つ以上ある: " + "、".join(selves))
    out.write(f"人物ノート {len(people)} 人。点検の結果: {len(problems)} 件\n")
    out.write("".join(f"- {p}\n" for p in problems))
    return 0


# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="people_cli", description="登場人物を覚える (人物ノートとメールの集計。削除はしない)")
    sub = parser.add_subparsers(dest="command", required=True)
    who = sub.add_parser("who", help="人物の要点とメールの集計 (読み取りだけ)")
    who.add_argument("queries", nargs="*", help="氏名・呼び方・アドレス (一部でよい。複数可)")
    who.add_argument("--mail", help="このメール (キャッシュの ID) の差出人・宛先・CC の全員")
    who.add_argument("--self", action="store_true", help="自分のノート")
    cand = sub.add_parser("candidates", help="やり取りが多いのに未登録の人 (読み取りだけ)")
    cand.add_argument("--since", type=int, default=90, help="直近の日数 (既定 90)")
    cand.add_argument("--min", type=int, default=3, help="この通数以上 (既定 3)")
    cand.add_argument("--limit", type=int, default=15, help="表示する最大人数")
    for name, help_text in (("new", "人物ノートを作る"), ("set", "人物ノートの項目を直す・足す")):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("name" if name == "new" else "person", help="氏名" if name == "new" else "氏名・呼び方・アドレス")
        p.add_argument("--kana", help="読み")
        p.add_argument("--email", action="append", help="アドレス (複数可。set では足す)")
        p.add_argument("--alias", action="append", help="呼び方・表示名の違い (複数可。set では足す)")
        p.add_argument("--org", help="会社・部署")
        p.add_argument("--role", help="役割 (見積の窓口、など)")
        p.add_argument("--relation", help=f"自分との関係 ({' / '.join(RELATIONS)})")
        p.add_argument("--point", action="append", help="要点の 1 行 (複数可。足す)")
        p.add_argument("--checked", action="store_true", help="ユーザーに確かめた日として、今日を入れる")
        p.add_argument("--dry-run", action="store_true", help="書かずに、結果だけ表示する")
        if name == "new":
            p.add_argument("--self", action="store_true", help="自分のノートにする (relation: 自分)")
    memo = sub.add_parser("memo", help="やり取りのメモに 1 行足す")
    memo.add_argument("person", help="氏名・呼び方・アドレス")
    memo.add_argument("text", help="メモ (業務の事実。評価は書かない)")
    memo.add_argument("--source", help="出典 (メールの件名など)")
    memo.add_argument("--dry-run", action="store_true", help="書かずに、結果だけ表示する")
    sub.add_parser("check", help="点検 (読み取りだけ)")
    return parser


def main(argv: list[str] | None = None, stdout: TextIO | None = None, stderr: TextIO | None = None, cwd: Path | None = None,
         now: dt.datetime | None = None, config_path: Path | None = None, cache_path: Path | None = None) -> int:
    out = stdout or sys.stdout
    err = stderr or sys.stderr
    if stdout is None:
        for stream in (sys.stdout, sys.stderr):
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8")  # Windows の標準出力の文字化けを防ぐ
    args = build_parser().parse_args(argv)
    moment = now or dt.datetime.now()
    try:
        config = load_config(config_path)
        vault = find_vault(config, cwd or Path.cwd())
        folder = people_folder(vault, config)
        people = load_people(folder)
        if args.command in ("who", "candidates"):
            cache = MailCache(cache_path or mail_cache_path())
            if args.command == "who":
                return cmd_who(vault, people, cache, args.queries, args.mail, args.self, out)
            return cmd_candidates(people, cache, max(1, args.since), max(1, args.min), max(1, args.limit), moment, out)
        if args.command == "new":
            return cmd_new(folder, vault, people, args, moment, out)
        if args.command == "set":
            return cmd_set(vault, people, args, moment, out)
        if args.command == "memo":
            return cmd_memo(vault, people, args, moment, out)
        return cmd_check(vault, people, moment, out)
    except PeopleError as exc:
        err.write(f"エラー: {exc}\n")
        return 2
    except OSError as exc:
        err.write(f"エラー: ファイルを読み書きできません (他のアプリで開いている可能性があります): {exc}\n")
        return 2


if __name__ == "__main__":
    sys.exit(main())
