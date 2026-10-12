/**
 * インデックス対象拡張子の定義と正規化。
 * 標準で本文抽出する拡張子・ファイル名のみ検索する拡張子の一覧と、
 * 利用者が追加した拡張子を合わせた選択肢の組み立て・保存形式の安定化を担う。
 **/

import { normalizeExtensionToken } from "./extensionFilter.ts";

export const BASE_CONTENT_EXTENSIONS = [
  ".md",
  ".json",
  ".txt",
  ".xml",
  ".excalidraw",
  ".dio",
  ".excalidraw.md",
  ".dio.svg",
  ".pdf",
  ".docx",
  ".xlsx",
  ".xlsm",
  ".pptx",
  ".msg",
];
export const BASE_FILENAME_ONLY_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".heic",
  ".svg",
  ".bmp",
  ".tif",
  ".tiff",
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".flac",
  ".aif",
  ".aiff",
  ".alac",
  ".m4p",
] as const;
export const DEFAULT_INDEX_EXTENSIONS = [...BASE_CONTENT_EXTENSIONS, ...BASE_FILENAME_ONLY_EXTENSIONS];

/**
 * 拡張子一覧は前後空白除去・ドット補完・重複排除を行う。
 */
export function normalizeCustomExtensions(extensions: readonly string[]): string[] {
  const normalized = extensions.map(normalizeExtensionToken).filter(Boolean);
  return [...new Set(normalized)];
}

/**
 * 標準拡張子と利用者追加拡張子を結合し、表示順を安定させる。
 */
export function buildAvailableExtensions(customContentExtensions: readonly string[], customFilenameExtensions: readonly string[]): string[] {
  return [
    ...BASE_CONTENT_EXTENSIONS,
    ...BASE_FILENAME_ONLY_EXTENSIONS,
    ...normalizeCustomExtensions(customContentExtensions),
    ...normalizeCustomExtensions(customFilenameExtensions),
  ].filter((extension, index, array) => array.indexOf(extension) === index);
}

/**
 * 拡張子選択は表示順のまま一意化し、保存値と画面表示の順序を安定させる。
 */
export function normalizeIndexExtensions(extensions: readonly string[], availableExtensions: readonly string[]): string[] {
  const selected = new Set(extensions.map(normalizeExtensionToken).filter(Boolean));
  return availableExtensions.filter((extension) => selected.has(extension));
}

/**
 * テキストファイルとの往復用に、改行区切りの拡張子一覧を配列へ変換する。
 */
export function parseExtensionText(value: string): string[] {
  return normalizeCustomExtensions(value.split(/[\s,]+/));
}
