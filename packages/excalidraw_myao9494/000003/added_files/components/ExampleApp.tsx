import React, {
  useEffect,
  useState,
  useRef,
  Children,
  cloneElement,
  useCallback,
  useMemo,
} from "react";

import type * as TExcalidraw from "@excalidraw/excalidraw";
import type {
  NonDeletedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import { exportToSvg } from "@excalidraw/excalidraw";

import initialData from "../initialData";
import { resolvablePromise } from "../utils";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useDragAndDrop } from "../hooks/useDragAndDrop";
import { AnnotationSettingsModal } from "./AnnotationSettingsModal";
import { loadAnnotationSettings, saveAnnotationSettings, type AnnotationSettings } from "../utils/annotationSettings";
import {
  saveElementsToLocalStorage,
  loadElementsFromLocalStorage,
  saveAppStateToLocalStorage,
  loadAppStateFromLocalStorage,
  saveBinaryFilesToLocalStorage,
  loadBinaryFilesFromLocalStorage
} from "../utils/localStorage";
import {
  getFilePathFromUrl,
  loadExcalidrawFile,
  saveExcalidrawFile,
  getFileInfo,
  handleStickyNoteLink,
  exportToSvgFile,
  isExcalidrawFile,
  formatLoadFileError,
  openPathWithFallback,
  archiveFile,
  isObsidianPath,
  isObsidianDrawingPath,
  API_BASE_URL,
  type ExcalidrawFileData,
  type LoadFileError
} from "../utils/fileUtils";
import { generateTabTitle } from "../utils/titleUtils";

import "./ExampleApp.scss";

import type { ResolvablePromise } from "../utils";

import defaultTemplateRaw from "../shoki.excalidraw?raw";

const SAVE_DELAY_MS = 10000;

const svgToDataUrl = (svg: SVGSVGElement): string => {
  const svgString = new XMLSerializer().serializeToString(svg);
  const utf8 = new TextEncoder().encode(svgString);
  let binary = '';
  for (let index = 0; index < utf8.length; index += 0x8000) {
    binary += String.fromCharCode(...Array.from(utf8.subarray(index, index + 0x8000)));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
};

const svgDataUrlToText = (dataUrl: string): string | null => {
  const separator = dataUrl.indexOf(',');
  if (separator < 0) {
    return null;
  }

  const encoded = dataUrl.slice(separator + 1);
  if (dataUrl.slice(0, separator).endsWith(';base64')) {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder().decode(bytes);
  }

  return decodeURIComponent(encoded);
};

/** SVGのサイズやメタデータを除き、描画形状だけを比較する。 */
const svgShapeSignature = (svg: string | SVGSVGElement): string | null => {
  const svgText = typeof svg === 'string' ? svg : new XMLSerializer().serializeToString(svg);
  const document = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const root = document.documentElement;
  if (!root || root.tagName.toLowerCase() !== 'svg') {
    return null;
  }

  const attributes = [
    'd', 'x', 'y', 'width', 'height', 'rx', 'ry', 'points', 'transform',
    'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
    'fill-opacity', 'stroke-opacity',
  ];
  const shapes = Array.from(root.querySelectorAll('path, rect, ellipse, circle, polygon, polyline, line'))
    .map((element) => [
      element.tagName.toLowerCase(),
      ...attributes.map((attribute) => element.getAttribute(attribute) || ''),
    ]);

  return JSON.stringify({
    viewBox: root.getAttribute('viewBox') || '',
    shapes,
  });
};

/** Markdownノートの埋め込みを、Excalidrawが表示できるSVG画像へ変換する。 */
const hydrateEmbeddedMarkdownFiles = async (
  fileData: ExcalidrawFileData,
  embeddedFilePaths: Record<string, string> = {},
  visitedPaths: Set<string> = new Set(),
): Promise<any> => {
  const files = { ...(fileData.files || {}) };

  for (const [fileId, sourcePath] of Object.entries(embeddedFilePaths)) {
    if (files[fileId]) {
      files[fileId] = {
        ...files[fileId],
        sourcePath,
      };
    }

    if (!sourcePath.toLowerCase().endsWith('.md') || visitedPaths.has(sourcePath)) {
      continue;
    }

    try {
      const childResult = await loadExcalidrawFile(sourcePath);
      if (!childResult?.data || !Array.isArray(childResult.data.elements)) {
        continue;
      }

      const childVisitedPaths = new Set(visitedPaths);
      childVisitedPaths.add(sourcePath);
      const childFiles = await hydrateEmbeddedMarkdownFiles(
        childResult.data,
        childResult.embeddedFilePaths,
        childVisitedPaths,
      );
      const childElements = childResult.data.elements.filter((element) => !element.isDeleted);
      const svg = await exportToSvg({
        elements: childElements,
        appState: {
          ...(childResult.data.appState || {}),
          viewBackgroundColor: childResult.data.appState?.viewBackgroundColor || '#ffffff',
          currentItemFontFamily: childResult.data.appState?.currentItemFontFamily || 1,
          currentItemFontSize: childResult.data.appState?.currentItemFontSize || 20,
          currentItemStrokeColor: childResult.data.appState?.currentItemStrokeColor || '#000000',
          currentItemOpacity: childResult.data.appState?.currentItemOpacity || 100,
          exportBackground: true,
          exportWithDarkMode: false,
          exportEmbedScene: false,
        },
        files: childFiles,
        exportPadding: 10,
        metadata: '',
      });

      files[fileId] = {
        ...(files[fileId] || {}),
        id: fileId,
        mimeType: 'image/svg+xml',
        dataURL: svgToDataUrl(svg),
        created: Date.now(),
        sourcePath,
        // これはMarkdownノートからブラウザ内で生成した表示用スナップショット。
        // Obsidianノート保存時に外部SVGとして書き出してはいけない。
        isEmbeddedMarkdownSnapshot: true,
      };
    } catch (error) {
      console.warn(`Failed to render embedded Markdown note: ${sourcePath}`, error);
    }
  }

  return files;
};

const renderMarkdownSnapshot = async (
  fileResult: Awaited<ReturnType<typeof loadExcalidrawFile>>,
  visitedPaths: Set<string>,
): Promise<SVGSVGElement | null> => {
  if (!fileResult?.data || !Array.isArray(fileResult.data.elements)) {
    return null;
  }

  const sourcePath = fileResult.resolvedPath || '';
  const childVisitedPaths = new Set(visitedPaths);
  if (sourcePath) {
    childVisitedPaths.add(sourcePath);
  }
  const childFiles = await hydrateEmbeddedMarkdownFiles(
    fileResult.data,
    fileResult.embeddedFilePaths,
    childVisitedPaths,
  );
  const childElements = fileResult.data.elements.filter((element) => !element.isDeleted);

  return exportToSvg({
    elements: childElements,
    appState: {
      ...(fileResult.data.appState || {}),
      viewBackgroundColor: fileResult.data.appState?.viewBackgroundColor || '#ffffff',
      currentItemFontFamily: fileResult.data.appState?.currentItemFontFamily || 1,
      currentItemFontSize: fileResult.data.appState?.currentItemFontSize || 20,
      currentItemStrokeColor: fileResult.data.appState?.currentItemStrokeColor || '#000000',
      currentItemOpacity: fileResult.data.appState?.currentItemOpacity || 100,
      exportBackground: true,
      exportWithDarkMode: false,
      exportEmbedScene: false,
    },
    files: childFiles,
    exportPadding: 10,
    metadata: '',
  });
};

/** SVGスナップショットを、同じフォルダの元Markdownノートへ戻す。 */
const resolveEmbeddedMarkdownSources = async (
  fileData: ExcalidrawFileData,
  embeddedFilePaths: Record<string, string> = {},
  candidates: string[] = [],
): Promise<Record<string, string>> => {
  const resolvedPaths = { ...embeddedFilePaths };
  if (candidates.length === 0) {
    return resolvedPaths;
  }

  const files = fileData.files || {};
  for (const [fileId, sourcePath] of Object.entries(embeddedFilePaths)) {
    if (!sourcePath.toLowerCase().endsWith('.svg')) {
      continue;
    }

    // 同じフォルダに候補が1つだけなら、SVGスナップショットの元ノートとして確定できる。
    if (candidates.length === 1) {
      resolvedPaths[fileId] = candidates[0];
      continue;
    }

    const dataUrl = files[fileId]?.dataURL;
    const sourceSvg = typeof dataUrl === 'string' ? svgDataUrlToText(dataUrl) : null;
    const sourceSignature = sourceSvg ? svgShapeSignature(sourceSvg) : null;
    if (!sourceSignature) {
      continue;
    }

    for (const candidatePath of candidates) {
      try {
        const candidateResult = await loadExcalidrawFile(candidatePath);
        const candidateSvg = await renderMarkdownSnapshot(candidateResult, new Set());
        const candidateSignature = candidateSvg ? svgShapeSignature(candidateSvg) : null;
        if (candidateSignature && candidateSignature === sourceSignature) {
          resolvedPaths[fileId] = candidatePath;
          break;
        }
      } catch (error) {
        console.warn(`Failed to compare embedded Markdown candidate: ${candidatePath}`, error);
      }
    }
  }

  return resolvedPaths;
};

let DEFAULT_TEMPLATE_DATA: ExcalidrawFileData | null = null;

const createGeneratedId = (prefix: string, seed: string): string =>
  `${prefix}-${seed}-${Math.random().toString(36).slice(2, 11)}`;

try {
  DEFAULT_TEMPLATE_DATA = JSON.parse(defaultTemplateRaw) as ExcalidrawFileData;
} catch (error) {
  console.error('テンプレートファイルの解析に失敗しました:', error);
  DEFAULT_TEMPLATE_DATA = null;
}

const ensureTemplateForNewFile = async (targetPath: string): Promise<boolean> => {
  if (!DEFAULT_TEMPLATE_DATA) {
    console.error('テンプレートデータが利用できません。');
    if (typeof window !== 'undefined' && window.alert) {
      window.alert('テンプレートデータを読み込めなかったため、新規ファイルを作成できませんでした。');
    }
    return false;
  }

  try {
    const templateClone = JSON.parse(JSON.stringify(DEFAULT_TEMPLATE_DATA)) as ExcalidrawFileData;
    const saveResult = await saveExcalidrawFile(targetPath, templateClone, true);

    if (!saveResult?.success) {
      throw new Error(saveResult?.message || 'テンプレートデータの保存に失敗しました');
    }

    return true;
  } catch (error) {
    console.error('Error preparing new file from template:', error);
    if (typeof window !== 'undefined' && window.alert) {
      window.alert('テンプレートの保存に失敗したため、新規ファイルを作成できませんでした。');
    }
    return false;
  }
};

/**
 * 新規ファイル作成用のダイアログを表示する
 */
const showNewFileDialog = async (currentFolder: string | null) => {
  const fileName = prompt("新しいファイル名を入力してください（拡張子なし）:");
  if (!fileName || !fileName.trim()) {
    return;
  }

  const normalizedFolder = currentFolder ? normalizePath(currentFolder) : null;
  const fullPath = normalizedFolder
    ? `${normalizedFolder}/${fileName.trim()}.excalidraw`
    : `${fileName.trim()}.excalidraw`;
  const normalizedFullPath = normalizePath(fullPath);

  const prepared = await ensureTemplateForNewFile(normalizedFullPath);
  if (!prepared) {
    return;
  }

  // 新しいファイルは別タブで開く（パスをエンコードしてセッションを保持）
  const encodedPath = encodeURIComponent(normalizedFullPath);
  const targetUrl = `${window.location.origin}${window.location.pathname}?filepath=${encodedPath}`;
  window.open(targetUrl, '_blank', 'noopener');
};

/**
 * パスを/区切りに正規化する
 */
const normalizePath = (path: string): string => {
  return path.replace(/\\/g, '/');
};

const parseLibraryContent = (libraryContent: string) => {
  const trimmedContent = libraryContent.trim();
  if (!trimmedContent) {
    return { libraryItems: [] };
  }

  const parsed = JSON.parse(trimmedContent);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("ライブラリデータがオブジェクトではありません");
  }

  return parsed;
};


