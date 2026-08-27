"""
Excalidraw バックエンド API サーバー (FastAPI)

主な仕様・機能:
1. ファイル読み込み (`GET /api/load-file`):
   - `.excalidraw` および `.excalidraw.md` ファイルの読み込みとJSON抽出・解凍。
   - Obsidian Embedded Files 内の画像リンクを解決し、同一フォルダ・サブフォルダ・Vault内から自動ハイドレーション。
   - Obsidian外にフォルダが移動された場合でも、同一フォルダ直下やサブフォルダ内の画像を自動検出・解決。
2. ファイル保存 (`POST /api/save-file`):
   - 原子的なファイル書き込みと自動バックアップ機能。
   - Obsidian互換形式（LZString圧縮JSON・Text Elements・Embedded Files）での保存。
3. ファイル情報取得・ディレクトリ一覧・外部アプリ連携・コマンド実行。
"""
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, ConfigDict, Field
from pathlib import Path
from html import escape, unescape
import asyncio
import json
import os
import sys
import time
import shutil
import subprocess
import hashlib
import traceback
import logging
import base64
import tempfile
import urllib.parse
from datetime import datetime, timedelta
from typing import Dict, List, Any, Optional
from contextlib import asynccontextmanager
import re
from lzstring import LZString
from starlette.responses import Response


HASHED_ASSET_PATTERN = re.compile(r".*-[0-9A-Za-z]{6,}\.(js|css|mjs)$")
ALLOWED_EXTERNAL_URL_SCHEMES = {"http", "https", "mailto", "obsidian"}
FILE_INFO_CACHE_MAX = 256
_FILE_INFO_HASH_CACHE: dict[tuple[str, int, int], str] = {}


class CacheControlledStaticFiles(StaticFiles):
    """PWA更新反映のために配信ファイルごとのキャッシュヘッダーを制御する。"""

    @staticmethod
    def build_static_cache_headers(path: Path | str) -> dict[str, str]:
        static_path = Path(path)

        if static_path.name in {"index.html", "sw.js", "manifest.webmanifest", "manifest.json"}:
            return {"Cache-Control": "no-cache, no-store, must-revalidate"}

        if HASHED_ASSET_PATTERN.fullmatch(static_path.name):
            return {"Cache-Control": "public, max-age=31536000, immutable"}

        return {"Cache-Control": "public, max-age=3600"}

    def file_response(
        self,
        full_path: Path,
        stat_result: os.stat_result,
        scope,
        status_code: int = 200,
    ) -> Response:
        response = super().file_response(full_path, stat_result, scope, status_code)
        static_path = Path(full_path)
        for key, value in self.build_static_cache_headers(static_path).items():
            response.headers[key] = value
        if static_path.name == "sw.js":
            response.headers["Service-Worker-Allowed"] = "/"
        return response

def find_vault_root(start_path: Path) -> Optional[Path]:
    """
    指定されたパスから上向きに探索して、Obsidian Vaultのルート（.obsidianフォルダがある場所）を見つける
    """
    try:
        current = start_path
        if current.is_file():
            current = current.parent
        
        while current != current.parent:
            if (current / ".obsidian").is_dir():
                return current
            current = current.parent
            
        return None
    except Exception:
        return None

def is_obsidian_path(filepath: str) -> bool:
    """
    パスがObsidian管理下にあるか判定する。
    - .excalidraw.md は場所を問わずObsidian形式として扱う
    - .excalidraw は .obsidian を祖先に持つ場合に移行対象として扱う
    - 既存互換のためパスに 'obsidian' を含む場合も移行対象とする
    """
    path_str = str(filepath).lower()
    if path_str.endswith('.excalidraw.md'):
        return True
    if not path_str.endswith('.excalidraw'):
        return False

    path = Path(filepath).expanduser()
    search_start = path if path.exists() else path.parent
    return find_vault_root(search_start) is not None or 'obsidian' in path_str

EXCALIDRAW_JSON_BLOCK_PATTERN = re.compile(
    r"```(?:compressed-json|json)[ \t]*\r?\n(.*?)\r?\n```",
    re.DOTALL,
)
EXCALIDRAW_PLUGIN_PARSED_PATTERN = re.compile(
    r"^[ \t]*excalidraw-plugin[ \t]*:[ \t]*['\"]?parsed['\"]?[ \t]*$",
    re.MULTILINE | re.IGNORECASE,
)
DRAWING_HEADING_PATTERN = re.compile(
    r"^#{1,6}[ \t]+Drawing[ \t]*$",
    re.MULTILINE | re.IGNORECASE,
)
EXCALIDRAW_DATA_HEADING_PATTERN = re.compile(
    r"^#{1,6}[ \t]+Excalidraw Data[ \t]*$",
    re.MULTILINE | re.IGNORECASE,
)
MARKDOWN_SECTION_BOUNDARY_PATTERN = re.compile(
    r"^(?:#{1,6}[ \t]+\S.*|%%[ \t]*)$",
    re.MULTILINE,
)


def find_excalidraw_json_block(content: str) -> Optional[re.Match[str]]:
    """Drawingセクション内のデータブロックを優先し、見出しのない旧形式にも対応する。"""
    drawing_heading_found = False
    for drawing_heading in DRAWING_HEADING_PATTERN.finditer(content):
        drawing_heading_found = True
        next_heading = MARKDOWN_SECTION_BOUNDARY_PATTERN.search(content, drawing_heading.end())
        section_end = next_heading.start() if next_heading else len(content)
        drawing_block = EXCALIDRAW_JSON_BLOCK_PATTERN.search(
            content,
            drawing_heading.end(),
            section_end,
        )
        if drawing_block:
            return drawing_block

    # Drawing見出しがあるのにブロックがない場合、後続メモのJSONを図面と誤認しない。
    if drawing_heading_found:
        return None

    return EXCALIDRAW_JSON_BLOCK_PATTERN.search(content)


def has_excalidraw_plugin_marker(content: str) -> bool:
    """Obsidian Excalidrawプラグインのparsedノートか判定する。"""
    return EXCALIDRAW_PLUGIN_PARSED_PATTERN.search(content) is not None


def is_excalidraw_markdown_file(file_path: Path, content: Optional[str] = None) -> bool:
    """拡張子またはFront MatterでExcalidraw Markdownか判定する。"""
    path_lower = str(file_path).lower()
    if path_lower.endswith('.excalidraw.md'):
        return True
    if file_path.suffix.lower() != '.md':
        return False
    if content is None:
        try:
            content = file_path.read_text(encoding='utf-8')
        except (OSError, UnicodeError):
            return False
    return has_excalidraw_plugin_marker(content)


def find_excalidraw_markdown_section(
    content: str,
    title: str,
) -> Optional[tuple[int, int]]:
    """Excalidraw Data配下の指定セクションについて、本文の開始・終了位置を返す。"""
    data_heading = EXCALIDRAW_DATA_HEADING_PATTERN.search(content)
    if not data_heading:
        # 非標準の旧Markdownに同名の手書き見出しがあっても変更しない。
        return None
    search_start = data_heading.end()
    heading_pattern = re.compile(
        rf"^#{{1,6}}[ \t]+{re.escape(title)}[ \t]*$",
        re.MULTILINE | re.IGNORECASE,
    )
    heading = heading_pattern.search(content, search_start)
    if not heading:
        return None

    newline_index = content.find("\n", heading.end())
    body_start = len(content) if newline_index == -1 else newline_index + 1
    boundary = MARKDOWN_SECTION_BOUNDARY_PATTERN.search(content, body_start)
    body_end = boundary.start() if boundary else len(content)
    return body_start, body_end


def extract_json_from_markdown(content: str) -> str:
    """
    MarkdownからExcalidraw JSONを抽出する。
    圧縮されている場合は解凍する。
    """
    # Drawing配下の ```compressed-json ... ``` または旧 ```json ... ``` を探す
    match = find_excalidraw_json_block(content)
    if not match:
        raise ValueError("No JSON block found in Markdown")

    # 改行を含む可能性があるので、すべての空白文字（改行含む）を除去
    json_content = match.group(1).strip()

    # JSONとしてパースできるか試みる (非圧縮)
    try:
        json.loads(json_content)
        return json_content
    except json.JSONDecodeError:
        pass

    # パースできなければ圧縮されているとみなして解凍を試みる
    # 圧縮データから改行を除去（Obsidianは複数行に分割して保存する）
    try:
        lz = LZString()
        # すべての改行と空白を除去
        compressed_clean = ''.join(json_content.split())
        decompressed = lz.decompressFromBase64(compressed_clean)
        if not decompressed:
             # 解凍結果が空、または失敗した場合
            raise ValueError("Failed to decompress JSON content")
        
        # サロゲートペアを結合して正しいUnicode文字にする
        # LZString（JS実装）はUTF-16コードユニットを文字として返すため、Pythonではサロゲートペアが分割された状態になることがある
        try:
            decompressed = decompressed.encode('utf-16', 'surrogatepass').decode('utf-16')
        except Exception:
            # 変換に失敗した場合はそのまま進む（あるいはログ出力）
            pass

        # 解凍結果が正当なJSONかチェック
        json.loads(decompressed)
        return decompressed
    except Exception as e:
        raise ValueError(f"Failed to extract/decompress JSON: {e}")

