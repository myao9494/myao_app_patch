/**
 * AIインプット候補ドキュメント判定モジュール (isAiInputDocumentCandidate)
 * 仕様:
 * - チャット型AI（会社AI）へのインプット用ドキュメント一覧として、テキスト本文を持つノート・文書のみを抽出する。
 * - .excalidraw.md や .excalidraw、.drawio.svg、.dio.svg などの図面アセット、および一般的な画像ファイル (png, jpg, svg等) は
 *   「文書ノート」ではなく「画像・図面アセット」として扱い、文書候補から除外する (false)。
 * - これら画像・図面アセットは、収集された各Markdown文書内の ![[...]] や [[...]] リンクから自動的に Base64 埋め込み画像として参照される。
 */

const IMAGE_AND_FIGURE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico",
  ".excalidraw", ".dio", ".drawio",
]);

/**
 * 対象アイテムがAIインプットのドキュメント（文書）候補として適格か判定する。
 */
export function isAiInputDocumentCandidate(item: { file_name: string; file_ext?: string }): boolean {
  const lowerName = item.file_name.toLowerCase();

  // 1. Excalidraw 図面アセットの除外
  if (lowerName.endsWith(".excalidraw.md") || lowerName.endsWith(".excalidraw")) {
    return false;
  }

  // 2. Drawio / Dio 図面アセットの除外
  if (
    lowerName.endsWith(".drawio.svg") ||
    lowerName.endsWith(".dio.svg") ||
    lowerName.endsWith(".drawio") ||
    lowerName.endsWith(".dio")
  ) {
    return false;
  }

  // 3. 画像ファイルの除外
  const ext = (item.file_ext || "").toLowerCase();
  if (IMAGE_AND_FIGURE_EXTENSIONS.has(ext)) {
    return false;
  }

  const nameExt = "." + (lowerName.split(".").pop() ?? "");
  if (IMAGE_AND_FIGURE_EXTENSIONS.has(nameExt)) {
    return false;
  }

  return true;
}
