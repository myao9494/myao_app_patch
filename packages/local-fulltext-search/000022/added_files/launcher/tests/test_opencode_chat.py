"""
OpenCode ペインのチャット表示モデル（Claudian 風: 吹き出し・思考/ツールの折りたたみ・使用量）と、
指示の履歴・会話一覧/モデル一覧の読み取り・表示用の書式を検証する。
"""

from __future__ import annotations

import json

from launcher_app.opencode_chat import (
    ChatTranscript,
    PromptHistory,
    format_elapsed,
    format_relative_time,
    format_tokens,
    parse_model_list,
    parse_session_list,
    summarize_tool,
    tool_header,
)


def event(kind: str, part: dict, session_id: str = "ses_A") -> dict:
    """opencode run --format json の 1 イベントを作る。"""
    return {"type": kind, "sessionID": session_id, "part": part}


def test_user_and_text_events_become_chat_entries_in_order() -> None:
    """自分の指示と opencode の応答（text）を、届いた順に別々の吹き出しとして並べる。"""
    transcript = ChatTranscript()
    transcript.add_user("ファイル一覧を教えて")

    assert transcript.apply_event(event("text", {"id": "prt_1", "type": "text", "text": "a.txt と b.txt です"})) is True

    assert [(entry.kind, entry.text) for entry in transcript.entries] == [
        ("user", "ファイル一覧を教えて"),
        ("text", "a.txt と b.txt です"),
    ]


def test_same_part_id_updates_entry_instead_of_appending() -> None:
    """同じ part ID のイベントは同じ吹き出し・カードを更新する（実行中→完了のツールなど）。"""
    transcript = ChatTranscript()
    transcript.apply_event(event("tool_use", {
        "id": "prt_t", "type": "tool", "tool": "bash",
        "state": {"status": "running", "input": {"command": "npm test"}},
    }))
    transcript.apply_event(event("tool_use", {
        "id": "prt_t", "type": "tool", "tool": "bash",
        "state": {"status": "completed", "input": {"command": "npm test"}, "output": "253 passed"},
    }))

    assert len(transcript.entries) == 1
    tool = transcript.entries[0]
    assert (tool.kind, tool.tool, tool.status, tool.summary) == ("tool", "bash", "completed", "npm test")
    assert "253 passed" in tool.detail_output
    assert '"command": "npm test"' in tool.detail_input


def test_tool_part_id_prefers_part_id_over_call_id() -> None:
    """ツールの呼び出し ID（functions.read:0）は応答ごとに重なるため、partID を優先して区別する。"""
    transcript = ChatTranscript()
    for part_id in ("prt_1", "prt_2"):
        transcript.apply_event(event("tool_use", {
            "partID": part_id, "id": "functions.read:0", "type": "tool", "tool": "read",
            "state": {"status": "completed", "input": {"path": f"{part_id}.txt"}, "output": "ok"},
        }))

    assert [entry.summary for entry in transcript.entries] == ["prt_1.txt", "prt_2.txt"]


def test_reasoning_is_collapsed_and_keeps_duration() -> None:
    """思考は既定で折りたたみ、かかった時間を見出しに出す。toggle で開閉できる。"""
    transcript = ChatTranscript()
    transcript.apply_event(event("reasoning", {
        "id": "prt_r", "type": "reasoning", "text": "ファイルを読む必要がある",
        "time": {"start": 1000, "end": 3500},
    }))

    reasoning = transcript.entries[0]
    assert reasoning.kind == "reasoning"
    assert reasoning.expanded is False
    assert reasoning.duration_seconds == 2.5
    assert transcript.toggle("prt_r") is True
    assert transcript.entries[0].expanded is True
    assert transcript.toggle("missing") is False


def test_empty_reasoning_and_control_events_are_not_shown() -> None:
    """中身のない思考や step_start などの制御イベントは表示しない。"""
    transcript = ChatTranscript()

    assert transcript.apply_event(event("reasoning", {"id": "prt_r", "type": "reasoning", "text": "  "})) is False
    assert transcript.apply_event(event("step_start", {"id": "prt_s", "type": "step-start"})) is False
    assert transcript.entries == []


