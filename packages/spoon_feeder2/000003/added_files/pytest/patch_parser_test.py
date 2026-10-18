"""AI出力の解析(patch_parser)とC#シンボル走査(csharp_symbols)の統合テスト。"""

from __future__ import annotations

import ast
import time

from backend.csharp_symbols import scan_csharp_symbols
from backend.patch_parser import _normalize_ai_code, parse_ai_output


def test_文字列リテラル内の物理改行はエスケープされる():
    broken = 'message = "line1\nline2"\n'
    normalized = _normalize_ai_code(broken)
    assert normalized == 'message = "line1\\nline2"\n'
    ast.parse(normalized)


def test_docstring内の改行は維持される():
    code = 'def f():\n    """説明\n    続き"""\n    return 1\n'
    assert _normalize_ai_code(code) == code


def test_コメント内のクォートは文字列開始と誤認しない():
    code = "# it's a comment\nvalue = 'a\nb'\n"
    assert _normalize_ai_code(code) == "# it's a comment\nvalue = 'a\\nb'\n"


def test_接頭辞付き文字列の物理改行もエスケープされる():
    assert _normalize_ai_code('x = f"a\nb"\ny = rb"c\nd"\n') == 'x = f"a\\nb"\ny = rb"c\\nd"\n'


def test_大きな入力でも数秒以内に正規化できる():
    code = "".join(f"value_{i} = 'text {i}'\n" for i in range(60000))
    started = time.monotonic()
    assert _normalize_ai_code(code) == code
    assert time.monotonic() - started < 3


def test_言語タグなしブロックはPython関数を優先して解釈する():
    changes = parse_ai_output("```\ndef total(a, b):\n    return a + b\n```")
    assert [(c.language, c.symbol, c.signature) for c in changes] == [("python", "total", "a,b")]


def test_言語タグなしブロックはPythonに該当しなければC_メソッドを解釈する():
    changes = parse_ai_output("```\npublic int Add(int a, int b) { return a + b; }\n```")
    assert [(c.language, c.symbol) for c in changes] == [("csharp", "Add")]


def test_パス付きブロックでシンボルがなければファイル全文置換になる():
    changes = parse_ai_output("```json path: config/app.json\n{\"a\": 1}\n```")
    assert (changes[0].path, changes[0].symbol, changes[0].action) == ("config/app.json", "", "modify")


def test_Markdownブロック内のネストしたコードフェンスを含めて全文を取得する():
    output = "```markdown path: docs/guide.md\n# 手順\n```bash\nls\n```\n終わり\n```\n"
    changes = parse_ai_output(output)
    assert changes[0].path == "docs/guide.md"
    assert changes[0].content == "# 手順\n```bash\nls\n```\n終わり\n"


def test_統合マークダウン見出し形式を複数ファイルに分割する():
    output = "# ===== [ファイル 1/2] docs/a.md =====\nA\n# ===== [ファイル 2/2] docs/b.md =====\nB\n"
    assert [(c.path, c.content) for c in parse_ai_output(output)] == [("docs/a.md", "A\n"), ("docs/b.md", "B\n")]


def test_C_シンボル走査は文字列とコメント中の波括弧を無視する():
    source = 'public class A { string s = "}"; // }\n void M() { } }\npublic static int Free(int x) { return x; }\n'
    symbols = {symbol.name: source[symbol.start:symbol.end] for symbol in scan_csharp_symbols(source)}
    assert symbols["A"].endswith("void M() { } }")
    assert symbols["Free"] == "public static int Free(int x) { return x; }"


def test_C_シンボル走査は式形式メンバーを検出して引数の空白を正規化する():
    source = "public int Twice(int   x,\n int y) => x * 2;\n"
    (symbol,) = scan_csharp_symbols(source)
    assert (symbol.name, symbol.signature) == ("Twice", "int x, int y")
