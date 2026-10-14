"""
Gantt画面を開いているブラウザを前面に出す処理（ベストエフォート）。

open-input API（ランチャー等からのタスク入力画面呼び出し）で使う。
- macOS: AppleScript で該当URLのタブを探してアクティブにし、なければURLを開く。
- Windows: フロントエンドが生きていれば既存のブラウザウィンドウを前面に出し（新規タブを増やさない）、
  生きていなければURLを開く。
- Linux: URLを開く。
各関数は (成功したか, エラーメッセージ) を返し、例外は外に出さない。
"""
import os
import subprocess
import sys
import webbrowser

ACTIVATION_TIMEOUT_SECONDS = 2

_ACTIVATE_TAB_APPLESCRIPT = """
on run argv
  set targetUrl to item 1 of argv
  set browserNames to {"Google Chrome", "Microsoft Edge", "Safari"}
  repeat with browserName in browserNames
    try
      if browserName as text is "Safari" then
        tell application "Safari"
          repeat with w from 1 to count of windows
            repeat with t from 1 to count of tabs of window w
              if URL of tab t of window w starts with targetUrl then
                set current tab of window w to tab t of window w
                set index of window w to 1
                activate
                return "activated"
              end if
            end repeat
          end repeat
        end tell
      else
        tell application (browserName as text)
          repeat with w from 1 to count of windows
            repeat with t from 1 to count of tabs of window w
              if URL of tab t of window w starts with targetUrl then
                set active tab index of window w to t
                set index of window w to 1
                activate
                return "activated"
              end if
            end repeat
          end repeat
        end tell
      end if
    end try
  end repeat
  return "not_found"
end run
"""

_ACTIVATE_WINDOW_APPLESCRIPT = """
set browserNames to {"Google Chrome", "Safari", "Microsoft Edge", "Firefox"}
tell application "System Events"
  repeat with browserName in browserNames
    if exists process (browserName as text) then
      set frontmost of process (browserName as text) to true
      return "activated"
    end if
  end repeat
end tell
return "not_found"
"""

_ACTIVATE_WINDOW_POWERSHELL = r"""
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
"@
$names = @("chrome", "msedge", "firefox")
foreach ($name in $names) {
  $process = Get-Process -Name $name -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
  if ($process) {
    [Win32]::ShowWindowAsync($process.MainWindowHandle, 9) | Out-Null
    [Win32]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
    Write-Output "activated"
    exit 0
  }
}
Write-Output "not_found"
exit 0
"""


def _run_activation_command(command: list[str], label: str) -> tuple[bool, str | None]:
    """コマンドを実行し、標準出力が "activated" なら成功とみなす。"""
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=ACTIVATION_TIMEOUT_SECONDS,
        )
    except Exception as exc:
        return False, f"{label} failed: {exc}"

    if result.returncode != 0:
        return False, (result.stderr or f"{label} returned non-zero status").strip()

    return result.stdout.strip() == "activated", None


def try_activate_existing_browser_tab(frontend_url: str) -> tuple[bool, str | None]:
    """Best-effort activation of an already-open browser tab on macOS."""
    if sys.platform != "darwin":
        return False, None
    return _run_activation_command(
        ["osascript", "-e", _ACTIVATE_TAB_APPLESCRIPT, frontend_url],
        "existing tab activation",
    )


def try_activate_existing_browser_window() -> tuple[bool, str | None]:
    """Best-effort activation of an existing browser window."""
    if sys.platform == "darwin":
        return _run_activation_command(
            ["osascript", "-e", _ACTIVATE_WINDOW_APPLESCRIPT],
            "existing browser window activation",
        )
    if sys.platform.startswith("win"):
        return _run_activation_command(
            [
                "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-Command", _ACTIVATE_WINDOW_POWERSHELL,
            ],
            "existing browser window activation",
        )
    return False, None


def try_show_gantt_window(frontend_url: str, frontend_is_alive: bool) -> tuple[bool, str | None]:
    """
    Open the Gantt URL and best-effort activate a local browser window.

    frontend_is_alive: 直近にフロントエンドからのハートビートを受け取っているか。
    """
    errors: list[str] = []

    activated_existing_tab, activation_error = try_activate_existing_browser_tab(frontend_url)
    if activated_existing_tab:
        return True, None
    if activation_error:
        errors.append(activation_error)

    if sys.platform.startswith("win") and frontend_is_alive:
        activated_existing_window, window_error = try_activate_existing_browser_window()
        if activated_existing_window:
            return True, None
        errors.append(
            window_error
            or "recent frontend heartbeat found, but no browser window was activated"
        )
        return False, "; ".join(errors)

    try:
        opened = webbrowser.open(frontend_url, new=0, autoraise=True)
        if not opened:
            errors.append("webbrowser.open returned false")
    except Exception as exc:
        errors.append(f"webbrowser.open failed: {exc}")

    try:
        if sys.platform.startswith("win"):
            os.startfile(frontend_url)  # type: ignore[attr-defined]
        elif sys.platform.startswith("linux"):
            subprocess.run(
                ["xdg-open", frontend_url],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=ACTIVATION_TIMEOUT_SECONDS,
            )
    except Exception as exc:
        errors.append(f"window activation failed: {exc}")

    return len(errors) == 0, "; ".join(errors) if errors else None
