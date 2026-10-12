"""
ファイル保存まわりの共通処理

- 原子的な書き込み（書き込み途中で既存ファイルを壊さない）
- 自動バックアップ（backup/ フォルダ、世代管理あり）
- Excalidraw JSON の検証と、ユーザー向けの詳細なエラー情報
- ドロップされたファイルのアップロード先の決定
"""
import json
import logging
import os
import re
import shutil
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import HTTPException

try:
    from .models import JsonErrorResponse, ValidationErrorDetail
except ImportError:  # backend/ をカレントにして `uvicorn main:app` で起動した場合
    from models import JsonErrorResponse, ValidationErrorDetail

logger = logging.getLogger("excalidraw.storage")


def _atomic_write(file_path: Path, content: Any, binary: bool) -> None:
    """一時ファイルへ全内容を書き、権限等を整えてから原子的に置換する。"""
    target_path = file_path.resolve() if file_path.is_symlink() else file_path
    target_path.parent.mkdir(parents=True, exist_ok=True)
    existing_mode = target_path.stat().st_mode & 0o777 if target_path.exists() else None
    fd, temp_name = tempfile.mkstemp(
        dir=target_path.parent,
        prefix=f".{target_path.name}.",
        suffix=".tmp",
    )
    temp_path = Path(temp_name)
    try:
        open_mode = "wb" if binary else "w"
        open_kwargs = {} if binary else {"encoding": "utf-8"}
        with os.fdopen(fd, open_mode, **open_kwargs) as temp_file:
            temp_file.write(content)
            temp_file.flush()
            os.fsync(temp_file.fileno())

        # mkstempの0600をそのまま公開せず、既存権限または従来の新規作成権限へ戻す。
        os.chmod(temp_path, existing_mode if existing_mode is not None else 0o644)

        # Finderタグ等の拡張属性は、OSが対応し権限がある範囲で引き継ぐ。
        if target_path.exists() and hasattr(os, "listxattr"):
            try:
                for attribute in os.listxattr(target_path):
                    os.setxattr(
                        temp_path,
                        attribute,
                        os.getxattr(target_path, attribute),
                    )
            except OSError:
                pass

        os.replace(temp_path, target_path)
    finally:
        if temp_path.exists():
            temp_path.unlink()


def atomic_write_text(file_path: Path, content: str) -> None:
    """テキストを完成後に原子的に置換する。"""
    _atomic_write(file_path, content, binary=False)


def atomic_write_bytes(file_path: Path, content: bytes) -> None:
    """バイナリを完成後に原子的に置換する。"""
    _atomic_write(file_path, content, binary=True)


