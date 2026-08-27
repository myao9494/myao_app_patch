"""
アプリケーション設定
- ベースディレクトリの設定（環境変数 FILE_MANAGER_BASE_DIR で指定）
- OS判定とパス正規化
- UI設定ファイルの読み書き

注: インデックス検索機能は外部サービス（file_index_service）に移行
"""
import json
import os
import platform
from pathlib import Path
from typing import Literal, Optional

from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

# .envファイルを読み込み（存在する場合）
# スクリプト実行ディレクトリまたはbackendディレクトリの.envを探す
_env_file = Path(__file__).parent.parent / ".env"
if _env_file.exists():
    load_dotenv(_env_file)


class Settings(BaseSettings):
    """アプリケーション設定"""

    model_config = SettingsConfigDict(
        env_prefix="FILE_MANAGER_",
        extra="ignore",
    )

    # サーバー設定
    host: str = "127.0.0.1"
    port: int = 8001
    fulltext_service_url: str = "http://127.0.0.1:8079"
    fulltext_refresh_window_minutes: int = 60
    file_io_workers: int = 16

    # OS判定
    is_windows: bool = platform.system() == "Windows"

    # テスト用のベースディレクトリオーバーライド
    _base_dir_override: Optional[Path] = None
    _preferences_file_override: Optional[Path] = None

    @property
    def base_dir(self) -> Path:
        """ベースディレクトリを取得"""
        if self._base_dir_override is not None:
            return self._base_dir_override

        # 環境変数で指定されている場合はそれを使用
        env_val = os.environ.get("FILE_MANAGER_BASE_DIR")
        if env_val:
            return Path(env_val)

        # フォールバック: OSに応じたデフォルト
        # Windows: USERPROFILEをルート（制限範囲）とする
        if self.is_windows:
            user_profile = os.environ.get("USERPROFILE")
            if user_profile:
                return Path(user_profile)
            return Path.home()
        # macOS/Linux: HOMEをルートとする
        return Path.home()

    @property
    def start_dir(self) -> Path:
        """初期表示ディレクトリを取得"""
        # 環境変数で指定されている場合はそれを使用
        env_val = os.environ.get("FILE_MANAGER_START_DIR")
        if env_val:
            return Path(env_val)
            
        # FILE_MANAGER_BASE_DIR が設定されている場合はそれをそのまま使用
        if os.environ.get("FILE_MANAGER_BASE_DIR"):
            return self.base_dir

        # デフォルトは base_dir/000_work (Windows) または base_dir/Documents
        if self.is_windows:
             return self.base_dir / "000_work"
        return self.base_dir


    @property
    def obsidian_base_dir(self) -> Path:
        """Obsidianのベースディレクトリを取得"""
        # 環境変数で指定されている場合はそれを使用
        env_val = os.environ.get("FILE_MANAGER_OBSIDIAN_BASE_DIR")
        if env_val:
            return Path(env_val)

        # デフォルト設定（ユーザー指定のパスを参考）
        if self.is_windows:
            # Windows版のデフォルト（例: D:\obsidian-dagnetz\01_data など、環境に合わせて変更可能）
            # ここでは暫定的に base_dir / "obsidian-dagnetz" / "01_data" とする
            return self.base_dir / "obsidian-dagnetz" / "01_data"
        else:
            # macOS版のデフォルト
            return Path("/Users/mine/000_work/obsidian-dagnetz/01_data")

    @property
    def preferences_file_path(self) -> Path:
        """UI設定を保存するJSONファイルのパスを取得"""
        if self._preferences_file_override is not None:
            return self._preferences_file_override

        env_val = os.environ.get("FILE_MANAGER_PREFERENCES_FILE")
        if env_val:
            return Path(env_val)

        return Path(__file__).parent.parent / "settings.json"


TextFileOpenMode = Literal["web", "vscode"]
MarkdownOpenMode = Literal["web", "external", "obsidian_or_web"]

DEFAULT_EDITOR_PREFERENCES = {
    "textFileOpenMode": "web",
    "markdownOpenMode": "web",
    "apiTimeout": 10,
    "folderLatestModifiedMaxEntries": 20_000,
    "defaultTextFileExtension": "txt",
    "pathMappings": {},
}

