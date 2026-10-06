"""
3Dメッシュ差分 非同期ジョブマネージャー仕様。
- 重いSTEP解析・テッセレーション・距離計算を子プロセス（multiprocessing.Process）で分離実行
- アップロードされたSTEPファイルはメッシュ化完了直後に削除
- 計算結果（VDM1バイナリおよびステータスJSON）は一時保存ディレクトリに保持（デフォルト60分）
- 有効期限切れジョブの自動クリーンアップおよび起動時の孤立ディレクトリ削除を提供
"""

from __future__ import annotations

import importlib.util
import json
import multiprocessing as mp
import os
import shutil
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

DEFAULT_RETENTION_MINUTES = 60
REQUIRED_MODULES = ("OCP", "trimesh", "scipy", "rtree")


def check_3d_availability() -> dict:
    """3D差分に必要なライブラリが環境に揃っているかを検査する。"""
    missing = [name for name in REQUIRED_MODULES if importlib.util.find_spec(name) is None]
    available = len(missing) == 0
    return {
        "available": available,
        "missing": missing,
        "install_hint": ".venv/bin/python -m pip install -r requirements-3d.txt",
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
    """子プロセス内で実行されるジョブワーカー。"""
    job_dir = Path(job_dir_str)
    status_file = job_dir / "status.json"
    old_step_path = Path(old_step_str)
    new_step_path = Path(new_step_str)

    def write_status(data: dict) -> None:
        tmp = job_dir / f"status_{uuid4().hex}.tmp"
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        tmp.replace(status_file)

    try:
        from .mesh_diff import compute_mesh_diff, pack_mesh_binary
        from .step_mesh import StepConversionError, load_step_pair_as_meshes

        # 段階1: STEP読み込みとメッシュ化
        def on_step_progress(stage: str, fraction: float) -> None:
            write_status({
                "status": "running",
                "stage": stage,
                "progress": round(fraction * 0.45, 3),
                "warnings": [],
                "error": None,
                "stats": None,
            })

        pair = load_step_pair_as_meshes(
            old_step_path,
            new_step_path,
            quality=quality,
            linear_deflection=linear_deflection,
            progress=on_step_progress,
            old_label=old_filename,
            new_label=new_filename,
        )

        # 変換完了直後に元STEPファイルを削除（容量削減・機密保護）
        old_step_path.unlink(missing_ok=True)
        new_step_path.unlink(missing_ok=True)

        # 段階2 & 3: 位置合わせと距離算出
        def on_diff_progress(stage: str, fraction: float) -> None:
            write_status({
                "status": "running",
                "stage": stage,
                "progress": round(0.45 + fraction * 0.50, 3),
                "warnings": pair.warnings,
                "error": None,
                "stats": None,
            })

        diff_result = compute_mesh_diff(
            pair.old.vertices,
            pair.old.faces,
            pair.new.vertices,
            pair.new.faces,
            tolerance=pair.linear_deflection,
            align_mode=align_mode,
            progress=on_diff_progress,
        )

        # バイナリ保存（VDM1）
        old_meta = {
            "side": "old",
            "filename": old_filename,
            "unit": pair.old.unit,
            "solid_count": pair.old.solid_count,
        }
        new_meta = {
            "side": "new",
            "filename": new_filename,
            "unit": pair.new.unit,
            "solid_count": pair.new.solid_count,
        }
        old_bin = pack_mesh_binary(diff_result.old.vertices, diff_result.old.faces, diff_result.old.distances, old_meta)
        new_bin = pack_mesh_binary(diff_result.new.vertices, diff_result.new.faces, diff_result.new.distances, new_meta)
        (job_dir / "old_mesh.vdm1").write_bytes(old_bin)
        (job_dir / "new_mesh.vdm1").write_bytes(new_bin)

        # 完了ステータスの記録
        all_warnings = list(pair.warnings) + list(diff_result.warnings)
        stats = {
            "linear_deflection": pair.linear_deflection,
            "angular_deflection": pair.angular_deflection,
            "alignment": {
                "matrix": diff_result.alignment.matrix.tolist(),
                "applied": diff_result.alignment.applied,
                "inlier_ratio": float(diff_result.alignment.inlier_ratio),
                "rms": float(diff_result.alignment.rms),
                "translation": diff_result.alignment.translation,
                "rotation_deg": float(diff_result.alignment.rotation_deg),
            },
            "old": {
                "vertex_count": int(len(diff_result.old.vertices)),
                "face_count": int(len(diff_result.old.faces)),
                "unit": pair.old.unit,
                "solid_count": pair.old.solid_count,
            },
            "new": {
                "vertex_count": int(len(diff_result.new.vertices)),
                "face_count": int(len(diff_result.new.faces)),
                "unit": pair.new.unit,
                "solid_count": pair.new.solid_count,
            },
        }
        write_status({
            "status": "done",
            "stage": "完了",
            "progress": 1.0,
            "warnings": all_warnings,
            "error": None,
            "stats": stats,
            "finished_at": datetime.now(timezone.utc).isoformat(),
        })

    except StepConversionError as exc:
        old_step_path.unlink(missing_ok=True)
        new_step_path.unlink(missing_ok=True)
        write_status({
            "status": "error",
            "stage": "エラー",
            "progress": 0.0,
            "warnings": [],
            "error": str(exc),
            "stats": None,
            "finished_at": datetime.now(timezone.utc).isoformat(),
        })
    except Exception as exc:
        old_step_path.unlink(missing_ok=True)
        new_step_path.unlink(missing_ok=True)
        write_status({
            "status": "error",
            "stage": "エラー",
            "progress": 0.0,
            "warnings": [],
            "error": f"3D差分処理中にエラーが発生しました: {exc}",
            "stats": None,
            "finished_at": datetime.now(timezone.utc).isoformat(),
        })


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

        self._processes: dict[str, mp.Process] = {}
        # 起動時に以前の実行で残った孤立ジョブを全削除する
        self._cleanup_all_on_startup()

    def _cleanup_all_on_startup(self) -> None:
        if not self.base_dir.exists():
            return
        for item in self.base_dir.iterdir():
            if item.is_dir():
                shutil.rmtree(item, ignore_errors=True)

    def job_dir(self, job_id: str) -> Path:
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
        """新しい差分ジョブを作成し、子プロセスで実行を開始する。"""
        self.cleanup_expired()
        job_id = uuid4().hex
        j_dir = self.job_dir(job_id)
        j_dir.mkdir(parents=True, exist_ok=True)

        old_step_path = j_dir / f"input_old_{uuid4().hex[:8]}.step"
        new_step_path = j_dir / f"input_new_{uuid4().hex[:8]}.step"
        old_step_path.write_bytes(old_content)
        new_step_path.write_bytes(new_content)

        initial_status = {
            "status": "running",
            "stage": "ジョブ開始",
            "progress": 0.0,
            "warnings": [],
            "error": None,
            "stats": None,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        (j_dir / "status.json").write_text(json.dumps(initial_status, ensure_ascii=False), encoding="utf-8")

        proc = mp.Process(
            target=_worker_entrypoint,
            args=(
                str(j_dir),
                str(old_step_path),
                str(new_step_path),
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
        """ジョブの現在のステータスを返す。存在しない場合はNone。"""
        j_dir = self.job_dir(job_id)
        status_file = j_dir / "status.json"
        if not status_file.exists():
            return None
        try:
            data = json.loads(status_file.read_text(encoding="utf-8"))
        except Exception:
            return None

        # プロセスが予期せず終了したか検査
        if data.get("status") == "running":
            proc = self._processes.get(job_id)
            if proc and not proc.is_alive() and proc.exitcode != 0:
                data["status"] = "error"
                data["error"] = f"3D差分処理プロセスが異常終了しました（終了コード: {proc.exitcode}）。"
                data["finished_at"] = datetime.now(timezone.utc).isoformat()
                status_file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

        data["job_id"] = job_id
        data["retention_minutes"] = self.retention_minutes
        return data

    def get_mesh_binary(self, job_id: str, side: str) -> bytes | None:
        """指定側のVDM1バイナリを取得する。"""
        if side not in ("old", "new"):
            return None
        bin_path = self.job_dir(job_id) / f"{side}_mesh.vdm1"
        if not bin_path.exists():
            return None
        return bin_path.read_bytes()

    def delete_job(self, job_id: str) -> bool:
        """ジョブのファイルおよびプロセスを破棄する。"""
        proc = self._processes.pop(job_id, None)
        if proc and proc.is_alive():
            proc.terminate()
        j_dir = self.job_dir(job_id)
        if j_dir.exists():
            shutil.rmtree(j_dir, ignore_errors=True)
            return True
        return False

    def cleanup_expired(self) -> int:
        """保持期間を経過したジョブを削除する。"""
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
                    if ts_str:
                        ts = datetime.fromisoformat(ts_str)
                        if ts < cutoff:
                            should_remove = True
                except Exception:
                    should_remove = True
            else:
                should_remove = True

            if should_remove:
                self.delete_job(j_dir.name)
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
