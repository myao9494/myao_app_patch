"""storage.py（バックアップ・アップロード）と system_open.py（コマンド整形）の単体テスト"""
import os
import time
from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from backend import storage, system_open
from backend.main import app

client = TestClient(app)


def _set_mtime(path, when: datetime):
    timestamp = when.timestamp()
    os.utime(path, (timestamp, timestamp))


class TestCreateBackup:
    def test_no_backup_for_new_file(self, tmp_path):
        assert storage.create_backup(str(tmp_path / "new.excalidraw")) is True
        assert not (tmp_path / "backup").exists()

    def test_auto_backup_at_most_every_10_minutes(self, tmp_path):
        drawing = tmp_path / "a.excalidraw"
        drawing.write_text("{}", encoding="utf-8")

        storage.create_backup(str(drawing))
        storage.create_backup(str(drawing))
        assert len(list((tmp_path / "backup").iterdir())) == 1

        # 手動保存（force）は間隔に関係なく作り、同じ秒でも上書きしない
        storage.create_backup(str(drawing), force=True)
        storage.create_backup(str(drawing), force=True)
        assert len(list((tmp_path / "backup").iterdir())) == 3

    def test_old_backups_are_pruned(self, tmp_path):
        drawing = tmp_path / "a.excalidraw"
        drawing.write_text("{}", encoding="utf-8")
        backup_dir = tmp_path / "backup"
        backup_dir.mkdir()

        now = datetime.now()
        too_old = backup_dir / "a_backup_old.excalidraw"
        yesterday_early = backup_dir / "a_backup_y1.excalidraw"
        yesterday_late = backup_dir / "a_backup_y2.excalidraw"
        for path in (too_old, yesterday_early, yesterday_late):
            path.write_text("{}", encoding="utf-8")
        _set_mtime(too_old, now - timedelta(days=15))
        _set_mtime(yesterday_early, now - timedelta(days=1, hours=2))
        _set_mtime(yesterday_late, now - timedelta(days=1, hours=1))

        storage.create_backup(str(drawing))

        remaining = {path.name for path in backup_dir.iterdir()}
        assert "a_backup_old.excalidraw" not in remaining  # 2週間より古い
        assert "a_backup_y1.excalidraw" not in remaining  # 前日の最新以外
        assert "a_backup_y2.excalidraw" in remaining
        assert len(remaining) == 2  # 前日の最新 + 今回


class TestUploadHelpers:
    def test_upload_directory_next_to_drawing(self, tmp_path):
        drawing = tmp_path / "a.excalidraw"
        assert storage.get_upload_directory(str(drawing), "email") == tmp_path / "uploads" / "emails"
        assert storage.get_upload_directory(str(drawing), "other") == tmp_path / "uploads" / "files"

    def test_relative_path_from_drawing(self, tmp_path):
        drawing = tmp_path / "a.excalidraw"
        target = tmp_path / "uploads" / "files" / "x.pdf"
        assert storage.compute_relative_path(str(drawing), str(target)) == "uploads/files/x.pdf"
        assert storage.compute_relative_path("localStorage", str(target)) == str(target)

    def test_sanitize_filename(self):
        assert storage.sanitize_filename('a<b>:c"d/e\\f|g?h*') == "a_b__c_d_e_f_g_h_"
        assert storage.sanitize_filename(" . ") == "untitled"

    def test_unique_timestamped_path_does_not_overwrite(self, tmp_path):
        first = storage.unique_timestamped_path(tmp_path, "a", ".txt", "123")
        first.write_text("1")
        second = storage.unique_timestamped_path(tmp_path, "a", ".txt", "123")
        assert first.name == "a_123.txt"
        assert second.name == "a_123_1.txt"

    def test_same_name_uploads_in_same_second_are_both_kept(self, tmp_path):
        drawing = tmp_path / "a.excalidraw"
        paths = []
        for content in (b"first", b"second"):
            response = client.post(
                "/api/upload-files",
                data={"current_path": str(drawing), "file_type": "general"},
                files={"files": ("same.txt", content)},
            )
            assert response.status_code == 200
            paths.append(response.json()["files"][0]["path"])

        assert paths[0] != paths[1]
        assert sorted((tmp_path / p).read_bytes() for p in paths) == [b"first", b"second"]


def test_archive_file_moves_to_backup(tmp_path):
    drawing = tmp_path / "a.excalidraw"
    drawing.write_text("{}", encoding="utf-8")

    body = client.post("/api/archive-file", json={"filepath": str(drawing)}).json()

    assert body["success"] is True
    assert not drawing.exists()
    assert (tmp_path / "backup" / os.path.basename(body["archivedPath"])).exists()


class TestCommandNormalization:
    def test_strip_cmd_prefix(self):
        assert system_open.strip_cmd_prefix("cmd python a.py") == "python a.py"
        assert system_open.strip_cmd_prefix("  CMD   ls ") == "ls"
        assert system_open.strip_cmd_prefix("cmd") == ""
        assert system_open.strip_cmd_prefix("cmdline") == "cmdline"
        assert system_open.strip_cmd_prefix(None) == ""

    def test_full_width_quote_is_normalized(self):
        assert system_open.normalize_command_for_platform("python ＂a b.py＂") == 'python "a b.py"'

    def test_normalize_filepath_strips_quotes_and_expands_home(self):
        assert system_open.normalize_filepath('  "~/x"  ') == os.path.expanduser("~/x")

    def test_run_command_rejects_missing_working_directory(self, tmp_path):
        response = client.post(
            "/api/run-command",
            json={"command": "cmd echo hi", "working_directory": str(tmp_path / "missing")},
        )
        assert response.status_code == 400


def test_file_info_is_lightweight(tmp_path):
    drawing = tmp_path / "a.excalidraw"
    drawing.write_text('{"elements": []}', encoding="utf-8")
    time.sleep(0.01)

    body = client.get("/api/file-info", params={"filepath": str(drawing)}).json()

    assert body == {"modified": drawing.stat().st_mtime, "exists": True, "isExcalidraw": False}
