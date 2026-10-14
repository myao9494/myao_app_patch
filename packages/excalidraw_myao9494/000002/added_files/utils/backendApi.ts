/**
 * バックエンド (FastAPI) 呼び出しの集約モジュール
 *
 * API は常に同一オリジンの相対パスで呼び出す。
 * - 本番: FastAPI (port 3001) が dist/ と API を同時に配信
 * - 開発: Vite (port 3001) が /api を FastAPI (port 8008) へ proxy
 */
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";

export const API_BASE_URL = '';

export interface ExcalidrawFileData {
  type: string;
  version: number;
  source: string;
  elements: NonDeletedExcalidrawElement[];
  appState: Partial<AppState>;
  files?: any;
}

/** バックエンドが返すJSON読み込みエラーの詳細 */
export interface ValidationErrorDetail {
  field: string;
  message: string;
  value?: string;
}

export interface JsonErrorResponse {
  error_type: 'json_syntax' | 'validation' | 'schema';
  message: string;
  line?: number;
  column?: number;
  context?: string;
  details?: ValidationErrorDetail[];
}

/** loadExcalidrawFile が throw するエラー */
export interface LoadFileError {
  status: number;
  error: JsonErrorResponse;
}

export interface LoadFileResponse {
  data: ExcalidrawFileData;
  /** ファイルの更新日時（UNIX秒）。外部更新検知の基準になる */
  modified?: number;
  /** 実際に読み込んだパス（.excalidraw → 移行済み .excalidraw.md など） */
  resolvedPath?: string;
  /** Embedded Files の fileId → 解決済みの実ファイルパス */
  embeddedFilePaths?: Record<string, string>;
  /** SVGスナップショットの元ノート候補（同じフォルダの Excalidraw Markdown） */
  embeddedMarkdownCandidates?: string[];
  /** Vault内の .excalidraw など、.excalidraw.md へ変換すべきファイルか（バックエンドが判定） */
  shouldMigrateToMarkdown?: boolean;
}

export interface FileInfoResponse {
  exists: boolean;
  modified?: number;
  isExcalidraw?: boolean;
}

export interface SaveFileResponse {
  success: boolean;
  message?: string;
  modified?: number;
}

export interface ArchiveFileResponse {
  success: boolean;
  archivedPath?: string;
  message?: string;
  error?: string;
}

export interface BackendOpenFileResponse {
  success: boolean;
  targetType?: string;
  resolvedPath?: string;
  message?: string;
}

export interface OpenEditorResponse {
  success: boolean;
  openedPath?: string;
  fallbackUsed?: boolean;
  message?: string;
}

export interface UploadFilesResponse {
  success: boolean;
  files?: Array<{ name: string; path: string; size: number }>;
  error?: string;
}

export interface SavedPathResponse {
  success: boolean;
  savedPath?: string;
  folderPath?: string;
  error?: string;
}

const postJson = (path: string, body: unknown): Promise<Response> =>
  fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** エラーレスポンスから FastAPI の detail（文字列）を取り出す */
