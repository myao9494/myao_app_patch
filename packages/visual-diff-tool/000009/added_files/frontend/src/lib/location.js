/**
 * URLパラメーター（外部アプリ・Obsidian・ファイルマネージャーからの起動）の解釈。
 */
import { extensionForFilename } from "./files.js";

export function externalResultIdFromLocation() {
  return new URLSearchParams(window.location.search).get("result_id");
}

/**
 * 外部から Git差分を開くパス。git_path（フォルダー・ファイル1つ・Markdown。ファイルマネージャーの「差分を表示」）を優先し、
 * 無ければ従来の markdown_path / markdown_file（Obsidian から）。
 */
export function gitPathFromSearch(search) {
  const params = new URLSearchParams(search);
  return params.get("git_path") || params.get("markdown_path") || params.get("markdown_file") || "";
}

export function gitPathFromLocation() {
  return gitPathFromSearch(window.location.search);
}

export function externalFileData(side, result) {
  const filename = side === "A" ? result.filename_a : result.filename_b;
  const page = side === "A" ? result.page_a : result.page_b;
  return {
    file: { name: filename || `API File ${side}` },
    metadata: {
      format: extensionForFilename(filename),
      page_count: Math.max(1, Number(page ?? 0) + 1),
      pages: [
        {
          index: Number(page ?? 0),
          width: result.width,
          height: result.height,
          warnings: [],
        },
      ],
      warnings: [],
    },
    external: true,
  };
}
