"""AI_work の自動化 (1 つ = .opencode/skills/<名前>/ のスキル) のひな形を置く・一覧にする (スキル automation-builder から呼ぶ)。

  new   <名前> --title 題名 --kind python|browser|outlook [--dry-run] : ひな形を置く (既にあれば何も書かずにエラー)
  list                                                               : 自動化の一覧と、足りないもの (一覧への記載、テスト、設定) を表示する
  slash <名前> --command コマンド名 [--description 説明]              : ランチャーに登録するスラッシュコマンド (JSON 1 件) を表示する

共通の引数: --root AI_work のフォルダ (既定: このスクリプトから 4 つ上)
            --harness ハーネスのフォルダ (既定: ~/.config/opencode。同じ名前のスキルを作らないための確認に使う)

守ること: 既存のファイルを上書きしない。削除しない。AI_work の外に書かない。ネットワークを使わない。
他のプログラムを起動しない。標準ライブラリだけ。ランチャーへの登録は人が行う (このスクリプトは表示するだけ)。
終了コード: 0 成功、2 入力の誤り・既にある・見つからない
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import TextIO

# OpenCode のスキル名の決まり: 英小文字と数字を、1 つのハイフンでつなぐ。64 文字まで。フォルダ名と同じにする
NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
KINDS = ("python", "browser", "outlook")
BUILDER = "automation-builder"
INDEX_FILE = "自動化一覧.md"
DEFAULT_ROOT = Path(__file__).resolve().parents[4]  # AI_work/.opencode/skills/automation-builder/scripts/
DEFAULT_HARNESS = Path.home() / ".config" / "opencode"


class CliError(Exception):
    """入力の誤り。メッセージを表示して、終了コード 2 で終わる。"""


# ---------------------------------------------------------------- ひな形の中身

def skill_md(name: str, title: str, kind: str) -> str:
    """SKILL.md のひな形。【 】は、エージェントが聞き取りの結果で埋める。"""
    run = f"<このスキルのフォルダ>\\run.bat"
    steps = {
        "python": f"""1. 指示から入力を読み取る。足りない項目は、上の表の「無いとき」を使う。表に無い曖昧さがあるときだけ、1 回にまとめて聞く。
2. 確認の実行(何も変えない)。何をするかが表示される。

   ```
   {run} 【引数】 --dry-run
   ```

3. 【取り消せない操作があるときだけ: 2 の結果を示し、「実行して」と返事をもらってから進む。無ければ、この行を消す】
4. 実行する。

   ```
   {run} 【引数】
   ```

5. 報告する: したこと、しなかったこと、出力したファイル。""",
        "outlook": f"""1. 指示から入力を読み取る。足りない項目は、上の表の「無いとき」を使う。表に無い曖昧さがあるときだけ、1 回にまとめて聞く。
2. 予定の案を作る(何も変えない)。件名・開始・長さ・場所が表示される。

   ```
   {run} 【引数】 --dry-run
   ```

3. スキル `outlook-mail` を読み込み、案の 1 件ずつを `cal-create … --dry-run` で確かめる。
4. 案の一覧を示し、「実行して」と返事をもらう。**返事の前に、予定を作らない。**
5. `cal-create`(`--dry-run` なし)で作る。
6. 報告する: 作った予定、作らなかった予定と理由。""",
        "browser": f"""1. 指示から入力を読み取る。足りない項目は、上の表の「無いとき」を使う。表に無い曖昧さがあるときだけ、1 回にまとめて聞く。
2. ブラウザを用意する。スキル `browser-session` を読み込み、`start`(起動済みなら `status`)。ログインが要る画面なら、人にログインしてもらう(パスワードは入力しない)。
3. 送信の直前まで進める(何も確定しない)。最後に、何を送るかが表示される。

   ```
   {run} 【引数(先頭に - を付けない)】
   ```

4. 表示された内容を示し、「実行して」と返事をもらう。**返事の前に、送信しない。**
5. 送信する。`browser-session` の run.bat を直接、`--allow-submit` を付けて実行する(承認はこの 1 回だけ)。

   ```
   <browser-session のフォルダ>\\run.bat run .opencode\\skills\\{name}\\scripts\\flow.py --allow-submit 【引数】
   ```

