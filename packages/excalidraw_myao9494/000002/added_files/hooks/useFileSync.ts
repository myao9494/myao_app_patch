/**
 * 図面ファイルの読み込み・自動保存・外部更新の取り込みを担うフック
 *
 * ■ 読み込み（ページ表示時に1回だけ）
 *   - URL の `?filepath=` があればバックエンドから読み込む。なければ localStorage を使う。
 *   - Excalidraw 以外のファイルが指定された場合は OS の既定アプリで開く。
 *   - Vault 内の .excalidraw は .excalidraw.md に変換し、元ファイルを backup/ へ移動する。
 *   - 読み込みに失敗したファイルは、空の図面で上書きしないよう保存を停止する。
 *
 * ■ 自動保存
 *   - 要素が変わってから 10 秒後に、内容が保存済みと異なれば保存する
 *     （10 秒以内の変更はまとめて 1 回で保存）。
 *   - タブが非表示になったときは、保存待ちの変更をすぐに保存する。
 *   - 手動保存（Ctrl/Cmd+S・保存ボタン）は内容が同じでも保存し、バックアップを強制する。
 *
 * ■ 外部更新（Obsidian・別タブ・他の人による更新）
 *   - 編集中は 5 秒に 1 回、保存前には毎回ファイルの更新日時を確認する。
 *   - 前回の読み込み・保存より新しければ、最新の内容を読み込んで画面を置き換え、保存し直す。
 *
 * 保存・外部更新の確認は1つのキューで直列に実行する。
 * 自分の保存による更新日時の変化を「外部更新」と誤検知しないため。
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type {
  AppState,
  BinaryFileData,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from '@excalidraw/excalidraw/types';
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types';

import initialData from '../initialData';
import {
  archiveFile,
  formatLoadFileError,
  getFileInfo,
  isLoadFileError,
  loadExcalidrawFile,
  saveExcalidrawFile,
  type ExcalidrawFileData,
  type LoadFileResponse,
} from '../utils/backendApi';
import { hydrateEmbeddedMarkdownFiles, resolveEmbeddedMarkdownSources } from '../utils/embeddedMarkdown';
import { fetchLibraryItems } from '../utils/libraryItems';
import { openPathWithFallback } from '../utils/linkHandler';
import {
  loadAppStateFromLocalStorage,
  loadBinaryFilesFromLocalStorage,
  loadElementsFromLocalStorage,
  saveAppStateToLocalStorage,
  saveBinaryFilesToLocalStorage,
  saveElementsToLocalStorage,
} from '../utils/localStorage';
import { getFilePathFromUrl, isExcalidrawFile } from '../utils/pathUtils';
import { resolvablePromise, type ResolvablePromise } from '../utils/resolvablePromise';
import { buildElementSummary, getSceneVersionKey, pickPersistedAppState } from '../utils/sceneSummary';

export const SAVE_DELAY_MS = 10000;
export const EXTERNAL_CHECK_INTERVAL_MS = 5000;

export type Notify = (message: string, isError?: boolean) => void;

export interface UseFileSyncOptions {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  notify: Notify;
  /** Embedded Files の fileId → 実ファイルパス（読み込みのたびに更新する。右クリックメニュー用） */
  embeddedFilePathsRef: MutableRefObject<Record<string, string>>;
  /** 外部更新の取り込みなどで、シーンが丸ごと置き換わったときに呼ばれる */
  onSceneReplaced?: () => void;
}

export interface UseFileSyncResult {
  /** 開いている図面のパス（localStorage モードでは null） */
  currentFilePath: string | null;
  /** Excalidraw の initialData に渡す Promise */
  initialDataPromise: ResolvablePromise<ExcalidrawInitialDataState | null>;
  /** Excalidraw の onChange に渡すハンドラー */
  handleChange: (elements: readonly { version: number; versionNonce: number }[]) => void;
  /** 手動保存（バックアップを強制） */
  saveNow: () => Promise<void>;
}

const toSceneAppState = (appState: Partial<AppState> | undefined): Partial<AppState> => ({
  ...initialData.appState,
  ...(appState || {}),
  collaborators: (appState?.collaborators instanceof Map
    ? appState.collaborators
    : new Map(Object.entries((appState?.collaborators as any) || {}))) as AppState['collaborators'],
});

const emptyScene = (): ExcalidrawInitialDataState => ({
  ...initialData,
  elements: [],
  appState: initialData.appState,
  files: {},
});

const setUrlFilePath = (filePath: string, mode: 'push' | 'replace'): void => {
  const url = new URL(window.location.href);
  url.searchParams.set('filepath', filePath);
  if (mode === 'push') {
    window.history.pushState({}, '', url.toString());
  } else {
    window.history.replaceState({}, '', url.toString());
  }
};

