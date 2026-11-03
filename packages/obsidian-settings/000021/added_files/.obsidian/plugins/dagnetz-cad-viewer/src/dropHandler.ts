/**
 * CADファイルドロップ連携ハンドラー
 * 
 * 1. ドラッグ＆ドロップされたファイルの拡張子（.step, .stp, .fcstd, .obj, .stl）を判定
 * 2. ドロップされたデータ（Wikilink [[...]]、埋め込み ![[...]]、生パス）からCADファイルパスを抽出
 * 3. ドロップされたファイルパスに基づき、即座にプレビュー表示可能な```stepコードブロック構文を生成
 * 4. エディタの上へのドロップだけを扱う（サイドバーへのドロップなどは横取りしない）
 **/

import { formatYamlName } from "./embed/embedNames";

export const CAD_EXTENSIONS = [".step", ".stp", ".fcstd", ".obj", ".stl"];

/**
 * ファイル名が対応CAD拡張子であるかを判定する
 */
export function isCadFile(filename: string): boolean {
  if (!filename) return false;
  const lower = filename.toLowerCase().trim();
  return CAD_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * ドロップされたテキスト（Wikilink [[...]] や ![[...]]、生パスなど）からCADファイルパスを抽出する
 * CADファイルでない場合は null を返す
 */
export function extractCadPathFromDropData(rawText: string): string | null {
  if (!rawText) return null;
  let clean = rawText.trim();
  // ![[...]] または [[...]] の囲みを除去
  if (clean.startsWith("![[") && clean.endsWith("]]")) {
    clean = clean.slice(3, -2).trim();
  } else if (clean.startsWith("[[") && clean.endsWith("]]")) {
    clean = clean.slice(2, -2).trim();
  }
  // エイリアス（パイプ区切り）がある場合はパス部分のみ抽出
  if (clean.includes("|")) {
    clean = clean.split("|")[0].trim();
  }
  if (isCadFile(clean)) {
    return clean;
  }
  return null;
}

/**
 * ドロップ先がエディタの中かどうかを判定する（文字ノードの場合は親要素で判定する）
 */
export function isEditorDropTarget(
  target: { closest?: (selector: string) => unknown; parentElement?: unknown } | null | undefined,
): boolean {
  const element = (target?.closest ? target : target?.parentElement) as
    | { closest?: (selector: string) => unknown }
    | null
    | undefined;
  return Boolean(element?.closest?.(".cm-editor"));
}

/**
 * パスを YAML の値として書く。YAML で特別な意味を持つ記号（「 #」「: 」や先頭の記号）を含むときだけ引用符で囲む
 */
export function formatYamlPath(path: string): string {
  return /^[&*!|>'"%@`[\]{},#?-]|: |\s#|:$/.test(path) ? JSON.stringify(path) : path;
}

/**
 * 指定されたファイルパスと設定から```stepコードブロック文字列を生成する（name を渡すと埋め込みの名前も書く）
 */
export function buildCadCodeBlock(
  filePath: string,
  height: number = 800,
  view: string = "iso",
  locked: boolean = false,
  name?: string,
): string {
  const nameLine = name ? `name: ${formatYamlName(name)}\n` : "";
  const lockedLine = locked ? "locked: true\n" : "";
  return `\`\`\`step\npath: ${formatYamlPath(filePath)}\n${nameLine}height: ${height}\nview: ${view}\n${lockedLine}\`\`\`\n`;
}

