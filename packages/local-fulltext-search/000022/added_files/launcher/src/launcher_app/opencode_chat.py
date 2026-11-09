"""
OpenCode ペインのチャット表示モデル（Obsidian の Claudian プラグイン風）と、表示用の書式・解析をまとめる。
AppKit に依存しないので、macOS 以外でもテストできる。WPF 版（OpenCodeChat.cs）と同じ約束で動く。

【仕様】
- 会話は「表示項目（ChatEntry）」の並び。種類は次の 5 つ。
  - user: 自分の指示（吹き出し）
  - text: opencode の応答本文（Markdown）
  - reasoning: 思考。既定で折りたたみ、見出しに「思考（n秒）」を出す
  - tool: ツール実行カード。見出しは「状態アイコン ツール名 要約」（✓ 完了 / ⏳ 実行中 / ✗ 失敗）。
    既定で折りたたみ、開くと入力と出力を表示する
  - notice: 中断・タイムアウト・失敗などのお知らせ（status は info / error）
- `opencode run --format json` の NDJSON イベントを apply_event / apply_line で取り込む。
  - text / reasoning / tool_use（tool_call）は part ID ごとに 1 項目。同じ ID が再び届いたら更新する
    （ツールの呼び出し ID は応答ごとに重なるため、partID を優先する）
  - step_finish は最後のトークン数をコンテキスト使用量とし、費用（cost）は合計する
  - error はエラーのお知らせ。step_start など他の制御イベントは表示しない
  - JSON でない行は ANSI を除いて本文（text）として残す
- `opencode session export` の JSON から過去の会話を復元できる（from_export）。
- 項目の更新は revision を上げる（画面は revision の変わった項目だけ描き直す）。
"""

from __future__ import annotations

from dataclasses import dataclass
import itertools
import json
import re
import threading
from typing import Any

_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
_MODEL_LINE_RE = re.compile(r"^[A-Za-z0-9._-]+/\S+$")
SUMMARY_LIMIT = 80
DETAIL_LIMIT = 4000
_STATUS_ICONS = {"completed": "✓", "running": "⏳", "pending": "⏳", "error": "✗"}


@dataclass
class ChatEntry:
    """会話の表示項目 1 つ。"""

    id: str
    kind: str
    text: str = ""
    tool: str = ""
    status: str = ""
    summary: str = ""
    detail_input: str = ""
    detail_output: str = ""
    duration_seconds: float | None = None
    expanded: bool = False
    revision: int = 0


@dataclass(frozen=True)
class SessionSummary:
    """会話一覧の 1 件（`opencode session list --format json`）。"""

    id: str
    title: str
    updated_ms: int


def _strip_ansi(text: str) -> str:
    """ANSI エスケープを除き、改行を LF に揃える。"""
    normalized = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    return _ANSI_ESCAPE_RE.sub("", normalized)


def _truncate(text: str, limit: int) -> str:
    """limit 文字を超えたら末尾を「…」にして limit 文字に収める。"""
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _duration(time_info: Any, start_key: str, end_key: str) -> float | None:
    """{start, end}（ミリ秒）からかかった秒数を返す。取れなければ None。"""
    if not isinstance(time_info, dict):
        return None
    start, end = time_info.get(start_key), time_info.get(end_key)
    if isinstance(start, (int, float)) and isinstance(end, (int, float)) and end >= start:
        return round((end - start) / 1000.0, 3)
    return None


def _context_tokens(tokens: Any) -> int | None:
    """step_finish の tokens から、コンテキストに載っているトークン数（入力+出力+思考+キャッシュ）を返す。"""
    if not isinstance(tokens, dict):
        return None
    cache = tokens.get("cache") if isinstance(tokens.get("cache"), dict) else {}
    values = [tokens.get("input"), tokens.get("output"), tokens.get("reasoning"), cache.get("read"), cache.get("write")]
    return int(sum(value for value in values if isinstance(value, (int, float))))