interface DirectoryBrowserEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number | null;
  modified?: number | null;
}


const formatModified = (value: number | null | undefined): string => {
  if (value == null) {
    return '';
  }
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const formatSize = (value: number | null | undefined): string => {
  if (value == null) {
    return '';
  }
  if (value < 1024) {
    return `${value} バイト`;
  }
  const kb = value / 1024;
  if (kb < 1024) {
    return `${Math.round(kb)} KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(1)} MB`;
  }
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
};

const getTypeLabel = (entry: DirectoryBrowserEntry): string => {
  if (entry.isDir) {
    return 'ファイル フォルダー';
  }
  const parts = entry.name.split('.');
  if (parts.length > 1) {
    const ext = parts.pop() || '';
    if (ext.toLowerCase() === 'excalidraw') {
      return 'EXCALIDRAW ファイル (.excalidraw)';
    }
    return `${ext.toUpperCase()} ファイル`;
  }
  return 'ファイル';
};


/**
 * VS Codeでフォルダを開く。VS CodeがなければOSのファイルマネージャーを開く。
 */
const openInCode = async (currentFolder: string | null) => {
  const folderPath = currentFolder ? normalizePath(currentFolder) : null;

  if (!folderPath) {
    alert('現在のフォルダが取得できません。ファイルを開いてからお試しください。');
    return;
  }

  try {
    const response = await fetch(`${API_BASE_URL}/api/open-in-editor`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        path: folderPath
      })
    });

    const result = await response.json().catch(() => null);

    if (!response.ok || !result?.success) {
      throw new Error(result?.detail || result?.message || 'フォルダを開けませんでした');
    }

    if (result.fallbackUsed) {
      alert('VS Codeが見つからないため、代わりにファイルマネージャーでフォルダを開きました。');
    }
  } catch (error) {
    console.error('Error opening folder in editor:', error);
    alert('フォルダを開けませんでした。VS CodeまたはOSのファイルマネージャー設定を確認してください。');
  }
};

/**
 * OSのファイルマネージャーでフォルダを開く
 */
const openInFileExplorer = async (currentFolder: string | null) => {
  const folderPath = currentFolder ? normalizePath(currentFolder) : null;

  if (!folderPath) {
    alert('現在のフォルダが取得できません。ファイルを開いてからお試しください。');
    return;
  }

  try {
    const redirectWindow = window.open('about:blank', '_blank');
    await openPathWithFallback(folderPath, redirectWindow);
  } catch (error) {
    console.error('フォルダを開く処理で例外が発生しました:', error);
    alert('フォルダを開く処理でエラーが発生しました。詳細はコンソールを確認してください。');
  }
};


export interface AppProps {
  appTitle: string;
  useCustom: (api: ExcalidrawImperativeAPI | null, customArgs?: any[]) => void;
  customArgs?: any[];
  children: React.ReactNode;
  excalidrawLib: typeof TExcalidraw;
}

