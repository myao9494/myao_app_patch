"""AI_work の動作確認と、今日の日付 (自動化の見本を兼ねる)。

使い方: run.bat [--json]
出力:   今日の日付・曜日・時刻、AI_work の場所、Python と .venv、ハーネスのスキル (browser-session・outlook-mail) の有無、
        自動化の数。何も変えない (読むだけ)。
用途:   ランチャー → opencode → スキル → Python の流れが通るかの確認。エージェントが「今日」「明日」を日付にするときの基準。
"""
from __future__ import annotations

import argparse
import json
import platform
import sys
from datetime import datetime
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parents[1]
AI_WORK = SKILL_DIR.parents[2]
WEEKDAYS = "月火水木金土日"
HARNESS_SKILLS = ("browser-session", "outlook-mail", "calc-check", "doc-convert")


def collect(now: datetime, ai_work: Path, harness: Path) -> dict:
    """確認の結果を辞書で返す (表示とテストで共通)。now・ai_work・harness は、テストで差し替えられるように引数にする。"""
    skills = ai_work / ".opencode" / "skills"
    automations = sorted(p.name for p in skills.iterdir() if p.is_dir() and (p / "SKILL.md").is_file()) if skills.is_dir() else []
    return {
        "今日": now.strftime("%Y-%m-%d"),
        "曜日": WEEKDAYS[now.weekday()],
        "時刻": now.strftime("%H:%M"),
        "AI_work": str(ai_work),
        "AGENTS.md": (ai_work / "AGENTS.md").is_file(),
        "Python": f"{platform.python_version()} ({sys.executable})",
        ".venv": (ai_work / ".venv").is_dir(),
        "ハーネス": str(harness),
        "ハーネスのスキル": {name: (harness / "skills" / name / "SKILL.md").is_file() for name in HARNESS_SKILLS},
        "自動化": [name for name in automations if name not in ("automation-builder", "env-check")],
    }


def render(info: dict) -> str:
    """人が読む形にする。"""
    mark = lambda ok: "あり" if ok else "なし"  # noqa: E731
    lines = [
        f"今日: {info['今日']} ({info['曜日']}) {info['時刻']}",
        f"AI_work: {info['AI_work']} (AGENTS.md {mark(info['AGENTS.md'])})",
        f"Python: {info['Python']} / .venv {mark(info['.venv'])}",
        f"ハーネス: {info['ハーネス']}",
        *[f"  - {name}: {mark(ok)}" for name, ok in info["ハーネスのスキル"].items()],
        f"自動化: {len(info['自動化'])} 個 {' '.join(info['自動化'])}".rstrip(),
    ]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="AI_work の動作確認と、今日の日付")
    parser.add_argument("--json", action="store_true", help="JSON で出す")
    args = parser.parse_args(argv)
    info = collect(datetime.now(), AI_WORK, Path.home() / ".config" / "opencode")
    sys.stdout.write(json.dumps(info, ensure_ascii=False, indent=2) + "\n" if args.json else render(info))
    return 0


if __name__ == "__main__":
    sys.exit(main())