def test_step_finish_updates_context_usage_and_cost() -> None:
    """最後の step_finish のトークン数をコンテキスト使用量として表示し、費用は合計する。"""
    transcript = ChatTranscript()
    transcript.apply_event(event("step_finish", {
        "type": "step-finish", "cost": 0.01,
        "tokens": {"input": 9976, "output": 30, "reasoning": 21, "cache": {"read": 0, "write": 0}},
    }))
    transcript.apply_event(event("step_finish", {
        "type": "step-finish", "cost": 0.02,
        "tokens": {"input": 191, "output": 6, "reasoning": 87, "cache": {"read": 9856, "write": 0}},
    }))

    assert transcript.context_tokens == 191 + 6 + 87 + 9856
    assert round(transcript.cost, 4) == 0.03
    assert transcript.usage_text() == "コンテキスト 10.1k トークン · $0.0300"


def test_usage_text_without_cost_and_without_usage() -> None:
    """費用 0 は出さず、使用量が無いときは空文字。"""
    transcript = ChatTranscript()
    assert transcript.usage_text() == ""
    transcript.apply_event(event("step_finish", {"type": "step-finish", "cost": 0, "tokens": {"input": 950}}))
    assert transcript.usage_text() == "コンテキスト 950 トークン"


def test_error_event_and_notices() -> None:
    """error イベントはエラーのお知らせ行にし、中断などの通知も同じ一覧へ並べる。"""
    transcript = ChatTranscript()
    transcript.apply_event({"type": "error", "error": {"name": "APIError", "data": {"message": "認証が必要です"}}})
    transcript.add_notice("中断しました")

    assert [(entry.kind, entry.status, entry.text) for entry in transcript.entries] == [
        ("notice", "error", "認証が必要です"),
        ("notice", "info", "中断しました"),
    ]


def test_apply_line_parses_ndjson_and_keeps_plain_output() -> None:
    """JSON の行はイベントとして読み、JSON でない出力は ANSI を除いて本文として残す。"""
    transcript = ChatTranscript()

    assert transcript.apply_line(json.dumps(event("text", {"id": "p", "type": "text", "text": "ok"}))) is True
    assert transcript.apply_line("\x1b[33m警告: 設定が古い\x1b[0m\n") is True
    assert transcript.apply_line("   ") is False

    assert [(entry.kind, entry.text) for entry in transcript.entries] == [("text", "ok"), ("text", "警告: 設定が古い")]


def test_last_assistant_text_and_copy_text() -> None:
    """コピー用に、応答の本文（最後の text）と吹き出し単位の本文を取り出せる。"""
    transcript = ChatTranscript()
    transcript.add_user("質問")
    transcript.apply_event(event("text", {"id": "p1", "type": "text", "text": "一つ目"}))
    transcript.apply_event(event("text", {"id": "p2", "type": "text", "text": "二つ目"}))

    assert transcript.last_assistant_text() == "二つ目"
    assert transcript.copy_text("p1") == "一つ目"
    assert transcript.copy_text("missing") == ""


def test_from_export_restores_past_conversation() -> None:
    """`opencode session export` の JSON から、過去の会話（指示・思考・ツール・応答・使用量）を復元する。"""
    exported = {
        "info": {"id": "ses_A", "title": "hello.txt を読む", "tokens": {"input": 10669}},
        "messages": [
            {"id": "m1", "type": "user", "text": "hello.txt を読んで"},
            {
                "id": "m2", "type": "assistant",
                "content": [
                    {"type": "reasoning", "text": "読む", "time": {"created": 1000, "completed": 1500}},
                    {
                        "type": "tool", "id": "functions.read:0", "name": "read",
                        "state": {"status": "completed", "input": {"path": "hello.txt"},
                                  "content": [{"type": "text", "text": "1: hello world"}]},
                    },
                ],
                "tokens": {"input": 9976, "output": 30, "reasoning": 21, "cache": {"read": 0, "write": 0}},
            },
            {
                "id": "m3", "type": "assistant",
                "content": [{"type": "text", "text": "hello world"}],
                "tokens": {"input": 191, "output": 6, "reasoning": 87, "cache": {"read": 9856, "write": 0}},
            },
            {"id": "m4", "type": "idle", "outcome": "succeeded"},
        ],
    }

    transcript = ChatTranscript.from_export(exported)

    assert transcript.title == "hello.txt を読む"
    assert [(entry.kind, entry.text or entry.summary) for entry in transcript.entries] == [
        ("user", "hello.txt を読んで"),
        ("reasoning", "読む"),
        ("tool", "hello.txt"),
        ("text", "hello world"),
    ]
    assert transcript.entries[1].duration_seconds == 0.5
    assert transcript.entries[2].status == "completed"
    assert "hello world" in transcript.entries[2].detail_output
    assert transcript.context_tokens == 191 + 6 + 87 + 9856
    # 復元した ID は重ならない
    assert len({entry.id for entry in transcript.entries}) == 4


