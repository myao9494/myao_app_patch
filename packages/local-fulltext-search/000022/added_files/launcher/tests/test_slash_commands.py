"""
OpenCode ペインのスラッシュコマンド（このアプリ独自の定型作業。/pass など）の展開・入力チェック・補完を検証する。
Obsidian（Claudian）と同じく、/ で候補を出し、上下で選び、Tab / Enter で確定、Esc で閉じる。
"""

from launcher_app.slash_commands import (
    SlashCommand,
    SlashSuggestions,
    apply_completion,
    completion_words,
    expand_slash_command,
    find_candidates,
    parse_commands,
    slash_query,
    validate_command,
)

PASS = SlashCommand("pass", "パスワード表 C:\\secret\\pw.xlsx から $ARGUMENTS のパスワードを探して", "パスワード取得")
PASTE = SlashCommand("paste", "クリップボードを整形して")
DAILY = SlashCommand("daily", "今日の作業をまとめて")
REPORT = SlashCommand("report-pass", "合格者を報告して")
COMMANDS = [PASS, PASTE, DAILY, REPORT]


def test_expand_replaces_arguments_placeholder() -> None:
    """/pass gmail は $ARGUMENTS を gmail に置き換えたプロンプトになる（名前は大文字小文字を区別しない）。"""
    assert expand_slash_command("/pass gmail", COMMANDS) == "パスワード表 C:\\secret\\pw.xlsx から gmail のパスワードを探して"
    assert expand_slash_command("/PASS  gmail ", COMMANDS) == "パスワード表 C:\\secret\\pw.xlsx から gmail のパスワードを探して"
    assert expand_slash_command("/pass", COMMANDS) == "パスワード表 C:\\secret\\pw.xlsx から  のパスワードを探して"


def test_expand_appends_arguments_without_placeholder() -> None:
    """$ARGUMENTS が無いコマンドは、後ろの文字（改行を含む）を空行のあとへ足す。"""
    assert expand_slash_command("/daily", COMMANDS) == "今日の作業をまとめて"
    assert expand_slash_command("/daily 午後は会議\n夜は資料", COMMANDS) == "今日の作業をまとめて\n\n午後は会議\n夜は資料"


def test_unregistered_or_non_command_text_is_not_expanded() -> None:
    """登録されていない名前・パス（/usr/bin など）・途中の / は展開しない（そのまま opencode へ送る）。"""
    assert expand_slash_command("/unknown x", COMMANDS) is None
    assert expand_slash_command("/usr/bin を調べて", COMMANDS) is None
    assert expand_slash_command("pass gmail", COMMANDS) is None
    assert expand_slash_command("", COMMANDS) is None


def test_validate_command_for_registration() -> None:
    """登録画面の入力チェック。先頭の / は付けても付けなくてもよい。"""
    assert validate_command("", "x", []) == "コマンド名を入力してください"
    assert validate_command("two words", "x", []) == "コマンド名に空白や / は使えません"
    assert validate_command("a/b", "x", []) == "コマンド名に空白や / は使えません"
    assert validate_command("/pass", "x", ["PASS"]) == "/pass はすでに登録されています"
    assert validate_command("pass", "  ", []) == "プロンプトを入力してください"
    assert validate_command("/pass", "x", ["daily"]) is None


def test_parse_commands_from_api_payload() -> None:
    """API の {"commands": [...]} から読み、壊れた項目は飛ばす。"""
    payload = {"commands": [{"name": "pass", "prompt": "p", "description": "d"}, {"name": "x"}, "bad"]}

    assert parse_commands(payload) == [SlashCommand("pass", "p", "d")]
    assert parse_commands(None) == []


def test_slash_query_only_while_typing_the_first_token() -> None:
    """先頭が / で、カーソルが最初の語の中にあるときだけ補完の検索語を返す。"""
    assert slash_query("/p", 2) == "p"
    assert slash_query("/", 1) == ""
    assert slash_query("/pa extra", 3) == "pa"
    assert slash_query("/pa extra", 6) is None
    assert slash_query("a/p", 3) is None
    assert slash_query("/p", 0) is None


def test_find_candidates_prefix_first_then_contains() -> None:
    """前方一致を名前順に先に、その後ろに途中一致を並べる。空なら全件（名前順）。"""
    assert [c.name for c in find_candidates(COMMANDS, "pa")] == ["pass", "paste", "report-pass"]
    assert [c.name for c in find_candidates(COMMANDS, "PAS")] == ["pass", "paste", "report-pass"]
    assert [c.name for c in find_candidates(COMMANDS, "")] == ["daily", "pass", "paste", "report-pass"]
    assert find_candidates(COMMANDS, "zzz") == []


def test_apply_completion_replaces_first_token() -> None:
    """補完は最初の語を「/名前 」に置き換え、カーソルを空白の後ろへ置く。後ろの文字は残す。"""
    assert apply_completion("/p", 2, "pass") == ("/pass ", 6)
    assert apply_completion("/pa gmail", 3, "pass") == ("/pass gmail", 6)


def test_completion_words_for_native_completion() -> None:
    """macOS の標準補完へ渡す候補。補完範囲に / が含まれるかどうかに合わせる。"""
    assert completion_words("p", COMMANDS) == ["pass", "paste", "report-pass"]
    assert completion_words("/p", COMMANDS) == ["/pass", "/paste", "/report-pass"]


def test_suggestions_open_while_typing_and_move_with_wrap() -> None:
    """/ を打つと候補が開き、上下で選択が回る。候補が無い・最初の語を出たら閉じる。"""
    state = SlashSuggestions()
    state.refresh("/pa", 3, COMMANDS)
    assert state.is_open and [c.name for c in state.items] == ["pass", "paste", "report-pass"]
    assert state.selected == PASS
    state.move(1)
    assert state.selected == PASTE
    state.move(-2)
    assert state.selected == REPORT

    state.refresh("/zzz", 4, COMMANDS)
    assert not state.is_open
    state.refresh("/pass gmail", 11, COMMANDS)
    assert not state.is_open


def test_suggestions_accept_and_dismiss() -> None:
    """確定で補完して閉じる。Esc で閉じたら、文字が変わるまで開かない。"""
    state = SlashSuggestions()
    state.refresh("/pa", 3, COMMANDS)
    state.move(1)
    assert state.accept("/pa", 3) == ("/paste ", 7)
    assert not state.is_open

    state.refresh("/p", 2, COMMANDS)
    state.dismiss()
    state.refresh("/p", 2, COMMANDS)
    assert not state.is_open
    state.refresh("/pa", 3, COMMANDS)
    assert state.is_open


def test_tab_completes_single_candidate_or_opens_list() -> None:
    """Tab: 候補が 1 つならそのまま補完（/d → /daily）、複数なら候補を開く、開いていれば選択中を確定。"""
    state = SlashSuggestions()
    assert state.complete_on_tab("/d", 2, COMMANDS) == ("/daily ", 7)

    state.refresh("/p", 2, COMMANDS)
    state.dismiss()
    assert state.complete_on_tab("/p", 2, COMMANDS) is None
    assert state.is_open
    assert state.complete_on_tab("/p", 2, COMMANDS) == ("/pass ", 6)
    assert state.complete_on_tab("hello", 5, COMMANDS) is None
