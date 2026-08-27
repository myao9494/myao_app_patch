# GET /api/open-path エンドポイントのテスト
# フォルダを指定した場合のリダイレクト先の動作を確認する

import pytest
from pathlib import Path
import urllib.parse


def _query_value(location: str, key: str) -> str:
    """リダイレクトURLのクエリ値を取り出す"""
    values = urllib.parse.parse_qs(urllib.parse.urlparse(location).query)[key]
    return values[0]


def _assert_redirect_path(location: str, key: str, expected: Path) -> None:
    """Windowsの8.3短縮パス差異を吸収してリダイレクト先パスを比較する"""
    assert Path(_query_value(location, key)).resolve() == expected.resolve()


class TestOpenPath:
    """GET /api/open-path エンドポイントのテスト"""

    def test_open_path_directory_redirects_to_frontend(self, client, temp_dir, monkeypatch):
        """ディレクトリを指定した場合、フロントエンドにリダイレクトされる"""
        from app import config
        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        path = str(temp_dir / "folder1")
        
        # TestClientはデフォルトでリダイレクトを追跡するが、
        # ここではリダイレクト先そのものを確認したいため follow_redirects=False にする
        response = client.get("/api/open-path", params={"path": path}, follow_redirects=False)

        assert response.status_code == 307
        location = response.headers["location"]
        
        # 将来的にホスト名に依存しない形式か、リクエスト時のホストを使用するようにしたい
        # ここでは相対パスでのリダイレクトを期待するように修正する
        assert location.startswith("/?path=") or location.startswith("./?path=")
        _assert_redirect_path(location, "path", temp_dir / "folder1")


    def test_open_path_file_returns_html(self, client, temp_dir, monkeypatch):
        """ファイルを指定した場合、OSで開き、タブを閉じるためのHTMLを返す"""
        from app import config
        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        path = str(temp_dir / "file1.txt")
        
        # open_path (subprocess.Popen) をモック化する必要がある
        # しかしまずはレスポンスがHTMLであることを確認
        response = client.get("/api/open-path", params={"path": path})

        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "window.close()" in response.text


