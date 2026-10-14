"""
ファイルが勝手に消えないことを保証する安全性テスト

- 移動: 同名衝突時は何も変更しない / 同じ場所への移動で消えない / 失敗・キャンセル時は移動元を残す
- 上書き: 置き換えられる既存ファイルはゴミ箱へ退避し、フォルダは統合して移動先だけのファイルを残す
- コピー: 同名衝突をエラーとして報告し、既存ファイルを変更しない
- 削除: フォルダは階層ごとゴミ箱へ / ゴミ箱に失敗しても完全削除しない
- アップロード: 同名ファイルを上書きしない
- ファイル更新: 書き込み失敗で元ファイルを壊さない / シンボリックリンクを壊さない
- 名前の検証: 区切り文字を含む名前で別の場所へ書き込まない
"""
import os
import time
from pathlib import Path

import pytest

from app.services import transfer
from app.services.transfer import CONFLICT_MESSAGE


def wait_for_task(client, task_id, timeout=10.0):
    """非同期タスクの完了を待って進捗レスポンスを返す"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        data = client.get(f"/api/tasks/{task_id}/progress").json()
        if data.get("status") in ("completed", "cancelled", "error"):
            return data
        time.sleep(0.05)
    raise AssertionError("task did not finish")


def batch(client, op, src_paths, dest, **kwargs):
    """一括移動/コピーを実行し、同期・非同期どちらでも結果dictを返す"""
    body = {"src_paths": [str(p) for p in src_paths], "dest_path": str(dest), **kwargs}
    response = client.post(f"/api/{op}/batch", json=body)
    assert response.status_code == 200, response.text
    data = response.json()
    if data.get("status") == "async":
        return wait_for_task(client, data["task_id"])["result"]
    return data


@pytest.fixture
def tree(tmp_path):
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    src.mkdir()
    dst.mkdir()
    return tmp_path, src, dst


@pytest.fixture
def no_rename(monkeypatch):
    """別ボリューム間の移動（コピー→検証→削除）を再現する"""
    monkeypatch.setattr(transfer, "_try_rename", lambda src, dest: False)


ASYNC_MODES = [pytest.param(False, id="sync"), pytest.param(True, id="async")]


class TestMoveNeverLosesData:
    @pytest.mark.parametrize("async_mode", ASYNC_MODES)
    def test_conflict_without_overwrite_keeps_both_files(self, client, tree, async_mode):
        _, src, dst = tree
        (src / "a.txt").write_text("NEW")
        (dst / "a.txt").write_text("OLD")

        result = batch(client, "move", [src / "a.txt"], dst, overwrite=False, async_mode=async_mode)

        assert (src / "a.txt").read_text() == "NEW"
        assert (dst / "a.txt").read_text() == "OLD"
        assert result["fail_count"] == 1
        assert result["results"][0]["status"] == "error"
        assert CONFLICT_MESSAGE in result["results"][0]["message"]

    @pytest.mark.parametrize("async_mode", ASYNC_MODES)
    def test_folder_conflict_without_overwrite_changes_nothing(self, client, tree, async_mode, no_rename):
        _, src, dst = tree
        (src / "folder").mkdir()
        (src / "folder" / "same.txt").write_text("NEW")
        (src / "folder" / "only_src.txt").write_text("S")
        (dst / "folder").mkdir()
        (dst / "folder" / "same.txt").write_text("OLD")

        result = batch(client, "move", [src / "folder"], dst, overwrite=False, async_mode=async_mode)

        assert result["results"][0]["status"] == "error"
        assert (src / "folder" / "same.txt").read_text() == "NEW"
        assert (src / "folder" / "only_src.txt").read_text() == "S"
        assert (dst / "folder" / "same.txt").read_text() == "OLD"
        assert not (dst / "folder" / "only_src.txt").exists()

    @pytest.mark.parametrize("async_mode", ASYNC_MODES)
    def test_overwrite_file_sends_old_version_to_trash(self, client, tree, async_mode, fake_trash):
        _, src, dst = tree
        (src / "a.txt").write_text("NEW")
        (dst / "a.txt").write_text("OLD")

        result = batch(client, "move", [src / "a.txt"], dst, overwrite=True, async_mode=async_mode)

        assert result["results"][0]["status"] == "success"
        assert (dst / "a.txt").read_text() == "NEW"
        assert not (src / "a.txt").exists()
        assert [Path(dest).read_text() for _, dest in fake_trash.items] == ["OLD"]

    @pytest.mark.parametrize("async_mode", ASYNC_MODES)
    def test_overwrite_folder_merges_and_keeps_destination_only_files(
        self, client, tree, async_mode, fake_trash
    ):
        _, src, dst = tree
        (src / "folder" / "sub").mkdir(parents=True)
        (src / "folder" / "same.txt").write_text("NEW")
        (src / "folder" / "sub" / "deep.txt").write_text("DEEP")
        (dst / "folder").mkdir()
        (dst / "folder" / "same.txt").write_text("OLD")
        (dst / "folder" / "only_dst.txt").write_text("KEEP")

        result = batch(client, "move", [src / "folder"], dst, overwrite=True, async_mode=async_mode)

        assert result["results"][0]["status"] == "success", result
        assert (dst / "folder" / "same.txt").read_text() == "NEW"
        assert (dst / "folder" / "only_dst.txt").read_text() == "KEEP"
        assert (dst / "folder" / "sub" / "deep.txt").read_text() == "DEEP"
        assert not (src / "folder").exists()
        assert [Path(dest).read_text() for _, dest in fake_trash.items] == ["OLD"]

    @pytest.mark.parametrize("async_mode", ASYNC_MODES)
    def test_move_into_same_folder_is_a_noop(self, client, tree, async_mode):
        tmp, src, _ = tree
        (src / "keep.txt").write_text("x")

        file_result = batch(client, "move", [src / "keep.txt"], src, async_mode=async_mode)
        folder_result = batch(client, "move", [src], tmp, async_mode=async_mode)

        assert (src / "keep.txt").read_text() == "x"
        for result in (file_result, folder_result):
            assert result["results"][0]["status"] == "skipped"
            assert result["fail_count"] == 0

    def test_single_move_to_own_parent_does_not_delete(self, client, tree):
        tmp, src, _ = tree
        (src / "f.txt").write_text("x")

        response = client.post("/api/move", json={"src_path": str(src), "dest_path": str(tmp)})

        assert response.status_code == 200
        assert (src / "f.txt").read_text() == "x"

    def test_single_move_conflict_returns_409_and_keeps_both(self, client, tree):
        _, src, dst = tree
        (src / "a.txt").write_text("NEW")
        (dst / "a.txt").write_text("OLD")

        response = client.post("/api/move", json={"src_path": str(src / "a.txt"), "dest_path": str(dst)})

        assert response.status_code == 409
        assert CONFLICT_MESSAGE in response.json()["detail"]
        assert (src / "a.txt").read_text() == "NEW"
        assert (dst / "a.txt").read_text() == "OLD"

    def test_single_move_to_new_full_path(self, client, tree):
        """Undo で使う「元のフルパスへ戻す」移動"""
        _, src, dst = tree
        (dst / "a.txt").write_text("x")

        response = client.post("/api/move", json={"src_path": str(dst / "a.txt"), "dest_path": str(src / "a.txt")})

        assert response.status_code == 200
        assert (src / "a.txt").read_text() == "x"
        assert not (dst / "a.txt").exists()

    def test_move_to_sibling_with_common_prefix_is_allowed(self, client, tree):
        tmp, _, _ = tree
        (tmp / "foo").mkdir()
        (tmp / "foo" / "x.txt").write_text("x")
        (tmp / "foobar").mkdir()

        result = batch(client, "move", [tmp / "foo"], tmp / "foobar")

        assert result["results"][0]["status"] == "success", result
        assert (tmp / "foobar" / "foo" / "x.txt").read_text() == "x"

    @pytest.mark.parametrize("async_mode", ASYNC_MODES)
    def test_move_into_own_subfolder_is_rejected(self, client, tree, async_mode):
        _, src, _ = tree
        (src / "child").mkdir()

        result = batch(client, "move", [src], src / "child", async_mode=async_mode)

        assert result["results"][0]["status"] == "error"
        assert (src / "child").is_dir()

    @pytest.mark.parametrize("async_mode", ASYNC_MODES)
    def test_cross_volume_move_copies_everything_then_removes_source(
        self, client, tree, async_mode, no_rename
    ):
        _, src, dst = tree
        (src / "folder" / "sub" / "empty").mkdir(parents=True)
        (src / "folder" / "a.txt").write_text("A")
        (src / "folder" / "sub" / "b.bin").write_bytes(os.urandom(4096))
        expected = (src / "folder" / "sub" / "b.bin").read_bytes()

        result = batch(client, "move", [src / "folder"], dst, async_mode=async_mode, verify_checksum=True)

        assert result["results"][0]["status"] == "success", result
        assert result["results"][0]["dest"] == (dst / "folder").as_posix()
        assert (dst / "folder" / "a.txt").read_text() == "A"
        assert (dst / "folder" / "sub" / "b.bin").read_bytes() == expected
        assert (dst / "folder" / "sub" / "empty").is_dir()
        assert not (src / "folder").exists()

    @pytest.mark.parametrize("async_mode", ASYNC_MODES)
    def test_cross_volume_move_keeps_source_when_any_copy_fails(
        self, client, tree, async_mode, no_rename, monkeypatch
    ):
        _, src, dst = tree
        (src / "folder").mkdir()
        for i in range(5):
            (src / "folder" / f"f{i}.txt").write_text(str(i))

        original_copy = transfer.fast_copy_file

        def flaky_copy(s, d):
            if s.name == "f3.txt":
                raise OSError("disk error")
            return original_copy(s, d)

        monkeypatch.setattr(transfer, "fast_copy_file", flaky_copy)

        result = batch(client, "move", [src / "folder"], dst, async_mode=async_mode)

        assert result["results"][0]["status"] == "error"
        assert sorted(p.name for p in (src / "folder").iterdir()) == [f"f{i}.txt" for i in range(5)]
        assert not (dst / "folder").exists()

    def test_cancelled_move_keeps_source(self, tree, no_rename, monkeypatch):
        _, src, dst = tree
        (src / "folder").mkdir()
        (src / "folder" / "a.txt").write_text("A")
        progress = transfer._Progress(task_id="dummy")
        monkeypatch.setattr(transfer._Progress, "cancelled", lambda self: True)

        with pytest.raises(transfer.TransferError):
            transfer.transfer_one(src / "folder", dst / "folder", "move", progress=progress)

        assert (src / "folder" / "a.txt").read_text() == "A"

    def test_move_keeps_source_when_new_file_appears_during_copy(self, tree, no_rename, monkeypatch):
        _, src, dst = tree
        (src / "folder").mkdir()
        (src / "folder" / "a.txt").write_text("A")
        original_copy = transfer.fast_copy_file

        def copy_and_add_file(s, d):
            original_copy(s, d)
            (src / "folder" / "late.txt").write_text("LATE")

        monkeypatch.setattr(transfer, "fast_copy_file", copy_and_add_file)

        with pytest.raises(transfer.TransferError):
            transfer.transfer_one(src / "folder", dst / "folder", "move")

        assert (src / "folder" / "late.txt").read_text() == "LATE"
        assert (src / "folder" / "a.txt").read_text() == "A"

    def test_server_default_does_not_overwrite(self, client, tree):
        """overwrite を省略した場合は上書きしない"""
        _, src, dst = tree
        (src / "a.txt").write_text("NEW")
        (dst / "a.txt").write_text("OLD")

        result = batch(client, "move", [src / "a.txt"], dst)

        assert result["results"][0]["status"] == "error"
        assert (src / "a.txt").read_text() == "NEW"


class TestCopyNeverLosesData:
    @pytest.mark.parametrize("async_mode", ASYNC_MODES)
    def test_conflict_is_reported_and_destination_unchanged(self, client, tree, async_mode):
        _, src, dst = tree
        (src / "a.txt").write_text("NEW")
        (dst / "a.txt").write_text("OLD")

        result = batch(client, "copy", [src / "a.txt"], dst, overwrite=False, async_mode=async_mode)

        assert result["results"][0]["status"] == "error"
        assert CONFLICT_MESSAGE in result["results"][0]["message"]
        assert (dst / "a.txt").read_text() == "OLD"
        assert (src / "a.txt").read_text() == "NEW"

    @pytest.mark.parametrize("async_mode", ASYNC_MODES)
    def test_overwrite_folder_merges(self, client, tree, async_mode, fake_trash):
        _, src, dst = tree
        (src / "folder").mkdir()
        (src / "folder" / "same.txt").write_text("NEW")
        (dst / "folder").mkdir()
        (dst / "folder" / "same.txt").write_text("OLD")
        (dst / "folder" / "only_dst.txt").write_text("KEEP")

        result = batch(client, "copy", [src / "folder"], dst, overwrite=True, async_mode=async_mode)

        assert result["results"][0]["status"] == "success", result
        assert (dst / "folder" / "same.txt").read_text() == "NEW"
        assert (dst / "folder" / "only_dst.txt").read_text() == "KEEP"
        assert (src / "folder" / "same.txt").read_text() == "NEW"
        assert [Path(dest).read_text() for _, dest in fake_trash.items] == ["OLD"]

    @pytest.mark.parametrize("async_mode", ASYNC_MODES)
    def test_copy_into_same_folder_is_rejected_without_changes(self, client, tree, async_mode):
        tmp, src, _ = tree
        (src / "a.txt").write_text("x")

        result = batch(client, "copy", [src / "a.txt"], src, async_mode=async_mode)

        assert result["results"][0]["status"] == "error"
        assert (src / "a.txt").read_text() == "x"

    def test_copy_reports_destination_path(self, client, tree):
        _, src, dst = tree
        (src / "a.txt").write_text("x")

        result = batch(client, "copy", [src / "a.txt"], dst)

        assert result["results"][0] == {
            "path": str(src / "a.txt"),
            "dest": (dst / "a.txt").as_posix(),
            "status": "success",
            "message": "コピー完了",
        }


class TestDeleteNeverLosesData:
    def test_async_folder_delete_moves_whole_folder_to_trash(self, client, tmp_path, fake_trash):
        folder = tmp_path / "folder"
        (folder / "sub").mkdir(parents=True)
        (folder / "x.txt").write_text("1")
        (folder / "sub" / "y.txt").write_text("2")

        task_id = client.post("/api/delete/batch", json={"paths": [str(folder)], "async_mode": True}).json()["task_id"]
        result = wait_for_task(client, task_id)["result"]

        assert result["success_count"] == 1
        assert len(fake_trash.items) == 1
        trashed = fake_trash.items[0][1]
        assert (trashed / "x.txt").read_text() == "1"
        assert (trashed / "sub" / "y.txt").read_text() == "2"

    @pytest.mark.parametrize("async_mode", ASYNC_MODES)
    def test_trash_failure_never_falls_back_to_permanent_delete(self, client, tmp_path, fake_trash, async_mode):
        folder = tmp_path / "folder"
        folder.mkdir()
        (folder / "x.txt").write_text("1")
        single = tmp_path / "single.txt"
        single.write_text("s")
        fake_trash.fail = True

        response = client.post(
            "/api/delete/batch", json={"paths": [str(folder), str(single)], "async_mode": async_mode}
        ).json()
        result = wait_for_task(client, response["task_id"])["result"] if async_mode else response

        assert result["fail_count"] == 2
        assert (folder / "x.txt").read_text() == "1"
        assert single.read_text() == "s"

    def test_single_delete_trash_failure_keeps_file(self, client, tmp_path, fake_trash):
        target = tmp_path / "a.txt"
        target.write_text("x")
        fake_trash.fail = True

        response = client.request("DELETE", "/api/delete", json={"path": str(target)})

        assert response.status_code == 500
        assert target.read_text() == "x"

    def test_single_async_delete_moves_folder_to_trash(self, client, tmp_path, fake_trash):
        folder = tmp_path / "folder"
        folder.mkdir()
        (folder / "x.txt").write_text("1")

        task_id = client.request(
            "DELETE", "/api/delete", json={"path": str(folder), "async_mode": True}
        ).json()["task_id"]
        wait_for_task(client, task_id)

        assert not folder.exists()
        assert (fake_trash.items[0][1] / "x.txt").read_text() == "1"

    def test_network_drive_items_are_deleted_directly(self, client, tmp_path, fake_trash, monkeypatch):
        from app.services import trash

        folder = tmp_path / "share"
        (folder / "sub").mkdir(parents=True)
        (folder / "sub" / "x.txt").write_text("1")
        monkeypatch.setattr(trash, "is_network_path", lambda path: True)

        result = client.post("/api/delete/batch", json={"paths": [str(folder)]}).json()

        assert result["success_count"] == 1
        assert "ネットワーク" in result["results"][0]["message"]
        assert not folder.exists()
        assert fake_trash.items == []


class TestNetworkDriveDetection:
    def test_parse_proc_mounts(self):
        from app.services.trash import parse_proc_mounts

        text = (
            "/dev/sda1 / ext4 rw 0 0\n"
            "//nas/share /mnt/my\\040share cifs rw 0 0\n"
            "server:/export /mnt/nfs nfs4 rw 0 0\n"
        )
        assert parse_proc_mounts(text) == [
            ("/", "ext4"), ("/mnt/my share", "cifs"), ("/mnt/nfs", "nfs4"),
        ]

    def test_parse_macos_mount_output(self):
        from app.services.trash import parse_macos_mount_output

        text = (
            "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n"
            "//user@nas/share on /Volumes/share (smbfs, nodev, nosuid, mounted by user)\n"
            "/dev/disk4s1 on /Volumes/USB DISK (msdos, local, nodev, nosuid, noowners)\n"
        )
        assert parse_macos_mount_output(text) == [
            ("/", "apfs"), ("/Volumes/share", "smbfs"), ("/Volumes/USB DISK", "msdos"),
        ]

    def test_only_network_filesystems_are_network(self, monkeypatch):
        from app import config
        from app.services import trash

        monkeypatch.setattr(config.settings, "is_windows", False)
        monkeypatch.setattr(trash, "_get_mount_table", lambda: [
            ("/", "apfs"), ("/Volumes/share", "smbfs"), ("/Volumes/USB DISK", "msdos"),
        ])
        monkeypatch.setattr(trash.os.path, "realpath", lambda p: p)

        assert trash.is_network_path("/Volumes/share/docs/a.txt") is True
        assert trash.is_network_path("/Volumes/USB DISK/a.txt") is False
        assert trash.is_network_path("/Volumes/shared/a.txt") is False
        assert trash.is_network_path("/Users/me/a.txt") is False

    def test_windows_local_d_drive_is_not_network(self, monkeypatch):
        from app import config
        from app.services import trash

        monkeypatch.setattr(config.settings, "is_windows", True)
        drive_types = {"C:\\": 3, "D:\\": 3, "Z:\\": trash.DRIVE_REMOTE}
        monkeypatch.setattr(trash, "_windows_drive_type", lambda root: drive_types[root])

        assert trash.is_network_path("D:\\data\\a.txt") is False
        assert trash.is_network_path("C:\\Users\\me") is False
        assert trash.is_network_path("Z:\\shared\\a.txt") is True
        assert trash.is_network_path("\\\\server\\share\\a.txt") is True


class TestWritesNeverLoseData:
    def test_upload_does_not_overwrite_existing_file(self, client, tmp_path):
        (tmp_path / "a.txt").write_text("OLD")

        response = client.post(
            "/api/upload",
            params={"path": str(tmp_path)},
            files=[("files", ("a.txt", b"NEW", "text/plain"))],
        )

        assert response.status_code == 200
        assert (tmp_path / "a.txt").read_text() == "OLD"
        assert (tmp_path / "a (1).txt").read_text() == "NEW"
        assert response.json()["uploaded"] == ["a (1).txt"]

    def test_upload_into_existing_folder_keeps_existing_files(self, client, tmp_path):
        (tmp_path / "dir").mkdir()
        (tmp_path / "dir" / "a.txt").write_text("OLD")

        client.post(
            "/api/upload",
            params={"path": str(tmp_path)},
            files=[("files", ("a.txt", b"NEW", "text/plain"))],
            data={"relative_paths": ["dir/a.txt"]},
        )

        assert (tmp_path / "dir" / "a.txt").read_text() == "OLD"
        assert (tmp_path / "dir" / "a (1).txt").read_text() == "NEW"

    def test_update_file_failure_keeps_original_content(self, client, tmp_path, monkeypatch):
        from app.services import fileio

        target = tmp_path / "note.md"
        target.write_text("ORIGINAL")

        def broken_replace(src, dst):
            raise OSError("disk full")

        monkeypatch.setattr(fileio.os, "replace", broken_replace)

        response = client.post("/api/update-file", json={"path": str(target), "content": "NEW"})

        assert response.status_code == 500
        assert target.read_text() == "ORIGINAL"
        assert sorted(p.name for p in tmp_path.iterdir()) == ["note.md"]

    def test_update_file_keeps_symlink_and_updates_target(self, client, tmp_path):
        real = tmp_path / "real.md"
        real.write_text("OLD")
        link = tmp_path / "link.md"
        link.symlink_to(real)

        response = client.post("/api/update-file", json={"path": str(link), "content": "NEW"})

        assert response.status_code == 200
        assert link.is_symlink()
        assert real.read_text() == "NEW"

    def test_update_file_keeps_permissions(self, client, tmp_path):
        target = tmp_path / "run.sh"
        target.write_text("echo old")
        target.chmod(0o755)

        client.post("/api/update-file", json={"path": str(target), "content": "echo new"})

        assert target.read_text() == "echo new"
        assert target.stat().st_mode & 0o777 == 0o755

    @pytest.mark.parametrize("bad_name", ["../escape.txt", "a/b.txt", "..", ""])
    def test_create_file_rejects_names_that_leave_the_folder(self, client, tmp_path, bad_name):
        (tmp_path / "inner").mkdir()

        response = client.post(
            "/api/create-file", json={"path": str(tmp_path / "inner"), "name": bad_name, "content": "x"}
        )

        assert response.status_code == 400
        assert not (tmp_path / "escape.txt").exists()

    def test_create_file_does_not_overwrite(self, client, tmp_path):
        (tmp_path / "a.txt").write_text("OLD")

        response = client.post("/api/create-file", json={"path": str(tmp_path), "name": "a.txt", "content": "NEW"})

        assert response.status_code == 400
        assert (tmp_path / "a.txt").read_text() == "OLD"

    def test_create_folder_rejects_path_separators(self, client, tmp_path):
        response = client.post("/api/create-folder", json={"path": str(tmp_path), "name": "../x"})

        assert response.status_code == 400
        assert not (tmp_path.parent / "x").exists()

    def test_rename_rejects_path_separators(self, client, tmp_path):
        (tmp_path / "inner").mkdir()
        target = tmp_path / "inner" / "a.txt"
        target.write_text("x")

        response = client.post("/api/rename", json={"old_path": str(target), "new_name": "../a.txt"})

        assert response.status_code == 400
        assert target.read_text() == "x"

    def test_rename_does_not_overwrite_existing(self, client, tmp_path):
        (tmp_path / "a.txt").write_text("A")
        (tmp_path / "b.txt").write_text("B")

        response = client.post("/api/rename", json={"old_path": str(tmp_path / "a.txt"), "new_name": "b.txt"})

        assert response.status_code == 400
        assert (tmp_path / "a.txt").read_text() == "A"
        assert (tmp_path / "b.txt").read_text() == "B"
