/**
 * Git差分で、Markdown内の3D表示（```step / ```cad）を HEAD と作業ツリーで画像として比べる。
 * 対応づけはコードブロックの name（無ければ出現順）で、バックエンドが行う。
 * 1. /api/git/cad-view/jobs で両側の表示設定とモデルの読み方を受け取る（STEPはメッシュ化ジョブ、STL / OBJ はファイル）
 * 2. ブラウザーで両側の絵を描き（renderCadView.js）、/api/git/cad-view/diff で通常の画像差分にかける
 * 3. 片側しか描けないとき（ノートの新規・3D表示の追加・モデルが見つからない）は、描けた側だけを返す
 * 比べるのはノートに見えている絵なので、形状の差に加えて、注記・視点・断面の変更も差分になる。
 */
import { API_BASE, postForm, postJson } from "../lib/api.js";
import { parseVdm1 } from "../three-diff/vdm1.js";

const JOB_POLL_INTERVAL_MS = 400;
const JOB_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * @returns {Promise<{result: object|null, item: object|null}>} 両側を描けたら result（DiffResponse）、
 *   片側だけなら item（image_head / image_current と、描けなかった理由 head_error / current_error）
 */
export async function loadCadViewComparison({ folder, file, viewKey, category, diffThreshold, anchor }) {
  const job = await postJson("/git/cad-view/jobs", {
    folder,
    path: file.path,
    head_path: file.head_path,
    has_head: file.has_head,
    has_current: file.has_current,
    key: viewKey,
  });
  const geometries = {};
  try {
    if (job.job_id) await waitForJob(job.job_id);
    const render = await import("./renderCadView.js");
    for (const sideName of ["head", "current"]) {
      const side = job[sideName];
      if (!side?.model_format) continue;
      geometries[sideName] = await loadGeometry(render, job, side, sideName, folder);
    }
    const images = {};
    for (const sideName of ["head", "current"]) {
      if (geometries[sideName]) images[sideName] = await render.renderCadViewImage(geometries[sideName], job[sideName].config);
    }
    const warnings = ["head", "current"].map((name) => job[name]?.error).filter(Boolean);
    if (job.paired_by === "order") {
      warnings.push(`変更前と変更後の片方に name が無いため、「${viewKey}」は出現順で対応づけました`);
    }
    if (images.head && images.current) {
      const form = new FormData();
      form.append("file_a", images.head, `HEAD:${file.head_path}#${viewKey}.png`);
      form.append("file_b", images.current, `${file.path}#${viewKey}.png`);
      form.append("category", category);
      form.append("diff_threshold", String(diffThreshold));
      if (anchor?.region) form.append("anchor_region", JSON.stringify(anchor.region));
      if (anchor?.region && anchor.regionB) form.append("anchor_region_b", JSON.stringify(anchor.regionB));
      const result = await postForm("/git/cad-view/diff", form);
      return { result: { ...result, conversion_warnings: [...warnings, ...(result.conversion_warnings ?? [])] }, item: null };
    }
    return {
      result: null,
      item: {
        image_head: images.head ? await imagePayload(images.head) : null,
        image_current: images.current ? await imagePayload(images.current) : null,
        head_error: job.head?.error ?? (job.head ? null : "変更前のノートはありません"),
        current_error: job.current?.error ?? (job.current ? null : "変更後のノートはありません"),
      },
    };
  } finally {
    Object.values(geometries).forEach((geometry) => geometry.dispose());
    // メッシュは描き終えたら不要なので、サーバーの計算結果もすぐ消す
    if (job.job_id) fetch(`${API_BASE}/3d/jobs/${encodeURIComponent(job.job_id)}`, { method: "DELETE" }).catch(() => {});
  }
}

async function waitForJob(jobId) {
  const started = Date.now();
  while (Date.now() - started < JOB_TIMEOUT_MS) {
    const response = await fetch(`${API_BASE}/3d/jobs/${encodeURIComponent(jobId)}`);
    if (!response.ok) throw new Error("3D表示のメッシュ化の状況を取得できませんでした");
    const status = await response.json();
    if (status.status === "done") return status;
    if (status.status === "error") throw new Error(status.error || "3D表示のモデルをメッシュ化できませんでした");
    await new Promise((resolve) => window.setTimeout(resolve, JOB_POLL_INTERVAL_MS));
  }
  throw new Error("3D表示のメッシュ化が時間内に終わりませんでした");
}

async function loadGeometry(render, job, side, sideName, folder) {
  if (side.model_format === "step") {
    const response = await fetch(`${API_BASE}/3d/jobs/${encodeURIComponent(job.job_id)}/mesh/${side.mesh_side}`);
    if (!response.ok) throw new Error("3D表示のメッシュを取得できませんでした");
    return render.geometryFromVdm1(parseVdm1(await response.arrayBuffer()));
  }
  const response = await fetch(`${API_BASE}/git/cad-view/model`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder, path: side.model_path, side: sideName }),
  });
  if (!response.ok) throw new Error(`3D表示のモデルを読めませんでした: ${side.model_path}`);
  return render.geometryFromModelFile(side.model_format, await response.arrayBuffer());
}

async function imagePayload(blob) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return { mime_type: "image/png", data: String(dataUrl).split(",")[1] };
}
