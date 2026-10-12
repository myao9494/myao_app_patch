/**
 * 検索結果の並び替え。
 * 再検索せずに、現在の UI 指定（並び順キーと昇順 / 降順）だけで安定した順序を作る。
 * 既定順ではハイブリッド融合スコアを最優先し、同点ならファイル名一致レベル、top タグ、
 * 検索語別クリック、本文関連度、利用価値、更新日時の順で比較する。
 **/

import type { SearchResult } from "./types";

/**
 * 検索結果は再検索せずに、現在の UI 指定だけで安定した並び替えを行う。
 */
export function sortSearchResults(
  items: readonly SearchResult[],
  {
    sortBy,
    sortOrder,
  }: {
    sortBy: "default" | "hybrid_score" | "vector_score" | "keyword_score" | "created" | "modified" | "click_count",
    sortOrder: "asc" | "desc",
  },
): SearchResult[] {
  if (sortBy === "default") {
    return [...items].sort((left, right) => {
      // ハイブリッド検索結果の場合は、ハイブリッド融合スコア順（RRF順位）を最優先
      const hybridDifference = (right.hybrid_score ?? -1) - (left.hybrid_score ?? -1);
      if (hybridDifference !== 0 && (right.hybrid_score != null || left.hybrid_score != null)) {
        return hybridDifference;
      }
      const filenameDifference = (right.filename_match_level ?? 0) - (left.filename_match_level ?? 0);
      if (filenameDifference !== 0) return filenameDifference;
      const topDifference = Number(Boolean(right.has_obsidian_top_tag)) - Number(Boolean(left.has_obsidian_top_tag));
      if (topDifference !== 0) return topDifference;
      const queryClickDifference = (right.query_click_score ?? 0) - (left.query_click_score ?? 0);
      if (queryClickDifference !== 0) return queryClickDifference;
      const relevanceDifference = (right.relevance_bucket ?? 0) - (left.relevance_bucket ?? 0);
      if (relevanceDifference !== 0) return relevanceDifference;
      const utilityDifference = (right.utility_score ?? 0) - (left.utility_score ?? 0);
      if (utilityDifference !== 0) return utilityDifference;
      const modifiedDifference = new Date(right.mtime).getTime() - new Date(left.mtime).getTime();
      return modifiedDifference !== 0 ? modifiedDifference : right.file_id - left.file_id;
    });
  }
  const direction = sortOrder === "asc" ? 1 : -1;

  return [...items].sort((left, right) => {
    const leftValue = getSortableValue(left, sortBy);
    const rightValue = getSortableValue(right, sortBy);
    if (leftValue < rightValue) {
      return -1 * direction;
    }
    if (leftValue > rightValue) {
      return 1 * direction;
    }
    return left.file_id - right.file_id;
  });
}

/**
 * 並び替えキーごとの比較値を数値へ正規化する。
 */
function getSortableValue(
  item: SearchResult,
  sortBy: "hybrid_score" | "vector_score" | "keyword_score" | "created" | "modified" | "click_count",
): number {
  if (sortBy === "hybrid_score") {
    return item.hybrid_score ?? -1;
  }
  if (sortBy === "vector_score") {
    return item.vector_score ?? -1;
  }
  if (sortBy === "keyword_score") {
    return item.keyword_score ?? -1;
  }
  if (sortBy === "click_count") {
    return item.click_count;
  }
  if (sortBy === "created") {
    return new Date(item.created_at).getTime();
  }
  return new Date(item.mtime).getTime();
}
