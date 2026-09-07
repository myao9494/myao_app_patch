/**
 * ファイルマネージャー メインアプリケーション
 * 3カラム構成: 左ペイン + 右ペイン + 検索パネル
 * URLクエリパラメータ ?path=/some/folder でフォルダを指定可能
 * Windowsネットワークフォルダ（UNCパス）対応
 * ファイルパスが指定された場合は親フォルダにリダイレクト
 * #api-test でAPIテストページを表示
 *
 * デフォルトパスはバックエンドの環境変数（FILE_MANAGER_BASE_DIR）から取得
 */
import { useState, useCallback, useEffect, lazy, Suspense, useRef } from "react";
import { Menu, Trash2, Sun, Moon, FlaskConical, Home, Link, Link2, ArrowRightLeft, CheckCircle2, AlertTriangle, Loader2, Play } from "lucide-react";
import { resolveSyncedPath } from "./utils/syncNavigation";
import { FileList } from "./components/FileList";
import { FileSearch } from "./components/FileSearch";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Modal } from "./components/Modal";
import { getPathInfo } from "./api/files";
import { useToast } from "./hooks/useToast";
import { getConfig, getDefaultBasePath, saveEditorPreferences, API_BASE_URL } from "./config";
import { OperationHistoryProvider, useOperationHistoryContext } from "./contexts/OperationHistoryContext";
import { FolderHistoryProvider } from "./contexts/FolderHistoryContext";
import { ToastProvider } from "./contexts/ToastContext";
import { ZoomProvider, useZoomContext } from "./contexts/ZoomContext";
import {
  isEditableEventTarget,
  isModalEventTarget,
  matchesCmdOrCtrlShiftShortcut,
} from "./utils/globalShortcuts";
import {
  type MarkdownOpenMode,
  type TextFileOpenMode,
} from "./utils/editorPreferences";
import "./App.css";

const ApiTestPage = lazy(() =>
  import("./pages/ApiTestPage").then((module) => ({ default: module.ApiTestPage }))
);
const ServerTerminal = lazy(() =>
  import("./components/ServerTerminal").then((module) => ({ default: module.ServerTerminal }))
);

const STORAGE_KEYS = {
  LEFT_PATH: 'file_manager_left_path',
  CENTER_PATH: 'file_manager_center_path',
  THEME: 'file_manager_theme',
  VERIFY_CHECKSUM: 'file_manager_verify_checksum',
  DEBUG_MODE: 'file_manager_debug_mode',
  SYNC_NAVIGATION: 'file_manager_sync_navigation',
};

// フォーカス可能なペインの型
type FocusedPane = "left" | "center" | "right" | "terminal" | null;

interface TerminalFocusRequest {
  cwd: string | null;
  seq: number;
}

