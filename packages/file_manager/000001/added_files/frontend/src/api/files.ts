/**
 * ファイルAPI クライアント
 * バックエンドのFastAPI エンドポイントと通信
 *
 * 注: インデックス検索は外部サービス（file_index_service）に移行
 *     → indexService.ts を参照
 * PWA配信時は同一オリジンのため相対パスを使用
 */
import type { DirectoryResponse, SearchResponse, SearchParams, PathInfoResponse } from "../types/file";
import { API_BASE_URL } from "../config";
import type { EditorLanguage } from "../utils/codeEditorHighlight";
import type { MarkdownOpenMode, TextFileOpenMode } from "../utils/editorPreferences";

const API_URL = `${API_BASE_URL}/api`;

/**
 * パスの種別を取得（ファイル/ディレクトリ/存在しない）
 */
export async function getPathInfo(path: string): Promise<PathInfoResponse> {
  const url = new URL(`${API_URL}/path-info`, window.location.origin);
  if (path) {
    url.searchParams.set("path", path);
  }

  const response = await fetch(url.toString());

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "パス情報の取得に失敗しました");
  }

  return response.json();
}

/**
 * ファイル一覧を取得
 */
export async function getFiles(path: string = ""): Promise<DirectoryResponse> {
  const url = new URL(`${API_URL}/files`, window.location.origin);
  if (path) {
    url.searchParams.set("path", path);
  }

  const response = await fetch(url.toString());

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "ファイル一覧の取得に失敗しました");
  }

  return response.json();
}

/**
 * フォルダ自身と配下を走査し、最も新しい更新日時を取得する。
 * 共有フォルダでの過負荷を避けるため、ユーザー操作時だけ呼び出す。
 */
export async function getFolderLatestModified(path: string): Promise<{
  path: string;
  modified: string;
  scanned_entries: number;
  truncated: boolean;
}> {
  const response = await fetch(`${API_URL}/folder-latest-modified`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "フォルダの最新更新日時取得に失敗しました");
  }

  return response.json();
}

/** ペイン内フォルダのGit未コミット変更有無を一括取得する。 */
export async function getFolderGitStatuses(paths: string[]): Promise<Array<{
  path: string;
  has_changes: boolean;
  changed_files: string[];
  has_more_changes: boolean;
  ahead_count: number;
  behind_count: number;
}>> {
  const response = await fetch(`${API_URL}/git-folder-statuses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Git状態の取得に失敗しました");
  }

  const data = await response.json();
  return data.items;
}

/**
 * ファイル/フォルダを削除
 */
export async function deleteItem(
  path: string,
  asyncMode: boolean = false,
  debugMode: boolean = false,
  forceKillPids?: number[]
): Promise<{
  status: string;
  message?: string;
  task_id?: string;
}> {
  const response = await fetch(`${API_URL}/delete`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path,
      async_mode: asyncMode,
      debug_mode: debugMode,
      force_kill_pids: forceKillPids
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    if (response.status === 409 && error.locked_by) {
      const err = new Error(error.detail || "ファイルがロックされています");
      (err as any).lockedBy = error.locked_by;
      throw err;
    }
    throw new Error(error.detail || "削除に失敗しました");
  }
  return await response.json();
}

/**
 * ファイル数をカウント（フォルダの場合は指定した深さまで再帰的にカウント）
 */
export async function countFiles(
  paths: string[],
  maxDepth: number = 3
): Promise<{
  total_count: number;
  details: Array<{
    path: string;
    count: number;
    type: string;
    error?: string;
  }>;
}> {
  const response = await fetch(`${API_URL}/count-files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paths,
      max_depth: maxDepth
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "ファイル数カウントに失敗しました");
  }
  return await response.json();
}

/**
 * 複数のファイル/フォルダを一括削除
 */
