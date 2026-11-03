/**
 * HTML出力プレビューのカード（エントリー）を集める。
 * - 表示中のファイルは取得済みの比較結果を再利用し、それ以外は /api/git/diff・/api/git/item で取得する
 * - 取得は並列度を抑えて同時に行い、カードの順序はファイル一覧の順を保つ
 * - テキストはファイル単位のメモ、画像は差分メモ画面で付けた注釈（memoStore）を添える
 * - Markdown内のExcalidraw図は、注釈・付箋がある場合だけ本文カードの直後に画像カードとして追加する
 *   （本文テキストのメモと区別するため、メモIDは「<path>#excalidraw」）
 * - Markdown内の3D表示も同じく、注釈・付箋がある場合だけ画像カードにする（メモIDは「<path>#cad-view:<name>」）
 */
import { anchorPayload, gitAnchorKey } from "../lib/anchorRegion.js";
import { mapWithConcurrency, postJson } from "../lib/api.js";
import { loadCadViewComparison } from "../cad-view/cadViewDiff.js";
import { cadViewMode, cadViewTitle } from "../cad-view/cadViewModel.js";
import { gitImageMemoId, gitMemoKey, readMemoPayload } from "../lib/memoStore.js";
import { normalizeMemoNotes, normalizeStickyNotes } from "../memo/memoModel.js";
import { normalizeReportOptions } from "./reportGeometry.js";

/**
 * @param {object} options
 * @param {object[]} options.files 出力対象の変更ファイル
 * @param {object} options.info /api/git/files の結果（repo_root, folder）
 * @param {string} options.folder 入力欄のフォルダー（info.folder が無い場合に使う）
 * @param {{file: object|null, view: string|null, result: object|null, item: object|null}} options.current 表示中のファイルと取得済みデータ
 * @param {Object<string, object>} [options.anchors] Git差分で人が指定した位置合わせの範囲（画面と同じ補正で出力する）
 */
export async function collectReportEntries({ files, info, folder, current, category, diffThreshold, textExtensions, textMemos, concurrency, anchors = {} }) {
  const gitFolder = info.folder || folder;

  async function excalidrawEntry(file) {
    if (file.kind !== "text" || !file.embedded_excalidraw || !file.diffable) return null;
    const memoPath = `${file.path}#excalidraw`;
    const imageMemo = await readMemoPayload(gitImageMemoId(info.repo_root, memoPath));
    const hasMemo = normalizeMemoNotes(imageMemo?.notes).length > 0 || normalizeStickyNotes(imageMemo?.stickies).length > 0;
    if (!hasMemo) return null;
    const isCurrentExcalidraw = file.path === current.file?.path && current.view === "excalidraw" && current.result;
    const data = isCurrentExcalidraw
      ? current.result
      : await postJson("/git/diff", {
        folder: gitFolder,
        path: file.path,
        head_path: file.head_path,
        category: "図面",
        diff_threshold: diffThreshold,
        subresource: "excalidraw",
        ...anchorPayload(anchors[gitAnchorKey(file.path, "excalidraw")]),
      });
    return {
      file: { ...file, kind: "image", memo_path: memoPath, display_path: `${file.path} / Excalidraw` },
      data,
      memo: "",
      imageMemo,
    };
  }

  async function cadViewEntries(file) {
    if (file.kind !== "text") return [];
    const entries = [];
    for (const view of file.cad_views ?? []) {
      const mode = cadViewMode(view.key);
      const memoPath = `${file.path}#${mode}`;
      const imageMemo = await readMemoPayload(gitImageMemoId(info.repo_root, memoPath));
      if (normalizeMemoNotes(imageMemo?.notes).length === 0 && normalizeStickyNotes(imageMemo?.stickies).length === 0) continue;
      const isCurrentView = file.path === current.file?.path && current.view === mode && (current.result || current.item);
      const comparison = isCurrentView
        ? { result: current.result, item: current.item }
        : await loadCadViewComparison({
          folder: gitFolder,
          file,
          viewKey: view.key,
          category: "図面",
          diffThreshold,
          anchor: anchors[gitAnchorKey(file.path, mode)],
        });
      entries.push({
        file: { ...file, kind: "image", memo_path: memoPath, display_path: `${file.path} / ${cadViewTitle(view)}` },
        data: comparison.result ?? comparison.item,
        memo: "",
        imageMemo,
      });
    }
    return entries;
  }

  async function fileData(file) {
    // 表示中のデータは、同じ表示（本文・画像）のときだけ使い回す（Excalidraw図や3D表示のデータを本文に使わない）
    const isCurrent = file.path === current.file?.path && (current.view === "text" || current.view === "image");
    if (isCurrent && file.kind === "image" && file.diffable && current.result) return current.result;
    if (isCurrent && current.item) return current.item;
    if (file.kind === "image" && file.diffable) {
      return postJson("/git/diff", {
        folder: gitFolder,
        path: file.path,
        head_path: file.head_path,
        category,
        diff_threshold: diffThreshold,
        ...anchorPayload(anchors[gitAnchorKey(file.path, "image")]),
      });
    }
    return postJson("/git/item", { folder: gitFolder, text_extensions: textExtensions, include_text: false, ...file });
  }

  // 各ファイルの取得は互いに独立なので並列に行う。バックエンドの画像処理(OpenCV)はGILを解放して並列に動く。
  const groups = await mapWithConcurrency(files, concurrency, async (file) => {
    const data = await fileData(file);
    const memo = file.kind === "text" ? textMemos[gitMemoKey(info.repo_root, file.path)] ?? "" : "";
    const imageMemo = file.kind === "text" ? null : await readMemoPayload(gitImageMemoId(info.repo_root, file.path));
    const extra = await excalidrawEntry(file);
    const views = await cadViewEntries(file);
    const main = { file, data, memo, imageMemo };
    return [main, ...(extra ? [extra] : []), ...views];
  });

  return groups.flat().map((entry) => ({
    ...entry,
    memoId: entry.file.kind === "image" ? gitImageMemoId(info.repo_root, entry.file.memo_path ?? entry.file.path) : null,
    reportOptions: normalizeReportOptions(entry.imageMemo?.reportOptions),
  }));
}
