/**
 * ファイル一覧取得のカスタムフック
 *
 * 注: インデックス検索は外部サービス（file_index_service）を使用
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getFiles,
  deleteItem,
  deleteItemsBatch,
  createFolder,
  renameItem,
  searchFiles,
  moveItemsBatch,
  copyItemsBatch,
  unzipFile,
} from "../api/files";
import {
  getIndexServiceStatus,
  searchIndexService,
  getIndexWatchPaths,
  addIndexWatchPath,
  removeIndexWatchPath,
  rebuildIndex as rebuildExternalIndex,
  type IndexSearchParams,
} from "../api/indexService";
import {
  getFulltextIndexServiceStatus,
  searchFulltextIndexService,
  type FulltextIndexServiceStatus,
} from "../api/fulltextIndexService";
import type { SearchParams } from "../types/file";

/**
 * ファイル一覧を取得するフック
 */
export function useFiles(path: string) {
  return useQuery({
    queryKey: ["files", path],
    queryFn: () => getFiles(path),
    enabled: !!path,
  });
}

/**
 * ファイル削除のミューテーション
 */
export function useDeleteItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ path, asyncMode, debugMode, forceKillPids }: {
      path: string;
      asyncMode?: boolean;
      debugMode?: boolean;
      forceKillPids?: number[];
    }) => deleteItem(path, asyncMode, debugMode, forceKillPids),
    onSuccess: (_data, variables) => {
      // 非同期モードでない場合のみ即座にリフレッシュ
      if (!variables.asyncMode) {
        queryClient.invalidateQueries({ queryKey: ["files"] });
      }
    },
  });
}

/**
 * 複数ファイル一括削除のミューテーション
 */
export function useDeleteItemsBatch() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ paths, asyncMode, debugMode, forceKillPids }: {
      paths: string[];
      asyncMode?: boolean;
      debugMode?: boolean;
      forceKillPids?: number[];
    }) => deleteItemsBatch(paths, asyncMode, debugMode, forceKillPids),
    onSuccess: (_data, variables) => {
      // 非同期モードでない場合のみ即座にリフレッシュ
      if (!variables.asyncMode) {
        queryClient.invalidateQueries({ queryKey: ["files"] });
      }
    },
  });
}

/**
 * フォルダ作成のミューテーション
 */
export function useCreateFolder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ parentPath, name }: { parentPath: string; name: string }) =>
      createFolder(parentPath, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["files"] });
    },
  });
}

/**
 * リネームのミューテーション
 */
export function useRenameItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ oldPath, newName }: { oldPath: string; newName: string }) =>
      renameItem(oldPath, newName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["files"] });
    },
  });
}

export function useMoveItemsBatch() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ srcPaths, destPath, overwrite, verifyChecksum, asyncMode, debugMode }: {
      srcPaths: string[];
      destPath: string;
      overwrite?: boolean;
      verifyChecksum?: boolean;
      asyncMode?: boolean;
      debugMode?: boolean;
    }) =>
      moveItemsBatch(srcPaths, destPath, overwrite, verifyChecksum, asyncMode, debugMode),
    onSuccess: (_, variables) => {
      // 非同期モードでない場合のみ即座にリフレッシュ
      if (!variables.asyncMode) {
        queryClient.invalidateQueries({ queryKey: ["files"] });
      }
    },
  });
}

export function useCopyItemsBatch() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ srcPaths, destPath, overwrite, verifyChecksum, asyncMode, debugMode }: {
      srcPaths: string[];
      destPath: string;
      overwrite?: boolean;
      verifyChecksum?: boolean;
      asyncMode?: boolean;
      debugMode?: boolean;
    }) =>
      copyItemsBatch(srcPaths, destPath, overwrite, verifyChecksum, asyncMode, debugMode),
    onSuccess: (_data, variables) => {
      // 非同期モードでない場合のみ即座にリフレッシュ
      if (!variables.asyncMode) {
        queryClient.invalidateQueries({ queryKey: ["files"] });
      }
    },
  });
}

/**
 * ファイル解凍のミューテーション
 */
export function useUnzipItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (path: string) => unzipFile(path),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["files"] });
    },
  });
}

/**
 * ファイル検索フック（Liveモード用）
 */
export function useSearchFiles(params: SearchParams | null, enabled: boolean = true) {
  return useQuery({
    queryKey: ["search", params],
    queryFn: () => (params ? searchFiles(params) : Promise.resolve({ query: "", path: "", depth: 0, total: 0, items: [] })),
    enabled: enabled && params !== null && params.query.trim() !== "",
    staleTime: 30000,
  });
}

// ========================================
// 外部インデックスサービス用フック
// ========================================

/**
 * 外部インデックスサービスのステータス取得フック
 */
export function useExternalIndexStatus() {
  return useQuery({
    queryKey: ["externalIndexStatus"],
    queryFn: getIndexServiceStatus,
    staleTime: 5000,
    refetchInterval: 10000,
    retry: false,
  });
}

/**
 * 外部インデックスサービスで検索するフック
 */
export function useExternalIndexSearch(params: IndexSearchParams | null, enabled: boolean = true) {
  return useQuery({
    queryKey: ["externalIndexSearch", params],
    queryFn: () => (params ? searchIndexService(params) : Promise.resolve({ totalResults: 0, results: [] })),
    enabled: enabled && params !== null && params.query.trim() !== "",
    staleTime: 30000,
    retry: false,
  });
}

/**
 * 全文検索サービスのステータス取得フック
 */
export function useFulltextIndexStatus() {
  return useQuery<FulltextIndexServiceStatus>({
    queryKey: ["fulltextIndexStatus"],
    queryFn: getFulltextIndexServiceStatus,
    staleTime: 5000,
    refetchInterval: 10000,
    retry: false,
  });
}

/**
 * 全文検索サービスで検索するフック
 */
export function useFulltextIndexSearch(
  params: (IndexSearchParams & { depth?: number }) | null,
  enabled: boolean = true
) {
  return useQuery({
    queryKey: ["fulltextIndexSearch", params],
    queryFn: () => (params ? searchFulltextIndexService(params) : Promise.resolve({ totalResults: 0, results: [] })),
    enabled: enabled && params !== null && params.query.trim() !== "",
    staleTime: 30000,
    retry: false,
  });
}

/**
 * 外部インデックスサービスの監視パス取得フック
 */
export function useExternalWatchPaths() {
  return useQuery({
    queryKey: ["externalWatchPaths"],
    queryFn: getIndexWatchPaths,
    staleTime: 5000,
    refetchInterval: 10000,
    retry: false,
  });
}

/**
 * 外部インデックスサービスへの監視パス追加ミューテーション
 */
export function useAddExternalWatchPath() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (path: string) => addIndexWatchPath(path),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["externalWatchPaths"] });
      queryClient.invalidateQueries({ queryKey: ["externalIndexStatus"] });
    },
  });
}

/**
 * 外部インデックスサービスから監視パス削除ミューテーション
 */
export function useRemoveExternalWatchPath() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (path: string) => removeIndexWatchPath(path),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["externalWatchPaths"] });
      queryClient.invalidateQueries({ queryKey: ["externalIndexStatus"] });
    },
  });
}

/**
 * 外部インデックスサービスの再構築ミューテーション
 */
export function useRebuildExternalIndex() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (path?: string) => rebuildExternalIndex(path),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["externalIndexStatus"] });
    },
  });
}
