"""
ランチャー内 opencode CLI ペインのコマンド組み立て・会話セッション管理・サブプロセス実行を提供する。
画面に出す会話は opencode_chat.ChatTranscript（Claudian 風のチャット表示モデル）が持つ。

【仕様】
- 子プロセスには `cwd` に加えて環境変数 `PWD` も作業フォルダへ合わせて渡す（起動元の `PWD` が残ると opencode が別のフォルダで動く）。
- 作業フォルダは Web 設定ドロワーの `opencode_working_dir`（バックエンドが既定値を補う）を使う。
  未設定・存在しないフォルダでは opencode を起動せず `OpenCodeError` を送出する（別の場所で代わりに動かさない）。
- コマンドは `opencode run --format json --thinking [--model M] [--agent plan] [--auto] [--session <ID> | --continue] -- <指示>`。
  思考を表示するため常に `--thinking` を付ける。指示は `--` の後ろへ置き、`-` で始まる指示もオプションとして解釈させない。
  Plan モードのときだけ `--agent plan` を付ける（Build は opencode の既定に任せる）。自動承認は `--auto`。
- 1 回目の出力（NDJSON）に含まれる `sessionID` を覚え、2 回目以降は `--session <ID>` で同じ会話を続ける。
  ID が取れなかった成功時だけ `--continue` を使う。「新規会話」（`reset()`）と作業フォルダ変更で新規会話へ戻す。
- 同時に 2 つの opencode は走らせない。実行中に送った指示は待ち行列（queue）へ入れ、今の実行が終わったら順に送る。
  `cancel()`（停止）は実行中の処理を止め、待ち行列も捨てる。
- 結果のお知らせ: 中断「中断しました」、タイムアウト「タイムアウトしたため停止しました」、
  失敗「opencode 実行失敗（exit n）: 標準エラー」、応答が空「（応答なし）」。
- 状態表示（status_text）: 実行中は「作業中… 12秒」（待ち行列があれば「 · 待機 n件」）、終わったら「完了（2.0秒）」。
- 会話一覧は `opencode session list --format json -n 20`、過去の会話の読み込みは `opencode session export <ID>`、
  モデル一覧は `opencode models`（いずれも作業フォルダで実行）。
- サブプロセスは標準出力と標準エラーを並行して読み（パイプが詰まって止まらない）、`timeout_seconds` を過ぎたら止める。
- Windows では cmd.exe を経由する `opencode.cmd` を使わず、ネイティブの `opencode.exe` だけを起動する
  （cmd.exe は `&` や `|` を含む指示を別コマンドとして解釈するため）。
- 初回実行時に `opencode service start` を裏で 1 度だけ起動し、常駐サービスを温めておく。
- 登録したスラッシュコマンド（slash_commands）は送る直前にプロンプトへ展開する（slash_commands.py）。
  吹き出しと指示の履歴には打った文字（/pass gmail）をそのまま残す。
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
from typing import Any, Protocol

from launcher_app.opencode_chat import (
    ChatTranscript,
    PromptHistory,
    SessionSummary,
    format_elapsed,
    parse_model_list,
    parse_session_list,
)
from launcher_app.slash_commands import SlashCommand, expand_slash_command

_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
DEFAULT_TIMEOUT_SECONDS = 900.0
CAPTURE_TIMEOUT_SECONDS = 60.0
SESSION_LIST_LIMIT = 20
_service_warmup_started = False
_service_warmup_lock = threading.Lock()


class OpenCodeError(Exception):
    """opencode を実行できない理由（作業フォルダ未設定・実行中・実行ファイルなし）を表す。"""


@dataclass(frozen=True)
class OpenCodeRunResult:
    """opencode プロセス 1 回分の終了状態。"""

    returncode: int
    stderr: str = ""
    timed_out: bool = False
    cancelled: bool = False


@dataclass(frozen=True)
class OpenCodeCaptureResult:
    """短い問い合わせ（会話一覧・会話の書き出し・モデル一覧）の結果。"""

    returncode: int
    stdout: str
    stderr: str = ""


class OpenCodeRunner(Protocol):
    """opencode プロセスを起動し、標準出力を 1 行ずつ on_line へ渡す部品。"""

    def run(self, working_dir: str, args: list[str], on_line: Callable[[str], None]) -> OpenCodeRunResult: ...

    def capture(self, working_dir: str, args: list[str]) -> OpenCodeCaptureResult: ...

    def cancel(self) -> None: ...


def build_opencode_args(
    prompt: str,
    *,
    session_id: str | None = None,
    continue_session: bool = False,
    model: str | None = None,
    plan_mode: bool = False,
    auto_approve: bool = False,
) -> list[str]:
    """
    opencode CLI へ渡す引数を組み立てる。
    `--thinking` を常に付け、モデル・Plan・自動承認・会話の続き（`--session` / `--continue`）の順に足し、指示は `--` の後ろへ置く。
    """
    cleaned = str(prompt or "").strip()
    args = ["run", "--format", "json", "--thinking"]
    if model and model.strip():
        args += ["--model", model.strip()]
    if plan_mode:
        args += ["--agent", "plan"]
    if auto_approve:
        args.append("--auto")
    if session_id:
        args += ["--session", session_id]
    elif continue_session:
        args.append("--continue")
    return [*args, "--", cleaned]


def strip_ansi_codes(text: str) -> str:
    """CLI 出力に含まれる ANSI カラーコードや制御エスケープシーケンスを除去し、改行を LF に揃える。"""
    normalized = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    return _ANSI_ESCAPE_RE.sub("", normalized)


def _parse_event(line: str) -> dict[str, Any] | None:
    """NDJSON の 1 行を辞書として読む。JSON でなければ None。"""
    raw = str(line or "").strip()
    if not (raw.startswith("{") and raw.endswith("}")):
        return None
    try:
        payload = json.loads(raw)
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None


def extract_session_id(line: str) -> str | None:
    """NDJSON イベントの `sessionID` を返す。JSON でない行や ID のない行は None。"""
    payload = _parse_event(line)
    if payload is None:
        return None
    session_id = payload.get("sessionID")
    return str(session_id) if isinstance(session_id, str) and session_id else None


def resolve_opencode_executable(
    *,
    appdata: str | None = None,
    which: Callable[[str], str | None] = shutil.which,
    is_windows: bool | None = None,
) -> str | None:
    """
    opencode の実行ファイルを探す。見つからなければ None。
    Windows は npm 配下の opencode.exe → PATH 上の opencode.exe の順に探し、opencode.cmd は使わない。
    それ以外の OS は PATH 上の opencode を使う。
    """
    windows = os.name == "nt" if is_windows is None else is_windows
    if not windows:
        return which("opencode")
    appdata_dir = os.environ.get("APPDATA", "") if appdata is None else appdata
    if appdata_dir:
        npm_root = Path(appdata_dir) / "npm" / "node_modules" / "@opencode" / "cli"
        for candidate in (
            npm_root / "bin" / "opencode.exe",
            npm_root / "node_modules" / "@opencode" / "cli-windows-x64" / "bin" / "opencode.exe",
        ):
            if candidate.exists():
                return str(candidate)
    return which("opencode.exe")


def warm_up_opencode_service(executable: str) -> None:
    """
    opencode の常駐サービス（`opencode service start`）を裏で 1 度だけ起動する。
    失敗しても `opencode run` 単体は動くため、結果は見ない。
    """
    global _service_warmup_started
    with _service_warmup_lock:
        if _service_warmup_started:
            return
        _service_warmup_started = True

    def _warmup() -> None:
        try:
            subprocess.run(
                [executable, "service", "start"],
                capture_output=True,
                timeout=15,
                check=False,
                creationflags=_creation_flags(),
            )
        except (OSError, subprocess.SubprocessError):
            pass

    threading.Thread(target=_warmup, daemon=True).start()


def child_environment(working_dir: str) -> dict[str, str] | None:
    """
    opencode へ渡す環境変数。`PWD` を作業フォルダに合わせる。
    `cwd=` だけを指定すると起動元の `PWD` が残り、opencode はそちらを作業フォルダと見なして
    設定したフォルダと別の場所（例: バックエンドの backend/）でコマンドを実行してしまう。
    作業フォルダが空なら何も変えない（None）。
    """
    if not working_dir:
        return None
    return {**os.environ, "PWD": working_dir}


def _creation_flags() -> int:
    """Windows ではコンソール窓を出さずに起動する。"""
    return getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0


class SubprocessOpenCodeRunner:
    """
    opencode をサブプロセスで実行する既定のランナー。
    標準エラーは別スレッドで読み、`timeout_seconds` を過ぎるか cancel() されたらプロセスを止める。
    """

    def __init__(
        self,
        *,
        executable_resolver: Callable[[], str | None] = resolve_opencode_executable,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        warm_up: Callable[[str], None] = warm_up_opencode_service,
    ) -> None:
        self.executable_resolver = executable_resolver
        self.timeout_seconds = timeout_seconds
        self.warm_up = warm_up
        self._lock = threading.Lock()
        self._process: subprocess.Popen[str] | None = None
        self._cancelled = False

    def run(self, working_dir: str, args: list[str], on_line: Callable[[str], None]) -> OpenCodeRunResult:
        """作業フォルダで opencode を起動し、標準出力を 1 行ずつ on_line へ渡して終了状態を返す。"""
        executable = self.executable_resolver()
        if not executable:
            raise OpenCodeError("opencode が見つかりません（opencode.exe をインストールしてください）")
        self.warm_up(executable)
        process = subprocess.Popen(
            [executable, *args],
            cwd=working_dir,
            env=child_environment(working_dir),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=_creation_flags(),
        )
        with self._lock:
            self._process = process
            self._cancelled = False
        stderr_chunks: list[str] = []
        stderr_reader = threading.Thread(target=lambda: stderr_chunks.append(process.stderr.read() if process.stderr else ""), daemon=True)
        stderr_reader.start()
        timed_out = threading.Event()

        def _on_timeout() -> None:
            timed_out.set()
            _kill(process)

        watchdog = threading.Timer(self.timeout_seconds, _on_timeout)
        watchdog.daemon = True
        watchdog.start()
        try:
            assert process.stdout is not None
            for raw_line in process.stdout:
                on_line(raw_line)
            returncode = process.wait()
        finally:
            watchdog.cancel()
            stderr_reader.join(5)
            with self._lock:
                cancelled = self._cancelled
                self._process = None
        stderr_text = strip_ansi_codes("".join(stderr_chunks)).strip()
        return OpenCodeRunResult(returncode, stderr_text, timed_out=timed_out.is_set(), cancelled=cancelled)

    def capture(self, working_dir: str, args: list[str]) -> OpenCodeCaptureResult:
        """短い問い合わせを実行し、標準出力をまとめて返す（`CAPTURE_TIMEOUT_SECONDS` で打ち切る）。"""
        executable = self.executable_resolver()
        if not executable:
            raise OpenCodeError("opencode が見つかりません（opencode.exe をインストールしてください）")
        try:
            completed = subprocess.run(
                [executable, *args],
                cwd=working_dir or None,
                env=child_environment(working_dir),
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=CAPTURE_TIMEOUT_SECONDS,
                check=False,
                creationflags=_creation_flags(),
            )
        except subprocess.TimeoutExpired:
            return OpenCodeCaptureResult(-1, "", "タイムアウトしました")
        except OSError as error:
            raise OpenCodeError(f"opencode を起動できません: {error}") from error
        return OpenCodeCaptureResult(completed.returncode, completed.stdout or "", strip_ansi_codes(completed.stderr or "").strip())

    def cancel(self) -> None:
        """実行中の opencode を止める。実行していなければ何もしない。"""
        with self._lock:
            process = self._process
            if process is None:
                return
            self._cancelled = True
        _kill(process)


def _kill(process: subprocess.Popen[str]) -> None:
    """終了済みでも例外にせずプロセスを止める。"""
    try:
        process.kill()
    except OSError:
        pass


class OpenCodeSession:
    """
    opencode CLI ペインの作業フォルダ・会話 ID・チャット表示（transcript）・待ち行列・実行中状態を管理する。
    send() は呼び出したスレッドで opencode を実行する（画面からは別スレッドで呼ぶ）。
    """

    def __init__(
        self,
        working_dir: str = "",
        *,
        runner: OpenCodeRunner | None = None,
        dir_exists: Callable[[str], bool] = os.path.isdir,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.working_dir = str(working_dir or "").strip()
        self.runner: OpenCodeRunner = runner or SubprocessOpenCodeRunner()
        self.dir_exists = dir_exists
        self.clock = clock
        self.session_id: str | None = None
        self.transcript = ChatTranscript()
        self.history = PromptHistory()
        self.model: str | None = None
        self.plan_mode = False
        self.auto_approve = False
        self.queue: list[str] = []
        self.slash_commands: list[SlashCommand] = []
        self.status = ""
        self._has_conversation = False
        self._running = False
        self._started_at: float | None = None
        self._generation = 0
        self._lock = threading.Lock()

    @property
    def continue_session(self) -> bool:
        """次の送信が直前の会話の続きになるか。"""
        return self._has_conversation

    @property
    def is_running(self) -> bool:
        """opencode を実行中か。"""
        return self._running

    def status_text(self) -> str:
        """実行中は「作業中… 12秒 · 待機 1件」、それ以外は直近の結果（完了・中断など）。"""
        with self._lock:
            started = self._started_at if self._running else None
            waiting = len(self.queue)
        if started is None:
            return self.status
        text = f"作業中… {format_elapsed(self.clock() - started)}"
        return f"{text} · 待機 {waiting}件" if waiting else text

    def set_working_dir(self, working_dir: str) -> None:
        """作業フォルダを更新する。フォルダが変わったら新規会話へ戻す。"""
        normalized = str(working_dir or "").strip()
        if normalized != self.working_dir:
            self.working_dir = normalized
            self.session_id = None
            self._has_conversation = False

    def reset(self) -> None:
        """実行中なら止め、待ち行列と表示を消して次回の送信を新規会話に戻す。"""
        with self._lock:
            self._generation += 1
            self.queue.clear()
        if self._running:
            self.runner.cancel()
        self.session_id = None
        self._has_conversation = False
        self.transcript.clear()
        self.status = ""

    def cancel(self) -> None:
        """実行中の opencode を止め、待ち行列を捨てる。"""
        with self._lock:
            self.queue.clear()
            running = self._running
        if running:
            self.runner.cancel()

    def _check_working_dir(self) -> None:
        """作業フォルダが使えなければ OpenCodeError。"""
        if not self.working_dir:
            raise OpenCodeError("opencode 実行フォルダが未設定です（ランチャーの ☰ メニューか Web の設定で指定してください）")
        if not self.dir_exists(self.working_dir):
            raise OpenCodeError(f"opencode 実行フォルダが見つかりません: {self.working_dir}")

    def send(self, prompt: str, *, on_update: Callable[[], None] | None = None) -> bool:
        """
        指示を opencode へ送る。実行中なら待ち行列へ入れてすぐ戻る。
        実行した場合は、終わったあと待ち行列の指示も順に送ってから戻る。
        on_update には表示が変わるたびに通知する。空の指示は False、作業フォルダの未設定・不在は OpenCodeError。
        """
        cleaned_prompt = str(prompt or "").strip()
        if not cleaned_prompt:
            return False
        self._check_working_dir()
        with self._lock:
            if self._running:
                self.queue.append(cleaned_prompt)
                queued = True
            else:
                self._running = True
                queued = False
        if queued:
            _notify(on_update)
            return True
        try:
            next_prompt: str | None = cleaned_prompt
            while next_prompt is not None:
                self._run(next_prompt, on_update)
                with self._lock:
                    next_prompt = self.queue.pop(0) if self.queue else None
        finally:
            with self._lock:
                self._running = False
                self._started_at = None
            _notify(on_update)
        return True

    def _run(self, prompt: str, on_update: Callable[[], None] | None) -> None:
        """1 回分の実行と、結果のお知らせ。"""
        with self._lock:
            generation = self._generation
            self._started_at = self.clock()
        started = self._started_at
        self.history.add(prompt)
        self.transcript.add_user(prompt)
        expanded = expand_slash_command(prompt, self.slash_commands)
        args = build_opencode_args(
            expanded if expanded is not None else prompt,
            session_id=self.session_id,
            continue_session=self._has_conversation,
            model=self.model,
            plan_mode=self.plan_mode,
            auto_approve=self.auto_approve,
        )
        captured_session: list[str] = []
        shown_before = len(self.transcript.entries)

        def _handle_line(line: str) -> None:
            session_id = extract_session_id(line)
            if session_id and not captured_session:
                captured_session.append(session_id)
            if generation == self._generation and self.transcript.apply_line(line):
                _notify(on_update)

        _notify(on_update)
        try:
            result = self.runner.run(self.working_dir, args, _handle_line)
        except OpenCodeError as error:
            self.transcript.add_notice(str(error), error=True)
            self.status = f"opencode 実行失敗: {error}"
            return
        if generation != self._generation:
            return
        elapsed = self.clock() - (started if started is not None else self.clock())
        if result.cancelled:
            self.transcript.add_notice("中断しました")
            self.status = "中断しました"
        elif result.timed_out:
            self.transcript.add_notice("タイムアウトしたため停止しました", error=True)
            self.status = "タイムアウトしました"
        elif result.returncode != 0:
            detail = f": {result.stderr}" if result.stderr else ""
            self.transcript.add_notice(f"opencode 実行失敗（exit {result.returncode}）{detail}", error=True)
            self.status = f"opencode 実行失敗（exit {result.returncode}）"
        else:
            if not any(entry.kind in {"text", "tool"} for entry in self.transcript.entries[shown_before:]):
                self.transcript.add_notice("（応答なし）")
            self.status = f"完了（{format_elapsed(elapsed)}）"
        if captured_session:
            self.session_id = captured_session[0]
            self._has_conversation = True
        elif result.returncode == 0 and not result.cancelled and not result.timed_out:
            self._has_conversation = True

    def list_sessions(self) -> list[SessionSummary]:
        """作業フォルダの会話一覧（新しい順）。取れなければ空。"""
        self._check_working_dir()
        result = self.runner.capture(
            self.working_dir, ["session", "list", "--format", "json", "-n", str(SESSION_LIST_LIMIT)]
        )
        return parse_session_list(result.stdout) if result.returncode == 0 else []

    def resume(self, session_id: str) -> None:
        """
        過去の会話を読み込み、その会話 ID で続ける。実行中・読み込み失敗は OpenCodeError（今の会話は残す）。
        """
        self._check_working_dir()
        if self._running:
            raise OpenCodeError("opencode 実行中は会話を切り替えられません")
        result = self.runner.capture(self.working_dir, ["session", "export", session_id])
        data: Any = None
        if result.returncode == 0:
            try:
                start = result.stdout.find("{")
                data = json.JSONDecoder().raw_decode(result.stdout[start:])[0] if start >= 0 else None
            except ValueError:
                data = None
        if not isinstance(data, dict):
            raise OpenCodeError(f"会話を読み込めません: {result.stderr or session_id}")
        restored = ChatTranscript.from_export(data)
        with self._lock:
            self._generation += 1
        self.transcript.replace_with(restored)
        self.session_id = session_id
        self._has_conversation = True
        self.status = f"会話を再開しました: {restored.title or session_id}"

    def list_models(self) -> list[str]:
        """使えるモデルの一覧（`opencode models`）。取れなければ空。"""
        try:
            result = self.runner.capture(self.working_dir if self.working_dir and self.dir_exists(self.working_dir) else "", ["models"])
        except OpenCodeError:
            return []
        return parse_model_list(result.stdout) if result.returncode == 0 else []


def _notify(callback: Callable[[], None] | None) -> None:
    """表示更新の通知（未指定なら何もしない）。"""
    if callback is not None:
        callback()
