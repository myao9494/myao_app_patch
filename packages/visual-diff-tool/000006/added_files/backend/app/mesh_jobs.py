"""
3Dメッシュ差分 非同期ジョブマネージャー仕様。
- 重いSTEP解析・テッセレーション・距離計算を子プロセス（multiprocessing.Process, spawn方式）で分離実行
- アップロードされたSTEPファイルはメッシュ化完了直後に削除
- 計算結果（VDM1バイナリおよびステータスJSON）は一時保存ディレクトリに保持（デフォルト60分）
- 有効期限切れジョブの自動クリーンアップおよび起動時の孤立ディレクトリ削除を提供
- ジョブIDは uuid4 の16進32文字に限定する（`..` などでジョブ領域外を読み書き・削除させない）
"""

from __future__ import annotations

import importlib.util
import json
import multiprocessing as mp
import os
import re
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable
from uuid import uuid4

DEFAULT_RETENTION_MINUTES = 60
REQUIRED_MODULES = ("OCP", "trimesh", "scipy", "rtree")
QUALITY_MODES = ("coarse", "standard", "fine")
ALIGN_MODES = ("auto", "none", "centroid", "fit")
JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")

# fork はサーバーのスレッド（uvicorn・ThreadPoolExecutor）を引き継いでデッドロックし得るため、
# OSに依らず spawn を使う（macOS / Windows では元々の既定値）。
_MP_CONTEXT = mp.get_context("spawn")


def check_3d_availability() -> dict:
    """3D差分に必要なライブラリが環境に揃っているかを検査する。"""
    missing = [name for name in REQUIRED_MODULES if importlib.util.find_spec(name) is None]
    return {
        "available": not missing,
        "missing": missing,
        "install_hint": ".venv/bin/python -m pip install -r requirements-3d.txt",
    }


def is_valid_job_id(job_id: str) -> bool:
    return bool(JOB_ID_RE.fullmatch(job_id or ""))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _mesh_stats(mesh, vertex_count: int, face_count: int) -> dict:
    return {
        "vertex_count": int(vertex_count),
        "face_count": int(face_count),
        "unit": mesh.unit,
        "solid_count": mesh.solid_count,
    }


def _mesh_meta(side: str, filename: str, mesh) -> dict:
    return {"side": side, "filename": filename, "unit": mesh.unit, "solid_count": mesh.solid_count}


def _run_single_job(
    job_dir: Path,
    side: str,
    step_path: Path,
    filename: str,
    quality: str,
    linear_deflection: float | None,
    write_status: Callable[[dict], None],
) -> None:
    """片側だけのSTEP（Gitの新規追加 = new / 削除 = old）を単体プレビュー用にメッシュ化する。"""
    import numpy as np

    from .mesh_diff import pack_mesh_binary
    from .step_mesh import load_step_single_as_mesh

    result = load_step_single_as_mesh(
        step_path,
        quality=quality,
        linear_deflection=linear_deflection,
        progress=lambda stage, fraction: write_status(_running_status(stage, fraction)),
        label=filename,
    )
    step_path.unlink(missing_ok=True)
    mesh = result.mesh
    # 比較相手がないため、全頂点の距離0（＝変更なしのグレー表示）として送る。
    distances = np.zeros(len(mesh.vertices), dtype=np.float32)
    binary = pack_mesh_binary(mesh.vertices, mesh.faces, distances, _mesh_meta(side, filename, mesh))
    (job_dir / f"{side}_mesh.vdm1").write_bytes(binary)
    write_status({
        "status": "done",
        "stage": "完了",
        "progress": 1.0,
        "single_mode": side,
        "warnings": result.warnings,
        "error": None,
        "stats": {
            "linear_deflection": result.linear_deflection,
            "angular_deflection": result.angular_deflection,
            "alignment": {"applied": "none"},
            side: _mesh_stats(mesh, len(mesh.vertices), len(mesh.faces)),
        },
        "finished_at": _now_iso(),
    })


