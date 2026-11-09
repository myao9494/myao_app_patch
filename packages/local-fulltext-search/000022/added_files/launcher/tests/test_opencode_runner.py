"""
ランチャー内 opencode CLI ペインのコマンド組み立て・会話セッション管理（チャット表示・待ち行列・停止・
過去の会話の再開・モデル一覧）・サブプロセス実行（ハング防止・タイムアウト・実行ファイル解決）のテスト。
"""

from __future__ import annotations

from collections.abc import Callable
import json
import os
import sys
import threading

import pytest

from launcher_app.opencode_runner import (
    OpenCodeCaptureResult,
    OpenCodeError,
    OpenCodeRunResult,
    OpenCodeSession,
    SubprocessOpenCodeRunner,
    build_opencode_args,
    extract_session_id,
    resolve_opencode_executable,
    strip_ansi_codes,
)


class FakeRunner:
    """
    opencode CLI の代わりに、渡された NDJSON 行を順に流して終了コードを返す。
    capture（会話一覧・会話の書き出し・モデル一覧）は引数ごとに決めた結果を返す。
    """

    def __init__(
        self,
        scripts: list[tuple[list[str], OpenCodeRunResult]] | None = None,
        captures: dict[tuple[str, ...], OpenCodeCaptureResult] | None = None,
    ) -> None:
        self.scripts = list(scripts or [])
        self.captures = dict(captures or {})
        self.calls: list[tuple[str, list[str]]] = []
        self.capture_calls: list[tuple[str, list[str]]] = []
        self.cancel_count = 0

    def run(self, working_dir: str, args: list[str], on_line: Callable[[str], None]) -> OpenCodeRunResult:
        self.calls.append((working_dir, list(args)))
        lines, result = self.scripts.pop(0) if self.scripts else ([], OpenCodeRunResult(0))
        for line in lines:
            on_line(line)
        return result

    def capture(self, working_dir: str, args: list[str]) -> OpenCodeCaptureResult:
        self.capture_calls.append((working_dir, list(args)))
        return self.captures.get(tuple(args), OpenCodeCaptureResult(1, "", "not scripted"))

    def cancel(self) -> None:
        self.cancel_count += 1


_part_counter = [0]


def text_event(text: str, session_id: str = "ses_A") -> str:
    """opencode run --format json の text イベント 1 行を作る（part ID は毎回別）。"""
    _part_counter[0] += 1
    return json.dumps({"type": "text", "sessionID": session_id, "part": {"id": f"prt_{_part_counter[0]}", "type": "text", "text": text}})


def kinds_and_texts(session: OpenCodeSession) -> list[tuple[str, str]]:
    """会話の表示内容を (種類, 本文) の並びで返す。"""
    return [(entry.kind, entry.text) for entry in session.transcript.entries]


def make_session(runner: FakeRunner, working_dir: str = r"C:\work", **kwargs: object) -> OpenCodeSession:
    """フォルダが存在する扱いのセッションを作る。"""
    return OpenCodeSession(working_dir, runner=runner, dir_exists=lambda path: True, **kwargs)  # type: ignore[arg-type]


def test_build_opencode_args_separates_prompt_and_selects_session() -> None:
    """
    思考を表示するため常に `--thinking` を付け、プロンプトは `--` の後ろへ置く（`-` で始まる指示も解釈させない）。
    会話 ID が分かっていれば `--session`、分からなければ `--continue` で続きを指定する。
    """
    assert build_opencode_args("ファイル一覧を教えて") == ["run", "--format", "json", "--thinking", "--", "ファイル一覧を教えて"]
    assert build_opencode_args("-h の意味は？") == ["run", "--format", "json", "--thinking", "--", "-h の意味は？"]
    assert build_opencode_args("続き", session_id="ses_123") == [
        "run", "--format", "json", "--thinking", "--session", "ses_123", "--", "続き",
    ]
    assert build_opencode_args("続き", continue_session=True) == [
        "run", "--format", "json", "--thinking", "--continue", "--", "続き",
    ]


def test_build_opencode_args_adds_model_plan_and_auto_approve() -> None:
    """モデル指定は `--model`、Plan モードは `--agent plan`、自動承認は `--auto` を付ける。Build（既定）は付けない。"""
    assert build_opencode_args(
        "直して", session_id="ses_1", model="anthropic/claude-opus-5-5", plan_mode=True, auto_approve=True,
    ) == [
        "run", "--format", "json", "--thinking",
        "--model", "anthropic/claude-opus-5-5", "--agent", "plan", "--auto",
        "--session", "ses_1", "--", "直して",
    ]
    assert build_opencode_args("直して", model="  ", plan_mode=False) == ["run", "--format", "json", "--thinking", "--", "直して"]


