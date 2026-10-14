/**
 * 検索対象フォルダの包含判定。
 * 指定パスが登録済みの検索対象フォルダ（またはその配下）に含まれるかを、区切り文字の違いを吸収して判定する。
 **/

import type { SearchTargetFolder } from "./types";

/**
 * 検索対象フォルダの親子判定用に、区切りを統一して末尾スラッシュを除去する。
 */
export function normalizeComparablePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/");
  if (trimmed.length <= 1) {
    return trimmed;
  }
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

/**
 * 検索対象フォルダ一覧に、指定パス（または親）が含まれるか判定する。
 * 有効/無効に関わらず、親フォルダが登録済みなら子の自動追加候補は表示しない。
 */
export function isPathCoveredByTarget(path: string, searchTargets: readonly SearchTargetFolder[]): boolean {
  const normalizedPath = normalizeComparablePath(path);
  if (!normalizedPath) {
    return false;
  }
  const registeredPaths = searchTargets
    .map((item) => normalizeComparablePath(item.full_path))
    .filter(Boolean);
  return registeredPaths.some((rootPath) => normalizedPath === rootPath || normalizedPath.startsWith(`${rootPath}/`));
}