class TestFullPath:
    """GET /api/fullpath エンドポイントのテスト"""

    def test_fullpath_directory_redirects_to_frontend(self, client, temp_dir, monkeypatch):
        """フォルダを指定した場合、従来リンクでもWebアプリへリダイレクトする"""
        from app import config

        target_dir = temp_dir / "folder1"
        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        response = client.get(
            "/api/fullpath",
            params={"path": str(target_dir)},
            follow_redirects=False,
        )

        assert response.status_code == 307
        location = response.headers["location"]
        assert location.startswith("/?path=")
        _assert_redirect_path(location, "path", target_dir)

    def test_fullpath_obsidian_file_returns_html_instead_of_json(self, client, temp_dir, monkeypatch):
        """Obsidian対象ファイルでは専用アプリを起動しつつ、JSONではなくタブを閉じるHTMLを返す"""
        from app import config
        from app.routers import files

        obsidian_dir = temp_dir / "obsidian-vault" / "2026" / "03" / "14"
        obsidian_dir.mkdir(parents=True)
        note_path = obsidian_dir / "note.md"
        note_path.write_text("# note\n", encoding="utf-8")

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        preferences_path = temp_dir / "settings.json"
        preferences_path.write_text(
            '{"textFileOpenMode": "web", "markdownOpenMode": "external"}\n',
            encoding="utf-8",
        )
        monkeypatch.setattr(config.settings, "_preferences_file_override", preferences_path)
        monkeypatch.setattr(files.platform, "system", lambda: "Darwin")

        popen_calls = []
        monkeypatch.setattr(files.subprocess, "Popen", lambda args: popen_calls.append(args))

        response = client.get(
            "/api/fullpath",
            params={"path": str(note_path)},
            headers={"accept": "text/html"},
        )

        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "window.close()" in response.text
        assert len(popen_calls) == 2
        assert popen_calls[0][:3] == ["open", "-a", "Obsidian"]
        assert popen_calls[0][3].startswith("obsidian://open?vault=obsidian-vault&file=")
        assert popen_calls[1][:2] == ["/bin/sh", "-c"]
        assert "tell application \"Obsidian\" to activate" in popen_calls[1][2]

    def test_fullpath_pdf_redirects_to_viewer(self, client, temp_dir, monkeypatch):
        """PDFではブラウザ表示用URLへリダイレクトする"""
        from app import config

        pdf_path = temp_dir / "document.pdf"
        pdf_path.write_bytes(b"%PDF-1.4\n%test\n")

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        response = client.get(
            "/api/fullpath",
            params={"path": str(pdf_path)},
            headers={"accept": "text/html"},
            follow_redirects=False,
        )

        assert response.status_code == 307
        assert response.headers["location"].startswith("/api/view-pdf?path=")

    def test_fullpath_plain_markdown_external_mode_uses_vscode_and_returns_html(self, client, temp_dir, monkeypatch):
        """通常Markdownの外部起動ではVS Codeを開きつつタブを閉じるHTMLを返す"""
        from app import config
        from app.routers import files

        note_path = temp_dir / "note.md"
        note_path.write_text("# note\n", encoding="utf-8")

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        preferences_path = temp_dir / "settings.json"
        preferences_path.write_text(
            '{"textFileOpenMode": "web", "markdownOpenMode": "external"}\n',
            encoding="utf-8",
        )
        monkeypatch.setattr(config.settings, "_preferences_file_override", preferences_path)
        monkeypatch.setattr(files.platform, "system", lambda: "Darwin")

        popen_calls = []
        monkeypatch.setattr(files.subprocess, "Popen", lambda args: popen_calls.append(args))

        response = client.get(
            "/api/fullpath",
            params={"path": str(note_path)},
            headers={"accept": "text/html"},
        )

        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "window.close()" in response.text
        assert len(popen_calls) == 1
        assert "code" in popen_calls[0][0].lower()
        assert Path(popen_calls[0][1]).resolve() == note_path.resolve()

    def test_fullpath_markdown_web_mode_redirects_to_frontend_editor(self, client, temp_dir, monkeypatch):
        """MarkdownのWeb設定時はフロントエンドへリダイレクトして内蔵エディタで開く"""
        from app import config
        from app.routers import files

        note_path = temp_dir / "note.md"
        note_path.write_text("# note\n", encoding="utf-8")

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        popen_calls = []
        monkeypatch.setattr(files.subprocess, "Popen", lambda args: popen_calls.append(args))

        response = client.get(
            "/api/fullpath",
            params={"path": str(note_path), "markdown_mode": "web"},
            headers={"accept": "text/html"},
            follow_redirects=False,
        )

        assert response.status_code == 307
        location = response.headers["location"]
        assert location.startswith("/?path=")
        _assert_redirect_path(location, "path", note_path.parent)
        _assert_redirect_path(location, "open_file", note_path)
        assert "open_file=" in location
        assert popen_calls == []

    def test_fullpath_markdown_web_config_redirects_to_frontend_editor(self, client, temp_dir, monkeypatch):
        """Markdownモードを設定ファイルで受け取った場合もWebエディタへリダイレクトする"""
        from app import config
        from app.routers import files

        note_path = temp_dir / "obsidian-vault" / "70_gantt_csv" / "gantt_diff_summary.md"
        note_path.parent.mkdir(parents=True)
        note_path.write_text("# summary\n", encoding="utf-8")

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        preferences_path = temp_dir / "settings.json"
        preferences_path.write_text(
            '{"textFileOpenMode": "web", "markdownOpenMode": "web"}\n',
            encoding="utf-8",
        )
        monkeypatch.setattr(config.settings, "_preferences_file_override", preferences_path)

        popen_calls = []
        monkeypatch.setattr(files.subprocess, "Popen", lambda args: popen_calls.append(args))

        response = client.get(
            "/api/fullpath",
            params={"path": str(note_path)},
            headers={"accept": "text/html"},
            follow_redirects=False,
        )

        assert response.status_code == 307
        location = response.headers["location"]
        assert location.startswith("/?path=")
        _assert_redirect_path(location, "path", note_path.parent)
        _assert_redirect_path(location, "open_file", note_path)
        assert "open_file=" in location
        assert popen_calls == []

    def test_fullpath_markdown_obsidian_or_web_mode_uses_obsidian_inside_vault(self, client, temp_dir, monkeypatch):
        """obsidian_or_web設定時、Obsidian vault内ならObsidianを開く"""
        from app import config
        from app.routers import files

        vault_dir = temp_dir / "obsidian-vault" / "notes"
        vault_dir.mkdir(parents=True)
        note_path = vault_dir / "idea.md"
        note_path.write_text("# idea\n", encoding="utf-8")

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        monkeypatch.setattr(files.platform, "system", lambda: "Darwin")

        popen_calls = []
        monkeypatch.setattr(files.subprocess, "Popen", lambda args: popen_calls.append(args))

        response = client.get(
            "/api/fullpath",
            params={"path": str(note_path), "markdown_mode": "obsidian_or_web"},
            headers={"accept": "text/html"},
        )

        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "window.close()" in response.text
        assert len(popen_calls) >= 1
        assert "obsidian" in popen_calls[0][2].lower()

    def test_fullpath_markdown_obsidian_or_web_mode_redirects_to_web_editor_outside_obsidian(self, client, temp_dir, monkeypatch):
        """obsidian_or_web設定時、Obsidian vault外ならフロントエンドのWebエディタへリダイレクトする"""
        from app import config
        from app.routers import files

        note_path = temp_dir / "other_docs" / "memo.md"
        note_path.parent.mkdir(parents=True)
        note_path.write_text("# memo\n", encoding="utf-8")

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        popen_calls = []
        monkeypatch.setattr(files.subprocess, "Popen", lambda args: popen_calls.append(args))

        response = client.get(
            "/api/fullpath",
            params={"path": str(note_path), "markdown_mode": "obsidian_or_web"},
            headers={"accept": "text/html"},
            follow_redirects=False,
        )

        assert response.status_code == 307
        location = response.headers["location"]
        assert location.startswith("/?path=")
        _assert_redirect_path(location, "path", note_path.parent)
        _assert_redirect_path(location, "open_file", note_path)
        assert "open_file=" in location
        assert popen_calls == []

    def test_fullpath_text_web_mode_redirects_to_frontend_editor(self, client, temp_dir, monkeypatch):
        """テキストのWeb設定時はフロントエンドへリダイレクトして内蔵エディタで開く"""
        from app import config
        from app.routers import files

        text_path = temp_dir / "memo.txt"
        text_path.write_text("hello\n", encoding="utf-8")

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        popen_calls = []
        monkeypatch.setattr(files.subprocess, "Popen", lambda args: popen_calls.append(args))

        response = client.get(
            "/api/fullpath",
            params={"path": str(text_path), "text_mode": "web"},
            headers={"accept": "text/html"},
            follow_redirects=False,
        )

        assert response.status_code == 307
        location = response.headers["location"]
        assert location.startswith("/?path=")
        _assert_redirect_path(location, "path", text_path.parent)
        _assert_redirect_path(location, "open_file", text_path)
        assert "open_file=" in location
        assert popen_calls == []

    def test_fullpath_excalidraw_markdown_ignores_markdown_web_mode(self, client, temp_dir, monkeypatch):
        """excalidraw.md はMarkdown設定の対象外でExcalidrawへ流す"""
        from app import config
        from app.routers import files

        excalidraw_path = temp_dir / "diagram.excalidraw.md"
        excalidraw_path.write_text("# excalidraw\n", encoding="utf-8")

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        browser_calls = []
        monkeypatch.setattr(files.webbrowser, "open", lambda url: browser_calls.append(url))

        response = client.get(
            "/api/fullpath",
            params={"path": str(excalidraw_path), "markdown_mode": "web"},
            headers={"accept": "text/html"},
        )

        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "window.close()" in response.text
        assert len(browser_calls) == 1
        assert browser_calls[0].startswith("http://localhost:3001/?filepath=")

    def test_fullpath_markdown_external_mode_uses_vscode_outside_obsidian(self, client, temp_dir, monkeypatch):
        """Markdownの外部起動ではObsidian外のファイルをVS Codeで開く"""
        from app import config
        from app.routers import files

        note_path = temp_dir / "note.md"
        note_path.write_text("# note\n", encoding="utf-8")

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        vscode_calls = []

        async def fake_open_in_vscode(request):
            vscode_calls.append(request.path)
            return {"status": "success"}

        monkeypatch.setattr(files, "open_in_vscode", fake_open_in_vscode)

        response = client.get(
            "/api/fullpath",
            params={"path": str(note_path), "markdown_mode": "external"},
            headers={"accept": "text/html"},
        )

        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "window.close()" in response.text
        assert [Path(call).resolve() for call in vscode_calls] == [note_path.resolve()]

    def test_fullpath_markdown_external_mode_uses_obsidian_inside_vault(self, client, temp_dir, monkeypatch):
        """Markdownの外部起動ではObsidian配下のファイルをObsidianで開く"""
        from app import config
        from app.routers import files

        obsidian_dir = temp_dir / "obsidian-vault" / "2026" / "03" / "14"
        obsidian_dir.mkdir(parents=True)
        note_path = obsidian_dir / "note.md"
        note_path.write_text("# note\n", encoding="utf-8")

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        monkeypatch.setattr(files.platform, "system", lambda: "Darwin")

        popen_calls = []
        monkeypatch.setattr(files.subprocess, "Popen", lambda args: popen_calls.append(args))

        response = client.get(
            "/api/fullpath",
            params={"path": str(note_path), "markdown_mode": "external"},
            headers={"accept": "text/html"},
        )

        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "window.close()" in response.text
        assert len(popen_calls) == 2
        assert popen_calls[0][:3] == ["open", "-a", "Obsidian"]
        assert popen_calls[0][3].startswith("obsidian://open?vault=obsidian-vault&file=")
        assert popen_calls[1][:2] == ["/bin/sh", "-c"]
        assert "tell application \"Obsidian\" to activate" in popen_calls[1][2]

    def test_fullpath_api_clients_still_receive_json(self, client, temp_dir, monkeypatch):
        """APIクライアントでは従来どおりJSONレスポンスを返す"""
        from app import config

        note_path = temp_dir / "note.md"
        note_path.write_text("# note\n", encoding="utf-8")

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        response = client.get(
            "/api/fullpath",
            params={"path": str(note_path)},
            headers={"accept": "application/json"},
        )

        assert response.status_code == 200
        assert "application/json" in response.headers["content-type"]
        assert response.json()["action"] == "open_modal"