6. 報告する: したこと、しなかったこと、画面に出た結果(`text` で読む)。""",
    }[kind]
    unsafe = {
        "python": "【無し / 有り(何を、どのスキルで行うか)】",
        "outlook": "予定の作成(`outlook-mail` の `cal-create`)。出席者を付けても招待は送られない。【ほかにあれば書く】",
        "browser": "【送信・申請・確定のボタン(名前を書く)】。`browser-session` の見張りが止める。押すのは、人の承認の後に `--allow-submit` で。",
    }[kind]
    return f"""---
name: {name}
description: {title}。【いつ使うかと、何が起きるかを 1 文で。モデルはこの文で自動化を選ぶ。例: 勤怠を入れてと頼まれたときに使う。勤怠システムに出勤と退勤を入力する】
---

# {title}

<!-- automation-builder が置いたひな形({kind})。【 】を埋め、使わない行は消す。このコメントも消す -->

## 何をするか

【入力 → 結果を 1〜3 行で】

## 入力(ランチャーの `/コマンド` の後ろに書く日本語)

| 項目 | 例 | 無いとき |
|---|---|---|
| 【日付】 | 今日、11/12 | 今日 |

## 手順

{steps}

## 取り消せない操作

{unsafe}

## 設定

このフォルダの `config.local.json`(`config.sample.json` を写して、人が書く。Git に入れない)。パスワードは書かない。

## 確かめたこと

| 日付 | 内容 | 結果 |
|---|---|---|
| 【YYYY-MM-DD】 | 【dry-run / 本番 1 回】 | 【】 |
"""


def run_bat(kind: str) -> str:
    """run.bat (ASCII だけ。日本語の Windows の cmd.exe が誤読しないため)。"""
    if kind == "browser":
        return "\r\n".join([
            "@echo off",
            "rem Run scripts\\flow.py in the working browser tab through the harness skill browser-session.",
            "rem --allow-submit is refused here. After the user approves, call browser-session run.bat directly.",
            "rem This file must stay ASCII only (cmd.exe on Japanese Windows may misread other characters).",
            "setlocal",
            'set "BS=%USERPROFILE%\\.config\\opencode\\skills\\browser-session\\run.bat"',
            'if not exist "%BS%" (',
            "  echo browser-session not found: %BS% 1>&2",
            "  exit /b 2",
            ")",
            'echo %* | findstr /i /c:"--allow-submit" >nul',
            "if not errorlevel 1 (",
            "  echo Refused: after approval, run browser-session run.bat directly with --allow-submit. 1>&2",
            "  exit /b 2",
            ")",
            'call "%BS%" run "%~dp0scripts\\flow.py" %*',
            "exit /b %ERRORLEVEL%",
            "",
        ])
    return "\r\n".join([
        "@echo off",
        "rem Run scripts\\main.py with the AI_work .venv (or python when there is no .venv).",
        "rem This file must stay ASCII only (cmd.exe on Japanese Windows may misread other characters).",
        "setlocal",
        'set "PY=%~dp0..\\..\\..\\.venv\\Scripts\\python.exe"',
        'if not exist "%PY%" set "PY=python"',
        '"%PY%" "%~dp0scripts\\main.py" %*',
        "exit /b %ERRORLEVEL%",
        "",
    ])


def run_sh(kind: str) -> str:
    """run.sh (Mac・Linux。ASCII、LF)。"""
    if kind == "browser":
        return "\n".join([
            "#!/bin/sh",
            "# Run scripts/flow.py through the harness skill browser-session (Mac / Linux). Same arguments as run.bat.",
            "# --allow-submit is refused here. After the user approves, call browser-session run.sh directly.",
            "# This file must stay ASCII only, with LF line endings.",
            'here=$(cd "$(dirname "$0")" && pwd -P)',
            'BS="$HOME/.config/opencode/skills/browser-session/run.sh"',
            '[ -f "$BS" ] || { echo "browser-session not found: $BS" >&2; exit 2; }',
            'for a in "$@"; do',
            '  [ "$a" = "--allow-submit" ] && { echo "Refused: after approval, run browser-session run.sh directly with --allow-submit." >&2; exit 2; }',
            "done",
            'exec sh "$BS" run "$here/scripts/flow.py" "$@"',
            "",
        ])
    return "\n".join([
        "#!/bin/sh",
        "# Run scripts/main.py with the AI_work .venv (Mac / Linux). Same arguments as run.bat.",
        "# This file must stay ASCII only, with LF line endings.",
        'here=$(cd "$(dirname "$0")" && pwd -P)',
        'PY="$here/../../../.venv/bin/python"',
        'if [ ! -x "$PY" ]; then',
        "  PY=python3",
        '  command -v "$PY" >/dev/null 2>&1 || PY=python',
        "fi",
        'exec "$PY" "$here/scripts/main.py" "$@"',
        "",
    ])


def main_py(title: str, kind: str) -> str:
    """scripts/main.py (python・outlook)。計算 (build_plan) と実行 (execute) を分け、計算をテストする。"""
    output = "予定の案 (件名・開始・長さ・場所) を JSON で表示する。予定は作らない (作るのは outlook-mail)" if kind == "outlook" else "【標準出力に結果。ファイルを作るなら AI_work の output/ の下】"
    return f'''"""{title}。

