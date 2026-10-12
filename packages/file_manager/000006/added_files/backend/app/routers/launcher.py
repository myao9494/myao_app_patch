"""
外部アプリ起動 APIルーター
- POST /api/open/smart: 拡張子と設定から開き方を判定（Excalidraw / Jupyter / Obsidian / 内蔵エディタ / OS既定アプリ）
- POST /api/open/{vscode,editor,execute,explorer,default,antigravity,jupyter,excalidraw,obsidian,trash}
- GET  /api/fullpath: フルパスでファイルを開く（外部ツール・リンク連携用、file_viewer 互換）
- GET/POST /api/open-path, POST /api/open-folder: パス/フォルダを開く（file_viewer 互換）
- Windows では起動したウィンドウ（Explorer / Obsidian）を前面化する
"""
import ctypes
import html
import os
import platform
import subprocess
import threading
import time
import urllib.parse
import webbrowser
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from pydantic import BaseModel

from app.config import get_editor_preferences, settings
from app.schemas import OpenRequest
from app.services.paths import (
    convert_storage_path,
    normalize_path,
    run_in_io_thread,
    run_with_timeout,
)

router = APIRouter()


def _bring_explorer_to_front(process_id: int, target_path: Path) -> None:
    """
    Windowsで起動したExplorerウィンドウを前面に出すことを試みる。

    Windowsのフォアグラウンド制御制限により必ず成功する保証はないが、
    起動直後の数回リトライでユーザー体感を改善する。
    """
    if platform.system() != "Windows":
        return

    def worker() -> None:
        try:
            user32 = ctypes.windll.user32
            kernel32 = ctypes.windll.kernel32
        except Exception:
            return

        target_name = target_path.name.lower()
        shell_window = user32.GetShellWindow()

        def try_focus_window(hwnd: int) -> bool:
            if not hwnd or hwnd == shell_window:
                return False
            if not user32.IsWindowVisible(hwnd):
                return False

            class_name_buffer = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, class_name_buffer, len(class_name_buffer))
            class_name = class_name_buffer.value
            if class_name not in {"CabinetWClass", "ExploreWClass"}:
                return False

            window_text_buffer = ctypes.create_unicode_buffer(512)
            user32.GetWindowTextW(hwnd, window_text_buffer, len(window_text_buffer))
            window_title = window_text_buffer.value.lower()

            window_process_id = ctypes.c_ulong()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(window_process_id))

            if (
                window_process_id.value != process_id
                and target_name
                and target_name not in window_title
            ):
                return False
            return _focus_window_handle(user32, kernel32, hwnd, restore_minimized=True)

        for _ in range(10):
            focused = False

            @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
            def enum_windows_proc(hwnd, _lparam):
                nonlocal focused
                if focused:
                    return False
                focused = try_focus_window(hwnd)
                return not focused

            try:
                user32.EnumWindows(enum_windows_proc, 0)
            except Exception:
                return

            if focused:
                return
            time.sleep(0.2)

    threading.Thread(target=worker, daemon=True).start()


def _schedule_macos_obsidian_activation() -> None:
    """
    macOSでObsidianを少し遅らせて前面化する。

    ブラウザで /api/fullpath を開いた直後は、レスポンス描画でブラウザが
    再度アクティブになることがあるため、Obsidian URI 起動後に短い遅延を
    入れてアプリをactivateする。
    """
    subprocess.Popen([
        "/bin/sh",
        "-c",
        "sleep 0.35; /usr/bin/osascript -e 'tell application \"Obsidian\" to activate'",
    ])


def _bring_obsidian_to_front() -> None:
    """
    Obsidianウィンドウを前面に出すことを試みる。

    obsidian:// 起動では既存のObsidianウィンドウが別デスクトップに残ることがあるため、
    起動直後にタイトルからObsidianウィンドウを探して前面化を数回リトライする。
    """
    if platform.system() == "Darwin":
        _schedule_macos_obsidian_activation()
        return

    if platform.system() != "Windows":
        return

    def worker() -> None:
        try:
            user32 = ctypes.windll.user32
            kernel32 = ctypes.windll.kernel32
        except Exception:
            return

        shell_window = user32.GetShellWindow()
        title_keywords = ("obsidian",)

        def try_focus_window(hwnd: int) -> bool:
            if not hwnd or hwnd == shell_window:
                return False
            if not user32.IsWindowVisible(hwnd):
                return False

            title_buffer = ctypes.create_unicode_buffer(512)
            user32.GetWindowTextW(hwnd, title_buffer, len(title_buffer))
            window_title = title_buffer.value.lower()
            if not window_title or not any(keyword in window_title for keyword in title_keywords):
                return False
            return _focus_window_handle(user32, kernel32, hwnd, restore_minimized=True)

        for _ in range(15):
            focused = False

            @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
            def enum_windows_proc(hwnd, _lparam):
                nonlocal focused
                if focused:
                    return False
                focused = try_focus_window(hwnd)
                return not focused

            try:
                user32.EnumWindows(enum_windows_proc, 0)
            except Exception:
                return

            if focused:
                return
            time.sleep(0.2)

    threading.Thread(target=worker, daemon=True).start()