def convert_to_utf16_surrogates(text: str) -> str:
    """
    Python文字列をJSのようなUTF-16サロゲートペアを含む文字列に変換する
    LZStringが32bit文字（絵文字など）を正しく圧縮できない問題を回避するため
    """
    utf16_bytes = text.encode('utf-16le')
    # 2バイトごとに読み込んで文字にする
    chars = []
    for i in range(0, len(utf16_bytes), 2):
        code_unit = int.from_bytes(utf16_bytes[i:i+2], byteorder='little')
        chars.append(chr(code_unit))
    return "".join(chars)


def _atomic_write(file_path: Path, content: Any, binary: bool) -> None:
    """一時ファイルへ全内容を書き、権限等を整えてから原子的に置換する。"""
    target_path = file_path.resolve() if file_path.is_symlink() else file_path
    target_path.parent.mkdir(parents=True, exist_ok=True)
    existing_mode = target_path.stat().st_mode & 0o777 if target_path.exists() else None
    fd, temp_name = tempfile.mkstemp(
        dir=target_path.parent,
        prefix=f".{target_path.name}.",
        suffix=".tmp",
    )
    temp_path = Path(temp_name)
    try:
        open_mode = "wb" if binary else "w"
        open_kwargs = {} if binary else {"encoding": "utf-8"}
        with os.fdopen(fd, open_mode, **open_kwargs) as temp_file:
            temp_file.write(content)
            temp_file.flush()
            os.fsync(temp_file.fileno())

        # mkstempの0600をそのまま公開せず、既存権限または従来の新規作成権限へ戻す。
        os.chmod(temp_path, existing_mode if existing_mode is not None else 0o644)

        # Finderタグ等の拡張属性は、OSが対応し権限がある範囲で引き継ぐ。
        if target_path.exists() and hasattr(os, "listxattr"):
            try:
                for attribute in os.listxattr(target_path):
                    os.setxattr(
                        temp_path,
                        attribute,
                        os.getxattr(target_path, attribute),
                    )
            except OSError:
                pass

        os.replace(temp_path, target_path)
    finally:
        if temp_path.exists():
            temp_path.unlink()


def atomic_write_text(file_path: Path, content: str) -> None:
    """テキストを完成後に原子的に置換する。"""
    _atomic_write(file_path, content, binary=False)


def atomic_write_bytes(file_path: Path, content: bytes) -> None:
    """バイナリを完成後に原子的に置換する。"""
    _atomic_write(file_path, content, binary=True)

def embed_json_into_markdown(original_content: Optional[str], json_str: str, image_files: Optional[dict] = None) -> str:
    """
    MarkdownにJSONを埋め込む。
    - JSONはLZStringで圧縮する。
    - original_contentがある場合は、既存のJSONブロックを置換する。
    - ない場合は新規テンプレートを作成する。
    - image_filesがある場合、## Embedded Filesセクションを追加
    - JSONからテキスト要素を抽出して ## Text Elements セクションに記載
    """
    lz = LZString()
    # 32bit文字（絵文字）対応: サロゲートペアに分解してから圧縮
    safe_json_str = convert_to_utf16_surrogates(json_str)
    compressed = lz.compressToBase64(safe_json_str)
    # Obsidianプラグインの動作に合わせて、256文字ごとに改行+空行を挿入
    lines = [compressed[i:i+256] for i in range(0, len(compressed), 256)]
    compressed = '\n\n'.join(lines)

    # JSONデータからテキスト要素を抽出
    text_elements_section = ""
    try:
        data = json.loads(json_str)
        elements = data.get("elements", [])
        text_elements = [el for el in elements if el.get("type") == "text" and not el.get("isDeleted", False)]

        if text_elements:
            for el in text_elements:
                text_content = el.get("text", "")
                element_id = el.get("id", "")
                if text_content and element_id:
                    # Obsidianプラグインに合わせて、改行を維持し、IDを末尾に付与する
                    # 末尾の空白を除去
                    text_content = text_content.rstrip()
                    text_elements_section += f"{text_content} ^{element_id}\n\n"
            # 最後の余分な改行を削除
            text_elements_section = text_elements_section.rstrip('\n') + '\n'
    except Exception as e:
        print(f"Warning: Failed to extract text elements: {e}")

    # Embedded Filesセクションの生成
    embedded_files_section = ""
    if image_files:
        embedded_files_section = "## Embedded Files\n"
        for file_id, filename in image_files.items():
            embedded_files_section += f"{file_id}: [[{filename}]]\n"
        embedded_files_section += "\n"

    template = """---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'


# Excalidraw Data

## Text Elements
{TEXT_ELEMENTS}{EMBEDDED_FILES}%%
## Drawing
```compressed-json
{COMPRESSED_DATA}
```
%%"""

    if not original_content:
        content = template.replace("{COMPRESSED_DATA}", compressed)
        content = content.replace("{TEXT_ELEMENTS}", text_elements_section)
        content = content.replace("{EMBEDDED_FILES}", embedded_files_section)
        return content

    # 既存コンテンツがある場合、JSONブロック、Text Elements、Embedded Filesセクションを更新

    # 1. Drawingデータブロックだけを置換し、旧 ```json``` も正式な
    #    ```compressed-json``` へ正規化する。Markdown中の別のJSON例は保持する。
    json_block_match = find_excalidraw_json_block(original_content)

    if not json_block_match:
        # 構造が壊れているか、まだブロックがない場合、末尾に追加
        content = original_content + f"\n\n%%\n## Drawing\n```compressed-json\n{compressed}\n```\n%%\n"
    else:
        canonical_block = f"```compressed-json\n{compressed}\n```"
        content = (
            original_content[:json_block_match.start()]
            + canonical_block
            + original_content[json_block_match.end():]
        )

    # 2. Excalidraw Data配下のText Elements本文だけを更新する。
    text_section = find_excalidraw_markdown_section(content, "Text Elements")
    if text_section:
        body_start, body_end = text_section
        content = content[:body_start] + text_elements_section + content[body_end:]

    # 3. Embedded Filesセクションを更新
    if image_files:
        embedded_files_text = "## Embedded Files\n"
        for file_id, filename in image_files.items():
            embedded_files_text += f"{file_id}: [[{filename}]]\n"
        embedded_files_text += "\n"

        # 既存のEmbedded Filesセクション本文だけを置換
        embedded_section = find_excalidraw_markdown_section(content, "Embedded Files")
        if embedded_section:
            body_start, body_end = embedded_section
            embedded_body = "".join(
                f"{file_id}: [[{filename}]]\n"
                for file_id, filename in image_files.items()
            )
            content = content[:body_start] + embedded_body + content[body_end:]
        else:
            # Text Elements本文の後、次のセクション（%%またはDrawing）の前に挿入
            text_section = find_excalidraw_markdown_section(content, "Text Elements")
            if text_section:
                _, body_end = text_section
                content = content[:body_end] + embedded_files_text + content[body_end:]
            else:
                # Text Elementsもない場合、%%の前に挿入
                content = content.replace(
                    "%%\n## Drawing",
                    f"{embedded_files_text}%%\n## Drawing",
                    1,
                )

    return content

@asynccontextmanager
async def lifespan(_app: FastAPI):
    formatter = logging.Formatter("%(asctime)s %(levelname)s: %(message)s", "%Y-%m-%d %H:%M:%S")
    for logger_name in ("uvicorn.access", "uvicorn.error"):
        logger = logging.getLogger(logger_name)
        for handler in logger.handlers:
            handler.setFormatter(formatter)
    yield


app = FastAPI(title="Excalidraw File API", lifespan=lifespan)

# CORS設定 - 開発環境と本番環境の両方に対応
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3001",
        "http://127.0.0.1:3001", 
        "http://0.0.0.0:3001",
    ],
    allow_origin_regex=r"https?://(?:localhost|127\.0\.0\.1|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100(?:\.\d{1,3}){3})(?::\d+)?",
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# API呼び出しをログ出力するミドルウェア
@app.middleware("http")
async def log_api_calls(request, call_next):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] [API Call] {request.method} {request.url.path}")
    response = await call_next(request)
    return response

# データモデル
class ValidationErrorDetail(BaseModel):
    """バリデーションエラーの詳細情報"""
    field: str          # エラーフィールドパス (例: "elements[0].points")
    message: str        # エラーメッセージ
    value: Optional[str] = None  # 問題のある値（文字列化）

class JsonErrorResponse(BaseModel):
    """JSON読み込みエラーのレスポンス"""
    error_type: str     # "json_syntax" | "validation" | "schema"
    message: str        # ユーザー向けメッセージ
    line: Optional[int] = None      # エラー行数
    column: Optional[int] = None    # エラーカラム位置
    context: Optional[str] = None   # エラー周辺のテキスト
    details: Optional[List[ValidationErrorDetail]] = None

class ExcalidrawElement(BaseModel):
    type: str
    x: float
    y: float
    width: float
    height: float
    angle: float
    strokeColor: str
    backgroundColor: str
    fillStyle: str
    strokeWidth: int
    strokeStyle: str
    roughness: int
    opacity: int
    groupIds: List[str]
    frameId: Optional[str]
    roundness: Optional[Dict[str, Any]]
    seed: int
    versionNonce: int
    isDeleted: bool
    boundElements: Optional[List[Any]]
    updated: int
    link: Optional[str]
    locked: bool
    id: str

