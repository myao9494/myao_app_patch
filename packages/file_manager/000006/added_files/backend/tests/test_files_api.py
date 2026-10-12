"""
ファイル一覧APIのテスト
TDD: まずテストを作成し、失敗を確認してから実装を進める
"""
import pytest
from pathlib import Path


def create_directory_symlink_or_skip(link: Path, target: Path) -> None:
    """Windowsで権限がない場合はsymlink系テストをskipする"""
    try:
        link.symlink_to(target, target_is_directory=True)
    except OSError as exc:
        if getattr(exc, "winerror", None) == 1314:
            pytest.skip("Windows環境でシンボリックリンク作成権限がありません")
        raise


class TestGetFiles:
    """GET /api/files エンドポイントのテスト"""

    def test_get_files_returns_directory_type(self, client, temp_dir, monkeypatch):
        """ディレクトリを指定した場合、type: "directory"を返す"""
        # 一時ディレクトリをベースディレクトリとして設定
        from app import config
        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        response = client.get("/api/files", params={"path": ""})

        assert response.status_code == 200
        data = response.json()
        assert data["type"] == "directory"
        assert "items" in data

    def test_get_files_lists_folders_and_files(self, client, temp_dir, monkeypatch):
        """フォルダとファイルの一覧を取得できる"""
        from app import config
        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        response = client.get("/api/files", params={"path": ""})

        assert response.status_code == 200
        data = response.json()
        items = data["items"]

        # フォルダとファイルが含まれている
        names = [item["name"] for item in items]
        assert "folder1" in names
        assert "folder2" in names
        assert "file1.txt" in names
        assert "file2.md" in names

    def test_get_files_item_structure(self, client, temp_dir, monkeypatch):
        """各アイテムが必要な情報を持っている"""
        from app import config
        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        response = client.get("/api/files", params={"path": ""})

        data = response.json()
        items = data["items"]

        # フォルダの構造確認
        folder = next(item for item in items if item["name"] == "folder1")
        assert folder["type"] == "directory"
        assert "path" in folder

        # ファイルの構造確認
        file = next(item for item in items if item["name"] == "file1.txt")
        assert file["type"] == "file"
        assert "path" in file
        assert "size" in file
        assert "modified" in file

    def test_get_files_nested_directory(self, client, temp_dir, monkeypatch):
        """ネストしたディレクトリの内容を取得できる"""
        from app import config
        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        response = client.get("/api/files", params={"path": "folder1"})

        assert response.status_code == 200
        data = response.json()
        items = data["items"]

        names = [item["name"] for item in items]
        assert "nested.txt" in names

    def test_get_files_nonexistent_path(self, client, temp_dir, monkeypatch):
        """存在しないパスは404を返す"""
        from app import config
        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        response = client.get("/api/files", params={"path": "nonexistent"})

        assert response.status_code == 404

    def test_get_files_prevents_path_traversal(self, client, temp_dir, monkeypatch):
        """パストラバーサル攻撃を防ぐ"""
        from app import config
        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        response = client.get("/api/files", params={"path": "../../../etc"})

        # 403: ベースディレクトリ外へのアクセス拒否
        assert response.status_code == 403
    def test_get_files_with_file_path_returns_parent_directory(self, client, temp_dir, monkeypatch):
        """ファイルパスを指定した場合、その親ディレクトリの内容を返す"""
        from app import config
        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        # 実在するファイルパスを指定
        file_path = "file1.txt"
        response = client.get("/api/files", params={"path": file_path})

        assert response.status_code == 200
        data = response.json()
        assert data["type"] == "directory"
        # pathフィールドが含まれ、親ディレクトリ（この場合はベースディレクトリ）を指していること
        assert "path" in data
        assert Path(data["path"]).resolve() == temp_dir.resolve()
        
        # アイテム一覧にそのファイルが含まれていること
        names = [item["name"] for item in data["items"]]
        assert "file1.txt" in names

    def test_get_files_response_includes_path(self, client, temp_dir, monkeypatch):
        """レスポンスに現在のパスが含まれている"""
        from app import config
        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        response = client.get("/api/files", params={"path": "folder1"})

        assert response.status_code == 200
        data = response.json()
        assert "path" in data
        assert Path(data["path"]).suffix == "" # フォルダ名
        assert str(Path(data["path"]).name) == "folder1"

    def test_get_files_skips_recursive_symlink_entries(self, client, temp_dir, monkeypatch):
        """ベースディレクトリ配下を指すシンボリックリンクは再帰事故防止のため一覧から除外する"""
        from app import config
        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        loop_link = temp_dir / "folder1_loop"
        create_directory_symlink_or_skip(loop_link, temp_dir / "folder1")

        response = client.get("/api/files", params={"path": ""})

        assert response.status_code == 200
        data = response.json()
        names = [item["name"] for item in data["items"]]
        assert "folder1_loop" not in names


