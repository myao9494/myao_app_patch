"""ハーネスの全テストを動かす (標準ライブラリだけ)。

  python run_tests.py

  - tests/            ハーネス全体の整合性テスト
  - skills/*/tests/   スキルごとのテスト (偽の Outlook、偽のサーバーを使う)
どれかが失敗したら、終了コード 1。ファイルを足す・直したら、運ぶ前に必ず通す。
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    suites = [ROOT / "tests", *sorted(ROOT.glob("skills/*/tests"))]
    failed = []
    env = {**os.environ, "PYTHONUTF8": "1"}
    for suite in suites:
        label = suite.relative_to(ROOT).as_posix()
        result = subprocess.run([sys.executable, "-B", "-m", "unittest", "discover", "-s", str(suite)], cwd=ROOT, env=env, capture_output=True, text=True, encoding="utf-8")
        tail = (result.stderr.strip().splitlines() or [""])[-1] if result.returncode == 0 else ""
        summary = next((line for line in reversed(result.stderr.splitlines()) if line.startswith("Ran ")), "")
        print(f"{'OK  ' if result.returncode == 0 else 'FAIL'} {label}  {summary} {tail if result.returncode else ''}".rstrip())
        if result.returncode != 0:
            failed.append(label)
            print(result.stderr[-3000:])
    print("\n全テスト成功" if not failed else f"\n失敗: {', '.join(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