class ExcalidrawAppState(BaseModel):
    viewBackgroundColor: Optional[str] = None
    gridSize: Optional[int] = None
    currentItemStrokeColor: Optional[str] = None
    currentItemBackgroundColor: Optional[str] = None
    currentItemFillStyle: Optional[str] = None
    currentItemStrokeWidth: Optional[int] = None
    currentItemStrokeStyle: Optional[str] = None
    currentItemRoughness: Optional[int] = None
    currentItemOpacity: Optional[int] = None
    zoom: Optional[Dict[str, float]] = None
    scrollX: Optional[float] = None
    scrollY: Optional[float] = None

class ExcalidrawFileData(BaseModel):
    # 旧版・将来版・社内拡張のトップレベル項目を保存時に落とさない。
    model_config = ConfigDict(extra="allow")

    type: str = "excalidraw"
    version: int = 2
    source: str = "https://excalidraw.com"
    elements: List[Dict[str, Any]] = Field(default_factory=list)
    appState: Dict[str, Any] = Field(default_factory=dict)
    files: Dict[str, Any] = Field(default_factory=dict)

class SaveFileRequest(BaseModel):
    filepath: str
    data: ExcalidrawFileData
    force_backup: bool = False  # デフォルトは自動保存扱い（10分制限あり）

class OpenFileRequest(BaseModel):
    filepath: str

class OpenFileResponse(BaseModel):
    success: bool
    targetType: Optional[str] = None
    resolvedPath: Optional[str] = None
    message: Optional[str] = None

class SaveEmailRequest(BaseModel):
    emailData: str
    subject: str
    currentPath: str

class FileUploadResponse(BaseModel):
    success: bool
    files: List[Dict[str, Any]] = []
    error: Optional[str] = None

class FolderShortcutResponse(BaseModel):
    success: bool
    folderPath: Optional[str] = None
    error: Optional[str] = None

class EmailSaveResponse(BaseModel):
    success: bool
    savedPath: Optional[str] = None
    error: Optional[str] = None

class SaveLibraryRequest(BaseModel):
    file_path: str
    data: Dict[str, Any]

class SaveLibraryResponse(BaseModel):
    success: bool
    message: Optional[str] = None
    error: Optional[str] = None

class SaveSvgRequest(BaseModel):
    filepath: str
    svg_content: str

class OpenFolderRequest(BaseModel):
    path: str

class OpenFolderResponse(BaseModel):
    success: bool
    openedPath: Optional[str] = None
    error: Optional[str] = None

class OpenEditorRequest(BaseModel):
    path: str

class OpenEditorResponse(BaseModel):
    success: bool
    openedPath: Optional[str] = None
    fallbackUsed: bool = False
    message: Optional[str] = None

class RunCommandRequest(BaseModel):
    command: str
    working_directory: Optional[str] = None


class RunCommandResponse(BaseModel):
    success: bool
    command: str
    pid: Optional[int] = None
    error: Optional[str] = None

class ListDirectoryRequest(BaseModel):
    path: Optional[str] = None
    show_hidden: bool = False


class DirectoryEntry(BaseModel):
    name: str
    path: str
    is_dir: bool
    size: Optional[int] = None
    modified: Optional[float] = None


class ListDirectoryResponse(BaseModel):
    success: bool
    path: str
    parentPath: Optional[str] = None
    entries: List[DirectoryEntry] = Field(default_factory=list)
    error: Optional[str] = None