class TestFolderLatestModified:
    """フォルダ配下の最新更新日時を取得するAPIのテスト"""

    def test_returns_the_latest_timestamp_including_nested_files(self, client, temp_dir, monkeypatch):
        """深い階層のファイル更新日時をフォルダの最新日時として返す"""
        from app import config
        import os

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        target = temp_dir / "latest-target"
        nested = target / "nested"
        nested.mkdir(parents=True)
        older = target / "older.txt"
        latest = nested / "latest.txt"
        older.write_text("old")
        latest.write_text("new")
        os.utime(older, (1_700_000_000, 1_700_000_000))
        os.utime(latest, (1_800_000_000, 1_800_000_000))

        response = client.post("/api/folder-latest-modified", json={"path": "latest-target"})

        assert response.status_code == 200
        data = response.json()
        assert Path(data["path"]).resolve() == target.resolve()
        assert data["modified"].startswith("2027-01-15T")
        assert data["scanned_entries"] >= 3
        assert data["truncated"] is False

    def test_stops_at_the_configured_entry_limit(self, client, temp_dir, monkeypatch):
        """安全上限に達した不完全な集計結果はtruncatedとして返す"""
        from app import config
        from app.routers import files as files_router

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        monkeypatch.setattr(
            files_router,
            "get_editor_preferences",
            lambda: {"apiTimeout": 10, "folderLatestModifiedMaxEntries": 1},
        )
        target = temp_dir / "limited-target"
        target.mkdir()
        (target / "first.txt").write_text("first")
        (target / "second.txt").write_text("second")

        response = client.post("/api/folder-latest-modified", json={"path": "limited-target"})

        assert response.status_code == 200
        assert response.json()["scanned_entries"] == 1
        assert response.json()["truncated"] is True


