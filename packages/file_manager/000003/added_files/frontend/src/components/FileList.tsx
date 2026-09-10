/**
 * ファイル一覧コンポーネント
 * リストビューでファイル/フォルダを表示
 * ドラッグ&ドロップ対応、検索機能、ツールバー
 */
import { useState, useRef, useMemo, useEffect, useCallback, lazy, Suspense, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  // Folder,
  // File,
  ChevronUp,
  ChevronDown,
  FolderPlus,
  Trash2,
  RefreshCw,
  Search,
  X,
  Download,
  Code,
  FolderOpen,
  ClipboardPaste,
  Gem,
  History,
  Copy,
  Link,
  ArrowLeft,
  ArrowRight,
  Home,
  Rocket,
  Network,
  FlaskConical, // For Test Folder
} from "lucide-react";
import { useFiles, useDeleteItemsBatch, useCreateFolder, useMoveItemsBatch, useCopyItemsBatch } from "../hooks/useFiles";
import { copyFilesToClipboard } from "../api/clipboard";
import { useQueryClient } from "@tanstack/react-query";
import type { FileItem } from "../types/file";
import { buildAppPathUrl, buildFullPathUrl, getPathInfo, openInVSCode, openInEditor, executeProgramCode, openInExplorer, getDownloadUrl, getFullTextSearchUrl, getPdfViewUrl, getHtmlViewUrl, openInAntigravity, openInJupyter, openInExcalidraw, createFile, updateFile, openInObsidian, openSmart, countFiles, getFolderGitStatuses, getFolderLatestModified, openTrash, getTestFolderPath, uploadFiles, getObsidianDailyPath } from "../api/files";
import { ProgressModal } from "./ProgressModal";
import { useToast } from "../hooks/useToast";
import { ContextMenu } from "./ContextMenu";
import { PaneContextMenu } from "./PaneContextMenu";
import { EXT_FILTERS, FilterBar } from "./FilterBar";
// import { Toast } from "./Toast";
import { FileIcon } from "./FileIcon";
import { InputModal } from "./InputModal";
import { TextFileCreateModal } from "./TextFileCreateModal";
import { Modal } from "./Modal";
import { ConfirmationModal } from "./ConfirmationModal";
import { IndexedFolderSearchModal } from "./IndexedFolderSearchModal";
import { FolderHistoryModal } from "./FolderHistoryModal";
import { getNetworkDrivePath, getDefaultBasePath } from "../config";
import { useOperationHistoryContext } from "../contexts/OperationHistoryContext";
import { useFolderHistory } from "../contexts/FolderHistoryContext";
import { sanitizePath, formatPathForClipboard } from "../utils/pathUtils";
import { formatItemsAsMarkdownChecklist, formatItemsAsMarkdownBulletList } from "../utils/markdownChecklist";
import { shouldShowPaneContextMenu } from "../utils/paneContextMenuHelper";
import { isHtmlFile, isProgramCodeFile } from "../utils/codeFileActions";
import { isEditableEventTarget, matchesCmdOrCtrlShortcut, matchesPlainShortcut } from "../utils/globalShortcuts";
import { formatFileDate } from "../utils/formatFileDate";
import { scanDataTransferItems } from "../utils/dragDropScan";
import { buildGitSyncCommand, type GitSyncAction } from "../utils/gitCommands";
import { buildTextFileName } from "../utils/textFileName";
import type { IndexedFolderSearchItem } from "../api/fulltextIndexService";
import type { EditorLanguage } from "../utils/codeEditorHighlight";
import { isWebFileEditorTarget } from "../utils/codeEditorHighlight";
import type { MarkdownOpenMode, TextFileOpenMode } from "../utils/editorPreferences";
import { isImageFile, getImageSiblings } from "../utils/imageUtils";
import { formatSearchMatchCount, getNextSearchHitIndex, formatSearchPosition } from "../utils/searchFilter";
import { ImagePreviewModal } from "./ImagePreviewModal";
import "./FileList.css";

const MarkdownEditorModal = lazy(() =>
  import("./MarkdownEditorModal").then((module) => ({ default: module.MarkdownEditorModal }))
);
const FileEditorModal = lazy(() =>
  import("./FileEditorModal").then((module) => ({ default: module.FileEditorModal }))
);

interface FileListProps {
  initialPath?: string;
  panelId?: string;
  path?: string;
  initialOpenFilePath?: string;
  initialOpenMode?: "web";
  onInitialOpenHandled?: () => void;
  onPathChange?: (path: string) => void;
  onOpenInAdjacentPane?: (path: string) => void;
  isFocused?: boolean;
  onRequestFocus?: () => void;
  textFileOpenMode?: TextFileOpenMode;
  markdownOpenMode?: MarkdownOpenMode;
  defaultTextFileExtension?: string;
}

// ナビゲーション履歴エントリの型（カーソル・選択状態を含む）
interface NavigationHistoryEntry {
  path: string;
  focusedIndex: number;
  selectedItems: string[];
}

// ドラッグアンドドロップの状態をコンポーネント間で共有するためのグローバル変数
// useRefはコンポーネントインスタンスごとなので、ペイン間の移動には適さない
let globalDraggedItems: FileItem[] = [];
// ドラッグ元のペインIDを追跡（同一ペイン移動の確認用）
let globalDragSourcePanelId: string | null = null;

// グローバルクリップボード（アプリ内コピー＆ペースト用）
let globalClipboard: { paths: string[]; op: 'copy' | 'move' } | null = null;

function getFileExtension(name: string): string {
  const lastDotIndex = name.lastIndexOf(".");
  if (lastDotIndex < 0 || lastDotIndex === name.length - 1) {
    return "";
  }
  return name.slice(lastDotIndex + 1).toLowerCase();
}

function isExcalidrawMarkdownFile(fileName: string): boolean {
  const lowerFileName = fileName.toLowerCase();
  return lowerFileName.includes(".excalidraw") && lowerFileName.endsWith(".md");
}