/** 埋め込みMarkdownノートの元ファイルを特定し、表示用の files を用意する */
const prepareFiles = async (fileResult: LoadFileResponse) => {
  const embeddedFilePaths = await resolveEmbeddedMarkdownSources(
    fileResult.data,
    fileResult.embeddedFilePaths,
    fileResult.embeddedMarkdownCandidates,
  );
  const files = await hydrateEmbeddedMarkdownFiles(fileResult.data, embeddedFilePaths);
  return { files, embeddedFilePaths };
};

export const useFileSync = ({
  excalidrawAPI,
  notify,
  embeddedFilePathsRef,
  onSceneReplaced,
}: UseFileSyncOptions): UseFileSyncResult => {
  const [currentFilePath, setCurrentFilePathState] = useState<string | null>(null);
  const [filePathInitialized, setFilePathInitialized] = useState(false);

  // 非同期処理から常に最新値を参照するため ref でも保持する
  const apiRef = useRef(excalidrawAPI);
  apiRef.current = excalidrawAPI;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const onSceneReplacedRef = useRef(onSceneReplaced);
  onSceneReplacedRef.current = onSceneReplaced;

  const filePathRef = useRef<string | null>(null);
  const initialDataPromiseRef = useRef<ResolvablePromise<ExcalidrawInitialDataState | null>>();
  if (!initialDataPromiseRef.current) {
    initialDataPromiseRef.current = resolvablePromise<ExcalidrawInitialDataState | null>();
  }

  const loadStartedRef = useRef(false);
  /** 初期データの準備完了前（空のキャンバス）に保存しないためのフラグ */
  const sceneReadyRef = useRef(false);
  /** 読み込みに失敗したファイルを上書きしないよう、保存を止める理由 */
  const saveBlockedReasonRef = useRef<string | null>(null);
  /** 最後に読み込み・保存した内容の要約 */
  const savedSummaryRef = useRef('');
  /** 最後に読み込み・保存したときのファイル更新日時（外部更新検知の基準） */
  const lastFileModifiedRef = useRef(0);
  const lastVersionKeyRef = useRef<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const lastExternalCheckRef = useRef(0);
  const syncQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const pendingTasksRef = useRef(0);

  const setCurrentFilePath = useCallback((filePath: string | null) => {
    filePathRef.current = filePath;
    setCurrentFilePathState(filePath);
  }, []);

  /** 保存・外部更新確認を直列に実行する */
  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    pendingTasksRef.current += 1;
    const run = syncQueueRef.current.then(task, task);
    syncQueueRef.current = run
      .catch((error) => console.error('[Sync] task failed:', error))
      .finally(() => {
        pendingTasksRef.current -= 1;
      });
    return run;
  }, []);

  /** 現在のシーンをファイルへ書き込む。内容が保存済みと同じなら force 時以外はスキップ */
  const writeScene = useCallback(async (filePath: string, forceBackup: boolean): Promise<boolean> => {
    const api = apiRef.current;
    if (!api) {
      return false;
    }
    const elements = api.getSceneElements() as NonDeletedExcalidrawElement[];
    const summary = buildElementSummary(elements);
    if (!forceBackup && summary === savedSummaryRef.current) {
      return false;
    }

    const fileData: ExcalidrawFileData = {
      type: 'excalidraw',
      version: 2,
      source: 'https://excalidraw.com',
      elements,
      appState: pickPersistedAppState(api.getAppState()),
      files: api.getFiles() || {},
    };
    const result = await saveExcalidrawFile(filePath, fileData, forceBackup);
    if (!result.success) {
      notifyRef.current(result.message || 'ファイルの保存に失敗しました', true);
      return false;
    }

    savedSummaryRef.current = summary;
    if (result.modified) {
      lastFileModifiedRef.current = result.modified;
    }
    return true;
  }, []);

  /** 読み込んだファイルでシーンを置き換える */
  const applyLoadedFile = useCallback(async (fileResult: LoadFileResponse) => {
    const api = apiRef.current;
    if (!api) {
      return;
    }
    const { files, embeddedFilePaths } = await prepareFiles(fileResult);
    embeddedFilePathsRef.current = embeddedFilePaths;
    onSceneReplacedRef.current?.();

    const loadedFiles = Object.values(files).filter((file) => file?.dataURL) as BinaryFileData[];
    if (loadedFiles.length > 0) {
      api.addFiles(loadedFiles);
    }
    api.updateScene({
      elements: fileResult.data.elements ?? [],
      appState: toSceneAppState(fileResult.data.appState) as AppState,
    });

    savedSummaryRef.current = buildElementSummary(api.getSceneElements() as NonDeletedExcalidrawElement[]);
    lastVersionKeyRef.current = getSceneVersionKey(api.getSceneElementsIncludingDeleted());
    if (fileResult.modified) {
      lastFileModifiedRef.current = fileResult.modified;
    }
  }, [embeddedFilePathsRef]);

  /** ファイルが前回の読み込み・保存より新しくなっていれば true */
  const detectExternalUpdate = useCallback(async (filePath: string): Promise<boolean> => {
    const fileInfo = await getFileInfo(filePath);
    const remoteModified = fileInfo?.exists ? fileInfo.modified || 0 : 0;
    if (remoteModified > 0 && remoteModified > lastFileModifiedRef.current) {
      lastFileModifiedRef.current = remoteModified;
      return true;
    }
    return false;
  }, []);

  /** 外部で更新されたファイルを読み込み直し、その内容で保存し直す */
  const reloadFromDiskAndResave = useCallback(async (filePath: string) => {
    try {
      const fileResult = await loadExcalidrawFile(filePath);
      if (!fileResult) {
        notifyRef.current('最新の内容の読み込みに失敗しました', true);
        return;
      }
      await applyLoadedFile(fileResult);
      if (await writeScene(filePath, true)) {
        notifyRef.current('最新の内容を読み込んで保存しました');
      }
    } catch (error) {
      notifyRef.current(
        isLoadFileError(error) ? formatLoadFileError(error) : '最新の内容の読み込みに失敗しました',
        true,
      );
    }
  }, [applyLoadedFile, writeScene]);

  /** 保存（外部更新があれば先に取り込む）。保存した場合 true */
  const performSave = useCallback((forceBackup: boolean): Promise<boolean> => enqueue(async () => {
    const api = apiRef.current;
    if (!sceneReadyRef.current || !api) {
      return false;
    }
    if (saveBlockedReasonRef.current) {
      notifyRef.current(`読み込みに失敗したファイルのため保存していません。\n\n${saveBlockedReasonRef.current}`, true);
      return false;
    }

    const filePath = filePathRef.current;
    if (!filePath) {
      saveElementsToLocalStorage(api.getSceneElements() as NonDeletedExcalidrawElement[]);
      saveBinaryFilesToLocalStorage(api.getFiles());
      saveAppStateToLocalStorage(pickPersistedAppState(api.getAppState()));
      return true;
    }

    if (await detectExternalUpdate(filePath)) {
      await reloadFromDiskAndResave(filePath);
      return false;
    }
    return writeScene(filePath, forceBackup);
  }), [detectExternalUpdate, enqueue, reloadFromDiskAndResave, writeScene]);

  /** 編集中の外部更新チェック（保存処理中はスキップ） */
  const checkExternalUpdate = useCallback(() => {
    const filePath = filePathRef.current;
    if (!filePath || !sceneReadyRef.current || saveBlockedReasonRef.current || pendingTasksRef.current > 0) {
      return;
    }
    void enqueue(async () => {
      if (await detectExternalUpdate(filePath)) {
        await reloadFromDiskAndResave(filePath);
      }
    });
  }, [detectExternalUpdate, enqueue, reloadFromDiskAndResave]);

  const handleChange = useCallback((elements: readonly { version: number; versionNonce: number }[]) => {
    if (!sceneReadyRef.current) {
      return;
    }

    if (filePathRef.current) {
      // スクロール・選択・ポインタ移動など、要素が変わらない onChange は無視する
      const versionKey = getSceneVersionKey(elements);
      if (versionKey === lastVersionKeyRef.current) {
        return;
      }
      lastVersionKeyRef.current = versionKey;

      const now = Date.now();
      if (now - lastExternalCheckRef.current > EXTERNAL_CHECK_INTERVAL_MS) {
        lastExternalCheckRef.current = now;
        checkExternalUpdate();
      }
    }

    // 保存待ちのタイマーがあれば、その保存にまとめる
    if (saveTimerRef.current === null) {
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void performSave(false);
      }, SAVE_DELAY_MS);
    }
  }, [checkExternalUpdate, performSave]);

  const saveNow = useCallback(async () => {
    if (await performSave(true)) {
      notifyRef.current('保存しました');
    }
  }, [performSave]);

  /** Vault内の .excalidraw を .excalidraw.md に変換し、元ファイルを backup/ へ移動する */
  const migrateToMarkdown = useCallback(async (excalidrawPath: string, fileData: ExcalidrawFileData) => {
    const markdownPath = `${excalidrawPath}.md`;
    console.log(`[Obsidian Compat] converting ${excalidrawPath} to ${markdownPath}`);
    const saveResult = await saveExcalidrawFile(markdownPath, fileData, true);
    if (!saveResult.success) {
      console.error('[Obsidian Compat] Failed to create .excalidraw.md', saveResult.message);
      return;
    }

    setCurrentFilePath(markdownPath);
    setUrlFilePath(markdownPath, 'push');
    if (saveResult.modified) {
      lastFileModifiedRef.current = saveResult.modified;
    }
    const archiveResult = await archiveFile(excalidrawPath);
    if (archiveResult.success) {
      console.log('[Obsidian Compat] Archived original file:', archiveResult.archivedPath);
    } else {
      console.warn('[Obsidian Compat] Failed to archive original file:', archiveResult.error);
    }
  }, [setCurrentFilePath]);

  /** ファイル（または localStorage）から初期シーンを用意する */
  const loadInitialScene = useCallback(async (filePath: string | null): Promise<ExcalidrawInitialDataState> => {
    if (!filePath) {
      const savedElements = loadElementsFromLocalStorage();
      const savedAppState = loadAppStateFromLocalStorage();
      savedSummaryRef.current = buildElementSummary(savedElements as NonDeletedExcalidrawElement[]);
      return {
        ...initialData,
        elements: savedElements,
        appState: savedAppState ? { ...initialData.appState, ...savedAppState } : initialData.appState,
        files: loadBinaryFilesFromLocalStorage(),
      };
    }

    try {
      const fileResult = await loadExcalidrawFile(filePath);
      if (!fileResult) {
        console.log('新規ファイルとして開始します:', filePath);
        savedSummaryRef.current = buildElementSummary([]);
        return emptyScene();
      }

      const { files, embeddedFilePaths } = await prepareFiles(fileResult);
      embeddedFilePathsRef.current = embeddedFilePaths;
      const elements = fileResult.data.elements ?? [];
      savedSummaryRef.current = buildElementSummary(elements);
      lastVersionKeyRef.current = getSceneVersionKey(elements);
      lastFileModifiedRef.current = fileResult.modified || 0;

      let activePath = filePath;
      if (fileResult.resolvedPath && fileResult.resolvedPath !== filePath) {
        activePath = fileResult.resolvedPath;
        setCurrentFilePath(activePath);
        setUrlFilePath(activePath, 'replace');
      }

      if (fileResult.shouldMigrateToMarkdown) {
        await migrateToMarkdown(activePath, {
          ...fileResult.data,
          elements,
          files,
        });
      }

      return {
        ...initialData,
        elements,
        appState: toSceneAppState(fileResult.data.appState),
        files,
      };
    } catch (error) {
      const message = isLoadFileError(error) ? formatLoadFileError(error) : String(error);
      console.error('ファイルの読み込みに失敗しました:', error);
      saveBlockedReasonRef.current = message;
      notifyRef.current(
        `ファイルを読み込めませんでした。上書きを防ぐため、このタブでは保存しません。\n\n${message}`,
        true,
      );
      return emptyScene();
    }
  }, [embeddedFilePathsRef, migrateToMarkdown, setCurrentFilePath]);

  // URL の filepath を確認する。Excalidraw 以外のファイルは OS の既定アプリで開く。
  useEffect(() => {
    let disposed = false;
    const initializeFilePath = async () => {
      const filePath = getFilePathFromUrl();
      if (filePath && !isExcalidrawFile(filePath)) {
        // 通常の .md は、Front Matter の parsed マーカーをバックエンドで確認する
        const fileInfo = filePath.toLowerCase().endsWith('.md')
          ? await getFileInfo(filePath, { silent: true })
          : null;
        if (!fileInfo?.isExcalidraw) {
          if (!disposed) {
            setFilePathInitialized(true);
          }
          openPathWithFallback(filePath, window).catch((error) => {
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
  }, [setCurrentFilePath]);

  // 初期シーンの読み込み（Excalidraw の initialData は1回しか受け付けないため1回だけ）
  useEffect(() => {
    if (!excalidrawAPI || !filePathInitialized || loadStartedRef.current) {
      return;
    }
    loadStartedRef.current = true;

    void (async () => {
      const scene = await loadInitialScene(filePathRef.current);
      const libraryItems = await fetchLibraryItems();
      if (libraryItems) {
        scene.libraryItems = libraryItems;
      }
      sceneReadyRef.current = true;
      initialDataPromiseRef.current!.resolve(scene);
    })();
  }, [excalidrawAPI, filePathInitialized, loadInitialScene]);

  // タブが非表示になったら、保存待ちの変更をすぐ保存する（タブを閉じる前の取りこぼし防止）
  useEffect(() => {
    const flushPendingSave = () => {
      if (document.visibilityState === 'hidden' && saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        void performSave(false);
      }
    };
    document.addEventListener('visibilitychange', flushPendingSave);
    return () => document.removeEventListener('visibilitychange', flushPendingSave);
  }, [performSave]);

  useEffect(() => () => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  return {
    currentFilePath,
    initialDataPromise: initialDataPromiseRef.current,
    handleChange,
    saveNow,
  };
};
