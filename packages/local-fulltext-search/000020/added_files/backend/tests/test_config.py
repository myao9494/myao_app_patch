"""
起動設定の既定値を検証する。
意図せず既定ポートが変わらないように固定する。
"""

from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import Settings
from app.config import settings as app_settings
from app.db.connection import ensure_data_dir


def test_settings_default_bind_port_is_8079() -> None:
    """
    環境変数未指定時の既定ポートは 8079 を使う。
    """
    assert Settings.model_fields["bind_port"].default == 8079


def test_settings_default_database_path_does_not_depend_on_cwd(monkeypatch, tmp_path: Path) -> None:
    """
    既定の DB 保存先は起動ディレクトリに依存せず、backend/data/search.db を指す。
    """
    expected = (Path(__file__).resolve().parents[1] / "data" / "search.db").resolve()

    monkeypatch.chdir(tmp_path)

    assert Settings().database_path == expected


def test_settings_default_exclude_keywords_path_does_not_depend_on_cwd(monkeypatch, tmp_path: Path) -> None:
    """
    既定の除外キーワード保存先は起動ディレクトリに依存せず、backend/data/exclude_keywords.txt を指す。
    """
    expected = (Path(__file__).resolve().parents[1] / "data" / "exclude_keywords.txt").resolve()

    monkeypatch.chdir(tmp_path)

    assert Settings().exclude_keywords_path == expected


def test_settings_default_synonym_groups_path_does_not_depend_on_cwd(monkeypatch, tmp_path: Path) -> None:
    """
    既定の同義語リスト保存先は起動ディレクトリに依存せず、backend/data/synonym_groups.txt を指す。
    """
    expected = (Path(__file__).resolve().parents[1] / "data" / "synonym_groups.txt").resolve()

    monkeypatch.chdir(tmp_path)

    assert Settings().synonym_groups_path == expected


def test_settings_default_search_target_folders_path_does_not_depend_on_cwd(monkeypatch, tmp_path: Path) -> None:
    """
    既定の検索対象フォルダ保存先は起動ディレクトリに依存せず、backend/data/search_target_folders.txt を指す。
    """
    expected = (Path(__file__).resolve().parents[1] / "data" / "search_target_folders.txt").resolve()

    monkeypatch.chdir(tmp_path)

    assert Settings().search_target_folders_path == expected


def test_settings_relative_paths_are_normalized_to_absolute_stable_locations() -> None:
    """
    設定のパス項目は相対指定でも内部では安定した絶対パスへ正規化する。
    """
    backend_dir = Path(__file__).resolve().parents[1]
    project_root_dir = backend_dir.parent
    settings = Settings(
        data_dir=Path("custom-data"),
        frontend_dist_dir=Path("frontend/custom-dist"),
    )

    assert settings.data_dir == (backend_dir / "custom-data").resolve()
    assert settings.frontend_dist_dir == (project_root_dir / "frontend/custom-dist").resolve()


def test_data_file_paths_are_resolved_only_once(monkeypatch, tmp_path: Path) -> None:
    """
    設定は検索のたびに読むため、同じパスの解決を繰り返さない（Windows の resolve は 1 回で数ミリ秒かかる）。
    """
    settings = Settings(data_dir=tmp_path)
    original_resolve = Path.resolve
    resolved: list[Path] = []

    def counting_resolve(self: Path, strict: bool = False) -> Path:
        resolved.append(self)
        return original_resolve(self, strict)

    monkeypatch.setattr(Path, "resolve", counting_resolve)

    first = settings.exclude_keywords_path
    second = settings.exclude_keywords_path

    assert first == second == tmp_path.resolve() / "exclude_keywords.txt"
    assert resolved.count(tmp_path / "exclude_keywords.txt") <= 1


def test_data_file_paths_follow_the_current_data_dir(tmp_path: Path) -> None:
    """
    解決結果の再利用が、保存先の変更を隠さない。
    """
    settings = Settings(data_dir=tmp_path / "a")
    assert settings.database_path == (tmp_path / "a" / "search.db").resolve()

    settings.data_dir = tmp_path / "b"

    assert settings.database_path == (tmp_path / "b" / "search.db").resolve()


def test_ensure_data_dir_creates_the_folder_only_when_missing(monkeypatch, tmp_path: Path) -> None:
    """
    設定の読み込みごとに呼ばれるため、フォルダがあれば作成を試みない。無ければ親ごと作る。
    """
    data_dir = tmp_path / "parent" / "data"
    monkeypatch.setattr(app_settings, "data_dir", data_dir)

    ensure_data_dir()
    assert data_dir.is_dir()

    def fail_mkdir(self: Path, *args: object, **kwargs: object) -> None:
        raise AssertionError("既にあるフォルダを作ろうとした")

    monkeypatch.setattr(Path, "mkdir", fail_mkdir)
    ensure_data_dir()


def test_settings_database_name_rejects_path_segments() -> None:
    """
    database_name にはファイル名のみを許可し、パス区切りを混入させない。
    """
    with pytest.raises(ValidationError):
        Settings(database_name="../search.db")


def test_settings_exclude_keywords_name_rejects_path_segments() -> None:
    """
    exclude_keywords_name にはファイル名のみを許可し、パス区切りを混入させない。
    """
    with pytest.raises(ValidationError):
        Settings(exclude_keywords_name="../exclude_keywords.txt")


def test_settings_synonym_groups_name_rejects_path_segments() -> None:
    """
    synonym_groups_name にはファイル名のみを許可し、パス区切りを混入させない。
    """
    with pytest.raises(ValidationError):
        Settings(synonym_groups_name="../synonym_groups.txt")


def test_settings_search_target_folders_name_rejects_path_segments() -> None:
    """
    search_target_folders_name にはファイル名のみを許可し、パス区切りを混入させない。
    """
    with pytest.raises(ValidationError):
        Settings(search_target_folders_name="../search_target_folders.txt")