function AppContent() {
  const { showError, showSuccess } = useToast();
  const { zoomLevel, zoomIn, zoomOut, resetZoom } = useZoomContext();
  const { undo, redo, canUndo, canRedo } = useOperationHistoryContext();
  const [showMenu, setShowMenu] = useState(false);
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem(STORAGE_KEYS.THEME) || 'light';
  });
  // 左右ペイン同期移動設定
  const [isSyncNavigation, setIsSyncNavigation] = useState(() => {
    return localStorage.getItem(STORAGE_KEYS.SYNC_NAVIGATION) === 'true';
  });
  // チェックサム検証設定（移動時の安全性用）
  const [verifyChecksum, setVerifyChecksum] = useState(() => {
    return localStorage.getItem(STORAGE_KEYS.VERIFY_CHECKSUM) === 'true';
  });
  // デバッグモード設定（ログ出力用）
  const [debugMode, setDebugMode] = useState(() => {
    return localStorage.getItem(STORAGE_KEYS.DEBUG_MODE) === 'true';
  });
  const [locationSearch, setLocationSearch] = useState(() => window.location.search);
  const initialSavedLeftPathRef = useRef(localStorage.getItem(STORAGE_KEYS.LEFT_PATH));
  const initialSavedCenterPathRef = useRef(localStorage.getItem(STORAGE_KEYS.CENTER_PATH));
  const [textFileOpenMode, setTextFileOpenMode] = useState<TextFileOpenMode>("web");
  const [markdownOpenMode, setMarkdownOpenMode] = useState<MarkdownOpenMode>("web");
  const [apiTimeout, setApiTimeout] = useState<number>(10);
  const [folderLatestModifiedMaxEntries, setFolderLatestModifiedMaxEntries] = useState<number>(20_000);
  const [defaultTextFileExtension, setDefaultTextFileExtension] = useState("txt");
  const [pathMappings, setPathMappings] = useState<Record<string, string>>({});
  const [showPathMapModal, setShowPathMapModal] = useState(false);
  const [pathMapJsonStr, setPathMapJsonStr] = useState("");
  const [pathMapError, setPathMapError] = useState<string | null>(null);
  const [editorPreferencesLoaded, setEditorPreferencesLoaded] = useState(false);
  const [configuredDefaultPath, setConfiguredDefaultPath] = useState<string | null>(null);

  // 起動時にバックエンドから設定を取得（キャッシュに保存）
  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;

    const loadConfig = () => {
      getConfig().then((config) => {
        if (cancelled) return;
        if (!config.loadedFromServer) {
          retryTimer = window.setTimeout(loadConfig, 2_000);
          return;
        }

        setTextFileOpenMode(config.textFileOpenMode);
        setMarkdownOpenMode(config.markdownOpenMode);
        setApiTimeout(config.apiTimeout);
        setFolderLatestModifiedMaxEntries(config.folderLatestModifiedMaxEntries);
        setDefaultTextFileExtension(config.defaultTextFileExtension);
        setPathMappings(config.pathMappings || {});
        setConfiguredDefaultPath(config.defaultBasePath);
        setEditorPreferencesLoaded(true);
      }).catch((error: unknown) => {
        console.error("設定取得エラー:", error);
        if (!cancelled) {
          retryTimer = window.setTimeout(loadConfig, 2_000);
        }
      });
    };

    loadConfig();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => {
    const syncLocationSearch = () => {
      setLocationSearch(window.location.search);
    };

    window.addEventListener("popstate", syncLocationSearch);
    window.addEventListener("pageshow", syncLocationSearch);
    window.addEventListener("focus", syncLocationSearch);

    return () => {
      window.removeEventListener("popstate", syncLocationSearch);
      window.removeEventListener("pageshow", syncLocationSearch);
      window.removeEventListener("focus", syncLocationSearch);
    };
  }, []);

  // フォーカス中のペイン（各ペインは独自のフォーカス行を持つ）
  // 子コンポーネント（FileList/FileSearch）がisFocusedに基づいてDOMフォーカスを管理する
  const [focusedPane, setFocusedPane] = useState<FocusedPane>("left");
  const lastInactivePaneRef = useRef<Exclude<FocusedPane, null>>("left");
  const [terminalFocusRequest, setTerminalFocusRequest] = useState<TerminalFocusRequest>({
    cwd: null,
    seq: 0,
  });
  const [globalFulltextShortcutSeq, setGlobalFulltextShortcutSeq] = useState(0);

  // テーマを適用
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEYS.THEME, theme);
  }, [theme]);

  // チェックサム設定を保存
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.VERIFY_CHECKSUM, String(verifyChecksum));
  }, [verifyChecksum]);

  // デバッグモード設定を保存
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.DEBUG_MODE, String(debugMode));
  }, [debugMode]);

  // 左右同期移動設定を保存
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.SYNC_NAVIGATION, String(isSyncNavigation));
  }, [isSyncNavigation]);

  useEffect(() => {
    if (!editorPreferencesLoaded) {
      return;
    }

    saveEditorPreferences(
      textFileOpenMode,
      markdownOpenMode,
      apiTimeout,
      pathMappings,
      folderLatestModifiedMaxEntries,
      defaultTextFileExtension,
    ).catch((error) => {
      console.error("設定保存エラー:", error);
      showError("設定の保存に失敗しました");
    });
  }, [editorPreferencesLoaded, markdownOpenMode, apiTimeout, showError, textFileOpenMode, pathMappings, folderLatestModifiedMaxEntries, defaultTextFileExtension]);

  const [viewMode, setViewMode] = useState<"form" | "json">("form");
  const [formRules, setFormRules] = useState<{
    id: string;
    newServer: string;
    oldServers: string;
    testStatus?: "idle" | "testing" | "ok" | "error";
    testError?: string | null;
  }[]>([]);
  const [isTestingConnections, setIsTestingConnections] = useState(false);

  const handleOpenPathMapModal = () => {
    const rules = Object.entries(pathMappings).map(([newServer, oldServers], idx) => ({
      id: `${idx}-${Date.now()}`,
      newServer,
      oldServers,
      testStatus: "idle" as const,
      testError: null as string | null
    }));
    setFormRules(rules.length > 0 ? rules : [{ id: `0-${Date.now()}`, newServer: "", oldServers: "", testStatus: "idle", testError: null }]);
    setPathMapJsonStr(JSON.stringify(pathMappings, null, 2));
    setPathMapError(null);
    setViewMode("form");
    setShowPathMapModal(true);
    setShowMenu(false);
  };

  const handleAddFormRule = () => {
    setFormRules((prev) => [...prev, { id: `${prev.length}-${Date.now()}`, newServer: "", oldServers: "", testStatus: "idle", testError: null }]);
  };

  const handleTestConnections = async () => {
    let currentRules = [...formRules];
    
    // JSONモードの場合は同期
    if (viewMode === "json") {
      try {
        const parsed = JSON.parse(pathMapJsonStr);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("JSONはオブジェクト形式である必要があります。");
        }
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof key !== "string" || typeof value !== "string") {
            throw new Error("キーと値はすべて文字列である必要があります。");
          }
        }
        const rules = Object.entries(parsed as Record<string, string>).map(([newServer, oldServers], idx) => ({
          id: `${idx}-${Date.now()}`,
          newServer,
          oldServers,
          testStatus: "idle" as const,
          testError: null
        }));
        currentRules = rules.length > 0 ? rules : [{ id: `0-${Date.now()}`, newServer: "", oldServers: "", testStatus: "idle", testError: null }];
        setFormRules(currentRules);
        setPathMapError(null);
        setViewMode("form");
      } catch (e: any) {
        setPathMapError(e.message || "無効なJSONフォーマットです");
        showError("JSONにエラーがあるため接続テストを実行できません。");
        return;
      }
    }

    const targets = currentRules.map((r) => r.newServer.trim()).filter(Boolean);
    if (targets.length === 0) {
      showError("テスト対象の新サーバーアドレスが入力されていません。");
      return;
    }

    setIsTestingConnections(true);
    setFormRules((prev) =>
      prev.map((r) =>
        r.newServer.trim() ? { ...r, testStatus: "testing", testError: null } : r
      )
    );

    try {
      const response = await fetch(`${API_BASE_URL}/api/config/test-connections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: targets }),
      });

      if (!response.ok) {
        throw new Error("接続確認リクエストに失敗しました");
      }

      const results = await response.json();
      setFormRules((prev) =>
        prev.map((r) => {
          const key = r.newServer.trim();
          if (!key) return r;

          const res = results[key];
          if (res && res.alive) {
            return { ...r, testStatus: "ok", testError: null };
          } else {
            return {
              ...r,
              testStatus: "error",
              testError: res ? res.error : "接続に失敗しました"
            };
          }
        })
      );
      showSuccess("接続テストが完了しました");
    } catch (error: any) {
      console.error("接続テストエラー:", error);
      showError(error.message || "接続テスト中にエラーが発生しました");
      setFormRules((prev) =>
        prev.map((r) =>
          r.newServer.trim() ? { ...r, testStatus: "error", testError: "テスト失敗" } : r
        )
      );
    } finally {
      setIsTestingConnections(false);
    }
  };

  const handleRemoveFormRule = (id: string) => {
    setFormRules((prev) => {
      const filtered = prev.filter((r) => r.id !== id);
      return filtered.length > 0 ? filtered : [{ id: `0-${Date.now()}`, newServer: "", oldServers: "" }];
    });
  };

  const handleUpdateFormRule = (id: string, field: "newServer" | "oldServers", value: string) => {
    setFormRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, [field]: value } : r))
    );
  };

  const syncFormToJson = () => {
    const mappings: Record<string, string> = {};
    formRules.forEach((r) => {
      const key = r.newServer.trim();
      const val = r.oldServers.trim();
      if (key) {
        mappings[key] = val;
      }
    });
    setPathMapJsonStr(JSON.stringify(mappings, null, 2));
    setPathMapError(null);
  };

  const syncJsonToForm = (): boolean => {
    try {
      const parsed = JSON.parse(pathMapJsonStr);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("JSONはオブジェクト形式（{ \"新サーバー\": \"旧サーバー\" }）である必要があります。");
      }
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof key !== "string" || typeof value !== "string") {
          throw new Error("キーと値はすべて文字列である必要があります。");
        }
      }
      const rules = Object.entries(parsed as Record<string, string>).map(([newServer, oldServers], idx) => ({
        id: `${idx}-${Date.now()}`,
        newServer,
        oldServers
      }));
      setFormRules(rules.length > 0 ? rules : [{ id: `0-${Date.now()}`, newServer: "", oldServers: "" }]);
      setPathMapError(null);
      return true;
    } catch (e: any) {
      setPathMapError(e.message || "無効なJSONフォーマットです");
      return false;
    }
  };

  const handleToggleViewMode = (mode: "form" | "json") => {
    if (mode === "json") {
      syncFormToJson();
      setViewMode("json");
    } else {
      const success = syncJsonToForm();
      if (success) {
        setViewMode("form");
      }
    }
  };

  const handleSavePathMap = () => {
    let mappings: Record<string, string> = {};
    if (viewMode === "form") {
      formRules.forEach((r) => {
        const key = r.newServer.trim();
        const val = r.oldServers.trim();
        if (key) {
          mappings[key] = val;
        }
      });
    } else {
      try {
        const parsed = JSON.parse(pathMapJsonStr);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("JSONはオブジェクト形式である必要があります。");
        }
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof key !== "string" || typeof value !== "string") {
            throw new Error("キーと値はすべて文字列である必要があります。");
          }
        }
        mappings = parsed;
      } catch (e: any) {
        setPathMapError(e.message || "無効なJSONフォーマットです");
        return;
      }
    }

    setPathMappings(mappings);
    setShowPathMapModal(false);
    showSuccess("リンク置換設定を保存しました");
  };

  // ハッシュルーティング（APIテストページ）
  const [currentPage, setCurrentPage] = useState(() => {
    return window.location.hash === '#api-test' ? 'api-test' : 'main';
  });

  useEffect(() => {
    const handleHashChange = () => {
      setCurrentPage(window.location.hash === '#api-test' ? 'api-test' : 'main');
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // localStorageの初期化
  const handleResetSettings = () => {
    if (window.confirm("設定（保存されたパス、履歴、テーマなど）を初期化しますか？")) {
      localStorage.clear();
      window.location.href = window.location.pathname; // パラメータなしでリロード
    }
  };

  // URLクエリパラメータからパスを読み取る
  const searchParams = new URLSearchParams(locationSearch);
  const pathFromUrl = searchParams.get('path');
  const openFileFromUrl = searchParams.get('open_file');
  const openModeFromUrl = searchParams.get('open_mode');

  // パスが指定されている場合はデコードして使用、なければデフォルト
  const defaultPath = pathFromUrl
    ? decodeURIComponent(pathFromUrl)
    : getDefaultBasePath();

  const [leftPath, setLeftPath] = useState(() => {
    // 1. URLパラメータを最優先
    if (pathFromUrl) return decodeURIComponent(pathFromUrl);
    // 2. localStorage
    const saved = initialSavedLeftPathRef.current;
    if (saved) return saved;
    // 3. デフォルト（バックエンドから取得した値）
    return getDefaultBasePath();
  });

  useEffect(() => {
    if (!pathFromUrl) {
      return;
    }

    const decodedPath = decodeURIComponent(pathFromUrl);
    setLeftPath((prevPath) => (prevPath === decodedPath ? prevPath : decodedPath));
  }, [pathFromUrl]);

  // URLパラメータがファイルの場合、親フォルダにリダイレクト
  // 存在しないパスの場合はエラーメッセージを表示してURLパラメータをクリア
  useEffect(() => {
    const checkAndRedirectIfFile = async () => {
      if (!pathFromUrl) return;

      try {
        const decodedPath = decodeURIComponent(pathFromUrl);
        const pathInfo = await getPathInfo(decodedPath);

        if (pathInfo.type === "not_found") {
          // 存在しないパスの場合、エラーメッセージを表示してURLパラメータをクリア
          showError(`指定されたパスが見つかりません: ${decodedPath}\n\nデフォルトのパスに移動します。`);

          // URLパラメータを削除してリロード
          const newUrl = new URL(window.location.href);
          newUrl.searchParams.delete('path');
          window.history.replaceState({}, '', newUrl.toString());

          // デフォルトパスに設定
          setLeftPath(getDefaultBasePath());
        } else if (pathInfo.type === "file" && pathInfo.parent) {
          // ファイルの場合、親フォルダのパスでURLを書き換えてリロード
          const newUrl = new URL(window.location.href);
          newUrl.searchParams.set('path', pathInfo.parent);
          window.location.href = newUrl.toString();
        }
      } catch (error) {
        console.error("パス情報の取得に失敗しました:", error);
        // エラーの場合、エラーメッセージを表示してURLパラメータをクリア
        showError(`パス情報の取得に失敗しました。\n\nデフォルトのパスに移動します。`);

        const newUrl = new URL(window.location.href);
        newUrl.searchParams.delete('path');
        window.history.replaceState({}, '', newUrl.toString());
        setLeftPath(getDefaultBasePath());
      }
    };

    checkAndRedirectIfFile();
  }, [pathFromUrl]);

  const [centerPath, setCenterPath] = useState(() => {
    // 中央ペインはURLパラメータを無視し、localStorage またはデフォルト値を使用
    const saved = initialSavedCenterPathRef.current;
    if (saved) return saved;
    return getDefaultBasePath();
  });

  useEffect(() => {
    if (!configuredDefaultPath) return;
    if (!pathFromUrl && initialSavedLeftPathRef.current === null) {
      setLeftPath(configuredDefaultPath);
    }
    if (initialSavedCenterPathRef.current === null) {
      setCenterPath(configuredDefaultPath);
    }
  }, [configuredDefaultPath, pathFromUrl]);

  const handleInitialOpenHandled = useCallback(() => {
    const nextUrl = new URL(window.location.href);
    if (!nextUrl.searchParams.has("open_file") && !nextUrl.searchParams.has("open_mode")) {
      return;
    }

    nextUrl.searchParams.delete("open_file");
    nextUrl.searchParams.delete("open_mode");
    window.history.replaceState({}, "", nextUrl.toString());
    setLocationSearch(nextUrl.search);
  }, []);

  // パス変更時に localStorage に保存
  useEffect(() => {
    if (!configuredDefaultPath && initialSavedLeftPathRef.current === null) return;
    localStorage.setItem(STORAGE_KEYS.LEFT_PATH, leftPath);
  }, [configuredDefaultPath, leftPath]);

  useEffect(() => {
    if (!configuredDefaultPath && initialSavedCenterPathRef.current === null) return;
    localStorage.setItem(STORAGE_KEYS.CENTER_PATH, centerPath);
  }, [centerPath, configuredDefaultPath]);

  const isSyncingRef = useRef(false);
  const leftPathRef = useRef(leftPath);
  const centerPathRef = useRef(centerPath);
  leftPathRef.current = leftPath;
  centerPathRef.current = centerPath;

  const handleLeftPathChange = useCallback((newPath: string) => {
    const oldLeft = leftPathRef.current;
    setLeftPath(newPath);

    if (!isSyncNavigation || isSyncingRef.current) return;

    isSyncingRef.current = true;
    try {
      const currentCenter = centerPathRef.current;
      const syncResult = resolveSyncedPath(oldLeft, newPath, currentCenter);
      if (syncResult.nextPath && syncResult.nextPath !== currentCenter) {
        setCenterPath(syncResult.nextPath);
      }
    } finally {
      setTimeout(() => {
        isSyncingRef.current = false;
      }, 50);
    }
  }, [isSyncNavigation]);

  const handleCenterPathChange = useCallback((newPath: string) => {
    const oldCenter = centerPathRef.current;
    setCenterPath(newPath);

    if (!isSyncNavigation || isSyncingRef.current) return;

    isSyncingRef.current = true;
    try {
      const currentLeft = leftPathRef.current;
      const syncResult = resolveSyncedPath(oldCenter, newPath, currentLeft);
      if (syncResult.nextPath && syncResult.nextPath !== currentLeft) {
        setLeftPath(syncResult.nextPath);
      }
    } finally {
      setTimeout(() => {
        isSyncingRef.current = false;
      }, 50);
    }
  }, [isSyncNavigation]);

  const toggleSyncNavigation = useCallback(() => {
    setIsSyncNavigation((prev) => {
      const next = !prev;
      if (next) {
        showSuccess("左右ペインの同期移動を有効にしました");
      } else {
        showSuccess("左右ペインの同期移動を解除しました");
      }
      return next;
    });
  }, [showSuccess]);

  const handleSyncPathToCenter = useCallback(() => {
    setCenterPath(leftPath);
    showSuccess("右ペインを左ペインと同じフォルダに同期しました");
  }, [leftPath, showSuccess]);

  const clearActiveDomFocus = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, []);

  const deactivatePane = useCallback((pane: Exclude<FocusedPane, null>) => {
    lastInactivePaneRef.current = pane;
    clearActiveDomFocus();
    setFocusedPane(null);
  }, [clearActiveDomFocus]);

  const isXtermHiddenTextarea = (target: EventTarget | null): boolean => {
    return target instanceof HTMLTextAreaElement && target.classList.contains("xterm-helper-textarea");
  };

  // グローバルキーボードイベント（左右矢印でペイン切替、Ctrl+Z/Shift+Zで Undo/Redo）
  useEffect(() => {
    const handleGlobalKeyDown = async (e: KeyboardEvent) => {
      if (
        (focusedPane === "left" || focusedPane === "center" || focusedPane === "terminal") &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        !isModalEventTarget(e.target)
      ) {
        if (e.key === "Escape") {
          e.preventDefault();
          deactivatePane(focusedPane);
          return;
        }
      }

      const isTerminalResidualFocus = isXtermHiddenTextarea(e.target) && focusedPane !== "terminal";

      // 入力中は単キーショートカットを無効化
      if (isEditableEventTarget(e.target) && !isTerminalResidualFocus) {
        return;
      }

      // Ctrl/Cmdキーが押されている場合
      if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase();

        if (matchesCmdOrCtrlShiftShortcut(e, "p")) {
          e.preventDefault();
          if (isTerminalResidualFocus) clearActiveDomFocus();
          lastInactivePaneRef.current = "right";
          setFocusedPane("right");
          setGlobalFulltextShortcutSeq((current) => current + 1);
          return;
        }

        // Redo: Ctrl+Shift+Z / Cmd+Shift+Z (Undoより先にチェック)
        if (key === 'z' && e.shiftKey) {
          e.preventDefault();
          if (canRedo) {
            const result = await redo();
            if (result.success) {
              showSuccess(result.message);
            } else {
              showError(result.message);
            }
          } else {
            showError("やり直す操作がありません");
          }
          return;
        }

        // Undo: Ctrl+Z / Cmd+Z
        if (key === 'z' && !e.shiftKey) {
          e.preventDefault();
          if (canUndo) {
            const result = await undo();
            if (result.success) {
              showSuccess(result.message);
            } else {
              showError(result.message);
            }
          } else {
            showError("元に戻す操作がありません");
          }
          return;
        }

        // ブラウザの戻る・進む動作を防ぐ
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
        }
        return;
      }

      // Alt+S: 左右ペイン同期移動トグル
      if (e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        toggleSyncNavigation();
        return;
      }

      if (!e.shiftKey && !e.altKey) {
        const key = e.key.toLowerCase();

        if (key === "s") {
          e.preventDefault();
          if (isTerminalResidualFocus) clearActiveDomFocus();
          lastInactivePaneRef.current = "left";
          setFocusedPane("left");
          return;
        }

        if (key === "d") {
          e.preventDefault();
          if (isTerminalResidualFocus) clearActiveDomFocus();
          lastInactivePaneRef.current = "center";
          setFocusedPane("center");
          return;
        }

        if (key === "f") {
          e.preventDefault();
          if (isTerminalResidualFocus) clearActiveDomFocus();
          lastInactivePaneRef.current = "right";
          setFocusedPane("right");
          return;
        }

        if (key === "c") {
          e.preventDefault();
          if (isTerminalResidualFocus) clearActiveDomFocus();
          const cwd = focusedPane === "left" ? leftPath : focusedPane === "center" ? centerPath : null;
          lastInactivePaneRef.current = "terminal";
          setFocusedPane("terminal");
          setTerminalFocusRequest((current) => ({
            cwd,
            seq: current.seq + 1,
          }));
          return;
        }
      }

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setFocusedPane((prev) => {
          if (prev === null) {
            if (lastInactivePaneRef.current === "terminal") return "right";
            if (lastInactivePaneRef.current === "right") return "center";
            if (lastInactivePaneRef.current === "center") return "left";
            return "left";
          }
          if (prev === 'terminal') return 'right';
          if (prev === 'right') return 'center';
          if (prev === 'center') return 'left';
          return prev;
        });
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setFocusedPane((prev) => {
          if (prev === null) {
            if (lastInactivePaneRef.current === "left") return "center";
            if (lastInactivePaneRef.current === "center") return "right";
            if (lastInactivePaneRef.current === "right") return "terminal";
            return "right";
          }
          if (prev === 'right') return 'terminal';
          if (prev === 'left') return 'center';
          if (prev === 'center') return 'right';
          return prev;
        });
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [canUndo, canRedo, undo, redo, showError, showSuccess, focusedPane, leftPath, centerPath, clearActiveDomFocus]);

  const handleSelectFolder = useCallback((path: string) => {
    setLeftPath(path);
  }, []);

  const handleSelectRightFolder = useCallback((path: string) => {
    setCenterPath(path);
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>
          <a href="#" style={{ color: 'inherit', textDecoration: 'none' }}>
            File Manager
          </a>
        </h1>
        <div className="header-actions">
          <a href="/" className="home-link" title="ホームに戻る">
            <Home size={20} />
          </a>
          <a href="#api-test" target="_blank" className="api-test-link" title="APIテストページ">
            <FlaskConical size={20} />
          </a>
          <div className="sync-controls" style={{ display: 'flex', alignItems: 'center', gap: '4px', marginRight: '8px' }}>
            <button
              onClick={toggleSyncNavigation}
              className={`sync-nav-button ${isSyncNavigation ? 'active' : ''}`}
              style={{
                background: isSyncNavigation ? 'rgba(59, 130, 246, 0.25)' : 'none',
                border: isSyncNavigation ? '1px solid #3b82f6' : '1px solid rgba(255, 255, 255, 0.2)',
                color: isSyncNavigation ? '#60a5fa' : 'inherit',
                cursor: 'pointer',
                padding: '3px 8px',
                borderRadius: '4px',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '12px',
                fontWeight: isSyncNavigation ? 'bold' : 'normal',
                transition: 'all 0.15s ease',
              }}
              title={isSyncNavigation ? "左右ペイン同期移動: ON (クリックで解除、Alt+S)" : "左右ペイン同期移動: OFF (クリックで有効化、Alt+S)"}
            >
              <Link2 size={15} />
              <span>同期移動</span>
            </button>
            <button
              onClick={handleSyncPathToCenter}
              className="sync-path-button"
              style={{
                background: 'none',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                color: 'inherit',
                cursor: 'pointer',
                padding: '3px 6px',
                borderRadius: '4px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              title="右ペインを左ペインと同じフォルダに同期"
            >
              <ArrowRightLeft size={14} />
            </button>
          </div>
          <div className="zoom-controls" style={{ display: 'flex', alignItems: 'center', gap: '4px', marginRight: '8px', color: 'white' }}>
            <button
              onClick={zoomOut}
              className="zoom-button"
              style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '4px', display: 'flex' }}
              title="縮小"
            >
              -
            </button>
            <span
              onClick={resetZoom}
              style={{ fontSize: '12px', cursor: 'pointer', minWidth: '35px', textAlign: 'center' }}
              title="リセット"
            >
              {Math.round(zoomLevel * 100)}%
            </span>
            <button
              onClick={zoomIn}
              className="zoom-button"
              style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '4px', display: 'flex' }}
              title="拡大"
            >
              +
            </button>
          </div>
          <button className="menu-trigger" onClick={() => setShowMenu(!showMenu)}>
            <Menu size={20} />
          </button>
          {showMenu && (
            <div className="settings-menu">
              <button className="menu-item" onClick={() => { setTheme('light'); setShowMenu(false); }}>
                <Sun size={16} /> White Mode
              </button>
              <button className="menu-item" onClick={() => { setTheme('dark'); setShowMenu(false); }}>
                <Moon size={16} /> Dark Mode
              </button>
              <div className="menu-divider" />
              <div className="menu-section">
                <div className="menu-section-title">Text Files</div>
                <label className="menu-item checkbox-item">
                  <input
                    type="checkbox"
                    checked={textFileOpenMode === "web"}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setTextFileOpenMode("web");
                      }
                    }}
                  />
                  <span>Web App Editor</span>
                </label>
                <label className="menu-item checkbox-item">
                  <input
                    type="checkbox"
                    checked={textFileOpenMode === "vscode"}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setTextFileOpenMode("vscode");
                      }
                    }}
                  />
                  <span>Visual Studio Code</span>
                </label>
              </div>
              <div className="menu-divider" />
              <div className="menu-section">
                <div className="menu-section-title">Markdown</div>
                <label className="menu-item checkbox-item">
                  <input
                    type="checkbox"
                    checked={markdownOpenMode === "web"}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setMarkdownOpenMode("web");
                      }
                    }}
                  />
                  <span>Web App Editor</span>
                </label>
                <label className="menu-item checkbox-item">
                  <input
                    type="checkbox"
                    checked={markdownOpenMode === "obsidian_or_web"}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setMarkdownOpenMode("obsidian_or_web");
                      }
                    }}
                  />
                  <span>Obsidian or Web App Editor</span>
                </label>
                <label className="menu-item checkbox-item">
                  <input
                    type="checkbox"
                    checked={markdownOpenMode === "external"}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setMarkdownOpenMode("external");
                      }
                    }}
                  />
                  <span>Obsidian or Visual Studio Code</span>
                </label>
              </div>
              <div className="menu-divider" />
              <label className="menu-item checkbox-item">
                <input
                  type="checkbox"
                  checked={verifyChecksum}
                  onChange={(e) => setVerifyChecksum(e.target.checked)}
                />
                <span>Safe Move (Checksum)</span>
              </label>
              <label className="menu-item checkbox-item">
                <input
                  type="checkbox"
                  checked={debugMode}
                  onChange={(e) => setDebugMode(e.target.checked)}
                />
                <span>Debug Mode</span>
              </label>
              <div className="menu-divider" />
              <div className="menu-section">
                <div className="menu-section-title">Network Settings</div>
                <div className="menu-item" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '6px 12px' }}>
                  <span style={{ fontSize: '13px' }}>API Timeout (sec)</span>
                  <input
                    type="number"
                    min="1"
                    max="300"
                    value={apiTimeout}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val) && val > 0) {
                        setApiTimeout(val);
                      }
                    }}
                    style={{
                      width: '60px',
                      padding: '4px',
                      borderRadius: '4px',
                      border: '1px solid var(--border-color)',
                      background: 'var(--bg-secondary)',
                      color: 'var(--text-primary)',
                      textAlign: 'right',
                      fontSize: '13px'
                    }}
                  />
                </div>
                <div className="menu-item" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '6px 12px' }}>
                  <span style={{ fontSize: '13px' }}>Folder Date Max Items</span>
                  <input
                    type="number"
                    min="1"
                    max="1000000"
                    step="1000"
                    value={folderLatestModifiedMaxEntries}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val) && val > 0) {
                        setFolderLatestModifiedMaxEntries(Math.min(val, 1_000_000));
                      }
                    }}
                    title="dキーでフォルダ配下の最新更新日を計算する際の最大項目数"
                    style={{
                      width: '82px',
                      padding: '4px',
                      borderRadius: '4px',
                      border: '1px solid var(--border-color)',
                      background: 'var(--bg-secondary)',
                      color: 'var(--text-primary)',
                      textAlign: 'right',
                      fontSize: '13px'
                    }}
                  />
                </div>
                <div className="menu-item" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '6px 12px' }}>
                  <span style={{ fontSize: '13px' }}>Default Text Extension</span>
                  <input
                    type="text"
                    value={defaultTextFileExtension}
                    onChange={(e) => setDefaultTextFileExtension(e.target.value.replace(/^\.+/, ""))}
                    title="Tキーで作成するテキストファイルの既定拡張子"
                    style={{
                      width: '82px',
                      padding: '4px',
                      borderRadius: '4px',
                      border: '1px solid var(--border-color)',
                      background: 'var(--bg-secondary)',
                      color: 'var(--text-primary)',
                      textAlign: 'right',
                      fontSize: '13px'
                    }}
                  />
                </div>
              </div>
              <div className="menu-divider" />
              <div className="menu-section">
                <div className="menu-section-title">Link Settings</div>
                <button
                  className="menu-item"
                  onClick={handleOpenPathMapModal}
                  style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', border: 'none', background: 'none', textAlign: 'left', cursor: 'pointer', color: 'var(--text-primary)', padding: '6px 12px' }}
                >
                  <Link size={16} /> リンク置換設定の編集...
                </button>
              </div>
              <div className="menu-divider" />
              <button className="menu-item" onClick={() => { handleResetSettings(); setShowMenu(false); }}>
                <Trash2 size={16} /> Reset Storage
              </button>
            </div>
          )}
        </div>
      </header>
      {currentPage === 'api-test' ? (
        <main className="app-main api-test-main" style={{ zoom: zoomLevel } as any}>
          <Suspense fallback={<div className="loading">読み込み中...</div>}>
            <ApiTestPage />
          </Suspense>
        </main>
      ) : (
        <main className="app-main triple-pane" style={{ zoom: zoomLevel } as any}>
          <div
            className={`pane left-pane ${focusedPane === 'left' ? 'focused' : ''}`}
            onClick={() => {
              lastInactivePaneRef.current = "left";
              setFocusedPane('left');
            }}
          >
            <ErrorBoundary>
              <FileList
                panelId="left"
                initialPath={getDefaultBasePath()}
                path={leftPath}
                initialOpenFilePath={openFileFromUrl ? decodeURIComponent(openFileFromUrl) : undefined}
                initialOpenMode={openModeFromUrl === "web" ? "web" : undefined}
                onInitialOpenHandled={handleInitialOpenHandled}
                onPathChange={handleLeftPathChange}
                onOpenInAdjacentPane={(p) => setCenterPath(p)}
                isFocused={focusedPane === 'left'}
                onRequestFocus={() => {
                  lastInactivePaneRef.current = "left";
                  setFocusedPane('left');
                }}
                textFileOpenMode={textFileOpenMode}
                markdownOpenMode={markdownOpenMode}
                defaultTextFileExtension={defaultTextFileExtension}
              />
            </ErrorBoundary>
          </div>
          <div className="pane-divider" />
          <div
            className={`pane center-pane ${focusedPane === 'center' ? 'focused' : ''}`}
            onClick={() => {
              lastInactivePaneRef.current = "center";
              setFocusedPane('center');
            }}
          >
            <ErrorBoundary>
              <FileList
                panelId="center"
                initialPath={getDefaultBasePath()}
                path={centerPath}
                onPathChange={handleCenterPathChange}
                onOpenInAdjacentPane={(p) => setLeftPath(p)}
                isFocused={focusedPane === 'center'}
                onRequestFocus={() => {
                  lastInactivePaneRef.current = "center";
                  setFocusedPane('center');
                }}
                textFileOpenMode={textFileOpenMode}
                markdownOpenMode={markdownOpenMode}
                defaultTextFileExtension={defaultTextFileExtension}
              />
            </ErrorBoundary>
          </div>
          <div className="pane-divider" />
          <div
            className={`pane search-pane ${focusedPane === 'right' ? 'focused' : ''}`}
            onClick={() => {
              lastInactivePaneRef.current = "right";
              setFocusedPane('right');
            }}
          >
            <ErrorBoundary>
              <div className="search-pane-layout">
                <div
                  className={`search-pane-search ${focusedPane === 'right' ? 'focused' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    lastInactivePaneRef.current = "right";
                    setFocusedPane('right');
                  }}
                >
                  <FileSearch
                    initialPath={defaultPath}
                    leftPanePath={leftPath}
                    rightPanePath={centerPath}
                    onSelectFolder={handleSelectFolder}
                    onSelectRightFolder={handleSelectRightFolder}
                    isFocused={focusedPane === 'right'}
                    onRequestFocus={() => {
                      lastInactivePaneRef.current = "right";
                      setFocusedPane('right');
                    }}
                    textFileOpenMode={textFileOpenMode}
                    markdownOpenMode={markdownOpenMode}
                    globalFulltextShortcutSeq={globalFulltextShortcutSeq}
                  />
                </div>
                <div
                  className={`search-pane-terminal ${focusedPane === 'terminal' ? 'focused' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    lastInactivePaneRef.current = "terminal";
                    setFocusedPane('terminal');
                  }}
                >
                  <Suspense fallback={<div className="loading">ターミナルを読み込み中...</div>}>
                    <ServerTerminal
                      leftCwd={leftPath}
                      centerCwd={centerPath}
                      requestedCwd={terminalFocusRequest.cwd}
                      focusRequestSeq={terminalFocusRequest.seq}
                      isFocused={focusedPane === 'terminal'}
                      onRequestFocus={() => {
                        lastInactivePaneRef.current = "terminal";
                        setFocusedPane('terminal');
                      }}
                      onEscape={() => deactivatePane("terminal")}
                    />
                  </Suspense>
                </div>
              </div>
            </ErrorBoundary>
          </div>
        </main>
      )}

      <Modal
        isOpen={showPathMapModal}
        onClose={() => setShowPathMapModal(false)}
        title="リンク置換設定"
        width="680px"
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', width: '100%' }}>
            <button
              onClick={() => setShowPathMapModal(false)}
              className="btn-secondary"
              style={{
                padding: '8px 16px',
                borderRadius: '6px',
                border: '1px solid var(--border-color)',
                background: 'none',
                color: 'var(--text-primary)',
                cursor: 'pointer',
                fontSize: '14px',
              }}
            >
              キャンセル
            </button>
            <button
              onClick={handleSavePathMap}
              className="btn-primary"
              style={{
                padding: '8px 16px',
                borderRadius: '6px',
                border: 'none',
                background: '#0066cc',
                color: '#ffffff',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: 'bold',
              }}
            >
              保存
            </button>
          </div>
        }
      >
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '16px',
          borderBottom: '1px solid var(--border-color)',
          paddingBottom: '8px'
        }}>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => handleToggleViewMode("form")}
              style={{
                padding: '6px 12px',
                borderRadius: '4px',
                border: 'none',
                background: viewMode === "form" ? '#0066cc' : 'transparent',
                color: viewMode === "form" ? '#ffffff' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: 'bold'
              }}
            >
              入力フォームで編集
            </button>
            <button
              onClick={() => handleToggleViewMode("json")}
              style={{
                padding: '6px 12px',
                borderRadius: '4px',
                border: 'none',
                background: viewMode === "json" ? '#0066cc' : 'transparent',
                color: viewMode === "json" ? '#ffffff' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: 'bold'
              }}
            >
              JSONで直接編集
            </button>
          </div>

          <button
            onClick={handleTestConnections}
            disabled={isTestingConnections}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 12px',
              borderRadius: '6px',
              border: '1px solid var(--border-color)',
              background: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              cursor: isTestingConnections ? 'not-allowed' : 'pointer',
              fontSize: '12px',
              fontWeight: 'normal',
              transition: 'all 0.2s',
            }}
            title="入力された新サーバー（左側）のリンクが切れていないか、接続性を検証します"
          >
            {isTestingConnections ? (
              <Loader2 size={14} className="spin" style={{ color: '#0066cc' }} />
            ) : (
              <Play size={14} />
            )}
            新サーバーの接続確認
          </button>
        </div>

        {viewMode === "form" ? (
          <div>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px', marginTop: 0, lineHeight: '1.5' }}>
              移行先の新サーバーと、対応する旧サーバー（カンマ区切りで複数可能）を指定してください。古いアドレスからのアクセス時に自動置換されます。
            </p>
            
            <div style={{ maxHeight: '320px', overflowY: 'auto', paddingRight: '8px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'flex', gap: '12px', fontWeight: 'bold', fontSize: '12px', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)', paddingBottom: '4px', alignItems: 'center' }}>
                <div style={{ width: '20px', flexShrink: 0 }}></div>
                <div style={{ flex: 1 }}>新サーバー（左: 稼働中）</div>
                <div style={{ flex: 1.2 }}>旧サーバー群（右: リンク切れ、カンマ区切り）</div>
                <div style={{ width: '30px', flexShrink: 0 }}></div>
              </div>
              
              {formRules.map((rule) => (
                <div key={rule.id} style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                  <div style={{ width: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {rule.testStatus === "testing" && (
                      <div title="接続検証中...">
                        <Loader2 size={16} className="spin" style={{ color: '#0066cc' }} />
                      </div>
                    )}
                    {rule.testStatus === "ok" && (
                      <div title="接続成功">
                        <CheckCircle2 size={16} style={{ color: '#22c55e' }} />
                      </div>
                    )}
                    {rule.testStatus === "error" && (
                      <div title={rule.testError || "接続失敗"} style={{ display: 'flex', alignItems: 'center', cursor: 'help' }}>
                        <AlertTriangle size={16} style={{ color: '#ef4444' }} />
                      </div>
                    )}
                  </div>
                  <input
                    type="text"
                    value={rule.newServer}
                    onChange={(e) => handleUpdateFormRule(rule.id, "newServer", e.target.value)}
                    placeholder="例: \\\\new-server\\share"
                    style={{
                      flex: 1,
                      padding: '8px 12px',
                      borderRadius: '6px',
                      border: '1px solid var(--border-color)',
                      background: 'var(--bg-secondary)',
                      color: 'var(--text-primary)',
                      fontSize: '13px',
                      outline: 'none'
                    }}
                  />
                  <input
                    type="text"
                    value={rule.oldServers}
                    onChange={(e) => handleUpdateFormRule(rule.id, "oldServers", e.target.value)}
                    placeholder="例: \\\\old-1\\share,\\\\old-2\\share"
                    style={{
                      flex: 1.2,
                      padding: '8px 12px',
                      borderRadius: '6px',
                      border: '1px solid var(--border-color)',
                      background: 'var(--bg-secondary)',
                      color: 'var(--text-primary)',
                      fontSize: '13px',
                      outline: 'none'
                    }}
                  />
                  <button
                    onClick={() => handleRemoveFormRule(rule.id)}
                    title="削除"
                    style={{
                      width: '30px',
                      height: '30px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      border: 'none',
                      background: 'none',
                      color: '#ef4444',
                      cursor: 'pointer',
                      borderRadius: '4px',
                      padding: 0
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
              
              <button
                onClick={handleAddFormRule}
                style={{
                  alignSelf: 'flex-start',
                  padding: '6px 12px',
                  borderRadius: '6px',
                  border: '1px solid var(--border-color)',
                  background: 'var(--bg-secondary)',
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                  fontSize: '13px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  marginTop: '4px'
                }}
              >
                <span>＋ ルールを追加</span>
              </button>
            </div>
          </div>
        ) : (
          <div>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px', marginTop: 0, lineHeight: '1.5' }}>
              大量のマッピングデータをコピペ・バックアップする際に利用してください。<br />
              <strong>左側 (キー)</strong> に新サーバー、<strong>右側 (値)</strong> に旧サーバー群（カンマ区切り）を指定します。
            </p>
            
            <div style={{ marginBottom: '12px' }}>
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>入力例:</span>
              <pre style={{
                background: 'var(--bg-secondary)',
                padding: '8px 12px',
                borderRadius: '6px',
                fontSize: '12px',
                margin: '4px 0 12px 0',
                border: '1px solid var(--border-color)',
                overflowX: 'auto',
                fontFamily: 'monospace'
              }}>
{`{
  "\\\\\\\\new-server\\\\share": "\\\\\\\\old-1\\\\share,\\\\\\\\old-2\\\\share",
  "http://new-wiki/": "http://old-wiki-1/,http://old-wiki-2/"
}`}
              </pre>
            </div>

            <textarea
              value={pathMapJsonStr}
              onChange={(e) => setPathMapJsonStr(e.target.value)}
              style={{
                width: '100%',
                height: '220px',
                fontFamily: 'monospace',
                fontSize: '13px',
                padding: '12px',
                borderRadius: '8px',
                border: pathMapError ? '1px solid #ef4444' : '1px solid var(--border-color)',
                background: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                resize: 'vertical',
                outline: 'none',
                boxSizing: 'border-box'
              }}
              placeholder="{}"
            />
          </div>
        )}

        {pathMapError && (
          <div style={{ color: '#ef4444', fontSize: '12px', marginTop: '8px', whiteSpace: 'pre-wrap', lineHeight: '1.4' }}>
            ⚠️ {pathMapError}
          </div>
        )}
      </Modal>
    </div>
  );
}

// OperationHistoryProviderとToastProviderでラップ
function App() {
  return (
    <OperationHistoryProvider>
      <FolderHistoryProvider>
        <ToastProvider>
          <ZoomProvider>
            <AppContent />
          </ZoomProvider>
        </ToastProvider>
      </FolderHistoryProvider>
    </OperationHistoryProvider>
  );
}

export default App;