class TestOpenObsidian:
    """Obsidian起動時のWindows固有挙動を確認するテスト"""

    def test_focus_window_keeps_obsidian_fullscreen_when_not_minimized(self, monkeypatch):
        """前面化時に非最小化ウィンドウへSW_RESTOREを送らず全画面状態を維持する"""
        from app.routers import files

        class DummyUser32:
            def __init__(self):
                self.calls = []

            def IsWindowVisible(self, hwnd):
                self.calls.append(("IsWindowVisible", hwnd))
                return True

            def IsIconic(self, hwnd):
                self.calls.append(("IsIconic", hwnd))
                return False

            def GetWindowThreadProcessId(self, hwnd, _):
                self.calls.append(("GetWindowThreadProcessId", hwnd))
                return 200

            def AttachThreadInput(self, current_thread_id, window_thread_id, attach):
                self.calls.append(("AttachThreadInput", current_thread_id, window_thread_id, attach))
                return True

            def ShowWindow(self, hwnd, flag):
                self.calls.append(("ShowWindow", hwnd, flag))
                return True

            def BringWindowToTop(self, hwnd):
                self.calls.append(("BringWindowToTop", hwnd))
                return True

            def SetForegroundWindow(self, hwnd):
                self.calls.append(("SetForegroundWindow", hwnd))
                return True

        class DummyKernel32:
            def GetCurrentThreadId(self):
                return 100

        user32 = DummyUser32()
        kernel32 = DummyKernel32()

        focused = files._focus_window_handle(user32, kernel32, hwnd=123, restore_minimized=True)

        assert focused is True
        assert ("ShowWindow", 123, 9) not in user32.calls
        assert ("BringWindowToTop", 123) in user32.calls
        assert ("SetForegroundWindow", 123) in user32.calls

    def test_focus_window_restores_minimized_obsidian_window(self, monkeypatch):
        """最小化済みウィンドウは前面化前に復元する"""
        from app.routers import files

        class DummyUser32:
            def __init__(self):
                self.calls = []

            def IsWindowVisible(self, hwnd):
                self.calls.append(("IsWindowVisible", hwnd))
                return True

            def IsIconic(self, hwnd):
                self.calls.append(("IsIconic", hwnd))
                return True

            def GetWindowThreadProcessId(self, hwnd, _):
                self.calls.append(("GetWindowThreadProcessId", hwnd))
                return 200

            def AttachThreadInput(self, current_thread_id, window_thread_id, attach):
                self.calls.append(("AttachThreadInput", current_thread_id, window_thread_id, attach))
                return True

            def ShowWindow(self, hwnd, flag):
                self.calls.append(("ShowWindow", hwnd, flag))
                return True

            def BringWindowToTop(self, hwnd):
                self.calls.append(("BringWindowToTop", hwnd))
                return True

            def SetForegroundWindow(self, hwnd):
                self.calls.append(("SetForegroundWindow", hwnd))
                return True

        class DummyKernel32:
            def GetCurrentThreadId(self):
                return 100

        user32 = DummyUser32()
        kernel32 = DummyKernel32()

        focused = files._focus_window_handle(user32, kernel32, hwnd=123, restore_minimized=True)

        assert focused is True
        assert ("ShowWindow", 123, 9) in user32.calls

    def test_open_smart_tries_to_bring_obsidian_to_front_on_windows(self, client, temp_dir, monkeypatch):
        """WindowsではObsidian URI起動後に前面化処理を試みる"""
        from app import config
        from app.routers import files

        note_dir = temp_dir / "obsidian-vault" / "2026" / "03" / "14"
        note_dir.mkdir(parents=True)
        note_path = note_dir / "note.md"
        note_path.write_text("# note\n", encoding="utf-8")

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        monkeypatch.setattr(files.platform, "system", lambda: "Windows")

        startfile_calls = []
        focus_calls = []

        monkeypatch.setattr(files.os, "startfile", lambda target: startfile_calls.append(target), raising=False)
        monkeypatch.setattr(files, "_bring_obsidian_to_front", lambda: focus_calls.append(True))

        response = client.post("/api/open/smart", json={"path": str(note_path)})

        assert response.status_code == 200
        assert len(startfile_calls) == 1
        assert startfile_calls[0].startswith("obsidian://open?vault=obsidian-vault&file=")
        assert focus_calls == [True]