def clean_surrogates(obj: Any) -> Any:
    """
    サロゲート文字を含むデータをクリーンアップする
    JSONレスポンスでUnicodeEncodeErrorが発生するのを防ぐ
    """
    if isinstance(obj, str):
        # サロゲート文字を置換してクリーンアップ
        return obj.encode('utf-8', errors='surrogatepass').decode('utf-8', errors='replace')
    elif isinstance(obj, dict):
        return {k: clean_surrogates(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [clean_surrogates(item) for item in obj]
    else:
        return obj


def compute_data_hash(data: Any) -> str:
    """Returns a stable SHA-256 hash for predictable change detection."""
    canonical = json.dumps(
        data,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    # サロゲート文字を含む可能性があるため、errors="surrogatepass"を使用
    return hashlib.sha256(canonical.encode("utf-8", errors="surrogatepass")).hexdigest()


def get_cached_data_hash(cache_key: tuple[str, int, int], data_loader) -> str:
    """mtime/size が同一ならハッシュを再計算しない。"""
    cached_hash = _FILE_INFO_HASH_CACHE.get(cache_key)
    if cached_hash is not None:
        return cached_hash

    computed_hash = compute_data_hash(data_loader())
    if len(_FILE_INFO_HASH_CACHE) >= FILE_INFO_CACHE_MAX:
        _FILE_INFO_HASH_CACHE.pop(next(iter(_FILE_INFO_HASH_CACHE)))
    _FILE_INFO_HASH_CACHE[cache_key] = computed_hash
    return computed_hash


def validate_json_with_details(json_str: str) -> tuple[Any, Optional[JsonErrorResponse]]:
    """
    JSON文字列を検証し、詳細なエラー情報を返す

    Returns:
        (data, error): 成功時は(data, None)、失敗時は(None, error_response)
    """
    # ステップ1: JSON構文チェック
    try:
        data = json.loads(json_str)
    except json.JSONDecodeError as e:
        # エラー周辺のコンテキストを抽出（前後3行）
        lines = json_str.split('\n')
        start = max(0, e.lineno - 3)
        end = min(len(lines), e.lineno + 2)
        context_lines = lines[start:end]

        # エラー行にマーカーを追加
        error_idx = e.lineno - 1 - start
        if 0 <= error_idx < len(context_lines):
            context_lines[error_idx] += f"  <-- カラム {e.colno}"

        context = '\n'.join([f"{start+i+1}: {line}" for i, line in enumerate(context_lines)])

        return None, JsonErrorResponse(
            error_type="json_syntax",
            message=f"JSON構文エラー: {e.msg}",
            line=e.lineno,
            column=e.colno,
            context=context
        )

    # ステップ2: 基本構造チェック
    if not isinstance(data, dict):
        return None, JsonErrorResponse(
            error_type="schema",
            message="ExcalidrawファイルはJSONオブジェクトである必要があります"
        )

    if 'elements' not in data:
        return None, JsonErrorResponse(
            error_type="schema",
            message="'elements'フィールドが見つかりません"
        )

    # ステップ3: points フィールドの検証
    validation_errors = []

    for idx, element in enumerate(data.get('elements', [])):
        if not isinstance(element, dict):
            continue

        element_type = element.get('type', 'unknown')
        element_id = element.get('id', f'index-{idx}')

        # line, draw, freedraw タイプは points が必須
        if element_type in ['line', 'draw', 'freedraw']:
            if 'points' not in element:
                validation_errors.append(ValidationErrorDetail(
                    field=f"elements[{idx}] (type={element_type}, id={element_id})",
                    message=f"'{element_type}'タイプの要素には'points'フィールドが必要です"
                ))
                continue

            points = element['points']

            # pointsは配列である必要がある
            if not isinstance(points, list):
                validation_errors.append(ValidationErrorDetail(
                    field=f"elements[{idx}].points",
                    message=f"pointsは配列である必要があります（現在の型: {type(points).__name__}）",
                    value=str(points)[:50]
                ))
                continue

            # 各ポイントの形式チェック
            for pidx, point in enumerate(points):
                if not isinstance(point, list) or len(point) != 2:
                    validation_errors.append(ValidationErrorDetail(
                        field=f"elements[{idx}].points[{pidx}]",
                        message="各ポイントは[x, y]形式の配列である必要があります",
                        value=str(point)[:50]
                    ))
                elif not all(isinstance(c, (int, float)) for c in point):
                    validation_errors.append(ValidationErrorDetail(
                        field=f"elements[{idx}].points[{pidx}]",
                        message="座標は数値である必要があります",
                        value=str(point)[:50]
                    ))

    if validation_errors:
        # 最初の5個のエラーのみ返す
        return None, JsonErrorResponse(
            error_type="validation",
            message=f"{len(validation_errors)}個のバリデーションエラーが見つかりました" +
                   (f"（最初の5個を表示）" if len(validation_errors) > 5 else ""),
            details=validation_errors[:5]
        )

    return data, None


def create_empty_scene_data() -> Dict[str, Any]:
    return {
        "type": "excalidraw",
        "version": 2,
        "source": "https://excalidraw.com",
        "elements": [],
        "appState": {
            "viewBackgroundColor": "#ffffff",
            "gridSize": None,
        },
        "files": {},
    }


def load_json_file(file_path: Path) -> Any:
    """
    JSONファイルを読み込み、詳細なバリデーションを実行

    Raises:
        HTTPException: バリデーションエラー時
    """
    with open(file_path, "r", encoding="utf-8") as file:
        json_str = file.read()

    # Empty file handling: return default empty scene
    if not json_str.strip():
        return create_empty_scene_data()

    data, validation_error = validate_json_with_details(json_str)
    if validation_error:
        raise HTTPException(
            status_code=400,
            detail=validation_error.model_dump()
        )

    return data


def create_backup(filepath: str, force: bool = False) -> bool:
    """
    バックアップシステム
    - force=False: 10分間隔でバックアップを作成（自動保存）
    - force=True: 時間制限なしでバックアップを作成（手動更新時）
    - 前日の最新のみ残す
    - 2週間以上古いものは自動削除
    - ファイル名に日時（秒まで）を含める
    """
    try:
        file_path = Path(filepath)
        
        # ファイルが存在しない場合はバックアップ不要
        if not file_path.exists():
            return True
            
        # backupフォルダの作成
        backup_dir = file_path.parent / "backup"
        backup_dir.mkdir(exist_ok=True)
        
        # ファイル名からバックアップ名を生成
        base_name = file_path.stem
        extension = file_path.suffix
        
        current_time = datetime.now()
        current_timestamp = current_time.timestamp()
        
        # 既存のバックアップファイルをチェック
        existing_backups = []
        pattern = f"{base_name}_backup_*{extension}"
        
        for backup_file in backup_dir.glob(pattern):
            try:
                backup_time = backup_file.stat().st_mtime
                existing_backups.append((backup_file, backup_time))
            except OSError:
                continue
        
        # 10分以内（600秒）にバックアップがある場合はスキップ（強制モードでない場合のみ）
        if not force and existing_backups:
            latest_backup_time = max(existing_backups, key=lambda x: x[1])[1]
            if (current_timestamp - latest_backup_time) < 600:
                # print(f"Skip backup: Last backup was {int(current_timestamp - latest_backup_time)} seconds ago")
                return True
        
        # 2週間以上古いバックアップを削除
        two_weeks_ago = current_timestamp - (14 * 24 * 3600)
        for backup_file, backup_time in existing_backups:
            if backup_time < two_weeks_ago:
                try:
                    backup_file.unlink()
                    # print(f"Deleted old backup (>2 weeks): {backup_file}")
                except OSError as e:
                    print(f"Failed to delete old backup {backup_file}: {e}")
        
        # 前日の最新以外を削除
        if existing_backups:
            # 残存するバックアップを再取得
            remaining_backups = []
            for backup_file in backup_dir.glob(pattern):
                try:
                    backup_time = backup_file.stat().st_mtime
                    remaining_backups.append((backup_file, backup_time))
                except OSError:
                    continue
            
            # 日付ごとにグループ化
            daily_backups = {}
            for backup_file, backup_time in remaining_backups:
                backup_date = datetime.fromtimestamp(backup_time).date()
                if backup_date not in daily_backups:
                    daily_backups[backup_date] = []
                daily_backups[backup_date].append((backup_file, backup_time))
            
            # 各日付で最新のもの以外を削除
            today = current_time.date()
            for backup_date, day_backups in daily_backups.items():
                if backup_date != today and len(day_backups) > 1:
                    # 最新のもの以外を削除
                    day_backups.sort(key=lambda x: x[1])  # 時刻でソート
                    for backup_file, _ in day_backups[:-1]:  # 最新以外
                        try:
                            backup_file.unlink()
                            # print(f"Deleted old daily backup: {backup_file}")
                        except OSError as e:
                            print(f"Failed to delete daily backup {backup_file}: {e}")
        
        # 新しいバックアップファイル名を生成（秒まで含む）
        timestamp_str = current_time.strftime("%Y%m%d_%H%M%S")
        backup_name = f"{base_name}_backup_{timestamp_str}{extension}"
        backup_path = backup_dir / backup_name

        # 手動保存が同じ秒に複数回行われても、既存バックアップを上書きしない。
        collision_index = 1
        while backup_path.exists():
            backup_name = (
                f"{base_name}_backup_{timestamp_str}_{collision_index}{extension}"
            )
            backup_path = backup_dir / backup_name
            collision_index += 1
        
        # バックアップを作成
        shutil.copy2(file_path, backup_path)
        # if force:
        #     print(f"Forced backup created: {backup_path}")
        # else:
        #     print(f"Backup created: {backup_path}")
        
        return True

    except Exception as e:
        print(f"Error creating backup: {e}")
        return False


def get_upload_directory(file_path: str, file_type: str = "general") -> Path:
    """アップロードディレクトリを取得/作成"""
    # ローカルストレージ用のパスかどうかをチェック
    if not file_path or file_path.startswith('localStorage'):
        # ローカルストレージの場合はプロジェクトルートのupload_localディレクトリ
        base_dir = Path(__file__).parent.parent  # プロジェクトルート
        upload_dir = base_dir / "upload_local"
    else:
        # 通常のファイルパスの場合は従来通り
        base_dir = Path(file_path).parent
        upload_dir = base_dir / "uploads"
    
    if file_type == "email":
        upload_dir = upload_dir / "emails"
    elif file_type == "image":
        upload_dir = upload_dir / "images"
    elif file_type == "folder":
        upload_dir = upload_dir / "folders"
    else:
        upload_dir = upload_dir / "files"
    
    upload_dir.mkdir(parents=True, exist_ok=True)
    return upload_dir

def compute_relative_path(current_path: str, target_path: str) -> str:
    """
    現在のExcalidrawファイルの位置を基準とした相対パスを計算する。
    localStorageの場合は絶対パスをそのまま返す。
    """
    # localStorageの場合は相対パスを計算できないため、絶対パスを返す
    if not current_path or current_path.startswith('localStorage'):
        return target_path
    
    try:
        # 現在のファイルの親ディレクトリを基準とする
        base_dir = Path(current_path).parent
        target = Path(target_path)
        
        # 相対パスを計算
        relative = os.path.relpath(target, base_dir)
        
        # Windowsのバックスラッシュをスラッシュに統一
        relative = relative.replace('\\', '/')
        
        return relative
    except ValueError:
        # 異なるドライブ間など、相対パスを計算できない場合は絶対パスを返す
        return target_path

def sanitize_filename(filename: str) -> str:
    """ファイル名をサニタイズ"""
    # 危険な文字を除去
    import re
    filename = re.sub(r'[<>:"/\\|?*]', '_', filename)
    # 先頭末尾の空白とドットを除去
    filename = filename.strip(' .')
    # 空文字の場合はデフォルト名
    if not filename:
        filename = "untitled"
    return filename


IMAGE_MIME_TYPE_MAP = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "svg": "image/svg+xml",
    "webp": "image/webp",
}


SUPPORTED_IMAGE_EXTENSIONS = (
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico", ".md"
)
COMMON_ATTACHMENT_DIRS = (
    "attachments", "assets", "images", "img", "files", "resources", "_resources", ".attachments"
)


def parse_embedded_files_section(content: str) -> Dict[str, str]:
    """Obsidian markdown の Embedded Files セクションを解析する。パイプやアンカーを除去してリンク先を取得。"""
    embedded_files: Dict[str, str] = {}
    embedded_match = re.search(r"## Embedded Files\n(.*?)\n(?=##|%%|\Z)", content, re.DOTALL)
    if not embedded_match:
        return embedded_files

    for line in embedded_match.group(1).splitlines():
        if ":" not in line or "[[" not in line:
            continue
        file_id, _, remainder = line.partition(":")
        filename_match = re.search(r"\[\[(.*?)\]\]", remainder)
        if filename_match:
            raw_target = filename_match.group(1)
            # パイプ（表示名/サイズ指定）やアンカー（#見出し）を除去
            clean_target = raw_target.split("|")[0].split("#")[0].strip()
            embedded_files[file_id.strip()] = clean_target

    return embedded_files


def resolve_embedded_file_path(
    file_path: Path,
    image_filename: str,
    vault_root: Optional[Path] = None,
) -> Path:
    """
    埋め込み画像の候補パスを順に探索する。
    - Obsidian Vault外にフォルダごと移動した場合でも、同じフォルダ直下やサブフォルダ内の画像を自動検出する。
    - URLエンコード、拡張子省略、パイプ・アンカー、大文字小文字の差異にも対応する。
    """
    # パイプやアンカーの除去・URLデコード
    clean_link = image_filename.split("|")[0].split("#")[0].strip()
    decoded_link = urllib.parse.unquote(clean_link)
    raw_basename = Path(clean_link).name
    decoded_basename = Path(decoded_link).name

    # 1. まずインデックス辞書 (image_paths.json) からパスの解決を試みる
    if vault_root is not None:
        index_file = vault_root / ".obsidian" / "plugins" / "obsidian-sidebar-explorer" / "image_paths.json"
        if index_file.exists():
            try:
                with open(index_file, "r", encoding="utf-8") as f:
                    index_data = json.load(f)
                by_obsidian_path = index_data.get("byObsidianPath", {})
                for lookup_key in (clean_link, decoded_link, raw_basename, decoded_basename):
                    resolved_path_str = by_obsidian_path.get(lookup_key)
                    if resolved_path_str:
                        resolved_path = Path(resolved_path_str)
                        if resolved_path.exists():
                            return resolved_path
            except Exception as e:
                print(f"Warning: Failed to resolve path using index file: {e}")

    # 2. 探索対象ベースディレクトリ一覧
    search_dirs: List[Path] = [file_path.parent]

    # 同一フォルダ直下のよくある添付サブフォルダ
    for sub in COMMON_ATTACHMENT_DIRS:
        sub_dir = file_path.parent / sub
        if sub_dir.is_dir():
            search_dirs.append(sub_dir)

    if vault_root is not None:
        search_dirs.append(vault_root)
        for sub in COMMON_ATTACHMENT_DIRS:
            vault_sub_dir = vault_root / sub
            if vault_sub_dir.is_dir():
                search_dirs.append(vault_sub_dir)

    if file_path.parent.parent != file_path.parent:
        search_dirs.append(file_path.parent.parent)

    # 3. 探索対象の名前・パス候補（優先度順）
    name_candidates: List[str] = []
    for name in (decoded_link, clean_link, decoded_basename, raw_basename):
        if name and name not in name_candidates:
            name_candidates.append(name)

    # 4. 完全一致 / 拡張子補完探索
    for base_dir in search_dirs:
        if not base_dir.is_dir():
            continue
        for name in name_candidates:
            candidate = base_dir / name
            if candidate.is_file():
                # ディスク上の正確なケーシングの実ファイルパスを返す
                try:
                    for item in base_dir.iterdir():
                        if item.name.lower() == candidate.name.lower():
                            return item
                except OSError:
                    pass
                return candidate

            # 拡張子がない、または別の拡張子での実在確認
            if not candidate.suffix:
                for ext in SUPPORTED_IMAGE_EXTENSIONS:
                    candidate_with_ext = candidate.with_suffix(ext)
                    if candidate_with_ext.is_file():
                        try:
                            for item in base_dir.iterdir():
                                if item.name.lower() == candidate_with_ext.name.lower():
                                    return item
                        except OSError:
                            pass
                        return candidate_with_ext

    # 5. 大文字小文字（Case-insensitive）探索
    # 同一フォルダおよびそのサブフォルダ内のファイルを走査
    target_names_lower = set()
    for name in name_candidates:
        base_name = Path(name).name
        target_names_lower.add(base_name.lower())
        if not Path(name).suffix:
            for ext in SUPPORTED_IMAGE_EXTENSIONS:
                target_names_lower.add(f"{base_name.lower()}{ext.lower()}")

    for base_dir in search_dirs:
        if not base_dir.is_dir():
            continue
        try:
            for item in base_dir.iterdir():
                if item.is_file() and item.name.lower() in target_names_lower:
                    return item
        except OSError:
            continue

    # 6. 見つからない場合のフォールバックデフォルトパス
    return file_path.parent / (decoded_basename if decoded_basename else clean_link)


def build_data_url(image_path: Path, mime_type: Optional[str] = None) -> tuple[str, int]:
    """画像ファイルから data URL を生成する。"""
    resolved_mime_type = mime_type
    if not resolved_mime_type:
        ext = image_path.suffix.lower().lstrip(".")
        resolved_mime_type = IMAGE_MIME_TYPE_MAP.get(ext, "image/png")

    with open(image_path, "rb") as img_file:
        image_bytes = img_file.read()

    base64_data = base64.b64encode(image_bytes).decode("utf-8")
    data_url = f"data:{resolved_mime_type};base64,{base64_data}"
    created = int(image_path.stat().st_mtime * 1000)
    return data_url, created


def hydrate_obsidian_files(
    file_path: Path,
    data: Dict[str, Any],
    embedded_files_map: Dict[str, str],
) -> Dict[str, str]:
    """Embedded Filesを解決し、画像dataURLとMarkdownリンク先を補完する。"""
    vault_root = find_vault_root(file_path)
    embedded_file_paths: Dict[str, str] = {}
    files = data.get("files")
    if not isinstance(files, dict):
        files = {}
        data["files"] = files

    for file_id, image_filename in embedded_files_map.items():
        image_path = resolve_embedded_file_path(file_path, image_filename, vault_root)
        if image_path.exists():
            embedded_file_paths[file_id] = str(image_path)
        elif image_path.suffix.lower() == '.svg':
            # Obsidian ExcalidrawのSVGは、元Markdownノートのスナップショットとして
            # 保存されていることがある。SVG本体が削除されていても、フロントエンドが
            # 同じフォルダのparsedノートへ解決できるよう、期待パスを返しておく。
            embedded_file_paths[file_id] = str(image_path)

        file_entry = files.get(file_id)
        if isinstance(file_entry, dict) and file_entry.get("dataURL"):
            continue

        if not image_path.exists():
            print(f"Warning: Image file not found: {image_filename}")
            continue

        # Markdownノートはブラウザ側でExcalidraw SVGスナップショットに変換する。
        if image_path.suffix.lower() == '.md':
            continue

        try:
            data_url, created = build_data_url(image_path)
            files[file_id] = {
                **(file_entry if isinstance(file_entry, dict) else {}),
                "mimeType": IMAGE_MIME_TYPE_MAP.get(image_path.suffix.lower().lstrip("."), "image/png"),
                "id": file_id,
                "dataURL": data_url,
                "created": created,
            }
            print(f"Loaded image: {image_path}")
        except Exception as e:
            print(f"Warning: Failed to load image {image_filename}: {e}")

    for file_id, file_data in list(files.items()):
        if not isinstance(file_data, dict) or file_data.get("dataURL"):
            continue

        mime_type = file_data.get("mimeType", "image/png")
        ext = mime_type.split("/")[-1] if "/" in mime_type else "png"
        image_filename = embedded_files_map.get(file_id, f"{file_id[:8]}.{ext}")
        image_path = resolve_embedded_file_path(file_path, image_filename, vault_root)

        if not image_path.exists():
            print(f"Warning: Image file not found: {image_filename}")
            continue

        if image_path.suffix.lower() == '.md':
            embedded_file_paths[file_id] = str(image_path)
            continue

        try:
            data_url, created = build_data_url(image_path, mime_type)
            file_data["dataURL"] = data_url
            file_data.setdefault("created", created)
            print(f"Loaded image: {image_path}")
        except Exception as e:
            print(f"Warning: Failed to load image {image_filename}: {e}")

    return embedded_file_paths


def find_embedded_markdown_candidates(file_path: Path) -> List[str]:
    """同じフォルダにある、埋め込み元候補の Excalidraw Markdown を返す。"""
    candidates: List[str] = []
    try:
        for candidate in sorted(file_path.parent.glob("*.md")):
            if candidate == file_path:
                continue
            try:
                content = candidate.read_text(encoding="utf-8")
            except (OSError, UnicodeError):
                continue
            if has_excalidraw_plugin_marker(content):
                candidates.append(str(candidate))
    except OSError:
        return []
    return candidates

@app.get("/")
async def root():
    # dist/index.html が存在する場合はフロントエンドを配信（PWA対応）
    dist_index = Path(__file__).parent.parent / "dist" / "index.html"
    if dist_index.exists():
        return FileResponse(
            str(dist_index),
            media_type="text/html",
            headers=CacheControlledStaticFiles.build_static_cache_headers(dist_index),
        )
    return {"message": "Excalidraw File API"}

@app.get("/api/load-file")
async def load_file(filepath: str):
    try:
        # FastAPIがクエリーパラメーターをデコード済みなので二重デコードしない。
        file_path = Path(filepath)
        markdown_content: Optional[str] = None

        # .excalidraw.md だけでなく、通常の .md に保存された
        # excalidraw-plugin: parsed ノートもExcalidrawデータとして扱う。
        if file_path.suffix.lower() == '.md' and file_path.exists():
            try:
                markdown_content = file_path.read_text(encoding='utf-8')
            except (OSError, UnicodeError):
                markdown_content = None
        is_excalidraw_markdown = is_obsidian_path(str(file_path)) or is_excalidraw_markdown_file(
            file_path,
            markdown_content,
        )

        # Obsidian連携: パス判定と読み込み切り替え
        if is_excalidraw_markdown:
            # .excalidraw リクエストだが、.excalidraw.md が存在する場合はそちらを優先（移行済み対応）
            if file_path.suffix == '.excalidraw':
                md_path = file_path.with_suffix('.excalidraw.md')
                if md_path.exists():
                    file_path = md_path
            
            # Markdownファイルとして読み込む場合
            if is_excalidraw_markdown_file(file_path, markdown_content):
                if not file_path.exists():
                     raise HTTPException(status_code=404, detail="Obsidian file not found")
                
                try:
                    content = markdown_content
                    if content is None:
                        with open(file_path, "r", encoding="utf-8") as f:
                            content = f.read()

                    if not content.strip():
                        data = create_empty_scene_data()
                        return {
                            "data": data,
                            "modified": file_path.stat().st_mtime,
                            "hash": compute_data_hash(data),
                            "resolvedPath": str(file_path),
                        }

                    embedded_files_map = parse_embedded_files_section(content)

                    try:
                        json_str = extract_json_from_markdown(content)
                    except ValueError as e:
                        raise HTTPException(
                            status_code=400,
                            detail={
                                "error_type": "json_syntax",
                                "message": str(e),
                            },
                        ) from e

                    # 詳細検証を実行
                    data, validation_error = validate_json_with_details(json_str)
                    if validation_error:
                        raise HTTPException(
                            status_code=400,
                            detail=validation_error.model_dump()
                        )

                    embedded_file_paths = hydrate_obsidian_files(file_path, data, embedded_files_map)
                    embedded_markdown_candidates = (
                        find_embedded_markdown_candidates(file_path)
                        if any(path.lower().endswith('.svg') for path in embedded_file_paths.values())
                        else []
                    )

                    data_hash = compute_data_hash(data)

                    # サロゲート文字をクリーンアップしてレスポンスを返す
                    clean_data = clean_surrogates(data)
                    # ファイルの修正日時を取得
                    file_modified = file_path.stat().st_mtime
                    return {
                        "data": clean_data,
                        "modified": file_modified,
                        "hash": data_hash,
                        "resolvedPath": str(file_path),
                        "embeddedFilePaths": embedded_file_paths,
                        "embeddedMarkdownCandidates": embedded_markdown_candidates,
                    }
                except HTTPException:
                    raise
                except Exception as e:
                    print(f"Error loading Obsidian file: {e}")
                    raise HTTPException(status_code=500, detail=f"Error parsing Obsidian file: {str(e)}")
        
        # ファイルが存在しない場合
        if not file_path.exists():
            raise HTTPException(status_code=404, detail="File not found")
        
        # ファイルを読み込み
        data = load_json_file(file_path)
        data_hash = compute_data_hash(data)

        # サロゲート文字をクリーンアップしてレスポンスを返す
        clean_data = clean_surrogates(data)
        return {
            "data": clean_data,
            "modified": 0,
            "hash": data_hash,
            "resolvedPath": str(file_path),
        }
    
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="File not found")
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON format")
    except HTTPException:
        raise
    except Exception as e:
        print(f"An unexpected error occurred in load_file: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error loading file: {str(e)}")

@app.get("/api/file-info")
async def get_file_info(filepath: str):
    try:
        # URLデコードを明示的に行う（ダブルクォートを含む文字列に対応）
        file_path = Path(filepath)

        # ファイルが存在しない場合は exists: False を返す
        if not file_path.exists():
            return {
                "modified": 0,
                "exists": False,
            }

        stat_result = file_path.stat()
        file_modified = stat_result.st_mtime
        cache_key = (str(file_path), stat_result.st_mtime_ns, stat_result.st_size)

        # Excalidraw Markdownは更新検知がmtimeベースのため、重い解析を避ける。
        if is_excalidraw_markdown_file(file_path):
            return {
                "modified": file_modified,
                "exists": True,
                "isExcalidraw": True,
            }

        data_hash = get_cached_data_hash(cache_key, lambda: load_json_file(file_path))

        return {
            "modified": file_modified,
            "hash": data_hash,
            "exists": True,
            "isExcalidraw": False,
        }

    except FileNotFoundError:
        # ファイルが見つからない場合も exists: False を返す
        return {
            "modified": 0,
            "exists": False,
        }
    except Exception as e:
        print(f"An unexpected error occurred in get_file_info: {e}")
        traceback.print_exc()
        # エラーの場合も exists: False を返す（500エラーを避ける）
        return {
            "modified": 0,
            "exists": False,
        }


def _normalize_filepath(raw_path: str) -> str:
    """Expand environment variables, user home, and trim quotes."""
    if raw_path is None:
        return ""
    trimmed = raw_path.strip()
    if trimmed.startswith('"') and trimmed.endswith('"') and len(trimmed) >= 2:
        trimmed = trimmed[1:-1]
    expanded = os.path.expandvars(os.path.expanduser(trimmed))
    return expanded




def _launch_with_system(path_str: str) -> None:
    """Open file or directory with the OS-specific default handler."""
    if sys.platform.startswith('win'):
        # UNC パスも含めて Windows の既定アプリに委譲
        os.startfile(path_str)  # type: ignore[attr-defined]
    elif sys.platform == 'darwin':
        subprocess.run(["open", path_str], check=True)
    else:
        subprocess.run(["xdg-open", path_str], check=True)


async def _open_path_via_os(raw_path: str) -> OpenFileResponse:
    if not raw_path:
        raise HTTPException(status_code=400, detail="File path is required")

    normalized = _normalize_filepath(raw_path)
    target_path = Path(normalized)

    if target_path.is_dir():
        target_type = "directory"
    elif target_path.is_file():
        target_type = "file"
    else:
        raise HTTPException(status_code=404, detail="File or directory not found")

    try:
        await asyncio.to_thread(_launch_with_system, str(target_path))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="File or directory not found")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to open {target_type}: {exc}")

    return OpenFileResponse(
        success=True,
        targetType=target_type,
        resolvedPath=str(target_path),
        message=f"Opened {target_type} via system handler."
    )


