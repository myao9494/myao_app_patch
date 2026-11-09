"""
OpenCode ペインのスラッシュコマンド（このアプリ独自の定型作業。/pass など）の展開・入力チェック・補完。
AppKit に依存しない。WPF 版（SlashCommands.cs）と同じ約束で動く。

【仕様】
- コマンドは 名前・プロンプト・説明。保存はバックエンドの /api/index/settings/launcher-slash-commands（一覧ごと）。
- 展開: 指示の最初の語が「/登録済みの名前」（大文字小文字を区別しない）なら、プロンプトへ置き換えて送る。
  プロンプト中の $ARGUMENTS は名前の後ろの文字（前後の空白を除く）に置き換える。$ARGUMENTS が無ければ、
  後ろの文字があるときだけ空行のあとへ足す。登録の無い名前や /usr/bin のようなパスは展開せずそのまま送る。
- 登録の入力チェック: 名前（先頭の / は外す）が空・空白や / を含む・既存と重複、プロンプトが空はエラー。
- 補完（Obsidian と同じ操作）: 指示欄の先頭が / で、カーソルが最初の語の中にある間だけ候補を出す。
  候補は前方一致（名前順）→ 途中一致（名前順）。上下で選び（端で回る）、Tab / Enter で「/名前 」に置き換えて確定、Esc で閉じる。
  Esc で閉じたあとは文字が変わるまで開かない。Tab は候補が 1 つならすぐ補完、複数なら候補を開く。
"""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any

ARGUMENTS_PLACEHOLDER = "$ARGUMENTS"
_FIRST_TOKEN_RE = re.compile(r"^/(\S*)")


@dataclass(frozen=True)
class SlashCommand:
    """スラッシュコマンド 1 件。name は先頭の / を含まない。"""

    name: str
    prompt: str
    description: str = ""

    def to_payload(self) -> dict[str, str]:
        return {"name": self.name, "prompt": self.prompt, "description": self.description}


def normalize_name(name: str) -> str:
    """前後の空白と先頭の / を外す。"""
    return str(name or "").strip().lstrip("/")


def parse_commands(payload: Any) -> list[SlashCommand]:
    """API の {"commands": [...]}（または一覧そのもの）を読む。名前かプロンプトの無い項目は飛ばす。"""
    items = payload.get("commands") if isinstance(payload, dict) else payload
    commands: list[SlashCommand] = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        name = normalize_name(str(item.get("name") or ""))
        prompt = str(item.get("prompt") or "").strip()
        if name and prompt:
            commands.append(SlashCommand(name, prompt, str(item.get("description") or "").strip()))
    return commands


def validate_command(name: str, prompt: str, existing_names: list[str]) -> str | None:
    """登録画面の入力チェック。問題があれば利用者向けの文言、無ければ None。"""
    cleaned = normalize_name(name)
    if not cleaned:
        return "コマンド名を入力してください"
    if any(char.isspace() or char == "/" for char in cleaned):
        return "コマンド名に空白や / は使えません"
    if cleaned.lower() in {normalize_name(existing).lower() for existing in existing_names}:
        return f"/{cleaned} はすでに登録されています"
    if not str(prompt or "").strip():
        return "プロンプトを入力してください"
    return None


def _find(commands: list[SlashCommand], name: str) -> SlashCommand | None:
    lowered = name.lower()
    return next((command for command in commands if command.name.lower() == lowered), None)


def expand_slash_command(text: str, commands: list[SlashCommand]) -> str | None:
    """「/名前 引数」を登録したプロンプトへ展開する。登録の無い名前・コマンドでない文字は None。"""
    raw = str(text or "").strip()
    match = _FIRST_TOKEN_RE.match(raw)
    if not match or not match.group(1):
        return None
    command = _find(commands, match.group(1))
    if command is None:
        return None
    arguments = raw[match.end():].strip()
    if ARGUMENTS_PLACEHOLDER in command.prompt:
        return command.prompt.replace(ARGUMENTS_PLACEHOLDER, arguments)
    return f"{command.prompt}\n\n{arguments}" if arguments else command.prompt