def test_strip_ansi_codes_removes_escape_sequences() -> None:
    """CLI出力に含まれるANSIカラーコードや制御シーケンスを除去する。"""
    raw = "\x1b[32m✓\x1b[0m 完了しました \x1b[1;34m[opencode]\x1b[0m\r\n次の行"
    assert strip_ansi_codes(raw) == "✓ 完了しました [opencode]\n次の行"


def test_extract_session_id_reads_session_from_any_event() -> None:
    """NDJSON イベントの sessionID を取り出し、JSON でない行や ID のない行は None を返す。"""
    assert extract_session_id('{"type":"error","sessionID":"ses_e42","error":{}}') == "ses_e42"
    assert extract_session_id('{"type":"step_start"}') is None
    assert extract_session_id("plain text") is None


def test_session_requires_existing_working_dir_and_never_falls_back() -> None:
    """
    作業フォルダが未設定・存在しないときは opencode を起動せずエラーにする。
    ランチャー自身のフォルダなど別の場所でエージェントを動かさない。
    """
    runner = FakeRunner()
    unset = OpenCodeSession("", runner=runner, dir_exists=lambda path: True)
    with pytest.raises(OpenCodeError, match="未設定"):
        unset.send("質問")

    missing = OpenCodeSession(r"D:\missing", runner=runner, dir_exists=lambda path: False)
    with pytest.raises(OpenCodeError, match=r"見つかりません: D:\\missing"):
        missing.send("質問")
    assert runner.calls == []


def test_session_streams_chat_entries_and_continues_with_captured_session_id() -> None:
    """
    1 回目は新規会話。指示と応答をチャットの吹き出しとして並べ、届くたびに on_update で知らせる。
    出力に含まれた sessionID を覚え、2 回目以降は `--session` で同じ会話を続ける。
    """
    runner = FakeRunner([
        ([text_event("前半"), text_event("後半")], OpenCodeRunResult(0)),
        ([text_event("2回目の応答")], OpenCodeRunResult(0)),
    ])
    session = make_session(runner)
    snapshots: list[list[tuple[str, str]]] = []

    assert session.send("最初の質問", on_update=lambda: snapshots.append(kinds_and_texts(session))) is True

    assert runner.calls[-1] == (r"C:\work", ["run", "--format", "json", "--thinking", "--", "最初の質問"])
    assert kinds_and_texts(session) == [("user", "最初の質問"), ("text", "前半"), ("text", "後半")]
    assert [("user", "最初の質問"), ("text", "前半")] in snapshots  # 途中経過を知らせる
    assert session.session_id == "ses_A"
    assert session.continue_session is True

    session.send("2回目の質問")
    assert runner.calls[-1][1] == ["run", "--format", "json", "--thinking", "--session", "ses_A", "--", "2回目の質問"]
    assert kinds_and_texts(session)[-2:] == [("user", "2回目の質問"), ("text", "2回目の応答")]
    assert session.history.items == ["最初の質問", "2回目の質問"]


def test_session_passes_model_plan_and_auto_options() -> None:
    """ペインで選んだモデル・Plan モード・自動承認を opencode へ渡す。"""
    runner = FakeRunner()
    session = make_session(runner)
    session.model = "opencode/big-pickle"
    session.plan_mode = True
    session.auto_approve = True

    session.send("計画して")

    assert runner.calls[-1][1] == [
        "run", "--format", "json", "--thinking", "--model", "opencode/big-pickle", "--agent", "plan", "--auto", "--", "計画して",
    ]


def test_session_falls_back_to_continue_without_session_id_and_resets() -> None:
    """
    sessionID が取れなかった成功時は `--continue` で続ける。
    作業フォルダ変更と reset() は新規会話へ戻し、表示も空にする。
    """
    runner = FakeRunner([
        (["プレーン応答"], OpenCodeRunResult(0)),
        (["続き"], OpenCodeRunResult(0)),
        (["別フォルダ"], OpenCodeRunResult(0)),
    ])
    session = make_session(runner)

    session.send("1")
    session.send("2")
    assert runner.calls[-1][1] == ["run", "--format", "json", "--thinking", "--continue", "--", "2"]

    session.set_working_dir(r"D:\other")
    assert session.continue_session is False
    session.send("3")
    assert runner.calls[-1] == (r"D:\other", ["run", "--format", "json", "--thinking", "--", "3"])

    session.reset()
    assert session.continue_session is False
    assert session.session_id is None
    assert session.transcript.entries == []