const readErrorDetail = async (response: Response): Promise<string> => {
  try {
    const body = await response.json();
    if (typeof body?.detail === 'string') {
      return body.detail;
    }
    if (typeof body?.detail?.message === 'string') {
      return body.detail.message;
    }
  } catch {
    // JSONでない場合はステータスだけを返す
  }
  return `HTTP error! status: ${response.status}`;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Unknown error';

export const isLoadFileError = (error: unknown): error is LoadFileError =>
  Boolean(error && typeof error === 'object' && 'status' in error && 'error' in error);

/**
 * 図面ファイルを読み込む。
 * @returns ファイルが存在しなければ null
 * @throws LoadFileError JSON不正・サーバーエラー・通信エラー
 */
export const loadExcalidrawFile = async (filePath: string): Promise<LoadFileResponse | null> => {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/load-file?filepath=${encodeURIComponent(filePath)}`);
  } catch (error) {
    console.error('Error loading file:', error);
    throw {
      status: 500,
      error: { error_type: 'schema', message: errorMessage(error) },
    } as LoadFileError;
  }

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    let errorDetail: JsonErrorResponse;
    try {
      const errorData = await response.json();
      errorDetail = typeof errorData.detail === 'string'
        ? { error_type: 'schema', message: errorData.detail }
        : errorData.detail;
    } catch {
      errorDetail = { error_type: 'schema', message: `HTTP error! status: ${response.status}` };
    }
    throw { status: response.status, error: errorDetail } as LoadFileError;
  }

  return response.json();
};

/** ファイルの存在と更新日時を取得する。通信エラー時は null */
export const getFileInfo = async (
  filePath: string,
  options?: { silent?: boolean },
): Promise<FileInfoResponse | null> => {
  try {
    const response = await fetch(`${API_BASE_URL}/api/file-info?filepath=${encodeURIComponent(filePath)}`);
    if (response.status === 404) {
      return { modified: 0, exists: false };
    }
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    if (!options?.silent) {
      console.error('Error getting file info:', error);
    }
    return null;
  }
};

/** 図面ファイルを保存する。失敗時も例外は投げず success: false を返す */
export const saveExcalidrawFile = async (
  filePath: string,
  data: ExcalidrawFileData,
  forceBackup: boolean = false,
): Promise<SaveFileResponse> => {
  try {
    const response = await postJson('/api/save-file', {
      filepath: filePath,
      data,
      force_backup: forceBackup,
    });
    if (!response.ok) {
      return { success: false, message: await readErrorDetail(response) };
    }
    const result = await response.json();
    if (!result?.success) {
      return { success: false, message: result?.message || 'File save skipped by server.' };
    }
    console.log(`[${new Date().toISOString()}] File saved successfully:`, result.message);
    return result;
  } catch (error) {
    console.error('Error saving file:', error);
    return { success: false, message: `ファイルの保存に失敗しました: ${errorMessage(error)}` };
  }
};

/** ファイルを同じフォルダの backup/ へ移動する */
export const archiveFile = async (filePath: string): Promise<ArchiveFileResponse> => {
  try {
    const response = await postJson('/api/archive-file', { filepath: filePath });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Error archiving file:', error);
    return { success: false, error: errorMessage(error) };
  }
};

/** ファイル・フォルダをOSの既定アプリで開く */
export const openFileViaBackend = async (filePath: string): Promise<BackendOpenFileResponse> => {
  const response = await postJson('/api/open-file', { filepath: filePath });
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
};

/** URL（obsidian:// など）をOSの既定ハンドラーで開く */
export const openUrlViaBackend = async (url: string): Promise<boolean> => {
  const response = await fetch(`${API_BASE_URL}/api/open-url?url=${encodeURIComponent(url)}`);
  if (!response.ok) {
    console.error('URLを開けませんでした:', response.status);
    return false;
  }
  return true;
};

/** シェルコマンドを実行する（作業フォルダ指定可） */
export const runCommandViaBackend = async (
  command: string,
  workingDirectory?: string,
): Promise<{ success: boolean; error?: string }> => {
  const response = await postJson('/api/run-command', {
    command,
    working_directory: workingDirectory || '',
  });
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
};

/** フォルダをVS Code（なければOSのファイルマネージャー）で開く */
export const openInEditor = async (folderPath: string): Promise<OpenEditorResponse> => {
  const response = await postJson('/api/open-in-editor', { path: folderPath });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.success) {
    throw new Error(result?.detail || result?.message || 'フォルダを開けませんでした');
  }
  return result;
};

/** SVG文字列をファイルに保存する */
export const saveSvgFile = async (filePath: string, svgContent: string): Promise<void> => {
  const response = await postJson('/api/save-svg', { filepath: filePath, svg_content: svgContent });
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
};

/** ライブラリ (public/excalidraw_lib/my_lib.excalidrawlib) を保存する */
export const saveLibrary = async (libraryData: unknown): Promise<boolean> => {
  try {
    const response = await fetch(`${API_BASE_URL}/save-library`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_path: 'public/excalidraw_lib/my_lib.excalidrawlib',
        data: libraryData,
      }),
    });
    return response.ok;
  } catch (error) {
    console.error('ライブラリ保存中にエラーが発生しました:', error);
    return false;
  }
};

/**
 * ファイルを図面と同じフォルダの uploads/<種類>/ に保存する。
 * currentPath が null（localStorage モード）の場合はプロジェクトの upload_local/ に保存される。
 */
export const uploadFile = async (
  file: File,
  currentPath: string | null,
  fileType: 'general' | 'email' = 'general',
): Promise<UploadFilesResponse> => {
  try {
    const formData = new FormData();
    formData.append('files', file);
    formData.append('current_path', currentPath || 'localStorage');
    formData.append('file_type', fileType);

    const response = await fetch(`${API_BASE_URL}/api/upload-files`, { method: 'POST', body: formData });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Error uploading file:', error);
    return { success: false, error: errorMessage(error) };
  }
};

/** ドロップされたフォルダへのショートカット(.txt)を uploads/folders/ に作成する */
export const createFolderShortcut = async (
  folderPath: string,
  currentPath: string | null,
): Promise<SavedPathResponse> => {
  try {
    const formData = new FormData();
    formData.append('folder_path', folderPath);
    formData.append('current_path', currentPath || 'localStorage');

    const response = await fetch(`${API_BASE_URL}/api/create-folder-shortcut`, { method: 'POST', body: formData });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Error creating folder shortcut:', error);
    return { success: false, error: errorMessage(error) };
  }
};

/** Outlook からドロップされたメール本文を uploads/emails/*.eml に保存する */
export const saveEmail = async (
  emailData: string,
  subject: string,
  currentPath: string | null,
): Promise<SavedPathResponse> => {
  try {
    const response = await postJson('/api/save-email', {
      emailData,
      subject,
      currentPath: currentPath || 'localStorage',
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Error saving email:', error);
    return { success: false, error: errorMessage(error) };
  }
};

/** JSON読み込みエラーをユーザー向けメッセージに整形する */
export const formatLoadFileError = (loadError: LoadFileError): string => {
  const error = loadError.error;
  let message = error?.message || `読み込みに失敗しました (status: ${loadError.status})`;

  if (error?.error_type === 'json_syntax') {
    if (error.line && error.column) {
      message += `\n\n行 ${error.line}, カラム ${error.column}`;
    }
    if (error.context) {
      message += `\n\nエラー箇所:\n${error.context}`;
    }
  }

  if (error?.error_type === 'validation' && error.details && error.details.length > 0) {
    message += '\n\n詳細:';
    error.details.forEach((detail, idx) => {
      message += `\n${idx + 1}. ${detail.field}`;
      message += `\n   ${detail.message}`;
      if (detail.value) {
        message += `\n   値: ${detail.value}`;
      }
    });
  }

  return message;
};