def _strip_cmd_prefix(raw_command: str) -> str:
    if raw_command is None:
        return ""

    trimmed = raw_command.strip()
    if not trimmed:
        return ""

    lower = trimmed.lower()
    if lower == "cmd":
        return ""

    if lower.startswith("cmd"):
        remainder = trimmed[3:]
        if not remainder:
            return ""
        if remainder[0].isspace():
            return remainder.lstrip()

    return trimmed


def _normalize_command_for_platform(command: str) -> str:
    if not command:
        return ""

    normalized = command.replace("\uFF02", '"')  # Full-width double quote to ASCII

    if sys.platform.startswith("win"):
        normalized = normalized.replace("¥", "\\").replace("￥", "\\")

    return normalized


def _spawn_system_command(command: str, cwd: Optional[str] = None) -> subprocess.Popen:
    if sys.platform.startswith("win"):
        creationflags = 0
        if hasattr(subprocess, "CREATE_NEW_CONSOLE"):
            creationflags |= subprocess.CREATE_NEW_CONSOLE

        return subprocess.Popen(
            command,
            shell=True,
            cwd=cwd,
            creationflags=creationflags,
        )

    shell_executable = os.environ.get("SHELL")

    if sys.platform == "darwin":
        shell_executable = shell_executable or "/bin/zsh"
    else:
        shell_executable = shell_executable or "/bin/bash"

    return subprocess.Popen(
        command,
        shell=True,
        executable=shell_executable,
        cwd=cwd,
        start_new_session=True,
    )