def summarize_tool(tool: str, tool_input: Any, title: str = "") -> str:
    """ツールカードの見出しに出す要約（パス・コマンド・検索語など）を返す。80 文字で切る。"""
    data = tool_input if isinstance(tool_input, dict) else {}
    name = str(tool or "").lower()

    def text(key: str) -> str:
        value = data.get(key)
        return str(value).strip() if isinstance(value, (str, int, float)) else ""

    summary = ""
    if name in {"read", "write", "edit", "patch", "list", "multiedit"}:
        summary = text("filePath") or text("path")
    elif name == "bash":
        summary = text("command").split("\n", 1)[0]
    elif name in {"grep", "glob"}:
        summary = text("pattern")
        if summary and text("path"):
            summary = f"{summary} in {text('path')}"
    elif name == "webfetch":
        summary = text("url")
    elif name == "websearch":
        summary = text("query")
    elif name == "task":
        summary = text("description")
    elif name == "todowrite":
        todos = data.get("todos") if isinstance(data.get("todos"), list) else []
        done = sum(1 for todo in todos if isinstance(todo, dict) and todo.get("status") == "completed")
        summary = f"Tasks {done}/{len(todos)}" if todos else ""
    if not summary:
        cleaned_title = str(title or "").strip()
        if cleaned_title and cleaned_title.lower() != name:
            summary = cleaned_title
    if not summary:
        summary = next((str(value).strip() for value in data.values() if isinstance(value, str) and value.strip()), "")
    return _truncate(summary.split("\n", 1)[0], SUMMARY_LIMIT)


def tool_header(tool: str, status: str, summary: str) -> str:
    """ツールカードの見出し（状態アイコン・ツール名・要約）。"""
    icon = _STATUS_ICONS.get(status, "⏳")
    return f"{icon} {tool}  {summary}" if summary else f"{icon} {tool}"


def format_elapsed(seconds: float) -> str:
    """経過時間の表示（10 秒未満は小数 1 桁、1 分以上は「1分05秒」）。"""
    value = max(0.0, float(seconds))
    if value < 10:
        return f"{value:.1f}秒"
    if value < 60:
        return f"{int(round(value))}秒"
    total = int(round(value))
    return f"{total // 60}分{total % 60:02d}秒"


def format_tokens(count: int) -> str:
    """トークン数の表示（950 / 10.7k / 1.3M）。"""
    if count >= 1_000_000:
        return f"{count / 1_000_000:.1f}M"
    if count >= 1000:
        return f"{count / 1000:.1f}k"
    return str(count)


