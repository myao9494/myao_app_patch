"""
OpenCode の応答（Markdown）を、ランチャーの小さなペインで表示するための簡易 Markdown 解析を検証する。
見出し・箇条書き・番号付き・引用・コードブロック・行内コード・太字だけを扱う。
"""

from launcher_app.markdown_lite import MdBlock, MdInline, parse_inlines, parse_markdown


def test_paragraphs_are_split_by_blank_lines_and_keep_line_breaks() -> None:
    """空行で段落を分け、段落内の改行はそのまま残す。"""
    blocks = parse_markdown("一行目\n二行目\n\n次の段落")

    assert blocks == [
        MdBlock("paragraph", (MdInline("一行目\n二行目"),)),
        MdBlock("paragraph", (MdInline("次の段落"),)),
    ]


def test_headings_lists_and_quotes() -> None:
    """# 見出し、- 箇条書き（字下げで階層）、1. 番号付き、> 引用を見分ける。"""
    blocks = parse_markdown("## 手順\n- 準備\n  - 下準備\n2. 実行\n> 注意")

    assert [(block.kind, block.level, block.inlines[0].text) for block in blocks] == [
        ("heading", 2, "手順"),
        ("bullet", 0, "準備"),
        ("bullet", 1, "下準備"),
        ("numbered", 2, "実行"),
        ("quote", 0, "注意"),
    ]


def test_fenced_code_block_keeps_raw_text_and_language() -> None:
    """``` で囲んだ部分は Markdown として解釈せず、言語名と一緒にそのまま残す。"""
    blocks = parse_markdown("実行します\n```bash\nnpm test # **太字ではない**\n```\n終わり")

    assert blocks[1] == MdBlock("code", (), text="npm test # **太字ではない**", language="bash")
    assert [block.kind for block in blocks] == ["paragraph", "code", "paragraph"]


def test_unclosed_code_fence_runs_to_end() -> None:
    """閉じていないコードブロック（ストリーミング途中など）は最後までコードとして扱う。"""
    blocks = parse_markdown("```python\nprint(1)\nprint(2)")

    assert blocks == [MdBlock("code", (), text="print(1)\nprint(2)", language="python")]


def test_inline_code_and_bold() -> None:
    """`行内コード` と **太字** を分け、閉じていない記号は文字のまま残す。"""
    assert parse_inlines("`npm test` を **必ず** 実行") == [
        MdInline("npm test", "code"),
        MdInline(" を ", "plain"),
        MdInline("必ず", "bold"),
        MdInline(" 実行", "plain"),
    ]
    assert parse_inlines("2 ** 3 と `未完") == [MdInline("2 ** 3 と `未完", "plain")]


def test_empty_text_has_no_blocks() -> None:
    """空の応答はブロックなし。"""
    assert parse_markdown("") == []
    assert parse_markdown("\n\n") == []