使い方: run.bat 【引数】 [--dry-run]
入力:   【引数の意味と単位】
出力:   {output}
--dry-run: 何をするかを表示するだけで、何も変えない。
設定:   このスキルのフォルダの config.local.json (無ければ config.sample.json)。パスワードは書かない。
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parents[1]
AI_WORK = SKILL_DIR.parents[2]
OUTPUT_DIR = AI_WORK / "output"


def load_config() -> dict:
    """config.local.json を読む。無ければ config.sample.json、それも無ければ空。"""
    for name in ("config.local.json", "config.sample.json"):
        path = SKILL_DIR / name
        if path.is_file():
            return json.loads(path.read_text(encoding="utf-8-sig"))
    return {{}}


def build_plan(target: str, config: dict, today: date) -> list[dict]:
    """何をするかの一覧を返す。ファイルも画面も変えない (テストはここを確かめる)。

    target: 指示から読み取った引数。today: 今日の日付 (テストで固定できるように、引数で受け取る)。
    """
    return [{{"する内容": f"【】 {{target}}", "日付": today.isoformat()}}]


def execute(plan: list[dict]) -> None:
    """一覧のとおりに実行する。【取り消せない操作は、ここに書かない。ハーネスのスキルの道具で行う】"""
    for step in plan:
        print("実行:", json.dumps(step, ensure_ascii=False))


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="{title}")
    parser.add_argument("target", nargs="?", default="", help="【引数の説明】")
    parser.add_argument("--dry-run", action="store_true", help="何をするかを表示するだけ")
    args = parser.parse_args(argv)
    plan = build_plan(args.target, load_config(), date.today())
    if args.dry_run:
        print(json.dumps(plan, ensure_ascii=False, indent=2))
        return 0
    execute(plan)
    return 0


if __name__ == "__main__":
    sys.exit(main())
'''


def test_py(name: str) -> str:
    """tests/test_main.py。build_plan を、日付を固定して確かめる。"""
    return f'''"""scripts/main.py のテスト。AI_work で実行する:
    python -m unittest discover -s .opencode/skills/{name}/tests
"""
from __future__ import annotations

import importlib.util
import unittest
from datetime import date
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "main.py"
spec = importlib.util.spec_from_file_location("{name.replace("-", "_")}_main", SCRIPT)
main = importlib.util.module_from_spec(spec)
spec.loader.exec_module(main)


class BuildPlanTests(unittest.TestCase):
    def test_今日の日付で案を作る(self) -> None:
        plan = main.build_plan("例", {{}}, date(2026, 1, 5))
        self.assertEqual(plan[0]["日付"], "2026-01-05")

    # 【入力の解釈・計算の例を足す。「明日」「9:00-18:00」のような指示の読み取りは、ここで確かめる】


if __name__ == "__main__":
    unittest.main()
'''


def flow_py(title: str) -> str:
    """scripts/flow.py (browser)。browser-session の run の中で動き、page と args が渡される。"""
    return f'''"""{title} (browser-session の run で、作業中のタブで動く。page と args が渡される)。

入力:   args (run.bat の後ろに書いた引数。先頭に - を付けない)
出力:   最後に、何を送るかを print する。【取り込んだデータは page.save_json(..., "名前.json") で .handoff/browser/ へ】
送信:   このスクリプトの送信のボタンは、見張りが止める。人の承認の後に、browser-session の run.bat を
        --allow-submit 付きで直接実行したときだけ押される。
書き方: スキル browser-session の「page でできること」。作るときは .handoff/browser/ に段階ごとのスクリプトを書いて試し、
        通しで動くようになったら、ここへまとめる。
"""
import json
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parents[1]
config = {{}}
for name in ("config.local.json", "config.sample.json"):
    if (SKILL_DIR / name).is_file():
        config = json.loads((SKILL_DIR / name).read_text(encoding="utf-8-sig"))
        break