@app.post("/api/open-file", response_model=OpenFileResponse)
async def open_file_post(request: OpenFileRequest):
    return await _open_path_via_os(request.filepath)


@app.get("/api/open-file")
async def open_file_get(filepath: str):
    try:
        result = await _open_path_via_os(filepath)
    except HTTPException as exc:
        message = exc.detail if isinstance(exc.detail, str) else "Failed to open path"
        escaped_message = escape(message)
        error_html = f"""<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <title>Open File Error</title>
  </head>
  <body>
    <p>{escaped_message}</p>
  </body>
</html>"""
        return HTMLResponse(content=error_html, status_code=exc.status_code)

    escaped_message = escape(result.message or 'Opened path via system handler.')
    auto_close_html = f"""<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <title>Open File</title>
    <script>
      window.addEventListener('DOMContentLoaded', () => {{
        setTimeout(() => {{
          window.close();
        }}, 50);
      }});
    </script>
  </head>
  <body>
    <p>{escaped_message}</p>
  </body>
</html>"""
    return HTMLResponse(content=auto_close_html, status_code=200)


@app.get("/api/open-url")
async def open_url(url: str):
    """
    URLスキームをシステムのデフォルトハンドラーで開く
    obsidian:// などのカスタムURLスキームに対応
    """
    try:
        decoded_url = url

        parsed_url = urllib.parse.urlparse(decoded_url)
        if parsed_url.scheme.lower() not in ALLOWED_EXTERNAL_URL_SCHEMES:
            raise HTTPException(status_code=400, detail="URL scheme is not allowed")

        # システムのデフォルトハンドラーでURLを開く
        await asyncio.to_thread(_launch_with_system, decoded_url)

        return {
            "success": True,
            "url": decoded_url,
            "message": f"Opened URL with system handler"
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error opening URL: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to open URL: {str(e)}")


@app.post("/api/run-command", response_model=RunCommandResponse)
async def run_command(request: RunCommandRequest):
    # まずHTMLエンティティをデコード（例: &quot; → "）
    raw_command = unescape(request.command)
    cleaned_command = _strip_cmd_prefix(raw_command)
    cleaned_command = _normalize_command_for_platform(cleaned_command)
    # print(f"[DEBUG] Running command: {cleaned_command}")
    print("[DEBUG] request:", repr(request))

    if not cleaned_command:
        raise HTTPException(status_code=400, detail="Command is empty or missing after removing prefix")

    working_directory: Optional[str] = None
    if request.working_directory:
        normalized_workdir = _normalize_filepath(request.working_directory)
        if sys.platform.startswith("win"):
            normalized_workdir = normalized_workdir.replace("¥", "\\").replace("￥", "\\")

        if normalized_workdir and not Path(normalized_workdir).exists():
            raise HTTPException(status_code=400, detail="Specified working directory does not exist")

        working_directory = normalized_workdir or None

    try:
        process = _spawn_system_command(cleaned_command, cwd=working_directory)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Failed to locate command: {exc}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to execute command: {exc}")

    return RunCommandResponse(success=True, command=cleaned_command, pid=process.pid)


@app.post("/api/save-file")
async def save_file(request: SaveFileRequest):
    try:
        file_path = Path(request.filepath)

        data_to_save = request.data.model_dump()
        # ディレクトリが存在しない場合は作成
        file_path.parent.mkdir(parents=True, exist_ok=True)

        is_obsidian = is_obsidian_path(str(file_path))
        original_md_content = None
        image_files_map = {}  # file_id -> filename のマッピング

        # 通常の .md 名でも、既存ノートがExcalidrawプラグイン形式なら
        # Markdown本文を維持したまま図面データだけを更新する。
        if file_path.suffix.lower() == '.md' and file_path.exists() and not is_obsidian:
            try:
                original_md_content = file_path.read_text(encoding='utf-8')
                is_obsidian = has_excalidraw_plugin_marker(original_md_content)
            except (OSError, UnicodeError) as e:
                print(f"Warning: Failed to inspect existing markdown file: {e}")

        # Obsidian連携: パス判定と保存パス変更
        if is_obsidian:
            # 自動移行ロジックを削除: 保存時は拡張子を変更しない
            # if file_path.suffix == '.excalidraw':
            #     file_path = file_path.with_suffix('.excalidraw.md')

            # 既存コンテンツの読み込み（Frontmatter維持のため、および既存の画像リンク解析のため）
            existing_embedded_files = {} # file_id -> filename/link

            if file_path.exists() and original_md_content is None:
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        original_md_content = f.read()
                except Exception as e:
                    print(f"Warning: Failed to read existing obsidian file: {e}")

            if original_md_content is not None:
                existing_embedded_files = parse_embedded_files_section(original_md_content)

            # 画像を外部ファイルとして保存
            files = data_to_save.get('files', {})
            if files:
                for file_id, file_data in files.items():
                    # Markdownノートを画面内で表示するために生成したSVGは、元ノートの
                    # Embedded Filesリンクから再生成できるため、ディスクには保存しない。
                    # sourcePathは旧クライアントとの互換性、フラグは候補解決できない
                    # ケースの保険として利用する。
                    is_virtual_markdown_snapshot = (
                        isinstance(file_data, dict)
                        and (
                            file_data.get("isEmbeddedMarkdownSnapshot") is True
                            or str(file_data.get("sourcePath", "")).lower().endswith(".md")
                        )
                    )

                    # 既存リンクは、dataURLを保存しない場合でもMarkdownへ戻しておく。
                    if file_id in existing_embedded_files:
                        image_files_map[file_id] = existing_embedded_files[file_id]

                    if is_virtual_markdown_snapshot:
                        continue

                    # dataURLがある場合のみ保存（外部リソースでない場合）
                    if 'dataURL' in file_data and file_data['dataURL'].startswith('data:'):
                        try:
                            # dataURLからバイナリデータを取得
                            header, encoded = file_data['dataURL'].split(',', 1)
                            mime_type = header.split(':')[1].split(';')[0]
                            ext = mime_type.split('/')[1]
                            if ext == 'svg+xml': ext = 'svg'
                            
                            image_bytes = base64.b64decode(encoded)
                            
                            # 保存先ファイル名を決定
                            # 既存のリンクがある場合はそれを優先（ファイル名とパスを維持）
                            if file_id in existing_embedded_files:
                                current_link = existing_embedded_files[file_id]
                                # リンクがパスを含んでいる場合、その場所を探して上書きする
                                # 例: "assets/image.png" -> assetsフォルダを探す
                                
                                # 1. まずは絶対パス解決を試みる（既存 logic + vault root logic）
                                target_image_path = file_path.parent / current_link
                                if not target_image_path.parent.exists():
                                    # 親フォルダがない場合、Vaultルートからの相対パスかもしれない
                                    vault_root = find_vault_root(file_path)
                                    if vault_root:
                                        target_image_path = vault_root / current_link
                                
                                # それでもフォルダがない場合、あるいはファイルが存在しない場合でも
                                # 既存リンクが示す意図を尊重して、そのパス（の親ディレクトリ）が存在すればそこに保存したい
                                # ここでは簡単のため、「親ディレクトリが存在すればそこに保存」とする
                                if not target_image_path.parent.exists():
                                     # フォルダが見つからない場合は、やむを得ずカレント（file_pathと同じ場所）にフォールバック
                                     # ただし、ファイル名は維持する (basenameのみ)
                                     filename = os.path.basename(current_link)
                                     target_image_path = file_path.parent / filename
                                
                                # マッピング更新（埋め込み用リンク文字列は変更しない）
                                image_files_map[file_id] = current_link

                            else:
                                # 新規画像の場合
                                filename = f"{file_id}.{ext}"
                                target_image_path = file_path.parent / filename
                                image_files_map[file_id] = filename

                            # 親ディレクトリ作成（念のため）
                            target_image_path.parent.mkdir(parents=True, exist_ok=True)

                            # 書き込み途中で既存画像を壊さないよう原子的に置換
                            atomic_write_bytes(target_image_path, image_bytes)
                                
                            print(f"Saved image: {target_image_path}")

                        except Exception as e:
                            print(f"Warning: Failed to save image {file_id}: {e}")
            
            # dataURLを削除してファイルサイズを削減
            # Obsidianプラグインは元のdataURLも保持するが、
            # ここでは削除してファイルサイズを削減
            for file_id, file_data in files.items():
                if 'dataURL' in file_data:
                    del file_data['dataURL']


        # バックアップを作成（Obsidianファイル以外）
        if not is_obsidian:
            backup_success = create_backup(request.filepath, force=request.force_backup)
            if not backup_success:
                print("Warning: Backup creation failed, but continuing with file save")

        # 完成した内容を一時ファイルへ書いてから置換する。
        # 保存中断・容量不足などでも既存ファイルを途中まで切り詰めない。
        if is_obsidian:
            json_str = json.dumps(data_to_save, ensure_ascii=False)
            serialized_content = embed_json_into_markdown(
                original_md_content,
                json_str,
                image_files_map if image_files_map else None,
            )
        else:
            serialized_content = json.dumps(data_to_save, ensure_ascii=False, indent=2)

        # ファイルに保存 (リトライ処理付き)
        max_retries = 10
        retry_delay = 0.2  # 200ミリ秒
        for attempt in range(max_retries):
            try:
                atomic_write_text(file_path, serialized_content)
                # 成功したらループを抜ける
                break
            except PermissionError:
                if attempt < max_retries - 1:
                    # print(f"Warning: PermissionError on save (attempt {attempt + 1}/{max_retries}). Retrying in {retry_delay}s...")
                    time.sleep(retry_delay)
                else:
                    # 最後のリトライでも失敗したらエラーを投げる
                    # print(f"Error: Failed to save file after {max_retries} attempts due to PermissionError.")
                    raise HTTPException(status_code=500, detail="Failed to save file due to a persistent file lock.")

        data_hash = compute_data_hash(data_to_save)
        # 保存後のファイル修正日時を取得
        file_modified = file_path.stat().st_mtime

        return {
            "success": True,
            "message": f"File saved to {request.filepath}",
            "modified": file_modified,
            "hash": data_hash,
        }
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error saving file: {str(e)}")

@app.post("/api/upload-files")
async def upload_files(
    files: List[UploadFile] = File(...),
    current_path: str = Form(...),
    file_type: str = Form("general")
):
    try:
        if not files:
            raise HTTPException(status_code=400, detail="No files provided")
        
        # アップロードディレクトリを取得
        upload_dir = get_upload_directory(current_path, file_type)
        
        uploaded_files = []
        
        for file in files:
            if not file.filename:
                continue
                
            # ファイル名をサニタイズ
            safe_filename = sanitize_filename(file.filename)
            
            # 重複回避のためタイムスタンプを追加
            timestamp = str(int(time.time()))
            name, ext = os.path.splitext(safe_filename)
            unique_filename = f"{name}_{timestamp}{ext}"
            
            file_path = upload_dir / unique_filename
            
            # ファイルを保存
            with open(file_path, "wb") as buffer:
                content = await file.read()
                buffer.write(content)
            
            uploaded_files.append({
                "name": file.filename,
                "path": compute_relative_path(current_path, str(file_path)),
                "size": len(content)
            })
        
        return FileUploadResponse(
            success=True,
            files=uploaded_files
        )
        
    except Exception as e:
        import traceback
        print("Upload error:", str(e))
        print("Traceback:", traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"Error uploading files: {str(e)}")

@app.post("/api/create-folder-shortcut")
async def create_folder_shortcut(
    folder_path: str = Form(...),
    current_path: str = Form(...)
):
    try:
        # フォルダショートカット用ディレクトリを取得
        upload_dir = get_upload_directory(current_path, "folder")
        
        # フォルダ名を取得
        folder_name = os.path.basename(folder_path.rstrip('/\\'))
        if not folder_name:
            folder_name = "folder"
        
        # ショートカットファイルを作成
        timestamp = str(int(time.time()))
        shortcut_filename = f"{sanitize_filename(folder_name)}_{timestamp}.txt"
        shortcut_path = upload_dir / shortcut_filename
        
        # ショートカット内容を作成
        shortcut_content = f"Folder Shortcut\nPath: {folder_path}\nCreated: {time.strftime('%Y-%m-%d %H:%M:%S')}"
        
        with open(shortcut_path, "w", encoding="utf-8") as f:
            f.write(shortcut_content)
        
        return FolderShortcutResponse(
            success=True,
            folderPath=compute_relative_path(current_path, str(shortcut_path))
        )
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error creating folder shortcut: {str(e)}")

@app.post("/api/save-email")
async def save_email(request: SaveEmailRequest):
    try:
        # メール用ディレクトリを取得
        upload_dir = get_upload_directory(request.currentPath, "email")
        
        # 件名をファイル名として使用
        safe_subject = sanitize_filename(request.subject)
        if not safe_subject:
            safe_subject = "email"
        
        # タイムスタンプを追加
        timestamp = str(int(time.time()))
        email_filename = f"{safe_subject}_{timestamp}.eml"
        email_path = upload_dir / email_filename
        
        # メールデータを保存
        with open(email_path, "w", encoding="utf-8") as f:
            f.write(f"Subject: {request.subject}\n")
            f.write(f"Date: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write(f"Content-Type: text/plain; charset=utf-8\n\n")
            f.write(request.emailData)
        
        return EmailSaveResponse(
            success=True,
            savedPath=compute_relative_path(request.currentPath, str(email_path))
        )
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error saving email: {str(e)}")

@app.post("/save-library")
async def save_library(request: SaveLibraryRequest):
    """ライブラリファイルを保存するエンドポイント"""
    try:
        # プロジェクトルートからの相対パスを解決
        project_root = Path(__file__).parent.parent  # backendディレクトリの親ディレクトリ
        file_path = (project_root / request.file_path).resolve()
        allowed_path = (project_root / "public/excalidraw_lib/my_lib.excalidrawlib").resolve()
        if file_path != allowed_path:
            raise HTTPException(status_code=403, detail="Library path is not allowed")
        
        # ディレクトリが存在しない場合は作成
        file_path.parent.mkdir(parents=True, exist_ok=True)
        
        # ライブラリファイルに保存
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(request.data, f, ensure_ascii=False, indent=2)
        
        return SaveLibraryResponse(
            success=True,
            message=f"Library saved to {file_path}"
        )
    
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error saving library: {str(e)}")
        return SaveLibraryResponse(
            success=False,
            error=f"Error saving library: {str(e)}"
        )

@app.post("/api/save-svg")
async def save_svg(request: SaveSvgRequest):
    """SVGファイルを保存するエンドポイント"""
    try:
        file_path = Path(request.filepath)
        
        # ディレクトリが存在しない場合は作成
        file_path.parent.mkdir(parents=True, exist_ok=True)
        
        # SVGファイルに保存
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(request.svg_content)
        
        return {"success": True, "message": f"SVG file saved to {request.filepath}"}
    
    except Exception as e:
        print(f"Error saving SVG file: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error saving SVG file: {str(e)}")


@app.post("/api/open-folder", response_model=OpenFolderResponse)
async def open_folder(request: OpenFolderRequest):
    try:
        if not request.path:
            raise HTTPException(status_code=400, detail="Folder path is required")

        target_path = Path(request.path).expanduser()

        # ファイルが指定された場合は親ディレクトリを対象にする
        if target_path.is_file():
            target_path = target_path.parent

        resolved_path = target_path.resolve()

        if sys.platform.startswith("win"):
            subprocess.Popen(["explorer", str(resolved_path)])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(resolved_path)])
        else:
            subprocess.Popen(["xdg-open", str(resolved_path)])

        return OpenFolderResponse(success=True, openedPath=str(resolved_path))

    except HTTPException:
        raise
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Folder not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error opening folder: {str(e)}")


