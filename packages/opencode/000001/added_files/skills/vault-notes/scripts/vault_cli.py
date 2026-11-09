"""Obsidian の Vault にノートを保存・修正するときの補助コマンド (スキル vault-notes から呼ぶ)。

  today    : 今日の日付と時刻、今日のフォルダーの場所、今週・来週とこれから 14 日の曜日を調べる (--create でフォルダーを作る)
  new-note : 新しいノートを、frontmatter つきで、今日のフォルダー (または指定の場所) に作る。上書きはしない
             --gantt-id でガントのタスクとつなぐ名前 (名前【ID】.md) にする
  backup   : 修正する前に、ノートのコピーを .handoff/backup/ に残す
  mark-edit: AI が既存のノートを直した後に、frontmatter の状態を「AI が直した・未レビュー」にする (ai_edited と ai_reviewed: false)
  unreviewed: 人のレビューが済んでいない AI のノート (作った・直した) と、印の付け忘れの疑いを一覧にする (読み取りだけ)

LLM は現在時刻を知らないことがあるので、日付と時刻はこのコマンドの値を使う。
書き込むのは、Vault の中だけ。.obsidian などのドットで始まる場所、Vault の外には書かない。削除はしない。
Vault は、いまのフォルダーから上へたどって、最初に見つかる .obsidian のあるフォルダー。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import sys
import unicodedata
from pathlib import Path
from typing import TextIO

SKILL_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DAILY_DIR = "01_data/{yyyy}/{mm}/{dd}"
WEEKDAYS = "月火水木金土日"
RESERVED = {"CON", "PRN", "AUX", "NUL"} | {f"COM{i}" for i in range(1, 10)} | {f"LPT{i}" for i in range(1, 10)}
MAX_BODY_BYTES = 2_000_000
LINK_RE = re.compile(r"!?\[\[([^\]|#^]+)")  # [[ノート]]、![[図.excalidraw]]、[[ノート#見出し|表示名]] のリンク先
SKIP_DIRS = {"node_modules"}  # ドットで始まるフォルダー (.obsidian、.git、.trash、.handoff) も見ない


class VaultError(Exception):
    """利用者に見せてよいメッセージ。"""


def find_vault(start: Path) -> Path:
    current = start.resolve()
    for candidate in [current, *current.parents]:
        if (candidate / ".obsidian").is_dir():
            return candidate
    raise VaultError(f"Obsidian の Vault が見つかりません ({start} から上に .obsidian がありません)。Vault の中で実行してください")


def load_daily_pattern(config_path: Path | None = None) -> str:
    path = config_path or SKILL_DIR / "config.local.json"
    pattern = DEFAULT_DAILY_DIR
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as exc:
            raise VaultError(f"設定ファイルを読めません: {exc}") from exc
        pattern = str(data.get("daily_dir", DEFAULT_DAILY_DIR))
    leftovers = re.sub(r"\{(yyyy|mm|dd)\}", "", pattern)
    parts = [p for p in pattern.replace("\\", "/").split("/") if p]
    if "{" in leftovers or "}" in leftovers or ".." in parts or pattern.startswith(("/", "\\")) or ":" in pattern or not parts:
        raise VaultError(f"daily_dir が正しくありません: {pattern!r} (Vault からの相対。使えるのは {{yyyy}} {{mm}} {{dd}})")
    if any(p.startswith(".") for p in parts):
        raise VaultError("daily_dir に、ドットで始まるフォルダーは使えません")
    return "/".join(parts)


def today_dir(pattern: str, now: dt.datetime) -> str:
    return pattern.replace("{yyyy}", f"{now.year:04d}").replace("{mm}", f"{now.month:02d}").replace("{dd}", f"{now.day:02d}")


def is_within(path: Path, root: Path) -> bool:
    path_s, root_s = os.path.normcase(str(path)), os.path.normcase(str(root))
    return path_s == root_s or path_s.startswith(root_s.rstrip("\\/") + os.sep)


def check_vault_path(vault: Path, relative: str, what: str) -> Path:
    """Vault の中の、ドットで始まらない場所だけを許す。"""
    cleaned = relative.replace("\\", "/")
    parts = [p for p in cleaned.split("/") if p and p != "."]
    if cleaned.startswith("/") or ":" in cleaned or ".." in parts or not parts:
        raise VaultError(f"{what}は、Vault からの相対パスにしてください: {relative!r}")
    if any(p.startswith(".") for p in parts):
        raise VaultError(f"{what}に、ドットで始まる場所は使えません (.obsidian など): {relative!r}")
    target = (vault / Path(*parts)).resolve()
    if not is_within(target, vault.resolve()):
        raise VaultError(f"{what}が Vault の外を指しています: {relative!r}")
    return target


def vault_index(vault: Path) -> dict[str, list[Path]]:
    """Vault の中のファイル名 (小文字) → パス。.md は拡張子なしの名前も入れる (Obsidian のリンクは拡張子を省く)。"""
    index: dict[str, list[Path]] = {}
    for dirpath, dirnames, filenames in os.walk(vault):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            low = name.lower()
            path = Path(dirpath) / name
            index.setdefault(low, []).append(path)
            if low.endswith(".md"):
                index.setdefault(low[:-3], []).append(path)
    return index


def vault_names(vault: Path) -> set[str]:
    return set(vault_index(vault))


def link_targets(body: str) -> list[str]:
    targets: list[str] = []
    for match in LINK_RE.finditer(body):
        target = match.group(1).strip()
        if target and target not in targets:
            targets.append(target)
    return targets


def resolve_links(body: str, index: dict[str, list[Path]]) -> dict[str, Path]:
    """本文のリンク先のうち、Vault にある Markdown のノート (リンクの文字 → パス)。"""
    found = {}
    for target in link_targets(body):
        base = target.replace("\\", "/").rsplit("/", 1)[-1].lower()
        paths = [p for p in index.get(base, []) + index.get(base + ".md", []) if p.suffix.lower() == ".md"]
        if paths:
            found[target] = paths[0]
    return found


def ai_note_status(path: Path, vault: Path) -> str | None:
    """AI のまとめか: 'unreviewed' (ai_generated があり ai_reviewed が true でない) / 'reviewed' / None (人のノート)。
    10_summary/ (Vault の決まりで AI の要約の置き場) は、印が無くても AI のまとめとして扱う。"""
    try:
        head = path.read_bytes()[:4096].decode("utf-8", "replace").lstrip("\ufeff")
    except OSError:
        return None
    front = ""
    if head.startswith("---"):
        end = head.find("\n---", 3)
        front = head[3:end] if end != -1 else ""
    generated = re.search(r"(?m)^ai_generated:[ \t]*\S", front) is not None
    reviewed = re.search(r"(?mi)^ai_reviewed:[ \t]*(true|yes)[ \t\r]*$", front) is not None
    try:
        in_summary = path.resolve().relative_to(vault.resolve()).parts[:1] == ("10_summary",)
    except ValueError:
        in_summary = False
    if not (generated or in_summary):
        return None
    return "reviewed" if reviewed else "unreviewed"


QUOTE_RE = re.compile(r"「([^「」\n]{3,80})」")


def squash(text: str) -> str:
    """引用の照合用: NFKC、空白と読点・カンマ・中黒を除く (表記の揺れで誤って知らせないため)。"""
    return re.sub(r"[\s、,，・]", "", unicodedata.normalize("NFKC", text))


def unquoted_quotes(body: str, sources: list[Path]) -> list[str]:
    """「」の引用のうち、リンクした出典のノートに原文のまま無いもの (言い換えに「」を付けると、原文と読み違えるため)。"""
    quotes = []
    for match in QUOTE_RE.finditer(body):
        if match.group(1) not in quotes:
            quotes.append(match.group(1))
    if not quotes or not sources:
        return []
    corpus = "\n".join(squash(p.read_text(encoding="utf-8", errors="replace")) for p in sources)
    return [q for q in quotes if squash(q) not in corpus]


def missing_links(body: str, vault: Path) -> list[str]:
    """本文の [[リンク]] のうち、Vault にファイルが無いものを、出てきた順に返す (LLM が存在しないノートをリンクにすることがあるため)。"""
    targets: list[str] = []
    for match in LINK_RE.finditer(body):
        target = match.group(1).strip()
        if target and target not in targets:
            targets.append(target)
    if not targets:
        return []
    names = vault_names(vault)
    result = []
    for target in targets:
        base = target.replace("\\", "/").rsplit("/", 1)[-1].lower()
        if base not in names and base + ".md" not in names:
            result.append(target)
    return result


def gitignore_warning(vault: Path) -> str | None:
    """Vault が Git の管理下で、.handoff が .gitignore に無いときだけ警告する (.gitignore は書き換えない)。"""
    if not (vault / ".git").exists():
        return None
    ignore = vault / ".gitignore"
    lines = []
    if ignore.is_file():
        lines = [line.strip() for line in ignore.read_text(encoding="utf-8", errors="replace").splitlines()]
    if any(line in (".handoff", ".handoff/", "/.handoff", "/.handoff/", ".handoff/*", ".handoff/**") for line in lines):
        return None
    return "注意: .gitignore に .handoff/ が入っていません。下書きやバックアップがコミットされないよう、人に足してもらってください (自分では書き換えない)"


def safe_title(title: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f#^\[\]]', "_", title).strip(" .")
    cleaned = re.sub(r"\s+", " ", cleaned)[:100].rstrip(" .")
    if not cleaned:
        raise VaultError("題名が空です (使えない文字だけの題名は使えません)")
    if cleaned.split(".")[0].upper() in RESERVED:
        cleaned = "_" + cleaned
    return cleaned


def unique_file(directory: Path, stem: str, suffix: str) -> Path:
    candidate = directory / f"{stem}{suffix}"
    number = 2
    while candidate.exists():
        candidate = directory / f"{stem}_{number}{suffix}"
        number += 1
    return candidate


def stamp(now: dt.datetime) -> str:
    return now.strftime("%Y-%m-%d %H:%M:%S")


def build_note(now: dt.datetime, tags: list[str], body: str) -> str:
    """frontmatter: created、AI が作った印 (ai_generated) とレビューの状態 (ai_reviewed。Obsidian ではチェックボックス。
    人が確かめて ✓ にするまでは、ハーネスは根拠にしない)、tags。"""
    lines = ["---", f"created: {stamp(now)}", "ai_generated: opencode", "ai_reviewed: false"]
    lines += ["tags:"] + [f"  - {t}" for t in tags] if tags else ["tags:"]
    lines += ["---", "", body.strip("\n"), ""]
    return "\n".join(lines)


def parse_tags(raw: str | None) -> list[str]:
    tags = [t.strip().lstrip("#") for t in (raw or "").replace("、", ",").split(",") if t.strip()]
    for tag in tags:
        if re.search(r"[\s/\\:\"'\[\]{}|,]", tag):
            raise VaultError(f"タグに使えない文字があります: {tag!r} (階層の / も使いません)")
    return list(dict.fromkeys(tags))


def day_label(day: dt.date, today: dt.date) -> str:
    """MM/DD(曜)。今年でなければ YYYY/MM/DD(曜)。"""
    text = f"{day:%m/%d}" if day.year == today.year else f"{day:%Y/%m/%d}"
    return f"{text}({WEEKDAYS[day.weekday()]})"


def calendar_lines(now: dt.datetime) -> list[str]:
    """今週・来週 (月曜始まり) と、これから 14 日の曜日。LLM は曜日の計算を誤るので、ここで決める。"""
    today = now.date()
    monday = today - dt.timedelta(days=today.weekday())
    weeks = []
    for label, start in (("今週", monday), ("来週", monday + dt.timedelta(days=7))):
        weeks.append(f"{label}: {day_label(start, today)}〜{day_label(start + dt.timedelta(days=6), today)}")
    days = " ".join(day_label(today + dt.timedelta(days=n), today) for n in range(14))
    return [" / ".join(weeks), f"これから 14 日: {days}"]


def cmd_today(vault: Path, pattern: str, now: dt.datetime, create: bool, out: TextIO) -> int:
    relative = today_dir(pattern, now)
    folder = check_vault_path(vault, relative, "今日のフォルダー")
    out.write(f"日付: {now:%Y-%m-%d} ({WEEKDAYS[now.weekday()]}) / いま: {stamp(now)}\n")
    if create and not folder.exists():
        folder.mkdir(parents=True)
        out.write(f"今日のフォルダー: {relative} (作りました)\n")
    elif folder.is_dir():
        count = sum(1 for p in folder.iterdir() if p.is_file())
        out.write(f"今日のフォルダー: {relative} (あります。ファイル {count} 個)\n")
    else:
        out.write(f"今日のフォルダー: {relative} (まだありません。ノートを作るときに作られます)\n")
    out.write(f"frontmatter の created: {stamp(now)}\n")
    out.write("".join(line + "\n" for line in calendar_lines(now)))
    warning = gitignore_warning(vault)
    if warning:
        out.write(warning + "\n")
    return 0


def gantt_suffix(raw: str | None) -> str:
    """ガントのタスクとつなぐノートの名前の末尾【ID】(ガントの「O」・Vault の「ganttに追加」と同じ形。ガントは改名後も【ID】で探し直す)。"""
    if raw is None:
        return ""
    if not re.fullmatch(r"[1-9][0-9]{0,8}", raw.strip()):
        raise VaultError(f"--gantt-id は、ガントのタスクの ID (正の整数) にしてください: {raw!r}")
    return f"【{raw.strip()}】"


def cmd_new_note(vault: Path, pattern: str, now: dt.datetime, title: str, body_file: str, tags_raw: str | None, directory: str | None, dry_run: bool, out: TextIO, cwd: Path, gantt_id: str | None = None) -> int:
    suffix = gantt_suffix(gantt_id)
    name = safe_title(title)
    if suffix and not name.endswith(suffix):
        name += suffix
    tags = parse_tags(tags_raw)
    source = Path(body_file)
    source = source if source.is_absolute() else cwd / source
    if not source.is_file():
        raise VaultError(f"本文のファイルがありません: {body_file}")
    if not is_within(source.resolve(), vault.resolve()):
        raise VaultError("本文のファイルは、Vault の中 (.handoff/ など) に置いてください")
    if source.stat().st_size > MAX_BODY_BYTES:
        raise VaultError("本文のファイルが大きすぎます")
    body = source.read_text(encoding="utf-8-sig")
    if not body.strip():
        raise VaultError("本文が空です")
    if body.lstrip().startswith("---"):
        raise VaultError("本文が --- で始まっています (frontmatter は自動で付けます。本文から frontmatter を外してください)")
    relative = directory if directory else today_dir(pattern, now)
    folder = check_vault_path(vault, relative, "保存先のフォルダー")
    if folder.exists() and not folder.is_dir():
        raise VaultError(f"保存先がフォルダーではありません: {relative}")
    target = unique_file(folder, name, ".md")
    shown = target.relative_to(vault.resolve()).as_posix()
    notes = []
    if suffix:
        notes.append(f"ガントのタスク {gantt_id.strip()} とつなぐ名前です。タスク側は、app-ecosystem の task-link で、このノートを指すようにする")
    index = vault_index(vault)
    linked = resolve_links(body, index)
    loose = unquoted_quotes(body, list(dict.fromkeys(linked.values())))
    if loose:
        shown_quotes = "、".join(f"「{q}」" for q in loose[:8]) + (f" ほか {len(loose) - 8} 個" if len(loose) > 8 else "")
        notes.append(f"注意: 「」の引用が {len(loose)} 個、リンクした出典のノートに原文のまま見つかりません: {shown_quotes}"
                     " (原文どおりに直す。言い換えなら「」を外す)")
    ai_sources = [name for name, path in linked.items() if ai_note_status(path, vault) == "unreviewed"]
    if ai_sources:
        notes.append("注意: 未レビューの AI のまとめを、出典にしています: " + "、".join(f"[[{n}]]" for n in ai_sources)
                     + " (根拠にしない。原典で確かめ、原典をリンクする。人が ai_reviewed を ✓ にしたものは使ってよい)")
    missing = missing_links(body, vault)
    if missing:
        notes.append(f"注意: 見つからないリンクが {len(missing)} 個あります: " + "、".join(f"[[{m}]]" for m in missing)
                     + " (ノート名を確かめる。図は先に作る。リンクにしないなら [[ ]] を外す)")
    warning = gitignore_warning(vault)
    if warning:
        notes.append(warning)
    if dry_run:
        out.write(f"[試行] 作るノート: {shown}\n  created: {stamp(now)} / タグ: {', '.join(tags) or 'なし'} / 本文 {len(body):,} 文字\n実際には何も作っていません\n")
        out.write("".join(n + "\n" for n in notes))
        return 0
    folder.mkdir(parents=True, exist_ok=True)
    target.write_text(build_note(now, tags, body), encoding="utf-8", newline="\n")
    out.write(f"作りました: {shown}\n  created: {stamp(now)} / タグ: {', '.join(tags) or 'なし'} / 本文 {len(body):,} 文字\n")
    if target.stem != name:
        out.write(f"注意: 同じ名前のノートがあったため、'{target.stem}' にしました (上書きしていません)\n")
    out.write("".join(n + "\n" for n in notes))
    return 0


FRONT_KEY_RE = r"(?m)^{key}:[^\r\n]*"  # 行末の CR は含めない (CRLF のノートで、書き換えた行だけ CR が落ちないように)
BACKUP_RE = re.compile(r"^(\d{8}-\d{6})_(.+)$")


def split_front(text: str) -> tuple[str, str] | None:
    """先頭の frontmatter (--- の行から、閉じる --- の行まで。改行を含む) と、残りに分ける。無ければ None。"""
    match = re.match(r"---[ \t]*\r?\n(.*?\r?\n)?---[ \t]*(\r?\n|$)", text, re.S)
    if not match:
        if re.match(r"---[ \t]*\r?\n", text):
            raise VaultError("frontmatter が閉じていません (--- の行がありません)。人に直してもらってください")
        return None
    return text[:match.end()], text[match.end():]


def front_value(front: str, key: str) -> str | None:
    match = re.search(FRONT_KEY_RE.format(key=key), front)
    return match.group(0).split(":", 1)[1].strip() if match else None


def is_true(value: str | None) -> bool:
    return (value or "").strip().lower() in ("true", "yes")


def read_front(path: Path) -> str:
    """先頭 4 KB から frontmatter を読む (無い・壊れているときは空)。"""
    try:
        head = path.read_bytes()[:4096].decode("utf-8", "replace").lstrip("\ufeff")
        parts = split_front(head)
    except (OSError, VaultError):
        return ""
    return parts[0] if parts else ""


def set_front_keys(text: str, values: dict[str, str]) -> str:
    """frontmatter の指定のキーだけを書き換える (無ければ閉じる --- の前に足す。frontmatter が無ければ作る)。他の行は変えない。"""
    newline = "\r\n" if "\r\n" in text[:4096] else "\n"
    parts = split_front(text)
    if parts is None:
        return "---" + newline + "".join(f"{k}: {v}{newline}" for k, v in values.items()) + "---" + newline + text
    front, rest = parts
    body_end = front.rstrip("\r\n")
    closing_at = body_end.rfind("---")
    inner, closing = front[:closing_at], front[closing_at:]
    for key, value in values.items():
        pattern = FRONT_KEY_RE.format(key=key)
        if re.search(pattern, inner):
            inner = re.sub(pattern, lambda _m, k=key, v=value: f"{k}: {v}", inner, count=1)
        else:
            inner += f"{key}: {value}{newline}"
    return inner + closing + rest


def note_path(vault: Path, note: str, cwd: Path) -> tuple[Path, str]:
    source = Path(note)
    source = source if source.is_absolute() else cwd / source
    if not source.is_file():
        raise VaultError(f"ノートがありません: {note}")
    resolved = source.resolve()
    if not is_within(resolved, vault.resolve()):
        raise VaultError("Vault の外のファイルは扱いません")
    relative = resolved.relative_to(vault.resolve()).as_posix()
    if any(p.startswith(".") for p in relative.split("/")):
        raise VaultError(f"ドットで始まる場所のファイルは扱いません: {relative}")
    return resolved, relative


def cmd_mark_edit(vault: Path, now: dt.datetime, note: str, cwd: Path, out: TextIO) -> int:
    """AI が直したノートの状態を「未レビュー」にする。✓ (true) にはしない (人がレビューして付ける)。"""
    path, relative = note_path(vault, note, cwd)
    if not relative.lower().endswith(".md") or relative.lower().endswith(".excalidraw.md"):
        raise VaultError("印を付けられるのは、Markdown のノート (.md。図は除く) だけです")
    raw = path.read_bytes()
    bom = raw.startswith(b"\xef\xbb\xbf")
    text = raw.decode("utf-8-sig")
    parts = split_front(text)
    before = front_value(parts[0], "ai_reviewed") if parts else None
    updated = set_front_keys(text, {"ai_edited": stamp(now), "ai_reviewed": "false"})
    path.write_bytes(("\ufeff" if bom else "").encode("utf-8") + updated.encode("utf-8"))
    state = "なし" if before is None else before
    out.write(f"AI が直した印を付けました: {relative}\n  ai_edited: {stamp(now)} / ai_reviewed: {state} → false (人が確かめて ✓ にする)\n")
    if parts is None:
        out.write("  frontmatter が無かったので、この 2 つだけの frontmatter を作りました\n")
    backups = vault / ".handoff" / "backup"
    if not any(BACKUP_RE.match(p.stem) and BACKUP_RE.match(p.stem).group(2).startswith(path.stem) for p in (backups.iterdir() if backups.is_dir() else [])):
        out.write("注意: このノートのバックアップが .handoff/backup/ にありません (直す前に backup を取る決まり)\n")
    return 0


def parse_stamp(value: str | None) -> dt.datetime | None:
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return dt.datetime.strptime((value or "").strip().strip("'\""), fmt)
        except ValueError:
            continue
    return None


def forgotten_marks(vault: Path, index: dict[str, list[Path]]) -> list[tuple[str, str]]:
    """バックアップの後に中身が変わったのに、その後の ai_edited が無いノート (印の付け忘れの疑い)。(ノート, バックアップ)"""
    folder = vault / ".handoff" / "backup"
    found: list[tuple[str, str]] = []
    if not folder.is_dir():
        return found
    origins = backup_origins(vault)
    for backup in sorted(folder.iterdir()):
        match = BACKUP_RE.match(backup.stem)
        if not match or not backup.is_file() or backup.suffix.lower() != ".md" or backup.name.lower().endswith(".excalidraw.md"):
            continue
        taken = dt.datetime.strptime(match.group(1), "%Y%m%d-%H%M%S")
        origin = origins.get(backup.name)
        if origin is not None:
            candidates = [vault / origin] if (vault / origin).is_file() else []
        else:  # 記録の無い古いバックアップは、名前で探す (同名のノートがあると、どれか分からない)
            names = dict.fromkeys([match.group(2), re.sub(r"_\d+$", "", match.group(2))])
            candidates = [n for name in names for n in index.get((name + backup.suffix).lower(), [])]
        for note in candidates:
            if note.read_bytes() == backup.read_bytes():
                continue
            edited = parse_stamp(front_value(read_front(note), "ai_edited"))
            if edited is None or edited < taken:
                shown = backup.relative_to(vault).as_posix() + (" / 元のノートの記録が無く、同名が複数あるので推定" if origin is None and len(candidates) > 1 else "")
                item = (note.relative_to(vault).as_posix(), shown)
                if item not in found:
                    found.append(item)
    return found


BACKUP_INDEX = "index.tsv"


def backup_origins(vault: Path) -> dict[str, str]:
    """backup が残す記録 (.handoff/backup/index.tsv: バックアップの名前 → 元のノート)。"""
    path = vault / ".handoff" / "backup" / BACKUP_INDEX
    origins: dict[str, str] = {}
    if path.is_file():
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            parts = line.split("\t")
            if len(parts) == 2 and parts[0] and parts[1]:
                origins[parts[0]] = parts[1]
    return origins


def cmd_unreviewed(vault: Path, out: TextIO, limit: int) -> int:
    made: list[tuple[str, str]] = []
    edited: list[tuple[str, str]] = []
    index = vault_index(vault)
    for paths in index.values():
        for path in paths:
            if path.suffix.lower() != ".md":
                continue
            front = read_front(path)
            if not front or is_true(front_value(front, "ai_reviewed")):
                continue
            relative = path.relative_to(vault).as_posix()
            if front_value(front, "ai_generated"):
                made.append((relative, front_value(front, "created") or ""))
            elif front_value(front, "ai_edited"):
                edited.append((relative, front_value(front, "ai_edited") or ""))
    made, edited = sorted(set(made)), sorted(set(edited))
    suspects = forgotten_marks(vault, index)
    out.write(f"人のレビューが済んでいない AI のノート: AI が作った {len(made)} 個 / AI が直した {len(edited)} 個 / 印の付け忘れの疑い {len(suspects)} 個\n")
    for title, rows, label in (("AI が作った (根拠にしない)", made, "created"), ("AI が直した (根拠に使ってよい。人がレビューして ✓ にする)", edited, "ai_edited")):
        if rows:
            out.write(f"\n## {title}\n")
            out.write("".join(f"- {path} ({label}: {when or '?'})\n" for path, when in rows[:limit]))
            if len(rows) > limit:
                out.write(f"- ほか {len(rows) - limit} 個 (--limit で増やす)\n")
    if suspects:
        out.write("\n## 印の付け忘れの疑い (バックアップの後に中身が変わったが、その後の ai_edited が無い)\n")
        out.write("".join(f"- {path} (バックアップ: {backup})\n" for path, backup in suspects[:limit]))
        out.write("AI が直したものなら mark-edit で印を付ける。人が直したものなら、そのままでよい\n")
    out.write("\n10_summary/ の要約は、印が無いものは一覧に出ません (AI の要約として、根拠にしない)\n")
    return 0


def cmd_backup(vault: Path, now: dt.datetime, note: str, cwd: Path, out: TextIO) -> int:
    source = Path(note)
    source = source if source.is_absolute() else cwd / source
    if not source.is_file():
        raise VaultError(f"ノートがありません: {note}")
    resolved = source.resolve()
    if not is_within(resolved, vault.resolve()):
        raise VaultError("Vault の外のファイルは、バックアップしません")
    relative = resolved.relative_to(vault.resolve()).as_posix()
    if any(p.startswith(".") for p in relative.split("/")):
        raise VaultError(f"ドットで始まる場所のファイルは、バックアップしません: {relative}")
    folder = vault / ".handoff" / "backup"
    folder.mkdir(parents=True, exist_ok=True)
    target = unique_file(folder, f"{now:%Y%m%d-%H%M%S}_{resolved.stem}", resolved.suffix)
    shutil.copy2(resolved, target)
    with open(folder / BACKUP_INDEX, "a", encoding="utf-8", newline="\n") as record:  # 同名のノートがあっても、元が分かるように
        record.write(f"{target.name}\t{relative}\n")
    out.write(f"バックアップしました: {target.relative_to(vault.resolve()).as_posix()}\n  元: {relative} ({resolved.stat().st_size:,} バイト)\n")
    out.write("戻すときは、このファイルの中身を元のノートに上書きしてください (人間の確認の後)\n")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="vault_cli", description="Vault にノートを保存・修正するときの補助 (削除はしない)")
    sub = parser.add_subparsers(dest="command", required=True)
    today = sub.add_parser("today", help="今日の日付・時刻・フォルダー")
    today.add_argument("--create", action="store_true", help="今日のフォルダーを作る")
    new = sub.add_parser("new-note", help="新しいノートを作る (上書きしない)")
    new.add_argument("--title", required=True, help="ノートの題名 (ファイル名になる)")
    new.add_argument("--body-file", required=True, help="本文を書いたファイル (Vault の中。.handoff/ など)。frontmatter は含めない")
    new.add_argument("--tags", help="タグ (カンマ区切り。階層は使わない)")
    new.add_argument("--dir", help="保存先のフォルダー (Vault からの相対)。省略すると今日のフォルダー")
    new.add_argument("--gantt-id", help="ガントのタスクの ID。ファイル名の末尾に【ID】を付けて、タスクとつなぐ")
    new.add_argument("--dry-run", action="store_true", help="作らずに、結果だけ表示する")
    backup = sub.add_parser("backup", help="修正の前に、ノートのコピーを .handoff/backup/ に残す")
    backup.add_argument("note", help="ノートのパス")
    mark = sub.add_parser("mark-edit", help="AI が直したノートの状態を、未レビューにする (ai_edited と ai_reviewed: false)")
    mark.add_argument("note", help="ノートのパス")
    unreviewed = sub.add_parser("unreviewed", help="人のレビューが済んでいない AI のノートと、印の付け忘れの疑いの一覧 (読み取りだけ)")
    unreviewed.add_argument("--limit", type=int, default=100, help="種類ごとの最大件数")
    return parser


def main(argv: list[str] | None = None, stdout: TextIO | None = None, stderr: TextIO | None = None, cwd: Path | None = None,
         now: dt.datetime | None = None, config_path: Path | None = None) -> int:
    out = stdout or sys.stdout
    err = stderr or sys.stderr
    if stdout is None:
        for stream in (sys.stdout, sys.stderr):
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8")  # Windows の標準出力の文字化けを防ぐ
    args = build_parser().parse_args(argv)
    work = (cwd or Path.cwd()).resolve()
    moment = now or dt.datetime.now()
    try:
        vault = find_vault(work)
        pattern = load_daily_pattern(config_path)
        if args.command == "today":
            return cmd_today(vault, pattern, moment, args.create, out)
        if args.command == "new-note":
            return cmd_new_note(vault, pattern, moment, args.title, args.body_file, args.tags, args.dir, args.dry_run, out, work, args.gantt_id)
        if args.command == "mark-edit":
            return cmd_mark_edit(vault, moment, args.note, work, out)
        if args.command == "unreviewed":
            return cmd_unreviewed(vault, out, max(1, args.limit))
        return cmd_backup(vault, moment, args.note, work, out)
    except VaultError as exc:
        err.write(f"エラー: {exc}\n")
        return 2
    except OSError as exc:
        err.write(f"エラー: ファイルを読み書きできません (他のアプリで開いている可能性があります): {exc}\n")
        return 2


if __name__ == "__main__":
    sys.exit(main())