class TestGitFolderStatus:
    """ペイン内フォルダ向けGit状態一括取得APIのテスト"""

    def test_returns_status_for_changed_clean_and_non_git_folders(self, client, temp_dir, monkeypatch):
        """変更あり・変更なし・Git管理外の全フォルダについて状態を返す"""
        from app import config
        import subprocess

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        changed = temp_dir / "changed-repo"
        clean = temp_dir / "clean-repo"
        non_git = temp_dir / "non-git-folder"
        changed.mkdir()
        clean.mkdir()
        non_git.mkdir()
        for repository in (changed, clean):
            subprocess.run(["git", "init", "-q", str(repository)], check=True)
        (changed / "untracked.txt").write_text("changed")

        response = client.post(
            "/api/git-folder-statuses",
            json={"paths": ["changed-repo", "clean-repo", "non-git-folder"]},
        )

        assert response.status_code == 200
        statuses = {item["path"]: item for item in response.json()["items"]}
        changed_key = str(changed)
        clean_key = str(clean)
        non_git_key = str(non_git)
        assert statuses[changed_key]["has_changes"] is True
        assert statuses[changed_key]["changed_files"] == ["untracked.txt"]
        assert statuses[changed_key]["has_more_changes"] is False
        assert statuses[changed_key]["ahead_count"] == 0
        assert statuses[changed_key]["behind_count"] == 0
        assert statuses[clean_key]["has_changes"] is False
        assert statuses[non_git_key]["has_changes"] is False
        assert statuses[non_git_key]["ahead_count"] == 0
        assert statuses[non_git_key]["behind_count"] == 0

    def test_returns_unpushed_commit_count(self, client, temp_dir, monkeypatch):
        """追跡ブランチより進んだコミット数を未Push件数として返す"""
        from app import config
        import subprocess

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        remote = temp_dir / "remote.git"
        repository = temp_dir / "push-repo"
        subprocess.run(["git", "init", "--bare", "-q", str(remote)], check=True)
        subprocess.run(["git", "init", "-q", str(repository)], check=True)
        for command in (
            ["git", "-C", str(repository), "config", "user.email", "test@example.com"],
            ["git", "-C", str(repository), "config", "user.name", "Test User"],
            ["git", "-C", str(repository), "add", "."],
        ):
            subprocess.run(command, check=True)
        (repository / "initial.txt").write_text("initial")
        subprocess.run(["git", "-C", str(repository), "add", "."], check=True)
        subprocess.run(["git", "-C", str(repository), "commit", "-qm", "initial"], check=True)
        subprocess.run(["git", "-C", str(repository), "branch", "-M", "main"], check=True)
        subprocess.run(["git", "-C", str(repository), "remote", "add", "origin", str(remote)], check=True)
        subprocess.run(["git", "-C", str(repository), "push", "-qu", "origin", "main"], check=True)
        (repository / "unpushed.txt").write_text("unpushed")
        subprocess.run(["git", "-C", str(repository), "add", "."], check=True)
        subprocess.run(["git", "-C", str(repository), "commit", "-qm", "unpushed"], check=True)

        response = client.post("/api/git-folder-statuses", json={"paths": ["push-repo"]})

        assert response.status_code == 200
        status = response.json()["items"][0]
        assert status["ahead_count"] == 1
        assert status["behind_count"] == 0

        remote_writer = temp_dir / "remote-writer"
        subprocess.run(["git", "clone", "-q", "--branch", "main", str(remote), str(remote_writer)], check=True)
        subprocess.run(["git", "-C", str(remote_writer), "config", "user.email", "test@example.com"], check=True)
        subprocess.run(["git", "-C", str(remote_writer), "config", "user.name", "Test User"], check=True)
        (remote_writer / "remote.txt").write_text("remote")
        subprocess.run(["git", "-C", str(remote_writer), "add", "."], check=True)
        subprocess.run(["git", "-C", str(remote_writer), "commit", "-qm", "remote"], check=True)
        subprocess.run(["git", "-C", str(remote_writer), "push", "-q"], check=True)
        subprocess.run(["git", "-C", str(repository), "fetch", "-q", "origin"], check=True)

        response = client.post("/api/git-folder-statuses", json={"paths": ["push-repo"]})

        status = response.json()["items"][0]
        assert status["ahead_count"] == 1
        assert status["behind_count"] == 1

    def test_limits_hover_file_names_to_twenty(self, client, temp_dir, monkeypatch):
        """ホバー表示用の変更ファイル名は20件までに省略する"""
        from app import config
        import subprocess

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        repository = temp_dir / "many-changes"
        repository.mkdir()
        subprocess.run(["git", "init", "-q", str(repository)], check=True)
        for index in range(21):
            (repository / f"changed-{index:02}.txt").write_text("changed")

        response = client.post("/api/git-folder-statuses", json={"paths": ["many-changes"]})

        assert response.status_code == 200
        status = response.json()["items"][0]
        assert len(status["changed_files"]) == 20
        assert status["has_more_changes"] is True

import zipfile

class TestUnzipFile:
    """POST /api/files/unzip エンドポイントのテスト"""

    def test_unzip_creates_directory_and_extracts_files(self, client, temp_dir, monkeypatch):
        """zipファイルを解凍できること"""
        from app import config
        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        zip_path = temp_dir / "test.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("test_in_zip.txt", "hello zip")
            zf.writestr("folder_in_zip/nested.txt", "nested zip")

        response = client.post("/api/unzip", json={"path": "test.zip"})
        
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "success"
        
        extract_dir = temp_dir / "test"
        assert extract_dir.exists()
        assert extract_dir.is_dir()
        assert (extract_dir / "test_in_zip.txt").exists()
        assert (extract_dir / "folder_in_zip" / "nested.txt").exists()

    def test_unzip_nonexistent_file(self, client, temp_dir, monkeypatch):
        """存在しないzipファイルの解凍はエラーになること"""
        from app import config
        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        response = client.post("/api/unzip", json={"path": "not_exist.zip"})
        assert response.status_code == 404

    def test_unzip_not_a_zip_file(self, client, temp_dir, monkeypatch):
        """zipファイルでない場合の解凍はエラーになること"""
        from app import config
        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        response = client.post("/api/unzip", json={"path": "file1.txt"})
        assert response.status_code == 400

    def test_unzip_rejects_zip_slip_member(self, client, temp_dir, monkeypatch):
        """展開先外へ出るZIPメンバーを拒否する。"""
        from app import config

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        zip_path = temp_dir / "unsafe.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("../unsafe_evil/escaped.txt", "unsafe")

        response = client.post("/api/unzip", json={"path": "unsafe.zip"})

        assert response.status_code == 400
        assert not (temp_dir / "unsafe_evil" / "escaped.txt").exists()


