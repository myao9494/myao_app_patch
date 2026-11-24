"""Windows固有分岐とstart_servers.batの回帰テスト。

OS ごとの分岐（既定アプリ・Explorer・コマンド実行）は backend/system_open.py にあり、
API（backend/main.py）はそれを呼ぶ。sys.platform を差し替えて Windows の経路を確かめる。
"""

from pathlib import Path

from backend import main, system_open


def test_windows_system_opener_uses_startfile(monkeypatch):
    opened = []
    monkeypatch.setattr(system_open.sys, "platform", "win32")
    monkeypatch.setattr(system_open.os, "startfile", opened.append, raising=False)

    system_open.launch_with_system(r"C:\Company Files\drawing.excalidraw")

    assert opened == [r"C:\Company Files\drawing.excalidraw"]


def test_windows_editor_fallback_uses_system_opener(monkeypatch, tmp_path):
    opened = []
    monkeypatch.setattr(system_open.sys, "platform", "win32")
    monkeypatch.setattr(system_open.shutil, "which", lambda _name: None)
    monkeypatch.setattr(system_open, "launch_with_system", opened.append)

    result = main.open_in_editor(main.OpenEditorRequest(path=str(tmp_path)))

    assert result.success is True
    assert result.fallbackUsed is True
    assert opened == [str(tmp_path.resolve())]


def test_windows_open_folder_uses_explorer(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(system_open.sys, "platform", "win32")
    monkeypatch.setattr(system_open.subprocess, "Popen", lambda args, **kwargs: calls.append((args, kwargs)))

    result = main.open_folder(main.OpenFolderRequest(path=str(tmp_path)))

    assert result.success is True
    assert calls == [(["explorer", str(tmp_path.resolve())], {})]


def test_windows_command_normalization_and_spawn(monkeypatch):
    calls = []

    class FakeProcess:
        pid = 1234

    def fake_popen(command, **kwargs):
        calls.append((command, kwargs))
        return FakeProcess()

    monkeypatch.setattr(system_open.sys, "platform", "win32")
    monkeypatch.setattr(system_open.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(system_open.subprocess, "CREATE_NEW_CONSOLE", 0x10, raising=False)

    normalized = system_open.normalize_command_for_platform("cmd C:￥Company￥tool.bat")
    process = system_open.spawn_system_command(normalized, cwd=r"C:\Company Files")

    assert normalized == r"cmd C:\Company\tool.bat"
    assert process.pid == 1234
    assert calls == [
        (
            normalized,
            {
                "shell": True,
                "cwd": r"C:\Company Files",
                "creationflags": 0x10,
            },
        )
    ]


def test_windows_startup_batch_contract():
    script = (Path(__file__).parents[1] / "start_servers.bat").read_text(
        encoding="utf-8"
    )

    # ビルド失敗時は既存サーバーを止めない。
    assert script.index("call npm run build") < script.index("taskkill /PID")

    # backend\.venv の Python だけで起動する。無ければ setup_windows.bat で作ってから起動し、
    # ほかの venv やシステムの python には頼らない。空白を含む絶対パスも引用して起動する。
    assert r'set "PYTHON_EXE=%ROOT_DIR%\backend\.venv\Scripts\python.exe"' in script
    assert r'call "%ROOT_DIR%\setup_windows.bat" /nopause' in script
    for removed in (
        r"backend\venv\Scripts\python.exe",
        r"%ROOT_DIR%\.venv\Scripts\python.exe",
        r"%ROOT_DIR%\venv\Scripts\python.exe",
        'set "PYTHON_EXE=python"',
    ):
        assert removed not in script
    assert (
        '"%PYTHON_EXE%" -c "import fastapi, uvicorn, lzstring, multipart"'
        in script
    )
    assert 'start "Excalidraw Server" /D "%ROOT_DIR%\\backend" "%PYTHON_EXE%"' in script

    # Windows標準機能だけで待受解放とHTTP readinessを確認する。
    assert "netstat -aon" in script
    assert "taskkill /PID %%P /T /F" in script
    assert "powershell.exe -NoProfile -NonInteractive" in script
    assert "Invoke-WebRequest -UseBasicParsing" in script
    assert "curl.exe" not in script

    # 起動完了表示はHTTP確認ラベルより後に置く。
    assert script.index(":server_ready") < script.index("=== サーバー起動完了 ===")

    labels = {
        line.strip()[1:].lower()
        for line in script.splitlines()
        if line.strip().startswith(":")
    }
    goto_targets = {
        line.strip().split()[-1].lower()
        for line in script.splitlines()
        if "goto " in line.lower()
    }
    assert goto_targets <= labels