@app.post("/api/open-in-editor", response_model=OpenEditorResponse)
async def open_in_editor(request: OpenEditorRequest):
    """VS Codeを優先し、未導入ならOSの標準ファイルマネージャーで開く。"""
    if not request.path:
        raise HTTPException(status_code=400, detail="Folder path is required")

    target_path = Path(_normalize_filepath(request.path))
    if target_path.is_file():
        target_path = target_path.parent
    if not target_path.is_dir():
        raise HTTPException(status_code=404, detail="Folder not found")

    resolved_path = target_path.resolve()
    code_executable = shutil.which("code") or shutil.which("code.cmd")

    # macOSではPATHにcodeコマンドがなくても標準のアプリ配置を利用できる。
    mac_code_executable = Path(
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
    )
    if not code_executable and sys.platform == "darwin" and mac_code_executable.is_file():
        code_executable = str(mac_code_executable)

    try:
        if code_executable:
            subprocess.Popen([code_executable, str(resolved_path)], start_new_session=True)
            return OpenEditorResponse(
                success=True,
                openedPath=str(resolved_path),
                fallbackUsed=False,
                message="Opened folder in Visual Studio Code.",
            )

        await asyncio.to_thread(_launch_with_system, str(resolved_path))
        return OpenEditorResponse(
            success=True,
            openedPath=str(resolved_path),
            fallbackUsed=True,
            message="Visual Studio Code was not found; opened the system file manager instead.",
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Error opening editor or folder: {exc}")



@app.post("/api/list-directory", response_model=ListDirectoryResponse)
async def list_directory(request: ListDirectoryRequest):
    try:
        target_path = Path(request.path).expanduser() if request.path else Path.cwd()
        if not target_path.exists():
            raise HTTPException(status_code=404, detail="Directory not found")
        if not target_path.is_dir():
            raise HTTPException(status_code=400, detail="Target path is not a directory")

        resolved_path = target_path.resolve()
        entries: List[DirectoryEntry] = []

        for entry in resolved_path.iterdir():
            if not request.show_hidden and entry.name.startswith('.'):
                continue

            try:
                is_dir = entry.is_dir()
            except (PermissionError, FileNotFoundError):
                continue

            if not is_dir:
                name_lower = entry.name.lower()
                is_markdown_drawing = (
                    name_lower.endswith('.md')
                    and is_excalidraw_markdown_file(entry)
                )
                if not (
                    name_lower.endswith('.excalidraw')
                    or name_lower.endswith('.excalidraw.md')
                    or is_markdown_drawing
                ):
                    continue

            try:
                stat = entry.stat()
            except (PermissionError, FileNotFoundError):
                continue

            entries.append(
                DirectoryEntry(
                    name=entry.name,
                    path=str(entry.resolve()),
                    is_dir=is_dir,
                    size=None if is_dir else stat.st_size,
                    modified=stat.st_mtime,
                )
            )

        entries.sort(key=lambda item: (not item.is_dir, item.name.lower()))

        parent_path = None
        if resolved_path.parent != resolved_path:
            parent_path = str(resolved_path.parent)

        return ListDirectoryResponse(
            success=True,
            path=str(resolved_path),
            parentPath=parent_path,
            entries=entries,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error listing directory: {str(e)}")


# 静的ファイル配信の設定
@app.get("/api/file/{file_path:path}")
async def serve_uploaded_file(file_path: str):
    """アップロードされたファイルを配信"""
    try:
        path_parts = Path(file_path).parts
        if len(path_parts) < 2 or path_parts[0] not in {'uploads', 'upload_local'}:
            raise HTTPException(status_code=403, detail="Access denied")

        project_root = Path(__file__).parent.parent.resolve()
        allowed_root = (project_root / path_parts[0]).resolve()
        actual_file_path = (allowed_root / Path(*path_parts[1:])).resolve()
        if not actual_file_path.is_relative_to(allowed_root):
            raise HTTPException(status_code=403, detail="Access denied")
        
        # ファイルが存在するか確認
        if not actual_file_path.exists():
            raise HTTPException(status_code=404, detail="File not found")
        
        # ファイルを返す
        return FileResponse(
            path=str(actual_file_path),
            filename=actual_file_path.name,
            media_type='application/octet-stream'
        )
    
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error serving file {file_path}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error serving file: {str(e)}")

class ArchiveFileRequest(BaseModel):
    filepath: str

class ArchiveFileResponse(BaseModel):
    success: bool
    archivedPath: Optional[str] = None
    message: Optional[str] = None
    error: Optional[str] = None

@app.post("/api/archive-file", response_model=ArchiveFileResponse)
async def archive_file(request: ArchiveFileRequest):
    """
    指定されたファイルをbackupフォルダに移動（アーカイブ）する。
    ファイル名は {original_name}_{timestamp}{ext} となる。
    """
    try:
        file_path = Path(request.filepath)
        
        if not file_path.exists():
            return ArchiveFileResponse(success=False, error="File not found")
            
        # backupフォルダの作成
        backup_dir = file_path.parent / "backup"
        backup_dir.mkdir(exist_ok=True)
        
        # タイムスタンプ付きのファイル名を生成
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        new_filename = f"{file_path.stem}_{timestamp}{file_path.suffix}"
        backup_path = backup_dir / new_filename
        
        # 移動実行
        shutil.move(str(file_path), str(backup_path))
        
        # 相対パスを計算して返す
        try:
            archived_path_str = str(backup_path)
            message = f"File archived to {new_filename}"
        except Exception:
            archived_path_str = str(backup_path)
            message = "File archived successfully"
            
        print(f"[Archive] Moved {file_path} to {backup_path}")
        
        return ArchiveFileResponse(
            success=True,
            archivedPath=archived_path_str,
            message=message
        )
        
    except Exception as e:
        print(f"Error archiving file: {e}")
        return ArchiveFileResponse(
            success=False,
            error=str(e)
        )


# ========================================
# フロントエンド静的ファイル配信（PWA対応）
# ========================================
# dist/ディレクトリが存在する場合、ビルド済みフロントエンドを配信する
# APIルートの後にマウントすることで、/api/* は通常通り処理される
dist_path = Path(__file__).parent.parent / "dist"
if dist_path.exists():
    app.mount("/", CacheControlledStaticFiles(directory=str(dist_path), html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3001)