def _focus_window_handle(user32, kernel32, hwnd: int, restore_minimized: bool) -> bool:
    """
    Windowsウィンドウを前面化する。

    非最小化ウィンドウに SW_RESTORE を送ると最大化や全画面状態が崩れることがあるため、
    最小化時だけ復元して、それ以外は前面化のみ行う。
    """
    if not hwnd or not user32.IsWindowVisible(hwnd):
        return False

    current_thread_id = kernel32.GetCurrentThreadId()
    window_thread_id = user32.GetWindowThreadProcessId(hwnd, None)
    attached = False
    if window_thread_id and window_thread_id != current_thread_id:
        attached = bool(user32.AttachThreadInput(current_thread_id, window_thread_id, True))

    try:
        is_iconic = bool(getattr(user32, "IsIconic", lambda _hwnd: False)(hwnd))
        if restore_minimized and is_iconic:
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        user32.BringWindowToTop(hwnd)
        return bool(user32.SetForegroundWindow(hwnd))
    finally:
        if attached:
            user32.AttachThreadInput(current_thread_id, window_thread_id, False)


PROGRAM_CODE_EXTENSIONS = {
    ".py",
    ".pyw",
    ".sh",
    ".bash",
    ".zsh",
    ".command",
    ".bat",
    ".cmd",
    ".ps1",
}


def _is_program_code_file(path: Path) -> bool:
    """右クリックメニュー拡張対象のプログラムコードファイルか判定する。"""
    return path.is_file() and path.suffix.lower() in PROGRAM_CODE_EXTENSIONS


def _ensure_program_code_file(path: Path) -> None:
    """プログラムコードファイルでない場合はエラーを返す。"""
    if not path.exists():
        raise HTTPException(status_code=404, detail="ファイルが見つかりません")
    if not path.is_file():
        raise HTTPException(status_code=400, detail="ファイルを指定してください")
    if not _is_program_code_file(path):
        raise HTTPException(status_code=400, detail="プログラムコードファイルのみ対応しています")


def _build_editor_open_command(path: Path) -> List[str]:
    """OSごとのテキストエディター起動コマンドを返す。"""
    system = platform.system()
    if system == "Darwin":
        return ["open", "-a", "TextEdit", str(path)]
    if system == "Windows":
        return ["notepad.exe", str(path)]
    return ["xdg-open", str(path)]


def _build_execute_command(path: Path) -> List[str]:
    """拡張子に応じた実行コマンドを返す。"""
    system = platform.system()
    suffix = path.suffix.lower()

    if suffix in {".py", ".pyw"}:
        return ["py", str(path)] if system == "Windows" else ["python3", str(path)]
    if suffix in {".sh", ".bash", ".command"}:
        return ["bash", str(path)]
    if suffix == ".zsh":
        return ["zsh", str(path)]
    if suffix in {".bat", ".cmd"}:
        if system != "Windows":
            raise HTTPException(status_code=400, detail=f"{suffix} はこのOSでは実行できません")
        return ["cmd", "/c", str(path)]
    if suffix == ".ps1":
        if system == "Windows":
            return ["powershell", "-ExecutionPolicy", "Bypass", "-File", str(path)]
        raise HTTPException(status_code=400, detail=".ps1 はこのOSでは実行できません")

    raise HTTPException(status_code=400, detail="このファイルは実行対象外です")


@router.post("/open/vscode")
def open_in_vscode(request: OpenRequest):
    """
    指定されたパスをVS Codeで開く
    """
    path = normalize_path(request.path)
    
    if platform.system() == 'Darwin':
        vscode_path = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
        # Fallback for other locations or names if needed
        if not os.path.exists(vscode_path):
             # Try generic 'code' command
             vscode_path = 'code'
    elif platform.system() == 'Windows':
        vscode_path = os.path.join(os.environ["USERPROFILE"], r"AppData\Local\Programs\Microsoft VS Code\Code.exe")
    else:
        raise HTTPException(status_code=501, detail="サポートされていないOSです")

    # ファイル/フォルダが存在するか確認
    target_path = path if path.exists() else path.parent

    try:
        if platform.system() == 'Darwin':
             # macOS specific AppleScript for focus (optional, keeping simple subprocess first)
             subprocess.Popen([vscode_path, str(target_path)])
        else:
             subprocess.Popen([vscode_path, str(target_path)])
        return {"status": "success", "message": "VS Codeで開きました"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"VS Codeの起動に失敗しました: {str(e)}")


