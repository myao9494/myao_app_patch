"""図 (Excalidraw / draw.io) を、画像を見なくても分かる文章 (または Mermaid) にして読むコマンド (スキル diagram-reader から呼ぶ)。

  describe : 図を読んで文章にする。形式は、拡張子と中身から自動で判断する。圧縮された図も読める
  links    : ノートに埋め込まれた (リンクされた) 図の場所を調べる

読み取り専用。読めるのは、いまのフォルダ、または Vault (上へたどって見つかる .obsidian のあるフォルダ) の中だけ。
書くのは describe --out (.handoff/ の中だけ)。
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path
from typing import Any, TextIO

sys.path.insert(0, str(Path(__file__).resolve().parent))

import diagram_model as model  # noqa: E402
import load_drawio  # noqa: E402
import load_excalidraw  # noqa: E402

MAX_FILE_BYTES = 40 * 1024 * 1024
DIAGRAM_SUFFIXES = (".excalidraw.md", ".excalidraw", ".drawio.svg", ".dio.svg", ".drawio", ".dio")


class CliError(Exception):
    pass


def find_vault(start: Path) -> Path | None:
    current = start.resolve()
    for candidate in [current, *current.parents]:
        if (candidate / ".obsidian").is_dir():
            return candidate
    return None


def is_within(path: Path, root: Path) -> bool:
    a, b = os.path.normcase(str(path)), os.path.normcase(str(root))
    return a == b or a.startswith(b.rstrip("\\/") + os.sep)


def resolve_input(raw: str, cwd: Path) -> Path:
    path = Path(raw)
    path = path if path.is_absolute() else cwd / path
    if not path.is_file():
        raise CliError(f"ファイルがありません: {raw}")
    resolved = path.resolve()
    roots = [cwd.resolve()] + ([find_vault(cwd).resolve()] if find_vault(cwd) else [])
    if not any(is_within(resolved, root) for root in roots):
        raise CliError(f"'{raw}' は、読んでよい場所の外です (いまのフォルダと、Vault の中だけ)。回避せずに、そのまま報告してください")
    if resolved.stat().st_size > MAX_FILE_BYTES:
        raise CliError("ファイルが大きすぎます")
    return resolved


def detect_format(name: str, text: str) -> str:
    low = name.lower()
    if low.endswith((".excalidraw.md", ".excalidraw")):
        return "excalidraw"
    if low.endswith((".drawio.svg", ".dio.svg", ".drawio", ".dio")):
        return "drawio"
    head = text[:4000]
    if re.search(r"##? Drawing\s*\n```", text):
        return "excalidraw"
    if "<mxfile" in head or "<mxGraphModel" in head or (low.endswith(".svg") and ' content="' in head):
        return "drawio"
    raise CliError(f"対応していない形式です: {name} (対応: {', '.join(DIAGRAM_SUFFIXES)})")


def load_diagrams(path: Path, page: str | None) -> tuple[str, list[tuple[str, dict[str, Any]]]]:
    text = path.read_text(encoding="utf-8-sig")
    fmt = detect_format(path.name, text)
    try:
        if fmt == "excalidraw":
            return fmt, [("", load_excalidraw.load_drawing(text, path.name))]
        pages = load_drawio.load_pages(text, path.name)
    except (load_excalidraw.ReadError, load_drawio.DrawioError) as exc:
        raise CliError(str(exc)) from exc
    if page:
        picked = [(i, p) for i, p in enumerate(pages, 1) if page == str(i) or page == p[0]]
        if not picked:
            raise CliError(f"ページが見つかりません: {page} (あるページ: {', '.join(f'{i}「{n}」' for i, (n, _) in enumerate(pages, 1))})")
        return fmt, [(f"{picked[0][0]}/{len(pages)}「{picked[0][1][0]}」", picked[0][1][1])]
    if len(pages) == 1:
        return fmt, [("", pages[0][1])]
    return fmt, [(f"{i}/{len(pages)}「{n}」", d) for i, (n, d) in enumerate(pages, 1)]


def check_out_path(raw: str, cwd: Path) -> Path:
    """--out は、作業フォルダ直下の .handoff/ の中で、まだ無い場所だけを許す。
    `..` やリンクを解いた後の場所で判定する (`.handoff/../../x` のように、外へ出る指定を拒否する)。"""
    path = Path(raw)
    path = path if path.is_absolute() else cwd / path
    base = Path(os.path.realpath(cwd / ".handoff"))
    target = Path(os.path.realpath(path.parent)) / path.name
    if path.name in ("", ".", "..") or not is_within(target.parent, base):
        raise CliError("--out は、作業フォルダ直下の .handoff フォルダの中だけ指定できます (例: .handoff/図の説明.md)")
    if target.exists() or path.exists():
        raise CliError(f"'{raw}' はすでにあります。別の名前にしてください")
    return target


def ai_diagram_notice(path: Path) -> str:
    """ハーネスが作った図 (frontmatter に ai_generated があり、ai_reviewed が true でない) なら、注意の 1 行を返す。"""
    head = path.read_text(encoding="utf-8-sig", errors="replace")[:4096]
    if not head.startswith("---"):
        return ""
    end = head.find("\n---", 3)
    front = head[3:end] if end != -1 else ""
    if not re.search(r"(?m)^ai_generated:[ \t]*\S", front) or re.search(r"(?mi)^ai_reviewed:[ \t]*(true|yes)[ \t\r]*$", front):
        return ""
    return "注意: AI が作った図です (未レビュー)。人が ai_reviewed を ✓ にするまで、図の内容を根拠にしない (原典で確かめる)\n"


def cmd_describe(args: argparse.Namespace, cwd: Path, out: TextIO) -> int:
    path = resolve_input(args.file, cwd)
    fmt, pages = load_diagrams(path, args.page)
    notice = ai_diagram_notice(path).rstrip("\n")
    chunks = [("%% " + notice) if notice and args.format == "mermaid" else notice] if notice else []  # Mermaid では注釈の行にする
    for page_label, doc in pages:
        name = path.name + (f" (draw.io ページ {page_label})" if page_label else (" (draw.io)" if fmt == "drawio" else ""))
        diagram = model.analyze(doc, name)
        if not diagram.items and not diagram.free_texts:
            chunks.append(f"図の読み取り: {name}\n概要: 空の図です (要素がありません)\n")
        elif args.format == "mermaid":
            chunks.append(("%% " + name + "\n" if len(pages) > 1 else "") + model.describe_mermaid(diagram))
        else:
            chunks.append(model.describe_text(diagram, args.full, args.max_lines))
    text = "\n".join(chunks)
    if args.out:
        target = check_out_path(args.out, cwd)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8", newline="\n")
        shown = target.relative_to(cwd.resolve()).as_posix() if is_within(target.resolve(), cwd.resolve()) else str(target)
        out.write(f"出力: {shown} ({len(text.splitlines())} 行, {len(text)} 文字)\n")
    else:
        out.write(text)
    return 0


LINK_RE = re.compile(r"!?\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]")


def cmd_links(args: argparse.Namespace, cwd: Path, out: TextIO) -> int:
    note = resolve_input(args.note, cwd)
    names = []
    for match in LINK_RE.finditer(note.read_text(encoding="utf-8-sig")):
        name = match.group(1).strip()
        low = name.lower()
        if low.endswith(".excalidraw"):
            name += ".md"
        if name.lower().endswith(DIAGRAM_SUFFIXES):
            names.append(name)
    names = list(dict.fromkeys(names))
    if not names:
        out.write(f"{note.name}: 図 (Excalidraw / draw.io) の埋め込み・リンクはありません\n")
        return 0
    root = (find_vault(cwd) or cwd).resolve()
    found: dict[str, list[Path]] = {n.lower(): [] for n in names}
    for directory, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d != "node_modules"]
        for filename in filenames:
            if filename.lower() in found:
                found[filename.lower()].append(Path(directory) / filename)
    out.write(f"{note.name}: 図 {len(names)} 個\n")
    for name in names:
        hits = found[name.lower()]
        if not hits:
            out.write(f"  {name}: Vault の中に見つかりません\n")
        for hit in hits[:3]:
            out.write(f"  {name}: {hit.relative_to(root).as_posix()}\n")
        if len(hits) > 3:
            out.write(f"  {name}: ほか {len(hits) - 3} 個 (同名)\n")
    out.write("中身は、`run.bat describe <パス>` で、文章にして読む\n")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="diagram_cli", description="図 (Excalidraw / draw.io) を、文章にして読む (読み取り専用)")
    sub = parser.add_subparsers(dest="command", required=True)
    describe = sub.add_parser("describe", help="図を、文章 (または Mermaid) にして読む")
    describe.add_argument("file")
    describe.add_argument("--format", choices=("text", "mermaid"), default="text")
    describe.add_argument("--page", help="draw.io: 読むページ (番号か名前)。省略すると、全ページ")
    describe.add_argument("--full", action="store_true", help="長い文字を省略しない")
    describe.add_argument("--max-lines", type=int, default=220)
    describe.add_argument("--out", help=".handoff/ の中のファイルに書く")
    links = sub.add_parser("links", help="ノートに埋め込まれた図の場所を調べる")
    links.add_argument("note")
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
        return cmd_describe(args, work, out) if args.command == "describe" else cmd_links(args, work, out)
    except CliError as exc:
        err.write(f"エラー: {exc}\n")
        return 2
    except OSError as exc:
        err.write(f"エラー: ファイルを読み書きできません (他のアプリで開いている可能性があります): {exc}\n")
        return 2


if __name__ == "__main__":
    sys.exit(main())