class TestSmartOpenEditorFiles:
    """スマートオープン時の内蔵エディタ対象ファイル判定テスト"""

    def test_open_smart_prefers_embedded_editor_for_obsidian_markdown(self, client, temp_dir, monkeypatch):
        """prefer_embedded指定時はObsidian配下でもWebエディタ用レスポンスを返す"""
        from app import config
        from app.routers import files

        note_dir = temp_dir / "obsidian-vault" / "2026" / "03" / "14"
        note_dir.mkdir(parents=True)
        note_path = note_dir / "note.md"
        note_path.write_text("# note\n", encoding="utf-8")

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        popen_calls = []
        monkeypatch.setattr(files.subprocess, "Popen", lambda args: popen_calls.append(args))

        response = client.post(
            "/api/open/smart",
            json={"path": str(note_path), "prefer_embedded": True},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["action"] == "open_modal"
        assert data["editor_mode"] == "markdown"
        assert data["content"] == "# note\n"
        assert popen_calls == []

    def test_open_smart_prefer_embedded_does_not_capture_excalidraw_markdown(self, client, temp_dir, monkeypatch):
        """prefer_embedded指定でもexcalidraw.mdはExcalidrawを優先する"""
        from app import config

        excalidraw_path = temp_dir / "diagram.excalidraw.md"
        excalidraw_path.write_text("# excalidraw\n", encoding="utf-8")

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        response = client.post(
            "/api/open/smart",
            json={"path": str(excalidraw_path), "prefer_embedded": True},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["action"] == "opened"

    def test_open_smart_returns_modal_for_plain_text_file(self, client, temp_dir, monkeypatch):
        """txtファイルは内蔵テキストエディタ用レスポンスを返す"""
        from app import config

        note_path = temp_dir / "notes.txt"
        note_path.write_text("hello text\n", encoding="utf-8")

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        response = client.post("/api/open/smart", json={"path": str(note_path)})

        assert response.status_code == 200
        data = response.json()
        assert data["action"] == "open_modal"
        assert data["content"] == "hello text\n"
        assert data["editor_mode"] == "code"
        assert data["language"] == "plaintext"

    def test_open_smart_returns_modal_for_program_code_file(self, client, temp_dir, monkeypatch):
        """コードファイルはシンタックスハイライト用の言語情報付きで返す"""
        from app import config

        script_path = temp_dir / "app.py"
        script_path.write_text("print('hello')\n", encoding="utf-8")

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        response = client.post("/api/open/smart", json={"path": str(script_path)})

        assert response.status_code == 200
        data = response.json()
        assert data["action"] == "open_modal"
        assert data["content"] == "print('hello')\n"
        assert data["editor_mode"] == "code"
        assert data["language"] == "python"

    def test_open_obsidian_tries_to_bring_obsidian_to_front_on_windows(self, client, temp_dir, monkeypatch):
        """専用APIでもWindowsではObsidian URI起動後に前面化処理を試みる"""
        from app import config
        from app.routers import files

        note_dir = temp_dir / "obsidian-vault" / "2026" / "03" / "14"
        note_dir.mkdir(parents=True)
        note_path = note_dir / "note.md"
        note_path.write_text("# note\n", encoding="utf-8")

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        monkeypatch.setattr(files.platform, "system", lambda: "Windows")

        startfile_calls = []
        focus_calls = []

        monkeypatch.setattr(files.os, "startfile", lambda target: startfile_calls.append(target), raising=False)
        monkeypatch.setattr(files, "_bring_obsidian_to_front", lambda: focus_calls.append(True))

        response = client.post("/api/open/obsidian", json={"path": str(note_path)})

        assert response.status_code == 200
        assert len(startfile_calls) == 1
        assert startfile_calls[0].startswith("obsidian://open?vault=obsidian-vault&file=")
        assert focus_calls == [True]


class TestOpenExplorer:
    """Explorer起動時のWindows固有挙動を確認するテスト"""

    def test_open_explorer_tries_to_bring_window_to_front_on_windows(self, client, temp_dir, monkeypatch):
        """WindowsではExplorer起動後に前面化処理を試みる"""
        from app import config
        from app.routers import files

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        monkeypatch.setattr(files.platform, "system", lambda: "Windows")

        popen_calls = []
        focus_calls = []

        class DummyProcess:
            pid = 4321

        def fake_popen(args):
            popen_calls.append(args)
            return DummyProcess()

        monkeypatch.setattr(files.subprocess, "Popen", fake_popen)
        monkeypatch.setattr(files, "_bring_explorer_to_front", lambda pid, path: focus_calls.append((pid, path)))

        response = client.post("/api/open/explorer", json={"path": str(temp_dir / "folder1")})

        assert response.status_code == 200
        assert len(popen_calls) == 1
        assert popen_calls[0][0] == "explorer"
        assert popen_calls[0][1].endswith("\\folder1")
        assert len(focus_calls) == 1
        assert focus_calls[0][0] == 4321
        assert Path(focus_calls[0][1]).resolve() == (temp_dir / "folder1").resolve()

    def test_open_folder_tries_to_bring_window_to_front_on_windows(self, client, temp_dir, monkeypatch):
        """file_viewer互換APIでもExplorer前面化処理を試みる"""
        from app import config
        from app.routers import files

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        monkeypatch.setattr(files.platform, "system", lambda: "Windows")

        popen_calls = []
        focus_calls = []

        class DummyProcess:
            pid = 9876

        def fake_popen(args):
            popen_calls.append(args)
            return DummyProcess()

        monkeypatch.setattr(files.subprocess, "Popen", fake_popen)
        monkeypatch.setattr(files, "_bring_explorer_to_front", lambda pid, path: focus_calls.append((pid, path)))

        response = client.post("/api/open-folder", json={"path": str(temp_dir / "folder1" / "nested.txt")})

        assert response.status_code == 200
        assert len(popen_calls) == 1
        assert popen_calls[0][0] == "explorer"
        assert popen_calls[0][1].endswith("\\folder1")
        assert len(focus_calls) == 1
        assert focus_calls[0][0] == 9876
        assert Path(focus_calls[0][1]).resolve() == (temp_dir / "folder1").resolve()


class TestProgramCodeActions:
    """プログラムコード用の右クリックアクションAPIテスト"""

    def test_open_editor_opens_textedit_on_macos(self, client, temp_dir, monkeypatch):
        """macOSではTextEditでコードファイルを開く"""
        from app import config
        from app.routers import files

        script_path = temp_dir / "script.py"
        script_path.write_text("print('hello')\n", encoding="utf-8")

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        monkeypatch.setattr(files.platform, "system", lambda: "Darwin")

        popen_calls = []
        monkeypatch.setattr(files.subprocess, "Popen", lambda args: popen_calls.append(args))

        response = client.post("/api/open/editor", json={"path": str(script_path)})

        assert response.status_code == 200
        assert len(popen_calls) == 1
        assert popen_calls[0][:3] == ["open", "-a", "TextEdit"]
        assert Path(popen_calls[0][3]).resolve() == script_path.resolve()

    def test_open_editor_rejects_non_program_code_file(self, client, temp_dir, monkeypatch):
        """対象外の拡張子ではエディター起動を拒否する"""
        from app import config

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        response = client.post("/api/open/editor", json={"path": str(temp_dir / "file1.txt")})

        assert response.status_code == 400
        assert "プログラムコード" in response.json()["detail"]

    def test_execute_program_runs_python_script_on_macos(self, client, temp_dir, monkeypatch):
        """macOSではPythonスクリプトをpython3で実行する"""
        from app import config
        from app.routers import files

        script_path = temp_dir / "runner.py"
        script_path.write_text("print('run')\n", encoding="utf-8")

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        monkeypatch.setattr(files.platform, "system", lambda: "Darwin")

        popen_calls = []

        def fake_popen(args, cwd=None):
            popen_calls.append((args, cwd))

        monkeypatch.setattr(files.subprocess, "Popen", fake_popen)

        response = client.post("/api/open/execute", json={"path": str(script_path)})

        assert response.status_code == 200
        assert len(popen_calls) == 1
        assert popen_calls[0][0][0] == "python3"
        assert Path(popen_calls[0][0][1]).resolve() == script_path.resolve()
        assert Path(popen_calls[0][1]).resolve() == temp_dir.resolve()

    def test_execute_program_runs_batch_file_on_windows(self, client, temp_dir, monkeypatch):
        """Windowsではbatをcmd /cで実行する"""
        from app import config
        from app.routers import files

        script_path = temp_dir / "runner.bat"
        script_path.write_text("@echo off\r\necho hello\r\n", encoding="utf-8")

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        monkeypatch.setattr(files.platform, "system", lambda: "Windows")

        popen_calls = []

        def fake_popen(args, cwd=None, creationflags=0):
            popen_calls.append((args, cwd, creationflags))

        monkeypatch.setattr(files.subprocess, "Popen", fake_popen)

        response = client.post("/api/open/execute", json={"path": str(script_path)})

        assert response.status_code == 200
        assert len(popen_calls) == 1
        assert popen_calls[0][0][:2] == ["cmd", "/c"]
        assert Path(popen_calls[0][0][2]).resolve() == script_path.resolve()
        assert Path(popen_calls[0][1]).resolve() == temp_dir.resolve()
        assert popen_calls[0][2] == getattr(files.subprocess, "CREATE_NEW_CONSOLE", 0)


class TestOpenAntigravity:
    """POST /api/open/antigravity エンドポイントのテスト"""

    def test_open_antigravity_success_macos_ide_app(self, client, temp_dir, monkeypatch):
        """macOS環境でAntigravity IDE.appが存在する場合、正常に起動する"""
        from app import config
        from app.routers import files

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        monkeypatch.setattr(files.platform, "system", lambda: "Darwin")
        
        # 特定のパスのみ True を返すモック exists
        def fake_exists(p):
            return str(p) == '/Applications/Antigravity IDE.app'
        monkeypatch.setattr(files.os.path, "exists", fake_exists)

        popen_calls = []
        monkeypatch.setattr(files.subprocess, "Popen", lambda args: popen_calls.append(args))

        target_file = temp_dir / "test.txt"
        target_file.touch()

        response = client.post("/api/open/antigravity", json={"path": str(target_file)})

        assert response.status_code == 200
        assert response.json()["status"] == "success"
        assert len(popen_calls) == 1
        assert popen_calls[0][:3] == ['open', '-a', '/Applications/Antigravity IDE.app']
        assert Path(popen_calls[0][3]).resolve() == target_file.resolve()

    def test_open_antigravity_success_macos_standard_app(self, client, temp_dir, monkeypatch):
        """macOS環境でAntigravity.appが存在する場合、正常に起動する"""
        from app import config
        from app.routers import files

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        monkeypatch.setattr(files.platform, "system", lambda: "Darwin")
        
        # 特定のパスのみ True を返すモック exists
        def fake_exists(p):
            return str(p) == '/Applications/Antigravity.app'
        monkeypatch.setattr(files.os.path, "exists", fake_exists)

        popen_calls = []
        monkeypatch.setattr(files.subprocess, "Popen", lambda args: popen_calls.append(args))

        target_file = temp_dir / "test.txt"
        target_file.touch()

        response = client.post("/api/open/antigravity", json={"path": str(target_file)})

        assert response.status_code == 200
        assert response.json()["status"] == "success"
        assert len(popen_calls) == 1
        assert popen_calls[0][:3] == ['open', '-a', '/Applications/Antigravity.app']
        assert Path(popen_calls[0][3]).resolve() == target_file.resolve()

    def test_open_antigravity_not_found_macos(self, client, temp_dir, monkeypatch):
        """macOS環境でAntigravityが存在しない場合、404エラーを返す"""
        from app import config
        from app.routers import files

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        monkeypatch.setattr(files.platform, "system", lambda: "Darwin")
        
        # すべて False を返す
        monkeypatch.setattr(files.os.path, "exists", lambda p: False)

        target_file = temp_dir / "test.txt"
        target_file.touch()

        response = client.post("/api/open/antigravity", json={"path": str(target_file)})

        assert response.status_code == 404
        assert "Antigravityが見つかりません" in response.json()["detail"]

    def test_open_antigravity_not_supported_on_other_os(self, client, temp_dir, monkeypatch):
        """macOS以外のOSでは501エラーを返す"""
        from app import config
        from app.routers import files

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        monkeypatch.setattr(files.platform, "system", lambda: "Windows")

        target_file = temp_dir / "test.txt"
        target_file.touch()

        response = client.post("/api/open/antigravity", json={"path": str(target_file)})

        assert response.status_code == 501
        assert "AntigravityはmacOSでのみサポートされています" in response.json()["detail"]

