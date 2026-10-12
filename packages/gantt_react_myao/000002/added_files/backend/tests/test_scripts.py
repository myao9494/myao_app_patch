"""
運用スクリプト（負荷テスト用データ生成・CSVからの復元）とDB設定のテスト。
スクリプトは SessionLocal を直接使うが、conftest.py により一時DBへ隔離されている。
"""
from pathlib import Path

import pytest

import database
import generate_load_test_data
import restore_from_csv
from models import Link as LinkModel
from models import Task as TaskModel


def test_default_database_is_backend_gantt_db_regardless_of_cwd():
    backend_dir = Path(database.__file__).resolve().parent

    assert database.DEFAULT_DATABASE_URL == f"sqlite:///{(backend_dir / 'gantt.db').as_posix()}"


def test_tests_never_connect_to_default_database():
    assert str(database.engine.url) != database.DEFAULT_DATABASE_URL


# --- 負荷テスト用データ生成 ---

def test_generate_load_test_data_adds_tasks_without_deleting_existing_ones(db):
    generate_load_test_data.generate_data(300)

    assert db.query(TaskModel).count() == 301
    assert db.query(TaskModel).filter(TaskModel.kind_task == 2).count() == 10
    assert db.get(TaskModel, 1).text == "Current"


# --- CSVからの復元 ---

@pytest.fixture
def backup_dir(tmp_path) -> Path:
    directory = tmp_path / "vault" / "70_gantt_csv"
    directory.mkdir(parents=True)
    return directory


@pytest.fixture(autouse=True)
def current_data(db):
    db.add_all([
        TaskModel(id=1, text="Current", start_date="2026-01-01 00:00:00", end_date="2026-01-02 00:00:00"),
        LinkModel(id=1, source=1, target=1, type=0),
    ])
    db.commit()


TASKS_BACKUP = (
    "﻿id,text,start_date,end_date,duration,progress,parent,kind_task,sortorder,is_pinned\n"
    "10,Restored A,2026-02-01 00:00:00,2026-02-03 00:00:00,2,0.5,0,2,0,1\n"
    "11,Restored B,2026-02-01 00:00:00,2026-02-02 00:00:00,1,0,10,1,0,0\n"
)


def test_restore_replaces_tasks_and_links_from_backup(db, tmp_path, backup_dir):
    (backup_dir / "gantt_tasks.csv").write_text(TASKS_BACKUP, encoding="utf-8")
    (backup_dir / "gantt_links.csv").write_text("id,source,target,type\n5,10,11,0\n", encoding="utf-8")

    assert restore_from_csv.restore(str(tmp_path / "vault")) is True

    db.expire_all()
    tasks = db.query(TaskModel).order_by(TaskModel.id).all()
    assert [(task.id, task.text, task.parent, task.is_pinned) for task in tasks] == [
        (10, "Restored A", 0, 1),
        (11, "Restored B", 10, 0),
    ]
    links = db.query(LinkModel).all()
    assert [(link.id, link.source, link.target) for link in links] == [(5, 10, 11)]


def test_restore_clears_links_when_links_backup_is_missing(db, tmp_path, backup_dir):
    (backup_dir / "gantt_tasks.csv").write_text(TASKS_BACKUP, encoding="utf-8")

    assert restore_from_csv.restore(str(tmp_path / "vault")) is True

    db.expire_all()
    assert db.query(LinkModel).count() == 0


def test_restore_without_backup_file_changes_nothing(db, tmp_path):
    assert restore_from_csv.restore(str(tmp_path / "vault")) is False

    db.expire_all()
    assert [task.text for task in db.query(TaskModel).all()] == ["Current"]


def test_failed_restore_keeps_current_data(db, tmp_path, backup_dir):
    duplicated_ids = TASKS_BACKUP + "10,Duplicated,2026-02-01 00:00:00,2026-02-02 00:00:00,1,0,0,1,0,0\n"
    (backup_dir / "gantt_tasks.csv").write_text(duplicated_ids, encoding="utf-8")

    assert restore_from_csv.restore(str(tmp_path / "vault")) is False

    db.expire_all()
    assert [task.text for task in db.query(TaskModel).all()] == ["Current"]
    assert db.query(LinkModel).count() == 1
