/**
 * インデックス済みフォルダ・検索対象フォルダ一覧の絞り込み。
 *
 * - 「含む」キーワード: パスに含むものだけを残す（大文字小文字は区別しない）。
 * - 「含まない」キーワード: 1 行に 1 つ指定し、どれかをパスに含むものを隠す（インデックス済みフォルダ一覧のみ）。
 * - インデックス済みフォルダは、ファイル数の多い順（同数ならパスの昇順）に並べる。
 */
import { normalizeHiddenIndexedTargets } from "./settingsNormalization.ts";
import type { IndexedTarget, SearchTargetFolder } from "./types.ts";

export function filterIndexedTargets(
  targets: IndexedTarget[],
  filterKeyword: string,
  hideKeyword: string,
): IndexedTarget[] {
  const loweredFilterKeyword = filterKeyword.trim().toLowerCase();
  const hiddenKeywords = normalizeHiddenIndexedTargets(hideKeyword)
    .split(/\r?\n/)
    .map((item) => item.toLowerCase())
    .filter(Boolean);
  return targets
    .filter((item) => {
      const loweredPath = item.full_path.toLowerCase();
      if (loweredFilterKeyword && !loweredPath.includes(loweredFilterKeyword)) {
        return false;
      }
      return !hiddenKeywords.some((keyword) => loweredPath.includes(keyword));
    })
    .sort((left, right) => right.indexed_file_count - left.indexed_file_count || left.full_path.localeCompare(right.full_path));
}

export function filterSearchTargets(targets: SearchTargetFolder[], filterKeyword: string): SearchTargetFolder[] {
  const loweredFilterKeyword = filterKeyword.trim().toLowerCase();
  if (!loweredFilterKeyword) {
    return targets;
  }
  return targets.filter((item) => item.full_path.toLowerCase().includes(loweredFilterKeyword));
}
