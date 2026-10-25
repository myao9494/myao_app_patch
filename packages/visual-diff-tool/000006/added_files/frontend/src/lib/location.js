/**
 * URLパラメーター（外部アプリ・Obsidianからの起動）の解釈。
 */
import { extensionForFilename } from "./files.js";

export function externalResultIdFromLocation() {
  return new URLSearchParams(window.location.search).get("result_id");
}

export function markdownPathFromLocation() {
  const params = new URLSearchParams(window.location.search);
  return params.get("markdown_path") || params.get("markdown_file") || "";
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