class TestSearchFiles:
    """GET /api/search エンドポイントのテスト"""

    def test_search_files_finds_nested_matches(self, client, temp_dir, monkeypatch):
        """再帰検索でネストしたファイルも見つかる"""
        from app import config
        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        (temp_dir / "folder1" / "report_match.txt").write_text("report")

        response = client.get("/api/search", params={"path": "", "query": "match", "depth": 2})

        assert response.status_code == 200
        data = response.json()
        names = [item["name"] for item in data["items"]]
        assert "report_match.txt" in names

    def test_search_files_respects_file_type_filter(self, client, temp_dir, monkeypatch):
        """file_type=directory の場合はディレクトリのみ返す"""
        from app import config
        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        (temp_dir / "match_dir").mkdir()
        (temp_dir / "match_file.txt").write_text("match")

        response = client.get(
            "/api/search",
            params={"path": "", "query": "match", "depth": 1, "file_type": "directory"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 1
        assert data["items"][0]["name"] == "match_dir"
        assert data["items"][0]["type"] == "directory"

    def test_search_files_skips_recursive_symlink_entries(self, client, temp_dir, monkeypatch):
        """再帰検索でもベース配下を指すシンボリックリンクはたどらない"""
        from app import config
        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)

        loop_link = temp_dir / "folder1_loop"
        create_directory_symlink_or_skip(loop_link, temp_dir / "folder1")

        response = client.get("/api/search", params={"path": "", "query": "loop", "depth": 2})

        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 0
        assert data["items"] == []

    @pytest.mark.anyio
    async def test_search_files_offloads_recursive_walk(self, temp_dir, monkeypatch):
        """Live検索の再帰走査をイベントループ上で直接実行しない。"""
        from app.routers import files

        calls: list[object] = []

        async def record_run_with_timeout(func, *args, **kwargs):
            calls.append(func)
            return func(*args, **kwargs)

        monkeypatch.setattr(files, "run_with_timeout", record_run_with_timeout)

        response = await files.search_files(
            path=str(temp_dir),
            query="file",
            depth=1,
            ignore="",
            max_results=1000,
            file_type="all",
        )

        assert response.total >= 1
        assert calls


class TestCountFiles:
    """POST /api/count-files エンドポイントのテスト。"""

    @pytest.mark.anyio
    async def test_count_files_offloads_recursive_walk(self, temp_dir, monkeypatch):
        """再帰カウントをイベントループ上で直接実行しない。"""
        from app.routers import files

        calls: list[object] = []

        async def record_run_with_timeout(func, *args, **kwargs):
            calls.append(func)
            return func(*args, **kwargs)

        monkeypatch.setattr(files, "run_with_timeout", record_run_with_timeout)
        request = files.CountFilesRequest(paths=[str(temp_dir)], max_depth=3)

        response = await files.count_files(request)

        assert response.total_count >= 3
        assert calls


class TestDeleteItem:
    """DELETE /api/delete エンドポイントのテスト"""

    def test_delete_item_retries_windows_locked_file(self, client, temp_dir, monkeypatch):
        """Windowsで一時ロック中でもリトライ後に削除できる"""
        from app import config
        from app.services import trash

        target_file = temp_dir / "file1.txt"
        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        monkeypatch.setattr(config.settings, "is_windows", True)

        call_count = {"count": 0}

        def fake_move_to_trash(path_str: str) -> None:
            assert Path(path_str).resolve() == target_file.resolve()
            call_count["count"] += 1
            if call_count["count"] < 3:
                raise PermissionError("[WinError 32] The process cannot access the file")

        monkeypatch.setattr(trash, "move_to_trash", fake_move_to_trash)
        monkeypatch.setattr(trash.time, "sleep", lambda _: None)

        response = client.request("DELETE", "/api/delete", json={"path": "file1.txt"})

        assert response.status_code == 200
        assert response.json()["status"] == "success"
        assert call_count["count"] == 3

    def test_delete_item_waits_longer_for_windows_excel_style_lock(self, client, temp_dir, monkeypatch):
        """Windowsでロック解除が遅いファイルでも追加リトライで削除できる"""
        from app import config
        from app.services import trash

        target_file = temp_dir / "book.xlsx"
        target_file.write_text("excel content")
        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        monkeypatch.setattr(config.settings, "is_windows", True)

        call_count = {"count": 0}

        def fake_move_to_trash(path_str: str) -> None:
            assert Path(path_str).resolve() == target_file.resolve()
            call_count["count"] += 1
            if call_count["count"] < 7:
                raise PermissionError("[WinError 32] The process cannot access the file")

        monkeypatch.setattr(trash, "move_to_trash", fake_move_to_trash)
        monkeypatch.setattr(trash.time, "sleep", lambda _: None)

        response = client.request("DELETE", "/api/delete", json={"path": "book.xlsx"})

        assert response.status_code == 200
        assert response.json()["status"] == "success"
        assert call_count["count"] == 7

    def test_delete_item_returns_500_when_windows_lock_persists(self, client, temp_dir, monkeypatch):
        """Windowsでロックが継続する場合は削除失敗を返す"""
        from app import config
        from app.services import trash

        monkeypatch.setattr(config.settings, "_base_dir_override", temp_dir)
        monkeypatch.setattr(config.settings, "is_windows", True)

        def always_locked(_path_str: str) -> None:
            raise PermissionError("[WinError 32] still locked")

        monkeypatch.setattr(trash, "move_to_trash", always_locked)
        monkeypatch.setattr(trash.time, "sleep", lambda _: None)

        response = client.request("DELETE", "/api/delete", json={"path": "file1.txt"})

        assert response.status_code == 500
        assert "still locked" in response.json()["detail"]

    def test_move_to_trash_uses_win32_api_on_windows(self, temp_dir, monkeypatch):
        """Windows環境では send2trash ではなく SHFileOperationW を呼び出す"""
        from app.services import trash
        from app import config
        import ctypes
        
        monkeypatch.setattr(config.settings, "is_windows", True)
        
        # macOS など win32 がない環境でのエラーを防ぎつつ、Mock する
        class DummyShell32:
            def SHFileOperationW(self, op_struct):
                return 0 # 成功
                
        class DummyWinDLL:
            shell32 = DummyShell32()
            
        monkeypatch.setattr(ctypes, "windll", DummyWinDLL(), raising=False)
        
        target_path = str(temp_dir / "test_del.txt")
        
        # エラーが起きずに成功すればMock経由で抜けたことがわかる
        trash.move_to_trash(target_path)

    def test_move_to_trash_uses_send2trash_on_mac(self, temp_dir, monkeypatch):
        """Windows以外の環境では send2trash を呼び出す"""
        from app.services import trash
        from app import config
        
        monkeypatch.setattr(config.settings, "is_windows", False)
        
        called = False
        def mock_send2trash(path):
            nonlocal called
            called = True
            
        # send2trashモジュールをモック (テスト環境での不要な依存を防ぐ)
        import sys
        import types
        dummy_send2trash_module = types.ModuleType("send2trash")
        dummy_send2trash_module.send2trash = mock_send2trash
        monkeypatch.setitem(sys.modules, "send2trash", dummy_send2trash_module)
        
        target_path = str(temp_dir / "test_del.txt")
        trash.move_to_trash(target_path)
        
        assert called is True

    def test_delete_item_returns_409_when_process_is_locked(self, client, temp_dir, monkeypatch):
        """Windows環境でファイルがロックされており、プロセス特定ができた場合は409を返す"""
        from app.services import trash
        from app import config
        
        target_file = temp_dir / "locked_file.txt"
        target_file.touch()
        
        monkeypatch.setattr(config.settings, "is_windows", True)
        
        # 削除時に PermissionError を発生させるモック
        def mock_move_to_trash(path):
            raise PermissionError("[WinError 32] The process cannot access the file because it is being used by another process")
            
        monkeypatch.setattr(trash, "move_to_trash", mock_move_to_trash)
        
        # get_locking_processes をモックしてロックしているプロセスを返す
        def mock_get_locking_processes(path):
            return [{"pid": 1234, "name": "EXCEL.EXE"}]
            
        monkeypatch.setattr(trash, "get_locking_processes", mock_get_locking_processes)
        monkeypatch.setattr(trash.time, "sleep", lambda _: None)

        # 削除API呼び出し (async_mode=False)
        response = client.request(
            "DELETE",
            "/api/delete",
            json={"path": str(target_file), "async_mode": False}
        )
        
        assert response.status_code == 409
        data = response.json()
        assert "locked_by" in data
        assert data["locked_by"][0]["pid"] == 1234
        assert data["locked_by"][0]["name"] == "EXCEL.EXE"
