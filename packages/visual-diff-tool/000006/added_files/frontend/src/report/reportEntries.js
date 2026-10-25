/**
 * HTML出力プレビューのカード（エントリー）を集める。
 * - 表示中のファイルは取得済みの比較結果を再利用し、それ以外は /api/git/diff・/api/git/item で取得する
 * - 取得は並列度を抑えて同時に行い、カードの順序はファイル一覧の順を保つ
 * - テキストはファイル単位のメモ、画像は差分メモ画面で付けた注釈（memoStore）を添える
 * - Markdown内のExcalidraw図は、注釈・付箋がある場合だけ本文カードの直後に画像カードとして追加する
 *   （本文テキストのメモと区別するため、メモIDは「<path>#excalidraw」）
 */
import { mapWithConcurrency, postJson } from "../lib/api.js";
import { gitImageMemoId, gitMemoKey, readMemoPayload } from "../lib/memoStore.js";
import { normalizeMemoNotes, normalizeStickyNotes } from "../memo/memoModel.js";
import { normalizeReportOptions } from "./reportGeometry.js";

/**
 * @param {object} options
 * @param {object[]} options.files 出力対象の変更ファイル
 * @param {object} options.info /api/git/files の結果（repo_root, folder）
 * @param {string} options.folder 入力欄のフォルダー（info.folder が無い場合に使う）
 * @param {{file: object|null, view: string|null, result: object|null, item: object|null}} options.current 表示中のファイルと取得済みデータ
 */
export async function collectReportEntries({ files, info, folder, current, category, diffThreshold, textExtensions, textMemos, concurrency }) {
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
      });
    return {
      file: { ...file, kind: "image", memo_path: memoPath, display_path: `${file.path} / Excalidraw` },
      data,
      memo: "",
      imageMemo,
    };
  }

  async function fileData(file) {
    const isCurrent = file.path === current.file?.path;
    if (isCurrent && file.kind === "image" && file.diffable && current.result) return current.result;
    if (isCurrent && current.item) return current.item;
    if (file.kind === "image" && file.diffable) {
      return postJson("/git/diff", {
        folder: gitFolder,
        path: file.path,
        head_path: file.head_path,
        category,
        diff_threshold: diffThreshold,
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
    const main = { file, data, memo, imageMemo };
    return extra ? [main, extra] : [main];
  });

  return groups.flat().map((entry) => ({
    ...entry,
    memoId: entry.file.kind === "image" ? gitImageMemoId(info.repo_root, entry.file.memo_path ?? entry.file.path) : null,
    reportOptions: normalizeReportOptions(entry.imageMemo?.reportOptions),
  }));
}