def test_summarize_tool_by_tool_kind() -> None:
    """ツールごとに、カードの見出しへ出す要約（パス・コマンド・検索語など）を決める。"""
    assert summarize_tool("read", {"filePath": "src/app.py"}) == "src/app.py"
    assert summarize_tool("edit", {"path": "README.md"}) == "README.md"
    assert summarize_tool("bash", {"command": "npm test\nnpm run build"}) == "npm test"
    assert summarize_tool("grep", {"pattern": "TODO", "path": "src"}) == "TODO in src"
    assert summarize_tool("glob", {"pattern": "**/*.md"}) == "**/*.md"
    assert summarize_tool("webfetch", {"url": "https://example.test"}) == "https://example.test"
    assert summarize_tool("task", {"description": "テストを調べる"}) == "テストを調べる"
    assert summarize_tool("todowrite", {"todos": [{"status": "completed"}, {"status": "pending"}]}) == "Tasks 1/2"
    assert summarize_tool("custom", {}, title="独自ツール") == "独自ツール"
    assert summarize_tool("custom", {"x": 1, "query": "検索"}) == "検索"
    assert summarize_tool("bash", {"command": "x" * 200}).endswith("…")
    assert len(summarize_tool("bash", {"command": "x" * 200})) == 80


def test_tool_header_shows_status_icon() -> None:
    """ツールの見出しは「状態アイコン ツール名 要約」。"""
    assert tool_header("read", "completed", "hello.txt") == "✓ read  hello.txt"
    assert tool_header("bash", "running", "npm test") == "⏳ bash  npm test"
    assert tool_header("bash", "error", "") == "✗ bash"


def test_prompt_history_navigates_with_up_and_down() -> None:
    """↑ で過去の指示を新しい順に呼び出し、↓ で戻る。最後まで戻ると打ちかけの下書きを返す。"""
    history = PromptHistory(limit=3)
    for prompt in ("一つ目", "二つ目", "二つ目", "三つ目", "四つ目"):
        history.add(prompt)

    assert history.items == ["二つ目", "三つ目", "四つ目"]
    assert history.previous("下書き") == "四つ目"
    assert history.previous("四つ目") == "三つ目"
    assert history.previous("三つ目") == "二つ目"
    assert history.previous("二つ目") == "二つ目"
    assert history.next() == "三つ目"
    assert history.next() == "四つ目"
    assert history.next() == "下書き"
    assert history.next() is None


def test_prompt_history_empty_and_reset() -> None:
    """履歴が空なら呼び出さない。送信したら呼び出し位置を最初へ戻す。"""
    history = PromptHistory()
    assert history.previous("") is None
    history.add("a")
    assert history.previous("") == "a"
    history.add("b")
    assert history.previous("") == "b"


def test_parse_session_list_reads_json_and_ignores_noise() -> None:
    """`opencode session list --format json` の出力から会話一覧を読む。前後の余計な出力は無視する。"""
    stdout = 'warn: something\n[{"id":"ses_1","title":"一つ目","updated":2000},{"id":"ses_2","updated":1000}]\n'

    sessions = parse_session_list(stdout)

    assert [(s.id, s.title, s.updated_ms) for s in sessions] == [("ses_1", "一つ目", 2000), ("ses_2", "", 1000)]
    assert parse_session_list("not json") == []


def test_parse_model_list_keeps_provider_model_lines() -> None:
    """`opencode models` の出力から「プロバイダー/モデル」の行だけを取り出す。"""
    stdout = "opencode/big-pickle\nanthropic/claude-opus-5-5\n\nServiceUnavailableError: x\n    at k (B:/x.js:1:2)\n"

    assert parse_model_list(stdout) == ["opencode/big-pickle", "anthropic/claude-opus-5-5"]


def test_formatters() -> None:
    """経過時間・トークン数・相対時刻の表示。"""
    assert format_elapsed(0.24) == "0.2秒"
    assert format_elapsed(12.6) == "13秒"
    assert format_elapsed(65) == "1分05秒"
    assert format_tokens(950) == "950"
    assert format_tokens(10669) == "10.7k"
    assert format_tokens(1_260_000) == "1.3M"
    now = 10 * 24 * 3600 * 1000
    assert format_relative_time(now - 30 * 1000, now) == "たった今"
    assert format_relative_time(now - 5 * 60 * 1000, now) == "5分前"
    assert format_relative_time(now - 3 * 3600 * 1000, now) == "3時間前"
    assert format_relative_time(now - 2 * 24 * 3600 * 1000, now) == "2日前"