page.goto(config.get("url") or "【開始のページの URL】")  # noqa: F821 (page は run から渡される)
page.wait_for(text="【画面に必ず出る文字】")  # noqa: F821
print(page.snapshot())  # noqa: F821  【画面を調べ終えたら消す】

# 【入力する】 page.fill("#date", args[0]) など
# 【送信】 page.click(text="【送信のボタンの文字】")  ← 承認の前は、見張りが止める (終了コード 4)
print("送る内容:", args)  # noqa: F821
'''


def config_sample(kind: str) -> str:
    data: dict[str, str] = {"_説明": "config.local.json に写して、人が書き換える。パスワードは書かない。Git に入れない"}
    if kind == "browser":
        data["url"] = ""
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def scaffold(name: str, title: str, kind: str) -> dict[str, str]:
    """置くファイル (スキルのフォルダからの相対パス → 中身)。"""
    files = {
        "SKILL.md": skill_md(name, title, kind),
        "run.bat": run_bat(kind),
        "run.sh": run_sh(kind),
        "config.sample.json": config_sample(kind),
    }
    if kind == "browser":
        files["scripts/flow.py"] = flow_py(title)
    else:
        files["scripts/main.py"] = main_py(title, kind)
        files["tests/test_main.py"] = test_py(name)
    return files


# ---------------------------------------------------------------- コマンド

def skills_dir(root: Path) -> Path:
    return root / ".opencode" / "skills"


def check_name(name: str, root: Path, harness: Path) -> None:
    """名前の決まりと、既存のスキル (AI_work とハーネス) との重複を確かめる。"""
    if not NAME_RE.match(name) or len(name) > 64:
        raise CliError(f"名前は、英小文字・数字をハイフンでつなぐ (例: kintai-input。64 文字まで): {name}")
    if (skills_dir(root) / name).exists():
        raise CliError(f"既にあります: .opencode/skills/{name}/ (直すときは、ファイルを直接直す。new は上書きしない)")
    if (harness / "skills" / name).exists():
        raise CliError(f"ハーネスに同じ名前のスキルがあります: {name}。別の名前にする")


def cmd_new(name: str, title: str, kind: str, dry_run: bool, root: Path, harness: Path, out: TextIO) -> int:
    if not title.strip():
        raise CliError("--title (日本語の題名) が空です")
    check_name(name, root, harness)
    target = skills_dir(root) / name
    files = scaffold(name, title.strip(), kind)
    for rel in files:
        out.write(f"{'置く予定' if dry_run else '置いた'}: .opencode/skills/{name}/{rel}\n")
    if dry_run:
        out.write("(--dry-run: 何も書いていません)\n")
        return 0
    for rel, text in files.items():
        path = target / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("x", encoding="utf-8", newline="") as fh:  # "x": 既にあれば失敗する (上書きしない)
            fh.write(text)
    out.write(f"次: SKILL.md の【 】を埋める → 中身を書く → {INDEX_FILE} に 1 行足す → slash でランチャーのコマンドを示す\n")
    return 0


def read_frontmatter(path: Path) -> dict[str, str]:
    """SKILL.md の先頭の --- で囲まれた部分から、`キー: 値` を読む (1 行の値だけ)。"""
    text = path.read_text(encoding="utf-8-sig")
    if not text.startswith("---"):
        return {}
    head = text.split("\n---", 1)[0]
    pairs = (line.split(":", 1) for line in head.splitlines()[1:] if ":" in line)
    return {key.strip(): value.strip() for key, value in pairs}


def automations(root: Path) -> list[Path]:
    """自動化のフォルダ (automation-builder を除く、SKILL.md のあるもの)。名前順。"""
    base = skills_dir(root)
    if not base.is_dir():
        return []
    return sorted(p for p in base.iterdir() if p.is_dir() and p.name != BUILDER and (p / "SKILL.md").is_file())


def problems_of(folder: Path, index_text: str) -> list[str]:
    """1 つの自動化について、足りないものを返す。"""
    meta = read_frontmatter(folder / "SKILL.md")
    found = []
    if meta.get("name") != folder.name:
        found.append(f"SKILL.md の name がフォルダ名と違う ({meta.get('name')})")
    if not meta.get("description") or "【" in meta.get("description", ""):
        found.append("description が空か、【 】が残っている")
    if "【" in (folder / "SKILL.md").read_text(encoding="utf-8-sig"):
        found.append("SKILL.md に【 】が残っている")
    if not (folder / "run.bat").is_file():
        found.append("run.bat が無い")
    if (folder / "scripts" / "main.py").is_file() and not any((folder / "tests").glob("test_*.py")):
        found.append("tests/ にテストが無い")
    if (folder / "config.sample.json").is_file() and not (folder / "config.local.json").is_file():
        found.append("config.local.json が無い (人が config.sample.json から作る。要らなければ無視)")
    if f"`{folder.name}`" not in index_text:
        found.append(f"{INDEX_FILE} に載っていない")
    return found


def cmd_list(root: Path, out: TextIO) -> int:
    index = root / INDEX_FILE
    index_text = index.read_text(encoding="utf-8-sig") if index.is_file() else ""
    items = automations(root)
    if not items:
        out.write("自動化はまだありません (.opencode/skills/ に、automation-builder のほかのスキルが無い)\n")
        return 0
    for folder in items:
        meta = read_frontmatter(folder / "SKILL.md")
        out.write(f"- {folder.name}: {meta.get('description', '(説明なし)')}\n")
        for problem in problems_of(folder, index_text):
            out.write(f"    要確認: {problem}\n")
    return 0


def cmd_slash(name: str, command: str, description: str, root: Path, out: TextIO) -> int:
    if not (skills_dir(root) / name / "SKILL.md").is_file():
        raise CliError(f"自動化が見つかりません: .opencode/skills/{name}/SKILL.md")
    command = command.strip().lstrip("/")
    if not command or re.search(r"[\s/]", command):
        raise CliError("コマンド名に空白と / は使えない (ランチャーの決まり)")
    if not description.strip():
        description = read_frontmatter(skills_dir(root) / name / "SKILL.md").get("description", "").split("。")[0]
    entry = {
        "name": command,
        "description": description.strip(),
        "prompt": f"スキル `{name}` を読み込み、その「手順」どおりに実行してください。取り消せない操作の前では止まって、私の返事を待ってください。指示: $ARGUMENTS",
    }
    out.write(json.dumps(entry, ensure_ascii=False, indent=2) + "\n")
    out.write(f"(ランチャーの「/ コマンド」で、名前 {command}・説明・プロンプトを登録する。登録は人が行う)\n")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AI_work の自動化のひな形と一覧")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT, help="AI_work のフォルダ")
    parser.add_argument("--harness", type=Path, default=DEFAULT_HARNESS, help="ハーネスのフォルダ (~/.config/opencode)")
    sub = parser.add_subparsers(dest="command", required=True)
    new = sub.add_parser("new", help="ひな形を置く")
    new.add_argument("name")
    new.add_argument("--title", required=True, help="日本語の題名 (例: 勤怠入力)")
    new.add_argument("--kind", choices=KINDS, required=True)
    new.add_argument("--dry-run", action="store_true")
    sub.add_parser("list", help="自動化の一覧と、足りないもの")
    slash = sub.add_parser("slash", help="ランチャーに登録するコマンドを表示する")
    slash.add_argument("name")
    slash.add_argument("--command", dest="slash_command", required=True, help="ランチャーのコマンド名 (先頭の / は不要)")
    slash.add_argument("--description", default="", help="候補に出る説明 (省略すると SKILL.md の description の最初の文)")
    return parser


def main(argv: list[str] | None = None, stdout: TextIO | None = None, stderr: TextIO | None = None) -> int:
    out = stdout or sys.stdout
    err = stderr or sys.stderr
    for stream in (out, err):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    args = build_parser().parse_args(argv)
    root = args.root.resolve()
    try:
        if args.command == "new":
            return cmd_new(args.name, args.title, args.kind, args.dry_run, root, args.harness, out)
        if args.command == "list":
            return cmd_list(root, out)
        return cmd_slash(args.name, args.slash_command, args.description, root, out)
    except CliError as exc:
        err.write(f"エラー: {exc}\n")
        return 2


if __name__ == "__main__":
    sys.exit(main())