@router.post("/open/editor")
def open_in_editor(request: OpenRequest):
    """
    指定されたプログラムコードファイルをテキストエディターで開く
    """
    path = normalize_path(request.path)
    _ensure_program_code_file(path)

    try:
        subprocess.Popen(_build_editor_open_command(path))
        return {"status": "success", "message": "エディターで開きました"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"エディターの起動に失敗しました: {str(e)}")


@router.post("/open/execute")
def execute_program_code(request: OpenRequest):
    """
    指定されたプログラムコードファイルを実行する
    """
    path = normalize_path(request.path)
    _ensure_program_code_file(path)

    try:
        popen_kwargs = {"cwd": str(path.parent)}
        if platform.system() == "Windows":
            popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
        subprocess.Popen(_build_execute_command(path), **popen_kwargs)
        return {"status": "success", "message": "実行を開始しました"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"実行に失敗しました: {str(e)}")


@router.post("/open/explorer")
def open_in_explorer(request: OpenRequest):
    """
    指定されたパスをエクスプローラー/Finderで開く
    """
    path = normalize_path(request.path)
    target_path = path if path.is_dir() else path.parent
    
    if not target_path.exists():
         raise HTTPException(status_code=404, detail="パスが見つかりません")

    try:
        if platform.system() == "Windows":
            process = subprocess.Popen(['explorer', str(target_path).replace('/', '\\')])
            _bring_explorer_to_front(process.pid, target_path)
        elif platform.system() == "Darwin":
            subprocess.Popen(["open", str(target_path)])
        else:
            subprocess.Popen(["xdg-open", str(target_path)])
        return {"status": "success", "message": "フォルダを開きました"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"フォルダを開けませんでした: {str(e)}")