def format_relative_time(updated_ms: int, now_ms: int) -> str:
    """会話一覧の更新時刻を「たった今 / n分前 / n時間前 / n日前」で表す。"""
    seconds = max(0, (now_ms - updated_ms) // 1000)
    if seconds < 60:
        return "たった今"
    if seconds < 3600:
        return f"{seconds // 60}分前"
    if seconds < 86400:
        return f"{seconds // 3600}時間前"
    return f"{seconds // 86400}日前"


def _first_json(text: str, opener: str) -> Any:
    """出力の中から最初の JSON（opener で始まる行以降）を読む。読めなければ None。"""
    raw = str(text or "")
    index = raw.find(opener)
    while index >= 0:
        try:
            return json.JSONDecoder().raw_decode(raw[index:])[0]
        except ValueError:
            index = raw.find(opener, index + 1)
    return None


def parse_session_list(stdout: str) -> list[SessionSummary]:
    """`opencode session list --format json` の出力から会話一覧を読む。余計な出力は無視する。"""
    data = _first_json(stdout, "[")
    if not isinstance(data, list):
        return []
    sessions: list[SessionSummary] = []
    for item in data:
        if isinstance(item, dict) and isinstance(item.get("id"), str):
            updated = item.get("updated")
            sessions.append(SessionSummary(
                item["id"],
                str(item.get("title") or ""),
                int(updated) if isinstance(updated, (int, float)) else 0,
            ))
    return sessions


def parse_model_list(stdout: str) -> list[str]:
    """`opencode models` の出力から「プロバイダー/モデル」の行だけを取り出す。"""
    return [line.strip() for line in str(stdout or "").splitlines() if _MODEL_LINE_RE.match(line.strip())]


class PromptHistory:
    """
    送った指示の履歴。↑（previous）で新しい順に呼び出し、↓（next）で戻る。
    最後まで戻ると呼び出し前の下書きを返し、その次は None（呼び出し中でない）。
    連続する同じ指示はまとめ、上限を超えたら古いものから捨てる。
    """

    def __init__(self, limit: int = 50) -> None:
        self.limit = limit
        self.items: list[str] = []
        self._index: int | None = None
        self._draft = ""

    def add(self, prompt: str) -> None:
        """送った指示を履歴へ足し、呼び出し位置を最初へ戻す。"""
        cleaned = str(prompt or "").strip()
        self._index = None
        if not cleaned or (self.items and self.items[-1] == cleaned):
            return
        self.items.append(cleaned)
        del self.items[: max(0, len(self.items) - self.limit)]

    def previous(self, current_draft: str) -> str | None:
        """1 つ前（古い方）の指示。履歴が空なら None。最古で止まる。"""
        if not self.items:
            return None
        if self._index is None:
            self._draft = current_draft
            self._index = len(self.items) - 1
        else:
            self._index = max(0, self._index - 1)
        return self.items[self._index]

    def next(self) -> str | None:
        """1 つ後（新しい方）の指示。最新を過ぎたら下書き、呼び出し中でなければ None。"""
        if self._index is None:
            return None
        if self._index >= len(self.items) - 1:
            self._index = None
            return self._draft
        self._index += 1
        return self.items[self._index]


class ChatTranscript:
    """
    OpenCode ペインに表示する会話。opencode の出力を読むスレッドと画面のスレッドの両方から触るため、
    更新と読み出しはロックで守る。
    """

    def __init__(self) -> None:
        self.entries: list[ChatEntry] = []
        self.context_tokens = 0
        self.cost = 0.0
        self.title = ""
        self._ids = itertools.count(1)
        self._lock = threading.RLock()

    def _new_id(self, prefix: str) -> str:
        return f"{prefix}{next(self._ids)}"

    def _find(self, entry_id: str) -> ChatEntry | None:
        return next((entry for entry in self.entries if entry.id == entry_id), None)

    def _upsert(self, entry_id: str, kind: str, **values: Any) -> ChatEntry:
        """同じ ID があれば更新（revision を上げる）、なければ末尾へ追加する。"""
        with self._lock:
            entry = self._find(entry_id)
            if entry is None:
                entry = ChatEntry(entry_id, kind, **values)
                self.entries.append(entry)
                return entry
            for key, value in values.items():
                setattr(entry, key, value)
            entry.revision += 1
            return entry

    def snapshot(self) -> list[ChatEntry]:
        """今の表示項目の写し（描画中に別スレッドが更新しても崩れない）。"""
        with self._lock:
            return [ChatEntry(**vars(entry)) for entry in self.entries]

    @property
    def is_empty(self) -> bool:
        return not self.entries

    def clear(self) -> None:
        """表示と使用量を消す。"""
        with self._lock:
            self.entries.clear()
            self.context_tokens = 0
            self.cost = 0.0
            self.title = ""

    def replace_with(self, other: "ChatTranscript") -> None:
        """表示・使用量・題名を other の内容へ置き換える（過去の会話の読み込み）。"""
        restored = other.snapshot()
        with self._lock:
            self.entries[:] = restored
            self.context_tokens = other.context_tokens
            self.cost = other.cost
            self.title = other.title
            # 読み込んだ項目（1〜n 番）と ID が重ならないよう、続きの番号から採番する
            self._ids = itertools.count(len(restored) + 1)

    def add_user(self, text: str) -> ChatEntry:
        """自分の指示を吹き出しとして足す。"""
        return self._upsert(self._new_id("user_"), "user", text=str(text or "").strip())

    def add_notice(self, text: str, *, error: bool = False) -> ChatEntry:
        """お知らせ（中断・失敗など）を足す。"""
        return self._upsert(self._new_id("notice_"), "notice", text=text, status="error" if error else "info")

    def toggle(self, entry_id: str) -> bool:
        """思考・ツールの開閉を切り替える。見つからなければ False。"""
        with self._lock:
            entry = self._find(entry_id)
            if entry is None:
                return False
            entry.expanded = not entry.expanded
            entry.revision += 1
            return True

    def copy_text(self, entry_id: str) -> str:
        """吹き出し単位のコピー用文字列。"""
        with self._lock:
            entry = self._find(entry_id)
            return entry.text if entry is not None else ""

    def last_assistant_text(self) -> str:
        """最後の応答本文。"""
        with self._lock:
            return next((entry.text for entry in reversed(self.entries) if entry.kind == "text"), "")

    def usage_text(self) -> str:
        """「コンテキスト 10.1k トークン · $0.0300」。使用量が無ければ空文字。"""
        if self.context_tokens <= 0:
            return ""
        text = f"コンテキスト {format_tokens(self.context_tokens)} トークン"
        return f"{text} · ${self.cost:.4f}" if self.cost > 0 else text

    def apply_line(self, line: str) -> bool:
        """NDJSON の 1 行を取り込む。表示が変わったら True。"""
        raw = str(line or "").strip()
        if not raw:
            return False
        payload: Any = None
        if raw.startswith("{") and raw.endswith("}"):
            try:
                payload = json.loads(raw)
            except ValueError:
                payload = None
        if isinstance(payload, dict):
            return self.apply_event(payload)
        cleaned = _strip_ansi(raw).strip()
        if not cleaned:
            return False
        self._upsert(self._new_id("raw_"), "text", text=cleaned)
        return True

    def apply_event(self, payload: dict[str, Any]) -> bool:
        """opencode のイベント 1 つを取り込む。表示が変わったら True。"""
        event_type = str(payload.get("type") or "")
        part = payload.get("part") if isinstance(payload.get("part"), dict) else {}
        if event_type == "text":
            text = str(part.get("text") if "text" in part else payload.get("text") or "")
            if not text.strip():
                return False
            self._upsert(str(part.get("id") or self._new_id("text_")), "text", text=text)
            return True
        if event_type == "reasoning":
            text = str(part.get("text") or "")
            if not text.strip():
                return False
            self._upsert(
                str(part.get("id") or self._new_id("reasoning_")), "reasoning",
                text=text.strip(), duration_seconds=_duration(part.get("time"), "start", "end"),
            )
            return True
        if event_type in {"tool_use", "tool_call"}:
            self._apply_tool(part)
            return True
        if event_type == "step_finish":
            with self._lock:
                tokens = _context_tokens(part.get("tokens"))
                if tokens:
                    self.context_tokens = tokens
                cost = part.get("cost")
                if isinstance(cost, (int, float)):
                    self.cost += float(cost)
            return True
        if event_type == "error":
            self.add_notice(_error_message(payload), error=True)
            return True
        return False

    def _apply_tool(self, part: dict[str, Any], *, entry_id: str | None = None) -> None:
        """ツールの part（run の tool_use / export の tool）をカードへ反映する。"""
        state = part.get("state") if isinstance(part.get("state"), dict) else {}
        tool = str(part.get("tool") or part.get("name") or "tool")
        tool_input = state.get("input")
        status = str(state.get("status") or "running")
        output = state.get("output")
        if output is None and isinstance(state.get("content"), list):
            output = "\n".join(
                str(item.get("text") or "") for item in state["content"] if isinstance(item, dict)
            )
        if status == "error" and not output:
            output = state.get("error")
        self._upsert(
            entry_id or str(part.get("partID") or part.get("id") or self._new_id("tool_")),
            "tool",
            tool=tool,
            status="running" if status == "pending" else status,
            summary=summarize_tool(tool, tool_input, str(state.get("title") or part.get("title") or "")),
            detail_input=_truncate(json.dumps(tool_input, ensure_ascii=False, indent=2), DETAIL_LIMIT) if tool_input else "",
            detail_output=_truncate(_strip_ansi(str(output or "")).strip(), DETAIL_LIMIT),
        )

    @classmethod
    def from_export(cls, data: dict[str, Any]) -> "ChatTranscript":
        """`opencode session export` の JSON から会話を復元する。"""
        transcript = cls()
        info = data.get("info") if isinstance(data.get("info"), dict) else {}
        transcript.title = str(info.get("title") or "")
        messages = data.get("messages") if isinstance(data.get("messages"), list) else []
        for message in messages:
            if not isinstance(message, dict):
                continue
            kind = message.get("type") or message.get("role")
            if kind == "user":
                transcript.add_user(str(message.get("text") or ""))
                continue
            if kind != "assistant":
                continue
            for item in message.get("content") or []:
                if not isinstance(item, dict):
                    continue
                if item.get("type") == "text" and str(item.get("text") or "").strip():
                    transcript._upsert(transcript._new_id("text_"), "text", text=str(item["text"]))
                elif item.get("type") == "reasoning" and str(item.get("text") or "").strip():
                    transcript._upsert(
                        transcript._new_id("reasoning_"), "reasoning", text=str(item["text"]).strip(),
                        duration_seconds=_duration(item.get("time"), "created", "completed"),
                    )
                elif item.get("type") == "tool":
                    transcript._apply_tool(item, entry_id=transcript._new_id("tool_"))
            tokens = _context_tokens(message.get("tokens"))
            if tokens:
                transcript.context_tokens = tokens
            cost = message.get("cost")
            if isinstance(cost, (int, float)):
                transcript.cost += float(cost)
        return transcript


def _error_message(payload: dict[str, Any]) -> str:
    """error イベントから利用者に見せる文言を取り出す。"""
    error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
    data = error.get("data") if isinstance(error.get("data"), dict) else {}
    return str(data.get("message") or error.get("message") or payload.get("message") or error.get("name") or "不明なエラー")


__all__ = [
    "ChatEntry",
    "ChatTranscript",
    "PromptHistory",
    "SessionSummary",
    "format_elapsed",
    "format_relative_time",
    "format_tokens",
    "parse_model_list",
    "parse_session_list",
    "summarize_tool",
    "tool_header",
]

