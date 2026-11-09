"""マニュアルや長い資料を、目次と用語の表を先に決め、節ごとに書くための補助 (スキル doc-writing から呼ぶ)。

  init  : .handoff/doc_<話題>/ に、目次 (outline.md) と用語の表 (terms.md) のひな形を作る
  check : 節のファイルを、目次・用語の表と照らして検査する (読み取りだけ)
  join  : 検査を通ったら、目次の順に節をつないで 1 つの下書き (draft.md) にする

検査すること:
  - 目次にある節のファイルがあるか (無ければ未着手)、目次に無いファイルが無いか
  - 各節に出典があるか (出典: の行、または [[ノート]] のリンク)
  - 用語の表の「使わない言い方」が使われていないか (「」の引用とコードは除く)
  - 用語の表の「値」と、本文の数値が食い違っていないか (例: 締付トルク 25 N·m なのに、本文に 30)
  - 文体が混ざっていないか (である調 / です・ます調)
  - 番号つきの手順の番号が、1 から順に続いているか
  - リンク先のノートが Vault にあるか。未レビューの AI のノートを出典にしていないか
  - 「未確認」「要確認」「TODO」の残り (注意として一覧にする)
書くのは .handoff/ の中だけ。上書きはしない。
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import TextIO

SECTION_RE = re.compile(r"^\d{2}_[^\\/:*?\"<>|]+\.md$")
OUTLINE_ITEM_RE = re.compile(r"^\s*[-*]\s+(?:\[[ xX]\]\s+)?(\d{2}_[^\s:：]+\.md)")
LINK_RE = re.compile(r"!?\[\[([^\]|#^]+)")
PENDING_RE = re.compile(r"未確認|要確認|TODO|TBD")
DESU_END = ("です", "ます", "ました", "ません", "でした", "ましょう", "ください", "でしょう")
DEARU_END = ("である", "だ", "であった", "ではない")
MAX_FILE_BYTES = 2_000_000

OUTLINE_TEMPLATE = """# {title}

- 目的: (この文書で、読者が何をできるようになるか)
- 読者: (誰が、どんな場面で読むか。前提の知識)
- 範囲: (書くこと / 書かないこと)
- 文体: である
- 完成の条件: (何がそろえば完成か。レビューする人)

## 目次 (節のファイル。この順に join する。節を足すときは、ここにも足す)

- 01_概要.md: 目的、範囲、前提
- 02_準備.md: 必要なもの、権限、事前の確認
- 03_手順.md: 作業の手順 (1 つの番号に 1 つの操作)
- 04_確認とトラブル.md: 終わった後の確認、うまくいかないとき
"""

TERMS_TEMPLATE = """# 用語の表

用語は、この表の「用語」の書き方にそろえる。「使わない言い方」は、本文に出てきたら検査で見つかる(カンマか、読点で区切る)。
「値」を書いた用語は、本文で、その用語のすぐ後の数値が、表の値と同じかを検査する。

| 用語 | 定義 | 使わない言い方 | 値 | 出典 |
|---|---|---|---|---|