@router.post("/open/default")
def open_in_default_app(request: OpenRequest):
    """
    指定されたファイルをOSのデフォルトアプリケーションで開く
    """
    path = normalize_path(request.path)
    
    if not path.exists():
        raise HTTPException(status_code=404, detail="ファイルが見つかりません")

    try:
        if platform.system() == "Windows":
            os.startfile(str(path))
        elif platform.system() == "Darwin":  # macOS
            subprocess.Popen(["open", str(path)])
        else:  # Linux
            subprocess.Popen(["xdg-open", str(path)])
        return {"status": "success", "message": "ファイルを開きました"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ファイルを開けませんでした: {str(e)}")


class SmartOpenResponse(BaseModel):
    """
    スマートオープンの結果
    action: 実行されたアクション
    - "opened": 外部アプリで開いた
    - "open_modal": フロントエンドでモーダルを開く（内蔵エディタ用）
    - "open_url": フロントエンドでURLを開く（PDF等）
    """
    status: str
    action: str
    message: str
    content: Optional[str] = None  # action=open_modalの場合のファイル内容
    url: Optional[str] = None  # action=open_urlの場合のURL
    editor_mode: Optional[str] = None  # "markdown" | "code"
    language: Optional[str] = None  # シンタックスハイライト用の言語ID


EMBEDDED_EDITOR_LANGUAGE_MAP = {
    ".md": "markdown",
    ".txt": "plaintext",
    ".log": "plaintext",
    ".text": "plaintext",
    ".json": "json",
    ".jsonc": "json",
    ".js": "javascript",
    ".jsx": "jsx",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".py": "python",
    ".pyw": "python",
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell",
    ".command": "shell",
    ".bat": "batch",
    ".cmd": "batch",
    ".ps1": "powershell",
    ".css": "css",
    ".scss": "css",
    ".html": "html",
    ".htm": "html",
    ".xml": "xml",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".toml": "toml",
    ".ini": "ini",
    ".cfg": "ini",
    ".conf": "ini",
    ".sql": "sql",
    ".csv": "plaintext",
}


EMBEDDED_EDITOR_SPECIAL_FILENAMES = {
    "dockerfile": "plaintext",
    "makefile": "plaintext",
}


def _get_embedded_editor_language(path: Path) -> Optional[str]:
    """内蔵エディタで扱うファイルの言語IDを返す。"""
    if not path.exists() or not path.is_file():
        return None

    lower_name = path.name.lower()
    if lower_name in EMBEDDED_EDITOR_SPECIAL_FILENAMES:
        return EMBEDDED_EDITOR_SPECIAL_FILENAMES[lower_name]
    if lower_name.startswith(".env"):
        return "dotenv"

    return EMBEDDED_EDITOR_LANGUAGE_MAP.get(path.suffix.lower())


def _is_excalidraw_markdown(path: Path) -> bool:
    """Excalidraw用のMarkdownファイルか判定する。"""
    lower_name = path.name.lower()
    return ".excalidraw" in lower_name and lower_name.endswith(".md")


def resolve_file_app_url(path_obj: Path) -> Optional[str]:
    """
    ファイルパスから、専用アプリで開くためのURL/URIを解決する
    - Excalidraw -> http://localhost:3001/...
    - Jupyter -> http://localhost:8888/...
    - Obsidian -> obsidian://...
    - PDF -> /api/view-pdf...
    
    該当しない場合は None を返す
    """

    start_path = str(path_obj).lower()

    # --- Excalidraw ---
    # ファイル名に .excalidraw が含まれていればExcalidrawとして扱う
    # (例: file.excalidraw.md, file.excalidraw 1.md)
    name_lower = path_obj.name.lower()
    if '.excalidraw' in name_lower:
        if (name_lower.endswith('.excalidraw') or 
            name_lower.endswith('.md') or 
            name_lower.endswith('.svg') or 
            name_lower.endswith('.png')):
            
            encoded_path = urllib.parse.quote(str(path_obj))
            return f"http://localhost:3001/?filepath={encoded_path}"

    # --- Jupyter (.ipynb) ---
    if start_path.endswith('.ipynb'):
        # Windows specific logic: Port 8082, Root %USERPROFILE%/000_work
        if platform.system() == 'Windows':
            JUPYTER_BASE_URL = "http://localhost:8082/tree"
            user_profile = os.environ.get("USERPROFILE")
            if user_profile:
                jupyter_root = Path(user_profile) / "000_work"
                try:
                    # Calculate path relative to 000_work
                    # Note: We need to resolve paths to ensure correct relative calculation
                    resolved_path = path_obj.resolve()
                    resolved_root = jupyter_root.resolve()
                    
                    if str(resolved_path).lower().startswith(str(resolved_root).lower()):
                        relative_path = resolved_path.relative_to(resolved_root)
                        url_path = urllib.parse.quote(str(relative_path).replace('\\', '/'))
                        return f"{JUPYTER_BASE_URL}/{url_path}"
                except (ValueError, OSError):
                    # File is not inside 000_work, fall back to default logic or handle error
                    pass

        # Default/Existing logic (macOS/Linux or fallback)
        JUPYTER_BASE_URL = "http://localhost:8888/lab/tree"
        try:
            relative_path = path_obj.relative_to(settings.base_dir)
            url_path = urllib.parse.quote(str(relative_path).replace('\\', '/'))
            return f"{JUPYTER_BASE_URL}/{url_path}"
        except ValueError:
            pass 

    # --- Obsidian (.md) ---
    if start_path.endswith('.md') and 'obsidian' in start_path:
        parts = str(path_obj).replace('\\', '/').split('/')
        obsidian_idx = -1
        for i, part in enumerate(parts):
            if 'obsidian' in part.lower():
                obsidian_idx = i
                break
        
        if obsidian_idx != -1:
            vault_name = parts[obsidian_idx]
            relative_file_path = '/'.join(parts[obsidian_idx+1:])
            encoded_file = urllib.parse.quote(relative_file_path)
            encoded_vault = urllib.parse.quote(vault_name)
            return f"obsidian://open?vault={encoded_vault}&file={encoded_file}"

    # --- PDF ---
    # PDFはプラットフォームに関係なくブラウザで別タブ表示する
    if start_path.endswith('.pdf'):
        encoded_path = urllib.parse.quote(str(path_obj))
        return f"/api/view-pdf?path={encoded_path}"

    return None


def _prefers_html_response(request: Request) -> bool:
    """
    ブラウザの直接ナビゲーションかどうかをAcceptヘッダから判定する。

    fetch/jsonクライアントは従来どおりJSONを維持し、ブラウザ直開きのみ
    タブを閉じるHTMLやリダイレクトを返すために使用する。
    """
    accept = request.headers.get("accept", "")
    return "text/html" in accept or "application/xhtml+xml" in accept


def _close_tab_response(
    message: str = "Opened. Closing tab...",
    delay_ms: int = 1500,
) -> HTMLResponse:
    """
    外部アプリ起動後に一時タブを自動的に閉じるHTMLを返す。
    """
    escaped_message = html.escape(message)
    safe_delay_ms = max(0, delay_ms)
    return HTMLResponse(f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Closing...</title>
        <script>
            window.onload = function() {{
                setTimeout(function() {{
                    window.open('', '_self', '');
                    window.close();
                }}, {safe_delay_ms});
            }};
        </script>
    </head>
    <body style="background-color: #f0f0f0; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
        <div style="text-align: center; color: #666;">
            <p>{escaped_message}</p>
        </div>
    </body>
    </html>
    """)


def _build_frontend_editor_redirect_url(path: Path) -> str:
    """内蔵エディタで開くためのフロントエンドURLを組み立てる。"""
    encoded_parent = urllib.parse.quote(str(path.parent))
    encoded_file = urllib.parse.quote(str(path))
    return f"/?path={encoded_parent}&open_file={encoded_file}&open_mode=web"


def _build_frontend_directory_redirect_url(path: Path) -> str:
    """フォルダ表示用のフロントエンドURLを組み立てる。"""
    encoded_path = urllib.parse.quote(str(path))
    return f"/?path={encoded_path}"


def _should_use_web_editor_for_fullpath(
    path: Path,
    markdown_mode: Optional[str],
    text_mode: Optional[str],
) -> bool:
    """fullpath APIでWebエディタに誘導すべきか判定する。"""
    if _is_excalidraw_markdown(path):
        return False

    embedded_editor_language = _get_embedded_editor_language(path)
    if embedded_editor_language == "markdown":
        if markdown_mode == "web":
            return True
        if markdown_mode == "obsidian_or_web":
            target_url = resolve_file_app_url(path)
            return not (target_url and target_url.startswith("obsidian://"))
        return False
    if embedded_editor_language:
        return text_mode == "web"
    return False


def _should_use_external_markdown_app_for_fullpath(path: Path, markdown_mode: Optional[str]) -> bool:
    """fullpath APIでMarkdownを外部アプリ起動すべきか判定する。"""
    if _is_excalidraw_markdown(path):
        return False
    if _get_embedded_editor_language(path) != "markdown":
        return False
    if markdown_mode in {"external", "obsidian", "vscode"}:
        return True
    if markdown_mode == "obsidian_or_web":
        target_url = resolve_file_app_url(path)
        return bool(target_url and target_url.startswith("obsidian://"))
    return False


def _resolve_fullpath_preference(
    request: Request,
    query_param_name: str,
) -> Optional[str]:
    """fullpath用の設定値をquery→設定ファイルの順で解決する。"""
    query_value = request.query_params.get(query_param_name)
    if query_value:
        return query_value

    preferences = get_editor_preferences()
    if query_param_name == "markdown_mode":
        return preferences["markdownOpenMode"]
    if query_param_name == "text_mode":
        return preferences["textFileOpenMode"]

    return None


async def _open_markdown_external_app_for_fullpath(path: Path) -> None:
    """MarkdownをObsidian内外で適切な外部アプリへ振り分ける。"""
    target_url = resolve_file_app_url(path)
    if target_url and target_url.startswith("obsidian://"):
        await open_smart(OpenRequest(path=str(path)))
        return

    await run_in_io_thread(open_in_vscode, OpenRequest(path=str(path)))


async def _handle_fullpath_html_preferences(request: Request, path: Path) -> Optional[Response]:
    """ブラウザ直開き時の設定連動をfullpath APIに適用する。"""
    markdown_mode = _resolve_fullpath_preference(
        request,
        "markdown_mode",
    )
    text_mode = _resolve_fullpath_preference(
        request,
        "text_mode",
    )

    if _should_use_web_editor_for_fullpath(path, markdown_mode, text_mode):
        return RedirectResponse(_build_frontend_editor_redirect_url(path))

    if _should_use_external_markdown_app_for_fullpath(path, markdown_mode):
        target_url = resolve_file_app_url(path)
        await _open_markdown_external_app_for_fullpath(path)
        if target_url and target_url.startswith("obsidian://"):
            return _close_tab_response("Opened in Obsidian. Closing tab...", delay_ms=100)
        return _close_tab_response()

    if _get_embedded_editor_language(path) and text_mode == "vscode":
        await run_in_io_thread(open_in_vscode, OpenRequest(path=str(path)))
        return _close_tab_response()

    return None


@router.post("/open/smart", response_model=SmartOpenResponse)
async def open_smart(request: OpenRequest):
    """
    ファイル種類に応じてスマートに開く
    """
    converted_path = convert_storage_path(request.path)

    # 変換されたパスがURLの場合は直接ブラウザや外部アプリで開く (Pathの正規化エラー回避)
    if converted_path.startswith(("http://", "https://", "obsidian://")):
        try:
            if converted_path.startswith("http"):
                webbrowser.open(converted_path)
            else:
                # カスタムURI (obsidian 等)
                if platform.system() == 'Darwin':
                    if converted_path.startswith("obsidian://"):
                        subprocess.Popen(['open', '-a', 'Obsidian', converted_path])
                        _bring_obsidian_to_front()
                    else:
                        subprocess.Popen(['open', converted_path])
                elif platform.system() == 'Windows':
                    os.startfile(converted_path)
                    if converted_path.startswith("obsidian://"):
                        _bring_obsidian_to_front()
                else:
                    subprocess.Popen(['xdg-open', converted_path])
            
            return SmartOpenResponse(
                status="success",
                action="opened",
                message="リンクを開きました"
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"起動に失敗しました: {str(e)}")

    path = normalize_path(converted_path)

    def _open_smart_sync(t_path: Path, prefer_embedded: bool) -> SmartOpenResponse:
        if not t_path.exists():
            raise HTTPException(status_code=404, detail="ファイルが見つかりません")

        if t_path.is_dir():
            raise HTTPException(status_code=400, detail="ディレクトリは開けません")

        embedded_editor_language = _get_embedded_editor_language(t_path)

        if prefer_embedded and embedded_editor_language and not _is_excalidraw_markdown(t_path):
            try:
                with open(t_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                return SmartOpenResponse(
                    status="success",
                    action="open_modal",
                    message="エディタで開きます",
                    content=content,
                    editor_mode="markdown" if embedded_editor_language == "markdown" else "code",
                    language=embedded_editor_language,
                )
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"ファイル読み込み失敗: {str(e)}")

        # 共通ロジックでURL解決
        target_url = resolve_file_app_url(t_path)

        if target_url:
            try:
                if target_url.startswith("/"):
                    return SmartOpenResponse(
                        status="success",
                        action="open_url",
                        message="ブラウザで開きます",
                        url=target_url,
                    )

                # http/https は webbrowser で開く
                if target_url.startswith("http"):
                    webbrowser.open(target_url)
                else:
                    # obsidian:// 等のカスタムURI
                    if platform.system() == 'Darwin':
                        if target_url.startswith("obsidian://"):
                            subprocess.Popen(['open', '-a', 'Obsidian', target_url])
                            _bring_obsidian_to_front()
                        else:
                            subprocess.Popen(['open', target_url])
                    elif platform.system() == 'Windows':
                        os.startfile(target_url)
                        if target_url.startswith("obsidian://"):
                            _bring_obsidian_to_front()
                    else:
                        subprocess.Popen(['xdg-open', target_url])

                return SmartOpenResponse(
                    status="success",
                    action="opened",
                    message="専用アプリケーションで開きました"
                )
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"起動に失敗しました: {str(e)}")

        # --- 内蔵エディタ対象ファイル ---
        if embedded_editor_language:
            try:
                with open(t_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                return SmartOpenResponse(
                    status="success",
                    action="open_modal",
                    message="エディタで開きます",
                    content=content,
                    editor_mode="markdown" if embedded_editor_language == "markdown" else "code",
                    language=embedded_editor_language,
                )
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"ファイル読み込み失敗: {str(e)}")

        # --- その他 → OSデフォルトアプリ ---
        try:
            if platform.system() == "Windows":
                os.startfile(str(t_path))
            elif platform.system() == "Darwin":
                subprocess.Popen(["open", str(t_path)])
            else:
                subprocess.Popen(["xdg-open", str(t_path)])
            return SmartOpenResponse(
                status="success",
                action="opened",
                message="ファイルを開きました"
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"ファイルを開けませんでした: {str(e)}")

    return await run_with_timeout(_open_smart_sync, path, request.prefer_embedded)


@router.post("/open/antigravity")
def open_in_antigravity(request: OpenRequest):
    """
    指定されたパスをAntigravityで開く
    """
    path = normalize_path(request.path)
    
    if platform.system() == 'Darwin':
        # 起動可能なアプリケーションパッケージ（.app）の候補パス
        candidates = [
            '/Applications/Antigravity IDE.app',
            '/Applications/Antigravity.app'
        ]
        antigravity_path = None
        for candidate in candidates:
            if os.path.exists(candidate):
                antigravity_path = candidate
                break
    else:
        raise HTTPException(status_code=501, detail="AntigravityはmacOSでのみサポートされています")

    # ファイル/フォルダが存在するか確認
    target_path = path if path.exists() else path.parent

    if not antigravity_path:
        raise HTTPException(status_code=404, detail="Antigravityが見つかりません")

    try:
        subprocess.Popen(['open', '-a', antigravity_path, str(target_path)])
        return {"status": "success", "message": "Antigravityで開きました"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Antigravityの起動に失敗しました: {str(e)}")


@router.post("/open/jupyter")
def open_in_jupyter(request: OpenRequest):
    """
    指定されたパスをJupyterで開く
    """
    path = normalize_path(request.path)
    
    # JupyterのルートBase URL (環境に合わせて調整)
    # /lab/tree 形式でJupyterLabを開く
    JUPYTER_BASE_URL = "http://localhost:8888/lab/tree"
    
    # BASE_DIRからの相対パスを取得
    try:
        relative_path = path.relative_to(settings.base_dir)
    except ValueError:
        # BASE_DIR外の場合はエラーにするか、絶対パスで試みる（Jupyterの起動構成による）
        # ここではBASE_DIR以下のみサポート
        raise HTTPException(status_code=400, detail="Jupyterのルートディレクトリ外のファイルです")

    # URLエンコード
    # Note: jupyterはパス区切りをスラッシュにする必要がある
    url_path = urllib.parse.quote(str(relative_path).replace('\\', '/'))
    target_url = f"{JUPYTER_BASE_URL}/{url_path}"

    try:
        webbrowser.open(target_url)
        return {"status": "success", "message": f"Jupyterを開きました: {target_url}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Jupyterの起動に失敗しました: {str(e)}")


@router.post("/open/excalidraw")
def open_in_excalidraw(request: OpenRequest):
    """
    指定されたパスをExcalidraw (Port 3001) で開く
    """
    path = normalize_path(request.path)
    
    EXCALIDRAW_BASE_URL = "http://localhost:3001"
    
    # Excalidrawアプリ（ローカルホスト3001）がどうパスを受け取るかによるが、
    # 一般的には ?file=... 形式か、あるいはAPI経由
    # file_viewer の実装（claude.md記述）によると "Port 3001のExcalidrawエディタで開く"機能がある
    # ここではシンプルにローカルパスを渡すクエリパラメータ形式と仮定
    # 実装例: http://localhost:3001/?file=/absolute/path/to/file.excalidraw
    
    encoded_path = urllib.parse.quote(str(path))
    target_url = f"{EXCALIDRAW_BASE_URL}/?filepath={encoded_path}"

    try:
        webbrowser.open(target_url)
        return {"status": "success", "message": "Excalidrawを開きました"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Excalidrawの起動に失敗しました: {str(e)}")


@router.post("/open/obsidian")
def open_in_obsidian(request: OpenRequest):
    """
    パスから Vault 名とファイルパスを特定し、Obsidian URI で開く
    パスに「obsidian」を含むディレクトリがある必要がある
    """
    file_path = request.path
    if not file_path:
        raise HTTPException(status_code=400, detail="パスが指定されていません")
    
    try:
        # パスを正規化
        normalized_path = str(normalize_path(file_path)).replace('\\', '/')
        
        # パスの中から「obsidian」を含むディレクトリを探す
        parts = normalized_path.split('/')
        obsidian_idx = -1
        for i, part in enumerate(parts):
            if 'obsidian' in part.lower():
                obsidian_idx = i
                break
        
        if obsidian_idx == -1:
            raise HTTPException(status_code=400, detail='パスに「obsidian」を含むディレクトリが見つかりません')
        
        vault_name = parts[obsidian_idx]
        # Vault以降のパスを特定
        relative_file_path = '/'.join(parts[obsidian_idx+1:])
        
        # フォルダの場合は末尾に / を付けるとObsidianでフォルダが開く
        target_path = Path(file_path)
        if target_path.is_dir() and relative_file_path and not relative_file_path.endswith('/'):
            relative_file_path += '/'
        
        # Obsidian URI を構築
        encoded_file = urllib.parse.quote(relative_file_path)
        encoded_vault = urllib.parse.quote(vault_name)
        obsidian_uri = f"obsidian://open?vault={encoded_vault}&file={encoded_file}"
        
        if platform.system() == 'Darwin':  # macOS
            subprocess.Popen(['open', '-a', 'Obsidian', obsidian_uri])
            _bring_obsidian_to_front()
        elif platform.system() == 'Windows':
            os.startfile(obsidian_uri)
            _bring_obsidian_to_front()
        else:
            raise HTTPException(status_code=501, detail="サポートされていないOSです")
        
        return {"status": "success", "message": "Obsidianで開きました", "uri": obsidian_uri}
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Obsidianの起動に失敗しました: {str(e)}")


@router.get("/fullpath")
async def fullpath(
    request: Request,
    path: str = Query(..., description="開くファイルのフルパス"),
):
    """
    フルパスでファイルを開く（file_viewer互換）
    例: http://localhost:8001/api/fullpath?path=/path/to/file.pdf
    """
    if not path:
        raise HTTPException(status_code=400, detail="パスが指定されていません")
    
    # URLデコード
    decoded_path = urllib.parse.unquote(path)
    
    # ネットワークパス（UNC）の処理
    if decoded_path.startswith('//'):
        decoded_path = decoded_path.replace('/', '\\')  # //server/share → \\server\share

    normalized_path = normalize_path(decoded_path)

    if await run_with_timeout(normalized_path.is_dir):
        return RedirectResponse(_build_frontend_directory_redirect_url(normalized_path))

    if _prefers_html_response(request):
        preferred_response = await _handle_fullpath_html_preferences(request, normalized_path)
        if preferred_response is not None:
            return preferred_response
    
    # スマートオープンを呼び出し
    open_request = OpenRequest(path=decoded_path)
    result = await open_smart(open_request)

    if not _prefers_html_response(request):
        return result

    if result.action == "open_url":
        if not result.url:
            raise HTTPException(status_code=500, detail="開くURLを解決できませんでした")
        return RedirectResponse(result.url)

    if result.action == "open_modal":
        fallback_result = await open_path(open_request)
        if not fallback_result.get("success", False):
            raise HTTPException(
                status_code=500,
                detail=fallback_result.get("error", "ファイルを開けませんでした"),
            )

    return _close_tab_response()


@router.post("/open-path")
async def open_path(request: OpenRequest):
    """
    パスを開く（file_viewer互換）
    ファイルの場合はファイルを、フォルダの場合はフォルダを開く
    """
    path = normalize_path(request.path)

    def _open_path_sync(t_path: Path) -> dict:
        if not t_path.exists():
            return {"success": False, "error": f"パスが見つかりません: {request.path}"}

        try:
            if platform.system() == "Windows":
                if t_path.is_dir():
                    subprocess.Popen(['explorer', str(t_path).replace('/', '\\')])
                else:
                    os.startfile(str(t_path))
            elif platform.system() == "Darwin":
                subprocess.Popen(["open", str(t_path)])
            else:
                subprocess.Popen(["xdg-open", str(t_path)])
            return {"success": True, "message": f"開きました: {t_path}"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    return await run_with_timeout(_open_path_sync, path)


@router.get("/open-path")
async def open_path_get(path: str = Query(..., description="開くファイルのパス")):
    """
    パスを開く（GET版）
    単純なリンクから呼び出せるように追加
    - フォルダの場合: 本アプリのフロントエンドにリダイレクトして開く
    - ファイルの場合: サーバー側で開き、開いたタブを自動的に閉じるHTMLを返す
    """
    path_obj = normalize_path(path)

    if await run_with_timeout(path_obj.is_dir):
        # フォルダの場合はフロントエンドを開く
        # ポート番号（5173）を固定せず、相対パスでリダイレクトすることで現在のホスト・ポートを維持する
        encoded_path = urllib.parse.quote(str(path_obj))
        return RedirectResponse(f"/?path={encoded_path}")

    
    # 共通ロジックでURL解決
    target_url = await run_with_timeout(resolve_file_app_url, path_obj)
    if target_url:
        return RedirectResponse(target_url)

    # ファイルの場合は既存処理（OSデフォルトアプリで開く）
    request = OpenRequest(path=path)
    await open_path(request)
    
    # ブラウザのタブを閉じるためのHTMLを返す
    return _close_tab_response()


@router.post("/open-folder")
def open_folder(request: OpenRequest):
    """
    フォルダを開く（file_viewer互換）
    ファイルパスが渡された場合は親フォルダを開く
    """
    path = normalize_path(request.path)
    
    # ファイルの場合は親フォルダを開く
    if path.is_file():
        path = path.parent
    
    if not path.exists():
        return {"success": False, "error": f"フォルダが見つかりません: {request.path}"}
    
    try:
        if platform.system() == "Windows":
            process = subprocess.Popen(['explorer', str(path).replace('/', '\\')])
            _bring_explorer_to_front(process.pid, path)
        elif platform.system() == "Darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])
        return {"success": True, "message": f"フォルダを開きました: {path}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.post("/open/trash")
def open_trash():
    """
    ゴミ箱を開く
    """
    try:
        if platform.system() == "Windows":
            # Windows: shell:RecycleBinFolder
            subprocess.Popen(['explorer', 'shell:RecycleBinFolder'])
        elif platform.system() == "Darwin":
            # macOS: ~/.Trash
            trash_path = os.path.expanduser("~/.Trash")
            subprocess.Popen(["open", trash_path])
        else:
            # Linux: xdg-open trash:///
            subprocess.Popen(["xdg-open", "trash:///"])
        return {"success": True, "message": "ゴミ箱を開きました"}
    except Exception as e:
        return {"success": False, "error": str(e)}
