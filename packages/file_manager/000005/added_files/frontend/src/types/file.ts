/**
 * ファイル/フォルダアイテムの型定義
 */
export interface FileItem {
  name: string;
  type: "file" | "directory";
  path: string;
  size?: number;
  modified?: string;
  snippet?: string;
  relativePath?: string;
}

/**
 * フォルダ内画像一覧レスポンスの型定義
 */
export interface FolderImagesResponse {
  path: string;
  depth: number;
  total: number;
  images: FileItem[];
}

/**
 * ディレクトリ一覧レスポンスの型定義
 */
export interface DirectoryResponse {
  type: "directory";
  items: FileItem[];
}

/**
 * 検索レスポンスの型定義
 */
export interface SearchResponse {
  query: string;
  path: string;
  depth: number;
  total: number;
  items: FileItem[];
}

/**
 * 検索パラメータの型定義（Liveモード用）
 *
 * 注: インデックス検索は外部サービス（file_index_service）を使用
 *     → IndexSearchParams（indexService.ts）を参照
 */
export interface SearchParams {
  path: string;
  query: string;
  depth: number;
  ignore: string;
  maxResults?: number;
  fileType?: "all" | "file" | "directory";
}

/**
 * パス情報レスポンスの型定義
 */
export interface PathInfoResponse {
  path: string;
  type: "file" | "directory" | "not_found";
  parent?: string;
}

/**
 * 右クリックメニューのアクション
 */
export type ContextMenuAction =
  | "copy-path"
  | "rename"
  | "delete"
  | "copy"
  | "cut"
  | "paste";
