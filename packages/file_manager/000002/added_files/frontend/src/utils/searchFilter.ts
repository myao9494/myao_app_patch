/**
 * 検索フィルタユーティリティ
 * - ファイル名のインクリメンタル検索・正規表現フィルタリング (matchesSearchQuery)
 * - 不正な正規表現の自動フォールバック
 * - 検索ヒット件数のフォーマット表示 (formatSearchMatchCount)
 */

/**
 * ファイル名が検索クエリにマッチするか判定する
 * @param itemName ファイル名またはフォルダ名
 * @param query 検索クエリ文字列
 * @param isRegex 正規表現モードかどうか
 */
export function matchesSearchQuery(
  itemName: string,
  query: string,
  isRegex: boolean
): boolean {
  const trimmed = query.trim();
  if (!trimmed) {
    return true;
  }

  if (isRegex) {
    try {
      const reg = new RegExp(trimmed, "i");
      return reg.test(itemName);
    } catch {
      // 正規表現の文法エラー時は通常の部分一致（大文字小文字無視）にフォールバック
      return itemName.toLowerCase().includes(trimmed.toLowerCase());
    }
  }

  return itemName.toLowerCase().includes(trimmed.toLowerCase());
}

/**
 * 検索結果の件数表示文字列をフォーマットする
 * @param matchedCount マッチしたアイテム数
 * @param totalCount 全アイテム数
 */
export function formatSearchMatchCount(matchedCount: number, totalCount: number): string {
  return `${matchedCount} / ${totalCount}`;
}

/**
 * 検索ヒットリスト内での次または前のインデックスを計算する（Enter / Shift+Enter）
 * @param currentIndex 現在フォーカスされているインデックス
 * @param totalHits 検索ヒットの総数
 * @param direction "next" (次へ) または "prev" (前へ)
 */
export function getNextSearchHitIndex(
  currentIndex: number,
  totalHits: number,
  direction: "next" | "prev"
): number {
  if (totalHits <= 0) {
    return 0;
  }

  if (direction === "next") {
    if (currentIndex < 0 || currentIndex >= totalHits) {
      return 0;
    }
    return (currentIndex + 1) % totalHits;
  } else {
    if (currentIndex < 0 || currentIndex >= totalHits) {
      return totalHits - 1;
    }
    return (currentIndex - 1 + totalHits) % totalHits;
  }
}

/**
 * 検索ヒット時の位置表示文字列をフォーマットする (例: "1 / 5")
 * @param currentIndex 現在のインデックス (0-indexed)
 * @param totalHits ヒット総数
 */
export function formatSearchPosition(currentIndex: number, totalHits: number): string {
  if (totalHits <= 0) {
    return "0 / 0";
  }
  const safeIndex = Math.max(0, Math.min(currentIndex, totalHits - 1));
  return `${safeIndex + 1} / ${totalHits}`;
}