def test_session_reports_failure_timeout_and_empty_output_as_notices() -> None:
    """失敗・タイムアウト・応答なしは、理由をお知らせ行で表示する。失敗した実行は会話継続の起点にしない。"""
    runner = FakeRunner([
        ([], OpenCodeRunResult(1, stderr="認証が必要です")),
        ([], OpenCodeRunResult(-9, timed_out=True)),
        ([], OpenCodeRunResult(0)),
    ])
    session = make_session(runner)

    session.send("失敗")
    assert kinds_and_texts(session)[-1] == ("notice", "opencode 実行失敗（exit 1）: 認証が必要です")
    assert session.transcript.entries[-1].status == "error"
    assert session.continue_session is False

    session.send("時間切れ")
    assert kinds_and_texts(session)[-1] == ("notice", "タイムアウトしたため停止しました")

    session.send("空")
    assert kinds_and_texts(session)[-1] == ("notice", "（応答なし）")


def test_session_status_text_shows_elapsed_and_finish_time() -> None:
    """実行中は「作業中… 経過秒」、終わったら「完了（かかった秒）」を表示する。"""
    clock = [100.0]

    class SlowRunner(FakeRunner):
        def run(self, working_dir: str, args: list[str], on_line: Callable[[str], None]) -> OpenCodeRunResult:
            clock[0] += 2.0
            return super().run(working_dir, args, on_line)

    session = make_session(SlowRunner([([text_event("ok")], OpenCodeRunResult(0))]), clock=lambda: clock[0])
    assert session.status_text() == ""

    session.send("質問")

    assert session.status_text() == "完了（2.0秒）"


class BlockingRunner(FakeRunner):
    """1 回目の実行だけ、release されるまで終わらないランナー。"""

    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__(*args, **kwargs)  # type: ignore[arg-type]
        self.entered = threading.Event()
        self.release = threading.Event()

    def run(self, working_dir: str, args: list[str], on_line: Callable[[str], None]) -> OpenCodeRunResult:
        if not self.entered.is_set():
            self.entered.set()
            self.release.wait(5)
            if self.cancel_count:
                self.calls.append((working_dir, list(args)))
                return OpenCodeRunResult(-1, cancelled=True)
        return super().run(working_dir, args, on_line)


def test_send_while_running_queues_and_runs_after_current() -> None:
    """実行中に送った指示は待ち行列へ入れ、今の実行が終わったら順に送る。同時に 2 つは走らせない。"""
    runner = BlockingRunner()
    clock = [10.0]
    session = make_session(runner, clock=lambda: clock[0])
    worker = threading.Thread(target=session.send, args=("長い処理",))
    worker.start()
    assert runner.entered.wait(5)
    assert session.is_running is True

    assert session.send("次の指示") is True
    clock[0] += 12.0
    assert session.queue == ["次の指示"]
    assert session.status_text() == "作業中… 12秒 · 待機 1件"
    runner.release.set()
    worker.join(5)

    assert not worker.is_alive()
    assert [args[-1] for _, args in runner.calls] == ["長い処理", "次の指示"]
    assert session.queue == []
    assert [text for kind, text in kinds_and_texts(session) if kind == "user"] == ["長い処理", "次の指示"]
    assert session.is_running is False


def test_cancel_stops_current_run_and_clears_queue() -> None:
    """停止は実行中の opencode を止め、待ち行列も捨てる。"""
    runner = BlockingRunner()
    session = make_session(runner)
    worker = threading.Thread(target=session.send, args=("長い処理",))
    worker.start()
    assert runner.entered.wait(5)
    session.send("待機中の指示")

    session.cancel()
    runner.release.set()
    worker.join(5)

    assert runner.cancel_count == 1
    assert len(runner.calls) == 1
    assert session.queue == []
    assert kinds_and_texts(session)[-1] == ("notice", "中断しました")
    assert session.is_running is False