FOLDER_LATEST_MODIFIED_MAX_ENTRIES_DEFAULT = 20_000
FOLDER_LATEST_MODIFIED_MAX_ENTRIES_MAX = 1_000_000


def _normalize_text_file_open_mode(value: object) -> TextFileOpenMode:
    if value == "vscode":
        return "vscode"
    return "web"


def _normalize_markdown_open_mode(value: object) -> MarkdownOpenMode:
    if value in {"external", "obsidian", "vscode"}:
        return "external"
    if value in {"obsidian_or_web", "obsidian_web"}:
        return "obsidian_or_web"
    return "web"


def _normalize_folder_latest_modified_max_entries(value: object) -> int:
    """フォルダ最新日時の走査上限を安全な範囲に正規化する。"""
    try:
        max_entries = int(value)
    except (ValueError, TypeError):
        return FOLDER_LATEST_MODIFIED_MAX_ENTRIES_DEFAULT
    if max_entries < 1:
        return FOLDER_LATEST_MODIFIED_MAX_ENTRIES_DEFAULT
    return min(max_entries, FOLDER_LATEST_MODIFIED_MAX_ENTRIES_MAX)


def _normalize_default_text_file_extension(value: object) -> str:
    """テキストファイル作成用の拡張子を安全な形式に正規化する。"""
    extension = str(value or "").strip().lstrip(".")
    if not extension or len(extension) > 32:
        return "txt"
    if any(char in extension for char in "/\\\0") or any(char.isspace() for char in extension):
        return "txt"
    return extension


def get_editor_preferences() -> dict[str, object]:
    """UI設定ファイルからエディタ設定を読み込む"""
    path = settings.preferences_file_path

    try:
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                timeout_val = data.get("apiTimeout")
                try:
                    api_timeout = int(timeout_val) if timeout_val is not None else 10
                    if api_timeout <= 0:
                        api_timeout = 10
                except (ValueError, TypeError):
                    api_timeout = 10

                path_mappings = data.get("pathMappings")
                if not isinstance(path_mappings, dict):
                    path_mappings = {}

                return {
                    "textFileOpenMode": _normalize_text_file_open_mode(data.get("textFileOpenMode")),
                    "markdownOpenMode": _normalize_markdown_open_mode(data.get("markdownOpenMode")),
                    "apiTimeout": api_timeout,
                    "folderLatestModifiedMaxEntries": _normalize_folder_latest_modified_max_entries(
                        data.get("folderLatestModifiedMaxEntries")
                    ),
                    "defaultTextFileExtension": _normalize_default_text_file_extension(
                        data.get("defaultTextFileExtension")
                    ),
                    "pathMappings": path_mappings,
                }
    except (OSError, json.JSONDecodeError):
        pass

    return DEFAULT_EDITOR_PREFERENCES.copy()


def save_editor_preferences(
    text_file_open_mode: TextFileOpenMode,
    markdown_open_mode: MarkdownOpenMode,
    api_timeout: int = 10,
    path_mappings: Optional[dict[str, str]] = None,
    folder_latest_modified_max_entries: int = FOLDER_LATEST_MODIFIED_MAX_ENTRIES_DEFAULT,
    default_text_file_extension: str = "txt",
) -> dict[str, object]:
    """UI設定ファイルへエディタ設定を書き込む"""
    path = settings.preferences_file_path
    path.parent.mkdir(parents=True, exist_ok=True)

    preferences = {
        "textFileOpenMode": _normalize_text_file_open_mode(text_file_open_mode),
        "markdownOpenMode": _normalize_markdown_open_mode(markdown_open_mode),
        "apiTimeout": api_timeout if api_timeout > 0 else 10,
        "folderLatestModifiedMaxEntries": _normalize_folder_latest_modified_max_entries(
            folder_latest_modified_max_entries
        ),
        "defaultTextFileExtension": _normalize_default_text_file_extension(default_text_file_extension),
        "pathMappings": path_mappings if isinstance(path_mappings, dict) else {},
    }
    path.write_text(
        json.dumps(preferences, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return preferences


settings = Settings()