export function FileList({
  initialPath,
  panelId = "main",
  path,
  initialOpenFilePath,
  initialOpenMode,
  onInitialOpenHandled,
  onPathChange,
  onOpenInAdjacentPane,
  isFocused = false,
  onRequestFocus,
  textFileOpenMode = "web",
  markdownOpenMode = "web",
  defaultTextFileExtension = "txt",
}: FileListProps) {
  // initialPathが未指定の場合はバックエンドから取得した値を使用
  const effectiveInitialPath = initialPath ?? getDefaultBasePath();
  const { showError, showSuccess } = useToast();
  const [currentPath, setCurrentPath] = useState<string | null>(null); // 初期値はnull（検証前）
  const [isPathValidated, setIsPathValidated] = useState(false); // パス検証済みフラグ
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item: FileItem;
    startRename?: boolean;
  } | null>(null);
  const [paneContextMenu, setPaneContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [extFilter, setExtFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [isRegex, setIsRegex] = useState(true); // Default Regex ON
  const [sortKey, setSortKey] = useState<"name" | "size" | "date">("name");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [lastSelectedPath, setLastSelectedPath] = useState<string | null>(null);
  const { history: allHistory, addToHistory, searchHistory: searchHistoryContext, removeFromHistory } = useFolderHistory();
  const [showHistory, setShowHistory] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [navigationHistory, setNavigationHistory] = useState<NavigationHistoryEntry[]>([]);
  const [navigationIndex, setNavigationIndex] = useState(0);
  const [historyFilter, setHistoryFilter] = useState("");
  // ローカルフォーカス行インデックス（各ペインで独立）
  const [focusedIndex, setFocusedIndex] = useState<number>(0);
  // dキーで明示的に集計したフォルダだけを保持する（通常の一覧表示では走査しない）。
  const [folderLatestModified, setFolderLatestModified] = useState<Record<string, string>>({});
  const [folderLatestModifiedLoading, setFolderLatestModifiedLoading] = useState<Set<string>>(new Set());
  const [foldersWithGitChanges, setFoldersWithGitChanges] = useState<Record<string, {
    changedFiles: string[];
    hasMoreChanges: boolean;
    aheadCount: number;
    behindCount: number;
  }>>({});
  const [isGitStatusLoading, setIsGitStatusLoading] = useState(false);
  // フォーカス中のUIセクション
  type FocusSection = 'toolbar' | 'path' | 'filter' | 'history' | 'search' | 'list';
  const [focusedSection, setFocusedSection] = useState<FocusSection>('list');
  // ツールバーボタン内のフォーカスインデックス
  const [toolbarButtonIndex, setToolbarButtonIndex] = useState(0);
  // フィルタバーボタン内のフォーカスインデックス（全10ボタン: 全, F, D, 全, 常用, MD, IPYNB, PDF, Office, 画像, Excali）
  const [filterButtonIndex, setFilterButtonIndex] = useState(0);
  // パスセクション内のフォーカスインデックス（0: 履歴ボタン, 1: コピーボタン, 2: パス入力）
  const [pathButtonIndex, setPathButtonIndex] = useState(0);
  const [historySelectedIndex, setHistorySelectedIndex] = useState(0);
  const historyInputRef = useRef<HTMLInputElement>(null);
  const pathInputRef = useRef<HTMLTextAreaElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // ローカルRefは廃止し、グローバル変数 globalDraggedItems を使用する

  // グローバルショートカット用Ref
  const isFocusedRef = useRef(isFocused);
  const initialPathRef = useRef(effectiveInitialPath);

  // Markdownエディタモーダルの状態
  const [mdEditorOpen, setMdEditorOpen] = useState(false);
  const [mdEditorFileName, setMdEditorFileName] = useState("");
  const [mdEditorFilePath, setMdEditorFilePath] = useState<string | null>(null);
  const [mdEditorSaving, setMdEditorSaving] = useState(false);
  const [mdEditorInitialContent, setMdEditorInitialContent] = useState("");
  const [fileEditorOpen, setFileEditorOpen] = useState(false);
  const [fileEditorFileName, setFileEditorFileName] = useState("");
  const [fileEditorFilePath, setFileEditorFilePath] = useState<string | null>(null);
  const [fileEditorSaving, setFileEditorSaving] = useState(false);
  const [fileEditorInitialContent, setFileEditorInitialContent] = useState("");
  const [fileEditorLanguage, setFileEditorLanguage] = useState<EditorLanguage>("plaintext");
  const [isIndexedSearchOpen, setIsIndexedSearchOpen] = useState(false);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false);
  const [previewImage, setPreviewImage] = useState<FileItem | null>(null);
  const initialOpenHandledRef = useRef<string | null>(null);

  // フォルダ作成モーダルの状態
  const [isCreateFolderModalOpen, setIsCreateFolderModalOpen] = useState(false);
  const [isCreateTextFileModalOpen, setIsCreateTextFileModalOpen] = useState(false);
  const [isCreateMarkdownModalOpen, setIsCreateMarkdownModalOpen] = useState(false);
  const [isHelpModalOpen, setIsHelpModalOpen] = useState(false);

  // 削除確認モーダルの状態
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [itemsToDelete, setItemsToDelete] = useState<Set<string>>(new Set());

  // プログレスモーダルの状態
  const [progressModalOpen, setProgressModalOpen] = useState(false);
  const [progressTaskId, setProgressTaskId] = useState<string | null>(null);
  const [progressOperationType, setProgressOperationType] = useState<'move' | 'copy' | 'delete'>('move');

  // 親ディレクトリに戻った時にフォーカスを当てるべきパス
  const [pendingFocusPath, setPendingFocusPath] = useState<string | null>(null);


  // パスが検証済みの場合のみuseFilesを呼び出す
  const { data, isLoading, error, refetch } = useFiles(isPathValidated && currentPath ? currentPath : "");

  useEffect(() => {
    setFolderLatestModified({});
    setFolderLatestModifiedLoading(new Set());
    setFoldersWithGitChanges({});
    setIsGitStatusLoading(false);
  }, [currentPath]);

  const queryClient = useQueryClient();
  const deleteItemsBatch = useDeleteItemsBatch();
  const createFolder = useCreateFolder();
  const moveItemsBatch = useMoveItemsBatch();
  const copyItemsBatch = useCopyItemsBatch();
  const { addOperation } = useOperationHistoryContext();

  // 再読み込み / 更新 (R)
  const handleRefresh = useCallback(async () => {
    if (!currentPath) return;
    try {
      await queryClient.invalidateQueries({ queryKey: ["files", currentPath] });
      await refetch();
      showSuccess("一覧を更新しました");
    } catch (err) {
      showError(`更新に失敗しました: ${String(err)}`);
    }
  }, [currentPath, queryClient, refetch, showError, showSuccess]);



  // 初期パスの検証
  useEffect(() => {
    const validateInitialPath = async () => {
      const targetPath = path || effectiveInitialPath;
      if (!targetPath) {
        setCurrentPath(effectiveInitialPath);
        setNavigationHistory([{ path: effectiveInitialPath, focusedIndex: 0, selectedItems: [] }]);
        setIsPathValidated(true);
        return;
      }

      try {
        const pathInfo = await getPathInfo(targetPath);

        if (pathInfo.type === "not_found") {
          showError(`指定されたパスが見つかりません: ${targetPath}`);
          // デフォルトパスにフォールバック
          setCurrentPath(effectiveInitialPath);
          setNavigationHistory([{ path: effectiveInitialPath, focusedIndex: 0, selectedItems: [] }]);
        } else if (pathInfo.type === "file" && pathInfo.parent) {
          // ファイルの場合は親フォルダ
          setCurrentPath(pathInfo.parent);
          setNavigationHistory([{ path: pathInfo.parent, focusedIndex: 0, selectedItems: [] }]);
        } else {
          // ディレクトリの場合
          setCurrentPath(targetPath);
          setNavigationHistory([{ path: targetPath, focusedIndex: 0, selectedItems: [] }]);
        }
      } catch (error) {
        console.error("初期パスの検証に失敗しました:", error);
        setCurrentPath(effectiveInitialPath);
        setNavigationHistory([{ path: effectiveInitialPath, focusedIndex: 0, selectedItems: [] }]);
      }
      setIsPathValidated(true);
    };

    validateInitialPath();
  }, []); // 初回のみ実行



  // 外部からのパス変更に同期（パスチェック付き）
  useEffect(() => {
    const syncPath = async () => {
      // パスが変更され、現在のパスと異なる場合は移動
      if (path && path !== currentPath) {
        // navigateToFolderを使うことで履歴（戻るボタン）が正しく機能するようにする
        await navigateToFolder(path);
      }
    };
    syncPath();
  }, [path]);

  // パス変更時の履歴更新
  useEffect(() => {
    if (currentPath) {
      setPathInput(currentPath);
      addToHistory(currentPath);
      // 外部に通知
      onPathChange?.(currentPath);
    }
  }, [currentPath, panelId]);

  useEffect(() => {
    if (!initialOpenFilePath || !isPathValidated || !currentPath) {
      return;
    }
    if (initialOpenHandledRef.current === initialOpenFilePath) {
      return;
    }

    initialOpenHandledRef.current = initialOpenFilePath;
    const fileName = initialOpenFilePath.split(/[/\\]/).pop() || initialOpenFilePath;
    void handleOpenPath(initialOpenFilePath, fileName, {
      forceWebEditor: initialOpenMode === "web",
    }).finally(() => {
      onInitialOpenHandled?.();
    });
  }, [currentPath, initialOpenFilePath, initialOpenMode, isPathValidated, onInitialOpenHandled]);

  // フォーカスが当たった時にコンテナにフォーカスを移動
  useEffect(() => {
    if (isFocused && containerRef.current) {
      if (focusedSection === 'path' && pathButtonIndex === 2) {
        pathInputRef.current?.focus();
      } else if (focusedSection === 'search') {
        searchInputRef.current?.focus();
      } else if (focusedSection === 'history') {
        historyInputRef.current?.focus();
      } else {
        containerRef.current.focus();
      }
    }
  }, [isFocused]);



  // マウスの戻る/進むボタンのハンドリング
  useEffect(() => {
    // 左ペインまたは中央ペインのみ有効
    if (!isFocused || (panelId !== 'left' && panelId !== 'center')) {
      return;
    }

    const handleMouseUp = (e: MouseEvent) => {
      // button: 3 (Back), 4 (Forward)
      if (e.button === 3) {
        e.preventDefault();
        e.stopPropagation();
        goBack();
      } else if (e.button === 4) {
        e.preventDefault();
        e.stopPropagation();
        goForward();
      }
    };

    // ブラウザの戻るを防ぐためにmousedownもフックする（一部ブラウザ用）
    const handleMouseDown = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
      }
    };

    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('mousedown', handleMouseDown);

    return () => {
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('mousedown', handleMouseDown);
    };
  }, [isFocused, panelId, navigationIndex, navigationHistory]); // 依存配列にstateを含めて最新の関数を参照させる

  // フォルダに移動（パスチェック付き）
  const navigateToFolder = async (targetPath: string, fromNavigation = false) => {
    // パスをサニタイズ（引用符除去など）
    const cleanPath = sanitizePath(targetPath);

    // 空のパスはスキップ
    if (!cleanPath) {
      return;
    }

    // 現在のパスと同じ場合はスキップ
    if (cleanPath === currentPath) {
      return;
    }

    try {
      // パスの存在確認と種別チェック
      const pathInfo = await getPathInfo(cleanPath);

      if (pathInfo.type === "not_found") {
        // 存在しないパスの場合、エラーメッセージを表示して履歴から削除
        showError(`指定されたパスが見つかりません: ${cleanPath}\n履歴から削除しました。`);
        removeFromHistory(cleanPath);
        return;
      }

      // ファイルの場合は親フォルダに移動
      const finalPath = pathInfo.type === "file" && pathInfo.parent
        ? pathInfo.parent
        : cleanPath;

      if (!fromNavigation) {
        // ユーザーアクションによる移動の場合、履歴を追加
        // 現在の状態を履歴に保存してから新しいエントリを追加
        setNavigationHistory((prev) => {
          // 現在のエントリの状態を更新
          const updated = prev.map((entry, idx) =>
            idx === navigationIndex
              ? { ...entry, focusedIndex, selectedItems: Array.from(selectedItems) }
              : entry
          );
          // 新しいエントリを追加（履歴の最大サイズを制限: 100件）
          const newEntry: NavigationHistoryEntry = { path: finalPath, focusedIndex: 0, selectedItems: [] };
          const newHistory = [...updated.slice(0, navigationIndex + 1), newEntry];
          return newHistory.slice(-100);
        });
        setNavigationIndex((prev) => Math.min(prev + 1, 99));
      }
      setCurrentPath(finalPath);
      setSelectedItems(new Set());
      setFocusedIndex(0);
      setSearchQuery("");
    } catch (error) {
      console.error("パス情報の取得に失敗しました:", error);
      showError("パス情報の取得に失敗しました");
    }
  };

  // Refを最新の状態に保つ
  useEffect(() => {
    isFocusedRef.current = isFocused;
    initialPathRef.current = effectiveInitialPath;
  }, [isFocused, effectiveInitialPath]);

  // グローバルショートカット (Ctrl+H: ホームへ)
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // フォーカスがない場合は何もしない (Refで最新状態を確認)
      if (!isFocusedRef.current) return;

      if (isEditableEventTarget(e.target)) {
        return;
      }

      if (matchesCmdOrCtrlShortcut(e, "p") && (panelId === "left" || panelId === "center")) {
        e.preventDefault();
        e.stopPropagation();
        setIsIndexedSearchOpen(true);
        return;
      }

      if ((matchesCmdOrCtrlShortcut(e, "f") || matchesPlainShortcut(e, "/")) && (panelId === "left" || panelId === "center")) {
        e.preventDefault();
        e.stopPropagation();
        setFocusedSection("search");
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if (matchesCmdOrCtrlShortcut(e, "r") && (panelId === "left" || panelId === "center")) {
        e.preventDefault();
        e.stopPropagation();
        setIsHistoryModalOpen(true);
        return;
      }

      if (matchesPlainShortcut(e, "a") && (panelId === "left" || panelId === "center")) {
        e.preventDefault();
        e.stopPropagation();
        setIsCreateFolderModalOpen(true);
        return;
      }

      if (matchesPlainShortcut(e, "t") && (panelId === "left" || panelId === "center")) {
        e.preventDefault();
        e.stopPropagation();
        setIsCreateTextFileModalOpen(true);
        return;
      }

      if (matchesPlainShortcut(e, "o") && (panelId === "left" || panelId === "center")) {
        e.preventDefault();
        e.stopPropagation();
        if (!currentPath) return;
        openInExplorer(currentPath)
          .then(() => showSuccess("フォルダを開きました"))
          .catch((error: Error) => showError(`フォルダを開けませんでした: ${error.message}`));
        return;
      }

      if (matchesPlainShortcut(e, "r") && (panelId === "left" || panelId === "center")) {
        e.preventDefault();
        e.stopPropagation();
        void handleRefresh();
        return;
      }

      if (matchesPlainShortcut(e, "h")) {
        e.preventDefault();
        e.stopPropagation();
        setIsHelpModalOpen(true);
        return;
      }

      if (
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        e.key.toLowerCase() === "l" &&
        (panelId === "left" || panelId === "center")
      ) {
        e.preventDefault();
        e.stopPropagation();
        const currentFilterIndex = EXT_FILTERS.findIndex((filter) => filter.id === extFilter);
        const nextFilterIndex = e.shiftKey
          ? (currentFilterIndex - 1 + EXT_FILTERS.length) % EXT_FILTERS.length
          : (currentFilterIndex + 1) % EXT_FILTERS.length;
        setExtFilter(EXT_FILTERS[nextFilterIndex].id);
        setFilterButtonIndex(3 + nextFilterIndex);
        return;
      }

      if (matchesCmdOrCtrlShortcut(e, "h")) {
        e.preventDefault();
        e.stopPropagation();

        const targetPath = initialPathRef.current;
        navigateToFolder(targetPath);
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown, true);
    };
  }, [currentPath, extFilter, handleRefresh, navigateToFolder, panelId, setIsCreateFolderModalOpen, setIsCreateTextFileModalOpen, showError, showSuccess]);

  // 戻る
  const goBack = () => {
    if (navigationIndex > 0) {
      // 現在の状態を履歴に保存
      setNavigationHistory((prev) =>
        prev.map((entry, idx) =>
          idx === navigationIndex
            ? { ...entry, focusedIndex, selectedItems: Array.from(selectedItems) }
            : entry
        )
      );
      const newIndex = navigationIndex - 1;
      const targetEntry = navigationHistory[newIndex];
      setNavigationIndex(newIndex);
      setCurrentPath(targetEntry.path);
      setSelectedItems(new Set(targetEntry.selectedItems));
      setFocusedIndex(targetEntry.focusedIndex);
      setSearchQuery("");
    }
  };

  // 進む
  const goForward = () => {
    if (navigationIndex < navigationHistory.length - 1) {
      // 現在の状態を履歴に保存
      setNavigationHistory((prev) =>
        prev.map((entry, idx) =>
          idx === navigationIndex
            ? { ...entry, focusedIndex, selectedItems: Array.from(selectedItems) }
            : entry
        )
      );
      const newIndex = navigationIndex + 1;
      const targetEntry = navigationHistory[newIndex];
      setNavigationIndex(newIndex);
      setCurrentPath(targetEntry.path);
      setSelectedItems(new Set(targetEntry.selectedItems));
      setFocusedIndex(targetEntry.focusedIndex);
      setSearchQuery("");
    }
  };

  // 上の階層に移動
  // 上の階層に移動
  const navigateUp = () => {
    if (!currentPath) return;

    // 現在のパスを保存して、移動後にフォーカスを当てる
    setPendingFocusPath(currentPath);

    // Windowsパス対策：sanitizePathで正規化してから分割
    const cleanPath = sanitizePath(currentPath);
    const isUnc = cleanPath.startsWith("//");

    const parts = cleanPath.split("/").filter(Boolean);
    parts.pop();

    let newPath = "/" + parts.join("/");
    // UNCパスの場合、先頭にスラッシュを追加して //server/share の形に戻す
    if (isUnc) {
      newPath = "/" + newPath;
    }

    navigateToFolder(newPath);
  };

  // 右クリックメニュー
  const handleContextMenu = (e: React.MouseEvent, item: FileItem) => {
    e.preventDefault();
    e.stopPropagation();
    setPaneContextMenu(null);
    setContextMenu({ x: e.clientX, y: e.clientY, item });
  };

  const handlePaneContextMenu = (e: React.MouseEvent<HTMLElement>) => {
    // tbody内のtr（ファイル・フォルダ行）を右クリックした場合はそちらのコンテキストメニューに任せる
    if (!shouldShowPaneContextMenu(e.target as HTMLElement)) {
      return;
    }
    e.preventDefault();
    setContextMenu(null);
    setPaneContextMenu({ x: e.clientX, y: e.clientY });
  };

  const copyVisibleItemsAsChecklist = async () => {
    const markdown = formatItemsAsMarkdownChecklist([...folders, ...files]);
    if (!markdown) {
      showError("コピーできる項目がありません");
      setPaneContextMenu(null);
      return;
    }

    try {
      await navigator.clipboard.writeText(markdown);
      showSuccess("一覧をチェックボックス形式でコピーしました");
    } catch {
      showError("一覧のコピーに失敗しました");
    }
    setPaneContextMenu(null);
  };

  const copyVisibleItemsAsBulletList = async () => {
    const markdown = formatItemsAsMarkdownBulletList([...folders, ...files]);
    if (!markdown) {
      showError("コピーできる項目がありません");
      setPaneContextMenu(null);
      return;
    }

    try {
      await navigator.clipboard.writeText(markdown);
      showSuccess("一覧を箇条書き形式でコピーしました");
    } catch {
      showError("一覧のコピーに失敗しました");
    }
    setPaneContextMenu(null);
  };

  // フルパスをコピー
  const copyFullPath = async (item: FileItem) => {
    try {
      // item.pathは既に絶対パス
      const fullPath = item.path || currentPath || "";
      await navigator.clipboard.writeText(formatPathForClipboard(fullPath));
      showSuccess("パスをコピーしました");
      setContextMenu(null);
    } catch {
      showError("コピーに失敗しました");
    }
  };

  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 選択項目を削除（確認モーダルを表示）
  const handleDeleteSelected = () => {
    if (selectedItems.size === 0) return;
    setItemsToDelete(new Set(selectedItems));
    setIsDeleteModalOpen(true);
  };

  // メニューからの削除リクエスト
  const handleRequestDeleteFromMenu = (item: FileItem) => {
    setItemsToDelete(new Set([item.path]));
    setIsDeleteModalOpen(true);
  };

  // 削除の実行
  const handleConfirmDelete = async () => {
    if (itemsToDelete.size === 0) return;

    const debugMode = localStorage.getItem('file_manager_debug_mode') === 'true';
    const paths = Array.from(itemsToDelete);

    try {
      // 選択されたアイテムの中にディレクトリが含まれているかチェック
      const hasDirectory = paths.some(path => {
        const item = allSortedItems.find(i => i.path === path);
        return item && item.type === 'directory';
      });

      // 非同期モード判定: 3ファイル以上 または ディレクトリを含む
      const useAsyncMode = paths.length >= 3 || hasDirectory;

      try {
        const result = await deleteItemsBatch.mutateAsync({
          paths,
          asyncMode: useAsyncMode,
          debugMode
        });

        if (useAsyncMode) {
          // 非同期モード: プログレスモーダルを表示
          if (result.status === 'async' && result.task_id) {
            setProgressOperationType('delete');
            setProgressTaskId(result.task_id);
            setProgressModalOpen(true);
            setSelectedItems(new Set());
            setItemsToDelete(new Set()); // Clear itemsToDelete after starting async operation
            setIsDeleteModalOpen(false); // Close modal

            // フォーカス復帰
            onRequestFocus?.();
            setTimeout(() => {
              containerRef.current?.focus();
            }, 50);
          }
        } else {
          // 同期モード
          if (result.status === 'completed' && result.success_count !== undefined) {
            if (result.success_count > 0) {
              const count = result.success_count;
              showSuccess(`${count}件削除しました`);

              // 履歴に追加
              addOperation({
                type: "DELETE",
                canUndo: false,
                timestamp: Date.now(),
                data: {},
              });

              setSelectedItems(new Set());
              setItemsToDelete(new Set()); // Clear itemsToDelete after completion
              setIsDeleteModalOpen(false); // Close modal

              // フォーカス復帰
              onRequestFocus?.();
              setTimeout(() => {
                containerRef.current?.focus();
              }, 50);
            }
            if (result.fail_count && result.fail_count > 0) {
              showError(`${result.fail_count}件の削除に失敗しました`);
            }
            // ファイル一覧を更新
            queryClient.invalidateQueries({ queryKey: ["files"] });
          }
        }
      } catch (err: any) {
        // ロック検知時のプロセス終了ダイアログ
        if (err.lockedBy && Array.isArray(err.lockedBy) && err.lockedBy.length > 0) {
          const processInfo = err.lockedBy.map((p: any) => `・${p.name} (PID: ${p.pid})`).join("\n");
          const pids = err.lockedBy.map((p: any) => p.pid);
          if (window.confirm(`ファイルが以下のプロセスによって使用されているため、削除できません。\n\n${processInfo}\n\nプロセスを強制終了(Kill)して削除を再試行しますか？\n(※未保存のデータが失われる可能性があります)`)) {
            try {
              const retryResult = await deleteItemsBatch.mutateAsync({
                paths,
                asyncMode: useAsyncMode,
                debugMode,
                forceKillPids: pids
              });
              
              showSuccess("プロセスを強制終了し、削除を再試行しました。");
              if (!useAsyncMode && retryResult.status === 'completed') {
                queryClient.invalidateQueries({ queryKey: ["files"] });
              }
              setSelectedItems(new Set());
              setItemsToDelete(new Set());
              setIsDeleteModalOpen(false);
              onRequestFocus?.();
              setTimeout(() => { containerRef.current?.focus(); }, 50);
            } catch (retryErr: any) {
              console.error("Retry delete failed:", retryErr);
              showError(`プロセスの強制終了または削除に失敗しました: ${retryErr.message}`);
            }
            return;
          }
        }
        
        console.error("Delete failed:", err);
        showError(`削除に失敗しました: ${err.message}`);
      }
    } catch (err: any) {
      console.error("Failed to execute delete process:", err);
      showError(`処理中にエラーが発生しました: ${err.message}`);
    }
  };

  // フォルダ作成
  const handleCreateFolder = () => {
    setIsCreateFolderModalOpen(true);
  };

  const handleConfirmCreateFolder = async (name: string) => {
    const parentPath = currentPath || "";
    try {
      await createFolder.mutateAsync({ parentPath, name });
      showSuccess(`フォルダ作成: ${name}`);

      // 履歴に追加
      addOperation({
        type: "CREATE_FOLDER",
        canUndo: true,
        timestamp: Date.now(),
        data: {
          createdPath: `${parentPath}/${name}`,
        },
      });

      // 作成したペインをアクティブにする
      onRequestFocus?.();

      // モーダルが閉じた後に確実にフォーカスを当てる
      setTimeout(() => {
        containerRef.current?.focus();
      }, 50);
    } catch (e: any) {
      console.error("Folder creation failed:", e);
      showError(`フォルダ作成に失敗しました: ${e.message}`);
      throw e; // Keep modal open
    }
  };

  // テキストファイル作成
  const handleConfirmCreateTextFile = async (name: string, extension: string) => {
    if (!name || !name.trim()) return;

    if (!currentPath) {
      showError("作成先フォルダが特定できません");
      return;
    }

    const filename = buildTextFileName(name, extension);

    try {
      const result = await createFile(currentPath, filename, "");
      showSuccess(`テキストファイル作成: ${filename}`);

      addOperation({
        type: "CREATE_FILE",
        canUndo: true,
        timestamp: Date.now(),
        data: {
          createdPath: result.path,
          content: "",
        },
      });

      refetch();
      onRequestFocus?.();
      setTimeout(() => {
        containerRef.current?.focus();
      }, 50);
    } catch (e: any) {
      console.error("Text file creation failed:", e);
      showError(`テキストファイル作成に失敗しました: ${e.message}`);
      throw e;
    }
  };

  // クリップボードからパスを開く
  const openFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        const cleanPath = sanitizePath(text);
        if (cleanPath) {
          navigateToFolder(cleanPath);
        }
      }
    } catch {
      showError("クリップボードの読み取りに失敗しました");
    }
  };

  // フルパスをコピー
  const copyCurrentPath = async () => {
    if (!currentPath) return;
    try {
      await navigator.clipboard.writeText(formatPathForClipboard(currentPath || "/"));
      showSuccess("パスをコピーしました");
    } catch {
      showError("コピーに失敗しました");
    }
  };

  // リンクをコピー
  const copyLinkToClipboard = async (
    path: string,
    itemType: "file" | "directory" = "directory",
  ) => {
    if (!path) return;
    const url = itemType === "directory"
      ? buildAppPathUrl(path)
      : buildFullPathUrl(path, {
          textFileOpenMode,
          markdownOpenMode,
        });
    try {
      await navigator.clipboard.writeText(url);
      showSuccess("リンクをコピーしました");
    } catch {
      showError("コピーに失敗しました");
    }
  };

  // リンクを開く（ブラウザで開く）
  const openLink = (
    path: string,
    itemType: "file" | "directory" = "directory",
  ) => {
    if (!path) return;
    const url = itemType === "directory"
      ? buildAppPathUrl(path)
      : buildFullPathUrl(path, {
          textFileOpenMode,
          markdownOpenMode,
        });
    window.open(url, "_blank");
  };

  const openMarkdownInExternalApp = async (path: string) => {
    if (path.toLowerCase().includes("obsidian")) {
      await openInObsidian(path);
      showSuccess("Obsidianを開きました");
      return;
    }

    await openInVSCode(path);
    showSuccess("VS Codeで開きました");
  };

  // パス入力の確定
  const handlePathSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const cleanPath = sanitizePath(pathInput);

    // 空のパスはスキップ
    if (!cleanPath) {
      return;
    }

    try {
      // パスの存在確認
      const pathInfo = await getPathInfo(cleanPath);

      if (pathInfo.type === "not_found") {
        // 存在しないパスの場合、エラーメッセージを表示して元のパスに戻す
        showError(`指定されたパスが見つかりません: ${cleanPath}\n\n元のパスに戻ります。`);
        setPathInput(currentPath || ""); // 入力フィールドを元に戻す
        return;
      }

      if (pathInfo.type === "file" && pathInfo.parent) {
        // ファイルの場合、親フォルダに移動
        onRequestFocus?.();
        navigateToFolder(pathInfo.parent);
        return;
      }

      // ディレクトリの場合、そのまま移動
      onRequestFocus?.();
      navigateToFolder(cleanPath);

      // 現在のパスと同じ場合でも履歴を更新動かしたい（一番上に持ってくる）
      addToHistory(cleanPath);
    } catch (error) {
      console.error("パス情報の取得に失敗しました:", error);
      showError(`パスの確認に失敗しました。\n\n元のパスに戻ります。`);
      setPathInput(currentPath || "");
    }
  };

  // ダウンロード
  const handleDownload = async () => {
    if (selectedItems.size === 0) {
      showError("ファイルを選択してください");
      return;
    }

    for (const path of selectedItems) {
      const item = allSortedItems.find(i => i.path === path);
      if (item && item.type === 'directory') {
        showError(`フォルダのダウンロードはサポートされていません: ${item.name}`);
        continue;
      }

      // ローカルAPI経由でダウンロード
      const url = getDownloadUrl(path);
      const link = document.createElement('a');
      link.href = url;
      link.download = ''; // ファイル名はサーバーレスポンスに従う
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      await new Promise(resolve => setTimeout(resolve, 500));
    }
  };

  // VSCodeで開く
  const handleOpenVSCode = async () => {
    // 選択状態に関わらず、常にカレントディレクトリを開く
    const targetPath = currentPath;

    if (!targetPath) {
      showError("開く対象がありません");
      return;
    }

    try {
      await openInVSCode(targetPath);
      // VSCodeを開くのは「成功」メッセージを出さない方が一般的かもしれないが、
      // 既存の挙動に合わせておく（ただし複数件数表示はなくなる）
      // showSuccess("VSCodeを開きました");
    } catch (e: any) {
      console.error(`Error opening in VSCode: ${targetPath}`, e);
      showError(`VSCode起動エラー: ${e.message}`);
    }
  };

  const handleOpenProgramCodeInVSCode = async (item: FileItem) => {
    try {
      await openInVSCode(item.path);
      setContextMenu(null);
    } catch (e: any) {
      console.error(`Error opening program code in VSCode: ${item.path}`, e);
      showError(`コード起動エラー: ${e.message}`);
    }
  };

  const handleOpenProgramCodeInEditor = async (item: FileItem) => {
    try {
      await openInEditor(item.path);
      setContextMenu(null);
    } catch (e: any) {
      console.error(`Error opening program code in editor: ${item.path}`, e);
      showError(`エディター起動エラー: ${e.message}`);
    }
  };

  const handleExecuteProgramCode = async (item: FileItem) => {
    try {
      await executeProgramCode(item.path);
      showSuccess(`実行を開始しました: ${item.name}`);
      setContextMenu(null);
    } catch (e: any) {
      console.error(`Error executing program code: ${item.path}`, e);
      showError(`実行エラー: ${e.message}`);
    }
  };

  const handleOpenHtmlPreview = (item: FileItem) => {
    window.open(getHtmlViewUrl(item.path), "_blank", "noopener,noreferrer");
    setContextMenu(null);
  };

  // エクスプローラー/Finderで開く
  const handleOpenExplorer = async () => {
    // 選択状態に関わらず、常にカレントディレクトリを開く
    const targetPath = currentPath;

    if (!targetPath) {
      return;
    }

    try {
      await openInExplorer(targetPath);
      showSuccess("フォルダを開きました");
    } catch (e: any) {
      console.error("Failed to open explorer:", e);
      showError(`フォルダを開けませんでした: ${e.message}`);
    }
  };

  // 全文検索を開く
  const handleOpenFullTextSearch = () => {
    if (!currentPath) {
      showError("開く対象がありません");
      return;
    }

    window.open(getFullTextSearchUrl(currentPath), "_blank", "noopener,noreferrer");
  };

  // Jupyterを開く
  const handleOpenJupyter = async () => {
    // 選択状態に関わらず、常にカレントディレクトリを開く
    const targetPath = currentPath;

    if (!targetPath) return;

    try {
      await openInJupyter(targetPath);
      showSuccess("Jupyterを開きました");
    } catch (e: any) {
      console.error("Failed to open jupyter:", e);
      showError(`Jupyterを開けませんでした: ${e.message}`);
    }
  };

  // Excalidrawを開く (新規作成して開く)
  const handleOpenExcalidraw = async () => {
    // ファイル名入力プロンプト
    const name = prompt("ファイル名を入力してください");
    if (!name || !name.trim()) return;

    if (!currentPath) {
      showError("作成先フォルダが特定できません");
      return;
    }

    // 拡張子の決定
    // パスに 'obsidian' が含まれる場合は .excalidraw.md、それ以外は .excalidraw
    const isObsidian = currentPath.toLowerCase().includes('obsidian');
    const targetExtension = isObsidian ? '.excalidraw.md' : '.excalidraw';

    // 拡張子が既に入力されているかチェックし、なければ付与
    let filename = name.trim();
    if (!filename.endsWith(targetExtension)) {
      // 重複拡張子回避（.excalidrawと入力されたがObsidian環境の場合など）
      // シンプルに、末尾が想定拡張子でないなら追加する
      // .excalidraw.md の場合、.excalidrawだけついてても.mdを追加したい
      if (isObsidian && filename.endsWith('.excalidraw')) {
        filename += '.md';
      } else { // どちらの拡張子にも一致しない場合、targetExtensionを追加
        filename += targetExtension;
      }
    }

    try {
      // ファイル作成
      const cleanName = filename; // 階層トラバーサルチェックはバックエンドでやるが、念のため
      const result = await createFile(currentPath, cleanName, ""); // 空ファイル作成

      showSuccess(`ファイルを作成しました: ${cleanName}`);

      // 履歴に追加
      addOperation({
        type: "CREATE_FILE",
        canUndo: true,
        timestamp: Date.now(),
        data: {
          createdPath: result.path,
          content: "",
        },
      });

      // 作成したファイルを開く
      await openInExcalidraw(result.path);
      showSuccess("Excalidrawを開きました");

      // リスト更新
      refetch();

      // エディタが開くが、戻ってきたときのためにフォーカスを設定しておく
      onRequestFocus?.();
      setTimeout(() => {
        containerRef.current?.focus();
      }, 50);

    } catch (e: any) {
      console.error("Failed to open excalidraw:", e);
      showError(`処理に失敗しました: ${e.message}`);
    }
  };

  // Antigravityで開く
  const handleOpenAntigravity = async () => {
    // 選択状態に関わらず、常にカレントディレクトリを開く
    const targetPath = currentPath;

    if (!targetPath) {
      showError("開く対象がありません");
      return;
    }

    try {
      await openInAntigravity(targetPath);
      showSuccess("Antigravityを開きました");
    } catch (e: any) {
      console.error(`Error opening in Antigravity: ${targetPath}`, e);
      showError(`Antigravity起動エラー: ${e.message}`);
    }
  };

  // Markdown作成を開く
  const handleOpenMarkdown = () => {
    setIsCreateMarkdownModalOpen(true);
  };

  const handleConfirmCreateMarkdown = (name: string) => {
    if (!name || !name.trim()) return;

    if (!currentPath) {
      showError("作成先フォルダが特定できません");
      return;
    }

    // 拡張子の決定
    let filename = name.trim();
    if (!filename.endsWith('.md')) {
      filename += '.md';
    }

    setMdEditorFileName(filename);
    setMdEditorFilePath(null); // 新規作成なのでpathはまだない
    setMdEditorInitialContent(""); // 新規作成なので空
    setMdEditorOpen(true);
  };

  // Markdown保存
  const handleSaveMarkdown = async (content: string) => {
    if (!currentPath) return;

    setMdEditorSaving(true);
    try {
      if (mdEditorFilePath) {
        // 既存ファイルの更新
        await updateFile(mdEditorFilePath, content);
        showSuccess(`更新しました: ${mdEditorFileName}`);

        // 履歴に追加（戻れない操作として記録）
        addOperation({
          type: "UPDATE_FILE",
          canUndo: false,
          timestamp: Date.now(),
          data: {},
        });
      } else {
        // 新規ファイル作成
        const result = await createFile(currentPath, mdEditorFileName, content);
        setMdEditorFilePath(result.path);
        showSuccess(`作成しました: ${mdEditorFileName}`);

        // 履歴に追加
        addOperation({
          type: "CREATE_FILE",
          canUndo: true,
          timestamp: Date.now(),
          data: {
            createdPath: result.path,
            content,
          },
        });
      }
      refetch();
      setMdEditorOpen(false);

      // フォーカス復帰
      onRequestFocus?.();
      setTimeout(() => {
        containerRef.current?.focus();
      }, 50);
    } catch (e: any) {
      showError(`保存に失敗しました: ${e.message}`);
    } finally {
      setMdEditorSaving(false);
    }
  };

  // Markdownエディタを閉じる
  const handleCloseMdEditor = () => {
    setMdEditorOpen(false);
    setMdEditorFileName("");
    setMdEditorFilePath(null);
    // モーダル内の入力欄から、開く前にアクティブだったペインへキーボード操作を戻す。
    onRequestFocus?.();
    window.setTimeout(() => {
      containerRef.current?.focus();
    }, 50);
  };

  const handleSaveFileEditor = async (content: string) => {
    if (!fileEditorFilePath) return;

    setFileEditorSaving(true);
    try {
      await updateFile(fileEditorFilePath, content);
      showSuccess(`更新しました: ${fileEditorFileName}`);

      addOperation({
        type: "UPDATE_FILE",
        canUndo: false,
        timestamp: Date.now(),
        data: {},
      });

      refetch();
      setFileEditorOpen(false);
      onRequestFocus?.();
      setTimeout(() => {
        containerRef.current?.focus();
      }, 50);
    } catch (e: any) {
      showError(`保存に失敗しました: ${e.message}`);
    } finally {
      setFileEditorSaving(false);
    }
  };

  const handleCloseFileEditor = () => {
    setFileEditorOpen(false);
    setFileEditorFileName("");
    setFileEditorFilePath(null);
    // モーダル内の入力欄から、開く前にアクティブだったペインへキーボード操作を戻す。
    onRequestFocus?.();
    window.setTimeout(() => {
      containerRef.current?.focus();
    }, 50);
  };

  const handleCloseIndexedSearch = () => {
    setIsIndexedSearchOpen(false);
    onRequestFocus?.();
    setTimeout(() => {
      containerRef.current?.focus();
    }, 50);
  };

  // Obsidianで開く
  const handleOpenObsidian = async () => {
    // 選択状態に関わらず、常にカレントディレクトリを開く
    const targetPath = currentPath;

    if (!targetPath) {
      showError("開く対象がありません");
      return;
    }

    try {
      await openInObsidian(targetPath);
      showSuccess("Obsidianを開きました");
    } catch (e: any) {
      console.error(`Error opening in Obsidian: ${targetPath}`, e);
      showError(`Obsidian起動エラー: ${e.message}`);
    }
  };

  /**
   * Obsidianの今日のフォルダを開く
   */
  const handleOpenObsidianDaily = async () => {
    try {
      const result = await getObsidianDailyPath();
      if (result.path) {
        await navigateToFolder(result.path);
        // 作成されたペインをアクティブにする
        onRequestFocus?.();
      }
    } catch (e: any) {
      console.error("Failed to get obsidian daily path:", e);
      showError(`Obsidianの今日のフォルダを取得できませんでした: ${e.message}`);
    }
  };

  // 履歴フィルタリングとキーボード操作
  useEffect(() => {
    if (showHistory) {
      // setHistoryFilter(""); // 入力直後に消えてしまうため削除
      setHistorySelectedIndex(0);
      // ドロップダウンが表示されたらフィルタ入力にフォーカス
      // requestAnimationFrameを使用して確実にDOMが更新された後にフォーカスを当てる
      requestAnimationFrame(() => {
        historyInputRef.current?.focus();
      });
    }
  }, [showHistory]);

  const filteredHistory = useMemo(() => {
    const items = historyFilter
      ? searchHistoryContext(historyFilter)
      : allHistory;

    // 回数順（降順） > 最新順（降順）
    return [...items].sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return b.timestamp - a.timestamp;
    });
  }, [allHistory, historyFilter, searchHistoryContext]);

  const handleHistoryKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      setHistorySelectedIndex(prev => {
        const newIndex = Math.min(prev + 1, filteredHistory.length - 1);
        // 選択されたアイテムをスクロールして表示
        requestAnimationFrame(() => {
          const item = containerRef.current?.querySelector(`.history-item[data-index="${newIndex}"]`);
          item?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
        return newIndex;
      });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      setHistorySelectedIndex(prev => {
        const newIndex = Math.max(prev - 1, 0);
        // 選択されたアイテムをスクロールして表示
        requestAnimationFrame(() => {
          const item = containerRef.current?.querySelector(`.history-item[data-index="${newIndex}"]`);
          item?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
        return newIndex;
      });
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (filteredHistory[historySelectedIndex]) {
        onRequestFocus?.();
        navigateToFolder(filteredHistory[historySelectedIndex].path);
        setShowHistory(false);
        // フォーカスをリストに戻す
        containerRef.current?.focus();
        setFocusedSection('list');
        setFocusedIndex(0);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setShowHistory(false);
    }
  };

  const compiledSearchRegex = useMemo(() => {
    if (!searchQuery || !isRegex) return null;
    try {
      return new RegExp(searchQuery, "i");
    } catch {
      return null;
    }
  }, [searchQuery, isRegex]);

  const normalizedSearchQuery = useMemo(() => searchQuery.toLowerCase(), [searchQuery]);
  const allowedExtensions = useMemo(() => (
    extFilter === "all" ? null : new Set(extFilter.split("+").filter(Boolean))
  ), [extFilter]);

  // フィルタリング・分離・ソートを単一パスで実行
  const { folders, files } = useMemo(() => {
    const sourceItems = data?.items || [];
    const nextFolders: FileItem[] = [];
    const nextFiles: FileItem[] = [];

    for (const item of sourceItems) {
      if (searchQuery) {
        const matches = compiledSearchRegex
          ? compiledSearchRegex.test(item.name)
          : item.name.toLowerCase().includes(normalizedSearchQuery);
        if (!matches) {
          continue;
        }
      }

      if (typeFilter === "folders" && item.type !== "directory") continue;
      if (typeFilter === "files" && item.type !== "file") continue;

      if (allowedExtensions && item.type === "file") {
        const ext = getFileExtension(item.name);
        if (!allowedExtensions.has(ext)) {
          continue;
        }
      }

      if (item.type === "directory") {
        nextFolders.push(item);
      } else {
        nextFiles.push(item);
      }
    }

    const sortItems = (items: FileItem[]) => {
      if (sortKey === "name") {
        items.sort((a, b) => {
          const res = a.name.localeCompare(b.name);
          return sortOrder === "asc" ? res : -res;
        });
        return;
      }

      const decorated = items.map((item) => ({
        item,
        sortValue: sortKey === "size"
          ? (item.size || 0)
          : (folderLatestModified[item.path] ?? item.modified
            ? Date.parse(folderLatestModified[item.path] ?? item.modified!) || 0
            : 0),
      }));

      decorated.sort((a, b) => {
        const res = a.sortValue - b.sortValue;
        return sortOrder === "asc" ? res : -res;
      });

      items.splice(0, items.length, ...decorated.map(({ item }) => item));
    };

    sortItems(nextFolders);
    sortItems(nextFiles);

    return { folders: nextFolders, files: nextFiles };
  }, [data?.items, searchQuery, compiledSearchRegex, normalizedSearchQuery, typeFilter, allowedExtensions, sortKey, sortOrder, folderLatestModified]);

  // 全アイテム（フィルタとソート適用後）をメモ化
  const allSortedItems = useMemo(() => [...folders, ...files], [folders, files]);

  // 親ディレクトリに戻った時のフォーカス復元
  useEffect(() => {
    if (pendingFocusPath && !isLoading && allSortedItems.length > 0) {
      const index = allSortedItems.findIndex(item => item.path === pendingFocusPath);
      if (index !== -1) {
        setFocusedIndex(index);
        // フォーカスしたアイテムをスクロールして表示
        requestAnimationFrame(() => {
          const row = containerRef.current?.querySelector(`.file-table tbody tr[data-index="${index}"]`);
          row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
        setPendingFocusPath(null); // フォーカス設定したらクリア
      }
    }
  }, [pendingFocusPath, isLoading, allSortedItems]);

  // 検索クエリ入力時に先頭ヒットへフォーカス・選択を合わせる
  useEffect(() => {
    if (searchQuery.trim() && allSortedItems.length > 0) {
      setFocusedIndex(0);
      const firstItem = allSortedItems[0];
      if (firstItem) {
        setSelectedItems(new Set([firstItem.path]));
        setLastSelectedPath(firstItem.path);
      }
      requestAnimationFrame(() => {
        const row = containerRef.current?.querySelector(`.file-table tbody tr[data-index="0"]`);
        row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }
  }, [searchQuery]);

  // ドラッグ開始
  const handleDragStart = (e: React.DragEvent, item: FileItem) => {
    // 複数選択されている場合、選択されたアイテム全てのリストを作成
    let dragData: FileItem[] = [];

    // 現在表示されている全アイテム（フィルタ適用後）
    const allVisibleItems = [...folders, ...files];

    if (selectedItems.has(item.path)) {
      // ドラッグしたアイテムが選択状態なら、選択済み全アイテムを対象にする
      dragData = allVisibleItems.filter(i => selectedItems.has(i.path));

      // 万が一漏れていた場合のマージ
      if (!dragData.find(d => d.path === item.path)) {
        dragData.push(item);
      }
    } else {
      // 選択されていないアイテムをドラッグした場合、その一つだけを対象にする
      dragData = [item];
    }


    // グローバル変数に保存
    globalDraggedItems = dragData;
    globalDragSourcePanelId = panelId; // ドラッグ元のペインIDを保存
    console.log(`DragStart: Selected=${selectedItems.size}, Prepared Items=${dragData.length}, SourcePanel=${panelId}`);

    // dataTransferにもセット（互換性のため）
    e.dataTransfer.setData("text/plain", JSON.stringify(dragData));
    e.dataTransfer.effectAllowed = "copyMove";
  };

  // ドラッグオーバー
  const handleDragOver = (e: React.DragEvent, targetPath: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverPath(targetPath);
  };

  // ドラッグ終了
  const handleDragLeave = () => {
    setDragOverPath(null);
  };

  // ドロップ
  const handleDrop = async (e: React.DragEvent, targetPath: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverPath(null);

    // OSからのファイル・フォルダドロップ（アップロード）
    const isOsDrop = globalDraggedItems.length === 0 && (
      (e.dataTransfer.files && e.dataTransfer.files.length > 0) ||
      (e.dataTransfer.items && Array.from(e.dataTransfer.items).some((item) => item.kind === "file"))
    );

    if (isOsDrop) {
      try {
        const { files, emptyDirectories } = await scanDataTransferItems(e.dataTransfer);
        const totalItems = files.length + emptyDirectories.length;

        if (totalItems === 0) {
          // 何も取得できなかった場合は従来のファイル一覧フォールバック
          if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const fallbackFiles = Array.from(e.dataTransfer.files);
            showSuccess(`アップロード開始: ${fallbackFiles.length}件`);
            const result = await uploadFiles(targetPath, fallbackFiles);
            if (result.status === "success" || result.status === "partial_success") {
              showSuccess(result.message);
              queryClient.invalidateQueries({ queryKey: ["files"] });
            } else {
              showError(result.message || "アップロードに失敗しました");
            }
          }
          return;
        }

        const msgDetails = [
          files.length > 0 ? `${files.length}件のファイル` : "",
          emptyDirectories.length > 0 ? `${emptyDirectories.length}件のフォルダ` : "",
        ].filter(Boolean).join("、");

        showSuccess(`アップロード開始: ${msgDetails}`);

        const result = await uploadFiles(targetPath, files, emptyDirectories);
        if (result.status === "success" || result.status === "partial_success") {
          showSuccess(result.message);
          queryClient.invalidateQueries({ queryKey: ["files"] });
        } else {
          showError(result.message || "アップロードに失敗しました");
        }
      } catch (err) {
        showError(`アップロードエラー: ${String(err)}`);
      }
      return;
    }


    setDragOverPath(null);

    // グローバル変数から取得
    let items: FileItem[] = globalDraggedItems;

    // グローバル変数が空ならdataTransferから取得（外部からのドラッグ等の可能性用）
    if (items.length === 0) {
      const data = e.dataTransfer.getData("text/plain");
      if (data) {
        try {
          // 配列形式か単体形式かを判別してパース
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed)) {
            items = parsed;
          } else {
            items = [parsed];
          }
        } catch {
          console.error("Invalid drag data json");
        }
      }
    }

    if (items.length > 0) {
      console.log(`Drop: Processing ${items.length} items`);

      const srcPaths = items
        .filter(item => item.path !== targetPath)
        .map(item => item.path);

      if (srcPaths.length > 0) {
        // 同一ペイン内での移動かチェック（誤操作防止）
        if (globalDragSourcePanelId && globalDragSourcePanelId === panelId) {
          if (!confirm("同じペイン内での移動です。よろしいですか？")) {
            // キャンセルされた場合
            globalDraggedItems = [];
            globalDragSourcePanelId = null;
            return;
          }
        }

        // 設定を読み込み
        const verifyChecksum = localStorage.getItem('file_manager_verify_checksum') === 'true';
        const debugMode = localStorage.getItem('file_manager_debug_mode') === 'true';

        // クライアントサイドでの再帰カウント（countFiles）はNAS等で遅いため廃止
        // シンプルに「3つ以上のアイテム」または「フォルダが含まれる」場合は非同期モードとする
        // （フォルダが含まれる場合、中身が大量にある可能性があるため安全側に倒す）
        const hasDirectory = items.some(item => item.type === "directory");
        const useAsyncMode = srcPaths.length >= 3 || hasDirectory;

        if (useAsyncMode) {
          // 非同期モード: プログレスモーダルを表示
          moveItemsBatch.mutateAsync({
            srcPaths,
            destPath: targetPath,
            overwrite: false,
            verifyChecksum,
            asyncMode: true,
            debugMode
          }).then((result) => {
            if (result.status === 'async' && result.task_id) {
              setProgressOperationType('move');
              setProgressTaskId(result.task_id);
              setProgressModalOpen(true);

              // 履歴に追加（非同期モードでも成功時に追加）
              addOperation({
                type: "MOVE",
                canUndo: true,
                timestamp: Date.now(),
                data: {
                  srcPaths,
                  destParentPath: targetPath,
                },
              });
            }
          }).catch((err) => {
            console.error("Batch move failed:", err);
            showError("移動処理中にエラーが発生しました");
          });
        } else {
          // 同期モード: 従来通り
          moveItemsBatch.mutateAsync({
            srcPaths,
            destPath: targetPath,
            overwrite: false,
            verifyChecksum,
            asyncMode: false,
            debugMode
          }).then((result) => {
            if (result.status === 'completed' && result.success_count !== undefined) {
              handleBatchOperationResult('move', {
                success_count: result.success_count,
                fail_count: result.fail_count ?? 0,
                results: result.results ?? []
              }, targetPath);

              // 履歴に追加（同期モードで成功時）
              if (result.success_count > 0) {
                addOperation({
                  type: "MOVE",
                  canUndo: true,
                  timestamp: Date.now(),
                  data: {
                    srcPaths,
                    destParentPath: targetPath,
                  },
                });
              }
            }
          }).catch((err) => {
            console.error("Batch move failed:", err);
            showError("移動処理中にエラーが発生しました");
          });
        }
      }
    }

    // クリーンアップ
    globalDraggedItems = [];
    globalDragSourcePanelId = null;
  };

  // ドラッグ選択の状態
  const containerRef = useRef<HTMLDivElement>(null);
  const closeContextMenuAndRestoreFocus = () => {
    setContextMenu(null);
    onRequestFocus?.();
    requestAnimationFrame(() => {
      containerRef.current?.focus({ preventScroll: true });
    });
  };
  const [isDragSelecting, setIsDragSelecting] = useState(false);
  const [selectionBox, setSelectionBox] = useState<{ startX: number; startY: number; endX: number; endY: number } | null>(null);

  // Shift+ドラッグ中フラグ
  const [isShiftDragSelecting, setIsShiftDragSelecting] = useState(false);

  // isFocusedがtrueになったらcontainerRefにDOMフォーカスを当てる
  // これにより、ペイン切り替え後すぐにキーボード操作が有効になる
  // isFocusedがtrueの時、またはパス変更/ロード完了時にcontainerRefにDOMフォーカスを当てる
  // これにより、ペイン切り替え後やフォルダ移動後もキーボード操作が有効になる
  useEffect(() => {
    if (isFocused && containerRef.current && !isLoading) {
      // 念のため少し遅延させてフォーカス権を取り戻す
      requestAnimationFrame(() => {
        containerRef.current?.focus({ preventScroll: true });
      });
    }
  }, [isFocused, isLoading, currentPath]);

  // ツールバーボタンにキーボードフォーカスクラスを動的に付与
  useEffect(() => {
    if (focusedSection !== 'toolbar' || !containerRef.current) return;

    const toolbarButtons = containerRef.current.querySelectorAll('.icon-toolbar button');
    // 以前のフォーカスクラスをすべて削除
    toolbarButtons.forEach(btn => btn.classList.remove('keyboard-focused'));
    // 現在のインデックスにフォーカスクラスを追加
    if (toolbarButtons[toolbarButtonIndex]) {
      toolbarButtons[toolbarButtonIndex].classList.add('keyboard-focused');
    }

    return () => {
      // クリーンアップ時にすべてのフォーカスクラスを削除
      toolbarButtons.forEach(btn => btn.classList.remove('keyboard-focused'));
    };
  }, [focusedSection, toolbarButtonIndex]);

  // フィルタバーボタンにキーボードフォーカスクラスを動的に付与
  useEffect(() => {
    if (focusedSection !== 'filter' || !containerRef.current) return;

    const filterButtons = containerRef.current.querySelectorAll('.filter-bar .filter-btn');
    // 以前のフォーカスクラスをすべて削除
    filterButtons.forEach(btn => btn.classList.remove('keyboard-focused'));
    // 現在のインデックスにフォーカスクラスを追加
    if (filterButtons[filterButtonIndex]) {
      filterButtons[filterButtonIndex].classList.add('keyboard-focused');
    }

    return () => {
      // クリーンアップ時にすべてのフォーカスクラスを削除
      filterButtons.forEach(btn => btn.classList.remove('keyboard-focused'));
    };
  }, [focusedSection, filterButtonIndex]);

  // パスセクションのボタンにキーボードフォーカスクラスを動的に付与
  useEffect(() => {
    if (focusedSection !== 'path' || !containerRef.current) return;

    // パスセクションの要素: 履歴ボタン、コピーボタン、パス入力
    const historyButton = containerRef.current.querySelector('.path-input-container button[title="履歴"]');
    const copyButton = containerRef.current.querySelector('.path-input-container button[title="フルパスをコピー"]');
    const pathInput = containerRef.current.querySelector('.path-input-container .path-input');
    const elements = [historyButton, copyButton, pathInput].filter(Boolean);

    // 以前のフォーカスクラスをすべて削除
    elements.forEach(el => el?.classList.remove('keyboard-focused'));
    // 現在のインデックスにフォーカスクラスを追加
    if (elements[pathButtonIndex]) {
      elements[pathButtonIndex]?.classList.add('keyboard-focused');
    }

    return () => {
      // クリーンアップ時にすべてのフォーカスクラスを削除
      elements.forEach(el => el?.classList.remove('keyboard-focused'));
    };
  }, [focusedSection, pathButtonIndex]);

  // マウスダウン（ドラッグ選択開始）
  const handleMouseDown = (e: React.MouseEvent) => {
    // コンテナにフォーカスを当てる（これによりキーボードイベントを受け取れる）
    containerRef.current?.focus();

    // 左クリックのみ
    if (e.button !== 0) return;

    // Shiftキーが押されている場合は、テーブル行上でもドラッグ選択を許可
    const isShiftPressed = e.shiftKey;

    if (isShiftPressed) {
      // Shift+ドラッグ：テーブル行上でもドラッグ選択を開始
      // ただし、入力要素やボタンは除外
      if ((e.target as HTMLElement).closest('button, input, a')) return;

      // デフォルトの動作を防止（テキスト選択やドラッグを防ぐ）
      e.preventDefault();

      setIsDragSelecting(true);
      setIsShiftDragSelecting(true);
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        setSelectionBox({ startX: x, startY: y, endX: x, endY: y });
      }
    } else {
      // 通常クリック：テーブル行上ではドラッグ選択を開始しない
      if ((e.target as HTMLElement).closest('button, input, a, .file-table tr')) return;

      setIsDragSelecting(true);
      setIsShiftDragSelecting(false);
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        setSelectionBox({ startX: x, startY: y, endX: x, endY: y });
      }
    }
  };

  // マウスムーブ（ドラッグ中）
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragSelecting || !selectionBox || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    setSelectionBox({ ...selectionBox, endX: x, endY: y });
  };

  // マウスアップ（ドラッグ終了・選択確定）
  const handleMouseUp = () => {
    if (!isDragSelecting || !selectionBox || !containerRef.current) {
      setIsDragSelecting(false);
      setSelectionBox(null);
      return;
    }

    // 選択ボックスの座標計算
    const left = Math.min(selectionBox.startX, selectionBox.endX);
    const top = Math.min(selectionBox.startY, selectionBox.endY);
    const width = Math.abs(selectionBox.endX - selectionBox.startX);
    const height = Math.abs(selectionBox.endY - selectionBox.startY);

    // 微小なドラッグは無視（クリックと誤認させないため）
    if (width < 5 && height < 5) {
      setIsDragSelecting(false);
      setSelectionBox(null);
      return;
    }

    // 選択判定
    const newSelected = new Set(selectedItems);
    const rows = containerRef.current.querySelectorAll('.file-table tbody tr');

    // 現在のスクロール位置を考慮
    // selectionBoxはcontainerRef内の相対座標
    // getBoundingClientRectはビューポート相対座標
    // 比較のために補正が必要だが、containerRef基準で統一する
    const containerRect = containerRef.current.getBoundingClientRect();

    rows.forEach((row) => {
      const rowRect = row.getBoundingClientRect();
      const rowTop = rowRect.top - containerRect.top + containerRef.current!.scrollTop;
      const rowLeft = rowRect.left - containerRect.left + containerRef.current!.scrollLeft;

      // 簡易的な交差判定
      // 行全体が含まれるか、あるいは交差しているか
      if (
        rowLeft < left + width &&
        rowLeft + rowRect.width > left &&
        rowTop < top + height &&
        rowTop + rowRect.height > top
      ) {
        // パスを取得（tr要素にdata-path属性があると便利だが、今回はindexから辿るか、FileIcon等から類推は難しい）
        // そのため、Reactのレンダリングサイクル内で要素に関連付けられたデータを知る必要がある。
        // 既存のDOM構造にはパス情報が埋め込まれていないため、data-pathを追加するのがベスト。
        const path = row.getAttribute('data-path');
        if (path) {
          newSelected.add(path);
        }
      }
    });

    setSelectedItems(newSelected);
    setIsDragSelecting(false);
    setIsShiftDragSelecting(false);
    setSelectionBox(null);
  };

  // ウィンドウ外でのマウスアップも検知するため
  useEffect(() => {
    if (isDragSelecting) {
      window.addEventListener('mouseup', handleMouseUp);
      return () => window.removeEventListener('mouseup', handleMouseUp);
    }
  }, [isDragSelecting, selectionBox]);

  // パネルへのドロップ
  const handlePanelDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (currentPath) {
      handleDrop(e, currentPath);
    }
  };

  // バッチ操作結果の共通ハンドラ
  const handleBatchOperationResult = async (
    operation: 'copy' | 'move',
    result: { success_count: number; fail_count: number; results: any[] },
    targetPath: string
  ) => {
    if (result.success_count > 0) {
      const opName = operation === 'copy' ? 'コピー' : '移動';
      showSuccess(`${result.success_count}件${opName}しました`);
      if (operation === 'move') {
        globalClipboard = null;
        // ドラッグ移動の場合は選択解除も行う
        setSelectedItems(new Set());
      }
    }

    console.log("Batch result:", result);

    if (result.fail_count > 0) {
      // エラーメッセージに「存在します」が含まれているかチェック
      const conflicts = result.results.filter((r: any) =>
        r.status === "error" && r.message && r.message.includes("存在します")
      );

      if (conflicts.length > 0) {
        if (confirm(`${conflicts.length}件のファイルが既に存在します。上書きしますか？`)) {
          const conflictPaths = conflicts.map((r: any) => r.path);
          try {
            const retryResult = operation === 'copy'
              ? await copyItemsBatch.mutateAsync({ srcPaths: conflictPaths, destPath: targetPath, overwrite: true })
              : await moveItemsBatch.mutateAsync({ srcPaths: conflictPaths, destPath: targetPath, overwrite: true });

            if ((retryResult.success_count ?? 0) > 0) {
              showSuccess(`${retryResult.success_count}件上書きしました`);
              if (operation === 'move' && (retryResult.fail_count ?? 0) === 0) {
                globalClipboard = null;
                setSelectedItems(new Set());
              }
            }
          } catch (retryErr) {
            console.error("Overwrite retry failed:", retryErr);
            showError("上書き処理中にエラーが発生しました");
          }
        }
      }

      // その他のエラー
      const otherErrors = result.results.filter((r: any) =>
        r.status === "error" && (!r.message || !r.message.includes("存在します"))
      );

      if (otherErrors.length > 0) {
        showError(`${otherErrors.length}件の処理に失敗しました`);
        otherErrors.forEach((r: any) => {
          console.error(`Failed to process ${r.path}: ${r.message}`);
        });
      }
    }
  };


  // アイテムクリックハンドラ（選択処理）
  const handleItemClick = (e: React.MouseEvent, path: string) => {
    // Checkboxクリック時は親へ伝搬しないようにonClickで止めているのでここには来ないはずだが念のため
    // e.stopPropagation(); 

    const isMultiSelect = e.ctrlKey || e.metaKey;
    const isRangeSelect = e.shiftKey;

    if (isRangeSelect && lastSelectedPath) {
      // 範囲選択
      const currentIndex = allSortedItems.findIndex(item => item.path === path);
      const lastIndex = allSortedItems.findIndex(item => item.path === lastSelectedPath);

      if (currentIndex !== -1 && lastIndex !== -1) {
        const start = Math.min(currentIndex, lastIndex);
        const end = Math.max(currentIndex, lastIndex);

        const newSelected = new Set(selectedItems);
        // 範囲内のアイテムを追加
        for (let i = start; i <= end; i++) {
          newSelected.add(allSortedItems[i].path);
        }
        setSelectedItems(newSelected);
      }
    } else if (isMultiSelect) {
      // 個別トグル選択
      const newSelected = new Set(selectedItems);
      if (newSelected.has(path)) {
        newSelected.delete(path);
      } else {
        newSelected.add(path);
        setLastSelectedPath(path);
      }
      setSelectedItems(newSelected);
    } else {
      // 単一選択（他をクリア）
      setSelectedItems(new Set([path]));
      setLastSelectedPath(path);
    }
  };

  const handleOpenPath = async (path: string, fileName: string, options?: { forceWebEditor?: boolean }) => {
    try {
      const lowerFileName = fileName.toLowerCase();
      const forceWebEditor = options?.forceWebEditor === true;

      // PDFはawait後のwindow.openだとポップアップブロックされやすいため、
      // ユーザー操作の同期コンテキストで直接開く
      if (lowerFileName.endsWith(".pdf")) {
        window.open(getPdfViewUrl(path), "_blank", "noopener,noreferrer");
        return;
      }

      // 画像ファイルの場合は内蔵画像プレビューモーダルを開く
      if (isImageFile(fileName)) {
        const item = allSortedItems.find((it) => it.path === path) || {
          name: fileName,
          path: path,
          type: "file" as const,
        };
        setPreviewImage(item);
        setImagePreviewOpen(true);
        return;
      }

      if (!forceWebEditor && lowerFileName.endsWith(".md") && !isExcalidrawMarkdownFile(fileName)) {
        if (markdownOpenMode === "external") {
          await openMarkdownInExternalApp(path);
          return;
        }
        if (markdownOpenMode === "obsidian_or_web" && path.toLowerCase().includes("obsidian")) {
          await openInObsidian(path);
          showSuccess("Obsidianを開きました");
          return;
        }
      } else if (!forceWebEditor && textFileOpenMode === "vscode" && isWebFileEditorTarget(fileName)) {
        await openInVSCode(path);
        showSuccess("VS Codeで開きました");
        return;
      }

      const isMarkdownForWebEditor = lowerFileName.endsWith(".md")
        && !isExcalidrawMarkdownFile(fileName)
        && (markdownOpenMode === "web" || (markdownOpenMode === "obsidian_or_web" && !path.toLowerCase().includes("obsidian")));

      const result = await openSmart(path, {
        preferEmbedded: forceWebEditor || isMarkdownForWebEditor,
      });

      if (result.action === "open_modal") {
        if (result.editor_mode === "markdown") {
          setMdEditorFileName(fileName);
          setMdEditorFilePath(path);
          setMdEditorInitialContent(result.content || "");
          setMdEditorOpen(true);
        } else {
          setFileEditorFileName(fileName);
          setFileEditorFilePath(path);
          setFileEditorInitialContent(result.content || "");
          setFileEditorLanguage(result.language ?? "plaintext");
          setFileEditorOpen(true);
        }
      } else if (result.action === "open_url" && result.url) {
        window.open(result.url, "_blank", "noopener,noreferrer");
      } else {
        // 外部アプリで開いた
        showSuccess(result.message);
      }
    } catch (e: any) {
      showError(e.message || "ファイルを開けませんでした");
    }
  };

  // ファイルクリックハンドラ（ファイルを開く処理）
  // バックエンドの/api/open/smartでファイル種類判定・処理を行う
  const handleFileClick = async (item: FileItem) => {
    await handleOpenPath(item.path, item.name);
  };

  const handleIndexedSearchSelect = async (item: IndexedFolderSearchItem) => {
    await handleOpenPath(item.full_path, item.file_name);
  };

  const calculateFocusedFolderLatestModified = async () => {
    const selectedFolders = allSortedItems.filter(
      (item) => item.type === "directory" && selectedItems.has(item.path)
    );
    const focusedItem = allSortedItems[focusedIndex];
    const target = selectedFolders.length === 1
      ? selectedFolders[0]
      : selectedFolders.length === 0 && selectedItems.size === 0 && focusedItem?.type === "directory"
        ? focusedItem
        : null;

    if (!target) {
      showError("フォルダを1件選択するか、フォルダ行にカーソルを置いてください");
      return;
    }
    if (folderLatestModifiedLoading.has(target.path)) return;

    setFolderLatestModifiedLoading((previous) => new Set(previous).add(target.path));
    try {
      const result = await getFolderLatestModified(target.path);
      if (result.truncated) {
        showError(`「${target.name}」は項目数上限またはタイムアウトのため、Dateを更新しませんでした`);
        return;
      }
      setFolderLatestModified((previous) => ({ ...previous, [target.path]: result.modified }));
      showSuccess(`「${target.name}」の最新更新日を取得しました`);
    } catch (err) {
      showError(`最新更新日の取得に失敗しました: ${(err as Error).message}`);
    } finally {
      setFolderLatestModifiedLoading((previous) => {
        const next = new Set(previous);
        next.delete(target.path);
        return next;
      });
    }
  };

  const checkPaneGitStatuses = async () => {
    const folderPaths = (data?.items ?? [])
      .filter((item) => item.type === "directory")
      .map((item) => item.path);

    if (folderPaths.length === 0 || isGitStatusLoading) return;

    setIsGitStatusLoading(true);
    try {
      const statuses = await getFolderGitStatuses(folderPaths);
      setFoldersWithGitChanges(Object.fromEntries(
        statuses
          .map((item) => [item.path, {
            changedFiles: item.changed_files,
            hasMoreChanges: item.has_more_changes,
            aheadCount: item.ahead_count,
            behindCount: item.behind_count,
          }])
      ));
    } catch (err) {
      showError(`Git状態の取得に失敗しました: ${(err as Error).message}`);
    } finally {
      setIsGitStatusLoading(false);
    }
  };

  const handleOpenGitFolderInVSCode = async (item: FileItem) => {
    try {
      await openInVSCode(item.path);
    } catch (err) {
      showError(`VS Code起動エラー: ${(err as Error).message}`);
    }
  };

  const handleGitStatusAction = async (item: FileItem) => {
    const status = foldersWithGitChanges[item.path];
    if (!status || (status.aheadCount === 0 && status.behindCount === 0)) {
      await handleOpenGitFolderInVSCode(item);
      return;
    }

    const action: GitSyncAction = status.aheadCount > 0 && status.behindCount > 0
      ? "sync"
      : status.aheadCount > 0
        ? "push"
        : "pull";
    try {
      await navigator.clipboard.writeText(buildGitSyncCommand(item.path, action));
      showSuccess(`git ${action === "sync" ? "pull --rebase && git push" : action} コマンドをコピーしました`);
    } catch {
      showError("Gitコマンドのコピーに失敗しました");
    }
  };

  const getGitStatusTitle = (path: string): string => {
    const status = foldersWithGitChanges[path];
    if (!status) return "";
    const lines: string[] = [];
    if (status.aheadCount > 0) lines.push(`未Push: ${status.aheadCount}件`);
    if (status.behindCount > 0) lines.push(`未Pull: ${status.behindCount}件`);
    if (status.changedFiles.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push("変更ファイル:", ...status.changedFiles);
      if (status.hasMoreChanges) lines.push("…");
    }
    const clickHint = status.aheadCount > 0 || status.behindCount > 0
      ? "クリックしてターミナル用Gitコマンドをコピー"
      : "クリックしてVS Codeで開く";
    return [
      ...lines,
      "",
      clickHint,
    ].join("\n");
  };

  const getGitStatusLabel = (path: string): "-" | "G" | "Push" | "Pull" | "C" => {
    const status = foldersWithGitChanges[path];
    if (!status || (!status.hasMoreChanges && status.changedFiles.length === 0 && status.aheadCount === 0 && status.behindCount === 0)) return "-";
    if (status.aheadCount > 0 && status.behindCount > 0) return "C";
    if (status.aheadCount > 0) return "Push";
    if (status.behindCount > 0) return "Pull";
    return "G";
  };

  // キーボードショートカット
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }

    const isCmdOrCtrl = e.ctrlKey || e.metaKey;

    // ペインがフォーカスされている場合のみ処理
    if (!isFocused) return;

    // 戻る (Ctrl + Left / Ctrl + Down)
    if (isCmdOrCtrl && (e.key === 'ArrowLeft' || e.key === 'ArrowDown')) {
      e.preventDefault();
      e.stopPropagation();
      goBack();
      return;
    }

    // 進む (Ctrl + Right)
    if (isCmdOrCtrl && e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      goForward();
      return;
    }

    // 上の階層へ (Ctrl + Up)
    if (isCmdOrCtrl && e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      navigateUp();
      return;
    }



    // セクションごとの操作
    switch (focusedSection) {
      case 'toolbar':
        // 左右: ツールバーボタン切替
        if (e.key === 'ArrowLeft') {
          if (toolbarButtonIndex === 0) {
            // 左端の場合はイベントを通過させてペイン切り替えを許可
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          setToolbarButtonIndex(toolbarButtonIndex - 1);
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          e.stopPropagation();
          // ツールバーボタンの最大インデックスを動的に取得
          const toolbarButtons = containerRef.current?.querySelectorAll('.icon-toolbar button');
          const maxToolbarIndex = toolbarButtons ? Math.max(0, toolbarButtons.length - 1) : 0;
          if (toolbarButtonIndex < maxToolbarIndex) {
            setToolbarButtonIndex(toolbarButtonIndex + 1);
          }
          return;
        }
        // 下: 次のセクションへ
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          setFocusedSection('path');
          setPathButtonIndex(0); // 履歴ボタンから開始
          return;
        }
        // Enter: ボタンをクリック
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          // ツールバーボタンをクリック（DOMから取得）
          const toolbarButtons = containerRef.current?.querySelectorAll('.icon-toolbar button');
          if (toolbarButtons && toolbarButtons[toolbarButtonIndex]) {
            (toolbarButtons[toolbarButtonIndex] as HTMLButtonElement).click();
          }
          return;
        }
        break;

      case 'path':
        // 履歴ドロップダウンが開いている場合は履歴ナビゲーション
        if (showHistory) {
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            setHistorySelectedIndex(Math.max(0, historySelectedIndex - 1));
            return;
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            e.stopPropagation();
            setHistorySelectedIndex(Math.min(filteredHistory.length - 1, historySelectedIndex + 1));
            return;
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            if (filteredHistory[historySelectedIndex]) {
              navigateToFolder(filteredHistory[historySelectedIndex].path);
              setShowHistory(false);
            }
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setShowHistory(false);
            return;
          }
          return;
        }

        // 左右: パスセクション内のボタン切替
        if (e.key === 'ArrowLeft') {
          if (pathButtonIndex === 0) {
            // 左端の場合はイベントを通過させてペイン切り替えを許可
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          setPathButtonIndex(pathButtonIndex - 1);
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          e.stopPropagation();
          // 0: 履歴、1: コピー、2: パス入力
          if (pathButtonIndex < 2) {
            setPathButtonIndex(pathButtonIndex + 1);
          }
          return;
        }
        // 上: 前のセクションへ
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          setFocusedSection('toolbar');
          return;
        }
        // 下: 次のセクションへ
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          setFocusedSection('filter');
          return;
        }
        // Enter: ボタンをクリックまたはパス入力フォーカス
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          if (pathButtonIndex === 0) {
            // 履歴ボタン: 履歴ドロップダウンを表示
            setShowHistory(!showHistory);
            setHistorySelectedIndex(0);
          } else if (pathButtonIndex === 1) {
            // コピーボタン: パスをコピー
            copyCurrentPath();
          } else if (pathButtonIndex === 2) {
            // パス入力: フォーカスを移動
            pathInputRef.current?.focus();
          }
          return;
        }
        break;

      case 'filter':
        // 左右: フィルタボタン切替
        if (e.key === 'ArrowLeft') {
          if (filterButtonIndex === 0) {
            // 左端の場合はイベントを通過させてペイン切り替えを許可
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          setFilterButtonIndex(filterButtonIndex - 1);
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          e.stopPropagation();
          // フィルタボタンの最大インデックス（全10ボタン）
          const maxFilterIndex = 10;
          if (filterButtonIndex < maxFilterIndex) {
            setFilterButtonIndex(filterButtonIndex + 1);
          }
          return;
        }
        // 上: 前のセクションへ
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          setFocusedSection('path');
          setPathButtonIndex(0); // 履歴ボタンから開始
          return;
        }
        // 下: 次のセクションへ
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          setFocusedSection('history');
          historyInputRef.current?.focus();
          return;
        }
        // Enter: ボタンをクリック
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          const filterButtons = containerRef.current?.querySelectorAll('.filter-bar .filter-btn');
          if (filterButtons && filterButtons[filterButtonIndex]) {
            (filterButtons[filterButtonIndex] as HTMLButtonElement).click();
          }
          return;
        }
        break;

      case 'history':
        // 上: 前のセクションへ
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          setFocusedSection('filter');
          return;
        }
        // 下: 次のセクションへ
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          setFocusedSection('search');
          searchInputRef.current?.focus();
          return;
        }
        break;

      case 'search':
        // 上: 前のセクションへ
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          setFocusedSection('history');
          historyInputRef.current?.focus();
          return;
        }
        // 下: 次のセクションへ
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          setFocusedSection('list');
          setFocusedIndex(0);
          return;
        }
        break;

      case 'list':
        // 上矢印: フォーカスを上に移動
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();

          if (focusedIndex === 0) {
            // 先頭で上を押したら検索セクションへ
            setFocusedSection('search');
            searchInputRef.current?.focus();
            return;
          }

          const newIndex = focusedIndex - 1;

          if (isCmdOrCtrl && e.shiftKey) {
            // Ctrl + Shift: 選択解除（なぞって解除）
            const newSelected = new Set(selectedItems);
            if (allSortedItems[focusedIndex]) {
              newSelected.delete(allSortedItems[focusedIndex].path);
            }
            if (allSortedItems[newIndex]) {
              newSelected.delete(allSortedItems[newIndex].path);
            }
            setSelectedItems(newSelected);
          } else if (e.shiftKey) {
            // Shift押下中は連続選択
            const newSelected = new Set(selectedItems);
            if (allSortedItems[focusedIndex]) {
              newSelected.add(allSortedItems[focusedIndex].path);
            }
            if (allSortedItems[newIndex]) {
              newSelected.add(allSortedItems[newIndex].path);
              setLastSelectedPath(allSortedItems[newIndex].path);
            }
            setSelectedItems(newSelected);
          }

          setFocusedIndex(newIndex);
          // フォーカスしたアイテムをスクロールして表示
          requestAnimationFrame(() => {
            const row = containerRef.current?.querySelector(`.file-table tbody tr[data-index="${newIndex}"]`);
            row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          });
          return;
        }

        // 下矢印: フォーカスを下に移動
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          const newIndex = Math.min(allSortedItems.length - 1, focusedIndex + 1);

          if (isCmdOrCtrl && e.shiftKey) {
            // Ctrl + Shift: 選択解除（なぞって解除）
            const newSelected = new Set(selectedItems);
            if (allSortedItems[focusedIndex]) {
              newSelected.delete(allSortedItems[focusedIndex].path);
            }
            if (allSortedItems[newIndex]) {
              newSelected.delete(allSortedItems[newIndex].path);
            }
            setSelectedItems(newSelected);
          } else if (e.shiftKey) {
            // Shift押下中は連続選択
            const newSelected = new Set(selectedItems);
            if (allSortedItems[focusedIndex]) {
              newSelected.add(allSortedItems[focusedIndex].path);
            }
            if (allSortedItems[newIndex]) {
              newSelected.add(allSortedItems[newIndex].path);
              setLastSelectedPath(allSortedItems[newIndex].path);
            }
            setSelectedItems(newSelected);
          }

          setFocusedIndex(newIndex);
          // フォーカスしたアイテムをスクロールして表示
          requestAnimationFrame(() => {
            const row = containerRef.current?.querySelector(`.file-table tbody tr[data-index="${newIndex}"]`);
            row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          });
          return;
        }

        // Ctrl + Enter: フォーカス中の行を選択トグル
        if (isCmdOrCtrl && e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          if (focusedIndex >= 0 && allSortedItems[focusedIndex]) {
            const item = allSortedItems[focusedIndex];
            toggleSelect(item.path);
          }
          return;
        }

        // Enter: フォーカス中の行を開く（選択済みの場合）
        if (e.key === 'Enter' && !isCmdOrCtrl) {
          e.preventDefault();
          e.stopPropagation();
          if (focusedIndex >= 0 && allSortedItems[focusedIndex]) {
            const item = allSortedItems[focusedIndex];
            if (selectedItems.has(item.path)) {
              // 選択済みなら開く
              if (item.type === 'directory') {
                navigateToFolder(item.path);
              } else {
                handleFileClick(item);
              }
            } else {
              // 未選択なら選択
              toggleSelect(item.path);
            }
          }
          return;
        }
        break;
    }

    // 全選択解除 (Ctrl + Shift + A)
    if (isCmdOrCtrl && e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      e.stopPropagation(); // 他のペインへの干渉を防ぐ
      setSelectedItems(new Set());
      return;
    }

    // 全選択 (Ctrl + A)
    if (isCmdOrCtrl && !e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      e.stopPropagation();
      const allPaths = allSortedItems.map(item => item.path);
      setSelectedItems(new Set(allPaths));
    }

    // コピー (Ctrl + C)
    if (isCmdOrCtrl && e.key.toLowerCase() === 'c') {
      if (selectedItems.size > 0) {
        e.preventDefault();
        e.stopPropagation();

        // グローバルクリップボードに保存
        globalClipboard = {
          paths: Array.from(selectedItems),
          op: 'copy'
        };

        // OSクリップボードにもコピー (Explorer貼り付け用)
        const paths = Array.from(selectedItems);
        copyFilesToClipboard(paths).catch(err => console.error("OS copy failed", err));

        showSuccess(`${selectedItems.size}件をコピーしました`);
      }
      return;
    }

    // 切り取り (Ctrl + X)
    if (isCmdOrCtrl && e.key.toLowerCase() === 'x') {
      if (selectedItems.size > 0) {
        e.preventDefault();
        e.stopPropagation();

        // グローバルクリップボードに保存
        globalClipboard = {
          paths: Array.from(selectedItems),
          op: 'move'
        };

        showSuccess(`${selectedItems.size}件を切り取りました`);
      }
      return;
    }

    // ペースト (Ctrl + V)
    if (isCmdOrCtrl && e.key.toLowerCase() === 'v') {
      if (globalClipboard && globalClipboard.paths.length > 0) {
        if (currentPath) {
          e.preventDefault();
          e.stopPropagation();

          const debugMode = localStorage.getItem('file_manager_debug_mode') === 'true';
          const verifyChecksum = localStorage.getItem('file_manager_verify_checksum') === 'true';

          // ファイル数をカウントして非同期モードかどうかを判定
          countFiles(globalClipboard.paths, 3).then((countResult) => {
            const totalFileCount = countResult.total_count;
            const useAsyncMode = totalFileCount >= 3;

            if (globalClipboard!.op === 'copy') {
              if (useAsyncMode) {
                // 非同期モード: プログレスバー表示
                const srcPaths = globalClipboard!.paths;
                copyItemsBatch.mutateAsync({
                  srcPaths,
                  destPath: currentPath,
                  verifyChecksum,
                  asyncMode: true,
                  debugMode
                }).then((result) => {
                  if (result.status === 'async' && result.task_id) {
                    setProgressOperationType('copy');
                    setProgressTaskId(result.task_id);
                    setProgressModalOpen(true);

                    // 履歴に追加（コピーされたファイルのパスを計算）
                    const copiedPaths = srcPaths.map((srcPath) => {
                      const fileName = srcPath.split("/").pop() || "";
                      return `${currentPath}/${fileName}`;
                    });
                    addOperation({
                      type: "COPY",
                      canUndo: true,
                      timestamp: Date.now(),
                      data: {
                        copiedPaths,
                        originalPaths: srcPaths,
                      },
                    });
                  }
                }).catch((err) => {
                  console.error("Paste failed:", err);
                  showError("ペースト処理中にエラーが発生しました");
                });
              } else {
                // 同期モード
                const srcPaths = globalClipboard!.paths;
                copyItemsBatch.mutateAsync({
                  srcPaths,
                  destPath: currentPath,
                  verifyChecksum,
                  asyncMode: false,
                  debugMode
                }).then((result) => {
                  if (result.success_count !== undefined) {
                    handleBatchOperationResult('copy', {
                      success_count: result.success_count,
                      fail_count: result.fail_count ?? 0,
                      results: result.results ?? []
                    }, currentPath);

                    // 履歴に追加（同期モードで成功時）
                    if (result.success_count > 0) {
                      const copiedPaths = srcPaths.map((srcPath) => {
                        const fileName = srcPath.split("/").pop() || "";
                        return `${currentPath}/${fileName}`;
                      });
                      addOperation({
                        type: "COPY",
                        canUndo: true,
                        timestamp: Date.now(),
                        data: {
                          copiedPaths,
                          originalPaths: srcPaths,
                        },
                      });
                    }
                  }
                }).catch((err) => {
                  console.error("Paste failed:", err);
                  showError("ペースト処理中にエラーが発生しました");
                });
              }
            } else if (globalClipboard!.op === 'move') {
              if (useAsyncMode) {
                // 非同期モード: プログレスバー表示
                moveItemsBatch.mutateAsync({
                  srcPaths: globalClipboard!.paths,
                  destPath: currentPath,
                  verifyChecksum,
                  asyncMode: true,
                  debugMode
                }).then((result) => {
                  if (result.status === 'async' && result.task_id) {
                    setProgressOperationType('move');
                    setProgressTaskId(result.task_id);
                    setProgressModalOpen(true);
                    // 切り取りの場合はクリップボードをクリア
                    globalClipboard = null;
                    setSelectedItems(new Set());
                  }
                }).catch((err) => {
                  console.error("Paste failed:", err);
                  showError("ペースト処理中にエラーが発生しました");
                });
              } else {
                // 同期モード
                moveItemsBatch.mutateAsync({
                  srcPaths: globalClipboard!.paths,
                  destPath: currentPath,
                  verifyChecksum,
                  asyncMode: false,
                  debugMode
                }).then((result) => {
                  if (result.success_count !== undefined) {
                    handleBatchOperationResult('move', {
                      success_count: result.success_count,
                      fail_count: result.fail_count ?? 0,
                      results: result.results ?? []
                    }, currentPath);
                  }
                }).catch((err) => {
                  console.error("Paste failed:", err);
                  showError("ペースト処理中にエラーが発生しました");
                });
              }
            }
          }).catch((err: any) => {
            console.error("Failed to count files:", err);
            showError(`ファイル数カウントに失敗しました: ${err.message}`);
          });
        }
      }
    }

    // Git状態確認 (G)
    if (!isCmdOrCtrl && e.key.toLowerCase() === 'g') {
      if (panelId === 'left' || panelId === 'center') {
        e.preventDefault();
        e.stopPropagation();
        void checkPaneGitStatuses();
      }
      return;
    }

    // フォルダ最新日時の計算 (D)
    if (!isCmdOrCtrl && e.key.toLowerCase() === 'd') {
      if (panelId === 'left' || panelId === 'center') {
        e.preventDefault();
        e.stopPropagation();
        void calculateFocusedFolderLatestModified();
      }
      return;
    }

    // 再読み込み / 更新 (R)
    if (!isCmdOrCtrl && e.key.toLowerCase() === 'r') {
      if (panelId === 'left' || panelId === 'center') {
        e.preventDefault();
        e.stopPropagation();
        void handleRefresh();
      }
      return;
    }

    // リネーム (N)
    if (!isCmdOrCtrl && e.key.toLowerCase() === 'n') {
      if (panelId === 'left' || panelId === 'center') {
        e.preventDefault();
        e.stopPropagation();

        const focusedItem = allSortedItems[focusedIndex];

        if (focusedItem) {
          setContextMenu({
            x: window.innerWidth / 2,
            y: window.innerHeight / 2,
            item: focusedItem,
            startRename: true
          });
        }
      }
      return;
    }

    // 削除 (Delete / Cmd + Backspace)
    if (e.key === 'Delete' || (isCmdOrCtrl && e.key === 'Backspace')) {
      if (selectedItems.size > 0) {
        e.preventDefault();
        e.stopPropagation();
        handleDeleteSelected();
      }
      return;
    }

    // 選択解除 (Esc)
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setSelectedItems(new Set());
      setLastSelectedPath(null);
      return;
    }
  };

  // チェックボックス選択
  const toggleSelect = (path: string) => {
    const newSelected = new Set(selectedItems);
    if (newSelected.has(path)) {
      newSelected.delete(path);
    } else {
      newSelected.add(path);
      setLastSelectedPath(path);
    }
    setSelectedItems(newSelected);
  };

  // ファイルサイズをフォーマット
  const formatSize = (bytes?: number) => {
    if (bytes === undefined) return "-";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleSort = (key: "name" | "size" | "date") => {
    if (sortKey === key) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortOrder("asc");
    }
  };

  const SortIcon = ({ col }: { col: "name" | "size" | "date" }) => {
    if (sortKey !== col) return null;
    return sortOrder === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />;
  };

  // パス検証中またはファイル読み込み中
  if (!isPathValidated || isLoading) {
    return <div className="loading">読み込み中...</div>;
  }

  // パス検証済みで、有効なcurrentPathがない場合（通常は発生しない）
  if (!currentPath) {
    return <div className="error">パスが設定されていません</div>;
  }

  // エラー表示（パス検証後のエラーのみ）
  if (error) {
    return <div className="error">エラー: {(error as Error).message}</div>;
  }

  return (
    <div
      ref={containerRef}
      className={`file-list ${isShiftDragSelecting ? 'shift-drag-selecting' : ''}`}
      tabIndex={0} // キーボードイベントのために必要
      onKeyDown={handleKeyDown}
      onContextMenu={handlePaneContextMenu}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handlePanelDrop}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {selectionBox && (
        <div
          className="selection-box"
          style={{
            left: Math.min(selectionBox.startX, selectionBox.endX),
            top: Math.min(selectionBox.startY, selectionBox.endY),
            width: Math.abs(selectionBox.endX - selectionBox.startX),
            height: Math.abs(selectionBox.endY - selectionBox.startY),
          }}
        />
      )}
      <IndexedFolderSearchModal
        isOpen={isIndexedSearchOpen}
        folderPath={currentPath}
        onClose={handleCloseIndexedSearch}
        onSelectItem={handleIndexedSearchSelect}
      />
      <FolderHistoryModal
        isOpen={isHistoryModalOpen}
        history={allHistory.map((item) => item.path)}
        onClose={() => setIsHistoryModalOpen(false)}
        onSelectPath={(p) => navigateToFolder(p)}
      />
      {/* アイコンツールバー */}
      <div
        className={`icon-toolbar ${focusedSection === 'toolbar' ? 'section-focused' : ''}`}
        data-focused-index={focusedSection === 'toolbar' ? toolbarButtonIndex : undefined}
      >
        <button onClick={goBack} disabled={navigationIndex <= 0} title="戻る">
          <ArrowLeft size={14} />
        </button>
        <button onClick={goForward} disabled={navigationIndex >= navigationHistory.length - 1} title="進む">
          <ArrowRight size={14} />
        </button>
        <button onClick={navigateUp} disabled={!currentPath} title="上の階層へ">
          <ChevronUp size={14} />
        </button>
        <button onClick={() => {
          const targetPath = initialPath ?? getDefaultBasePath();
          navigateToFolder(targetPath);
        }} title="ホームへ">
          <Home size={14} />
        </button>
        <button onClick={() => navigateToFolder(getNetworkDrivePath())} title="ネットワークドライブへ">
          <Network size={14} />
        </button>
        <button onClick={openFromClipboard} title="クリップボードから開く">
          <ClipboardPaste size={14} />
        </button>
        <button onClick={handleDownload} title="ダウンロード">
          <Download size={14} />
        </button>
        <button onClick={handleOpenVSCode} title="VSCodeで開く">
          <Code size={14} />
        </button>
        <button onClick={handleOpenAntigravity} title="Antigravityで開く">
          <Rocket size={14} />
        </button>
        <button onClick={handleOpenObsidianDaily} title="Obsidian 今日のフォルダ">
          <img src="/obsidian.svg" alt="Obsidian Daily" width={14} height={14} />
        </button>
        <button onClick={handleOpenExplorer} title="フォルダを開く">
          <FolderOpen size={14} />
        </button>
        {(panelId === "left" || panelId === "center") && (
          <>
            <button
              onClick={() => {
                setFocusedSection("search");
                searchInputRef.current?.focus();
                searchInputRef.current?.select();
              }}
              title="ファイル名検索 (Ctrl+F / /)"
            >
              <Search size={14} />
            </button>
            <button onClick={handleOpenFullTextSearch} title="全文検索 (Ctrl+P)">
              <Search size={14} style={{ opacity: 0.6 }} />
            </button>
          </>
        )}
        <button onClick={handleOpenJupyter} title="Jupyterで開く">
          <img src="/icons/catppuccin/jupyter.svg" alt="Jupyter" width={14} height={14} />
        </button>
        <button onClick={handleOpenExcalidraw} title="Excalidrawで開く">
          <img src="/icons/catppuccin/excalidraw.svg" alt="Excalidraw" width={14} height={14} />
        </button>
        <button onClick={handleOpenMarkdown} title="Markdownファイル作成">
          <img src="/icons/catppuccin/markdown.svg" alt="Markdown" width={14} height={14} />
        </button>
        {/* Obsidianボタン：パスにobsidianを含む場合のみ表示 */}
        {currentPath && currentPath.toLowerCase().includes('obsidian') && (
          <>
            <div className="toolbar-divider" />
            <button onClick={handleOpenObsidian} title="Obsidianで開く">
              <Gem size={14} />
            </button>
          </>
        )}
        <div className="toolbar-divider" />
        <button onClick={handleCreateFolder} title="フォルダ作成">
          <FolderPlus size={14} />
        </button>
        <button
          onClick={handleDeleteSelected}
          disabled={selectedItems.size === 0}
          title="選択項目を削除"
          className="delete-btn"
        >
          <Trash2 size={14} />
        </button>
        <button onClick={handleRefresh} title="更新 (R)">
          <RefreshCw size={14} />
        </button>


        <div style={{ flex: 1 }} />

        {/* 区切り線 */}
        <div className="toolbar-divider" />

        {/* テストフォルダボタン (透明/アウトライン) */}
        <button
          className="toolbar-btn test-folder-btn"
          onClick={async () => {
            const result = await getTestFolderPath();
            if (result.success && result.path) {
              navigateToFolder(result.path);
            } else {
              showError(result.error || "テストフォルダのパスを取得できませんでした");
            }
          }}
          title="テストフォルダを開く"
        >
          <FlaskConical size={14} />
        </button>

        {/* ゴミ箱表示ボタン (透明/アウトライン) */}
        <button
          className="toolbar-btn trash-open-btn"
          onClick={async () => {
            const result = await openTrash();
            if (result.success) {
              showSuccess(result.message || "ゴミ箱を開きました");
            } else {
              showError(result.error || "ゴミ箱を開けませんでした");
            }
          }}
          title="ゴミ箱を開く"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {/* パス入力 */}
      <div className="path-input-container">
        {/* 履歴ボタンは削除 */}
        <button onClick={copyCurrentPath} title="フルパスをコピー" className="path-button">
          <Copy size={14} />
        </button>
        <button onClick={() => copyLinkToClipboard(currentPath || "", "directory")} title="リンクをコピー" className="path-button">
          <Link size={14} />
        </button>
        <form onSubmit={handlePathSubmit} className="path-form">
          <textarea
            ref={pathInputRef as any}
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder="フルパスを入力"
            className="path-input"
            rows={1}
            style={{ height: 'auto' }} // 動的高さ調整の初期値
            onKeyDown={(e) => {
              // Enterで送信 (Shiftなし)
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handlePathSubmit(e);
                return;
              }

              if (e.key === 'ArrowDown') {
                // カーソルが最後尾または次の行がない場合のみフォーカス移動
                // ここでは簡易的に常に移動させず、テキストエリア内の移動を優先したいが
                // UI操作性を考えると、一行入力的な使い方がメインなので下矢印で移動しても良いかもしれない
                // 一旦、Shift+ArrowDownでなければ移動などにするか、あるいはテキストエリアの特性上、
                // 上下移動はキャレット移動に使いたい。
                // 今回は「下矢印でフィルタへ移動」を維持する場合、キャレットが最終行なら移動、という判定が必要だが
                // 簡易実装として Ctrl+ArrowDown 等にするか、あるいは単行ならそのまま。
                // ここでは、デフォルトの挙動（キャレット移動）を優先し、修飾キー付きでフォーカス移動にするか、
                // シンプルに「Shift+Enter」で改行、「Enter」で送信という仕様に合わせ、
                // 矢印キーはテキストエリア内の移動に専念させるのが無難。
                // しかし既存の操作性を維持するため、空欄または入力がない場合は移動させる等の工夫もできる。

                // 元のロジックを維持しつつ、テキストエリア内の移動を阻害しないようにする
                // e.preventDefault() は条件付きにする

                // 最終行かどうか判定するのは複雑なので、Ctrl+Downで移動にする案
                // またはユーザー要望は「表示」なので、操作性は変えたくない

                // 今回はシンプルに: Enterのみ送信に変更し、矢印キーによるフォーカス移動は
                // 複数行入力の邪魔になるため、Ctrl+ArrowDown / Cmd+ArrowDown に変更する
                if (e.ctrlKey || e.metaKey) {
                  e.preventDefault();
                  containerRef.current?.focus();
                  setFocusedSection('filter');
                }
              } else if (e.key === 'ArrowUp') {
                if (e.ctrlKey || e.metaKey) {
                  e.preventDefault();
                  containerRef.current?.focus();
                  setFocusedSection('toolbar');
                  setToolbarButtonIndex(0);
                }
              } else if (e.key === 'ArrowLeft') {
                // カーソルが先頭の場合、コピーボタンに移動 (Ctrl+Left)
                if ((e.ctrlKey || e.metaKey) && (e.target as HTMLTextAreaElement).selectionStart === 0) {
                  e.preventDefault();
                  containerRef.current?.focus();
                  setFocusedSection('path');
                  setPathButtonIndex(1); // コピーボタン
                }
              }
            }}
          />
        </form>
      </div>

      {/* フィルタバー */}
      <FilterBar
        typeFilter={typeFilter}
        extFilter={extFilter}
        onTypeChange={setTypeFilter}
        onExtChange={setExtFilter}
        isFocused={focusedSection === 'filter'}
      />

      {/* 履歴検索バー (Keyword Searchの上に追加) */}
      <div className="history-search-bar">
        <History size={14} className="history-icon" />
        <input
          ref={historyInputRef}
          type="text"
          placeholder="履歴を検索..."
          value={historyFilter}
          onChange={(e) => {
            setHistoryFilter(e.target.value);
            setHistorySelectedIndex(0);
            if (!showHistory) setShowHistory(true);
          }}
          onFocus={() => {
            // フォーカス時は何もしない（入力時のみ表示）
          }}
          onBlur={() => {
            // クリックイベントの処理を待つために少し遅延させる
            setTimeout(() => setShowHistory(false), 200);
          }}
          onKeyDown={(e) => {
            const isDropdownActive = showHistory && filteredHistory.length > 0;

            if (e.key === 'ArrowUp') {
              if (!isDropdownActive) {
                e.preventDefault();
                containerRef.current?.focus();
                setFocusedSection('filter');
                return;
              }
              // ドロップダウンがアクティブなら handleHistoryKeyDown で処理
            } else if (e.key === 'ArrowDown') {
              if (!isDropdownActive) {
                e.preventDefault();
                containerRef.current?.focus();
                setFocusedSection('search');
                searchInputRef.current?.focus();
                return;
              }
              // ドロップダウンがアクティブなら handleHistoryKeyDown で処理
            } else if (e.key === 'Enter') {
              if (!showHistory) {
                e.preventDefault();
                setShowHistory(true);
                setHistorySelectedIndex(0);
                return;
              }
            }

            // ドロップダウン用キーハンドリング
            handleHistoryKeyDown(e);
          }}
          onClick={(e) => e.stopPropagation()}
        />
        {showHistory && (
          <div className="history-dropdown">
            {filteredHistory.length > 0 ? (
              filteredHistory.slice(0, 10).map((item, index) => (
                <div
                  key={index}
                  data-index={index}
                  className={`history-item ${index === historySelectedIndex ? "selected" : ""}`}
                  onClick={() => {
                    navigateToFolder(item.path);
                    setShowHistory(false);
                  }}
                  onMouseEnter={() => setHistorySelectedIndex(index)}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <span style={{
                    overflow: 'hidden',
                    whiteSpace: 'normal',
                    wordBreak: 'break-all',
                    overflowWrap: 'anywhere'
                  }}>
                    {item.path || "/"}
                  </span>
                  {item.count > 1 && (
                    <span style={{ fontSize: '0.8em', color: '#888', marginLeft: '8px', flexShrink: 0 }}>
                      {item.count}回
                    </span>
                  )}
                </div>
              ))
            ) : (
              <div className="history-empty">履歴がありません</div>
            )}
          </div>
        )}
      </div>

      {/* 検索バー */}
      <div className="search-bar">
        <Search size={14} className="search-icon" />
        <input
          ref={searchInputRef}
          type="text"
          placeholder={isRegex ? "正規表現で検索... (Ctrl+F / /)" : "検索... (Ctrl+F / /)"}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setSearchQuery("");
              setFocusedSection('list');
              setFocusedIndex(0);
              containerRef.current?.focus();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              containerRef.current?.focus();
              setFocusedSection('list');
              setFocusedIndex(0);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              containerRef.current?.focus();
              setFocusedSection('history');
              historyInputRef.current?.focus();
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (searchQuery.trim() && allSortedItems.length > 0) {
                const direction = e.shiftKey ? "prev" : "next";
                const nextIdx = getNextSearchHitIndex(focusedIndex, allSortedItems.length, direction);
                setFocusedIndex(nextIdx);
                const targetItem = allSortedItems[nextIdx];
                if (targetItem) {
                  setSelectedItems(new Set([targetItem.path]));
                  setLastSelectedPath(targetItem.path);
                }
                const rowEl = containerRef.current?.querySelector(`.file-table tbody tr[data-index="${nextIdx}"]`);
                rowEl?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
              } else {
                onRequestFocus?.();
                containerRef.current?.focus();
                setFocusedSection('list');
                setFocusedIndex(0);
              }
            }
          }}
        />
        {searchQuery && (
          <button
            className="search-clear-btn"
            onClick={() => {
              setSearchQuery("");
              searchInputRef.current?.focus();
            }}
            title="検索をクリア (Esc)"
          >
            <X size={12} />
          </button>
        )}
        <span
          className="search-count-badge"
          title={searchQuery.trim() ? "現在ヒット位置 / 総ヒット件数 (Enter: 次へ / Shift+Enter: 前へ)" : "マッチ件数 / 全件数"}
        >
          {searchQuery.trim()
            ? formatSearchPosition(focusedIndex, allSortedItems.length)
            : formatSearchMatchCount(allSortedItems.length, data?.items?.length || 0)}
        </span>
        <button
          className={`regex-toggle ${isRegex ? "active" : ""}`}
          onClick={() => setIsRegex(!isRegex)}
          title="正規表現 (Regex)"
        >
          .*
        </button>
      </div>

      {/* ファイル一覧テーブル */}
      <div className="table-container">
        <table className="file-table">
          <thead onContextMenu={handlePaneContextMenu}>
            <tr>
              <th className="checkbox-col"></th>
              <th className="name-col" onClick={() => handleSort("name")}>
                Name <SortIcon col="name" />
              </th>
              <th className="size-col" onClick={() => handleSort("size")}>
                Size <SortIcon col="size" />
              </th>
              <th className="date-col" onClick={() => handleSort("date")}>
                Date <SortIcon col="date" />
              </th>
              <th className="git-col" title="Gキーでペイン内フォルダのGit変更を確認">
                Git{isGitStatusLoading ? "…" : ""}
              </th>
            </tr>
          </thead>
          <tbody>
            {/* フォルダ */}
            {folders.map((item, index) => (
              <tr
                key={item.path}
                data-path={item.path}
                data-index={index}
                className={`${selectedItems.has(item.path) ? "selected" : ""} ${dragOverPath === item.path ? "drag-over" : ""} ${focusedIndex === index ? "focused" : ""}`}
                draggable
                onDragStart={(e) => handleDragStart(e, item)}
                onDragOver={(e) => handleDragOver(e, item.path)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, item.path)}
                onContextMenu={(e) => handleContextMenu(e, item)}
                onClick={(e) => {
                  onRequestFocus?.();
                  setFocusedSection('list');
                  setFocusedIndex(index);
                  handleItemClick(e, item.path);
                  containerRef.current?.focus();
                }}
              >
                <td className="checkbox-col" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedItems.has(item.path)}
                    onChange={() => toggleSelect(item.path)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        if (selectedItems.has(item.path)) {
                          // 既に選択済みなら開く（フォルダに移動）
                          navigateToFolder(item.path);
                        } else {
                          // 未選択なら選択する
                          toggleSelect(item.path);
                        }
                      }
                    }}
                  />
                </td>
                <td className="name-cell">
                  <div className="name-cell-content">
                    <button
                      className="row-copy-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        copyFullPath(item);
                      }}
                      title="フルパスをコピー"
                    >
                      <Copy size={12} />
                    </button>
                    <button
                      className="row-copy-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        copyLinkToClipboard(item.path, "directory");
                      }}
                      title="リンクをコピー"
                    >
                      <Link size={12} />
                    </button>
                    <div
                      className="name-info-wrapper"
                      onClick={() => navigateToFolder(item.path)}
                    >
                      <FileIcon name={item.name} type="directory" className="icon" />
                      <span>{item.name}</span>
                    </div>
                  </div>
                </td>
                <td className="size-col">
                  <div className="cell-content">
                    -
                  </div>
                </td>
                <td className="date-col">
                  <div className="cell-content">
                    {folderLatestModifiedLoading.has(item.path)
                      ? "…"
                      : formatFileDate(folderLatestModified[item.path] ?? item.modified)}
                  </div>
                </td>
                <td className="git-col">
                  {foldersWithGitChanges[item.path] && (() => {
                    const label = getGitStatusLabel(item.path);
                    return label === "-" ? (
                      <span title="Gitリポジトリ外、または変更・リモートとの差分なし">-</span>
                    ) : (
                      <button
                        className="git-status-button"
                        type="button"
                        title={getGitStatusTitle(item.path)}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleGitStatusAction(item);
                        }}
                      >
                        {label}
                      </button>
                    );
                  })()}
                </td>
              </tr>
            ))}

            {/* ファイル */}
            {files.map((item, index) => (
              <tr
                key={item.path}
                data-path={item.path}
                data-index={folders.length + index}
                className={`${selectedItems.has(item.path) ? "selected" : ""} ${focusedIndex === folders.length + index ? "focused" : ""}`}
                draggable
                onDragStart={(e) => handleDragStart(e, item)}
                onContextMenu={(e) => handleContextMenu(e, item)}
                onClick={(e) => {
                  onRequestFocus?.();
                  setFocusedSection('list');
                  setFocusedIndex(folders.length + index);
                  handleItemClick(e, item.path);
                  containerRef.current?.focus();
                }}
                onDoubleClick={() => handleFileClick(item)}
              >
                <td className="checkbox-col" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedItems.has(item.path)}
                    onChange={() => toggleSelect(item.path)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        if (selectedItems.has(item.path)) {
                          // 既に選択済みなら開く（ファイルを開く）
                          handleFileClick(item);
                        } else {
                          // 未選択なら選択する
                          toggleSelect(item.path);
                        }
                      }
                    }}
                  />
                </td>
                <td className="name-cell">
                  <div className="name-cell-content">
                    <button
                      className="row-copy-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        copyFullPath(item);
                      }}
                      title="フルパスをコピー"
                    >
                      <Copy size={12} />
                    </button>
                    <button
                      className="row-copy-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        copyLinkToClipboard(item.path, "file");
                      }}
                      title="リンクをコピー"
                    >
                      <Link size={12} />
                    </button>
                    <div className="name-info-wrapper">
                      <FileIcon name={item.name} type="file" className="icon" />
                      <span>{item.name}</span>
                    </div>
                  </div>
                </td>
                <td className="size-col">
                  <div className="cell-content">
                    {formatSize(item.size)}
                  </div>
                </td>
                <td className="date-col">
                  <div className="cell-content">
                    {formatFileDate(item.modified)}
                  </div>
                </td>
                <td className="git-col" />
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 右クリックメニュー */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          item={contextMenu.item}
          onClose={closeContextMenuAndRestoreFocus}
          currentPath={currentPath || ""}
          startRename={contextMenu.startRename}
          onOpenLink={() => {
            openLink(contextMenu.item.path, contextMenu.item.type);
            setContextMenu(null);
          }}
          onOpenHtmlPreview={isHtmlFile(contextMenu.item.name) ? () => handleOpenHtmlPreview(contextMenu.item) : undefined}
          onOpenImagePreview={isImageFile(contextMenu.item.name) ? () => {
            setPreviewImage(contextMenu.item);
            setImagePreviewOpen(true);
            setContextMenu(null);
          } : undefined}
          onOpenInCode={isProgramCodeFile(contextMenu.item.name) ? () => handleOpenProgramCodeInVSCode(contextMenu.item) : undefined}
          onOpenInEditor={isProgramCodeFile(contextMenu.item.name) ? () => handleOpenProgramCodeInEditor(contextMenu.item) : undefined}
          onExecute={isProgramCodeFile(contextMenu.item.name) ? () => handleExecuteProgramCode(contextMenu.item) : undefined}
          onDeleteRequest={handleRequestDeleteFromMenu}
          onRenamed={(oldPath, newPath) => {
            setSelectedItems((previous) => {
              if (!previous.has(oldPath)) return previous;
              const next = new Set(previous);
              next.delete(oldPath);
              next.add(newPath);
              return next;
            });
            setLastSelectedPath((previous) => previous === oldPath ? newPath : previous);
          }}
        />
      )}
      {paneContextMenu && (
        <PaneContextMenu
          x={paneContextMenu.x}
          y={paneContextMenu.y}
          onClose={() => setPaneContextMenu(null)}
          onCopyChecklist={copyVisibleItemsAsChecklist}
          onCopyBulletList={copyVisibleItemsAsBulletList}
          onOpenInAdjacentPane={
            onOpenInAdjacentPane && currentPath
              ? () => {
                  onOpenInAdjacentPane(currentPath);
                  showSuccess("隣のペインで開きました");
                  setPaneContextMenu(null);
                }
              : undefined
          }
        />
      )}

      {/* トースト通知 */}
      {/* トースト通知はApp.tsxのToastProviderで表示 */}

      {/* Markdownエディタモーダル */}
      {mdEditorOpen && (
        <Suspense fallback={null}>
          <MarkdownEditorModal
            isOpen={mdEditorOpen}
            onClose={handleCloseMdEditor}
            onSave={handleSaveMarkdown}
            fileName={mdEditorFileName}
            filePath={mdEditorFilePath}
            currentDirectory={currentPath}
            isSaving={mdEditorSaving}
            initialContent={mdEditorInitialContent}
          />
        </Suspense>
      )}


      {fileEditorOpen && (
        <Suspense fallback={null}>
          <FileEditorModal
            isOpen={fileEditorOpen}
            onClose={handleCloseFileEditor}
            onSave={handleSaveFileEditor}
            fileName={fileEditorFileName}
            filePath={fileEditorFilePath}
            isSaving={fileEditorSaving}
            initialContent={fileEditorInitialContent}
            initialLanguage={fileEditorLanguage}
          />

        </Suspense>
      )}

      {/* 画像プレビューモーダル */}
      <ImagePreviewModal
        isOpen={imagePreviewOpen}
        onClose={() => {
          setImagePreviewOpen(false);
          setPreviewImage(null);
        }}
        currentImage={previewImage}
        siblingImages={previewImage ? getImageSiblings(allSortedItems, previewImage.path).images : []}
        onNavigate={(nextImg) => setPreviewImage(nextImg)}
      />

      {/* プログレスモーダル */}
      <ProgressModal
        isOpen={progressModalOpen}
        taskId={progressTaskId}
        operationType={progressOperationType}
        onClose={() => {
          if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
          setProgressModalOpen(false);
          setProgressTaskId(null);
        }}
        onComplete={(result) => {
          if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
          const messages = { move: "移動完了", copy: "コピー完了", delete: "削除完了" };
          let msg = messages[progressOperationType];

          // 詳細がある場合は追加情報を表示してもよいが、ここではシンプルに
          if (result && result.fail_count > 0) {
            msg += ` (成功: ${result.success_count}, 失敗: ${result.fail_count})`;
          }

          showSuccess(msg);
          // 全パネルのファイル一覧を更新
          queryClient.invalidateQueries({ queryKey: ["files"] });

          // 完了後はモーダルを閉じる
          setProgressModalOpen(false);
          setProgressTaskId(null);
        }}
      />

      {/* 使い方モーダル */}
      <Modal
        isOpen={isHelpModalOpen}
        onClose={() => setIsHelpModalOpen(false)}
        title="使い方"
        width="min(760px, 94vw)"
      >
        <div className="help-modal-content">
          <section className="help-section">
            <h3>ショートカットキー</h3>
            <dl className="help-list">
              <div><dt>H</dt><dd>この使い方を表示</dd></div>
              <div><dt>A</dt><dd>左・真ん中ペインでフォルダ作成</dd></div>
              <div><dt>T</dt><dd>左・真ん中ペインで空のテキストファイル作成。ファイル名と拡張子を個別に指定</dd></div>
              <div><dt>O</dt><dd>左・真ん中ペインで現在のフォルダをFinder／Explorerで開く</dd></div>
              <div><dt>R</dt><dd>左・真ん中ペインのファイル一覧を再読み込み（更新）</dd></div>
              <div><dt>N</dt><dd>左・真ん中ペインのアクティブカーソル行をリネーム。ファイル名と拡張子を個別に指定</dd></div>
              <div><dt>L</dt><dd>左・真ん中ペインの表示フィルタを次へ切り替え</dd></div>
              <div><dt>Shift + L</dt><dd>左・真ん中ペインの表示フィルタを前へ切り替え</dd></div>
              <div><dt>D</dt><dd>左・真ん中ペインで、選択中またはカーソル位置のフォルダ配下を集計し、Date列に最新更新日を表示</dd></div>
              <div><dt>G</dt><dd>左・真ん中ペイン内の全フォルダを並列にGit確認。Git列は作業ツリー変更ならG、未PushならPush、未PullならPull、両方ならC、Git管理外または差分なしなら-を表示。GのクリックはVS Codeを開き、Push・Pull・Cのクリックはcd付きGitコマンドをクリップボードへコピー</dd></div>
              <div><dt>Ctrl/Cmd + P</dt><dd>左・真ん中ペインのフォルダ内 indexed 検索を表示</dd></div>
              <div><dt>Ctrl/Cmd + R</dt><dd>左・真ん中ペインのフォルダ履歴検索を表示</dd></div>
              <div><dt>Ctrl/Cmd + H</dt><dd>ホームフォルダへ移動</dd></div>
              <div><dt>Ctrl/Cmd + ← / ↓ / →</dt><dd>戻る / 戻る / 進む</dd></div>
              <div><dt>Ctrl/Cmd + ↑</dt><dd>上の階層へ移動</dd></div>
              <div><dt>Ctrl/Cmd + A</dt><dd>表示中のアイテムを全選択</dd></div>
              <div><dt>Ctrl/Cmd + Shift + A</dt><dd>選択解除</dd></div>
            </dl>
          </section>

          <section className="help-section">
            <h3>設定</h3>
            <dl className="help-list">
              <div><dt>Theme</dt><dd>Light / Dark の表示テーマを切り替え</dd></div>
              <div><dt>Text File Open</dt><dd>テキスト系ファイルをWebエディタで開くか外部アプリで開くかを選択</dd></div>
              <div><dt>Markdown Open</dt><dd>Markdownをアプリ内エディタで開くかObsidian連携を優先するかを選択</dd></div>
              <div><dt>Verify Checksum</dt><dd>移動・コピー時にチェックサム検証を行う安全寄りの設定</dd></div>
              <div><dt>Debug Mode</dt><dd>ファイル操作時の詳細ログやデバッグ情報を有効化</dd></div>
              <div><dt>API Timeout</dt><dd>ネットワークドライブなどのAPI待ち時間上限を秒数で設定</dd></div>
              <div><dt>Folder Date Max Items</dt><dd>Dで最新更新日を集計する際の最大項目数を設定</dd></div>
              <div><dt>Default Text Extension</dt><dd>Tでテキストファイルを作成する際の既定拡張子を設定</dd></div>
              <div><dt>リンク置換設定</dt><dd>古いサーバー名やUNCパスを新しいリンクへ置換するルールを編集</dd></div>
              <div><dt>Reset Storage</dt><dd>保存されたパス、履歴、テーマなどのローカル設定を初期化</dd></div>
              <div><dt>検索ペイン設定</dt><dd>インデックスサービスURLや監視パスを検索ペインの設定から管理</dd></div>
            </dl>
          </section>
        </div>
      </Modal>

      {/* フォルダ作成モーダル */}
      <InputModal
        isOpen={isCreateFolderModalOpen}
        onClose={() => setIsCreateFolderModalOpen(false)}
        title="フォルダ作成"
        message="新しいフォルダの名前を入力してください"
        placeholder="フォルダ名"
        onConfirm={handleConfirmCreateFolder}
        confirmLabel="作成"
      />

      {/* テキストファイル作成モーダル */}
      <TextFileCreateModal
        isOpen={isCreateTextFileModalOpen}
        onClose={() => setIsCreateTextFileModalOpen(false)}
        defaultExtension={defaultTextFileExtension}
        onConfirm={handleConfirmCreateTextFile}
      />

      {/* Markdown作成モーダル */}
      <InputModal
        isOpen={isCreateMarkdownModalOpen}
        onClose={() => setIsCreateMarkdownModalOpen(false)}
        title="Markdownファイル作成"
        message="Markdownファイル名を入力してください（.md拡張子は自動付与）"
        placeholder="ファイル名"
        onConfirm={handleConfirmCreateMarkdown}
        confirmLabel="エディタを開く"
      />

      {/* 削除確認モーダル */}
      <ConfirmationModal
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        title="削除の確認"
        message={
          itemsToDelete.size > 1
            ? `${itemsToDelete.size}件のアイテムを削除しますか？`
            : `「${Array.from(itemsToDelete)[0]?.split('/').pop()}」を削除しますか？`
        }
        onConfirm={handleConfirmDelete}
        confirmLabel="削除"
        confirmButtonClass="btn-danger"
      />
    </div>
  );
}
