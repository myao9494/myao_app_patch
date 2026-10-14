/**
 * インデックスサービスAPIクライアント
 * Everything互換の外部インデックスサービスと通信
 */

import { API_BASE_URL } from "../config";

// インデックスサービスのデフォルトURL (バックエンドプロキシ経由)
const DEFAULT_INDEX_SERVICE_URL = `${API_BASE_URL}/api/index`;

// ローカルストレージのキー
const INDEX_SERVICE_URL_KEY = "file_manager_index_service_url";

/**
 * インデックスサービスURLを取得
 */
export function getIndexServiceUrl(): string {
  return localStorage.getItem(INDEX_SERVICE_URL_KEY) || DEFAULT_INDEX_SERVICE_URL;
}

/**
 * インデックスサービスURLを設定
 */
export function setIndexServiceUrl(url: string): void {
  localStorage.setItem(INDEX_SERVICE_URL_KEY, url);
}

/**
 * インデックスサービスのステータス
 */
export interface IndexServiceStatus {
  ready: boolean;
  version: string;
  paths: Array<{
    path: string;
    status: string;
    indexed_files: number;
    total_files: number;
    error_message: string | null;
  }>;
  total_indexed: number;
}

/**
 * インデックスサービスのステータスを取得
 */
export async function getIndexServiceStatus(): Promise<IndexServiceStatus> {
  const url = getIndexServiceUrl();

  try {
    const response = await fetch(`${url}/status`);
    if (!response.ok) {
      // サービスが起動していない場合はエラーにせず、準備未完了として返す
      console.warn("インデックスサービスに接続できません");
      return {
        ready: false,
        version: "",
        paths: [],
        total_indexed: 0,
        error_message: null
      } as unknown as IndexServiceStatus;
    }
    return response.json();
  } catch (error) {
    // 接続エラー（CORSやサーバーダウン）も同様に処理
    console.warn("インデックスサービスへの接続に失敗しました", error);
    return {
      ready: false,
      version: "",
      paths: [],
      total_indexed: 0,
      error_message: null
    } as unknown as IndexServiceStatus;
  }
}

/**
 * インデックスサービスで検索（Everything互換）
 */
export interface IndexSearchParams {
  query: string;
  path?: string;
  count?: number;
  offset?: number;
  sort?: "name" | "path" | "size" | "date_modified";
  ascending?: boolean;
  fileType?: "all" | "file" | "directory";
}

export interface IndexSearchResult {
  name: string;
  path: string;
  type: string;
  size: number;
  date_modified: number;
  snippet?: string;
}

export interface IndexSearchResponse {
  totalResults: number;
  results: IndexSearchResult[];
}

/** 検索語を空白（半角・全角）で分割する */
export function splitQueryTokens(query: string): string[] {
  return query.split(/\s+/).filter(Boolean);
}

/** フルパスに全ての語を含む項目だけを残す（大文字小文字は区別しない） */
export function filterByAllTokens<T extends { path: string }>(items: T[], tokens: string[]): T[] {
  const lowered = tokens.map((t) => t.toLowerCase());
  return items.filter((item) => {
    const path = item.path.toLowerCase();
    return lowered.every((t) => path.includes(t));
  });
}

/**
 * インデックスサービスで検索する。
 * 複数語の場合は語ごとに問い合わせて統合し、フルパス（フォルダ名を含む）に
 * 全語を含むものだけを返す（例:「人事 top」→ 人事/top.excalidraw）。
 */
export async function searchIndexService(params: IndexSearchParams): Promise<IndexSearchResponse> {
  const tokens = splitQueryTokens(params.query);
  if (tokens.length <= 1) {
    return searchIndexServiceOnce(params);
  }

  const responses = await Promise.all(
    tokens.map((token) => searchIndexServiceOnce({ ...params, query: token }))
  );
  const seen = new Set<string>();
  const merged: IndexSearchResult[] = [];
  for (const response of responses) {
    for (const item of response.results) {
      if (seen.has(item.path)) continue;
      seen.add(item.path);
      merged.push(item);
    }
  }
  const results = filterByAllTokens(merged, tokens);
  return { totalResults: results.length, results };
}

async function searchIndexServiceOnce(params: IndexSearchParams): Promise<IndexSearchResponse> {
  const baseUrl = getIndexServiceUrl();
  const url = new URL(baseUrl, window.location.origin);

  url.searchParams.set("search", params.query);
  url.searchParams.set("json", "1");

  if (params.path) {
    url.searchParams.set("path", params.path);
  }
  if (params.count !== undefined) {
    url.searchParams.set("count", params.count.toString());
  }
  if (params.offset !== undefined) {
    url.searchParams.set("offset", params.offset.toString());
  }
  if (params.sort) {
    url.searchParams.set("sort", params.sort);
  }
  if (params.ascending !== undefined) {
    url.searchParams.set("ascending", params.ascending ? "1" : "0");
  }
  if (params.fileType && params.fileType !== "all") {
    url.searchParams.set("file_type", params.fileType);
  }

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error("検索に失敗しました");
  }

  return response.json();
}

/**
 * 監視パス一覧を取得
 */
export interface IndexWatchPath {
  id: number;
  path: string;
  enabled: number;
  status: string;
  total_files: number;
  indexed_files: number;
  last_full_scan: number | null;
  last_updated: number | null;
  error_message: string | null;
}

export async function getIndexWatchPaths(): Promise<IndexWatchPath[]> {
  const url = getIndexServiceUrl();

  const response = await fetch(`${url}/paths`);

  if (!response.ok) {
    throw new Error("監視パス一覧の取得に失敗しました");
  }

  return response.json();
}

/**
 * 監視パスを追加
 */
export async function addIndexWatchPath(path: string): Promise<{ path: string; status: string }> {
  const url = getIndexServiceUrl();

  const response = await fetch(`${url}/paths`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "監視パスの追加に失敗しました");
  }

  return response.json();
}

/**
 * 監視パスを削除
 */
export async function removeIndexWatchPath(path: string): Promise<{ path: string; status: string }> {
  const baseUrl = getIndexServiceUrl();
  const url = new URL(`${baseUrl}/paths`, window.location.origin);
  url.searchParams.set("path", path);

  const response = await fetch(url.toString(), { method: "DELETE" });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "監視パスの削除に失敗しました");
  }

  return response.json();
}

/**
 * インデックスを再構築
 */
export async function rebuildIndex(path?: string): Promise<{ status: string; message: string }> {
  const baseUrl = getIndexServiceUrl();
  const url = new URL(`${baseUrl}/rebuild`, window.location.origin);
  if (path) {
    url.searchParams.set("path", path);
  }

  const response = await fetch(url.toString(), { method: "POST" });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "インデックス再構築に失敗しました");
  }

  return response.json();
}
