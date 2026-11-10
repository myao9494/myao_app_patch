"""プロジェクトのフォルダに、ハーネス用の最小のファイルを置く (スキル project-init から呼ぶ)。

  check <フォルダ>                         : いまの状態と、フォルダの中身 (ファイルの種類・手がかり) と、テンプレートの推奨を表示する (何も書かない)
  draft <フォルダ> --template 種類 [--name]  : テンプレートを、フォルダの .handoff/project-init_AGENTS.md に書き出す (エージェントが【 】を埋める下書き)
  plan  <フォルダ> (--agents-file 下書き | --template 種類) : apply が何をするかを表示する (何も書かない)
  apply <フォルダ> (--agents-file 下書き | --template 種類) : 置く

テンプレートの種類 (templates/project/<種類>/AGENTS.md):
  coding   プログラム・設計計算・解析 (Python が中心)
  csharp   C# (.NET) のプログラム (設計計算・解析も)
  document 一般資料 (手順書・マニュアル・報告書・設計資料・調査のまとめ)

置くもの (足りないものだけ):
  1. AGENTS.md   下書き (--agents-file) か、テンプレート (--template) から。AGENTS.md または CLAUDE.md が既にあれば作らない
  2. .handoff/   サブエージェントの受け渡し用フォルダ
  3. .gitignore  .handoff/ .venv/ __pycache__/ の行を、足りないものだけ末尾に足す (追記のみ。無ければ作る)

守ること: 既存のファイルは上書きしない。削除しない。指定したフォルダの外には書かない。
git は、このスクリプトからは実行しない (他のプログラムを起動しない)。.git が無いフォルダの git init は、
スキルの手順に従って、エージェントが、plan の承認を得てから実行する。ネットワークも使わない。標準ライブラリだけ。
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import TextIO

SKILL_DIR = Path(__file__).resolve().parents[1]
HARNESS_DIR = SKILL_DIR.parents[1]
TEMPLATE_KINDS = {
    "coding": "プログラム・設計計算・解析",
    "csharp": "C# (.NET) のプログラム",
    "document": "一般資料 (手順書・マニュアル・報告書・設計資料・調査のまとめ)",
}
DEFAULT_TEMPLATES = {kind: HARNESS_DIR / "templates" / "project" / kind / "AGENTS.md" for kind in TEMPLATE_KINDS}
DRAFT_NAME = "project-init_AGENTS.md"
PLACEHOLDER_RE = re.compile(r"【[^】\n]{1,200}】")
# 中身の調べ方 (読むのは名前だけ。中身は開かない)
SKIP_DIRS = {".git", ".handoff", ".venv", "venv", "node_modules", "__pycache__", "dist", "build", "obj", ".obsidian", ".trash", ".idea", ".vscode"}
MAX_SURVEY_FILES = 5000
MAX_SURVEY_DEPTH = 6
CODE_EXTS = {".py", ".ipynb", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".go", ".rs", ".rb", ".php",
             ".m", ".r", ".jl", ".f", ".f90", ".bas", ".vb", ".vba", ".sh", ".bat", ".ps1", ".sql", ".html", ".css", ".vue"}
MODEL_EXTS = {".inp", ".cdb", ".fem", ".nas", ".bdf", ".step", ".stp", ".igs", ".iges", ".stl", ".fcstd", ".mph", ".x_t", ".dxf", ".dwg"}
DOC_EXTS = {".md", ".txt", ".docx", ".doc", ".xlsx", ".xlsm", ".xls", ".pptx", ".ppt", ".pdf", ".csv", ".rtf", ".msg", ".eml", ".png", ".jpg", ".jpeg"}
CODE_MARKERS = {"package.json", "pyproject.toml", "requirements.txt", "requirements.in", "setup.py", "setup.cfg", "pipfile", "makefile", "cmakelists.txt",
                "cargo.toml", "go.mod", "pom.xml", "build.gradle", "tsconfig.json", "vite.config.ts", "vite.config.js"}
CSHARP_EXTS = {".cs", ".csx", ".razor", ".xaml"}
CSHARP_MARKER_EXTS = {".sln", ".slnx", ".csproj"}
CSHARP_MARKER_NAMES = {"global.json", "nuget.config", "directory.build.props", "directory.packages.props"}
README_NAMES = {"readme.md", "readme.txt", "readme", "claude.md", "agents.md"}
GITIGNORE_ENTRIES = [".handoff/", ".venv/", "__pycache__/"]
GITIGNORE_COMMENT = "# OpenCode のハーネスが使う場所 (project-init が追記)"
TITLE_PLACEHOLDER = "# 【プロジェクト名】"
MAX_TEMPLATE_BYTES = 200_000
MAX_GITIGNORE_BYTES = 2_000_000
SYSTEM_TOP_DIRS = {"windows", "program files", "program files (x86)", "programdata", "etc", "usr", "bin", "sbin", "system", "library", "dev", "proc", "boot"}


class InitError(Exception):
    """利用者に見せてよいメッセージ。"""


@dataclass
class Action:
    kind: str  # create_file / create_dir / append_lines / keep
    name: str
    detail: str
    lines: list[str] = field(default_factory=list)
    text: str = ""
    newline: str = "\n"
    needs_leading_newline: bool = False
    creates: bool = False  # append_lines で、ファイルを新しく作るとき True


@dataclass
class State:
    target: Path
    git: str
    git_ok: bool
    agents_md: str | None
    claude_md: str | None
    handoff: str
    gitignore: str
    warnings: list[str]
    actions: list[Action]


def is_within(path: Path, root: Path) -> bool:
    path_s, root_s = os.path.normcase(str(path)), os.path.normcase(str(root))
    return path_s == root_s or path_s.startswith(root_s.rstrip("\\/") + os.sep)


def same_path(a: Path, b: Path) -> bool:
    return os.path.normcase(str(a)) == os.path.normcase(str(b))


def resolve_target(raw: str, cwd: Path, home: Path, harness: Path) -> Path:
    """指定されたフォルダを検査して、実在する絶対パス (リンクをたどった先) を返す。"""
    if not raw.strip():
        raise InitError("フォルダが指定されていません")
    candidate = Path(raw)
    candidate = candidate if candidate.is_absolute() else cwd / candidate
    if not candidate.exists():
        raise InitError(f"フォルダがありません: {raw}")
    if not candidate.is_dir():
        raise InitError(f"フォルダではありません: {raw}")
    target = candidate.resolve()
    parts = [p.lower() for p in target.parts]
    if target.parent == target:
        raise InitError(f"ドライブやルートのフォルダには置きません: {target}")
    if same_path(target, home.resolve()):
        raise InitError(f"ホームフォルダそのものには置きません。プロジェクトのフォルダを指定してください: {target}")
    if is_within(target, harness.resolve()):
        raise InitError(f"ハーネス自身のフォルダ (またはその中) には置きません: {target}")
    if ".git" in parts:
        raise InitError(f".git の中には置きません: {target}")
    if len(parts) > 1 and parts[1] in SYSTEM_TOP_DIRS:
        raise InitError(f"システムのフォルダには置きません: {target}")
    return target


def find_git(target: Path) -> tuple[str, bool]:
    """(表示, 対象がリポジトリのルートか)。git は実行しない。.git があるかを見るだけ。"""
    if os.path.lexists(target / ".git"):
        return "あります (このフォルダがリポジトリのルート)", True
    for parent in target.parents:
        if os.path.lexists(parent / ".git"):
            return f"このフォルダは、リポジトリの途中です (ルートは {parent})", False
    return "Git で管理されていません (.git がありません)", False


def names_in(target: Path) -> dict[str, str]:
    """小文字の名前 -> 実際の名前。Windows では大文字小文字が区別されないため、揃えて探す。"""
    return {name.lower(): name for name in os.listdir(target)}


def detect_newline(data: bytes) -> str:
    return "\r\n" if b"\r\n" in data else "\n"


def entry_variants(entry: str) -> set[str]:
    bare = entry.rstrip("/")
    return {bare, bare + "/", "/" + bare, "/" + bare + "/", "**/" + bare, "**/" + bare + "/"}


def read_gitignore(path: Path) -> tuple[list[str], str, bool]:
    """(行, 改行の形, 末尾に改行があるか)。UTF-8 以外は触らない。"""
    if path.stat().st_size > MAX_GITIGNORE_BYTES:
        raise InitError(".gitignore が大きすぎます。触りません")
    data = path.read_bytes()
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise InitError(".gitignore が UTF-8 ではありません。触りません (人間が足してください)") from exc
    return text.splitlines(), detect_newline(data), (data.endswith(b"\n") or not data)


@dataclass
class Survey:
    files: int = 0
    code: int = 0
    model: int = 0
    doc: int = 0
    csharp: int = 0  # code のうち、C# のファイル (.cs など) の数
    markers: list[str] = field(default_factory=list)
    csharp_markers: list[str] = field(default_factory=list)
    readmes: list[str] = field(default_factory=list)
    top: list[str] = field(default_factory=list)
    truncated: bool = False

    def suggestion(self) -> tuple[str | None, str]:
        """(推奨の種類, 理由)。決められなければ (None, 理由)。"""
        if not self.files:
            return None, "中身がありません。インタビューで決める"
        other_code = self.code - self.csharp
        if (self.csharp_markers or self.csharp) and self.csharp >= other_code:
            clues = self.csharp_markers[:4] or [f".cs など {self.csharp} 個"]
            return "csharp", "C# の手がかり (" + ", ".join(clues) + ") があります"
        if self.markers:
            return "coding", "プログラムの手がかり (" + ", ".join(self.markers[:4]) + ") があります"
        if self.code + self.model >= max(1, (self.code + self.model + self.doc) // 5):
            return "coding", f"プログラム {self.code} 個・モデル {self.model} 個が、資料 {self.doc} 個に比べて多い"
        if self.doc:
            return "document", f"資料 {self.doc} 個が中心で、プログラムの手がかりがありません"
        return None, "種類の分からないファイルだけです。インタビューで決める"


def survey(target: Path) -> Survey:
    """フォルダの中身を、名前と拡張子だけで調べる (ファイルは開かない)。"""
    result = Survey()
    result.top = sorted(name + ("/" if (target / name).is_dir() else "") for name in os.listdir(target) if name.lower() not in SKIP_DIRS)[:30]
    base_depth = len(target.parts)
    for root, dirs, files in os.walk(target):
        root_path = Path(root)
        dirs[:] = sorted(d for d in dirs if d.lower() not in SKIP_DIRS and not (root_path / d).is_symlink() and len(root_path.parts) - base_depth < MAX_SURVEY_DEPTH)
        for name in sorted(files):
            if result.files >= MAX_SURVEY_FILES:
                result.truncated = True
                return result
            lower = name.lower()
            result.files += 1
            rel = (root_path / name).relative_to(target).as_posix()
            if lower in CODE_MARKERS and rel not in result.markers:
                result.markers.append(rel)
            if lower in README_NAMES and len(result.readmes) < 10:
                result.readmes.append(rel)
            suffix = Path(lower).suffix
            if (lower in CSHARP_MARKER_NAMES or suffix in CSHARP_MARKER_EXTS) and rel not in result.csharp_markers:
                result.csharp_markers.append(rel)
            if suffix in CODE_EXTS or suffix in CSHARP_EXTS:
                result.code += 1
                if suffix in CSHARP_EXTS:
                    result.csharp += 1
            elif suffix in MODEL_EXTS:
                result.model += 1
            elif suffix in DOC_EXTS:
                result.doc += 1
    return result


def placeholders(text: str) -> list[str]:
    """埋まっていない【 】 (重複なし、出てきた順)。"""
    return list(dict.fromkeys(PLACEHOLDER_RE.findall(text)))


def load_agents_file(raw: str, cwd: Path, target: Path) -> str:
    """インタビューで【 】を埋めた下書き。UTF-8 の Markdown で、見出し (# ) がある。"""
    path = Path(raw)
    path = (path if path.is_absolute() else cwd / path)
    if not path.is_file():
        path = target / raw if not Path(raw).is_absolute() else path
    if not path.is_file():
        raise InitError(f"下書きがありません: {raw}")
    if path.stat().st_size > MAX_TEMPLATE_BYTES:
        raise InitError("下書きが大きすぎます")
    try:
        text = path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError as exc:
        raise InitError("下書きが UTF-8 ではありません") from exc
    if not re.search(r"(?m)^# \S", text):
        raise InitError("下書きに見出し (# プロジェクト名) がありません")
    return text


def load_template(template: Path, name: str | None) -> str:
    if not template.is_file():
        raise InitError(f"テンプレートがありません: {template}")
    if template.stat().st_size > MAX_TEMPLATE_BYTES:
        raise InitError("テンプレートが大きすぎます")
    text = template.read_text(encoding="utf-8-sig")
    if name:
        title = name.strip()
        if not title or "\n" in title or "\r" in title or len(title) > 100:
            raise InitError("--name は、1 行で 100 文字以内にしてください")
        if TITLE_PLACEHOLDER not in text:
            raise InitError("テンプレートに、プロジェクト名の行 (# 【プロジェクト名】) がありません")
        text = text.replace(TITLE_PLACEHOLDER, f"# {title}", 1)
    return text


def inspect(target: Path, agents_text: str | None, source: str) -> State:
    git_text, git_ok = find_git(target)
    warnings: list[str] = []
    if not git_ok:
        if git_text.startswith("Git で管理されていません"):
            warnings.append("Git のルートではありません。この設計は Git での管理が前提です。git init は、このスクリプトでは実行しません (スキルの手順で、エージェントが承認を得てから実行します)")
        else:
            warnings.append("Git のルートではありません。リポジトリの途中なので git init はしません (入れ子のリポジトリになるため)。ルートを指定し直してください")
    actions: list[Action] = []
    names = names_in(target)

    agents = names.get("agents.md")
    claude = names.get("claude.md")
    if agents:
        actions.append(Action("keep", "AGENTS.md", f"あります ({agents})。触りません"))
    elif claude:
        actions.append(Action("keep", "AGENTS.md", f"作りません。{claude} があり、共通ルールが CLAUDE.md を最初に読むため (指示を 1 か所にしておく)"))
    elif agents_text is None:
        actions.append(Action("keep", "AGENTS.md", "ありません。テンプレートを選んで作る (check の推奨を見て、draft で下書きを作り、plan / apply に --agents-file で渡す)"))
    else:
        left = placeholders(agents_text)
        detail = f"{source}から作る ({len(agents_text):,} 文字)"
        if left:
            detail += f"。埋まっていない【 】が {len(left)} 個: " + "、".join(left[:5]) + (" ほか" if len(left) > 5 else "")
            warnings.append(f"AGENTS.md に、埋まっていない【 】が {len(left)} 個あります。インタビューで埋めるか、使わない行を消してから置く")
        if agents_text.lstrip().startswith("<!--"):
            warnings.append("AGENTS.md の先頭に、テンプレートの説明のコメント (<!-- … -->) が残っています。置く前に消す")
        actions.append(Action("create_file", "AGENTS.md", detail, text=agents_text))

    handoff_path = target / ".handoff"
    if os.path.lexists(handoff_path):
        if handoff_path.is_symlink() or not handoff_path.is_dir():
            actions.append(Action("keep", ".handoff/", "フォルダではない (またはリンク) ため、触りません。確認してください"))
            warnings.append(".handoff がフォルダではありません。サブエージェントの結果が書けない恐れがあります")
        else:
            actions.append(Action("keep", ".handoff/", "あります"))
    else:
        actions.append(Action("create_dir", ".handoff/", "作る"))

    gi_path = target / ".gitignore"
    gi_name = names.get(".gitignore")
    if gi_name:
        gi_path = target / gi_name
    if os.path.lexists(gi_path):
        if gi_path.is_symlink() or not gi_path.is_file():
            actions.append(Action("keep", ".gitignore", "ファイルではない (またはリンク) ため、触りません。確認してください"))
        else:
            lines, newline, ends_nl = read_gitignore(gi_path)
            present = {ln.strip() for ln in lines if ln.strip() and not ln.lstrip().startswith("#")}
            negated = {ln.strip()[1:] for ln in present if ln.strip().startswith("!")}
            missing: list[str] = []
            for entry in GITIGNORE_ENTRIES:
                variants = entry_variants(entry)
                if present & variants:
                    continue
                if negated & variants:
                    warnings.append(f".gitignore に、{entry} を除外しない行 (!…) があります。足さずに、確認してください")
                    continue
                missing.append(entry)
            if missing:
                actions.append(Action("append_lines", ".gitignore", "末尾に足す: " + " ".join(missing), lines=missing, newline=newline, needs_leading_newline=not ends_nl))
            else:
                actions.append(Action("keep", ".gitignore", f"必要な行が揃っています ({' '.join(GITIGNORE_ENTRIES)})"))
    else:
        actions.append(Action("append_lines", ".gitignore", "作る: " + " ".join(GITIGNORE_ENTRIES), lines=list(GITIGNORE_ENTRIES), creates=True))

    return State(target, git_text, git_ok, agents, claude, "あります" if os.path.lexists(handoff_path) else "ありません", "あります" if os.path.lexists(gi_path) else "ありません", warnings, actions)


def ensure_handoff(target: Path) -> None:
    """.handoff/ が無ければ作る (draft と apply の両方で使う)。"""
    path = target / ".handoff"
    if os.path.lexists(path):
        if path.is_symlink() or not path.is_dir():
            raise InitError(".handoff がフォルダではありません。触りません")
        return
    path.mkdir()


def write_draft(target: Path, text: str) -> Path:
    """下書きを .handoff/ に、上書きせずに書く (同じ名前があれば _2、_3)。"""
    ensure_handoff(target)
    stem, suffix = DRAFT_NAME.rsplit(".", 1)
    for number in range(1, 100):
        path = target / ".handoff" / (DRAFT_NAME if number == 1 else f"{stem}_{number}.{suffix}")
        if not os.path.lexists(path):
            create_new_file(path, text)
            return path
    raise InitError("下書きが多すぎます。.handoff/ を整理してください")


def create_new_file(path: Path, text: str) -> None:
    """排他的に作る。既にあれば失敗する (上書きしない)。"""
    with open(path, "x", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def append_to_file(path: Path, data: bytes) -> None:
    with open(path, "ab") as handle:
        handle.write(data)


def execute(state: State, out: TextIO) -> int:
    done = 0
    for action in state.actions:
        if action.kind == "create_file":
            create_new_file(state.target / action.name, action.text)
            out.write(f"作りました: {action.name}\n")
            done += 1
        elif action.kind == "create_dir":
            ensure_handoff(state.target)
            out.write(f"作りました: {action.name}\n")
            done += 1
        elif action.kind == "append_lines":
            path = state.target / ".gitignore"
            nl = action.newline
            if not action.creates:
                names = names_in(state.target)
                path = state.target / names[".gitignore"]
                block = ([""] if action.needs_leading_newline else []) + [GITIGNORE_COMMENT] + action.lines
                append_to_file(path, (nl.join(block) + nl).encode("utf-8"))
                out.write(f"足しました: .gitignore に {' '.join(action.lines)}\n")
            else:
                create_new_file(path, "\n".join([GITIGNORE_COMMENT] + action.lines) + "\n")
                out.write(f"作りました: .gitignore ({' '.join(action.lines)})\n")
            done += 1
        else:
            out.write(f"そのまま: {action.name} ({action.detail})\n")
    if not done:
        out.write("何もする必要がありません\n")
    return done


def show_state(state: State, out: TextIO) -> None:
    out.write(f"フォルダ: {state.target}\n")
    out.write(f"Git: {state.git}\n")
    out.write(f"AGENTS.md: {'あります' if state.agents_md else 'ありません'} / CLAUDE.md: {'あります' if state.claude_md else 'ありません'}\n")
    out.write(f".handoff/: {state.handoff} / .gitignore: {state.gitignore}\n")
    for warning in state.warnings:
        out.write(f"注意: {warning}\n")


def show_survey(result: Survey, out: TextIO) -> None:
    kind, reason = result.suggestion()
    more = " 以上 (途中まで数えた)" if result.truncated else ""
    out.write(f"中身: ファイル {result.files} 個{more} (プログラム {result.code}、モデル {result.model}、資料 {result.doc})\n")
    if result.top:
        out.write("  一番上: " + "  ".join(result.top) + "\n")
    if result.markers:
        out.write("  プログラムの手がかり: " + ", ".join(result.markers[:8]) + "\n")
    if result.csharp_markers:
        out.write("  C# の手がかり: " + ", ".join(result.csharp_markers[:8]) + "\n")
    if result.readmes:
        out.write("  先に読む: " + ", ".join(result.readmes) + "\n")
    out.write(f"テンプレートの推奨: {kind + ' (' + TEMPLATE_KINDS[kind] + ')' if kind else 'なし'} — {reason}\n")
    out.write("テンプレート: " + " / ".join(f"{k} ({v})" for k, v in TEMPLATE_KINDS.items()) + "\n")


def show_plan(state: State, out: TextIO) -> None:
    labels = {"create_file": "作る", "create_dir": "作る", "append_lines": "足す", "keep": "そのまま"}
    for action in state.actions:
        label = "作る" if action.creates else labels[action.kind]
        out.write(f"  [{label}] {action.name}: {action.detail}\n")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="project_init", description="プロジェクトのフォルダに、AGENTS.md・.handoff/・.gitignore の行を置く (上書き・削除はしない)")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("check", help="状態と中身を調べ、テンプレートを推奨する (何も書かない)")
    p.add_argument("folder", help="プロジェクトのフォルダ")
    p = sub.add_parser("draft", help="テンプレートを .handoff/ に下書きとして書き出す (【 】を埋めるため)")
    p.add_argument("folder", help="プロジェクトのフォルダ")
    p.add_argument("--template", required=True, choices=sorted(TEMPLATE_KINDS), help="テンプレートの種類")
    p.add_argument("--name", help="見出しに入れるプロジェクト名")
    for command, text in (("plan", "置く内容を表示する (何も書かない)"), ("apply", "置く")):
        p = sub.add_parser(command, help=text)
        p.add_argument("folder", help="プロジェクトのフォルダ")
        group = p.add_mutually_exclusive_group()
        group.add_argument("--agents-file", help="【 】を埋めた AGENTS.md の下書き (draft で作ったもの)")
        group.add_argument("--template", choices=sorted(TEMPLATE_KINDS), help="下書きを使わず、テンプレートのまま置く")
        p.add_argument("--name", help="--template のとき、見出しに入れるプロジェクト名")
    return parser


def main(argv: list[str] | None = None, stdout: TextIO | None = None, stderr: TextIO | None = None, cwd: Path | None = None,
         templates: dict[str, Path] | None = None, home: Path | None = None, harness: Path | None = None) -> int:
    out = stdout or sys.stdout
    err = stderr or sys.stderr
    if stdout is None:
        for stream in (sys.stdout, sys.stderr):
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8")  # Windows の標準出力の文字化けを防ぐ
    args = build_parser().parse_args(argv)
    work = (cwd or Path.cwd()).resolve()
    try:
        target = resolve_target(args.folder, work, home or Path.home(), harness or HARNESS_DIR)
        kinds = templates or DEFAULT_TEMPLATES
        if args.command == "draft":
            names = names_in(target)
            if "agents.md" in names or "claude.md" in names:
                raise InitError(f"{names.get('agents.md') or names.get('claude.md')} があります。AGENTS.md は作らないので、下書きも作りません")
            path = write_draft(target, load_template(kinds[args.template], args.name))
            left = placeholders(path.read_text(encoding="utf-8"))
            out.write(f"下書きを作りました: {path}\n")
            out.write(f"テンプレート: {args.template} ({TEMPLATE_KINDS[args.template]})\n")
            out.write(f"埋める【 】: {len(left)} 個\n" + "".join(f"  {item}\n" for item in left))
            out.write("中身とインタビューの答えで【 】を埋め、使わない行・節と、先頭の説明のコメントを消してから、plan --agents-file で確かめる\n")
            return 0
        agents_text: str | None = None
        source = ""
        if args.command in ("plan", "apply"):
            if args.agents_file:
                if args.name:
                    raise InitError("--name は --template と一緒に使う (下書きでは、見出しを直接書く)")
                agents_text, source = load_agents_file(args.agents_file, work, target), "下書き"
            elif args.template:
                agents_text, source = load_template(kinds[args.template], args.name), f"テンプレート {args.template} "
        state = inspect(target, agents_text, source)
        if args.command == "check":
            show_state(state, out)
            if not (state.agents_md or state.claude_md):
                show_survey(survey(target), out)
            todo = [a for a in state.actions if a.kind != "keep" or (a.name == "AGENTS.md" and not (state.agents_md or state.claude_md))]
            out.write("足りないもの: " + (", ".join(a.name for a in todo) if todo else "なし") + "\n")
            return 0
        needs_agents = not (state.agents_md or state.claude_md)
        if needs_agents and agents_text is None:
            raise InitError("AGENTS.md の元を指定してください: --agents-file <draft で作って【 】を埋めた下書き> (勧める) か --template "
                            + " / ".join(f"{k} ({v})" for k, v in TEMPLATE_KINDS.items()))
        if args.command == "plan":
            show_state(state, out)
            out.write("apply で行うこと:\n")
            show_plan(state, out)
            out.write("実際には何も書いていません\n")
            return 0
        show_state(state, out)
        execute(state, out)
        created = next((a for a in state.actions if a.kind == "create_file"), None)
        left = placeholders(created.text) if created else []
        out.write("削除・上書きはしていません" + (f"。AGENTS.md に、埋まっていない【 】が {len(left)} 個残っています" if left else "") + "\n")
        return 0
    except InitError as exc:
        err.write(f"エラー: {exc}\n")
        return 2
    except FileExistsError as exc:
        err.write(f"エラー: 直前に同じ名前のものができました。上書きせずに止めました: {exc}\n")
        return 2
    except OSError as exc:
        err.write(f"エラー: ファイルを読み書きできません (他のアプリで開いている可能性があります): {exc}\n")
        return 2


if __name__ == "__main__":
    sys.exit(main())