def test_list_sessions_resume_and_list_models() -> None:
    """会話一覧から過去の会話を読み込み、その会話 ID で続ける。モデル一覧も取得できる。"""
    export = {
        "info": {"id": "ses_old", "title": "前の会話"},
        "messages": [
            {"id": "m1", "type": "user", "text": "前の質問"},
            {"id": "m2", "type": "assistant", "content": [{"type": "text", "text": "前の応答"}]},
        ],
    }
    runner = FakeRunner(captures={
        ("session", "list", "--format", "json", "-n", "20"): OpenCodeCaptureResult(
            0, '[{"id":"ses_old","title":"前の会話","updated":5}]', ""
        ),
        ("session", "export", "ses_old"): OpenCodeCaptureResult(0, json.dumps(export), ""),
        ("models",): OpenCodeCaptureResult(0, "opencode/big-pickle\nanthropic/claude-opus-5-5\n", ""),
    })
    session = make_session(runner)

    sessions = session.list_sessions()
    assert [(item.id, item.title) for item in sessions] == [("ses_old", "前の会話")]
    assert runner.capture_calls[-1][0] == r"C:\work"

    session.resume("ses_old")
    assert kinds_and_texts(session) == [("user", "前の質問"), ("text", "前の応答")]
    assert session.session_id == "ses_old"
    assert session.continue_session is True

    session.send("続きの質問")
    assert runner.calls[-1][1][-4:] == ["--session", "ses_old", "--", "続きの質問"]

    assert session.list_models() == ["opencode/big-pickle", "anthropic/claude-opus-5-5"]


def test_resume_failure_keeps_current_conversation() -> None:
    """会話を読み込めなかったときは今の会話を残し、理由をエラーで知らせる。"""
    runner = FakeRunner([([text_event("今の応答")], OpenCodeRunResult(0))])
    session = make_session(runner)
    session.send("今の質問")

    with pytest.raises(OpenCodeError, match="会話を読み込めません"):
        session.resume("ses_missing")

    assert kinds_and_texts(session) == [("user", "今の質問"), ("text", "今の応答")]
    assert session.session_id == "ses_A"
    assert session.list_models() == []


def test_resolve_opencode_executable_never_returns_cmd_wrapper_on_windows(tmp_path) -> None:
    """
    Windows では cmd.exe を経由する opencode.cmd を使わず、ネイティブの opencode.exe だけを返す。
    （cmd.exe は `&` や `|` を含む指示を別コマンドとして解釈するため）
    """
    appdata = tmp_path / "AppData"
    (appdata / "npm").mkdir(parents=True)
    (appdata / "npm" / "opencode.cmd").write_text("@echo off", encoding="utf-8")

    assert resolve_opencode_executable(appdata=str(appdata), which=lambda name: None, is_windows=True) is None

    native = appdata / "npm" / "node_modules" / "@opencode" / "cli" / "bin" / "opencode.exe"
    native.parent.mkdir(parents=True)
    native.write_bytes(b"")
    assert resolve_opencode_executable(appdata=str(appdata), which=lambda name: None, is_windows=True) == str(native)

    on_path = resolve_opencode_executable(
        appdata="", which=lambda name: r"C:\bin\opencode.exe" if name == "opencode.exe" else None, is_windows=True
    )
    assert on_path == r"C:\bin\opencode.exe"
    assert resolve_opencode_executable(appdata="", which=lambda name: "/usr/local/bin/opencode", is_windows=False) == (
        "/usr/local/bin/opencode"
    )


def _python_runner(script: str, **kwargs: object) -> tuple[SubprocessOpenCodeRunner, list[str]]:
    """opencode の代わりに Python スクリプトを起動するランナーを作る。"""
    runner = SubprocessOpenCodeRunner(executable_resolver=lambda: sys.executable, warm_up=lambda executable: None, **kwargs)  # type: ignore[arg-type]
    return runner, ["-c", script]


def test_subprocess_runner_does_not_hang_when_stderr_is_large(tmp_path) -> None:
    """
    標準エラーへ大量に書く opencode でも、標準出力と並行して読み、待ち合わせで止まらない。
    """
    script = "import sys\nsys.stderr.write('e' * 200000)\nsys.stderr.flush()\nprint('{\"type\":\"text\",\"part\":{\"text\":\"done\"}}', flush=True)\n"
    runner, args = _python_runner(script, timeout_seconds=20)
    lines: list[str] = []
    result: list[OpenCodeRunResult] = []

    worker = threading.Thread(target=lambda: result.append(runner.run(str(tmp_path), args, lines.append)))
    worker.start()
    worker.join(15)

    assert not worker.is_alive(), "標準エラーの読み残しでハングした"
    assert result[0].returncode == 0
    assert len(result[0].stderr) == 200000
    assert any("done" in line for line in lines)