<!-- 例 (この行は検査されない):
| 締付トルク | ボルトを締める回転の力 | 締め付けトルク、トルク値 | 25 N·m | 作業標準.pdf p.4 |
-->
"""


class DocError(Exception):
    """利用者に見せてよいメッセージ (終了コード 2)。"""


@dataclass
class Term:
    word: str
    banned: list[str]
    value: str
    number: str | None


@dataclass
class Report:
    problems: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    pending: list[str] = field(default_factory=list)


def is_within(path: Path, root: Path) -> bool:
    a, b = os.path.normcase(os.path.realpath(path)), os.path.normcase(os.path.realpath(root))
    return a == b or a.startswith(b.rstrip("\\/") + os.sep)


def safe_topic(topic: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f\s]+', "_", topic).strip("._")[:60]
    if not cleaned:
        raise DocError("話題が空です (使えない文字だけの話題は使えません)")
    return cleaned


def doc_folder(raw: str, cwd: Path) -> Path:
    path = Path(raw)
    path = path if path.is_absolute() else cwd / path
    if not path.is_dir():
        raise DocError(f"フォルダがありません: {raw} (init で作る)")
    if not is_within(path, cwd / ".handoff") or os.path.realpath(path) == os.path.realpath(cwd / ".handoff"):
        raise DocError("文書のフォルダは、作業フォルダ直下の .handoff/ の中だけです (例: .handoff/doc_手順書)")
    return Path(os.path.realpath(path))


def read_text(path: Path) -> str:
    if path.stat().st_size > MAX_FILE_BYTES:
        raise DocError(f"ファイルが大きすぎます: {path.name}")
    return path.read_text(encoding="utf-8-sig")


def parse_outline(text: str) -> tuple[list[str], str]:
    items = []
    for line in text.splitlines():
        match = OUTLINE_ITEM_RE.match(line)
        if match and match.group(1) not in items:
            items.append(match.group(1))
    style_match = re.search(r"(?m)^\s*[-*]\s*文体[:：]\s*(\S+)", text)
    style = "です" if style_match and ("です" in style_match.group(1) or "ます" in style_match.group(1)) else "である"
    return items, style


def strip_comments(text: str) -> str:
    return re.sub(r"<!--.*?-->", "", text, flags=re.S)


def parse_terms(text: str) -> list[Term]:
    terms = []
    for line in strip_comments(text).splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")] if line.strip().startswith("|") else []
        if len(cells) < 3 or cells[0] in ("用語", "") or set(cells[0]) <= set("-: "):
            continue
        banned = [b.strip() for b in re.split(r"[,、，]", cells[2]) if b.strip()]
        value = cells[3] if len(cells) > 3 else ""
        number = re.search(r"\d+(?:\.\d+)?", value)
        terms.append(Term(cells[0], banned, value, number.group(0) if number else None))
    return terms


def prose_lines(text: str) -> list[tuple[int, str]]:
    """本文の行 (コードブロックの中は除く)。行の中の `コード` と「引用」は、空白に置き換える (原文どおりの引用は検査しない)。"""
    lines = []
    fence = None
    for number, line in enumerate(text.splitlines(), start=1):
        stripped = line.lstrip()
        if stripped.startswith(("```", "~~~")):
            marker = stripped[:3]
            fence = None if fence == marker else (fence or marker)
            continue
        if fence:
            continue
        cleaned = re.sub(r"`[^`]*`", lambda m: " " * len(m.group(0)), line)
        cleaned = re.sub(r"「[^「」]*」", lambda m: " " * len(m.group(0)), cleaned)
        lines.append((number, cleaned))
    return lines


def mask_terms(line: str, words: list[str]) -> str:
    for word in sorted(words, key=len, reverse=True):
        line = line.replace(word, "\0" * len(word))
    return line


def check_numbering(name: str, text: str, report: Report) -> None:
    """番号つきの手順が、1 から順に続いているか。字下げごとに数え、より浅い行が出たら数え直す。"""
    expected: dict[int, int] = {}
    for number, line in prose_lines(text):
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip())
        match = re.match(r"\s*(\d+)[.)]\s", line)
        for level in [lvl for lvl in expected if lvl > indent]:
            del expected[level]
        if not match:
            embed_only = re.fullmatch(r"\s*(!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]*\)|>.*)\s*", line)  # 手順の間の図・画像・引用は、数え直さない
            if (indent == 0 and not embed_only) or line.lstrip().startswith("#"):
                expected.clear()
            continue
        value = int(match.group(1))
        want = expected.get(indent)
        if want is None and value != 1:
            report.notes.append(f"{name}:{number}: 番号つきの手順が {value}. から始まっています (前の手順の続きなら、間の段落を字下げする)")
        elif want is not None and value != want:
            report.problems.append(f"{name}:{number}: 手順の番号が飛んでいます ({want - 1}. の次が {value}.)")
        expected[indent] = value + 1


def find_vault(start: Path) -> Path | None:
    for candidate in [start, *start.parents]:
        if (candidate / ".obsidian").is_dir():
            return candidate
    return None


def vault_names(vault: Path) -> dict[str, Path]:
    names: dict[str, Path] = {}
    for dirpath, dirnames, filenames in os.walk(vault):
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d != "node_modules"]
        for filename in filenames:
            path = Path(dirpath) / filename
            names.setdefault(filename.lower(), path)
            if filename.lower().endswith(".md"):
                names.setdefault(filename[:-3].lower(), path)
    return names


def unreviewed_ai(path: Path, vault: Path) -> bool:
    try:
        head = path.read_bytes()[:4096].decode("utf-8", "replace").lstrip("﻿")
    except OSError:
        return False
    front = ""
    if head.startswith("---"):
        end = head.find("\n---", 3)
        front = head[3:end] if end != -1 else ""
    generated = re.search(r"(?m)^ai_generated:[ \t]*\S", front) is not None
    reviewed = re.search(r"(?mi)^ai_reviewed:[ \t]*(true|yes)[ \t\r]*$", front) is not None
    in_summary = path.resolve().relative_to(vault.resolve()).parts[:1] == ("10_summary",)
    return (generated or in_summary) and not reviewed


def run_check(folder: Path, cwd: Path, final: bool = False, only: str | None = None) -> tuple[Report, list[str]]:
    """only を付けると、そのファイル (推敲の後の最終稿など) だけを、用語・値・文体・番号・リンクで検査する。"""
    report = Report()
    outline_path, terms_path = folder / "outline.md", folder / "terms.md"
    if not outline_path.is_file():
        raise DocError(f"目次 (outline.md) がありません: {folder.name}")
    sections, style = parse_outline(read_text(outline_path))
    if not sections:
        report.problems.append("outline.md の目次に、節のファイル (- 01_名前.md: 要点) がありません")
    terms = parse_terms(read_text(terms_path)) if terms_path.is_file() else []
    if not terms_path.is_file():
        report.notes.append("用語の表 (terms.md) がありません。用語をそろえる検査をしていません")
    present = sorted(p.name for p in folder.iterdir() if p.is_file() and SECTION_RE.match(p.name))
    if only:
        if "/" in only or "\\" in only or not (folder / only).is_file():
            raise DocError(f"文書のフォルダの中に、ファイルがありません: {only}")
        targets = [only]
    else:
        targets = [s for s in sections if s in present]
        for extra in [p for p in present if p not in sections]:
            report.problems.append(f"{extra}: 目次 (outline.md) にありません (目次に足すか、節の名前を目次に合わせる)")
        missing = [s for s in sections if s not in present]
        if missing:
            (report.problems if final else report.notes).append("まだ無い節: " + ", ".join(missing))
    vault = find_vault(cwd)
    names = vault_names(vault) if vault else {}
    canonical = [t.word for t in terms]
    endings = {"です": 0, "である": 0}
    for name in targets:
        text = read_text(folder / name)
        if not text.strip():
            report.problems.append(f"{name}: 中身が空です")
            continue
        has_link = bool(re.search(r"(?<!!)\[\[[^\]]+\]\]", text))  # 図や画像の埋め込み (![[…]]) は、出典に数えない
        if not has_link and not re.search(r"(?m)^\s*[-*]?\s*(\*\*)?出典(\*\*)?[:：]\s*\S", text):
            report.problems.append(f"{name}: 出典がありません (「出典: ファイルのパスとページ」の行か、[[ノート]] のリンクを書く)")
        lines = prose_lines(text)
        for number, line in lines:
            masked = mask_terms(line, canonical)
            for term in terms:
                for banned in term.banned:
                    if banned in masked:
                        report.problems.append(f"{name}:{number}: 「{banned}」は使わない言い方です (用語の表: {term.word})")
                if term.number:
                    for match in re.finditer(re.escape(term.word) + r"[^0-9\n。]{0,12}?(\d+(?:\.\d+)?)", line):
                        if float(match.group(1)) != float(term.number):
                            report.problems.append(f"{name}:{number}: {term.word} の値が {match.group(1)} です (用語の表: {term.value})")
            for sentence in re.split(r"[。！？]", line)[:-1]:
                tail = sentence.rstrip(" 　)）」")
                if tail.endswith(DESU_END):
                    endings["です"] += 1
                    if style == "である":
                        report.notes.append(f"{name}:{number}: です・ます調の文があります (目次の文体: である): …{tail[-12:]}。")
                elif tail.endswith(DEARU_END):
                    endings["である"] += 1
                    if style == "です":
                        report.notes.append(f"{name}:{number}: である調の文があります (目次の文体: です・ます): …{tail[-12:]}。")
            if PENDING_RE.search(line):
                report.pending.append(f"{name}:{number}: {line.strip()[:80]}")
        check_numbering(name, text, report)
        for target in dict.fromkeys(m.group(1).strip() for m in LINK_RE.finditer(text)):
            base = target.replace("\\", "/").rsplit("/", 1)[-1].lower()
            if not vault:
                continue
            path = names.get(base) or names.get(base + ".md")
            if path is None:
                report.problems.append(f"{name}: リンク先が Vault にありません: [[{target}]]")
            elif path.suffix.lower() == ".md" and unreviewed_ai(path, vault):
                report.problems.append(f"{name}: 未レビューの AI のノートを出典にしています: [[{target}]] (原典を読み、原典をリンクする)")
    if not vault and any(LINK_RE.search(read_text(folder / s)) for s in targets):
        report.notes.append("Vault の外なので、[[リンク]] の先があるかは確かめていません")
    summary = [f"文書: {folder.name}" + (f" / {only} だけ" if only else f" (節 {len(present)}/{len(sections)}") + f"、用語 {len(terms)}、文体: {style}" + ("" if only else ")")]
    return report, summary


def write_report(report: Report, summary: list[str], out: TextIO) -> None:
    out.write("".join(line + "\n" for line in summary))
    out.write(f"結果: {'合格' if not report.problems else '不合格'} (問題 {len(report.problems)} 件、注意 {len(report.notes)} 件、未確認の残り {len(report.pending)} 件)\n")
    for title, rows in (("問題 (直す)", report.problems), ("注意 (直すか、理由を報告に書く)", report.notes), ("未確認の残り (報告に書く。人に確かめてもらう)", report.pending)):
        if rows:
            out.write(f"\n## {title}\n" + "".join(f"- {row}\n" for row in rows[:200]))
            if len(rows) > 200:
                out.write(f"- ほか {len(rows) - 200} 件\n")


def cmd_init(topic: str, title: str | None, cwd: Path, out: TextIO) -> int:
    folder = cwd / ".handoff" / f"doc_{safe_topic(topic)}"
    if folder.exists():
        raise DocError(f"すでにあります: {folder.relative_to(cwd).as_posix()} (続きから書く。新しく作るなら別の話題にする)")
    folder.mkdir(parents=True)
    (folder / "outline.md").write_text(OUTLINE_TEMPLATE.format(title=title or topic), encoding="utf-8", newline="\n")
    (folder / "terms.md").write_text(TERMS_TEMPLATE, encoding="utf-8", newline="\n")
    shown = folder.relative_to(cwd).as_posix()
    out.write(f"作りました: {shown}/outline.md、{shown}/terms.md\n目次・用語の表を埋めて、ユーザーの承認を得てから、節 (01_名前.md …) を書く\n")
    return 0


def cmd_join(folder: Path, cwd: Path, with_title: bool, out: TextIO) -> int:
    report, summary = run_check(folder, cwd, final=True)
    if report.problems:
        write_report(report, summary, out)
        out.write("\n問題があるので、つなぎませんでした。直してから、もう一度 join する\n")
        return 1
    sections, _ = parse_outline(read_text(folder / "outline.md"))
    parts = [read_text(folder / name).strip("\n") for name in sections]
    if with_title:
        title = re.search(r"(?m)^#\s+(.+)$", read_text(folder / "outline.md"))
        parts.insert(0, f"# {title.group(1).strip()}" if title else "")
    target = folder / "draft.md"
    number = 2
    while target.exists():
        target = folder / f"draft_{number}.md"
        number += 1
    text = "\n\n".join(p for p in parts if p) + "\n"
    target.write_text(text, encoding="utf-8", newline="\n")
    out.write(f"つなぎました: {target.relative_to(cwd).as_posix()} (節 {len(sections)}、{len(text):,} 文字)\n")
    if report.notes or report.pending:
        out.write(f"注意 {len(report.notes)} 件、未確認の残り {len(report.pending)} 件があります (check で一覧を見て、報告に書く)\n")
    out.write("Vault に保存するなら vault-notes の new-note --body-file に、このファイルを渡す\n")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="doc_cli", description="長い資料を節ごとに書く補助 (書くのは .handoff/ の中だけ。上書きしない)")
    sub = parser.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init", help="目次と用語の表のひな形を、.handoff/doc_<話題>/ に作る")
    init.add_argument("topic", help="話題 (フォルダ名になる)")
    init.add_argument("--title", help="文書の題名 (省略すると話題)")
    check = sub.add_parser("check", help="節を、目次・用語の表と照らして検査する (読み取りだけ)")
    check.add_argument("folder", help="文書のフォルダ (.handoff/doc_<話題>)")
    check.add_argument("--file", help="このファイルだけを検査する (推敲の後の polish_draft.md など。フォルダの中の名前)")
    join = sub.add_parser("join", help="検査を通ったら、目次の順に節をつないで draft.md にする")
    join.add_argument("folder")
    join.add_argument("--with-title", action="store_true", help="先頭に、目次の # 題名 を入れる")
    return parser


def main(argv: list[str] | None = None, stdout: TextIO | None = None, stderr: TextIO | None = None, cwd: Path | None = None) -> int:
    out = stdout or sys.stdout
    err = stderr or sys.stderr
    if stdout is None:
        for stream in (sys.stdout, sys.stderr):
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8")  # Windows の標準出力の文字化けを防ぐ
    args = build_parser().parse_args(argv)
    work = (cwd or Path.cwd()).resolve()
    try:
        if args.command == "init":
            return cmd_init(args.topic, args.title, work, out)
        folder = doc_folder(args.folder, work)
        if args.command == "check":
            report, summary = run_check(folder, work, only=args.file)
            write_report(report, summary, out)
            return 1 if report.problems else 0
        return cmd_join(folder, work, args.with_title, out)
    except DocError as exc:
        err.write(f"エラー: {exc}\n")
        return 2
    except OSError as exc:
        err.write(f"エラー: ファイルを読み書きできません (他のアプリで開いている可能性があります): {exc}\n")
        return 2


if __name__ == "__main__":
    sys.exit(main())
