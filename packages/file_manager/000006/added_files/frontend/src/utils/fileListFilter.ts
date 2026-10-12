/**
 * ファイル一覧の絞り込み・並べ替え（FileList で使用する純粋関数）
 * - 検索語: 正規表現モードでは大文字小文字を区別しない正規表現、無効な正規表現や通常モードでは部分一致
 * - 種類: all / files / folders
 * - 拡張子: "md+txt" のような + 区切りのリスト（"all" は無制限）。フォルダには適用しない
 * - 並べ替え: name / size / date（date はフォルダ最新日時の集計結果があればそれを優先）
 * - 結果はフォルダとファイルに分けて返す（画面ではフォルダを先に表示する）
 */
import type { FileItem } from "../types/file";

export type FileListSortKey = "name" | "size" | "date";
export type FileListSortOrder = "asc" | "desc";

export interface FileListFilterOptions {
  searchQuery: string;
  isRegex: boolean;
  typeFilter: string;
  extFilter: string;
  sortKey: FileListSortKey;
  sortOrder: FileListSortOrder;
  /** フォルダ最新日時（d キーで集計した値）。date 並べ替えで item.modified より優先する */
  folderLatestModified?: Record<string, string>;
}

export function getFileExtension(name: string): string {
  const lastDotIndex = name.lastIndexOf(".");
  if (lastDotIndex < 0 || lastDotIndex === name.length - 1) {
    return "";
  }
  return name.slice(lastDotIndex + 1).toLowerCase();
}

function compileSearchRegex(searchQuery: string, isRegex: boolean): RegExp | null {
  if (!searchQuery || !isRegex) return null;
  try {
    return new RegExp(searchQuery, "i");
  } catch {
    return null;
  }
}

function sortItems(items: FileItem[], options: FileListFilterOptions): void {
  const { sortKey, sortOrder, folderLatestModified = {} } = options;
  if (sortKey === "name") {
    items.sort((a, b) => {
      const res = a.name.localeCompare(b.name);
      return sortOrder === "asc" ? res : -res;
    });
    return;
  }

  const decorated = items.map((item) => {
    const modified = folderLatestModified[item.path] ?? item.modified;
    return {
      item,
      sortValue: sortKey === "size" ? (item.size || 0) : (modified ? Date.parse(modified) || 0 : 0),
    };
  });
  decorated.sort((a, b) => {
    const res = a.sortValue - b.sortValue;
    return sortOrder === "asc" ? res : -res;
  });
  items.splice(0, items.length, ...decorated.map(({ item }) => item));
}

export function filterAndSortItems(
  sourceItems: readonly FileItem[],
  options: FileListFilterOptions,
): { folders: FileItem[]; files: FileItem[] } {
  const { searchQuery, isRegex, typeFilter, extFilter } = options;
  const compiledSearchRegex = compileSearchRegex(searchQuery, isRegex);
  const normalizedSearchQuery = searchQuery.toLowerCase();
  const allowedExtensions = extFilter === "all" ? null : new Set(extFilter.split("+").filter(Boolean));

  const folders: FileItem[] = [];
  const files: FileItem[] = [];

  for (const item of sourceItems) {
    if (searchQuery) {
      const matches = compiledSearchRegex
        ? compiledSearchRegex.test(item.name)
        : item.name.toLowerCase().includes(normalizedSearchQuery);
      if (!matches) continue;
    }

    if (typeFilter === "folders" && item.type !== "directory") continue;
    if (typeFilter === "files" && item.type !== "file") continue;

    if (allowedExtensions && item.type === "file" && !allowedExtensions.has(getFileExtension(item.name))) {
      continue;
    }

    (item.type === "directory" ? folders : files).push(item);
  }

  sortItems(folders, options);
  sortItems(files, options);
  return { folders, files };
}