export async function deleteItemsBatch(
  paths: string[],
  asyncMode: boolean = false,
  debugMode: boolean = false,
  forceKillPids?: number[]
): Promise<{
  status: string;
  success_count?: number;
  fail_count?: number;
  results?: any[];
  task_id?: string;
  message?: string;
}> {
  const response = await fetch(`${API_URL}/delete/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paths,
      async_mode: asyncMode,
      debug_mode: debugMode,
      force_kill_pids: forceKillPids
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    if (response.status === 409 && error.locked_by) {
      const err = new Error(error.detail || "ファイルがロックされています");
      (err as any).lockedBy = error.locked_by;
      throw err;
    }
    throw new Error(error.detail || "削除に失敗しました");
  }
  return await response.json();
}

/**
 * フォルダを作成
 */
export async function createFolder(
  parentPath: string,
  name: string
): Promise<void> {
  const response = await fetch(`${API_URL}/create-folder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: parentPath, name }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "フォルダ作成に失敗しました");
  }
}

/**
 * ファイル/フォルダをリネーム
 */
export async function renameItem(
  oldPath: string,
  newName: string
): Promise<void> {
  const response = await fetch(`${API_URL}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ old_path: oldPath, new_name: newName }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "リネームに失敗しました");
  }
}

/**
 * ファイル検索（Liveモード用 - ディレクトリ走査）
 */
export async function searchFiles(params: SearchParams): Promise<SearchResponse> {
  const url = new URL(`${API_URL}/search`, window.location.origin);
  url.searchParams.set("path", params.path);
  url.searchParams.set("query", params.query);
  url.searchParams.set("depth", params.depth.toString());
  url.searchParams.set("ignore", params.ignore);
  if (params.maxResults) {
    url.searchParams.set("max_results", params.maxResults.toString());
  }
  // ファイルタイプフィルタ
  if (params.fileType && params.fileType !== "all") {
    url.searchParams.set("file_type", params.fileType);
  }

  const response = await fetch(url.toString());

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "検索に失敗しました");
  }

  return response.json();
}

/**
 * ファイル/フォルダを移動
 */
export async function moveItem(
  srcPath: string,
  destPath: string
): Promise<void> {
  const response = await fetch(`${API_URL}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ src_path: srcPath, dest_path: destPath }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "移動に失敗しました");
  }
}

/**
 * ファイルを作成
 */
export async function createFile(parentPath: string, name: string, content: string = ""): Promise<{ status: string; message: string; path: string }> {
  const response = await fetch(`${API_URL}/create-file`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: parentPath, name, content }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "ファイルの作成に失敗しました");
  }
  return await response.json();
}

/**
 * ファイルの内容を更新
 */
export async function updateFile(filePath: string, content: string): Promise<{ status: string; message: string }> {
  const response = await fetch(`${API_URL}/update-file`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: filePath, content }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "ファイルの更新に失敗しました");
  }
  return await response.json();
}

/**
 * ZIPファイルを解凍
 */
export async function unzipFile(
  path: string
): Promise<{
  status: string;
  message: string;
  extracted_path: string;
}> {
  const response = await fetch(`${API_URL}/unzip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "解凍に失敗しました");
  }
  return await response.json();
}
// 複数ファイル/フォルダを移動（安全な移動: コピー → 検証 → 削除）
// asyncMode=true の場合はタスクIDを返す（非同期処理）
export const moveItemsBatch = async (
  srcPaths: string[],
  destPath: string,
  overwrite: boolean = false,
  verifyChecksum: boolean = false,
  asyncMode: boolean = false,
  debugMode: boolean = false
): Promise<{ status: string; success_count?: number; fail_count?: number; results?: any[]; task_id?: string }> => {
  const response = await fetch(`${API_URL}/move/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      src_paths: srcPaths,
      dest_path: destPath,
      overwrite,
      verify_checksum: verifyChecksum,
      async_mode: asyncMode,
      debug_mode: debugMode
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "移動に失敗しました");
  }

  return await response.json();
};