def _run_pair_job(
    job_dir: Path,
    old_step_path: Path,
    new_step_path: Path,
    old_filename: str,
    new_filename: str,
    quality: str,
    align_mode: str,
    linear_deflection: float | None,
    write_status: Callable[[dict], None],
) -> None:
    from .mesh_diff import compute_mesh_diff, pack_mesh_binary
    from .step_mesh import load_step_pair_as_meshes

    # 段階1: STEP読み込みとメッシュ化（進捗 0〜45%）
    pair = load_step_pair_as_meshes(
        old_step_path,
        new_step_path,
        quality=quality,
        linear_deflection=linear_deflection,
        progress=lambda stage, fraction: write_status(_running_status(stage, fraction * 0.45)),
        old_label=old_filename,
        new_label=new_filename,
    )

    # 変換完了直後に元STEPファイルを削除（容量削減・機密保護）
    old_step_path.unlink(missing_ok=True)
    new_step_path.unlink(missing_ok=True)

    # 段階2 & 3: 位置合わせと距離算出（進捗 45〜95%）
    diff_result = compute_mesh_diff(
        pair.old.vertices,
        pair.old.faces,
        pair.new.vertices,
        pair.new.faces,
        tolerance=pair.linear_deflection,
        align_mode=align_mode,
        quality=quality,
        progress=lambda stage, fraction: write_status(_running_status(stage, 0.45 + fraction * 0.50, pair.warnings)),
    )

    old_bin = pack_mesh_binary(
        diff_result.old.vertices, diff_result.old.faces, diff_result.old.distances, _mesh_meta("old", old_filename, pair.old)
    )
    new_bin = pack_mesh_binary(
        diff_result.new.vertices, diff_result.new.faces, diff_result.new.distances, _mesh_meta("new", new_filename, pair.new)
    )
    (job_dir / "old_mesh.vdm1").write_bytes(old_bin)
    (job_dir / "new_mesh.vdm1").write_bytes(new_bin)

    alignment = diff_result.alignment
    write_status({
        "status": "done",
        "stage": "完了",
        "progress": 1.0,
        "warnings": list(pair.warnings) + list(diff_result.warnings),
        "error": None,
        "stats": {
            "linear_deflection": pair.linear_deflection,
            "angular_deflection": pair.angular_deflection,
            "alignment": {
                "matrix": alignment.matrix.tolist(),
                "applied": alignment.applied,
                "inlier_ratio": float(alignment.inlier_ratio),
                "rms": float(alignment.rms),
                "translation": alignment.translation,
                "rotation_deg": float(alignment.rotation_deg),
            },
            "old": _mesh_stats(pair.old, len(diff_result.old.vertices), len(diff_result.old.faces)),
            "new": _mesh_stats(pair.new, len(diff_result.new.vertices), len(diff_result.new.faces)),
        },
        "finished_at": _now_iso(),
    })


def _running_status(stage: str, progress: float, warnings: list[str] | None = None) -> dict:
    return {
        "status": "running",
        "stage": stage,
        "progress": round(progress, 3),
        "warnings": list(warnings or []),
        "error": None,
        "stats": None,
    }


def _worker_entrypoint(
    job_dir_str: str,
    old_step_str: str,
    new_step_str: str,
    old_filename: str,
    new_filename: str,
    quality: str,
    align_mode: str,
    linear_deflection: float | None,
) -> None:
    """子プロセス内で実行されるジョブワーカー。片側だけ指定された場合は単体プレビューを作る。"""
    job_dir = Path(job_dir_str)
    status_file = job_dir / "status.json"
    old_step_path = Path(old_step_str) if old_step_str else None
    new_step_path = Path(new_step_str) if new_step_str else None

    def write_status(data: dict) -> None:
        tmp = job_dir / f"status_{uuid4().hex}.tmp"
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        tmp.replace(status_file)

    def remove_inputs() -> None:
        for path in (old_step_path, new_step_path):
            if path is not None:
                path.unlink(missing_ok=True)

    has_old = old_step_path is not None and old_step_path.exists()
    has_new = new_step_path is not None and new_step_path.exists()
    try:
        if has_new and not has_old:
            _run_single_job(job_dir, "new", new_step_path, new_filename, quality, linear_deflection, write_status)
        elif has_old and not has_new:
            _run_single_job(job_dir, "old", old_step_path, old_filename, quality, linear_deflection, write_status)
        else:
            _run_pair_job(
                job_dir,
                old_step_path,
                new_step_path,
                old_filename,
                new_filename,
                quality,
                align_mode,
                linear_deflection,
                write_status,
            )
    except Exception as exc:  # 子プロセスの失敗は必ず status.json に残し、UIへ原因を表示する
        remove_inputs()
        write_status(_error_status(_job_error_message(exc)))