def test_subprocess_runner_kills_process_after_timeout(tmp_path) -> None:
    """応答が返らない opencode はタイムアウトで止め、その旨を返す。"""
    runner, args = _python_runner("import time\ntime.sleep(30)\n", timeout_seconds=0.5)

    result = runner.run(str(tmp_path), args, lambda line: None)

    assert result.returncode != 0
    assert result.timed_out is True


def test_subprocess_runner_cancel_stops_running_process(tmp_path) -> None:
    """cancel() で実行中の opencode を止める。"""
    runner, args = _python_runner("import time\nprint('start', flush=True)\ntime.sleep(30)\n", timeout_seconds=60)
    started = threading.Event()
    result: list[OpenCodeRunResult] = []

    def on_line(line: str) -> None:
        started.set()

    worker = threading.Thread(target=lambda: result.append(runner.run(str(tmp_path), args, on_line)))
    worker.start()
    assert started.wait(10)
    runner.cancel()
    worker.join(10)

    assert not worker.is_alive()
    assert result[0].cancelled is True


def test_subprocess_runner_run_sets_pwd_to_working_dir(tmp_path, monkeypatch) -> None:
    """
    起動元の PWD が残ったままだと、opencode が cwd ではなく PWD を作業フォルダと見なす（backend で動いてしまう）。
    run は cwd と同じ値を PWD にも渡す。
    """
    monkeypatch.setenv("PWD", "/somewhere/else")
    runner, args = _python_runner("import os\nprint(os.environ.get('PWD'), os.getcwd(), flush=True)\n", timeout_seconds=20)
    lines: list[str] = []

    runner.run(str(tmp_path), args, lines.append)

    pwd, cwd = "".join(lines).split()
    assert pwd == str(tmp_path)
    assert os.path.realpath(cwd) == os.path.realpath(str(tmp_path))


def test_subprocess_runner_capture_sets_pwd_to_working_dir(tmp_path, monkeypatch) -> None:
    """会話一覧などの短い問い合わせ（capture）も、PWD を作業フォルダに合わせる。"""
    monkeypatch.setenv("PWD", "/somewhere/else")
    runner, args = _python_runner("import os\nprint(os.environ.get('PWD'))\n", timeout_seconds=20)

    result = runner.capture(str(tmp_path), args)

    assert result.stdout.strip() == str(tmp_path)


def test_subprocess_runner_reports_missing_executable(tmp_path) -> None:
    """opencode.exe が見つからないときは分かる文言で知らせる。"""
    runner = SubprocessOpenCodeRunner(executable_resolver=lambda: None, warm_up=lambda executable: None)

    with pytest.raises(OpenCodeError, match="opencode が見つかりません"):
        runner.run(str(tmp_path), ["run"], lambda line: None)


def test_subprocess_runner_capture_returns_stdout(tmp_path) -> None:
    """会話一覧などの短い問い合わせは、標準出力をまとめて受け取る。"""
    runner, args = _python_runner("print('[]')", timeout_seconds=20)

    result = runner.capture(str(tmp_path), args)

    assert result.returncode == 0
    assert result.stdout.strip() == "[]"


def test_session_expands_registered_slash_command() -> None:
    """
    登録したスラッシュコマンド（/pass gmail）は展開したプロンプトを opencode へ送り、
    吹き出しと指示の履歴には打った「/pass gmail」をそのまま残す。登録の無い /… はそのまま送る。
    """
    from launcher_app.slash_commands import SlashCommand

    runner = FakeRunner()
    session = make_session(runner)
    session.slash_commands = [SlashCommand("pass", "パスワード表から $ARGUMENTS のパスワードを探して")]

    session.send("/pass gmail")
    session.send("/usr/bin を調べて")

    assert [args[-1] for _, args in runner.calls] == ["パスワード表から gmail のパスワードを探して", "/usr/bin を調べて"]
    assert [text for kind, text in kinds_and_texts(session) if kind == "user"] == ["/pass gmail", "/usr/bin を調べて"]
    assert session.history.items == ["/pass gmail", "/usr/bin を調べて"]