export default function ExampleApp({
  appTitle,
  useCustom,
  customArgs,
  children,
  excalidrawLib,
}: AppProps) {
  const {
    convertToExcalidrawElements,
    viewportCoordsToSceneCoords,
  } = excalidrawLib;

  const appRef = useRef<any>(null);

  const initialStatePromiseRef = useRef<{
    promise: ResolvablePromise<ExcalidrawInitialDataState | null>;
  }>({ promise: null! });
  if (!initialStatePromiseRef.current.promise) {
    initialStatePromiseRef.current.promise =
      resolvablePromise<ExcalidrawInitialDataState | null>();
  }

  const [excalidrawAPI, setExcalidrawAPI] =
    useState<ExcalidrawImperativeAPI | null>(null);

  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
  // URLの対象ファイルを確認する前に、ローカルの空データで初期化しない。
  const [filePathInitialized, setFilePathInitialized] = useState<boolean>(false);
  const [lastSavedElements, setLastSavedElements] = useState<string>('');
  const [lastFileHash, setLastFileHash] = useState<string>('');
  const [saveNotification, setSaveNotification] = useState<{ message: string; isError?: boolean } | null>(null);
  const [isFileBrowserOpen, setIsFileBrowserOpen] = useState<boolean>(false);
  const [isFileBrowserLoading, setIsFileBrowserLoading] = useState<boolean>(false);
  const [fileBrowserEntries, setFileBrowserEntries] = useState<DirectoryBrowserEntry[]>([]);
  const [fileBrowserPath, setFileBrowserPath] = useState<string | null>(null);
  const [fileBrowserParentPath, setFileBrowserParentPath] = useState<string | null>(null);
  const [fileBrowserError, setFileBrowserError] = useState<string | null>(null);
  const [fileBrowserSelectedEntry, setFileBrowserSelectedEntry] = useState<DirectoryBrowserEntry | null>(null);
  const [fileBrowserInputValue, setFileBrowserInputValue] = useState<string>('');
  const [annotationSettings, setAnnotationSettings] = useState<AnnotationSettings>(() => loadAnnotationSettings());
  const [isAnnotationSettingsOpen, setIsAnnotationSettingsOpen] = useState<boolean>(false);
  const [imageContextMenu, setImageContextMenu] = useState<{
    left: number;
    top: number;
    sourcePath: string;
  } | null>(null);

  // 保存通知を表示する関数
  const showSaveNotification = useCallback((message: string, isError: boolean = false) => {
    setSaveNotification({ message, isError });

    // エラーの場合は10秒、通常は2秒
    const displayDuration = isError ? 10000 : 2000;

    setTimeout(() => {
      setSaveNotification(null);
    }, displayDuration);
  }, []);

  // 現在のフォルダパスを取得する関数（Windows/Unix両対応）
  const getCurrentFolder = useCallback(() => {
    if (!currentFilePath) {
      // console.log('getCurrentFolder: currentFilePath is null or undefined');
      return null;
    }

    // Windows と Unix の両方のパス区切り文字に対応
    const normalizedPath = currentFilePath.replace(/\\/g, '/');
    const lastSlashIndex = normalizedPath.lastIndexOf('/');

    const result = lastSlashIndex !== -1 ? normalizedPath.substring(0, lastSlashIndex) : null;

    // console.log('getCurrentFolder Debug Info:');
    // console.log('  Original currentFilePath:', currentFilePath);
    // console.log('  Normalized path:', normalizedPath);
    // console.log('  Last slash index:', lastSlashIndex);
    // console.log('  Result folder path:', result);

    return result;
  }, [currentFilePath]);

  const fetchDirectoryContents = useCallback(async (targetPath: string | null) => {
    setIsFileBrowserLoading(true);
    setFileBrowserError(null);

    try {
      const currentHost = window.location.hostname || "localhost";
      const response = await fetch(`${API_BASE_URL}/api/list-directory`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: targetPath ?? undefined,
        }),
      });

      const result = await response.json().catch(() => null);

      if (!response.ok || !result?.success) {
        const message = result?.error || result?.detail || 'ディレクトリ情報の取得に失敗しました。';
        throw new Error(message);
      }

      const entriesArray = Array.isArray(result.entries) ? result.entries : [];
      const mappedEntries: DirectoryBrowserEntry[] = entriesArray.map((entry: any) => ({
        name: entry.name,
        path: entry.path,
        isDir: Boolean(entry.is_dir ?? entry.isDir),
        size: entry.size ?? null,
        modified: entry.modified ?? null,
      }));

      const filteredEntries = mappedEntries.filter((entry) => {
        if (entry.isDir) {
          return true;
        }
        const nameLower = entry.name.toLowerCase();
        return nameLower.endsWith('.excalidraw')
          || nameLower.endsWith('.excalidraw.md')
          || nameLower.endsWith('.md');
      });

      setFileBrowserEntries(filteredEntries);
      setFileBrowserPath(result.path ? normalizePath(result.path) : targetPath ? normalizePath(targetPath) : null);
      setFileBrowserParentPath(result.parentPath ? normalizePath(result.parentPath) : null);
      setFileBrowserSelectedEntry(null);
      setFileBrowserInputValue('');
    } catch (error) {
      console.error('Error fetching directory contents:', error);
      setFileBrowserError(error instanceof Error ? error.message : 'ディレクトリ情報の取得に失敗しました。');
    } finally {
      setIsFileBrowserLoading(false);
    }
  }, []);

  const openFileBrowser = useCallback(() => {
    if (isFileBrowserOpen) {
      return;
    }

    const startPath = getCurrentFolder();
    setIsFileBrowserOpen(true);
    setFileBrowserSelectedEntry(null);
    setFileBrowserInputValue('');
    fetchDirectoryContents(startPath);
  }, [fetchDirectoryContents, getCurrentFolder, isFileBrowserOpen]);

  const closeFileBrowser = useCallback(() => {
    setIsFileBrowserOpen(false);
    setFileBrowserError(null);
    setFileBrowserSelectedEntry(null);
    setFileBrowserInputValue('');
  }, []);

  const openFileFromBrowser = useCallback((rawPath: string) => {
    const normalizedPath = normalizePath(rawPath);
    const encodedPath = encodeURIComponent(normalizedPath);
    const targetUrl = `${window.location.origin}/?filepath=${encodedPath}`;
    window.open(targetUrl, '_blank', 'noopener');
    closeFileBrowser();
  }, [closeFileBrowser]);

  const handleDirectoryNavigate = useCallback((nextPath: string | null) => {
    if (!nextPath) {
      return;
    }
    fetchDirectoryContents(nextPath);
  }, [fetchDirectoryContents]);

  const handleFileBrowserConfirm = useCallback(() => {
    const trimmedInput = fileBrowserInputValue.trim();
    if (trimmedInput) {
      const matchedEntry = fileBrowserEntries.find(
        (entry) => entry.name.toLowerCase() === trimmedInput.toLowerCase(),
      );
      if (matchedEntry) {
        if (matchedEntry.isDir) {
          handleDirectoryNavigate(matchedEntry.path);
        } else {
          openFileFromBrowser(matchedEntry.path);
        }
        return;
      }
    }

    if (fileBrowserSelectedEntry && !fileBrowserSelectedEntry.isDir) {
      openFileFromBrowser(fileBrowserSelectedEntry.path);
      return;
    }

    if (trimmedInput) {
      setFileBrowserError(`ファイルが見つかりません: ${trimmedInput}`);
    }
  }, [
    fileBrowserEntries,
    fileBrowserInputValue,
    fileBrowserSelectedEntry,
    handleDirectoryNavigate,
    openFileFromBrowser,
  ]);

  const handleEntryClick = useCallback((entry: DirectoryBrowserEntry) => {
    setFileBrowserSelectedEntry(entry);
    setFileBrowserError(null);
    if (entry.isDir) {
      setFileBrowserInputValue('');
    } else {
      setFileBrowserInputValue(entry.name);
    }
  }, []);

  const handleEntryDoubleClick = useCallback((entry: DirectoryBrowserEntry) => {
    if (entry.isDir) {
      handleDirectoryNavigate(entry.path);
    } else {
      openFileFromBrowser(entry.path);
    }
  }, [handleDirectoryNavigate, openFileFromBrowser]);

  const handleEntryKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, entry: DirectoryBrowserEntry) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleEntryDoubleClick(entry);
      }
    },
    [handleEntryDoubleClick],
  );

  const displayPathValue = useMemo(() => {
    if (!fileBrowserPath) {
      return '';
    }
    const normalized = normalizePath(fileBrowserPath);
    return normalized.replace(/\//g, '\\');
  }, [fileBrowserPath]);

  const openButtonDisabled = useMemo(() => {
    if (isFileBrowserLoading) {
      return true;
    }
    if (fileBrowserInputValue.trim()) {
      return false;
    }
    if (fileBrowserSelectedEntry && !fileBrowserSelectedEntry.isDir) {
      return false;
    }
    return true;
  }, [fileBrowserInputValue, fileBrowserSelectedEntry, isFileBrowserLoading]);

  // SVGファイルとして保存する関数
  const exportSvg = useCallback(async (currentFolder: string | null) => {
    if (!excalidrawAPI) {
      console.error('Excalidraw APIが利用できません');
      return;
    }

    try {
      const elements = excalidrawAPI.getSceneElements();
      const appState = excalidrawAPI.getAppState();
      const files = excalidrawAPI.getFiles();

      // 選択された要素を取得
      const selectedElements = elements.filter(element => appState.selectedElementIds[element.id]);

      const success = await exportToSvgFile(
        elements,
        appState,
        files,
        currentFolder,
        selectedElements.length > 0 ? selectedElements : null
      );

      if (success) {
        console.log('SVGファイルの保存に成功しました');
      } else {
        console.error('SVGファイルの保存に失敗しました');
      }
    } catch (error) {
      console.error('SVGエクスポート中にエラーが発生しました:', error);
    }
  }, [excalidrawAPI]);

  // デバウンス処理用のstate（削除済み - Refを使用）

  // 最新の値を保持するためのref
  const currentFilePathRef = useRef<string | null>(null);
  const lastSavedElementsRef = useRef<string>('');
  const lastFileHashRef = useRef<string>('');
  const externalUpdateNotifiedHashRef = useRef<string>('');
  const saveInProgressRef = useRef<boolean>(false);
  // Excalidrawの初期空キャンバスが、ファイル読込前に保存されるのを防ぐ。
  const initialDataLoadedRef = useRef<boolean>(false);
  // .excalidraw.md ファイル用のタイムスタンプ追跡
  const lastFileModifiedRef = useRef<number>(0);

  // refの値を更新
  useEffect(() => {
    currentFilePathRef.current = currentFilePath;
  }, [currentFilePath]);

  useEffect(() => {
    lastSavedElementsRef.current = lastSavedElements;
  }, [lastSavedElements]);

  useEffect(() => {
    lastFileHashRef.current = lastFileHash;
  }, [lastFileHash]);

  const buildElementSummary = useCallback(
    (elements: NonDeletedExcalidrawElement[], deletedCount: number = 0) => {
      const ids: string[] = [];
      const geometry: string[] = [];
      const texts: string[] = [];
      const styles: string[] = [];
      const extras: string[] = [];

      for (const element of elements) {
        if (element.isDeleted) {
          continue;
        }

        ids.push(element.id);
        geometry.push(
          `${element.id}:${element.x.toFixed(2)},${element.y.toFixed(2)},${element.width.toFixed(2)},${element.height.toFixed(2)},${(element.angle || 0).toFixed(2)}`,
        );
        styles.push(
          `${element.id}:${element.strokeColor},${element.backgroundColor},${element.fillStyle},${element.strokeWidth},${element.roughness},${element.opacity}`,
        );

        if (element.type === 'text') {
          texts.push(`${element.id}:${element.text || ''}`);
        }

        const elementExtras: string[] = [];
        if (element.type === 'arrow' && element.startArrowhead) {
          elementExtras.push(`start:${element.startArrowhead}`);
        }
        if (element.type === 'arrow' && element.endArrowhead) {
          elementExtras.push(`end:${element.endArrowhead}`);
        }
        if (element.link) {
          elementExtras.push(`link:${element.link}`);
        }
        if (element.groupIds && element.groupIds.length > 0) {
          elementExtras.push(`groups:${element.groupIds.join(',')}`);
        }
        extras.push(`${element.id}:${elementExtras.join(';')}`);
      }

      const summary = {
        count: ids.length,
        deletedCount,
        ids: ids.sort().join(','),
        geometry: geometry.sort().join('|'),
        texts: texts.sort().join('|'),
        styles: styles.sort().join('|'),
        extras: extras.sort().join('|'),
      };
      return JSON.stringify(summary);
    },
    [],
  );

  // ドラッグ&ドロップ用のコンテナRef
  const containerRef = useRef<HTMLDivElement>(null);
  const embeddedFilePathsRef = useRef<Record<string, string>>({});
  const contextMenuSourcePathRef = useRef<string | null>(null);
  const imageContextMenuRef = useRef<HTMLDivElement>(null);

  useCustom(excalidrawAPI, customArgs);

  // ドラッグ&ドロップ機能を追加
  useDragAndDrop({
    excalidrawAPI,
    currentFilePath,
    containerRef,
  });

  // ファイルハッシュの変更をログに出力するuseEffect
  const prevHashRef = useRef<string>();
  useEffect(() => {
    const prevHash = prevHashRef.current;
    if (prevHash !== lastFileHash) {
      console.log(`[Hash Change] Hash updated from ${prevHash || '(initial)'} to ${lastFileHash}`);
    }
    prevHashRef.current = lastFileHash;
  }, [lastFileHash]);

  useEffect(() => {
    const filePath = getFilePathFromUrl();

    let disposed = false;
    const initializeFilePath = async () => {
      // URLパラメータでファイルパスが指定されている場合の処理
      if (filePath && !isExcalidrawFile(filePath)) {
        // 通常の .md は、Front Matter の parsed マーカーをバックエンドで確認する。
        const fileInfo = filePath.toLowerCase().endsWith('.md')
          ? await getFileInfo(filePath, { silent: true })
          : null;

        // Excalidraw以外は同梱FastAPIからOSの既定アプリで開く。
        if (!fileInfo?.isExcalidraw) {
          setFilePathInitialized(true);
          openPathWithFallback(filePath, window).catch(error => {
            console.error('Failed to open non-Excalidraw file:', error);
            alert('ファイルを開けませんでした。ファイルが存在し、OSに対応アプリが設定されているか確認してください。');
          });
          return;
        }
      }

      if (!disposed) {
        setCurrentFilePath(filePath);
        setFilePathInitialized(true);
      }
    };

    void initializeFilePath();
    return () => {
      disposed = true;
    };
  }, []);

  // タブタイトルを設定するuseEffect
  useEffect(() => {
    const tabTitle = generateTabTitle(currentFilePath);
    document.title = tabTitle;
  }, [currentFilePath]);

  const handleOpenFileButtonClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    openFileBrowser();
  }, [openFileBrowser]);

  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }

    const loadData = async () => {
      if (!filePathInitialized) {
        return;
      }

      let dataToLoad;
      initialDataLoadedRef.current = false;
      embeddedFilePathsRef.current = {};
      contextMenuSourcePathRef.current = null;
      setImageContextMenu(null);

      if (currentFilePath) {
        try {
          const fileResult = await loadExcalidrawFile(currentFilePath);
          if (fileResult) {
            try {
                const {
                  data: fileData,
                  hash,
                  modified,
                  resolvedPath,
                  embeddedFilePaths,
                  embeddedMarkdownCandidates,
                } = fileResult;
                const resolvedEmbeddedFilePaths = await resolveEmbeddedMarkdownSources(
                  fileData,
                  embeddedFilePaths,
                  embeddedMarkdownCandidates,
                );
                embeddedFilePathsRef.current = resolvedEmbeddedFilePaths;
                const loadedFiles = await hydrateEmbeddedMarkdownFiles(fileData, resolvedEmbeddedFilePaths);
                dataToLoad = {
                  ...initialData,
                  elements: fileData.elements.length > 0 ? fileData.elements : convertToExcalidrawElements(initialData.elements),
                  appState: fileData.appState
                    ? {
                      ...initialData.appState,
                      ...fileData.appState,
                      collaborators:
                        fileData.appState.collaborators instanceof Map
                          ? fileData.appState.collaborators
                          : new Map(Object.entries(fileData.appState.collaborators || {})),
                    }
                    : initialData.appState,
                  files: loadedFiles,
                };

                const resolvedHash = hash || '';
                setLastFileHash(resolvedHash);
                lastFileHashRef.current = resolvedHash;
                externalUpdateNotifiedHashRef.current = resolvedHash;
                if (resolvedPath && resolvedPath !== currentFilePath) {
                  setCurrentFilePath(resolvedPath);
                  const newUrl = new URL(window.location.href);
                  newUrl.searchParams.set('filepath', resolvedPath);
                  window.history.replaceState({}, '', newUrl.toString());
                }
                if (isObsidianDrawingPath(resolvedPath || currentFilePath) && modified) {
                  lastFileModifiedRef.current = modified;
                }
                // 初期読み込み時の要素を記録
                const initialSummary = buildElementSummary(
                  fileData.elements as NonDeletedExcalidrawElement[],
                  0,
                );
                setLastSavedElements(initialSummary);
                lastSavedElementsRef.current = initialSummary;

                // --------------------------------------------------------------------------------
                // Obsidian互換モードの処理: .excalidraw を開いた場合の自動変換
                // --------------------------------------------------------------------------------
                // 1. .excalidraw ファイルを開いており、かつ Obsidian フォルダ内であるか確認
                // const { isObsidianPath } = await import('../utils/fileUtils'); // 既にトップレベルでimport済み

                const activeFilePath = resolvedPath || currentFilePath;
                const isObsidian = isObsidianPath(activeFilePath);
                console.log(`[Obsidian Compat] Checking... Path: ${activeFilePath}, isObsidian: ${isObsidian}`);

                if (activeFilePath.endsWith('.excalidraw') && isObsidian) {
                  console.log('[Obsidian Compat] .excalidraw file detected in Obsidian folder.');

                  // .excalidraw.md のパスを構築
                  const mdFilePath = activeFilePath + '.md'; // 例: test.excalidraw -> test.excalidraw.md
                  console.log(`[Obsidian Compat] converting to ${mdFilePath}`);

                  const saveResult = await saveExcalidrawFile(mdFilePath, dataToLoad as ExcalidrawFileData, true);
                  console.log('[Obsidian Compat] Save result:', saveResult);

                  if (saveResult && saveResult.success) {
                    console.log('[Obsidian Compat] Successfully created .excalidraw.md. Switching context.');

                    setCurrentFilePath(mdFilePath);
                    const newUrl = new URL(window.location.href);
                    newUrl.searchParams.set('filepath', mdFilePath);
                    window.history.pushState({}, '', newUrl.toString());

                    if (saveResult.hash) setLastFileHash(saveResult.hash);
                    if (saveResult.modified) lastFileModifiedRef.current = saveResult.modified;

                    archiveFile(activeFilePath).then(archiveResult => {
                      if (archiveResult.success) {
                        console.log('[Obsidian Compat] Archived original file:', archiveResult.archivedPath);
                      } else {
                        console.warn('[Obsidian Compat] Failed to archive original file:', archiveResult.error);
                      }
                    });
                  } else {
                    console.error('[Obsidian Compat] Failed to create .excalidraw.md', saveResult);
                    if (!saveResult?.success && saveResult?.message) {
                      console.warn(`[Obsidian Compat] Reason: ${saveResult.message}`);
                    }
                  }
                }
                // --------------------------------------------------------------------------------
            } catch (loadError) {
              // ファイル読み込みエラーの場合は初期データを使用
              console.warn('ファイルの読み込みに失敗しました。新規ファイルとして開始します:', loadError);
              dataToLoad = {
                ...initialData,
                elements: convertToExcalidrawElements(initialData.elements),
                appState: initialData.appState,
                files: {},
              };
              const emptySummary = buildElementSummary([]);
              setLastSavedElements(emptySummary);
              lastSavedElementsRef.current = emptySummary;
              setLastFileHash('');
              lastFileHashRef.current = '';
              externalUpdateNotifiedHashRef.current = '';
            }
          } else {
            // ファイルが存在しない場合は新規ファイルとして初期データを使用
            console.log('新規ファイルとして開始します:', currentFilePath);
            dataToLoad = {
              ...initialData,
              elements: convertToExcalidrawElements(initialData.elements),
              appState: initialData.appState,
              files: {},
            };
            const emptySummary = buildElementSummary([]);
            setLastSavedElements(emptySummary);
            lastSavedElementsRef.current = emptySummary;
            setLastFileHash('');
            lastFileHashRef.current = '';
            externalUpdateNotifiedHashRef.current = '';
          }
        } catch (error) {
          console.warn('ファイルの取得に失敗しました。新規ファイルとして開始します:', error);
          dataToLoad = {
            ...initialData,
            elements: convertToExcalidrawElements(initialData.elements),
            appState: initialData.appState,
            files: {},
          };
          const emptySummary = buildElementSummary([]);
          setLastSavedElements(emptySummary);
          lastSavedElementsRef.current = emptySummary;
          setLastFileHash('');
          lastFileHashRef.current = '';
          externalUpdateNotifiedHashRef.current = '';
        }
      } else {
        // ローカルストレージからデータを読み込み
        const savedElements = loadElementsFromLocalStorage();
        const savedAppState = loadAppStateFromLocalStorage();
        const savedFiles = loadBinaryFilesFromLocalStorage();

        dataToLoad = {
          ...initialData,
          elements: savedElements.length > 0 ? savedElements : convertToExcalidrawElements(initialData.elements),
          appState: savedAppState ? { ...initialData.appState, ...savedAppState } : initialData.appState,
          files: savedFiles,
        };

        const localSummary = buildElementSummary(
          (savedElements as NonDeletedExcalidrawElement[]) || [],
        );
        setLastSavedElements(localSummary);
        lastSavedElementsRef.current = localSummary;
        setLastFileHash('');
        lastFileHashRef.current = '';
        externalUpdateNotifiedHashRef.current = '';
      }

      // ライブラリファイルをロードしてlibraryItemsに追加
      try {
        const response = await fetch('/excalidraw_lib/my_lib.excalidrawlib', {
          cache: 'no-store',
          headers: {
            'Cache-Control': 'no-cache',
          },
        });
        if (response.ok) {
          const libraryContent = await response.text();
          const libraryData = parseLibraryContent(libraryContent);

          if (Array.isArray(libraryData.libraryItems)) {
            const librarySeed = `${Date.now()}`;
            // 各ライブラリアイテムと要素のIDを新しい一意のIDに更新
            const updatedLibraryItems = libraryData.libraryItems.map((item: any) => ({
              ...item,
              id: createGeneratedId('lib', librarySeed),
              elements: item.elements?.map((element: any) => ({
                ...element,
                id: createGeneratedId('elem', librarySeed),
                // グループIDも更新
                groupIds: element.groupIds?.map(() => createGeneratedId('group', librarySeed))
              }))
            }));

            dataToLoad.libraryItems = updatedLibraryItems;
            console.log(`ライブラリを読み込みました: ${updatedLibraryItems.length} アイテム`);
          }
        }
      } catch (error) {
        console.warn('ライブラリファイルの読み込みに失敗しました:', error);
      }

      initialDataLoadedRef.current = true;
      //@ts-ignore
      initialStatePromiseRef.current.promise.resolve(dataToLoad);
    };

    loadData();
  }, [buildElementSummary, convertToExcalidrawElements, currentFilePath, excalidrawAPI, filePathInitialized]);

  // 最新値を保持するRef
  const lastSaveTimeRef = useRef<number>(0);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastCheckTimeRef = useRef<number>(0); // 外部ファイルチェック用のタイムスタンプ
  const pendingSaveRef = useRef<boolean>(false);

  // 効率的な変更検知関数（削除要素も考慮）
  const isSignificantChange = useCallback((elements: NonDeletedExcalidrawElement[]): boolean => {
    const currentFilePathValue = currentFilePathRef.current;
    if (!currentFilePathValue) return true; // ローカルストレージの場合は常に保存

    // 削除された要素も含めて全要素を取得
    const allElements = excalidrawAPI?.getSceneElementsIncludingDeleted() || [];

    // 削除操作の特別な検知：要素数の変化を最優先でチェック
    let lastSavedData;
    try {
      lastSavedData = JSON.parse(lastSavedElementsRef.current);
    } catch {
      return true; // パース失敗時は保存を実行
    }

    // 削除された要素の数をカウント
    const deletedCount = allElements.filter(el => el.isDeleted).length;
    const activeCount = elements.length;
    // 削除された要素が検知された場合は即座に変更と判定
    if (deletedCount > 0) {
      // console.log(`[Change Detection] Deleted elements detected: ${deletedCount} deleted, ${activeCount} active`);
      return true;
    }

    // 要素数が変化した場合（削除や追加）は即座に変更と判定
    if (lastSavedData.count !== activeCount) {
      // console.log(`[Change Detection] Element count changed: ${lastSavedData.count} → ${activeCount}`);
      return true;
    }

    // 包括的な変更検知：すべての重要なプロパティを含む
    const currentSummaryString = buildElementSummary(elements, deletedCount);
    const hasChanged = currentSummaryString !== lastSavedElementsRef.current;

    if (hasChanged) {
      // console.log(`[Change Detection] Detailed change detected`);
    }

    return hasChanged;
  }, [excalidrawAPI, buildElementSummary]);

  const applyLoadedFile = useCallback(
    async (
      fileData: ExcalidrawFileData,
      hash?: string,
      notifyMessage?: string,
      embeddedFilePaths?: Record<string, string>,
      embeddedMarkdownCandidates?: string[],
    ) => {
      if (!excalidrawAPI) {
        return;
      }

      const newElements = fileData.elements && fileData.elements.length > 0 ? fileData.elements : [];
      const newAppState = fileData.appState
        ? {
          ...fileData.appState,
          collaborators:
            fileData.appState.collaborators instanceof Map
              ? fileData.appState.collaborators
              : new Map(Object.entries(fileData.appState.collaborators || {})),
        }
        : {};
      const resolvedEmbeddedFilePaths = await resolveEmbeddedMarkdownSources(
        fileData,
        embeddedFilePaths,
        embeddedMarkdownCandidates,
      );
      const newFiles = await hydrateEmbeddedMarkdownFiles(fileData, resolvedEmbeddedFilePaths);
      embeddedFilePathsRef.current = resolvedEmbeddedFilePaths;
      contextMenuSourcePathRef.current = null;
      setImageContextMenu(null);

      excalidrawAPI.updateScene({
        elements: newElements,
        appState: newAppState,
        files: newFiles,
      });
      initialDataLoadedRef.current = true;

      const activeElements = excalidrawAPI.getSceneElements() as NonDeletedExcalidrawElement[];
      const deletedElements = excalidrawAPI
        .getSceneElementsIncludingDeleted()
        ?.filter((el) => el.isDeleted).length || 0;

      const summaryString = buildElementSummary(activeElements, deletedElements);
      setLastSavedElements(summaryString);
      lastSavedElementsRef.current = summaryString;

      if (typeof hash === 'string') {
        setLastFileHash(hash);
        lastFileHashRef.current = hash;
        externalUpdateNotifiedHashRef.current = hash;
      }

      if (notifyMessage) {
        showSaveNotification(notifyMessage);
      }
    },
    [buildElementSummary, excalidrawAPI, showSaveNotification],
  );

  // 実際の保存処理を実行する関数
  const performSave = useCallback(async (
    elements: NonDeletedExcalidrawElement[],
    appState: any,
    files: any,
    forceBackup: boolean = false,
    skipConflictCheck: boolean = false
  ) => {
    if (!initialDataLoadedRef.current) {
      console.warn('[Save] ファイルの読み込み完了前の保存をスキップしました');
      return false;
    }

    const now = Date.now();
    const alreadySaving = saveInProgressRef.current;
    saveInProgressRef.current = true;

    try {
      // 保存したいアプリケーション状態のみを抽出
      const stateToSave = {
        viewBackgroundColor: appState.viewBackgroundColor,
        currentItemFontFamily: appState.currentItemFontFamily,
        currentItemFontSize: appState.currentItemFontSize,
        currentItemStrokeColor: appState.currentItemStrokeColor,
        currentItemBackgroundColor: appState.currentItemBackgroundColor,
        currentItemFillStyle: appState.currentItemFillStyle,
        currentItemStrokeWidth: appState.currentItemStrokeWidth,
        currentItemStrokeStyle: appState.currentItemStrokeStyle,
        currentItemRoughness: appState.currentItemRoughness,
        currentItemOpacity: appState.currentItemOpacity,
        zoom: appState.zoom,
        scrollX: appState.scrollX,
        scrollY: appState.scrollY,
      };

      const currentFilePathValue = currentFilePathRef.current;
      if (currentFilePathValue) {
        const allElements = excalidrawAPI?.getSceneElementsIncludingDeleted() || [];
        const deletedCount = allElements.filter((el) => el.isDeleted).length;
        const currentSummaryString = buildElementSummary(elements, deletedCount);
        let latestRemoteHash = lastFileHashRef.current;
        let shouldForceBackup = forceBackup;
        let conflictOverwrite = false;

        try {
          const skipConflictDetection = skipConflictCheck || alreadySaving;
          const fileInfo = await getFileInfo(currentFilePathValue);
          if (fileInfo?.exists) {
            const remoteHash = fileInfo.hash || '';
            const remoteModified = fileInfo.modified || 0;
            const isObsidianFile = isObsidianDrawingPath(currentFilePathValue);
            if (remoteHash) {
              latestRemoteHash = remoteHash;
            }

            // .excalidraw.md はタイムスタンプで、それ以外はハッシュで外部更新を検出
            let hasExternalUpdate = false;
            if (!skipConflictDetection) {
              if (isObsidianFile) {
                hasExternalUpdate = remoteModified > 0 && remoteModified > lastFileModifiedRef.current;
              } else {
                hasExternalUpdate = !!remoteHash && remoteHash !== lastFileHashRef.current;
              }
            }

            if (hasExternalUpdate) {
              if (isObsidianFile) {
                lastFileModifiedRef.current = remoteModified;
              } else if (remoteHash) {
                externalUpdateNotifiedHashRef.current = remoteHash;
              }

              // Obsidianファイル（.excalidraw.md）の場合は、確認ダイアログを表示せず自動的に最新を読み込んで保存
              if (isObsidianFile) {
                try {
                  const fileResult = await loadExcalidrawFile(currentFilePathValue);
                  if (fileResult) {
                    await applyLoadedFile(
                      fileResult.data,
                      fileResult.hash,
                      undefined,
                      fileResult.embeddedFilePaths,
                      fileResult.embeddedMarkdownCandidates,
                    );
                    const currentElements = excalidrawAPI.getSceneElements();
                    const currentAppState = excalidrawAPI.getAppState();
                    const currentFiles = excalidrawAPI.getFiles();
                    const saved = await performSave(currentElements, currentAppState, currentFiles, true, true);
                    if (saved) {
                      showSaveNotification('最新の内容を読み込んで保存しました');
                    } else {
                      showSaveNotification('保存に失敗しました', true);
                    }
                  } else {
                    showSaveNotification('最新の内容の読み込みに失敗しました', true);
                  }
                } catch (error) {
                  if (error && typeof error === 'object' && 'status' in error && 'error' in error) {
                    const loadError = error as LoadFileError;
                    const detailedMessage = formatLoadFileError(loadError);
                    showSaveNotification(detailedMessage, true);
                  } else {
                    showSaveNotification('最新の内容の読み込みに失敗しました', true);
                  }
                }
                return false;
              }

              // それ以外のファイルは従来通り確認ダイアログを表示
              const reload = window.confirm(
                'ファイルが他の人によって更新されています。\nOK: 最新の内容を読み込み\nキャンセル: サーバの内容をバックアップして現在の画面き保存',
              );

              if (reload) {
                try {
                  const fileResult = await loadExcalidrawFile(currentFilePathValue);
                  if (fileResult) {
                    await applyLoadedFile(
                      fileResult.data,
                      fileResult.hash,
                      '最新の内容を読み込みました',
                      fileResult.embeddedFilePaths,
                      fileResult.embeddedMarkdownCandidates,
                    );
                  } else {
                    showSaveNotification('最新の内容の読み込みに失敗しました', true);
                  }
                } catch (error) {
                  if (error && typeof error === 'object' && 'status' in error && 'error' in error) {
                    const loadError = error as LoadFileError;
                    const detailedMessage = formatLoadFileError(loadError);
                    showSaveNotification(detailedMessage, true);
                  } else {
                    showSaveNotification('最新の内容の読み込みに失敗しました', true);
                  }
                }
                return false;
              }

              shouldForceBackup = true;
              conflictOverwrite = true;
            }
          }
        } catch (error) {
          console.error('Error checking file info before save:', error);
        }

        if (deletedCount > 0 || currentSummaryString !== lastSavedElementsRef.current || shouldForceBackup) {
          const fileData: ExcalidrawFileData = {
            type: "excalidraw",
            version: 2,
            source: "https://excalidraw.com",
            elements,
            appState: stateToSave,
            files: files || {},
          };

          const saveResult = await saveExcalidrawFile(currentFilePathValue, fileData, shouldForceBackup);
          if (saveResult?.success) {
            // console.log(
            //   `[Save] File saved successfully (${elements.length} elements, ${deletedCount} deleted)`,
            // );
            setLastSavedElements(currentSummaryString);
            lastSavedElementsRef.current = currentSummaryString;
            lastSaveTimeRef.current = now;

            const resolvedHash = saveResult.hash || latestRemoteHash;
            if (resolvedHash) {
              setLastFileHash(resolvedHash);
              lastFileHashRef.current = resolvedHash;
              externalUpdateNotifiedHashRef.current = resolvedHash;
            }
            // .excalidraw.md の場合はタイムスタンプも更新
            if (isObsidianDrawingPath(currentFilePathValue) && saveResult.modified) {
              lastFileModifiedRef.current = saveResult.modified;
            }

            if (conflictOverwrite) {
              showSaveNotification('最新の内容をバックアップして上書き保存しました');
            }
            return true;
          } else {
            const message = saveResult?.message || 'ファイルの保存に失敗しました';
            showSaveNotification(message, true);
            return false;
          }
        }
      } else {
        // ローカルストレージに保存
        saveElementsToLocalStorage(elements);

        // 画像データも保存
        if (files) {
          saveBinaryFilesToLocalStorage(files);
        }

        // アプリケーション状態も保存
        saveAppStateToLocalStorage(stateToSave);

        lastSaveTimeRef.current = now;
        return true;
      }

      return false;
    } finally {
      if (!alreadySaving) {
        saveInProgressRef.current = false;
      }
    }
  }, [applyLoadedFile, buildElementSummary, excalidrawAPI, showSaveNotification]);

  // 定期的にファイルの更新日時をチェック
  const checkFileUpdates = useCallback(async () => {
    if (!currentFilePath || !excalidrawAPI) {
      return;
    }
    if (saveInProgressRef.current) {
      return;
    }
    try {
      const fileInfo = await getFileInfo(currentFilePath);
      if (!fileInfo || !fileInfo.exists) {
        return;
      }

      // .excalidraw.md ファイルはタイムスタンプベースで更新検知
      const isObsidianFile = isObsidianDrawingPath(currentFilePath);
      const remoteModified = fileInfo.modified || 0;
      const remoteHash = fileInfo.hash || '';

      let hasNewerVersion = false;
      if (isObsidianFile) {
        // タイムスタンプベースで比較（修正日時が新しければ更新あり）
        hasNewerVersion = remoteModified > 0 && remoteModified > lastFileModifiedRef.current;
      } else {
        // ハッシュベースで比較
        hasNewerVersion = !!remoteHash && remoteHash !== lastFileHashRef.current;
      }
      const alreadyNotified = isObsidianFile
        ? remoteModified === lastFileModifiedRef.current
        : remoteHash === externalUpdateNotifiedHashRef.current;

      if (hasNewerVersion && !alreadyNotified) {
        if (isObsidianFile) {
          lastFileModifiedRef.current = remoteModified;
        } else if (remoteHash) {
          externalUpdateNotifiedHashRef.current = remoteHash;
        }

        // Obsidianファイル（.excalidraw.md）の場合は、確認ダイアログを表示せず自動的に最新を読み込んで保存
        if (isObsidianDrawingPath(currentFilePath)) {
          try {
            const fileResult = await loadExcalidrawFile(currentFilePath);
            if (fileResult) {
              await applyLoadedFile(
                fileResult.data,
                fileResult.hash,
                undefined,
                fileResult.embeddedFilePaths,
                fileResult.embeddedMarkdownCandidates,
              );
              const currentElements = excalidrawAPI.getSceneElements();
              const currentAppState = excalidrawAPI.getAppState();
              const currentFiles = excalidrawAPI.getFiles();
              const saved = await performSave(currentElements, currentAppState, currentFiles, true, true);
              if (saved) {
                showSaveNotification('最新の内容を読み込んで保存しました');
              } else {
                showSaveNotification('保存に失敗しました', true);
              }
            } else {
              showSaveNotification('最新の内容の読み込みに失敗しました', true);
            }
          } catch (error) {
            if (error && typeof error === 'object' && 'status' in error && 'error' in error) {
              const loadError = error as LoadFileError;
              const detailedMessage = formatLoadFileError(loadError);
              showSaveNotification(detailedMessage, true);
            } else {
              showSaveNotification('最新の内容の読み込みに失敗しました', true);
            }
          }
        } else {
          // それ以外のファイルは従来通り確認ダイアログを表示
          const shouldReload = window.confirm(
            'ファイルが他の人によって更新されています。\nOK: 最新の内容を読み込み\nキャンセル: 現在の内容をバックアップして上書き保存',
          );

          if (shouldReload) {
            try {
              const fileResult = await loadExcalidrawFile(currentFilePath);
              if (fileResult) {
                await applyLoadedFile(
                  fileResult.data,
                  fileResult.hash,
                  '最新の内容を読み込みました',
                  fileResult.embeddedFilePaths,
                  fileResult.embeddedMarkdownCandidates,
                );
              } else {
                showSaveNotification('最新の内容の読み込みに失敗しました', true);
              }
            } catch (error) {
              if (error && typeof error === 'object' && 'status' in error && 'error' in error) {
                const loadError = error as LoadFileError;
                const detailedMessage = formatLoadFileError(loadError);
                showSaveNotification(detailedMessage, true);
              } else {
                showSaveNotification('最新の内容の読み込みに失敗しました', true);
              }
            }
          } else {
            const currentElements = excalidrawAPI.getSceneElements();
            const currentAppState = excalidrawAPI.getAppState();
            const currentFiles = excalidrawAPI.getFiles();
            const saved = await performSave(currentElements, currentAppState, currentFiles, true, true);
            if (saved) {
              showSaveNotification('最新の内容をバックアップして上書き保存しました');
            } else {
              showSaveNotification('上書き保存に失敗しました', true);
            }
          }
        }
      }
    } catch (error) {
      console.error('Error checking file updates:', error);
    }
  }, [currentFilePath, excalidrawAPI, applyLoadedFile, performSave, showSaveNotification]);

  // デバウンス処理を行う保存関数（10秒間隔制限付き）
  // - 編集が発生しても10秒に1度だけ保存を許可する
  // - 保存直前にExcalidraw APIから最新の状態を取り直し、不要な保存を避ける
  // - 外部更新の監視もここで一定間隔ごとにトリガーする
  const debouncedSave = useCallback((
    elements: NonDeletedExcalidrawElement[],
    appState: AppState,
    files: any
  ) => {
    if (!isSignificantChange(elements)) {
      return;
    }

    // 外部更新チェックは5秒間隔で実行し、編集中でも最新の変更を拾えるようにする
    const now = Date.now();
    if (now - lastCheckTimeRef.current > 5000) {
      lastCheckTimeRef.current = now;
      void checkFileUpdates();
    }

    // すでに保存待ちのタイマーが動いている場合は何もせず、10秒後の保存にまとめる
    if (saveTimeoutRef.current) {
      pendingSaveRef.current = true;
      return;
    }

    pendingSaveRef.current = true;

    saveTimeoutRef.current = setTimeout(async () => {
      saveTimeoutRef.current = null;

      const api = excalidrawAPI;
      if (!api) {
        pendingSaveRef.current = false;
        return;
      }

      // 10秒経過時点で再度最新要素を取得し、保存すべきかを再評価
      const currentElements = api.getSceneElements() as NonDeletedExcalidrawElement[];
      if (!isSignificantChange(currentElements)) {
        pendingSaveRef.current = false;
        return;
      }

      const currentAppState = api.getAppState();
      const currentFiles = api.getFiles();

      pendingSaveRef.current = false;

      // ここで初めて保存を実行。10秒以内の変更は一括で保存される
      await performSave(currentElements, currentAppState, currentFiles);
    }, SAVE_DELAY_MS);
  }, [checkFileUpdates, excalidrawAPI, isSignificantChange, performSave]);

  // 強制保存関数（10秒制限を無視）
  const forceSave = useCallback(async (
    elements: NonDeletedExcalidrawElement[],
    appState: any,
    files: any
  ) => {
    // console.log(`[Force Save] Executing forced save (elements: ${elements.length})`);

    // 10秒制限を無視して即座に保存
    lastSaveTimeRef.current = 0; // 制限をバイパス

    await performSave(elements, appState, files);

    // 保存後に実際の時刻を設定
    lastSaveTimeRef.current = Date.now();
  }, [performSave]);

  // 手動保存関数（強制バックアップ付き）
  const manualSave = useCallback(async (
    elements: NonDeletedExcalidrawElement[],
    appState: any,
    files: any
  ) => {
    // console.log(`[Manual Save] Executing manual save with forced backup (elements: ${elements.length})`);

    // 既存のperformSave関数を使用して手動保存を実行
    await performSave(elements, appState, files, true); // 強制バックアップフラグを渡す
    showSaveNotification('保存しました');
  }, [performSave, showSaveNotification]);

  // ショートカット用の保存ハンドラ
  const handleSaveShortcut = useCallback(() => {
    if (excalidrawAPI) {
      const elements = excalidrawAPI.getSceneElements();
      const appState = excalidrawAPI.getAppState();
      const files = excalidrawAPI.getFiles();
      manualSave(elements, appState, files);
    }
  }, [excalidrawAPI, manualSave]);

  // カスタムキーボードショートカット機能を追加
  useKeyboardShortcuts({
    excalidrawAPI,
    viewportCoordsToSceneCoords,
    onSave: handleSaveShortcut,
    onToggleAnnotationSettings: () => setIsAnnotationSettingsOpen((prev) => !prev),
    annotationSettings,
  });

  // 埋め込み Markdown 画像だけ、元ノートを対象にした独自メニューを表示する。
  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }

    return excalidrawAPI.onPointerDown((_activeTool, pointerDownState, event) => {
      if (event.button !== 2) {
        return;
      }

      const hitElement = pointerDownState.hit.element;
      const fileId = hitElement?.type === 'image' ? hitElement.fileId : undefined;
      contextMenuSourcePathRef.current = fileId
        ? embeddedFilePathsRef.current[fileId] || null
        : null;
    });
  }, [excalidrawAPI]);

  useEffect(() => {
    const closeContextMenu = (event: PointerEvent) => {
      if (!imageContextMenuRef.current?.contains(event.target as Node)) {
        setImageContextMenu(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setImageContextMenu(null);
      }
    };

    document.addEventListener('pointerdown', closeContextMenu);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeContextMenu);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  const handleCanvasContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    let sourcePath = contextMenuSourcePathRef.current;
    contextMenuSourcePathRef.current = null;

    // pointerdown の hit 情報が取得できない場合は、右クリック位置から画像を判定する。
    if (!sourcePath && excalidrawAPI) {
      const appState = excalidrawAPI.getAppState();
      const scenePoint = viewportCoordsToSceneCoords(
        { clientX: event.clientX, clientY: event.clientY },
        appState,
      );
      const imageAtPoint = [...excalidrawAPI.getSceneElements()].reverse().find((element) => {
        if (element.type !== 'image') {
          return false;
        }

        const centerX = element.x + element.width / 2;
        const centerY = element.y + element.height / 2;
        const deltaX = scenePoint.x - centerX;
        const deltaY = scenePoint.y - centerY;
        const cos = Math.cos(-element.angle);
        const sin = Math.sin(-element.angle);
        const localX = deltaX * cos - deltaY * sin + element.width / 2;
        const localY = deltaX * sin + deltaY * cos + element.height / 2;
        return localX >= 0 && localX <= element.width && localY >= 0 && localY <= element.height;
      });

      if (imageAtPoint?.type === 'image') {
        const file = excalidrawAPI.getFiles()[imageAtPoint.fileId] as { sourcePath?: string } | undefined;
        sourcePath = embeddedFilePathsRef.current[imageAtPoint.fileId] || file?.sourcePath || null;
      }
    }

    // 右クリックイベントが先に選択状態を作った場合は、選択中の画像から解決する。
    if (!sourcePath && excalidrawAPI) {
      const selectedElementIds = excalidrawAPI.getAppState().selectedElementIds;
      const selectedImage = excalidrawAPI.getSceneElements().find((element) => {
        if (element.type !== 'image' || !selectedElementIds[element.id]) {
          return false;
        }
        const file = excalidrawAPI.getFiles()[element.fileId] as { sourcePath?: string } | undefined;
        return Boolean(embeddedFilePathsRef.current[element.fileId] || file?.sourcePath);
      });

      if (selectedImage?.type === 'image') {
        const file = excalidrawAPI.getFiles()[selectedImage.fileId] as { sourcePath?: string } | undefined;
        sourcePath = embeddedFilePathsRef.current[selectedImage.fileId] || file?.sourcePath || null;
      }
    }

    if (!sourcePath) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setImageContextMenu({
      left: Math.min(event.clientX, Math.max(8, window.innerWidth - 228)),
      top: Math.min(event.clientY, Math.max(8, window.innerHeight - 100)),
      sourcePath,
    });
  }, [excalidrawAPI, viewportCoordsToSceneCoords]);

  const openEmbeddedNoteInWebApp = useCallback((sourcePath: string) => {
    const noteUrl = new URL(window.location.href);
    noteUrl.searchParams.set('filepath', sourcePath);
    window.open(noteUrl.toString(), '_blank', 'noopener');
    setImageContextMenu(null);
  }, []);

  const openEmbeddedNoteInObsidian = useCallback((sourcePath: string) => {
    setImageContextMenu(null);
    // 8001のopen-pathが、Obsidian Vault内のMarkdownパスを
    // obsidian://open?vault=...&file=... へ変換して起動する。
    const redirectWindow = window.open('about:blank', '_blank');
    void openPathWithFallback(sourcePath, redirectWindow).catch((error) => {
      console.error('Error opening embedded note in Obsidian:', error);
      if (redirectWindow && !redirectWindow.closed) {
        redirectWindow.close();
      }
      if (typeof window !== 'undefined' && window.alert) {
        window.alert('Obsidianでノートを開けませんでした。');
      }
    });
  }, []);

  // ページを離れる前に未保存の変更を警告する
  // useEffect(() => {
  //   const handleBeforeUnload = (event: BeforeUnloadEvent) => {
  //     if (excalidrawAPI && isSignificantChange(excalidrawAPI.getSceneElements())) {
  //       // 未保存の変更がある場合、ブラウザ標準の確認ダイアログを表示
  //       event.preventDefault();
  //       event.returnValue = ''; // 古いブラウザ向けの互換性設定
  //     }
  //   };

  //   window.addEventListener('beforeunload', handleBeforeUnload);

  //   return () => {
  //     window.removeEventListener('beforeunload', handleBeforeUnload);
  //   };
  // }, [excalidrawAPI, isSignificantChange]);

  // コンポーネントのクリーンアップ時にタイマーをクリア
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
    };
  }, []);

  // ライブラリ変更時の自動保存処理
  const handleLibraryChange = useCallback(async (libraryItems: any[]) => {
    console.log(`ライブラリが変更されました: ${libraryItems.length} アイテム`);

    // 空のライブラリデータの保存を防止
    if (!libraryItems || libraryItems.length === 0) {
      console.warn('空のライブラリデータの保存をスキップしました');
      return;
    }

    // 既存のライブラリファイルの内容を確認
    try {
      const currentResponse = await fetch('/excalidraw_lib/my_lib.excalidrawlib', {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache',
        },
      });
      if (currentResponse.ok) {
        const currentContent = await currentResponse.text();
        const currentData = parseLibraryContent(currentContent);

        // 現在のファイルにデータがあり、新しいデータが空の場合は保存しない
        if (Array.isArray(currentData.libraryItems) && currentData.libraryItems.length > 0 && libraryItems.length === 0) {
          console.warn('既存のライブラリデータを保護するため、空のデータでの上書きをスキップしました');
          return;
        }
      }
    } catch (error) {
      console.warn('既存ライブラリファイルの確認に失敗:', error);
    }

    try {
      const libraryData = {
        type: "excalidrawlib",
        version: 2,
        source: window.location.origin,
        libraryItems
      };

      const response = await fetch(`${API_BASE_URL}/save-library`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          file_path: 'public/excalidraw_lib/my_lib.excalidrawlib',
          data: libraryData
        })
      });

      if (response.ok) {
        console.log('ライブラリが自動保存されました');
      } else {
        console.error('ライブラリの保存に失敗しました');
      }
    } catch (error) {
      console.error('ライブラリ保存中にエラーが発生しました:', error);
    }
  }, []);

  const renderExcalidraw = (children: React.ReactNode) => {
    const Excalidraw: any = Children.toArray(children).find(
      (child) =>
        React.isValidElement(child) &&
        typeof child.type !== "string" &&
        //@ts-ignore
        child.type.displayName === "Excalidraw",
    );
    if (!Excalidraw) {
      return;
    }
    const newElement = cloneElement(
      Excalidraw,
      {
        excalidrawAPI: (api: ExcalidrawImperativeAPI) => setExcalidrawAPI(api),
        initialData: initialStatePromiseRef.current.promise,
        langCode: 'ja-JP',
        onChange: (
          elements: NonDeletedExcalidrawElement[],
          state: AppState,
          files: any,
        ) => {
          // デバウンス処理を使用して保存
          debouncedSave(elements, state, files);
        },
        onLibraryChange: handleLibraryChange,
        onLinkOpen: (
          element: NonDeletedExcalidrawElement,
          event: CustomEvent<{ nativeEvent: MouseEvent | React.PointerEvent<HTMLCanvasElement> }>,
        ) => {
          // 付箋のリンククリック処理をカスタマイズ
          if (element.link) {
            event.preventDefault();
            const nativeEvent = event.detail?.nativeEvent;
            if (nativeEvent) {
              nativeEvent.preventDefault();
              nativeEvent.stopPropagation();
            }
            void handleStickyNoteLink(element.link, getCurrentFolder() ?? undefined);
          }
        },
        uiOptions: {
          canvasActions: {
            saveAs: false,
            saveToActiveFile: false,
          },
        },
      },
    );
    return newElement;
  };

  return (
    <div className="App" ref={appRef}>
      {/* 保存通知 */}
      {saveNotification && (
        <div className={`save-notification ${saveNotification.isError ? 'error' : ''}`}>
          {saveNotification.message}
        </div>
      )}

      {/* カスタムヘッダー */}
      <div className="custom-header">
        <div className="header-actions">
          <button
            className="header-btn new-file-btn"
            onClick={() => void showNewFileDialog(getCurrentFolder())}
            title="新規作成"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
          <button
            className="header-btn annotation-settings-btn"
            onClick={() => setIsAnnotationSettingsOpen((prev) => !prev)}
            title="マーカーとアンダーラインの設定 (,)"
            aria-label="マーカーとアンダーラインの設定"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
          </button>
          <button
            className="header-btn open-explorer-btn"
            onClick={() => openInFileExplorer(getCurrentFolder())}
            title="フォルダを開く"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 7h5l2 3h11a1 1 0 0 1 1 1v7a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z" />
              <polyline points="13 12 16 15 21 10" />
            </svg>
          </button>
          <button
            className="header-btn open-code-btn"
            onClick={() => openInCode(getCurrentFolder())}
            title="codeで開く"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="16,18 22,12 16,6"></polyline>
              <polyline points="8,6 2,12 8,18"></polyline>
            </svg>
          </button>
          <button
            className="header-btn manual-save-btn"
            onClick={() => {
              if (excalidrawAPI) {
                const elements = excalidrawAPI.getSceneElements();
                const appState = excalidrawAPI.getAppState();
                const files = excalidrawAPI.getFiles();
                manualSave(elements, appState, files);
              }
            }}
            title="手動保存（強制バックアップ）"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
              <polyline points="17,21 17,13 7,13 7,21"></polyline>
              <polyline points="7,3 7,8 15,8"></polyline>
            </svg>
          </button>
          <button
            className="header-btn export-svg-btn"
            onClick={() => exportSvg(getCurrentFolder())}
            title="SVGで保存"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
              <polyline points="7,18 12,23 17,18"></polyline>
              <line x1="12" y1="23" x2="12" y2="12"></line>
              <text x="12" y="9" textAnchor="middle" fontSize="15" fill="currentColor">svg</text>
            </svg>
          </button>
        </div>
      </div>

      {isFileBrowserOpen && (
        <div className="file-browser-overlay" onClick={closeFileBrowser}>
          <div className="file-browser-window" onClick={(event) => event.stopPropagation()}>
            <div className="file-browser-titlebar">
              <span>開く</span>
              <button
                type="button"
                className="file-browser-titlebar-close"
                onClick={closeFileBrowser}
                aria-label="ファイル選択を閉じる"
              >
                ×
              </button>
            </div>
            <div className="file-browser-toolbar">
              <div className="file-browser-toolbar-buttons">
                <button
                  type="button"
                  title="上へ"
                  onClick={() => handleDirectoryNavigate(fileBrowserParentPath)}
                  disabled={!fileBrowserParentPath || isFileBrowserLoading}
                  aria-label="親フォルダへ"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="7 11 12 6 17 11" />
                    <line x1="12" y1="6" x2="12" y2="20" />
                  </svg>
                </button>
                <button
                  type="button"
                  title="更新"
                  onClick={() => fetchDirectoryContents(fileBrowserPath)}
                  disabled={isFileBrowserLoading}
                  aria-label="再読み込み"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="1 4 1 10 7 10" />
                    <polyline points="23 20 23 14 17 14" />
                    <path d="M20.49 9A9 9 0 0 0 6.83 5.17L1 10" />
                    <path d="M3.51 15A9 9 0 0 0 17.17 18.83L23 14" />
                  </svg>
                </button>
              </div>
              <div className="file-browser-location">
                <label htmlFor="file-browser-location-input">場所:</label>
                <input
                  id="file-browser-location-input"
                  type="text"
                  value={displayPathValue}
                  readOnly
                />
              </div>
            </div>
            <div className="file-browser-content">
              {fileBrowserError && (
                <div className="file-browser-message error">{fileBrowserError}</div>
              )}
              <div className="file-browser-table">
                <div className="file-browser-table-header">
                  <span className="column name">名前</span>
                  <span className="column modified">更新日時</span>
                  <span className="column type">種類</span>
                  <span className="column size">サイズ</span>
                </div>
                <div className="file-browser-table-body">
                  {isFileBrowserLoading ? (
                    <div className="file-browser-message">読み込み中...</div>
                  ) : fileBrowserEntries.length === 0 ? (
                    <div className="file-browser-message">このフォルダには項目がありません。</div>
                  ) : (
                    fileBrowserEntries.map((entry) => {
                      const isSelected = fileBrowserSelectedEntry?.path === entry.path;
                      const classNames = [
                        'file-browser-row',
                        entry.isDir ? 'is-dir' : 'is-file',
                        isSelected ? 'is-selected' : '',
                      ]
                        .filter(Boolean)
                        .join(' ');
                      return (
                        <button
                          key={entry.path}
                          type="button"
                          className={classNames}
                          onClick={() => handleEntryClick(entry)}
                          onDoubleClick={() => handleEntryDoubleClick(entry)}
                          onKeyDown={(event) => handleEntryKeyDown(event, entry)}
                          aria-selected={isSelected}
                        >
                          <span className="column name" title={entry.name}>
                            <svg
                              className="entry-icon"
                              width="18"
                              height="18"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              aria-hidden="true"
                            >
                              {entry.isDir ? (
                                <path d="M3 7h5l2 3h11a1 1 0 0 1 1 1v9a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
                              ) : (
                                <>
                                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                  <polyline points="14,2 14,8 20,8" />
                                </>
                              )}
                            </svg>
                            <span className="entry-name">{entry.name}</span>
                          </span>
                          <span className="column modified">
                            {formatModified(entry.modified ?? null)}
                          </span>
                          <span className="column type">{getTypeLabel(entry)}</span>
                          <span className="column size">{entry.isDir ? '' : formatSize(entry.size ?? null)}</span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
            <div className="file-browser-footer">
              <div className="file-browser-field">
                <label htmlFor="file-browser-file-name">ファイル名(N):</label>
                <input
                  id="file-browser-file-name"
                  type="text"
                  value={fileBrowserInputValue}
                  onChange={(event) => {
                    setFileBrowserInputValue(event.target.value);
                    setFileBrowserError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      handleFileBrowserConfirm();
                    }
                  }}
                  autoFocus
                />
              </div>
              <div className="file-browser-field">
                <label htmlFor="file-browser-file-type">ファイルの種類(T):</label>
                <select id="file-browser-file-type" value="excalidraw" disabled>
                  <option value="excalidraw">Excalidraw ファイル (*.excalidraw)</option>
                  <option value="all">すべてのファイル (*.*)</option>
                </select>
              </div>
              <div className="file-browser-footer-buttons">
                <button type="button" onClick={handleFileBrowserConfirm} disabled={openButtonDisabled}>
                  開く(O)
                </button>
                <button type="button" onClick={closeFileBrowser}>
                  キャンセル
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {imageContextMenu && (
        <div
          ref={imageContextMenuRef}
          className="embedded-image-context-menu"
          style={{ left: imageContextMenu.left, top: imageContextMenu.top }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => openEmbeddedNoteInWebApp(imageContextMenu.sourcePath)}
          >
            webアプリで編集
          </button>
          <button
            type="button"
            onClick={() => openEmbeddedNoteInObsidian(imageContextMenu.sourcePath)}
          >
            obsidianで表示
          </button>
        </div>
      )}
      <AnnotationSettingsModal
        isOpen={isAnnotationSettingsOpen}
        onClose={() => setIsAnnotationSettingsOpen(false)}
        settings={annotationSettings}
        onUpdateSettings={(newSettings) => {
          setAnnotationSettings(newSettings);
          saveAnnotationSettings(newSettings);
        }}
      />
      <div
        className="excalidraw-wrapper"
        ref={containerRef}
        onContextMenuCapture={handleCanvasContextMenu}
      >
        {renderExcalidraw(children)}
      </div>
    </div>
  );
}
