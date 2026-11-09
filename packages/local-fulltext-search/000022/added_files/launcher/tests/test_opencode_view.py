"""
macOS 版 OpenCode ペインのチャット表示（NSTextView へ流し込む「文字列＋書式＋リンク」の並び）を検証する。
AppKit に依存しない部分なので、macOS 以外でも実行できる。
"""

from launcher_app.opencode_chat import ChatTranscript
from launcher_app.ui.opencode_view import EMPTY_HINT, Segment, render_chat


def joined(segments: list[Segment]) -> str:
    """表示される文字列全体。"""
    return "".join(segment.text for segment in segments)


def build_transcript() -> ChatTranscript:
    """指示 → 思考 → ツール → 応答 の 1 往復を持つ会話。"""
    transcript = ChatTranscript()
    transcript.add_user("テストを流して")
    transcript.apply_event({"type": "reasoning", "part": {
        "id": "r1", "type": "reasoning", "text": "npm test を使う", "time": {"start": 0, "end": 1200},
    }})
    transcript.apply_event({"type": "tool_use", "part": {
        "id": "t1", "type": "tool", "tool": "bash",
        "state": {"status": "completed", "input": {"command": "npm test"}, "output": "253 passed"},
    }})
    transcript.apply_event({"type": "text", "part": {"id": "x1", "type": "text", "text": "**全件**成功です\n```\n253 passed\n```"}})
    return transcript


def test_empty_transcript_shows_hint() -> None:
    """会話が空のときは操作の案内を出す。"""
    segments = render_chat(ChatTranscript())

    assert joined(segments) == EMPTY_HINT
    assert "Enter で送信" in EMPTY_HINT and "Shift+Enter で改行" in EMPTY_HINT


def test_user_and_assistant_bubbles_have_labels_and_styles() -> None:
    """自分の指示と opencode の応答を、見出し付きの別の書式（吹き出し）で表示する。"""
    segments = render_chat(build_transcript())

    styles = {segment.style for segment in segments}
    assert {"user_label", "user", "assistant_label", "bold", "code"} <= styles
    user = next(segment for segment in segments if segment.style == "user")
    assert user.text.strip() == "テストを流して"
    assert next(segment for segment in segments if segment.style == "bold").text == "全件"
    assert next(segment for segment in segments if segment.style == "code").text.strip() == "253 passed"
    # 応答の見出しは 1 往復に 1 回だけ
    assert [segment.style for segment in segments].count("assistant_label") == 1


def test_reasoning_and_tool_are_collapsed_with_toggle_links() -> None:
    """思考とツールは見出しだけを出して折りたたみ、見出しのリンクで開閉する。"""
    segments = render_chat(build_transcript())
    text = joined(segments)

    assert "▸ 思考（1.2秒）" in text
    assert "▸ ✓ bash  npm test" in text
    assert "npm test を使う" not in text  # 思考の本文は閉じている
    assert "253 passed\n" in text  # 応答本文のコードブロックだけが見える
    links = [segment.link for segment in segments if segment.link]
    assert "toggle:r1" in links and "toggle:t1" in links


def test_expanded_tool_shows_input_and_output() -> None:
    """開いたツールは入力と出力を表示する。"""
    transcript = build_transcript()
    transcript.toggle("t1")
    transcript.toggle("r1")

    text = joined(render_chat(transcript))

    assert "▾ ✓ bash  npm test" in text
    assert '"command": "npm test"' in text
    assert "npm test を使う" in text


def test_assistant_text_has_copy_link() -> None:
    """応答の吹き出しごとにコピーのリンクを付ける。"""
    segments = render_chat(build_transcript())

    copy = [segment for segment in segments if segment.link == "copy:x1"]
    assert len(copy) == 1 and copy[0].text == "コピー"


def test_notices_and_errors() -> None:
    """中断などの通知と、エラーを区別して表示する。"""
    transcript = ChatTranscript()
    transcript.add_notice("中断しました")
    transcript.add_notice("認証が必要です", error=True)

    segments = render_chat(transcript)

    assert [(segment.style, segment.text) for segment in segments] == [
        ("notice", "— 中断しました —\n"),
        ("error", "⚠ 認証が必要です\n"),
    ]


def test_markdown_lists_and_headings_are_rendered_with_prefixes() -> None:
    """箇条書きは「• 」、番号付きは「1. 」、見出しは見出し用の書式で表示する。"""
    transcript = ChatTranscript()
    transcript.apply_event({"type": "text", "part": {"id": "x", "type": "text", "text": "# まとめ\n- 一つ目\n  - 詳細\n3. 三番"}})

    segments = render_chat(transcript)
    text = joined(segments)

    assert next(segment for segment in segments if segment.style == "heading").text == "まとめ\n"
    assert "• 一つ目\n" in text
    assert "    • 詳細\n" in text
    assert "3. 三番\n" in text