def slash_query(text: str, caret: int) -> str | None:
    """先頭が / で、カーソルが最初の語の中にあるとき、/ の後ろからカーソルまでの文字（検索語）を返す。"""
    before = str(text or "")[: max(0, caret)]
    if not before.startswith("/") or any(char.isspace() for char in before):
        return None
    return before[1:]


def find_candidates(commands: list[SlashCommand], query: str) -> list[SlashCommand]:
    """前方一致（名前順）→ 途中一致（名前順）の候補。"""
    lowered = str(query or "").lower()
    ordered = sorted(commands, key=lambda command: command.name.lower())
    prefix = [command for command in ordered if command.name.lower().startswith(lowered)]
    contains = [command for command in ordered if lowered in command.name.lower() and command not in prefix]
    return prefix + contains


def apply_completion(text: str, caret: int, name: str) -> tuple[str, int]:
    """最初の語を「/名前 」へ置き換え、(新しい文字, カーソル位置) を返す。後ろの文字は残す。"""
    raw = str(text or "")
    match = _FIRST_TOKEN_RE.match(raw)
    rest = raw[match.end():] if match else raw[max(0, caret):]
    head = f"/{name}"
    if rest.startswith((" ", "\n", "\t")):
        return f"{head}{rest}", len(head) + 1
    return f"{head} {rest}", len(head) + 1


def completion_words(partial: str, commands: list[SlashCommand]) -> list[str]:
    """macOS の標準補完（NSTextView の complete:）へ渡す候補。補完範囲が / を含むなら / 付きで返す。"""
    with_slash = str(partial or "").startswith("/")
    query = partial[1:] if with_slash else str(partial or "")
    return [f"/{command.name}" if with_slash else command.name for command in find_candidates(commands, query)]


class SlashSuggestions:
    """指示欄の補完候補の表示状態（開閉・候補・選択位置）。"""

    def __init__(self) -> None:
        self.items: list[SlashCommand] = []
        self.index = 0
        self.is_open = False
        self._text: str | None = None
        self._dismissed_text: str | None = None

    @property
    def selected(self) -> SlashCommand | None:
        return self.items[self.index] if self.is_open and self.items else None

    def refresh(self, text: str, caret: int, commands: list[SlashCommand], *, force: bool = False) -> None:
        """入力が変わるたびに候補を作り直し、先頭を選ぶ。force は Esc で閉じた状態でも開く（Tab 用）。"""
        self._text = text
        query = slash_query(text, caret)
        if query is None:
            self._close()
            self._dismissed_text = None
            return
        if not force and self._dismissed_text == text:
            self._close()
            return
        self._dismissed_text = None
        # 入力が変わったら先頭の候補を選び直す（Obsidian と同じ）
        self.items = find_candidates(commands, query)
        self.index = 0
        self.is_open = bool(self.items)

    def move(self, delta: int) -> None:
        """選択を上下へ動かす（端で回る）。"""
        if self.items:
            self.index = (self.index + delta) % len(self.items)

    def accept(self, text: str, caret: int) -> tuple[str, int] | None:
        """選択中の候補で補完して閉じる。候補が無ければ None。"""
        command = self.selected
        if command is None:
            return None
        self._close()
        return apply_completion(text, caret, command.name)

    def dismiss(self) -> None:
        """Esc: 閉じて、文字が変わるまで開かない。"""
        self._dismissed_text = self._text
        self._close()

    def complete_on_tab(self, text: str, caret: int, commands: list[SlashCommand]) -> tuple[str, int] | None:
        """Tab: 開いていれば選択中を確定。閉じていれば、候補 1 つは即補完、複数は開いて None。"""
        if self.is_open:
            return self.accept(text, caret)
        self.refresh(text, caret, commands, force=True)
        if len(self.items) == 1 and self.is_open:
            return self.accept(text, caret)
        return None

    def _close(self) -> None:
        self.is_open = False
