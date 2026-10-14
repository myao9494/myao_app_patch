"""Windows固有分岐とstart_servers.batの回帰テスト。"""

import asyncio
from pathlib import Path

from backend import main


def test_windows_system_opener_uses_startfile(monkeypatch):
    opened = []
    monkeypatch.setattr(main.sys, "platform", "win32")
    monkeypatch.setattr(main.os, "startfile", opened.append, raising=False)

    main._launch_with_system(r"C:\Company Files\drawing.excalidraw")

    assert opened == [r"C:\Company Files\drawing.excalidraw"]


def test_windows_editor_fallback_uses_system_opener(monkeypatch, tmp_path):
    opened = []
    monkeypatch.setattr(main.sys, "platform", "win32")
    monkeypatch.setattr(main.shutil, "which", lambda _name: None)
    monkeypatch.setattr(main, "_launch_with_system", opened.append)

    result = asyncio.run(
        main.open_in_editor(main.OpenEditorRequest(path=str(tmp_path)))
    )

    assert result.success is True
    assert result.fallbackUsed is True
    assert opened == [str(tmp_path.resolve())]


def test_windows_open_folder_uses_explorer(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(main.sys, "platform", "win32")
    monkeypatch.setattr(main.subprocess, "Popen", lambda args, **kwargs: calls.append((args, kwargs)))

    result = asyncio.run(main.open_folder(main.OpenFolderRequest(path=str(tmp_path))))

    assert result.success is True
    assert calls == [(["explorer", str(tmp_path.resolve())], {})]


def test_windows_command_normalization_and_spawn(monkeypatch):
    calls = []

    class FakeProcess:
        pid = 1234

    def fake_popen(command, **kwargs):
        calls.append((command, kwargs))
        return FakeProcess()

    monkeypatch.setattr(main.sys, "platform", "win32")
    monkeypatch.setattr(main.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(main.subprocess, "CREATE_NEW_CONSOLE", 0x10, raising=False)

    normalized = main._normalize_command_for_platform("cmd C:￥Company￥tool.bat")
    process = main._spawn_system_command(normalized, cwd=r"C:\Company Files")

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

    # よくある仮想環境を網羅し、空白を含む絶対パスも引用して起動する。
    for candidate in (
        r"backend\.venv\Scripts\python.exe",
        r"backend\venv\Scripts\python.exe",
        r"\.venv\Scripts\python.exe",
        r"\venv\Scripts\python.exe",
    ):
        assert candidate in script
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