def _job_error_message(exc: Exception) -> str:
    from .step_mesh import StepConversionError

    # StepConversionError は「旧ファイル(名前): 原因」形式なので、そのままUIへ表示する。
    if isinstance(exc, StepConversionError):
        return str(exc)
    return f"3D差分処理中にエラーが発生しました: {exc}"


def _error_status(message: str) -> dict:
    return {
        "status": "error",
        "stage": "エラー",
        "progress": 0.0,
        "warnings": [],
        "error": message,
        "stats": None,
        "finished_at": _now_iso(),
    }


class MeshDiffJobManager:
    """3D差分ジョブのライフサイクルおよび一時ファイルの保持・削除を管理する。"""

    def __init__(self, base_dir: Path | None = None, retention_minutes: int | None = None):
        if base_dir is None:
            self.base_dir = Path(__file__).resolve().parents[1] / ".mesh_jobs"
        else:
            self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)

        if retention_minutes is not None:
            self.retention_minutes = int(retention_minutes)
        else:
            env_val = os.environ.get("VISUAL_DIFF_3D_RETENTION_MINUTES")
            self.retention_minutes = int(env_val) if env_val else DEFAULT_RETENTION_MINUTES

        self._processes: dict[str, mp.process.BaseProcess] = {}
        # 起動時に以前の実行で残った孤立ジョブを全削除する
        self._cleanup_all_on_startup()

    def _cleanup_all_on_startup(self) -> None:
        if not self.base_dir.exists():
            return
        for item in self.base_dir.iterdir():
            if item.is_dir():
                shutil.rmtree(item, ignore_errors=True)

    def job_dir(self, job_id: str) -> Path:
        """ジョブIDに対応するディレクトリ。不正なIDは ValueError（ジョブ領域外を指させない）。"""
        if not is_valid_job_id(job_id):
            raise ValueError(f"invalid job id: {job_id!r}")
        return self.base_dir / job_id

    def create_job(
        self,
        old_filename: str,
        old_content: bytes,
        new_filename: str,
        new_content: bytes,
        *,
        quality: str = "standard",
        align_mode: str = "auto",
        linear_deflection: float | None = None,
    ) -> str:
        """新しい差分ジョブを作成し、子プロセスで実行を開始する。片側が空なら単体プレビューになる。"""
        self.cleanup_expired()
        job_id = uuid4().hex
        j_dir = self.job_dir(job_id)
        j_dir.mkdir(parents=True, exist_ok=True)

        def store_input(prefix: str, content: bytes) -> str:
            if not content:
                return ""
            path = j_dir / f"{prefix}_{uuid4().hex[:8]}.step"
            path.write_bytes(content)
            return str(path)

        old_step_path_str = store_input("input_old", old_content)
        new_step_path_str = store_input("input_new", new_content)

        initial_status = _running_status("ジョブ開始", 0.0)
        initial_status["created_at"] = _now_iso()
        (j_dir / "status.json").write_text(json.dumps(initial_status, ensure_ascii=False), encoding="utf-8")

        proc = _MP_CONTEXT.Process(
            target=_worker_entrypoint,
            args=(
                str(j_dir),
                old_step_path_str,
                new_step_path_str,
                old_filename,
                new_filename,
                quality,
                align_mode,
                linear_deflection,
            ),
            daemon=True,
        )
        proc.start()
        self._processes[job_id] = proc
        return job_id

    def get_status(self, job_id: str) -> dict | None:
        """ジョブの現在のステータスを返す。存在しない（または不正なID）場合はNone。"""
        if not is_valid_job_id(job_id):
            return None
        status_file = self.job_dir(job_id) / "status.json"
        if not status_file.exists():
            return None
        try:
            data = json.loads(status_file.read_text(encoding="utf-8"))
        except Exception:
            return None

        # プロセスが状態を書けずに終了した場合（クラッシュ等）はエラーとして確定させる
        if data.get("status") == "running":
            proc = self._processes.get(job_id)
            if proc and not proc.is_alive() and proc.exitcode != 0:
                data["status"] = "error"
                data["error"] = f"3D差分処理プロセスが異常終了しました（終了コード: {proc.exitcode}）。"
                data["finished_at"] = _now_iso()
                status_file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

        data["job_id"] = job_id
        data["retention_minutes"] = self.retention_minutes
        return data

    def get_mesh_binary(self, job_id: str, side: str) -> bytes | None:
        """指定側のVDM1バイナリを取得する。"""
        if side not in ("old", "new") or not is_valid_job_id(job_id):
            return None
        bin_path = self.job_dir(job_id) / f"{side}_mesh.vdm1"
        if not bin_path.exists():
            return None
        return bin_path.read_bytes()

    def delete_job(self, job_id: str) -> bool:
        """ジョブのファイルおよびプロセスを破棄する。"""
        if not is_valid_job_id(job_id):
            return False
        return self._remove(job_id, self.job_dir(job_id))

    def _remove(self, job_id: str, j_dir: Path) -> bool:
        proc = self._processes.pop(job_id, None)
        if proc and proc.is_alive():
            proc.terminate()
            proc.join(timeout=5)
        if j_dir.exists():
            shutil.rmtree(j_dir, ignore_errors=True)
            return True
        return False

    def _reap_finished_processes(self) -> None:
        """終了済みの子プロセスを回収し、プロセス表が増え続けないようにする（結果は status.json に残る）。"""
        for job_id, proc in list(self._processes.items()):
            if proc.is_alive():
                continue
            proc.join(timeout=0)
            # 状態が running のまま終了したもの（クラッシュ）は、get_status が exitcode を参照するので残す。
            if self._read_status_value(job_id) != "running":
                self._processes.pop(job_id, None)

    def _read_status_value(self, job_id: str) -> str | None:
        try:
            data = json.loads((self.base_dir / job_id / "status.json").read_text(encoding="utf-8"))
        except Exception:
            return None
        return data.get("status")

    def cleanup_expired(self) -> int:
        """保持期間を経過したジョブを削除する。"""
        self._reap_finished_processes()
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=self.retention_minutes)
        removed = 0
        if not self.base_dir.exists():
            return removed

        for j_dir in list(self.base_dir.iterdir()):
            if not j_dir.is_dir():
                continue
            status_file = j_dir / "status.json"
            should_remove = False
            if status_file.exists():
                try:
                    data = json.loads(status_file.read_text(encoding="utf-8"))
                    ts_str = data.get("finished_at") or data.get("created_at")
                    if ts_str and datetime.fromisoformat(ts_str) < cutoff:
                        should_remove = True
                except Exception:
                    should_remove = True
            else:
                should_remove = True

            if should_remove:
                self._remove(j_dir.name, j_dir)
                removed += 1
        return removed

    def register_finished_job_for_test(self, finished_at: datetime) -> str:
        """テスト用: 終了済みジョブを直接生成する。"""
        job_id = uuid4().hex
        j_dir = self.job_dir(job_id)
        j_dir.mkdir(parents=True, exist_ok=True)
        status = {
            "status": "done",
            "stage": "完了",
            "progress": 1.0,
            "warnings": [],
            "error": None,
            "stats": {},
            "finished_at": finished_at.isoformat(),
        }
        (j_dir / "status.json").write_text(json.dumps(status, ensure_ascii=False), encoding="utf-8")
        return job_id
