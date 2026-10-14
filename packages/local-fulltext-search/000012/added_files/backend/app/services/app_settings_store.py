"""
アプリ共有設定の正規化と永続化。

仕様:
- 設定は data_dir 配下のプレーンテキスト（1 設定 1 ファイル）として保存し、人が直接編集できる形を保つ。
- 未作成の設定ファイルは、読み込み時に既定値で自動生成する（削除確認設定だけは生成せず既定 True を返す）。
- 除外キーワードは、旧 SQLite 保存値（app_settings テーブル）が残っていれば初回だけテキストへ移行する。
- 類似語・専門用語リストは `用語1,用語2 : 解説` 形式。通常検索の OR 展開には用語部分だけを使う。
- 壊れた値（未知の Web 取得方式・ホットキー）は既定値へ書き戻す。
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from app.config import settings
from app.db.connection import ensure_data_dir
from app.extractors.text_extractor import normalize_extension_filter, normalize_extension_token
from app.models.indexing import DEFAULT_EXCLUDE_KEYWORDS, AppSettingsResponse
from app.services import exclude_rules

WEB_FETCH_MODES = frozenset({"http", "edge", "chrome"})
DEFAULT_WEB_FETCH_MODE = "http"
LAUNCHER_HOTKEYS = frozenset({"command_option", "double_shift"})
DEFAULT_LAUNCHER_HOTKEY = "command_option"


def normalize_exclude_keywords(value: str | None) -> str:
    """除外キーワードを重複なしの改行区切りへ正規化する。"""
    return "\n".join(exclude_rules.parse_exclude_keywords(value))


def parse_extension_entries(value: str | None) -> list[str]:
    """カンマまたは改行区切りの拡張子一覧を、重複なしの正規化済みリストへ変換する。"""
    seen: set[str] = set()
    extensions: list[str] = []
    for raw_token in (value or "").replace(",", "\n").splitlines():
        extension = normalize_extension_token(raw_token)
        if not extension or extension in seen:
            continue
        seen.add(extension)
        extensions.append(extension)
    return extensions


def normalize_extension_entries(value: str | None) -> str:
    return "\n".join(parse_extension_entries(value))


def normalize_selected_extensions(
    value: str | None,
    *,
    custom_content_extensions: str = "",
    custom_filename_extensions: str = "",
) -> str:
    """インデックス対象拡張子を、対応拡張子（標準 + 追加分）の範囲でソート済み改行区切りへ正規化する。"""
    return "\n".join(
        sorted(
            normalize_extension_filter(
                value,
                extra_content_extensions=tuple(parse_extension_entries(custom_content_extensions)),
                extra_filename_extensions=tuple(parse_extension_entries(custom_filename_extensions)),
            )
        )
    )


def parse_synonym_entries(value: str | None) -> list[dict[str, Any]]:
    """
    1行ごとに「類似語群（カンマ区切り）」と「意味・解説（コロン以降）」を抽出する。
    例: PC,パソコン:パーソナルコンピュータの略称
    ASCII は大文字小文字違いを同一語として扱い、元の表記は先勝ちで残す。
    """
    entries: list[dict[str, Any]] = []
    for line in (value or "").splitlines():
        line_str = line.strip()
        if not line_str:
            continue
        # コロン（半角・全角）で類似語と解説を分離
        if ":" in line_str:
            terms_part, desc_part = line_str.split(":", 1)
        elif "：" in line_str:
            terms_part, desc_part = line_str.split("：", 1)
        else:
            terms_part, desc_part = line_str, ""

        seen: set[str] = set()
        group: list[str] = []
        for raw_token in terms_part.replace("，", ",").split(","):
            token = raw_token.strip()
            normalized_token = token.casefold()
            if not token or normalized_token in seen:
                continue
            seen.add(normalized_token)
            group.append(token)

        if group:
            entries.append({"terms": group, "description": desc_part.strip()})
    return entries


def parse_synonym_groups(value: str | None) -> list[list[str]]:
    """
    同義語リストは 1 行を 1 グループとして解釈し、カンマ区切りで重複を除去する。
    コロン以降の意味・解説は除外して通常検索のOR展開用グループのみを返す。
    """
    return [entry["terms"] for entry in parse_synonym_entries(value) if entry["terms"]]


def normalize_synonym_groups(value: str | None) -> str:
    lines: list[str] = []
    for entry in parse_synonym_entries(value):
        terms = ",".join(entry["terms"])
        description = entry["description"]
        lines.append(f"{terms}:{description}" if description else terms)
    return "\n".join(lines)


def normalize_gantt_parent(value: object) -> int:
    """gantt の parent ID を 0 以上の整数へ正規化する（不正値は 0）。"""
    try:
        parent = int(str(value).strip())
    except (TypeError, ValueError):
        return 0
    return parent if parent >= 0 else 0


def normalize_web_fetch_mode(value: str) -> str:
    """Web取得方式は通常HTTP・Edge・Chromeだけを許可する。"""
    normalized = value.strip().lower()
    if normalized not in WEB_FETCH_MODES:
        raise ValueError("web_fetch_mode must be http, edge, or chrome.")
    return normalized


def normalize_launcher_hotkey(value: object) -> str:
    """ランチャーで選べる2種類のグローバルショートカットだけを保存する。"""
    normalized = str(value or "").strip().lower()
    if normalized not in LAUNCHER_HOTKEYS:
        raise ValueError("launcher_hotkey must be command_option or double_shift.")
    return normalized


def normalize_plain_text(value: str | None) -> str:
    """前後の空白だけを取り除く（パスなど、内容を加工しない設定値用）。"""
    return str(value or "").strip()


def merge_app_settings(
    current: AppSettingsResponse,
    *,
    exclude_keywords: str | None = None,
    web_exclude_keywords: str | None = None,
    web_fetch_mode: str | None = None,
    hidden_indexed_targets: str | None = None,
    synonym_groups: str | None = None,
    obsidian_sidebar_explorer_data_path: str | None = None,
    gantt_parent: int | None = None,
    launcher_hotkey: str | None = None,
    index_selected_extensions: str | None = None,
    custom_content_extensions: str | None = None,
    custom_filename_extensions: str | None = None,
    confirm_index_deletion: bool | None = None,
) -> AppSettingsResponse:
    """
    現在の設定へ、指定された項目（None 以外）だけを正規化して上書きした設定を返す。
    インデックス対象の拡張子は、追加拡張子の変更で候補が変わるため、指定が無くても正規化し直す。
    """

    def pick(value, normalize, current_value):
        return normalize(value) if value is not None else current_value

    merged_custom_content_extensions = pick(
        custom_content_extensions, normalize_extension_entries, current.custom_content_extensions
    )
    merged_custom_filename_extensions = pick(
        custom_filename_extensions, normalize_extension_entries, current.custom_filename_extensions
    )
    return AppSettingsResponse(
        exclude_keywords=pick(exclude_keywords, normalize_exclude_keywords, current.exclude_keywords),
        web_exclude_keywords=pick(web_exclude_keywords, normalize_exclude_keywords, current.web_exclude_keywords),
        web_fetch_mode=pick(web_fetch_mode, normalize_web_fetch_mode, current.web_fetch_mode),
        hidden_indexed_targets=pick(hidden_indexed_targets, normalize_exclude_keywords, current.hidden_indexed_targets),
        synonym_groups=pick(synonym_groups, normalize_synonym_groups, current.synonym_groups),
        obsidian_sidebar_explorer_data_path=pick(
            obsidian_sidebar_explorer_data_path, normalize_plain_text, current.obsidian_sidebar_explorer_data_path
        ),
        gantt_parent=pick(gantt_parent, normalize_gantt_parent, current.gantt_parent),
        launcher_hotkey=pick(launcher_hotkey, normalize_launcher_hotkey, current.launcher_hotkey),
        index_selected_extensions=normalize_selected_extensions(
            index_selected_extensions if index_selected_extensions is not None else current.index_selected_extensions,
            custom_content_extensions=merged_custom_content_extensions,
            custom_filename_extensions=merged_custom_filename_extensions,
        ),
        custom_content_extensions=merged_custom_content_extensions,
        custom_filename_extensions=merged_custom_filename_extensions,
        confirm_index_deletion=pick(confirm_index_deletion, bool, current.confirm_index_deletion),
    )


def _write_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8")


class AppSettingsStore:
    """data_dir 配下の設定ファイル群を読み書きする。"""

    def __init__(self, legacy_exclude_keywords_reader: Callable[[], str | None] | None = None) -> None:
        # 旧 SQLite 保存方式からの初回移行用。接続を持たない呼び出し元では None のままでよい。
        self._legacy_exclude_keywords_reader = legacy_exclude_keywords_reader

    def load(self) -> AppSettingsResponse:
        """アプリ全体で共有する設定値をまとめて読み込む。"""
        custom_content_extensions = self.read_custom_content_extensions()
        custom_filename_extensions = self.read_custom_filename_extensions()
        return AppSettingsResponse(
            exclude_keywords=self.read_exclude_keywords(),
            web_exclude_keywords=self.read_web_exclude_keywords(),
            web_fetch_mode=self.read_web_fetch_mode(),
            hidden_indexed_targets=self.read_hidden_indexed_targets(),
            synonym_groups=self.read_synonym_groups(),
            obsidian_sidebar_explorer_data_path=self.read_obsidian_sidebar_explorer_data_path(),
            gantt_parent=self.read_gantt_parent(),
            launcher_hotkey=self.read_launcher_hotkey(),
            index_selected_extensions=self.read_index_selected_extensions(
                custom_content_extensions=custom_content_extensions,
                custom_filename_extensions=custom_filename_extensions,
            ),
            custom_content_extensions=custom_content_extensions,
            custom_filename_extensions=custom_filename_extensions,
            confirm_index_deletion=self.read_confirm_index_deletion(),
        )

    def save(self, values: AppSettingsResponse) -> None:
        """設定値をまとめて保存する。"""
        self.write_exclude_keywords(values.exclude_keywords)
        self.write_web_exclude_keywords(values.web_exclude_keywords)
        self.write_web_fetch_mode(values.web_fetch_mode)
        self.write_hidden_indexed_targets(values.hidden_indexed_targets)
        self.write_synonym_groups(values.synonym_groups)
        self.write_obsidian_sidebar_explorer_data_path(values.obsidian_sidebar_explorer_data_path)
        self.write_gantt_parent(values.gantt_parent)
        self.write_launcher_hotkey(values.launcher_hotkey)
        self.write_custom_content_extensions(values.custom_content_extensions)
        self.write_custom_filename_extensions(values.custom_filename_extensions)
        self.write_index_selected_extensions(values.index_selected_extensions)
        self.write_confirm_index_deletion(values.confirm_index_deletion)

    def _read_or_initialize(self, path: Path, normalize: Callable[[str], str], default: str = "") -> str:
        """設定ファイルを正規化して読み込み、未作成なら既定値で作成する。"""
        ensure_data_dir()
        if path.exists():
            return normalize(path.read_text(encoding="utf-8"))
        _write_text(path, normalize(default))
        return default

    def _write_normalized(self, path: Path, normalize: Callable[[str], str], value: str) -> None:
        ensure_data_dir()
        _write_text(path, normalize(value))

    # --- 除外キーワード ---

    def read_exclude_keywords(self) -> str:
        """
        除外キーワードは人が直接編集しやすいテキストファイルから読み込む。
        旧 SQLite 保存値が残っている場合は初回だけテキストへ移行する。
        """
        ensure_data_dir()
        path = settings.exclude_keywords_path
        if path.exists():
            return normalize_exclude_keywords(path.read_text(encoding="utf-8"))

        legacy_keywords = self._legacy_exclude_keywords_reader() if self._legacy_exclude_keywords_reader else None
        initial_value = normalize_exclude_keywords(legacy_keywords or DEFAULT_EXCLUDE_KEYWORDS)
        self.write_exclude_keywords(initial_value)
        return initial_value

    def write_exclude_keywords(self, value: str) -> None:
        self._write_normalized(settings.exclude_keywords_path, normalize_exclude_keywords, value)

    def read_web_exclude_keywords(self) -> str:
        """Web クロール専用の除外キーワードを読み込む。"""
        return self._read_or_initialize(settings.web_exclude_keywords_path, normalize_exclude_keywords)

    def write_web_exclude_keywords(self, value: str) -> None:
        self._write_normalized(settings.web_exclude_keywords_path, normalize_exclude_keywords, value)

    def read_hidden_indexed_targets(self) -> str:
        """一覧から隠したい確認済みフォルダ用キーワードを読み込む。"""
        return self._read_or_initialize(settings.hidden_indexed_targets_path, normalize_exclude_keywords)

    def write_hidden_indexed_targets(self, value: str) -> None:
        self._write_normalized(settings.hidden_indexed_targets_path, normalize_exclude_keywords, value)

    # --- Web 取得方式 ---

    def read_web_fetch_mode(self) -> str:
        """未設定・不正値の環境では従来互換の通常HTTPを使う。"""
        ensure_data_dir()
        path = settings.web_fetch_mode_path
        if path.exists():
            try:
                return normalize_web_fetch_mode(path.read_text(encoding="utf-8"))
            except ValueError:
                pass
        self.write_web_fetch_mode(DEFAULT_WEB_FETCH_MODE)
        return DEFAULT_WEB_FETCH_MODE

    def write_web_fetch_mode(self, value: str) -> None:
        self._write_normalized(settings.web_fetch_mode_path, normalize_web_fetch_mode, value)

    # --- 類似語・専門用語 ---

    def read_synonym_groups(self) -> str:
        """類似語・専門用語リスト（1 行 1 グループ）を読み込む。"""
        return self._read_or_initialize(settings.synonym_groups_path, normalize_synonym_groups)

    def write_synonym_groups(self, value: str) -> None:
        self._write_normalized(settings.synonym_groups_path, normalize_synonym_groups, value)

    # --- Obsidian / gantt / ランチャー ---

    def read_obsidian_sidebar_explorer_data_path(self) -> str:
        """Obsidian sidebar-explorer の data.json パスを読み込む。"""
        return self._read_or_initialize(settings.obsidian_sidebar_explorer_data_path_path, normalize_plain_text)

    def write_obsidian_sidebar_explorer_data_path(self, value: str) -> None:
        self._write_normalized(settings.obsidian_sidebar_explorer_data_path_path, normalize_plain_text, value)

    def read_gantt_parent(self) -> int:
        """ランチャーの gantt タスク作成で使う parent ID を読み込む。"""
        ensure_data_dir()
        path = settings.gantt_parent_path
        if path.exists():
            return normalize_gantt_parent(path.read_text(encoding="utf-8"))
        self.write_gantt_parent(0)
        return 0

    def write_gantt_parent(self, value: int) -> None:
        ensure_data_dir()
        _write_text(settings.gantt_parent_path, str(normalize_gantt_parent(value)))

    def read_launcher_hotkey(self) -> str:
        """未設定・壊れた設定は従来互換の Command + Option に戻す。"""
        try:
            return normalize_launcher_hotkey(settings.launcher_hotkey_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.write_launcher_hotkey(DEFAULT_LAUNCHER_HOTKEY)
            return DEFAULT_LAUNCHER_HOTKEY

    def write_launcher_hotkey(self, value: object) -> None:
        _write_text(settings.launcher_hotkey_path, normalize_launcher_hotkey(value))

    # --- 削除確認 ---

    def read_confirm_index_deletion(self) -> bool:
        """インデックス削除時の確認ダイアログ表示設定を読み込む（既定: True）。"""
        ensure_data_dir()
        path = settings.confirm_index_deletion_path
        if path.exists():
            return path.read_text(encoding="utf-8").strip() != "0"
        return True

    def write_confirm_index_deletion(self, value: bool) -> None:
        ensure_data_dir()
        _write_text(settings.confirm_index_deletion_path, "1" if value else "0")

    # --- 拡張子 ---

    def read_custom_content_extensions(self) -> str:
        """本文抽出対象として追加した拡張子一覧を読み込む。"""
        return self._read_or_initialize(settings.custom_content_extensions_path, normalize_extension_entries)

    def write_custom_content_extensions(self, value: str) -> None:
        self._write_normalized(settings.custom_content_extensions_path, normalize_extension_entries, value)

    def read_custom_filename_extensions(self) -> str:
        """ファイル名のみ検索対象として追加した拡張子一覧を読み込む。"""
        return self._read_or_initialize(settings.custom_filename_extensions_path, normalize_extension_entries)

    def write_custom_filename_extensions(self, value: str) -> None:
        self._write_normalized(settings.custom_filename_extensions_path, normalize_extension_entries, value)

    def read_index_selected_extensions(self, *, custom_content_extensions: str, custom_filename_extensions: str) -> str:
        """
        インデックス対象として有効化された拡張子一覧を読み込む。
        初回は現在サポートしている全拡張子を既定値として保存する。
        """
        ensure_data_dir()
        path = settings.index_selected_extensions_path
        raw_value = path.read_text(encoding="utf-8") if path.exists() else None
        selected_extensions = normalize_selected_extensions(
            raw_value,
            custom_content_extensions=custom_content_extensions,
            custom_filename_extensions=custom_filename_extensions,
        )
        if raw_value is None:
            self.write_index_selected_extensions(selected_extensions)
        return selected_extensions

    def write_index_selected_extensions(self, value: str) -> None:
        self._write_normalized(settings.index_selected_extensions_path, normalize_extension_entries, value)




def load_app_settings() -> AppSettingsResponse:
    """DB 接続を必要としない呼び出し元（ベクトルインデックス等）向けに、現在の共有設定を読み込む。"""
    return AppSettingsStore().load()
