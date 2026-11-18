"""
3D CAD差分（STEP比較）API。重い処理は MeshDiffJobManager が子プロセスで実行する。
GET /api/3d/status, /api/3d/samples, POST /api/3d/samples/load, POST /api/3d/jobs,
GET /api/3d/jobs/{job_id}, GET /api/3d/jobs/{job_id}/mesh/{side}, DELETE /api/3d/jobs/{job_id},
POST /api/git/3d/jobs（HEAD と作業ツリーのSTEPを比較。片側だけなら単体プレビュー）
POST /api/git/cad-view/jobs（Markdown内の3D表示を画像で比べるため、HEADと作業ツリーの表示設定とメッシュを用意する）
Git の2つは任意項目 old_rev / new_rev（ファイルの履歴で過去のコミットどうしを比べる。既定は HEAD / 作業ツリー）を受け付ける。
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response

from ..diff_pipeline import read_upload_or_413
from ..git_repo import (
    git_repo_root,
    git_show,
    is_git_3d_path,
    normalize_revision,
    payload_folder,
    payload_revisions,
    read_revision_file,
    revision_label,
    safe_git_path,
)
from ..cad_views import extract_cad_views, mesh_model_format, pair_cad_views
from ..image_io import MAX_UPLOAD_BYTES
from ..markdown_links import find_vault_root, resolve_obsidian_link
from ..text_diff import MAX_TEXT_BYTES, decode_git_text
from ..mesh_jobs import (
    ALIGN_MODES,
    QUALITY_MODES,
    MeshDiffJobManager,
    check_3d_availability,
)

router = APIRouter()


mesh_job_manager = MeshDiffJobManager()


@router.get("/api/3d/status")
def get_3d_status() -> dict:
    return check_3d_availability()


@router.post("/api/3d/jobs", status_code=202)
def create_3d_job(
    file_old: UploadFile = File(...),
    file_new: UploadFile = File(...),
    quality: str = Form("standard"),
    align_mode: str = Form("auto"),
    linear_deflection: float | None = Form(None),
) -> JSONResponse:
    if not is_git_3d_path(file_old.filename or "") or not is_git_3d_path(file_new.filename or ""):
        raise HTTPException(status_code=400, detail="STEPファイル（拡張子 .step または .stp）を指定してください。")
    _validate_3d_request(quality, align_mode)

    content_old = read_upload_or_413(file_old)
    content_new = read_upload_or_413(file_new)
    if not content_old or not content_new:
        raise HTTPException(status_code=400, detail="アップロードされたファイルが空です。")

    job_id = mesh_job_manager.create_job(
        file_old.filename or "old.step",
        content_old,
        file_new.filename or "new.step",
        content_new,
        quality=quality,
        align_mode=align_mode,
        linear_deflection=linear_deflection,
    )
    return JSONResponse(status_code=202, content={"job_id": job_id, "status": "queued"})


@router.get("/api/3d/jobs/{job_id}")
def get_3d_job_status(job_id: str) -> JSONResponse:
    status = mesh_job_manager.get_status(job_id)
    if status is None:
        raise HTTPException(status_code=404, detail="指定された3D差分ジョブが見つかりません。")
    return JSONResponse(status)


@router.get("/api/3d/jobs/{job_id}/mesh/{side}")
def get_3d_job_mesh(job_id: str, side: str):
    if side not in ("old", "new"):
        raise HTTPException(status_code=400, detail="side は 'old' または 'new' を指定してください。")
    status = mesh_job_manager.get_status(job_id)
    if status is None:
        raise HTTPException(status_code=404, detail="指定された3D差分ジョブが見つかりません。")
    if status.get("status") != "done":
        raise HTTPException(status_code=409, detail=f"ジョブが完了していません（現在の状態: {status.get('status')}）。")
    data = mesh_job_manager.get_mesh_binary(job_id, side)
    if data is None:
        raise HTTPException(status_code=404, detail="メッシュデータが存在しません。")
    return Response(content=data, media_type="application/octet-stream")


@router.delete("/api/3d/jobs/{job_id}")
def delete_3d_job(job_id: str) -> JSONResponse:
    deleted = mesh_job_manager.delete_job(job_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="指定された3D差分ジョブが見つかりません。")
    return JSONResponse({"status": "deleted"})


def _validate_3d_request(quality: str, align_mode: str) -> None:
    if quality not in QUALITY_MODES:
        raise HTTPException(status_code=400, detail=f"無効な品質設定です: {quality}（{' / '.join(QUALITY_MODES)}）")
    if align_mode not in ALIGN_MODES:
        raise HTTPException(status_code=400, detail=f"無効な位置合わせモードです: {align_mode}")
    avail = check_3d_availability()
    if not avail["available"]:
        raise HTTPException(
            status_code=503,
            detail=f"3D差分に必要なライブラリが不足しています: {', '.join(avail['missing'])}。{avail['install_hint']}",
        )


STEP_SAMPLE_DEFINITIONS = [
    {"id": "hole_position", "title": "穴位置の変更 (φ12穴 x=30 → x=60)"},
    {"id": "dimension", "title": "寸法の変更 (ブロック長さ 80 → 90)"},
    {"id": "added_boss", "title": "ボスの追加 (φ20x15 円柱)"},
    {"id": "moved_rotated", "title": "位置・向きズレのみ (同一形状・回転35°/15°補正・差分0%)"},
    {"id": "moved_rotated_diff", "title": "位置ズレ＋形状変更 (回転35°/15°補正＋縦壁に穴追加)"},
    {"id": "unit_inch", "title": "単位不一致 (ミリ vs インチ段付き軸)"},
]
STEP_SAMPLES_DIR = Path(__file__).resolve().parents[3] / "samples" / "step"


@router.get("/api/3d/samples")
def get_3d_samples() -> list[dict]:
    return [
        item for item in STEP_SAMPLE_DEFINITIONS
        if (STEP_SAMPLES_DIR / f"{item['id']}_a.step").exists() and (STEP_SAMPLES_DIR / f"{item['id']}_b.step").exists()
    ]


@router.post("/api/3d/samples/load", status_code=202)
def load_3d_sample(payload: dict) -> JSONResponse:
    sample_id = str(payload.get("sample_id", ""))
    quality = str(payload.get("quality", "standard"))
    align_mode = str(payload.get("align_mode", "auto"))

    # 定義済みのサンプルIDだけを受け付ける（任意のパスを組み立てさせない）。
    known_ids = {item["id"] for item in STEP_SAMPLE_DEFINITIONS}
    path_a = STEP_SAMPLES_DIR / f"{sample_id}_a.step"
    path_b = STEP_SAMPLES_DIR / f"{sample_id}_b.step"
    if sample_id not in known_ids or not path_a.exists() or not path_b.exists():
        raise HTTPException(status_code=404, detail=f"サンプル '{sample_id}' が見つかりません。")
    _validate_3d_request(quality, align_mode)

    content_old = path_a.read_bytes()
    content_new = path_b.read_bytes()
    job_id = mesh_job_manager.create_job(
        f"{sample_id}_a.step",
        content_old,
        f"{sample_id}_b.step",
        content_new,
        quality=quality,
        align_mode=align_mode,
    )
    return JSONResponse(status_code=202, content={"job_id": job_id, "status": "queued"})


@router.post("/api/git/3d/jobs", status_code=202)
def create_git_3d_job(payload: dict) -> JSONResponse:
    """Git管理下のSTEPファイル（HEAD vs 作業ツリー）から3D差分ジョブを作成する。"""
    folder = payload_folder(payload)
    repo = git_repo_root(folder)
    path = str(payload.get("path") or "")
    if not path:
        raise HTTPException(status_code=422, detail="path is required")
    rel_path = safe_git_path(repo, path, restrict_to_images=False)
    head_path = str(payload.get("head_path") or path)
    head_rel_path = safe_git_path(repo, head_path, restrict_to_images=False)

    if not is_git_3d_path(rel_path):
        raise HTTPException(status_code=400, detail="STEPファイル（拡張子 .step または .stp）を指定してください。")

    quality = str(payload.get("quality") or "standard")
    align_mode = str(payload.get("align_mode") or "auto")
    _validate_3d_request(quality, align_mode)

    has_head = bool(payload.get("has_head", True))
    has_current = bool(payload.get("has_current", True))
    old_rev, new_rev = payload_revisions(payload)

    content_old = b""
    if has_head:
        try:
            content_old = git_show(repo, head_rel_path, max_bytes=MAX_UPLOAD_BYTES, rev=old_rev)
        except HTTPException:
            content_old = b""

    content_new = b""
    if has_current:
        try:
            content_new = read_revision_file(repo, rel_path, new_rev, MAX_UPLOAD_BYTES)
        except HTTPException as exc:
            if exc.status_code != 404:
                raise

    if not content_old and not content_new:
        raise HTTPException(status_code=404, detail="変更前にも変更後にもSTEPファイルが見つかりません。")

    job_id = mesh_job_manager.create_job(
        f"{revision_label(old_rev)}_{Path(head_rel_path).name}" if content_old else "",
        content_old,
        (Path(rel_path).name if new_rev is None else f"{revision_label(new_rev)}_{Path(rel_path).name}") if content_new else "",
        content_new,
        quality=quality,
        align_mode=align_mode,
    )
    return JSONResponse({"job_id": job_id, "status": "pending"}, status_code=202)


@router.post("/api/git/cad-view/jobs", status_code=202)
def create_git_cad_view_job(payload: dict) -> JSONResponse:
    """Markdown内の3D表示（key = name、無ければ「#出現順」）について、HEADと作業ツリーの表示設定とモデルの読み方を返す。

    画像はブラウザーがこの設定とメッシュから描く。比べるのはノートに見えている絵なので、
    STEPは位置合わせせず（align_mode=none）座標のままメッシュ化する。両側が同じSTEPなら1回だけ。
    STL / OBJ は三角形メッシュなので、ブラウザーが /api/git/cad-view/model で読んで直接描く。
    """
    folder = payload_folder(payload)
    repo = git_repo_root(folder)
    path = str(payload.get("path") or "")
    key = str(payload.get("key") or "")
    if not path or not key:
        raise HTTPException(status_code=422, detail="path and key are required")
    rel_path = safe_git_path(repo, path, restrict_to_images=False)
    head_rel_path = safe_git_path(repo, str(payload.get("head_path") or path), restrict_to_images=False)

    old_rev, new_rev = payload_revisions(payload)
    vault_root = find_vault_root(repo, rel_path)
    head_views = _note_cad_views(repo, head_rel_path, rev=old_rev) if payload.get("has_head", True) else None
    current_views = _note_cad_views(repo, rel_path, rev=new_rev) if payload.get("has_current", True) else None
    pairs = pair_cad_views(head_views or [], current_views or [])
    # 一覧の key は作業ツリー側（削除されたノートはHEAD側）のブロックのもの
    pair = next((item for item in pairs if item["current"] and item["current"]["key"] == key), None) or next(
        (item for item in pairs if item["head"] and item["head"]["key"] == key), None
    )
    if pair is None:
        raise HTTPException(status_code=404, detail=f"「{key}」の3D表示が見つかりません。")

    head = _cad_view_side(repo, vault_root, head_rel_path, pair["head"], key, rev=old_rev, label="変更前") if head_views is not None else None
    current = _cad_view_side(repo, vault_root, rel_path, pair["current"], key, rev=new_rev, label="変更後") if current_views is not None else None
    if not any(side and side["model_format"] for side in (head, current)):
        reasons = [side["error"] for side in (head, current) if side and side.get("error")]
        raise HTTPException(status_code=404, detail=reasons[0] if reasons else "3D表示のモデルが見つかりません。")

    step_old = head.pop("content", b"") if head else b""
    step_new = current.pop("content", b"") if current else b""
    same_model = bool(step_old) and step_old == step_new
    if same_model:
        step_old = b""  # 同じモデルは1回だけメッシュ化し、両側の絵に使う
    if head:
        head["mesh_side"] = "new" if same_model else "old" if step_old else None
    if current:
        current["mesh_side"] = "new" if step_new else None

    job_id = None
    if step_old or step_new:
        job_id = mesh_job_manager.create_job(
            f"{revision_label(old_rev)}_{Path(head['model_path']).name}" if step_old else "",
            step_old,
            Path(current["model_path"]).name if step_new else "",
            step_new,
            quality=str(payload.get("quality") or "standard"),
            align_mode="none",
        )
    return JSONResponse(
        {"job_id": job_id, "same_model": same_model, "paired_by": pair["paired_by"], "head": head, "current": current},
        status_code=202,
    )


@router.post("/api/git/cad-view/model")
def get_git_cad_view_model(payload: dict) -> Response:
    """3D表示が指す STL / OBJ を返す。rev があればその版（null は作業ツリー）、無ければ side=head で HEAD・それ以外は作業ツリー。"""
    folder = payload_folder(payload)
    repo = git_repo_root(folder)
    model_path = safe_git_path(repo, str(payload.get("path") or ""), restrict_to_images=False)
    if mesh_model_format(model_path) is None:
        raise HTTPException(status_code=400, detail="STL または OBJ のファイルを指定してください。")
    if "rev" in payload:
        rev = normalize_revision(payload.get("rev"))
    else:
        rev = "HEAD" if payload.get("side") == "head" else None
    content = read_revision_file(repo, model_path, rev, MAX_UPLOAD_BYTES)
    return Response(content=content, media_type="application/octet-stream")


def _note_cad_views(repo: Path, md_rel_path: str, *, rev: str | None) -> list[dict] | None:
    """片側（rev の版。None は作業ツリー）のノートの3D表示ブロック一覧。ノートが無ければ None。"""
    try:
        text_bytes = read_revision_file(repo, md_rel_path, rev, MAX_TEXT_BYTES)
        text, _ = decode_git_text(text_bytes)
    except HTTPException:
        return None
    return extract_cad_views(text)


def _cad_view_side(
    repo: Path, vault_root: Path, md_rel_path: str, view: dict | None, key: str, *, rev: str | None, label: str
) -> dict:
    """片側（rev の版。None は作業ツリー）の3D表示の設定とモデルを読む。STEPは内容も返す（メッシュ化ジョブに渡す）。

    rev はモデルの取得（STL / OBJ の /api/git/cad-view/model）でも使うので、そのまま返す。
    """
    side = {"key": None, "name": None, "config": None, "model_path": None, "model_format": None, "error": None, "rev": rev}
    if view is None:
        side["error"] = f"{label}のノートには「{key}」の3D表示がありません。"
        return side

    side.update(key=view["key"], name=view["name"], config=view["config"])
    model_path = resolve_obsidian_link(repo, md_rel_path, view["config"]["path"], vault_root)
    side["model_path"] = model_path
    model_format = "step" if model_path and is_git_3d_path(model_path) else mesh_model_format(model_path or "")
    if not model_path or model_format is None:
        side["error"] = f"{label}の3D表示のモデルを比較できません（STEP / STL / OBJ のみ対応）: {view['config']['path']}"
        return side
    try:
        content = read_revision_file(repo, model_path, rev, MAX_UPLOAD_BYTES)
    except HTTPException:
        side["error"] = f"{label}の3D表示のモデルを読めません: {model_path}"
        return side
    side["model_format"] = model_format
    if model_format == "step":
        side["content"] = content
    return side