def clean_surrogates(obj: Any) -> Any:
    """
    サロゲート文字を含むデータをクリーンアップする
    JSONレスポンスでUnicodeEncodeErrorが発生するのを防ぐ
    """
    if isinstance(obj, str):
        # サロゲート文字を置換してクリーンアップ
        return obj.encode('utf-8', errors='surrogatepass').decode('utf-8', errors='replace')
    elif isinstance(obj, dict):
        return {k: clean_surrogates(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [clean_surrogates(item) for item in obj]
    else:
        return obj


def validate_json_with_details(json_str: str) -> tuple[Any, Optional[JsonErrorResponse]]:
    """
    JSON文字列を検証し、詳細なエラー情報を返す

    Returns:
        (data, error): 成功時は(data, None)、失敗時は(None, error_response)
    """
    # ステップ1: JSON構文チェック
    try:
        data = json.loads(json_str)
    except json.JSONDecodeError as e:
        # エラー周辺のコンテキストを抽出（前後3行）
        lines = json_str.split('\n')
        start = max(0, e.lineno - 3)
        end = min(len(lines), e.lineno + 2)
        context_lines = lines[start:end]

        # エラー行にマーカーを追加
        error_idx = e.lineno - 1 - start
        if 0 <= error_idx < len(context_lines):
            context_lines[error_idx] += f"  <-- カラム {e.colno}"

        context = '\n'.join([f"{start+i+1}: {line}" for i, line in enumerate(context_lines)])

        return None, JsonErrorResponse(
            error_type="json_syntax",
            message=f"JSON構文エラー: {e.msg}",
            line=e.lineno,
            column=e.colno,
            context=context
        )

    # ステップ2: 基本構造チェック
    if not isinstance(data, dict):
        return None, JsonErrorResponse(
            error_type="schema",
            message="ExcalidrawファイルはJSONオブジェクトである必要があります"
        )

    if 'elements' not in data:
        return None, JsonErrorResponse(
            error_type="schema",
            message="'elements'フィールドが見つかりません"
        )

    # ステップ3: points フィールドの検証
    validation_errors = []

    for idx, element in enumerate(data.get('elements', [])):
        if not isinstance(element, dict):
            continue

        element_type = element.get('type', 'unknown')
        element_id = element.get('id', f'index-{idx}')

        # line, draw, freedraw タイプは points が必須
        if element_type in ['line', 'draw', 'freedraw']:
            if 'points' not in element:
                validation_errors.append(ValidationErrorDetail(
                    field=f"elements[{idx}] (type={element_type}, id={element_id})",
                    message=f"'{element_type}'タイプの要素には'points'フィールドが必要です"
                ))
                continue

            points = element['points']

            # pointsは配列である必要がある
            if not isinstance(points, list):
                validation_errors.append(ValidationErrorDetail(
                    field=f"elements[{idx}].points",
                    message=f"pointsは配列である必要があります（現在の型: {type(points).__name__}）",
                    value=str(points)[:50]
                ))
                continue

            # 各ポイントの形式チェック
            for pidx, point in enumerate(points):
                if not isinstance(point, list) or len(point) != 2:
                    validation_errors.append(ValidationErrorDetail(
                        field=f"elements[{idx}].points[{pidx}]",
                        message="各ポイントは[x, y]形式の配列である必要があります",
                        value=str(point)[:50]
                    ))
                elif not all(isinstance(c, (int, float)) for c in point):
                    validation_errors.append(ValidationErrorDetail(
                        field=f"elements[{idx}].points[{pidx}]",
                        message="座標は数値である必要があります",
                        value=str(point)[:50]
                    ))

    if validation_errors:
        # 最初の5個のエラーのみ返す
        return None, JsonErrorResponse(
            error_type="validation",
            message=f"{len(validation_errors)}個のバリデーションエラーが見つかりました" +
                   ("（最初の5個を表示）" if len(validation_errors) > 5 else ""),
            details=validation_errors[:5]
        )

    return data, None


def create_empty_scene_data() -> Dict[str, Any]:
    return {
        "type": "excalidraw",
        "version": 2,
        "source": "https://excalidraw.com",
        "elements": [],
        "appState": {
            "viewBackgroundColor": "#ffffff",
            "gridSize": None,
        },
        "files": {},
    }


def load_json_file(file_path: Path) -> Any:
    """
    JSONファイルを読み込み、詳細なバリデーションを実行

    Raises:
        HTTPException: バリデーションエラー時
    """
    with open(file_path, "r", encoding="utf-8") as file:
        json_str = file.read()

    # Empty file handling: return default empty scene
    if not json_str.strip():
        return create_empty_scene_data()

    data, validation_error = validate_json_with_details(json_str)
    if validation_error:
        raise HTTPException(
            status_code=400,
            detail=validation_error.model_dump()
        )

    return data


BACKUP_DIR_NAME = "backup"
AUTO_BACKUP_INTERVAL_SECONDS = 10 * 60
BACKUP_RETENTION_SECONDS = 14 * 24 * 3600


def _list_backups(backup_dir: Path, pattern: str) -> list[tuple[Path, float]]:
    backups = []
    for backup_file in backup_dir.glob(pattern):
        try:
            backups.append((backup_file, backup_file.stat().st_mtime))
        except OSError:
            continue
    return backups


def _remove_quietly(path: Path) -> None:
    try:
        path.unlink()
    except OSError as e:
        logger.warning("Failed to delete old backup %s: %s", path, e)


def create_backup(filepath: str, force: bool = False) -> bool:
    """
    保存前に、既存ファイルを同じフォルダの backup/ にコピーする。

    - force=False（自動保存）: 直近10分以内にバックアップがあれば作らない
    - force=True（手動保存・競合時）: 時間に関係なく作る
    - 2週間より古いバックアップは削除する
    - 今日以外の日は、その日の最新1件だけを残す
    - ファイル名: <元の名前>_backup_YYYYMMDD_HHMMSS[_連番]<拡張子>

    Returns:
        失敗した場合 False（保存自体は続行する）
    """
    try:
        file_path = Path(filepath)
        if not file_path.exists():
            return True

        backup_dir = file_path.parent / BACKUP_DIR_NAME
        backup_dir.mkdir(exist_ok=True)

        base_name = file_path.stem
        extension = file_path.suffix
        pattern = f"{base_name}_backup_*{extension}"
        now = datetime.now()
        now_timestamp = now.timestamp()

        existing_backups = _list_backups(backup_dir, pattern)
        if not force and existing_backups:
            latest_backup_time = max(backup_time for _, backup_time in existing_backups)
            if now_timestamp - latest_backup_time < AUTO_BACKUP_INTERVAL_SECONDS:
                return True

        for backup_file, backup_time in existing_backups:
            if backup_time < now_timestamp - BACKUP_RETENTION_SECONDS:
                _remove_quietly(backup_file)

        daily_backups: Dict[Any, list[tuple[Path, float]]] = {}
        for backup_file, backup_time in _list_backups(backup_dir, pattern):
            daily_backups.setdefault(datetime.fromtimestamp(backup_time).date(), []).append(
                (backup_file, backup_time)
            )
        for backup_date, day_backups in daily_backups.items():
            if backup_date != now.date() and len(day_backups) > 1:
                day_backups.sort(key=lambda item: item[1])
                for backup_file, _ in day_backups[:-1]:
                    _remove_quietly(backup_file)

        timestamp_str = now.strftime("%Y%m%d_%H%M%S")
        backup_path = backup_dir / f"{base_name}_backup_{timestamp_str}{extension}"
        # 同じ秒に複数回保存しても、既存バックアップを上書きしない
        collision_index = 1
        while backup_path.exists():
            backup_path = backup_dir / f"{base_name}_backup_{timestamp_str}_{collision_index}{extension}"
            collision_index += 1

        shutil.copy2(file_path, backup_path)
        return True

    except Exception as e:
        logger.error("Error creating backup: %s", e)
        return False


def get_upload_directory(current_path: str, file_type: str = "general") -> Path:
    """
    ドロップされたファイルの保存先フォルダを返す（なければ作る）。

    - 図面を開いている場合: <図面のフォルダ>/uploads/<種類>/
    - localStorage モードの場合: <プロジェクト>/upload_local/<種類>/
    """
    if not current_path or current_path.startswith("localStorage"):
        upload_dir = Path(__file__).parent.parent / "upload_local"
    else:
        upload_dir = Path(current_path).parent / "uploads"

    subfolder = {"email": "emails", "image": "images", "folder": "folders"}.get(file_type, "files")
    upload_dir = upload_dir / subfolder
    upload_dir.mkdir(parents=True, exist_ok=True)
    return upload_dir


def compute_relative_path(current_path: str, target_path: str) -> str:
    """
    図面ファイルのフォルダから見た相対パス（区切りは /）を返す。
    localStorage モードや、別ドライブなど相対パスにできない場合は絶対パスを返す。
    """
    if not current_path or current_path.startswith("localStorage"):
        return target_path
    try:
        return os.path.relpath(Path(target_path), Path(current_path).parent).replace("\\", "/")
    except ValueError:
        return target_path


def sanitize_filename(filename: str) -> str:
    """ファイル名に使えない文字を _ に置き換える。空になった場合は untitled。"""
    filename = re.sub(r'[<>:"/\\|?*]', "_", filename).strip(" .")
    return filename or "untitled"


def unique_timestamped_path(directory: Path, stem: str, extension: str, timestamp: str) -> Path:
    """<stem>_<timestamp><ext> を返す。既に存在する場合は _1, _2 ... を付けて上書きを防ぐ。"""
    candidate = directory / f"{stem}_{timestamp}{extension}"
    index = 1
    while candidate.exists():
        candidate = directory / f"{stem}_{timestamp}_{index}{extension}"
        index += 1
    return candidate
