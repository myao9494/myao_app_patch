/**
 * 拡張子フィルタのトークン解析および検索結果絞り込みユーティリティ。
 * 空白またはカンマ区切りの入力を解析し、通常の包含指定（例: .md, pdf）と
 * マイナス記号による除外指定（例: -.png, -png）を判定して検索結果をフィルタリングする。
 **/
import type { SearchResult } from "./types";

/**
 * 拡張子入力を `.md` 形式へ正規化し、空値は捨てる。
 */
export function normalizeExtensionToken(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

export type SearchFilterExtensions = {
  include: string[];
  exclude: string[];
};

/**
 * 拡張子フィルタ文字列を解析し、包含拡張子一覧と除外拡張子一覧に分離する。
 * `-png` や `-.png` など、先頭にマイナスが付くものは除外対象として抽出される。
 */
export function parseSearchFilterTokens(value: string): SearchFilterExtensions {
  const trimmed = value.trim();
  if (!trimmed) {
    return { include: [], exclude: [] };
  }

  const rawTokens = trimmed.split(/[\s,]+/).filter(Boolean);
  const include: string[] = [];
  const exclude: string[] = [];

  for (const token of rawTokens) {
    const cleanToken = token.trim().toLowerCase();
    if (cleanToken.startsWith("-") && cleanToken.length > 1) {
      const withoutMinus = cleanToken.slice(1).trim();
      if (withoutMinus) {
        exclude.push(normalizeExtensionToken(withoutMinus));
      }
    } else if (!cleanToken.startsWith("-")) {
      include.push(normalizeExtensionToken(cleanToken));
    }
  }

  return {
    include: [...new Set(include.filter(Boolean))],
    exclude: [...new Set(exclude.filter(Boolean))],
  };
}

/**
 * 空白またはカンマ区切りの拡張子入力を UI フィルター用の一意な包含拡張子一覧へ変換する。
 * （後方互換性のため維持）
 */
export function parseSearchFilterExtensions(value: string): string[] {
  return parseSearchFilterTokens(value).include;
}

/**
 * 検索結果を拡張子フィルタ（包含・除外）で絞り込む。
 * 1. 除外拡張子（例: -.png, -jpg）に合致するファイルを除外する。
 * 2. 包含拡張子（例: md, pdf）が指定されている場合は、その拡張子に合致するもののみ残す。
 * 3. 包含指定がなく除外指定のみの場合は、除外対象以外のすべての結果を残す。
 */
export function filterSearchResultsByExtensions(items: readonly SearchResult[], value: string): SearchResult[] {
  const { include, exclude } = parseSearchFilterTokens(value);
  if (include.length === 0 && exclude.length === 0) {
    return [...items];
  }

  const includeSet = new Set(include);
  const excludeSet = new Set(exclude);

  return items.filter((item) => {
    const ext = (item.file_ext || "").toLowerCase();
    if (excludeSet.has(ext)) {
      return false;
    }
    if (includeSet.size > 0 && !includeSet.has(ext)) {
      return false;
    }
    return true;
  });
}