// 複数ファイル/フォルダをコピー
export const copyItemsBatch = async (
  srcPaths: string[],
  destPath: string,
  overwrite: boolean = false,
  verifyChecksum: boolean = false,
  asyncMode: boolean = false,
  debugMode: boolean = false
): Promise<{
  status: string;
  success_count?: number;
  fail_count?: number;
  results?: any[];
  task_id?: string;
}> => {
  const response = await fetch(`${API_URL}/copy/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      src_paths: srcPaths,
      dest_path: destPath,
      overwrite,
      verify_checksum: verifyChecksum,
      async_mode: asyncMode,
      debug_mode: debugMode
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "コピーに失敗しました");
  }

  return await response.json();
};

/**
 * VS Codeで開く
 */
export async function openInVSCode(path: string): Promise<void> {
  const response = await fetch(`${API_URL}/open/vscode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "VS Codeで開けませんでした");
  }
}

/**
 * テキストエディターで開く
 */
export async function openInEditor(path: string): Promise<void> {
  const response = await fetch(`${API_URL}/open/editor`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "エディターで開けませんでした");
  }
}

/**
 * プログラムコードファイルを実行する
 */
export async function executeProgramCode(path: string): Promise<void> {
  const response = await fetch(`${API_URL}/open/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "実行に失敗しました");
  }
}

/**
 * エクスプローラー/Finderで開く
 */
export async function openInExplorer(path: string): Promise<void> {
  const response = await fetch(`${API_URL}/open/explorer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "フォルダを開けませんでした");
  }
}

/**
 * ダウンロードURLを取得
 */
export function getDownloadUrl(path: string): string {
  const url = new URL(`${API_URL}/download`, window.location.origin);
  url.searchParams.set("path", path);
  return url.toString();
}

/**
 * 全文検索URLを取得
 */
export function getFullTextSearchUrl(path: string): string {
  const url = new URL("http://127.0.0.1:8079/");
  const normalizedPath = path.replace(/^\/([A-Za-z]:\/)/, "$1");
  url.searchParams.set("full_path", normalizedPath);
  return url.toString();
}

/**
 * PDF表示用URLを取得
 * ダブルクリック時に同期的に新規タブを開くために利用する
 */
export function getPdfViewUrl(path: string): string {
  const url = new URL(`${API_URL}/view-pdf`, window.location.origin);
  url.searchParams.set("path", path);
  return url.toString();
}

/**
 * HTMLプレビュー表示用URLを取得
 * 右クリックメニュー等からブラウザの別タブで開くために利用する
 */
export function getHtmlViewUrl(path: string): string {
  const url = new URL(`${API_URL}/view-html`, window.location.origin);
  url.searchParams.set("path", path);
  return url.toString();
}

/**
 * Antigravityで開く
 */
