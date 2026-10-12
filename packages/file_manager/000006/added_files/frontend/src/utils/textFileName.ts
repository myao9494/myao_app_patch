/**
 * 新規作成するファイルの名前を組み立てる
 * - buildTextFileName: テキストファイル作成モーダルの名前と拡張子を結合する
 * - buildMarkdownFileName: 末尾に .md がなければ付ける
 * - buildExcalidrawFileName: obsidian 配下では .excalidraw.md、それ以外は .excalidraw を付ける
 */

/** ファイル名と拡張子から作成するファイル名を返す。 */
export function buildTextFileName(name: string, extension: string): string {
  const trimmedName = name.trim();
  const normalizedExtension = extension.trim().replace(/^\.+/, "");
  if (!normalizedExtension) return trimmedName;
  const suffix = `.${normalizedExtension}`;
  return trimmedName.toLowerCase().endsWith(suffix.toLowerCase())
    ? trimmedName
    : `${trimmedName}${suffix}`;
}

/** Markdown ファイル名（.md がなければ付ける） */
export function buildMarkdownFileName(name: string): string {
  const trimmedName = name.trim();
  return trimmedName.endsWith(".md") ? trimmedName : `${trimmedName}.md`;
}

/** Excalidraw の図面ファイル名。Obsidian の Vault では Excalidraw プラグイン形式（.excalidraw.md）にする */
export function buildExcalidrawFileName(name: string, isObsidian: boolean): string {
  const trimmedName = name.trim();
  const targetExtension = isObsidian ? ".excalidraw.md" : ".excalidraw";
  if (trimmedName.endsWith(targetExtension)) return trimmedName;
  if (isObsidian && trimmedName.endsWith(".excalidraw")) return `${trimmedName}.md`;
  return `${trimmedName}${targetExtension}`;
}
