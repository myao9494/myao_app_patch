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

/**
 * ファイルをロックしているプロセス（Windows Restart Manager で取得）
 */
export interface LockingProcess {
  pid: number;
  name: string;
}

/**
 * 一括操作（移動・コピー・削除）の項目ごとの結果
 * - status: success=成功 / error=失敗 / skipped=何もしなかった（移動元と移動先が同じ等）
 * - dest: 移動/コピー先のパス（移動・コピーのみ）
 */
export interface BatchItemResult {
  path: string;
  dest?: string;
  status: "success" | "error" | "skipped";
  message: string;
  locked_by?: LockingProcess[];
}

/**
 * 一括操作APIのレスポンス
 * - 同期モード: status="completed" と結果
 * - 非同期モード: status="async" と task_id（結果は /api/tasks/{id}/progress の result）
 */
export interface BatchOperationResponse {
  status: string;
  success_count?: number;
  fail_count?: number;
  results?: BatchItemResult[];
  task_id?: string;
  message?: string;
}

/**
 * 一括操作の完了結果
 */
export interface BatchOperationResult {
  success_count: number;
  fail_count: number;
  results: BatchItemResult[];
}