export async function openInAntigravity(path: string): Promise<void> {
  const response = await fetch(`${API_URL}/open/antigravity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Antigravityで開けませんでした");
  }
}

/**
 * Jupyterで開く
 */
export async function openInJupyter(path: string): Promise<void> {
  const response = await fetch(`${API_URL}/open/jupyter`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Jupyterで開けませんでした");
  }
}

/**
 * Excalidrawで開く
 */
export async function openInExcalidraw(path: string): Promise<void> {
  const response = await fetch(`${API_URL}/open/excalidraw`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Excalidrawで開けませんでした");
  }
}

/**
 * Obsidianで開く
 * パスに「obsidian」を含むディレクトリがある必要がある
 */
export async function openInObsidian(path: string): Promise<void> {
  const response = await fetch(`${API_URL}/open/obsidian`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Obsidianで開けませんでした");
  }
}

export function buildFullPathUrl(
  path: string,
  options?: {
    textFileOpenMode?: TextFileOpenMode;
    markdownOpenMode?: MarkdownOpenMode;
  }
): string {
  const url = new URL(`${API_URL}/fullpath`, window.location.origin);
  url.searchParams.set("path", path);

  if (options?.textFileOpenMode) {
    url.searchParams.set("text_mode", options.textFileOpenMode);
  }

  if (options?.markdownOpenMode) {
    url.searchParams.set(
      "markdown_mode",
      options.markdownOpenMode
    );
  }

  return url.toString();
}

/**
 * このWebアプリで指定パスを開くURLを構築する
 * ファイルパスでもアプリ側で親フォルダへ自動リダイレクトされる
 */
export function buildAppPathUrl(path: string): string {
  const url = new URL(window.location.origin);
  url.searchParams.set("path", path);
  return url.toString();
}

// ----------------------------------------------------------------
// ファイルオープンAPI
// ----------------------------------------------------------------

/**
 * スマートオープン結果の型
 */
export interface SmartOpenResult {
  status: string;
  action: "opened" | "open_modal" | "open_url";
  message: string;
  content?: string;  // action=open_modalの場合のファイル内容
  url?: string;  // action=open_urlの場合のURL
  editor_mode?: "markdown" | "code";
  language?: EditorLanguage;
}

interface OpenSmartOptions {
  preferEmbedded?: boolean;
}

/**
 * ファイル種類に応じてスマートに開く
 * バックエンドで種類判定を行い、適切な処理を実行
 */
export async function openSmart(path: string, options?: OpenSmartOptions): Promise<SmartOpenResult> {
  const response = await fetch(`${API_URL}/open/smart`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path,
      prefer_embedded: options?.preferEmbedded ?? false,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "ファイルを開けませんでした");
  }

  return response.json();
}

/**
 * デフォルトアプリケーションでファイルを開く
 */
export async function openInDefaultApp(path: string): Promise<{ success: boolean; message: string }> {
  try {
    const response = await fetch(`${API_URL}/open/default`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });

    if (!response.ok) {
      const error = await response.json();
      return { success: false, message: error.detail || "ファイルを開けませんでした" };
    }

    return { success: true, message: "ファイルを開きました" };
  } catch {
    return { success: false, message: "サーバーに接続できませんでした" };
  }
}

/**
 * ゴミ箱を開く
 */
export async function openTrash(): Promise<{ success: boolean; message?: string; error?: string }> {
  const response = await fetch(`${API_URL}/open/trash`, {
    method: "POST",
  });
  return await response.json();
}

/**
 * テストフォルダのパスを取得
 */
export async function getTestFolderPath(): Promise<{ success: boolean; path?: string; error?: string }> {
  const response = await fetch(`${API_URL}/test-folder-path`);
  return await response.json();
}

/**
 * ファイルの内容を取得（Markdownエディタ用）
 */
export async function getFileContent(path: string): Promise<string> {
  const response = await fetch(`${API_URL}/file-content?path=${encodeURIComponent(path)}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "ファイル内容の取得に失敗しました");
  }

  const data = await response.json();
  return data.content;
}


export interface UploadFileItem {
  file: File;
  relativePath?: string;
}

/**
 * ファイルおよびフォルダをアップロード
 */
export async function uploadFiles(
  path: string,
  files: (File | UploadFileItem)[],
  emptyDirectories?: string[]
): Promise<{
  status: string;
  message: string;
  uploaded?: string[];
  created_directories?: string[];
  errors?: string[];
}> {
  const formData = new FormData();
  files.forEach((item) => {
    if ("file" in item) {
      formData.append("files", item.file);
      if (item.relativePath) {
        formData.append("relative_paths", item.relativePath);
      }
    } else {
      formData.append("files", item);
    }
  });

  if (emptyDirectories && emptyDirectories.length > 0) {
    emptyDirectories.forEach((dir) => {
      formData.append("empty_directories", dir);
    });
  }

  const url = new URL(`${API_URL}/upload`, window.location.origin);
  url.searchParams.set("path", path);

  const response = await fetch(url.toString(), {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "アップロードに失敗しました");
  }

  return await response.json();
}

/**
 * Obsidianの今日のフォルダパスを取得（存在しない場合は作成される）
 */
export async function getObsidianDailyPath(): Promise<{ path: string }> {
  const url = new URL(`${API_URL}/obsidian/daily-path`, window.location.origin);
  const response = await fetch(url.toString());

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Obsidianパスの取得に失敗しました");
  }

  return response.json();
}
