/**
 * ファイル一覧コンポーネント（1ペイン分）
 * - 状態（現在のフォルダ・選択・カーソル・絞り込み）とキーボード操作・フォルダ移動をまとめる
 * - 各機能は fileList/ の部品とフックに分けている
 *   - 表示: FileListToolbar / FileListPathBar / FileListHistorySearch / FileListSearchBar / FileListTable
 *   - 削除・移動・コピー: useBatchFileOperations（FileListOperationModals）
 *   - 新規作成: useFileCreation（FileListCreateModals）、ファイルを開く: useFileOpener
 *   - ドラッグ&ドロップ: useFileListDragDrop、範囲選択: useDragSelect
 *   - セクション間のキーボード移動: useSectionFocus、Git 状態・最新更新日: useFolderInsights
 *   - 内蔵エディタ: useFileListEditors、外部アプリ: useExternalAppActions
 * - 画面操作テスト: FileList.ui.test.tsx
 */
import { logError } from "../utils/errorLog";
import { useState, useRef, useMemo, useEffect, useEffectEvent, useCallback } from "react";
import { useFiles } from "../hooks/useFiles";
import { copyFilesToClipboard } from "../api/clipboard";
import { useQueryClient } from "@tanstack/react-query";
import type { FileItem } from "../types/file";
import { buildAppPathUrl, buildFullPathUrl, getPathInfo, openInExplorer, getDownloadUrl, countFiles, getTestFolderPath, getObsidianDailyPath } from "../api/files";
import { useToast } from "../hooks/useToast";
import { ContextMenu } from "./ContextMenu";
import { PaneContextMenu } from "./PaneContextMenu";
import { FilterBar } from "./FilterBar";
import { EXT_FILTERS } from "./filterOptions";
import { IndexedFolderSearchModal } from "./IndexedFolderSearchModal";
import { FolderHistoryModal } from "./FolderHistoryModal";
import { getNetworkDrivePath, getDefaultBasePath } from "../config";
import { useOperationHistoryContext } from "../contexts/OperationHistoryContext";
import { useFolderHistory } from "../contexts/FolderHistoryContext";
import { sanitizePath, formatPathForClipboard } from "../utils/pathUtils";
import { formatItemsAsMarkdownChecklist, formatItemsAsMarkdownBulletList, formatItemsAsMarkdownLinkList } from "../utils/markdownChecklist";
import { shouldShowPaneContextMenu } from "../utils/paneContextMenuHelper";
import { isHtmlFile, isProgramCodeFile } from "../utils/codeFileActions";
import { isEditableEventTarget, matchesCmdOrCtrlShortcut, matchesPlainShortcut } from "../utils/globalShortcuts";
import type { IndexedFolderSearchItem } from "../api/fulltextIndexService";
import type { MarkdownOpenMode, TextFileOpenMode } from "../utils/editorPreferences";
import { isImageFile } from "../utils/imageUtils";
import { formatSearchMatchCount, getNextSearchHitIndex, formatSearchPosition } from "../utils/searchFilter";
import { ImagePreviewModal } from "./ImagePreviewModal";
import { errorMessage } from "../utils/errorMessage";
import { FileListHelpModal } from "./fileList/FileListHelpModal";
import { FileListToolbar } from "./fileList/FileListToolbar";
import { FileListPathBar } from "./fileList/FileListPathBar";
import { FileListHistorySearch } from "./fileList/FileListHistorySearch";
import { FileListSearchBar } from "./fileList/FileListSearchBar";
import { FileListTable } from "./fileList/FileListTable";
import { useExternalAppActions } from "./fileList/useExternalAppActions";
import { useFileListEditors } from "./fileList/useFileListEditors";
import { FileListEditorModals } from "./fileList/FileListEditorModals";
import { useBatchFileOperations } from "./fileList/useBatchFileOperations";
import { useSectionFocus } from "./fileList/useSectionFocus";
import { useFileOpener } from "./fileList/useFileOpener";
import { useFileCreation } from "./fileList/useFileCreation";
import { FileListCreateModals } from "./fileList/FileListCreateModals";
import { useFolderInsights } from "./fileList/useFolderInsights";
import { useFileListDragDrop } from "./fileList/useFileListDragDrop";
import { useDragSelect } from "./fileList/useDragSelect";
import { SelectionBox } from "./fileList/FileListSelectionBox";
import { FileListDeleteConfirmModal, FileListProgressModal } from "./fileList/FileListOperationModals";
import { fileListShared, setFileListClipboard } from "./fileList/sharedState";
import { filterAndSortItems } from "../utils/fileListFilter";
import { canGoBack, canGoForward, createNavigation, pushNavigation, stepNavigation, type NavigationState } from "../utils/navigationHistory";
import "./FileList.css";

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
  const [lastSelectedPath, setLastSelectedPath] = useState<string | null>(null);
  const { history: allHistory, addToHistory, removeFromHistory } = useFolderHistory();
  const [pathInput, setPathInput] = useState("");
  // 戻る/進むの履歴（カーソル位置と選択状態も保存する）
  const [navigation, setNavigation] = useState<NavigationState>({ entries: [], index: 0 });
  // ローカルフォーカス行インデックス（各ペインで独立）
  const [focusedIndex, setFocusedIndex] = useState<number>(0);
  // dキーで明示的に集計したフォルダだけを保持する（通常の一覧表示では走査しない）。
  const historyInputRef = useRef<HTMLInputElement>(null);
  const pathInputRef = useRef<HTMLTextAreaElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // セクション（ツールバー・パス・フィルタ・履歴検索・検索・一覧）間のキーボード移動
  const sections = useSectionFocus({
    containerRef,
    pathInputRef,
    historyInputRef,
    searchInputRef,
    onCopyPath: () => void copyCurrentPath(),
    onCopyLink: () => void copyLinkToClipboard(currentPath || "", "directory"),
    onEnterList: () => setFocusedIndex(0),
  });
  const { focusedSection, setFocusedSection, toolbarButtonIndex, pathButtonIndex, setToolbarButtonIndex, setFilterButtonIndex, setPathButtonIndex } = sections;

  // グローバルショートカット用Ref
  const isFocusedRef = useRef(isFocused);
  const initialPathRef = useRef(effectiveInitialPath);

  const [isIndexedSearchOpen, setIsIndexedSearchOpen] = useState(false);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const initialOpenHandledRef = useRef<string | null>(null);

  const [isHelpModalOpen, setIsHelpModalOpen] = useState(false);

  // 親ディレクトリに戻った時にフォーカスを当てるべきパス
  const [pendingFocusPath, setPendingFocusPath] = useState<string | null>(null);

  // パスが検証済みの場合のみuseFilesを呼び出す
  const { data, isLoading, error, refetch } = useFiles(isPathValidated && currentPath ? currentPath : "");

  // フォルダの Git 状態（G）・最新更新日（D）
  const insights = useFolderInsights({
    currentPath,
    allItems: data?.items ?? [],
    selectedItems,
    showSuccess,
    showError,
  });
  const { folderLatestModified } = insights;

  // 絞り込み・並べ替え（フォルダとファイルに分けて返す）
  const { folders, files } = useMemo(
    () => filterAndSortItems(data?.items ?? [], {
      searchQuery,
      isRegex,
      typeFilter,
      extFilter,
      sortKey,
      sortOrder,
      folderLatestModified,
    }),
    [data?.items, searchQuery, isRegex, typeFilter, extFilter, sortKey, sortOrder, folderLatestModified]
  );

  // 全アイテム（フィルタとソート適用後）をメモ化
  const allSortedItems = useMemo(() => [...folders, ...files], [folders, files]);

  // 現在のフォルダ内の全画像ファイル（フィルタに関わらずフォルダ内の全画像を安定して保持・不要な再生成を防止）
  const currentFolderImages = useMemo(() => {
    const sortedImages = allSortedItems.filter(
      (item) => item.type === "file" && isImageFile(item.name)
    );
    if (sortedImages.length > 0) return sortedImages;
    return (data?.items || []).filter(
      (item) => item.type === "file" && isImageFile(item.name)
    );
  }, [allSortedItems, data?.items]);



  const queryClient = useQueryClient();
  const {
    openMarkdownInExternalApp,
    handleOpenVSCode,
    handleOpenProgramCodeInVSCode,
    handleOpenProgramCodeInEditor,
    handleExecuteProgramCode,
    handleOpenHtmlPreview,
    handleOpenExplorer,
    handleOpenTrashFolder,
    handleOpenFullTextSearch,
    handleOpenJupyter,
    handleOpenAntigravity,
    handleOpenObsidian,
  } = useExternalAppActions({ currentPath, showError, showSuccess, closeContextMenu: () => setContextMenu(null) });
  const { addOperation } = useOperationHistoryContext();
  // ペインへキーボード操作を戻す（モーダルを閉じた後など）
  const restorePaneFocus = () => {
    onRequestFocus?.();
    window.setTimeout(() => {
      containerRef.current?.focus();
    }, 50);
  };
  const editors = useFileListEditors({ currentPath, showError, showSuccess, addOperation, refetch, restorePaneFocus });
  // ファイルを開く（種類と設定に応じて内蔵エディタ・画像プレビュー・外部アプリ）
  const fileOpener = useFileOpener({
    visibleItems: allSortedItems,
    folderImages: currentFolderImages,
    textFileOpenMode,
    markdownOpenMode,
    openMarkdownInExternalApp,
    openMarkdownEditor: editors.openMarkdownEditor,
    openFileEditor: editors.openFileEditor,
    showSuccess,
    showError,
  });
  // 新規作成（フォルダ・テキスト・Markdown・Excalidraw）
  const creation = useFileCreation({
    currentPath,
    showSuccess,
    showError,
    addOperation,
    refetch,
    openNewMarkdown: (fileName) => editors.openMarkdownEditor(fileName, null, ""),
    onCreated: () => {
      onRequestFocus?.();
      setTimeout(() => containerRef.current?.focus(), 50);
    },
  });

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

  // 初期パスの検証（初回のみ。useEffectEvent で最新の props を読む）
  const validateInitialPath = useEffectEvent(async () => {
      const targetPath = path || effectiveInitialPath;
      if (!targetPath) {
        setCurrentPath(effectiveInitialPath);
        setNavigation(createNavigation(effectiveInitialPath));
        setIsPathValidated(true);
        return;
      }

      try {
        const pathInfo = await getPathInfo(targetPath);

        if (pathInfo.type === "not_found") {
          showError(`指定されたパスが見つかりません: ${targetPath}`);
          // デフォルトパスにフォールバック
          setCurrentPath(effectiveInitialPath);
          setNavigation(createNavigation(effectiveInitialPath));
        } else if (pathInfo.type === "file" && pathInfo.parent) {
          // ファイルの場合は親フォルダ
          setCurrentPath(pathInfo.parent);
          setNavigation(createNavigation(pathInfo.parent));
        } else {
          // ディレクトリの場合
          setCurrentPath(targetPath);
          setNavigation(createNavigation(targetPath));
        }
      } catch (error) {
        console.error("初期パスの検証に失敗しました:", error);
        setCurrentPath(effectiveInitialPath);
        setNavigation(createNavigation(effectiveInitialPath));
      }
      setIsPathValidated(true);
  });

  useEffect(() => {
    void validateInitialPath();
  }, []);

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
        // ユーザーアクションによる移動の場合、今のフォルダの状態を保存して履歴を追加
        const snapshot = { focusedIndex, selectedItems };
        setNavigation((prev) => pushNavigation(prev, snapshot, finalPath));
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

  // グローバルショートカット（ペインにフォーカスがあるときだけ処理する）
  // useEffectEvent で常に最新の状態を参照し、リスナーの付け直しを描画ごとに行わない
  const handleGlobalKeyDown = useEffectEvent((e: KeyboardEvent) => {
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
      creation.openFolderModal();
      return;
    }

    if (matchesPlainShortcut(e, "t") && (panelId === "left" || panelId === "center")) {
      e.preventDefault();
      e.stopPropagation();
      creation.openTextFileModal();
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
  });

  useEffect(() => {
    const listener = (e: KeyboardEvent) => handleGlobalKeyDown(e);
    window.addEventListener("keydown", listener, true);
    return () => {
      window.removeEventListener("keydown", listener, true);
    };
  }, []);

  // 戻る / 進む（移動先のカーソル位置と選択状態を復元する）
  const stepHistory = (delta: -1 | 1) => {
    const step = stepNavigation(navigation, { focusedIndex, selectedItems }, delta);
    if (!step) return;
    setNavigation(step.state);
    setCurrentPath(step.target.path);
    setSelectedItems(new Set(step.target.selectedItems));
    setFocusedIndex(step.target.focusedIndex);
    setSearchQuery("");
  };
  const goBack = () => stepHistory(-1);
  const goForward = () => stepHistory(1);

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

  // 表示中の一覧を Markdown 形式でクリップボードにコピー（ペインの右クリックメニュー）
  const copyVisibleItems = async (format: (items: FileItem[]) => string, formatName: string) => {
    setPaneContextMenu(null);
    const markdown = format(allSortedItems);
    if (!markdown) {
      showError("コピーできる項目がありません");
      return;
    }
    try {
      await navigator.clipboard.writeText(markdown);
      showSuccess(`一覧を${formatName}形式でコピーしました`);
    } catch (err) {
      logError("一覧のコピーに失敗しました", err);
      showError("一覧のコピーに失敗しました");
    }
  };
  const copyVisibleItemsAsChecklist = () => copyVisibleItems(formatItemsAsMarkdownChecklist, "チェックボックス");
  const copyVisibleItemsAsBulletList = () => copyVisibleItems(formatItemsAsMarkdownBulletList, "箇条書き");
  const copyVisibleItemsAsLinkList = () => copyVisibleItems(formatItemsAsMarkdownLinkList, "リンク付きリスト");

  // フルパスをコピー
  const copyFullPath = async (item: FileItem) => {
    try {
      // item.pathは既に絶対パス
      const fullPath = item.path || currentPath || "";
      await navigator.clipboard.writeText(formatPathForClipboard(fullPath));
      showSuccess("パスをコピーしました");
      setContextMenu(null);
    } catch (err) {
      logError("コピーに失敗しました", err);
      showError("コピーに失敗しました");
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
    } catch (err) {
      logError("クリップボードの読み取りに失敗しました", err);
      showError("クリップボードの読み取りに失敗しました");
    }
  };

  // フルパスをコピー
  const copyCurrentPath = async () => {
    if (!currentPath) return;
    try {
      await navigator.clipboard.writeText(formatPathForClipboard(currentPath || "/"));
      showSuccess("パスをコピーしました");
    } catch (err) {
      logError("コピーに失敗しました", err);
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
    } catch (err) {
      logError("コピーに失敗しました", err);
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

  // テストフォルダを開く
  const handleOpenTestFolder = async () => {
    const result = await getTestFolderPath();
    if (result.success && result.path) {
      navigateToFolder(result.path);
    } else {
      showError(result.error || "テストフォルダのパスを取得できませんでした");
    }
  };

  const handleCloseIndexedSearch = () => {
    setIsIndexedSearchOpen(false);
    onRequestFocus?.();
    setTimeout(() => {
      containerRef.current?.focus();
    }, 50);
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
    } catch (e) {
      console.error("Failed to get obsidian daily path:", e);
      showError(`Obsidianの今日のフォルダを取得できませんでした: ${errorMessage(e)}`);
    }
  };

  // 削除・移動・コピー（確認モーダル・進捗モーダル・Undo 記録を含む）
  const operations = useBatchFileOperations({
    selectedItems,
    setSelectedItems,
    allSortedItems,
    showError,
    showSuccess,
    addOperation,
    restorePaneFocus,
  });

  // ドラッグ&ドロップ（アプリ内の移動・OS からのアップロード）
  const { dragOverPath, handleDragStart, handleDragOver, handleDragLeave, handleDrop, handlePanelDrop } = useFileListDragDrop({
    panelId,
    currentPath,
    visibleItems: allSortedItems,
    selectedItems,
    startMove: (srcPaths, destPath, asyncMode) => operations.startBatchTransfer('move', srcPaths, destPath, asyncMode),
    showSuccess,
    showError,
  });

  // 範囲選択（ラバーバンド選択）
  const { selectionBox, isShiftDragSelecting, handleMouseDown, handleMouseMove, handleMouseUp } = useDragSelect({
    containerRef,
    selectedItems,
    setSelectedItems,
  });

  // 親ディレクトリに戻った時のフォーカス復元（元いたフォルダの行にカーソルを合わせる）
  const focusPendingPath = useEffectEvent(() => {
    if (!pendingFocusPath || isLoading || allSortedItems.length === 0) return;
    const index = allSortedItems.findIndex(item => item.path === pendingFocusPath);
    if (index === -1) return;
    setFocusedIndex(index);
    // フォーカスしたアイテムをスクロールして表示
    requestAnimationFrame(() => {
      const row = containerRef.current?.querySelector(`.file-table tbody tr[data-index="${index}"]`);
      row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    setPendingFocusPath(null);
  });

  useEffect(() => {
    focusPendingPath();
  }, [pendingFocusPath, isLoading, allSortedItems]);

  // 検索クエリ入力時に先頭ヒットへフォーカス・選択を合わせる
  const focusFirstSearchHit = useEffectEvent((query: string) => {
    if (query.trim() && allSortedItems.length > 0) {
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
  });

  useEffect(() => {
    focusFirstSearchHit(searchQuery);
  }, [searchQuery]);

  // 検索バーで Enter / Shift+Enter: 次/前のヒットへ。検索語がなければ一覧へ移る
  const handleSearchEnter = (backwards: boolean) => {
    if (searchQuery.trim() && allSortedItems.length > 0) {
      const nextIdx = getNextSearchHitIndex(focusedIndex, allSortedItems.length, backwards ? "prev" : "next");
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
  };

  // 右クリックメニューを閉じてペインにフォーカスを戻す
  const closeContextMenuAndRestoreFocus = () => {
    setContextMenu(null);
    onRequestFocus?.();
    requestAnimationFrame(() => {
      containerRef.current?.focus({ preventScroll: true });
    });
  };
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

  // ファイルクリックハンドラ（ファイルを開く処理）
  // バックエンドの/api/open/smartでファイル種類判定・処理を行う
  const handleFileClick = async (item: FileItem) => {
    await fileOpener.openPath(item.path, item.name);
  };

  const handleIndexedSearchSelect = async (item: IndexedFolderSearchItem) => {
    await fileOpener.openPath(item.full_path, item.file_name);
  };

  // ---- 以下の副作用は、上で定義した移動・ファイルを開く処理を使う ----

  // 外部からのパス変更に同期（パスチェック付き）
  const syncPathFromProp = useEffectEvent((nextPath: string | undefined) => {
    // パスが変更され、現在のパスと異なる場合は移動
    // navigateToFolderを使うことで履歴（戻るボタン）が正しく機能するようにする
    if (nextPath && nextPath !== currentPath) {
      void navigateToFolder(nextPath);
    }
  });

  useEffect(() => {
    syncPathFromProp(path);
  }, [path]);

  // パス変更時の履歴更新
  const onCurrentPathChanged = useEffectEvent((changedPath: string) => {
    setPathInput(changedPath);
    addToHistory(changedPath);
    // 外部に通知
    onPathChange?.(changedPath);
  });

  useEffect(() => {
    if (currentPath) {
      onCurrentPathChanged(currentPath);
    }
  }, [currentPath, panelId]);

  // URL パラメータで指定されたファイルを初回だけ開く
  const openInitialFile = useEffectEvent((filePath: string, openMode: typeof initialOpenMode) => {
    const fileName = filePath.split(/[/\\]/).pop() || filePath;
    void fileOpener.openPath(filePath, fileName, {
      forceWebEditor: openMode === "web",
    }).finally(() => {
      onInitialOpenHandled?.();
    });
  });

  useEffect(() => {
    if (!initialOpenFilePath || !isPathValidated || !currentPath) {
      return;
    }
    if (initialOpenHandledRef.current === initialOpenFilePath) {
      return;
    }

    initialOpenHandledRef.current = initialOpenFilePath;
    openInitialFile(initialOpenFilePath, initialOpenMode);
  }, [currentPath, initialOpenFilePath, initialOpenMode, isPathValidated]);

  // フォーカスが当たった時に、直前に操作していた欄（パス・検索・履歴・一覧）へフォーカスを戻す
  const restoreFocusTarget = useEffectEvent(() => {
    if (!containerRef.current) return;
    if (focusedSection === 'path' && pathButtonIndex === 2) {
      pathInputRef.current?.focus();
    } else if (focusedSection === 'search') {
      searchInputRef.current?.focus();
    } else if (focusedSection === 'history') {
      historyInputRef.current?.focus();
    } else {
      containerRef.current.focus();
    }
  });

  useEffect(() => {
    if (isFocused) {
      restoreFocusTarget();
    }
  }, [isFocused]);

  // マウスの戻る/進むボタンのハンドリング
  const onMouseNavigationButton = useEffectEvent((e: MouseEvent) => {
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
  });

  useEffect(() => {
    // 左ペインまたは中央ペインのみ有効
    if (!isFocused || (panelId !== 'left' && panelId !== 'center')) {
      return;
    }

    const handleMouseUp = (e: MouseEvent) => onMouseNavigationButton(e);

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
  }, [isFocused, panelId]);

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

    // ツールバー・パス・フィルタ・履歴検索・検索セクションの操作
    if (sections.handleSectionKeyDown(e)) return;

    if (focusedSection === 'list') {
      // ↑↓: カーソル移動（Shift 押下中は連続選択。先頭で↑を押したら検索セクションへ）
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();

        if (e.key === 'ArrowUp' && focusedIndex === 0) {
          setFocusedSection('search');
          searchInputRef.current?.focus();
          return;
        }

        const newIndex = e.key === 'ArrowUp'
          ? focusedIndex - 1
          : Math.min(allSortedItems.length - 1, focusedIndex + 1);

        if (e.shiftKey) {
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
        setFileListClipboard({ paths: Array.from(selectedItems), op: 'copy' });

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
        setFileListClipboard({ paths: Array.from(selectedItems), op: 'move' });

        showSuccess(`${selectedItems.size}件を切り取りました`);
      }
      return;
    }

    // ペースト (Ctrl + V)
    if (isCmdOrCtrl && e.key.toLowerCase() === 'v') {
      if (fileListShared.clipboard && fileListShared.clipboard.paths.length > 0) {
        if (currentPath) {
          e.preventDefault();
          e.stopPropagation();

          // ファイル数をカウントして非同期モードかどうかを判定
          const clipboard = fileListShared.clipboard;
          countFiles(clipboard.paths, 3).then((countResult) => {
            operations.startBatchTransfer(clipboard.op, clipboard.paths, currentPath, countResult.total_count >= 3);
          }).catch((err) => {
            console.error("Failed to count files:", err);
            showError(`ファイル数カウントに失敗しました: ${errorMessage(err)}`);
          });
        }
      }
    }

    // Git状態確認 (G)
    if (!isCmdOrCtrl && e.key.toLowerCase() === 'g') {
      if (panelId === 'left' || panelId === 'center') {
        e.preventDefault();
        e.stopPropagation();
        void insights.checkGitStatuses();
      }
      return;
    }

    // フォルダ最新日時の計算 (D)
    if (!isCmdOrCtrl && e.key.toLowerCase() === 'd') {
      if (panelId === 'left' || panelId === 'center') {
        e.preventDefault();
        e.stopPropagation();
        void insights.calculateFolderLatestModified(allSortedItems, focusedIndex);
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
        operations.handleDeleteSelected();
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

  const handleSort = (key: "name" | "size" | "date") => {
    if (sortKey === key) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortOrder("asc");
    }
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
      <SelectionBox box={selectionBox} />
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
      <FileListToolbar
        isSectionFocused={focusedSection === 'toolbar'}
        focusedButtonIndex={toolbarButtonIndex}
        canGoBack={canGoBack(navigation)}
        canGoForward={canGoForward(navigation)}
        canGoUp={!!currentPath}
        showPaneSearchButtons={panelId === "left" || panelId === "center"}
        showObsidianButton={!!currentPath && currentPath.toLowerCase().includes('obsidian')}
        hasSelection={selectedItems.size > 0}
        onBack={goBack}
        onForward={goForward}
        onUp={navigateUp}
        onHome={() => navigateToFolder(initialPath ?? getDefaultBasePath())}
        onNetworkDrive={() => navigateToFolder(getNetworkDrivePath())}
        onOpenFromClipboard={openFromClipboard}
        onDownload={handleDownload}
        onOpenVSCode={handleOpenVSCode}
        onOpenAntigravity={handleOpenAntigravity}
        onOpenObsidianDaily={handleOpenObsidianDaily}
        onOpenExplorer={handleOpenExplorer}
        onFocusSearch={() => {
          setFocusedSection("search");
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        }}
        onOpenFullTextSearch={handleOpenFullTextSearch}
        onOpenJupyter={handleOpenJupyter}
        onOpenExcalidraw={() => void creation.createExcalidraw()}
        onCreateMarkdown={creation.openMarkdownModal}
        onOpenObsidian={handleOpenObsidian}
        onCreateFolder={creation.openFolderModal}
        onDeleteSelected={operations.handleDeleteSelected}
        onRefresh={handleRefresh}
        onOpenTestFolder={handleOpenTestFolder}
        onOpenTrash={handleOpenTrashFolder}
      />

      {/* パス入力 */}
      <FileListPathBar
        inputRef={pathInputRef}
        value={pathInput}
        onChange={setPathInput}
        onSubmit={handlePathSubmit}
        onCopyPath={copyCurrentPath}
        onCopyLink={() => copyLinkToClipboard(currentPath || "", "directory")}
        onFocusFilterBar={() => {
          containerRef.current?.focus();
          setFocusedSection('filter');
        }}
        onFocusToolbar={() => {
          containerRef.current?.focus();
          setFocusedSection('toolbar');
          setToolbarButtonIndex(0);
        }}
        onFocusPathButtons={() => {
          containerRef.current?.focus();
          setFocusedSection('path');
          setPathButtonIndex(1);
        }}
      />

      {/* フィルタバー */}
      <FilterBar
        typeFilter={typeFilter}
        extFilter={extFilter}
        onTypeChange={setTypeFilter}
        onExtChange={setExtFilter}
        isFocused={focusedSection === 'filter'}
      />

      {/* 履歴検索バー */}
      <FileListHistorySearch
        inputRef={historyInputRef}
        onSelectPath={(p, viaKeyboard) => {
          if (viaKeyboard) {
            onRequestFocus?.();
            void navigateToFolder(p);
            // フォーカスを一覧に戻す
            containerRef.current?.focus();
            setFocusedSection('list');
            setFocusedIndex(0);
          } else {
            void navigateToFolder(p);
          }
        }}
        onFocusFilterBar={() => {
          containerRef.current?.focus();
          setFocusedSection('filter');
        }}
        onFocusSearchBar={() => {
          containerRef.current?.focus();
          setFocusedSection('search');
          searchInputRef.current?.focus();
        }}
      />

      {/* 検索バー */}
      <FileListSearchBar
        inputRef={searchInputRef}
        query={searchQuery}
        onQueryChange={setSearchQuery}
        isRegex={isRegex}
        onToggleRegex={() => setIsRegex(!isRegex)}
        badgeText={searchQuery.trim()
          ? formatSearchPosition(focusedIndex, allSortedItems.length)
          : formatSearchMatchCount(allSortedItems.length, data?.items?.length || 0)}
        onEscape={() => {
          setSearchQuery("");
          setFocusedSection('list');
          setFocusedIndex(0);
          containerRef.current?.focus();
        }}
        onFocusList={() => {
          containerRef.current?.focus();
          setFocusedSection('list');
          setFocusedIndex(0);
        }}
        onFocusHistorySearch={() => {
          containerRef.current?.focus();
          setFocusedSection('history');
          historyInputRef.current?.focus();
        }}
        onEnter={handleSearchEnter}
      />

      {/* ファイル一覧テーブル */}
      <FileListTable
        folders={folders}
        files={files}
        selectedItems={selectedItems}
        focusedIndex={focusedIndex}
        dragOverPath={dragOverPath}
        sortKey={sortKey}
        sortOrder={sortOrder}
        folderLatestModified={folderLatestModified}
        folderLatestModifiedLoading={insights.folderLatestModifiedLoading}
        gitStatuses={insights.gitStatuses}
        isGitStatusLoading={insights.isGitStatusLoading}
        onSort={handleSort}
        onHeaderContextMenu={handlePaneContextMenu}
        onRowClick={(e, item, index) => {
          onRequestFocus?.();
          setFocusedSection('list');
          setFocusedIndex(index);
          handleItemClick(e, item.path);
          containerRef.current?.focus();
        }}
        onRowContextMenu={handleContextMenu}
        onToggleSelect={toggleSelect}
        onOpenFolder={(p) => navigateToFolder(p)}
        onOpenFile={handleFileClick}
        onCopyFullPath={copyFullPath}
        onCopyLink={copyLinkToClipboard}
        onGitStatusAction={(item) => void insights.handleGitStatusAction(item)}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      />

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
            fileOpener.openImage(contextMenu.item);
            setContextMenu(null);
          } : undefined}
          onOpenFolderImages={() => {
            fileOpener.openFolderImages(contextMenu.item);
            setContextMenu(null);
          }}
          onOpenInCode={isProgramCodeFile(contextMenu.item.name) ? () => handleOpenProgramCodeInVSCode(contextMenu.item) : undefined}
          onOpenInEditor={isProgramCodeFile(contextMenu.item.name) ? () => handleOpenProgramCodeInEditor(contextMenu.item) : undefined}
          onExecute={isProgramCodeFile(contextMenu.item.name) ? () => handleExecuteProgramCode(contextMenu.item) : undefined}
          onDeleteRequest={operations.handleRequestDeleteFromMenu}
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
          onOpenImageViewer={() => {
            fileOpener.openFolderImages();
            setPaneContextMenu(null);
          }}
          onCopyChecklist={copyVisibleItemsAsChecklist}
          onCopyBulletList={copyVisibleItemsAsBulletList}
          onCopyLinkList={copyVisibleItemsAsLinkList}
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

      {/* 内蔵エディタ（Markdown / テキスト・コード） */}
      <FileListEditorModals editors={editors} currentDirectory={currentPath} />

      {/* 画像プレビューモーダル */}
      <ImagePreviewModal
        isOpen={fileOpener.imagePreview.isOpen}
        onClose={fileOpener.imagePreview.close}
        currentImage={fileOpener.imagePreview.image}
        siblingImages={currentFolderImages}
        folderPath={currentPath || ""}
        onNavigate={fileOpener.imagePreview.navigate}
        initialMode={fileOpener.imagePreview.mode}
      />

      {/* 進捗モーダル（非同期の移動・コピー・削除） */}
      <FileListProgressModal operations={operations} />

      {/* 使い方モーダル */}
      <FileListHelpModal isOpen={isHelpModalOpen} onClose={() => setIsHelpModalOpen(false)} />

      {/* フォルダ作成モーダル */}
      {/* 新規作成ダイアログ */}
      <FileListCreateModals creation={creation} defaultTextFileExtension={defaultTextFileExtension} />

      {/* 削除確認モーダル */}
      <FileListDeleteConfirmModal operations={operations} />
    </div>
  );
}
