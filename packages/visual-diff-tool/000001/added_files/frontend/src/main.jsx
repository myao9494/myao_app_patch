/**
 * 画像差分ツールのメインUIコンポーネント
 *
 * ユーザーが2つの画像（またはPDF/TIFF等）を選択し、
 * バックエンドのAPIに送信して差分比較を行うための機能を提供する。
 * 比較結果は「元画像」「補正B」「差分」「マスク」の各ビューで切り替えて表示できる。
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  BookOpenText,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Download,
  ExternalLink,
  FileText,
  FolderGit2,
  FolderOpen,
  GripVertical,
  HelpCircle,
  ImageUp,
  Layers,
  Loader2,
  Menu,
  MessageSquarePlus,
  MousePointer2,
  PanelTopOpen,
  RefreshCw,
  RotateCcw,
  Save,
  ScanSearch,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import "./styles.css";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";
const CATEGORIES = ["汎用", "図面", "グラフ", "書類"];
const VIEWS = [
  { id: "original", label: "元画像" },
  { id: "aligned", label: "補正B" },
  { id: "overlay", label: "差分" },
  { id: "mask", label: "マスク" },
];
const TAB_TOGGLE_VIEWS = ["aligned", "overlay"];
const MEMO_DB_NAME = "visual-diff-memo";
const MEMO_DB_STORE = "payloads";
const MEMO_STORAGE_KEY = "visual-diff-memo-fallback";
const CLIPBOARD_IMAGE_SCALE = 2;
const DEFAULT_TEXT_EXTENSIONS = [".md", ".txt", ".csv", ".json", ".yaml", ".yml"];
const GIT_EXTENSION_STORAGE_KEY = "visual-diff-git-text-extensions";
const GIT_TEXT_MEMO_STORAGE_KEY = "visual-diff-git-text-memos";
const GIT_FOLDER_HISTORY_STORAGE_KEY = "visual-diff-git-folder-history";
const DISPLAY_SCALE_STORAGE_KEY = "visual-diff-display-scale";
const MEMO_SIDEBAR_WIDTH_STORAGE_KEY = "visual-diff-memo-sidebar-width";
const MEMO_SIDEBAR_VISIBLE_STORAGE_KEY = "visual-diff-memo-sidebar-visible";
const MEMO_CHANGE_TYPES = [
  { id: "change", label: "変更" },
  { id: "add", label: "追加" },
  { id: "remove", label: "削除" },
  { id: "confirm", label: "確認依頼" },
  { id: "decision", label: "要判断" },
];
const MEMO_ANNOTATION_TYPES = [
  { id: "arrow", label: "矢印", shortcut: "A" },
  { id: "cloud", label: "変更雲", shortcut: "C" },
  { id: "rectangle", label: "矩形", shortcut: "R" },
  { id: "ellipse", label: "楕円", shortcut: "O" },
  { id: "highlight", label: "マーカー", shortcut: "M" },
];
const MEMO_DEFAULTS = {
  text: "めも",
  changeType: "change",
  opacity: 60,
  fontSize: 15,
  width: 100,
  height: 42,
  autoSize: true,
  leaderX: 18,
  leaderY: 46,
  leaderEndX: -73,
  leaderEndY: 163,
  annotations: [],
};
const MEMO_EXTRA_LEADER_DEFAULT = {
  leaderX: 162,
  leaderY: 46,
  leaderEndX: 275,
  leaderEndY: 163,
};
const STICKY_DEFAULTS = {
  text: "付箋",
  x: 42,
  y: 12,
  width: 180,
  height: 72,
  fontSize: 15,
};
const MEMO_COLORS = [
  { fill: "#ef4444", border: "#fecaca", line: "#ef4444", hex: "#ef4444" },
  { fill: "#2563eb", border: "#bfdbfe", line: "#3b82f6", hex: "#3b82f6" },
  { fill: "#10b981", border: "#a7f3d0", line: "#10b981", hex: "#10b981" },
  { fill: "#d97706", border: "#fde68a", line: "#f59e0b", hex: "#f59e0b" },
  { fill: "#9333ea", border: "#e9d5ff", line: "#a855f7", hex: "#a855f7" },
  { fill: "#0891b2", border: "#a5f3fc", line: "#06b6d4", hex: "#06b6d4" },
];

function useShortcutHelp() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const handleHelpShortcut = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
      if (isTypingTarget(event.target) || event.key.toLowerCase() !== "h") return;
      event.preventDefault();
      setOpen((current) => !current);
    };
    window.addEventListener("keydown", handleHelpShortcut);
    return () => window.removeEventListener("keydown", handleHelpShortcut);
  }, []);
  return [open, setOpen];
}

function ShortcutHelp({ page, onClose }) {
  const content = page === "memo" ? {
    title: "画像メモのショートカット",
    shortcuts: [
      ["← / →", "前後の画像へ移動（Git差分から開いた場合）"],
      ["T", "メモを追加"], ["L", "選択メモへラインを追加"], ["N", "付箋を追加"],
      ["A", "ドラッグした起点から終点へ矢印を追加"], ["C", "変更雲"], ["R / 2", "矩形"],
      ["O / 4", "楕円"], ["M", "マーカー"], ["Ctrl/Cmd+Z", "元に戻す"],
      ["Ctrl/Cmd+Shift+Z", "やり直す"], ["Delete", "選択中の図形を削除"],
      ["H", "このヘルプの表示／非表示"], ["Esc", "テキスト編集／ヘルプを閉じる"],
    ],
    settings: [
      "画像内のメモ本文: ダブルクリックで文字編集になります。上部の本文欄はクリックで編集でき、Escまたは図形選択で編集を終了します。",
      "図形: クリックで水色の選択枠を表示します。選択後はDelete／Backspaceで削除できます。",
      "Git対象拡張子: git差分でテキストとして扱う形式を設定します。画像形式は常に対象です。",
      "Obsidianフォルダー: Markdownリンクの解決元です。",
      "レポート保存先: 出力HTMLをサーバー側で保存するフォルダーです。",
      "表示倍率: アプリ全体のUI倍率です。画像メモの表示サイズとは別です。",
    ],
  } : page === "git" ? {
    title: "git差分のショートカット",
    shortcuts: [["← / →", "前後の変更ファイルへ移動"], ["変更行の→", "HEAD側の内容を変更後ファイルへ反映して元に戻す"], ["Tab / Shift+Tab", "補正Bと差分表示を切替（画像）"], ["H", "このヘルプ"]],
    settings: [
      "Git対象拡張子: 一覧・HTMLレポートに含めるテキスト形式を設定します。",
      "Obsidianフォルダー: Markdownから関連ファイルをたどる基準です。",
      "レポート保存先: プレビュー調整後のHTML保存先です。未設定時はダウンロードします。",
      "表示倍率: git差分画面全体を50〜200%で表示します。",
    ],
  } : page === "report" ? {
    title: "HTML出力プレビューの操作",
    shortcuts: [["H", "このヘルプ"]],
    settings: [
      "カード見出しをドラッグするか、↑／↓ボタンで出力順を変更します。",
      "画像はドラッグ／2本指スワイプで移動し、ピンチで拡大・縮小します。右下ハンドルでカードをリサイズできます。",
      "領域指定ボタンで出力範囲を選びます。未指定の場合は現在表示中の範囲を出力します。",
      "テキスト差分の戻すボタンは作業ファイルを1行だけ変更前へ戻します。ファイルがプレビュー後に変わった場合は安全のため拒否します。",
      "メモ編集で詳細を直した後は、「戻る」ボタンでHTML出力プレビューへ戻れます。",
    ],
  } : page === "api" ? {
    title: "API説明ページのショートカット",
    shortcuts: [["H", "このヘルプ"], ["Ctrl/Cmd+F", "ブラウザ内検索"]],
    settings: ["このページには固有設定がありません。設定は差分画面のハンバーガーメニューから変更できます。"],
  } : {
    title: "ファイル差分のショートカット",
    shortcuts: [["Tab / Shift+Tab", "補正Bと差分表示を切替"], ["Ctrl/Cmd/Alt+ホイール", "画像を拡大・縮小"], ["H", "このヘルプ"]],
    settings: [
      "Git対象拡張子: git差分モードで扱うテキスト形式です。",
      "Obsidianフォルダー／レポート保存先: Markdown連携とHTML保存に使います。",
      "表示倍率: アプリ全体のUI倍率です。画像の拡大率とは別です。",
    ],
  };
  return (
    <div className="shortcut-help-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="shortcut-help-modal" role="dialog" aria-modal="true" aria-labelledby="shortcut-help-title">
        <header><div><HelpCircle size={22} /><h2 id="shortcut-help-title">{content.title}</h2></div><button type="button" onClick={onClose} aria-label="閉じる">×</button></header>
        <div className="shortcut-help-body">
          <h3>ショートカット</h3>
          <dl>{content.shortcuts.map(([key, label]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{label}</dd></div>)}</dl>
          <h3>設定と操作</h3>
          <ul>{content.settings.map((setting) => <li key={setting}>{setting}</li>)}</ul>
        </div>
      </section>
    </div>
  );
}

function App() {
  const [helpOpen, setHelpOpen] = useShortcutHelp();
  const [menuOpen, setMenuOpen] = useState(false);
  const [textExtensions, setTextExtensions] = useState(loadTextExtensions);
  const [extensionDraft, setExtensionDraft] = useState(() => loadTextExtensions().join(", "));
  const [obsidianFolder, setObsidianFolder] = useState("");
  const [obsidianFolderDraft, setObsidianFolderDraft] = useState("");
  const [obsidianReportFolder, setObsidianReportFolder] = useState("");
  const [obsidianReportFolderDraft, setObsidianReportFolderDraft] = useState("");
  const [obsidianSettingsBusy, setObsidianSettingsBusy] = useState(false);
  const [displayScale, setDisplayScale] = useState(loadDisplayScale);
  const [activeTab, setActiveTab] = useState("files");
  const [left, setLeft] = useState(null);
  const [right, setRight] = useState(null);
  const [pageA, setPageA] = useState(0);
  const [pageB, setPageB] = useState(0);
  const [category, setCategory] = useState("汎用");
  const [diffThreshold, setDiffThreshold] = useState(0.1);
  const [view, setView] = useState("overlay");
  const [zoom, setZoom] = useState(1);
  const [anchorRegion, setAnchorRegion] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [activeSide, setActiveSide] = useState("left");
  const [gitFolder, setGitFolder] = useState(loadLastGitFolder);
  const [gitFolderHistory, setGitFolderHistory] = useState(loadGitFolderHistory);
  const [gitInfo, setGitInfo] = useState(null);
  const [gitIndex, setGitIndex] = useState(0);
  const [gitResult, setGitResult] = useState(null);
  const [gitItem, setGitItem] = useState(null);
  const [gitTextMemos, setGitTextMemos] = useState(loadGitTextMemos);
  const [gitExportExcluded, setGitExportExcluded] = useState([]);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportNotice, setExportNotice] = useState("");
  const [exportSelectionOpen, setExportSelectionOpen] = useState(false);
  const [reportPreview, setReportPreview] = useState(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [gitTextBusy, setGitTextBusy] = useState(false);
  const [gitTextHistory, setGitTextHistory] = useState({ path: "", undo: [], redo: [] });
  const [gitError, setGitError] = useState("");
  const requestIdRef = useRef(0);
  const gitRequestIdRef = useRef(0);
  const gitTextPreviewRequestRef = useRef(0);
  const previewRequestIdRef = useRef({ left: 0, right: 0 });
  const canvasRefs = useRef({ left: null, right: null });
  const syncingCanvasScrollRef = useRef(false);
  const reportPreviewRestoreRef = useRef(false);

  useEffect(() => {
    if (!reportPreview) return undefined;
    const timer = window.setTimeout(() => {
      reportPreview.forEach((entry) => {
        if (!entry.memoId || !entry.imageMemo) return;
        storeMemoPayload(entry.memoId, {
          ...entry.imageMemo,
          reportOptions: normalizeReportOptions(entry.reportOptions),
        }).catch(() => setGitError("HTMLプレビュー設定を保存できませんでした"));
      });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [reportPreview]);

  useEffect(() => {
    if (!reportPreview) return undefined;
    const leavePreviewWhenRouteChanges = () => {
      if (!window.location.hash.startsWith("#report-preview")) setReportPreview(null);
    };
    window.addEventListener("hashchange", leavePreviewWhenRouteChanges);
    window.addEventListener("popstate", leavePreviewWhenRouteChanges);
    return () => {
      window.removeEventListener("hashchange", leavePreviewWhenRouteChanges);
      window.removeEventListener("popstate", leavePreviewWhenRouteChanges);
    };
  }, [reportPreview]);

  useEffect(() => {
    if (!reportPreview) return undefined;
    async function refreshMemoEdits() {
      if (document.visibilityState !== "visible") return;
      const refreshed = await Promise.all(reportPreview.map(async (entry) => {
        if (!entry.memoId) return entry;
        const stored = await readMemoPayload(entry.memoId);
        return stored ? { ...entry, imageMemo: stored, reportOptions: normalizeReportOptions(stored.reportOptions ?? entry.reportOptions) } : entry;
      }));
      setReportPreview(refreshed);
    }
    window.addEventListener("focus", refreshMemoEdits);
    document.addEventListener("visibilitychange", refreshMemoEdits);
    return () => {
      window.removeEventListener("focus", refreshMemoEdits);
      document.removeEventListener("visibilitychange", refreshMemoEdits);
    };
  }, [reportPreview]);

  const canCompare = Boolean(left?.file instanceof File && right?.file instanceof File);
  const comparableGitFiles = useMemo(() => (gitInfo?.files ?? []).filter((file) => file.comparable), [gitInfo]);
  const gitTargets = useMemo(() => comparableGitFiles.flatMap((file) => {
    const targets = [{ file, mode: file.kind === "text" ? "text" : "image" }];
    if (file.kind === "text" && file.embedded_excalidraw) {
      targets.push({ file, mode: "excalidraw" });
    }
    return targets;
  }), [comparableGitFiles]);
  const exportableGitFiles = useMemo(
    () => comparableGitFiles.filter((file) => !gitExportExcluded.includes(file.path)),
    [comparableGitFiles, gitExportExcluded],
  );
  const currentGitTarget = gitTargets[gitIndex] ?? null;
  const currentGitFile = currentGitTarget?.file ?? null;
  const currentGitView = currentGitTarget?.mode ?? null;
  const gitTextMode = activeTab === "git" && currentGitFile?.kind === "text" && currentGitView === "text";
  const gitImageMode = activeTab === "git" && (currentGitFile?.kind === "image" || currentGitView === "excalidraw");
  const currentTextMemoKey = currentGitFile && gitInfo ? gitMemoKey(gitInfo.repo_root, currentGitFile.path) : "";
  const currentTextMemo = currentTextMemoKey ? gitTextMemos[currentTextMemoKey] ?? "" : "";
  const currentTextDirty = Boolean(
    currentGitFile?.kind === "text"
      && gitItem
      && normalizeLineEndings(gitItem.text_current ?? "") !== normalizeLineEndings(gitItem.text_saved ?? ""),
  );
  const activeResult = activeTab === "git" ? gitResult : result;
  const leftPreviewImage = left?.preview ? toDataUri(left.preview) : null;
  const rightPreviewImage = right?.preview ? toDataUri(right.preview) : null;
  const rightImage = useMemo(() => {
    if (!activeResult) return null;
    if (view === "original") return toDataUri(activeResult.image_b_original ?? activeResult.image_b_aligned);
    if (view === "aligned") return toDataUri(activeResult.image_b_aligned);
    if (view === "mask") return toDataUri(activeResult.mask);
    return toDataUri(activeResult.overlay);
  }, [activeResult, view]);
  const leftImage = useMemo(() => {
    if (!activeResult) return activeTab === "git" ? (gitItem?.image_head ? toDataUri(gitItem.image_head) : null) : leftPreviewImage;
    if (view === "original") return toDataUri(activeResult.image_a_original ?? activeResult.image_a);
    return toDataUri(activeResult.image_a);
  }, [activeResult, activeTab, gitItem, leftPreviewImage, view]);
  const rightPaneTitle = activeResult
    ? view === "original"
      ? "B 元画像"
      : view === "overlay"
      ? "差分オーバーレイ"
      : view === "mask"
        ? "差分マスク"
        : "B 補正済み"
    : "B 比較対象";

  function invalidateComparison() {
    requestIdRef.current += 1;
    setResult(null);
    setBusy(false);
  }

  async function loadFile(side, file, attachment = null) {
    setError("");
    invalidateComparison();
    if (side === "left") setAnchorRegion(null);
    const form = new FormData();
    form.append("file", file);
    try {
      const metadata = await postForm("/analyze", form);
      const payload = { file, metadata, attachment };
      if (side === "left") {
        setLeft(payload);
        setPageA(0);
        setActiveSide("right");
      } else {
        setRight(payload);
        setPageB(0);
        setActiveSide("left");
      }
      await loadPreview(side, file, 0);
    } catch (err) {
      setError(err.message);
    }
  }

  async function loadPreview(side, file, page) {
    const nextId = previewRequestIdRef.current[side] + 1;
    previewRequestIdRef.current = { ...previewRequestIdRef.current, [side]: nextId };
    const form = new FormData();
    form.append("file", file);
    form.append("page", String(page));
    try {
      const converted = await postForm("/convert", form);
      if (previewRequestIdRef.current[side] !== nextId) return;
      const applyPreview = (current) =>
        current?.file === file ? { ...current, preview: converted.image, regions: converted.regions ?? [] } : current;
      if (side === "left") {
        setLeft(applyPreview);
      } else {
        setRight(applyPreview);
      }
    } catch (err) {
      if (previewRequestIdRef.current[side] === nextId) {
        setError(err.message);
      }
    }
  }

  function selectPage(side, nextPage) {
    invalidateComparison();
    if (side === "left") {
      setAnchorRegion(null);
      setPageA(nextPage);
      if (left?.file) loadPreview("left", left.file, nextPage);
    } else {
      setPageB(nextPage);
      if (right?.file) loadPreview("right", right.file, nextPage);
    }
  }

  async function pasteImage(side, event) {
    setActiveSide(side);
    const file = imageFileFromClipboard(event.clipboardData);
    if (!file) return;
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const attachment = await postForm("/attachments", form);
      await loadFile(side, file, attachment);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const resultId = externalResultIdFromLocation();
    if (!resultId) return;
    setActiveTab("files");
    setBusy(true);
    setError("");
    getJson(`/diff/${encodeURIComponent(resultId)}?diff_threshold=${encodeURIComponent(diffThreshold)}`)
      .then((cachedResult) => {
        setResult(cachedResult);
        setLeft(externalFileData("A", cachedResult));
        setRight(externalFileData("B", cachedResult));
        setPageA(cachedResult.page_a ?? 0);
        setPageB(cachedResult.page_b ?? 0);
        setCategory(cachedResult.category ?? "汎用");
        setView("overlay");
      })
      .catch((err) => {
        setError(err.status === 404 ? "差分結果のキャッシュが見つかりません。もう一度 /api/diff を実行してください。" : err.message);
      })
      .finally(() => {
        setBusy(false);
      });
  }, []);

  useEffect(() => {
    if (activeTab === "files" && (!result || (!canCompare && result.alignment?.method !== "cached") || result.diff_threshold === diffThreshold)) return undefined;
    if (activeTab === "git" && (!gitResult || gitResult.diff_threshold === diffThreshold)) return undefined;
    const timer = window.setTimeout(() => {
      rethreshold(diffThreshold, activeTab);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [diffThreshold, result, gitResult, canCompare, activeTab]);

  useEffect(() => {
    function handleGitKeys(event) {
      if (activeTab !== "git" || isTypingTarget(event.target)) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        selectGitIndex(gitIndex - 1);
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        selectGitIndex(gitIndex + 1);
      }
    }
    window.addEventListener("keydown", handleGitKeys);
    return () => window.removeEventListener("keydown", handleGitKeys);
  }, [activeTab, gitIndex, gitTargets]);

  useEffect(() => {
    function handleTextEditKeys(event) {
      if (!gitTextMode) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (!modifier) return;
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveGitText();
      } else if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redoGitText();
        else undoGitText();
      }
    }
    window.addEventListener("keydown", handleTextEditKeys);
    return () => window.removeEventListener("keydown", handleTextEditKeys);
  }, [gitTextMode, currentGitFile, gitItem, gitTextHistory, currentTextDirty]);

  useEffect(() => {
    function handleResultViewKeys(event) {
      if (!activeResult || isTypingTarget(event.target) || event.key !== "Tab") return;
      event.preventDefault();
      setView((currentView) => {
        const currentIndex = TAB_TOGGLE_VIEWS.indexOf(currentView);
        if (event.shiftKey) {
          return currentIndex === 0 ? TAB_TOGGLE_VIEWS[1] : TAB_TOGGLE_VIEWS[0];
        }
        return currentIndex === 1 ? TAB_TOGGLE_VIEWS[0] : TAB_TOGGLE_VIEWS[1];
      });
    }
    window.addEventListener("keydown", handleResultViewKeys);
    return () => window.removeEventListener("keydown", handleResultViewKeys);
  }, [activeResult]);

  useEffect(() => {
    persistLocalStorage(GIT_EXTENSION_STORAGE_KEY, textExtensions);
  }, [textExtensions]);

  useEffect(() => {
    getJson("/settings/obsidian").then((settings) => {
      const folder = String(settings.obsidian_folder || "");
      setObsidianFolder(folder);
      setObsidianFolderDraft(folder);
      const reportFolder = String(settings.obsidian_report_folder || "");
      setObsidianReportFolder(reportFolder);
      setObsidianReportFolderDraft(reportFolder);
    }).catch(() => {
      // Older running servers may not expose settings yet; the rest of the UI remains usable.
    });
  }, []);

  useEffect(() => {
    const markdownPath = markdownPathFromLocation();
    if (!markdownPath) return;
    setActiveTab("git");
    setGitFolder(markdownPath);
    loadGitImages(markdownPath);
  }, []);

  useEffect(() => {
    if (
      !window.location.hash.startsWith("#report-preview")
      || reportPreview
      || reportPreviewRestoreRef.current
      || !gitInfo
      || gitBusy
      || exportBusy
    ) return;
    reportPreviewRestoreRef.current = true;
    exportGitHtml();
  }, [gitInfo, gitBusy, exportBusy, reportPreview]);

  useEffect(() => {
    persistLocalStorage(GIT_FOLDER_HISTORY_STORAGE_KEY, gitFolderHistory);
  }, [gitFolderHistory]);

  useEffect(() => {
    persistLocalStorage(GIT_TEXT_MEMO_STORAGE_KEY, gitTextMemos);
  }, [gitTextMemos]);

  useEffect(() => {
    persistLocalStorage(DISPLAY_SCALE_STORAGE_KEY, displayScale);
  }, [displayScale]);

  useEffect(() => {
    persistLocalStorage(GIT_EXTENSION_STORAGE_KEY, textExtensions);
  }, [textExtensions]);

  useEffect(() => {
    function syncSharedSettings(event) {
      if (event.key === DISPLAY_SCALE_STORAGE_KEY) setDisplayScale(loadDisplayScale());
      if (event.key === GIT_EXTENSION_STORAGE_KEY) {
        const next = loadTextExtensions();
        setTextExtensions(next);
        setExtensionDraft(next.join(", "));
      }
    }
    window.addEventListener("storage", syncSharedSettings);
    return () => window.removeEventListener("storage", syncSharedSettings);
  }, []);

  function registerCanvas(side, element) {
    canvasRefs.current[side] = element;
  }

  function syncCanvasScroll(side, event) {
    if (syncingCanvasScrollRef.current) return;
    const source = event.currentTarget;
    const other = canvasRefs.current[side === "left" ? "right" : "left"];
    if (!other) return;
    syncingCanvasScrollRef.current = true;
    other.scrollLeft = source.scrollLeft;
    other.scrollTop = source.scrollTop;
    window.requestAnimationFrame(() => {
      syncingCanvasScrollRef.current = false;
    });
  }

  function handleImageWheel(event) {
    if (!event.ctrlKey && !event.metaKey && !event.altKey) return;
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    setZoom((value) => Math.max(0.25, Math.min(3, value + direction * 0.05)));
  }

  async function saveObsidianFolderSetting() {
    setObsidianSettingsBusy(true);
    try {
      const response = await fetch(`${API_BASE}/settings/obsidian`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          obsidian_folder: obsidianFolderDraft.trim(),
          obsidian_report_folder: obsidianReportFolderDraft.trim(),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || `設定保存に失敗しました（${response.status}）`);
      const folder = String(body.obsidian_folder || "");
      setObsidianFolder(folder);
      setObsidianFolderDraft(folder);
      const reportFolder = String(body.obsidian_report_folder || "");
      setObsidianReportFolder(reportFolder);
      setObsidianReportFolderDraft(reportFolder);
      setGitError("");
    } catch (err) {
      setGitError(`Obsidianフォルダー設定を保存できませんでした: ${err.message}`);
    } finally {
      setObsidianSettingsBusy(false);
    }
  }

  function selectCategory(nextCategory) {
    setCategory(nextCategory);
    invalidateComparison();
    if (gitImageMode && currentGitFile?.diffable) {
      const requestId = gitRequestIdRef.current + 1;
      gitRequestIdRef.current = requestId;
      setGitResult(null);
      setGitItem(null);
      setGitBusy(true);
      setGitError("");
      compareGitFile(currentGitFile, requestId, nextCategory, gitInfo?.folder || gitFolder, currentGitView)
        .catch((err) => {
          if (requestId === gitRequestIdRef.current) setGitError(err.message);
        })
        .finally(() => {
          if (requestId === gitRequestIdRef.current) setGitBusy(false);
        });
    } else {
      setGitResult(null);
    }
  }

  function selectAnchorRegion(region) {
    setAnchorRegion(region);
    invalidateComparison();
  }

  function clearAnchorRegion() {
    setAnchorRegion(null);
    invalidateComparison();
  }

  async function compare(threshold = diffThreshold) {
    if (!canCompare) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file_a", left.file);
      form.append("file_b", right.file);
      form.append("page_a", String(pageA));
      form.append("page_b", String(pageB));
      form.append("category", category);
      form.append("diff_threshold", String(threshold));
      if (anchorRegion) {
        form.append("anchor_region", JSON.stringify(anchorRegion));
      }
      const nextResult = await postForm("/diff", form);
      if (requestId === requestIdRef.current) {
        setResult(nextResult);
      }
    } catch (err) {
      if (requestId === requestIdRef.current) {
        setError(err.message);
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setBusy(false);
      }
    }
  }

  async function rethreshold(threshold, target = "files") {
    const sourceResult = target === "git" ? gitResult : result;
    if (!sourceResult) return;
    const requestId = target === "git" ? gitRequestIdRef.current + 1 : requestIdRef.current + 1;
    if (target === "git") {
      gitRequestIdRef.current = requestId;
      setGitBusy(true);
      setGitError("");
    } else {
      requestIdRef.current = requestId;
      setBusy(true);
      setError("");
    }
    try {
      const payload = sourceResult.result_id
        ? { result_id: sourceResult.result_id, diff_threshold: threshold }
        : {
            image_a: sourceResult.image_a,
            image_b_aligned: sourceResult.image_b_aligned,
            diff_threshold: threshold,
          };
      let nextDiff;
      try {
        nextDiff = await postJson("/rediff", payload);
      } catch (err) {
        if (err.status !== 404 || !sourceResult.image_a || !sourceResult.image_b_aligned) throw err;
        nextDiff = await postJson("/rediff", {
          image_a: sourceResult.image_a,
          image_b_aligned: sourceResult.image_b_aligned,
          diff_threshold: threshold,
        });
      }
      if (target === "git" && requestId === gitRequestIdRef.current) {
        setGitResult((current) => (current ? { ...current, ...nextDiff } : current));
      }
      if (target === "files" && requestId === requestIdRef.current) {
        setResult((current) => (current ? { ...current, ...nextDiff } : current));
      }
    } catch (err) {
      if (target === "git" && requestId === gitRequestIdRef.current) {
        setGitError(err.message);
      }
      if (target === "files" && requestId === requestIdRef.current) {
        setError(err.message);
      }
    } finally {
      if (target === "git" && requestId === gitRequestIdRef.current) {
        setGitBusy(false);
      }
      if (target === "files" && requestId === requestIdRef.current) {
        setBusy(false);
      }
    }
  }

  if (reportPreview) {
    return (
      <ReportPreviewPage
        entries={reportPreview}
        busy={exportBusy}
        onClose={closeReportPreviewPage}
        onChange={setReportPreview}
        onRevertLine={revertPreviewLine}
        onExport={() => finalizeGitHtml(reportPreview)}
        error={gitError}
      />
    );
  }

  return (
    <main
      className={`app-shell ${gitTextMode ? "text-diff-mode" : ""}`}
      style={{ zoom: displayScale, height: `${100 / displayScale}vh` }}
    >
      <header className="app-header">
        <div className="header-main">
          <h1>Visual Diff Tool</h1>
          <nav className="mode-tabs" aria-label="diff mode">
            <button className={activeTab === "files" ? "active" : ""} onClick={() => setActiveTab("files")}>
              <ImageUp size={18} />
              ファイル差分
            </button>
            <button className={activeTab === "git" ? "active" : ""} onClick={() => setActiveTab("git")}>
              <FolderGit2 size={18} />
              git差分
            </button>
          </nav>
        </div>
        <div className="header-menu">
          <button className="menu-button" type="button" aria-label="メニュー" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
            <Menu size={22} />
          </button>
          {menuOpen && (
            <div className="hamburger-menu" role="menu">
              <div className="extension-settings">
                  <strong className="extension-settings-title">Git対象拡張子</strong>
                  <label>
                    <span>テキスト拡張子（カンマ区切り）</span>
                    <textarea value={extensionDraft} onChange={(event) => setExtensionDraft(event.target.value)} />
                  </label>
                  <small>画像形式は常に対象です。設定はこのブラウザに保存されます。</small>
                  <div>
                    <button
                      type="button"
                      onClick={() => {
                        const next = normalizeTextExtensions(extensionDraft);
                        setTextExtensions(next);
                        setExtensionDraft(next.join(", "));
                        setGitInfo(null);
                        setGitResult(null);
                        setGitItem(null);
                      }}
                    >
                      適用
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setExtensionDraft(DEFAULT_TEXT_EXTENSIONS.join(", "));
                        setTextExtensions(DEFAULT_TEXT_EXTENSIONS);
                      }}
                    >
                      初期値
                    </button>
                  </div>
                  <label className="obsidian-folder-setting">
                    <span>Obsidianフォルダー（サーバー保存）</span>
                    <input
                      type="text"
                      value={obsidianFolderDraft}
                      placeholder="/path/to/obsidian-vault"
                      onChange={(event) => setObsidianFolderDraft(event.target.value)}
                    />
                  </label>
                  <small>Markdownファイルを指定したときのリンク解決に使用します。</small>
                  <label className="obsidian-folder-setting">
                    <span>Obsidianレポート保存先（サーバー保存）</span>
                    <input
                      type="text"
                      value={obsidianReportFolderDraft}
                      placeholder="/path/to/report-folder"
                      onChange={(event) => setObsidianReportFolderDraft(event.target.value)}
                    />
                  </label>
                  <small>Obsidian起点のHTML差分レポートをこのフォルダーへ保存します。</small>
                  <label className="display-scale-setting">
                      <span>このアプリの表示倍率 {Math.round(displayScale * 100)}%</span>
                      <input
                        type="range"
                        min="50"
                        max="200"
                      step="5"
                      value={Math.round(displayScale * 100)}
                      onChange={(event) => setDisplayScale(Number(event.target.value) / 100)}
                    />
                  </label>
                  <div>
                    <button type="button" disabled={obsidianSettingsBusy} onClick={saveObsidianFolderSetting}>
                      {obsidianSettingsBusy ? "保存中…" : "サーバーへ保存"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setObsidianFolderDraft(obsidianFolder);
                        setObsidianReportFolderDraft(obsidianReportFolder);
                      }}
                    >
                      戻す
                    </button>
                    <button type="button" onClick={() => setDisplayScale(1)}>表示倍率100%</button>
                  </div>
              </div>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  window.open("/api-guide", "_blank", "noopener,noreferrer");
                }}
              >
                <BookOpenText size={18} />
                APIエンドポイント説明
                <ExternalLink size={16} />
              </button>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setHelpOpen(true); }}>
                <HelpCircle size={18} />
                ショートカットと操作
              </button>
            </div>
          )}
        </div>
      </header>

      <section className="toolbar" aria-label="compare settings">
        {activeTab === "files" ? (
          <>
            <FilePicker
              label="A"
              side="left"
              active={activeSide === "left"}
              data={left}
              page={pageA}
              setPage={(page) => selectPage("left", page)}
              onActivate={setActiveSide}
              onPasteImage={pasteImage}
              onFile={(file) => loadFile("left", file)}
              onDropFile={(file) => loadFile("left", file)}
            />
            <FilePicker
              label="B"
              side="right"
              active={activeSide === "right"}
              data={right}
              page={pageB}
              setPage={(page) => selectPage("right", page)}
              onActivate={setActiveSide}
              onPasteImage={pasteImage}
              onFile={(file) => loadFile("right", file)}
              onDropFile={(file) => loadFile("right", file)}
            />
            <button className="primary" disabled={!canCompare || busy} onClick={() => compare()}>
              {busy ? <Loader2 className="spin" size={18} /> : <ScanSearch size={18} />}
              比較
            </button>
            <button className="primary secondary" disabled={!result} onClick={() => openDiffMemoTab(result, left, right, setError)}>
              <PanelTopOpen size={18} />
              差分メモ
            </button>
          </>
        ) : (
          <GitToolbar
            folder={gitFolder}
            folderHistory={gitFolderHistory}
            setFolder={(value) => {
              gitRequestIdRef.current += 1;
              setGitFolder(value);
              setGitInfo(null);
              setGitIndex(0);
              setGitResult(null);
              setGitItem(null);
              setGitExportExcluded([]);
              setGitError("");
              setExportNotice("");
              setGitBusy(false);
            }}
            info={gitInfo}
            files={comparableGitFiles}
            targets={gitTargets}
            currentFile={currentGitFile}
            currentView={currentGitView}
            index={gitIndex}
            busy={gitBusy}
            onLoad={loadGitImages}
            onPrevious={() => selectGitIndex(gitIndex - 1)}
            onNext={() => selectGitIndex(gitIndex + 1)}
            onSelect={(index) => selectGitIndex(index)}
            onSelectFolder={(value) => {
              gitRequestIdRef.current += 1;
              setGitFolder(value);
              setGitInfo(null);
              setGitIndex(0);
              setGitResult(null);
              setGitItem(null);
              setGitExportExcluded([]);
              setGitError("");
              setExportNotice("");
              setGitBusy(false);
            }}
            onMemo={() => openGitMemo()}
            canMemo={currentGitFile?.kind === "image" && Boolean(gitResult || gitItem?.image_head || gitItem?.image_current)}
            onExport={exportGitHtml}
            canExport={Boolean(exportableGitFiles.length)}
            exportBusy={exportBusy}
            onOpenExportSelection={() => setExportSelectionOpen(true)}
            exportCount={exportableGitFiles.length}
          />
        )}
        {activeTab === "git" && exportSelectionOpen && (
          <ExportSelectionModal
            files={comparableGitFiles}
            excludedPaths={gitExportExcluded}
            busy={gitBusy || exportBusy}
            onToggle={(path, included) => setGitExportExcluded((paths) => included
              ? paths.filter((item) => item !== path)
              : [...new Set([...paths, path])])}
            onIncludeAll={() => setGitExportExcluded([])}
            onExcludeAll={() => setGitExportExcluded(comparableGitFiles.map((file) => file.path))}
            onClose={() => setExportSelectionOpen(false)}
          />
        )}
        {(activeTab === "files" || gitImageMode) && <div className="control">
          <span>カテゴリ</span>
          <div className="segmented">
            {CATEGORIES.map((item) => (
              <button key={item} className={category === item ? "active" : ""} onClick={() => selectCategory(item)}>
                {item}
              </button>
            ))}
          </div>
        </div>}
        {(activeTab === "files" || gitImageMode) && <div className="control">
          <span>表示</span>
          <div className="segmented">
            {VIEWS.map((item) => (
              <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
        </div>}
        {(activeTab === "files" || gitImageMode) && <label className="control threshold-control">
          <span>差分しきい値 {diffThreshold.toFixed(2)}</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={diffThreshold}
            onChange={(event) => setDiffThreshold(Number(event.target.value))}
          />
        </label>}
        {activeTab === "files" && <div className="control anchor-control">
          <span>基準領域</span>
          <button className={`anchor-status ${anchorRegion ? "selected" : ""}`} disabled={!left?.regions?.length} onClick={clearAnchorRegion}>
            {anchorRegion ? <X size={16} /> : <MousePointer2 size={16} />}
            {anchorRegion ? `${anchorRegion.label}を使用` : `${left?.regions?.length ?? 0}候補`}
          </button>
        </div>}
        {(activeTab === "files" || gitImageMode) && <div className="icon-group" aria-label="zoom">
          <button title="縮小" onClick={() => setZoom((value) => Math.max(0.25, value - 0.1))}>
            <ZoomOut size={18} />
          </button>
          <output>{Math.round(zoom * 100)}%</output>
          <button title="拡大" onClick={() => setZoom((value) => Math.min(3, value + 0.1))}>
            <ZoomIn size={18} />
          </button>
        </div>}
      </section>

      {exportNotice && <div className="notice success">{exportNotice}</div>}

      {(activeTab === "git" ? gitError : error) && (
        <div className="notice error">
          <AlertTriangle size={18} />
          {activeTab === "git" ? gitError : error}
        </div>
      )}

      {activeResult?.alignment?.warning && (
        <div className="notice warning">
          <AlertTriangle size={18} />
          位置合わせ失敗、未補正で表示中: {activeResult.alignment.warning}
        </div>
      )}

      {activeResult?.conversion_warnings?.length > 0 && (
        <div className="notice warning">
          <AlertTriangle size={18} />
          変換時の注意: {activeResult.conversion_warnings.join(" / ")}
        </div>
      )}

      {(activeTab === "files" || gitImageMode) && <section className="summary">
        <Stat label="差分ピクセル" value={activeResult ? activeResult.diff_pixels.toLocaleString() : "-"} />
        <Stat label="差分率" value={activeResult ? `${(activeResult.diff_ratio * 100).toFixed(3)}%` : "-"} />
        <Stat label="しきい値" value={activeResult ? activeResult.diff_threshold.toFixed(2) : diffThreshold.toFixed(2)} />
        <Stat label="マッチ数" value={activeResult ? `${activeResult.alignment.matches} / ${activeResult.alignment.inliers}` : "-"} />
        <Stat label="矩形" value={activeResult ? activeResult.diff_rects.length : "-"} />
      </section>}

      {gitTextMode ? (
        <TextDiffView
          file={currentGitFile}
          item={gitItem}
          memo={currentTextMemo}
          busy={gitBusy}
          previewBusy={gitTextBusy}
          dirty={currentTextDirty}
          onEditText={editGitText}
          onSave={saveGitText}
          onRevertLine={revertGitTextLine}
          onMemoChange={(value) => setGitTextMemos((current) => ({ ...current, [currentTextMemoKey]: value }))}
        />
      ) : <section className="viewer">
        <ImagePane
          title={activeTab === "git" ? "変更前" : "A 基準"}
          side="left"
          active={activeSide === "left"}
          subtitle={activeTab === "git" ? currentGitFile?.head_path : left?.file?.name}
          image={leftImage}
          zoom={zoom}
          regions={activeTab === "git" || (activeResult && view !== "original") ? [] : left?.regions ?? []}
          selectedRegion={anchorRegion}
          onSelectRegion={selectAnchorRegion}
          onActivate={setActiveSide}
          onPasteImage={pasteImage}
          onDropFile={(file) => loadFile("left", file)}
          onCanvasRef={(element) => registerCanvas("left", element)}
          onCanvasScroll={(event) => syncCanvasScroll("left", event)}
          onCanvasWheel={handleImageWheel}
        />
        <ImagePane
          title={rightPaneTitle}
          side="right"
          active={activeSide === "right"}
          subtitle={activeTab === "git" ? currentGitFile?.path : right?.file?.name}
          image={activeResult ? rightImage : activeTab === "git" ? (gitItem?.image_current ? toDataUri(gitItem.image_current) : null) : rightPreviewImage}
          zoom={zoom}
          regions={[]}
          selectedRegion={null}
          onActivate={setActiveSide}
          onPasteImage={pasteImage}
          onDropFile={(file) => loadFile("right", file)}
          onCanvasRef={(element) => registerCanvas("right", element)}
          onCanvasScroll={(event) => syncCanvasScroll("right", event)}
          onCanvasWheel={handleImageWheel}
        />
      </section>}
      {helpOpen && <ShortcutHelp page={activeTab === "git" ? "git" : "files"} onClose={() => setHelpOpen(false)} />}
    </main>
  );

  async function loadGitImages(folderOverride = gitFolder) {
    const requestId = gitRequestIdRef.current + 1;
    gitRequestIdRef.current = requestId;
    setGitBusy(true);
    setGitError("");
    setGitResult(null);
    setGitItem(null);
    try {
      const folder = String(folderOverride || "").trim();
      const info = await postJson("/git/files", { folder, text_extensions: textExtensions });
      if (requestId !== gitRequestIdRef.current) return;
      setGitInfo(info);
      const normalizedFolder = folder;
      if (normalizedFolder) {
        setGitFolderHistory((history) => [normalizedFolder, ...history.filter((item) => item !== normalizedFolder)].slice(0, 12));
      }
      setGitExportExcluded([]);
      const nextFiles = (info.files ?? []).filter((file) => file.comparable);
      setGitIndex(0);
      if (nextFiles[0]) {
        await loadGitFile(nextFiles[0], requestId, info.folder || folder, nextFiles[0].kind === "text" ? "text" : "image");
      }
    } catch (err) {
      if (requestId === gitRequestIdRef.current) setGitError(err.message);
    } finally {
      if (requestId === gitRequestIdRef.current) setGitBusy(false);
    }
  }

  async function selectGitIndex(nextIndex) {
    if (!gitTargets.length) return;
    const wrappedIndex = (nextIndex + gitTargets.length) % gitTargets.length;
    const target = gitTargets[wrappedIndex];
    setGitIndex(wrappedIndex);
    if (target.file.path === currentGitFile?.path) {
      if (target.mode === currentGitView) return;
      if (target.mode === "text" && gitItem) {
        setGitResult(null);
        return;
      }
    }
    const requestId = gitRequestIdRef.current + 1;
    gitRequestIdRef.current = requestId;
    setGitBusy(true);
    setGitError("");
    setGitResult(null);
    setGitItem(null);
    try {
      await loadGitFile(target.file, requestId, undefined, target.mode);
    } catch (err) {
      if (requestId === gitRequestIdRef.current) setGitError(err.message);
    } finally {
      if (requestId === gitRequestIdRef.current) setGitBusy(false);
    }
  }

  async function compareGitFile(
    file,
    requestId = gitRequestIdRef.current,
    selectedCategory = category,
    folderOverride = gitInfo?.folder || gitFolder,
    targetMode = "image",
  ) {
    const nextResult = await postJson("/git/diff", {
      folder: folderOverride,
      path: file.path,
      head_path: file.head_path,
      category: selectedCategory,
      diff_threshold: diffThreshold,
      ...(targetMode === "excalidraw" ? { subresource: "excalidraw" } : {}),
    });
    if (requestId === gitRequestIdRef.current) {
      setGitResult(nextResult);
    }
  }

  async function loadGitFile(file, requestId = gitRequestIdRef.current, folderOverride = gitInfo?.folder || gitFolder, targetMode = file.kind === "text" ? "text" : "image") {
    if ((file.kind === "image" || targetMode === "excalidraw") && file.diffable) {
      await compareGitFile(file, requestId, targetMode === "excalidraw" ? "図面" : category, folderOverride, targetMode);
      return;
    }
    const nextItem = await postJson("/git/item", {
      folder: folderOverride,
      text_extensions: textExtensions,
      include_text: file.kind === "text",
      ...file,
    });
    if (requestId === gitRequestIdRef.current) {
      if (file.kind === "text") {
        const textCurrent = normalizeLineEndings(nextItem.text_current ?? "");
        const textHead = normalizeLineEndings(nextItem.text_head ?? "");
        setGitItem({ ...nextItem, text_head: textHead, text_current: textCurrent, text_saved: textCurrent });
        setGitTextHistory({ path: file.path, undo: [], redo: [] });
      } else {
        setGitItem(nextItem);
        setGitTextHistory({ path: "", undo: [], redo: [] });
      }
    }
  }

  async function previewGitText(nextText, { recordHistory = true } = {}) {
    if (!currentGitFile || currentGitFile.kind !== "text" || !gitInfo || !gitItem) return;
    const normalizedText = normalizeLineEndings(nextText);
    const currentText = normalizeLineEndings(gitItem.text_current ?? "");
    if (normalizedText === currentText) return;
    if (recordHistory) {
      setGitTextHistory((history) => history.path === currentGitFile.path
        ? { path: history.path, undo: [...history.undo, currentText], redo: [] }
        : { path: currentGitFile.path, undo: [currentText], redo: [] });
    }
    const requestId = gitTextPreviewRequestRef.current + 1;
    gitTextPreviewRequestRef.current = requestId;
    setGitItem((current) => current ? { ...current, text_current: normalizedText } : current);
    setGitTextBusy(true);
    setGitError("");
    try {
      const preview = await postJson("/git/text-diff", {
        folder: gitInfo.folder || gitFolder,
        text_extensions: textExtensions,
        path: currentGitFile.path,
        head_path: currentGitFile.head_path,
        has_head: currentGitFile.has_head,
        text: normalizedText,
      });
      if (requestId === gitTextPreviewRequestRef.current) {
        setGitItem((current) => current ? { ...current, text_current: normalizedText, rows: preview.rows } : current);
      }
    } catch (err) {
      if (requestId === gitTextPreviewRequestRef.current) setGitError(`編集内容を反映できませんでした: ${err.message}`);
    } finally {
      if (requestId === gitTextPreviewRequestRef.current) setGitTextBusy(false);
    }
  }

  function editGitText(row, value) {
    if (!gitItem || !Number.isInteger(row.new_index)) return;
    const lines = normalizeLineEndings(gitItem.text_current ?? "").split("\n");
    if (row.new_index < 0 || row.new_index >= lines.length) return;
    lines[row.new_index] = value;
    previewGitText(lines.join("\n"));
  }

  function undoGitText() {
    if (!currentGitFile || !gitItem || gitTextHistory.path !== currentGitFile.path || !gitTextHistory.undo.length) return;
    const currentText = normalizeLineEndings(gitItem.text_current ?? "");
    const previousText = gitTextHistory.undo[gitTextHistory.undo.length - 1];
    setGitTextHistory((history) => ({
      path: history.path,
      undo: history.undo.slice(0, -1),
      redo: [...history.redo, currentText],
    }));
    previewGitText(previousText, { recordHistory: false });
  }

  function redoGitText() {
    if (!currentGitFile || !gitItem || gitTextHistory.path !== currentGitFile.path || !gitTextHistory.redo.length) return;
    const currentText = normalizeLineEndings(gitItem.text_current ?? "");
    const nextText = gitTextHistory.redo[gitTextHistory.redo.length - 1];
    setGitTextHistory((history) => ({
      path: history.path,
      undo: [...history.undo, currentText],
      redo: history.redo.slice(0, -1),
    }));
    previewGitText(nextText, { recordHistory: false });
  }

  async function saveGitText() {
    if (!currentGitFile || currentGitFile.kind !== "text" || !gitInfo || !gitItem || !currentTextDirty || gitTextBusy) return;
    const text = normalizeLineEndings(gitItem.text_current ?? "");
    setGitTextBusy(true);
    setGitError("");
    try {
      const saved = await postJson("/git/save-text", {
        folder: gitInfo.folder || gitFolder,
        text_extensions: textExtensions,
        path: currentGitFile.path,
        head_path: currentGitFile.head_path,
        has_head: currentGitFile.has_head,
        base_text: normalizeLineEndings(gitItem.text_saved ?? ""),
        text,
      });
      setGitItem((current) => current ? {
        ...current,
        text_current: normalizeLineEndings(saved.text_current ?? text),
        text_saved: normalizeLineEndings(saved.text_current ?? text),
        rows: saved.rows,
      } : current);
      setGitTextHistory({ path: currentGitFile.path, undo: [], redo: [] });
      setExportNotice(`${currentGitFile.path} を保存しました。`);
    } catch (err) {
      setGitError(`保存できませんでした: ${err.message}`);
    } finally {
      setGitTextBusy(false);
    }
  }

  async function openGitMemo() {
    if (!currentGitFile || !gitInfo) return;
    const fallbackImage = gitItem?.image_head ?? gitItem?.image_current;
    const memoResult = gitResult ?? (fallbackImage ? {
      image_a: gitItem?.image_head ?? fallbackImage,
      image_b_aligned: gitItem?.image_current ?? fallbackImage,
    } : null);
    if (!memoResult) return;
    const id = gitImageMemoId(gitInfo.repo_root, currentGitFile.path);
    const memoFiles = comparableGitFiles.filter((file) => file.kind === "image");
    const memoIndex = memoFiles.findIndex((file) => file.path === currentGitFile.path);
    await openDiffMemoTab(
      memoResult,
      { file: { name: `変更前:${currentGitFile.head_path}` } },
      { file: { name: currentGitFile.path } },
      setGitError,
      id,
      {
        reportPreviewReturn: true,
        memoNavigation: memoIndex >= 0 ? {
          folder: gitInfo.folder || gitFolder,
          repo_root: gitInfo.repo_root,
          files: memoFiles,
          index: memoIndex,
          category,
          diff_threshold: diffThreshold,
          text_extensions: textExtensions,
        } : null,
      },
    );
  }

  async function exportGitHtml() {
    if (!gitInfo || !exportableGitFiles.length) return;
    setExportBusy(true);
    setExportNotice("");
    setGitError("");
    try {
      const entries = [];
      for (const file of exportableGitFiles) {
        let data;
        const isCurrent = file.path === currentGitFile?.path;
        if (isCurrent && file.kind === "image" && file.diffable && gitResult) {
          data = gitResult;
        } else if (isCurrent && gitItem) {
          data = gitItem;
        } else if (file.kind === "image" && file.diffable) {
          data = await postJson("/git/diff", {
            folder: gitInfo.folder || gitFolder,
            path: file.path,
            head_path: file.head_path,
            category,
            diff_threshold: diffThreshold,
          });
        } else {
          data = await postJson("/git/item", {
            folder: gitInfo.folder || gitFolder,
            text_extensions: textExtensions,
            include_text: false,
            ...file,
          });
        }
        let memo = "";
        let imageMemo = null;
        if (file.kind === "text") {
          memo = gitTextMemos[gitMemoKey(gitInfo.repo_root, file.path)] ?? "";
        } else {
          imageMemo = await readMemoPayload(gitImageMemoId(gitInfo.repo_root, file.path));
        }
        entries.push({ file, data, memo, imageMemo });
      }
      setReportPreview(entries.map((entry) => ({
        ...entry,
        memoId: entry.file.kind === "image" ? gitImageMemoId(gitInfo.repo_root, entry.file.path) : null,
        reportOptions: normalizeReportOptions(entry.imageMemo?.reportOptions),
      })));
      window.history.pushState(null, "", `${window.location.pathname}${window.location.search}#report-preview`);
      setExportNotice("プレビューを作成しました。内容を調整してから出力してください。");
    } catch (err) {
      setGitError(`HTMLプレビューを作成できませんでした: ${err.message}`);
    } finally {
      setExportBusy(false);
    }
  }

  async function revertPreviewLine(entryIndex, row) {
    if (!gitInfo) return;
    const entry = reportPreview?.[entryIndex];
    if (!entry || entry.file.kind !== "text") return;
    setExportBusy(true);
    setGitError("");
    try {
      const restored = await postJson("/git/revert-line", {
        folder: gitInfo.folder || gitFolder,
        text_extensions: textExtensions,
        path: entry.file.path,
        head_path: entry.file.head_path,
        row,
      });
      setReportPreview((current) => current?.map((item, index) => (
        index === entryIndex ? { ...item, data: { ...item.data, rows: restored.rows } } : item
      )) ?? null);
      if (entry.file.path === currentGitFile?.path) {
        setGitItem((current) => current ? { ...current, rows: restored.rows } : current);
      }
      setExportNotice(`${entry.file.path} の1行を変更前へ戻しました。`);
    } catch (err) {
      setGitError(`行を戻せませんでした: ${err.message}`);
    } finally {
      setExportBusy(false);
    }
  }

  async function revertGitTextLine(row) {
    if (!gitItem || !currentGitFile || currentGitFile.kind !== "text") return;
    const lines = normalizeLineEndings(gitItem.text_current ?? "").split("\n");
    const index = Number.isInteger(row.new_index) ? row.new_index : lines.length;
    if (row.kind === "insert") {
      if (index >= 0 && index < lines.length) lines.splice(index, 1);
    } else if (row.kind === "delete") {
      lines.splice(Math.max(0, Math.min(index, lines.length)), 0, String(row.old ?? ""));
    } else if (row.kind === "replace" && index >= 0 && index < lines.length) {
      lines[index] = String(row.old ?? "");
    } else {
      return;
    }
    previewGitText(lines.join("\n"));
  }

  async function finalizeGitHtml(entries) {
    if (!gitInfo || !entries.length) {
      setGitError("HTML出力に必要な情報がありません。プレビューを閉じて、もう一度開いてください。");
      return;
    }
    setExportBusy(true);
    setExportNotice("");
    setGitError("");
    try {
      const html = await buildStandaloneGitReport(gitInfo, entries);
      const filename = gitReportFilename(gitInfo);
      if (gitInfo.source_markdown && obsidianReportFolder) {
        const saved = await postJson("/reports/save", {
          html,
          filename,
          source_markdown: gitInfo.source_markdown,
        });
        setExportNotice(`HTMLを保存しました: ${saved.path}`);
      } else {
        downloadTextFile(html, filename, "text/html;charset=utf-8");
        setExportNotice(`HTMLを保存しました（${entries.length}件、外部接続なしで閲覧できます）`);
      }
      closeReportPreviewPage();
    } catch (err) {
      setGitError(`HTML出力に失敗しました: ${err.message}`);
    } finally {
      setExportBusy(false);
    }
  }

  function closeReportPreviewPage() {
    setReportPreview(null);
    if (window.location.hash.startsWith("#report-preview")) {
      window.history.back();
    }
  }
}

function ApiGuideApp() {
  const [helpOpen, setHelpOpen] = useShortcutHelp();
  return (
    <main className="api-guide-page">
      <header className="api-guide-header">
        <div>
          <h1>Visual Diff Tool API Guide</h1>
          <p>外部アプリやAIエージェントが本アプリのAPIを呼び出すための実装仕様</p>
        </div>
        <div>
          <button type="button" className="primary secondary" onClick={() => setHelpOpen(true)}><HelpCircle size={18} />ヘルプ</button>
          <a className="primary secondary api-guide-openapi" href="/docs" target="_blank" rel="noreferrer">
            <ExternalLink size={18} />
            FastAPI docs
          </a>
        </div>
      </header>

      <section className="api-guide-content">
        <ApiGuideSection title="基本情報">
          <ul>
            <li>Application Base URL: <code>http://127.0.0.1:8078/</code></li>
            <li>API Base URL: <code>http://127.0.0.1:8078/api</code>。各エンドポイントはこのURLに <code>/health</code>, <code>/diff</code> などを連結して呼び出す。</li>
            <li>画像データはレスポンス内で <code>{"{ mime_type: \"image/png\", data: \"...\" }"}</code> の形で返る。<code>data</code> は data URI prefix を含まないPNGのBase64文字列。</li>
            <li>アップロード上限は1ファイルあたりバックエンド設定の <code>MAX_UPLOAD_BYTES</code> に従う。上限超過時は <code>413</code>。</li>
            <li>対応入力形式: PNG, JPG/JPEG, WebP, BMP, GIF, TIFF/TIF, SVG, PDF, Excalidraw。</li>
            <li>ページ番号は0始まり。PDF/TIFFなど複数ページ形式は <code>/analyze</code> でページ一覧を取得し、選択したページを <code>page</code>, <code>page_a</code>, <code>page_b</code> に指定する。</li>
            <li>エラーは主に <code>{"{ detail: \"message\" }"}</code> 形式で返る。クライアントはHTTPステータスと <code>detail</code> を表示またはログ化する。</li>
          </ul>
        </ApiGuideSection>

        <ApiEndpoint
          method="GET"
          path="/api/health"
          purpose="バックエンドが起動してAPIを受け付けられるか確認する。"
          request="リクエストボディなし。"
          response={`{ "status": "ok" }`}
          notes="外部アプリは初期化時にこのエンドポイントを呼び、200以外ならAPI未起動として扱う。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/analyze"
          purpose="アップロードファイルの形式、ページ数、各ページのサイズ、変換時の注意を取得する。比較前の事前検査に使う。"
          request={`Content-Type: multipart/form-data
file: 対象ファイル`}
          response={`{
  "filename": "drawing.pdf",
  "format": "pdf",
  "page_count": 2,
  "pages": [
    { "index": 0, "width": 1240, "height": 1754, "warnings": [] }
  ],
  "warnings": []
}`}
          notes="Excalidrawでは未対応表現がwarningsに入る。UIや外部アプリは警告をユーザーに見せるとよい。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/convert"
          purpose="指定ページをPNG相当にラスタライズし、プレビュー画像と基準領域候補を取得する。"
          request={`Content-Type: multipart/form-data
file: 対象ファイル
page: 0始まりのページ番号。省略時は0`}
          response={`{
  "filename": "drawing.svg",
  "format": "svg",
  "page": 0,
  "width": 800,
  "height": 600,
  "image": { "mime_type": "image/png", "data": "base64..." },
  "regions": [
    { "x": 10, "y": 20, "width": 300, "height": 200, "label": "枠線候補" }
  ],
  "warnings": []
}`}
          notes="regionsは後続の/api/diffでanchor_regionとして使える。画像表示時は data:image/png;base64, をprefixとして付ける。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/diff"
          purpose="2つのファイルを指定ページで比較し、位置合わせ済み画像、差分オーバーレイ、マスク、差分矩形、差分率を返す。"
          request={`Content-Type: multipart/form-data
file_a: 基準ファイル
file_b: 比較対象ファイル
page_a: 基準ファイルのページ番号。省略時0
page_b: 比較対象ファイルのページ番号。省略時0
category: 汎用 | 図面 | グラフ | 書類。省略時 汎用
diff_threshold: 0.0から1.0の差分しきい値。省略時0.1
anchor_region: 任意。JSON文字列。例 {"x":0,"y":0,"width":800,"height":600,"label":"全体枠候補"}`}
          response={`{
  "result_id": "cache-id",
  "filename_a": "drawing-before.png",
  "filename_b": "clipboard.png",
  "page_a": 0,
  "page_b": 0,
  "category": "図面",
  "width": 800,
  "height": 600,
  "alignment": {
    "success": true,
    "method": "ORB homography",
    "warning": null,
    "matches": 120,
    "inliers": 88,
    "matrix": [[1,0,0],[0,1,0],[0,0,1]]
  },
  "image_a": { "mime_type": "image/png", "data": "base64..." },
  "image_a_original": { "mime_type": "image/png", "data": "base64..." },
  "image_b_original": { "mime_type": "image/png", "data": "base64..." },
  "image_b_aligned": { "mime_type": "image/png", "data": "base64..." },
  "overlay": { "mime_type": "image/png", "data": "base64..." },
  "mask": { "mime_type": "image/png", "data": "base64..." },
  "diff_rects": [{ "x": 100, "y": 80, "width": 40, "height": 20, "area": 800 }],
  "diff_pixels": 1234,
  "diff_ratio": 0.00257,
  "diff_threshold": 0.1,
  "conversion_warnings": []
}`}
          notes="AIや外部アプリが最初に使う中心API。result_idが返り、localhost/127.0.0.1で呼ばれた場合は、成功後にWebアプリも http://127.0.0.1:8078/?result_id=... 形式で自動表示する。巨大ペアがキャッシュ上限を超える場合、result_idはnull。差分の可視化はoverlay、二値的な差分抽出はmask、機械判定はdiff_ratioとdiff_rectsを見る。"
        />

        <ApiEndpoint
          method="GET"
          path="/api/diff/{result_id}"
          purpose="/api/diffで作成済みの短期キャッシュ結果を取得し、外部アプリからWeb画面表示へつなぐ。"
          request={`Query:
diff_threshold: 0.0から1.0の差分しきい値。省略時0.1`}
          response="/api/diff と同じ DiffResponse。"
          notes="外部アプリは /api/diff 成功後に http://127.0.0.1:8078/?result_id=cache-id を開くと、このエンドポイント経由でWebアプリが結果を表示する。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/rediff"
          purpose="位置合わせ済みの比較結果に対して、しきい値だけを変えて差分を再計算する。再アップロードや再位置合わせを避けるために使う。"
          request={`Content-Type: application/json
{
  "result_id": "/api/diffで返ったID",
  "diff_threshold": 0.4
}

cacheが失効した場合のfallback:
{
  "image_a": { "mime_type": "image/png", "data": "base64..." },
  "image_b_aligned": { "mime_type": "image/png", "data": "base64..." },
  "diff_threshold": 0.4
}`}
          response={`{
  "result_id": "cache-id",
  "overlay": { "mime_type": "image/png", "data": "base64..." },
  "mask": { "mime_type": "image/png", "data": "base64..." },
  "diff_rects": [],
  "diff_pixels": 0,
  "diff_ratio": 0,
  "diff_threshold": 0.4
}`}
          notes="404 Diff result cache expired が返った場合はfallback形式でimage_aとimage_b_alignedを送る。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/attachments"
          purpose="クリップボード由来などの一時画像をバックエンド側に保存する。比較そのものには必須ではない。"
          request={`Content-Type: multipart/form-data
file: 保存したい添付ファイル`}
          response={`{
  "filename": "clipboard.png",
  "stored_as": "generated-name.png",
  "size": 12345,
  "retention_days": 3,
  "deleted_expired": 0
}`}
          notes="保存ファイルは保持期限後にcleanup対象になる。外部アプリが一時添付の追跡をしたい場合に使う。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/git/images"
          purpose="互換用API。指定フォルダのGit差分から変更画像を一覧する。"
          request={`Content-Type: application/json
{ "folder": "/absolute/path/to/repo/or/subfolder" }`}
          response={`{
  "folder": "/absolute/path/to/repo",
  "repo_root": "/absolute/path/to/repo",
  "files": [
    {
      "path": "new.png",
      "head_path": "old.png",
      "status": "R",
      "comparable": true,
      "reason": null
    }
  ]
}`}
          notes="追加・削除など両側がそろわない画像はcomparable=falseになる。新しいUIでは画像とテキストを扱う/api/git/filesを使用する。"
        />

        <ApiEndpoint
          method="GET"
          path="/api/settings/obsidian"
          purpose="サーバーに保存されているObsidianフォルダーとレポート保存先を取得する。"
          request="リクエストボディなし。"
          response={`{
  "obsidian_folder": "/absolute/path/to/obsidian-vault",
  "obsidian_report_folder": "/absolute/path/to/report-folder"
}`}
          notes="設定はブラウザではなくBackendの設定ファイルに保存される。未設定時は空文字列。"
        />

        <ApiEndpoint
          method="PUT"
          path="/api/settings/obsidian"
          purpose="Obsidianフォルダーとレポート保存先を検証してサーバーへ保存する。"
          request={`Content-Type: application/json
{
  "obsidian_folder": "/absolute/path/to/obsidian-vault",
  "obsidian_report_folder": "/absolute/path/to/report-folder"
}`}
          response={`{
  "obsidian_folder": "/absolute/path/to/obsidian-vault",
  "obsidian_report_folder": "/absolute/path/to/report-folder"
}`}
          notes="空文字列を送ると設定を解除する。省略した項目は既存値を維持する。存在しないパスやファイルを指定した場合は422。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/reports/save"
          purpose="自己完結HTMLレポートをサーバー上のObsidianレポート保存先へ保存する。"
          request={`Content-Type: application/json
{
  "filename": "note_変更差分レポート.html",
  "html": "<!doctype html>..."
}`}
          response={`{
  "filename": "note_変更差分レポート.html",
  "path": "/absolute/path/to/report-folder/note_変更差分レポート.html"
}`}
          notes="保存先は /api/settings/obsidian の obsidian_report_folder だけを使用し、リクエストからは変更できない。設定がない場合、Frontendはブラウザダウンロードへフォールバックする。上限は50MB。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/git/files"
          purpose="設定された拡張子に従い、変更画像と変更テキストを追加・削除・未追跡も含めて一覧する。"
          request={`Content-Type: application/json
{ "folder": "/absolute/path/to/repo", "text_extensions": [".md", ".txt"] }`}
          response={`{
  "repo_root": "/absolute/path/to/repo",
  "files": [{
    "path": "guide.md", "head_path": "guide.md", "kind": "text",
    "change_type": "modified", "has_head": true, "has_current": true,
    "diffable": true, "comparable": true
  }]
}`}
          notes="画像拡張子は常に対象。text_extensionsは最大50件で、先頭のドットは省略できる。"
        />

        <ApiEndpoint
          method="POST / GET"
          path="/api/git/markdown"
          purpose="Obsidianの現在Markdownノートを起点に関連Git差分を取得し、DIFF画面へのリンクを返す。"
          request={`POST JSON:
{ "markdown_path": "/absolute/path/to/note.md", "text_extensions": [".md", ".txt"] }

GET:
/api/git/markdown?path=%2Fabsolute%2Fpath%2Fto%2Fnote.md`}
          response={`{
  "source_markdown": "/absolute/path/to/note.md",
  "files": [{ "path": "assets/diagram.svg", "kind": "image" }],
  "diff_url": "/?markdown_path=%2Fabsolute%2Fpath%2Fto%2Fnote.md"
}`}
          notes="Obsidianの右クリックメニューはdiff_urlを開く。Web UIはMarkdown本文と、リンクを再帰的にたどった変更画像・図面を表示する。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/git/item"
          purpose="Git変更ファイルのHEAD側と作業フォルダ側を取得する。テキストでは左右差分行、画像ではPNGプレビューを返す。"
          request={`Content-Type: application/json
{
  "folder": "/absolute/path/to/repo", "path": "guide.md", "head_path": "guide.md",
  "kind": "text", "has_head": true, "has_current": true,
  "text_extensions": [".md", ".txt"]
}`}
          response="テキストはtext_head、text_current、rows。画像はimage_head、image_currentを返す。"
          notes="テキストはUTF-8/CP932を読み取り、5 MB・30,000行/片側を上限とする。include_text=falseなら全文フィールドを省略できる。バイナリ内容はテキストとして返さない。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/git/revert-line"
          purpose="HTML出力プレビューに表示した変更行を、作業ファイル上でHEADの内容へ1行だけ戻す。"
          request={`Content-Type: application/json
{
  "folder": "/absolute/path/to/repo", "path": "guide.md", "head_path": "guide.md",
  "text_extensions": [".md"],
  "row": { "kind": "replace", "old_index": 3, "new_index": 3, "old": "before", "new": "after" }
}`}
          response={`{ "path": "guide.md", "rows": [/* 更新後の差分行 */] }`}
          notes="作業ファイルを書き換える操作。rowの種類・内容・両側インデックスを現在の差分と厳密照合し、プレビュー後にファイルが変わっていれば409で拒否する。対象は設定済みテキスト拡張子のみ。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/git/diff"
          purpose="git管理下の現在ファイルとHEAD側画像を比較する。リネーム時は現在パスとHEAD側パスを分けて指定する。"
          request={`Content-Type: application/json
{
  "folder": "/absolute/path/to/repo/or/subfolder",
  "path": "current/path.png",
  "head_path": "head/path.png",
  "category": "汎用",
  "diff_threshold": 0.1
}`}
          response="/api/diff と同じ DiffResponse。page_a と page_b は0。"
          notes="pathとhead_pathはリポジトリ相対パス。絶対パスや..を含むパスは拒否される。"
        />

        <ApiGuideSection title="外部アプリ向け推奨フロー">
          <ol>
            <li><code>GET /api/health</code> で起動確認をする。</li>
            <li>ユーザーが通常ファイルを比較する場合は、両ファイルに <code>/api/analyze</code> を実行してページ数と警告を取得する。</li>
            <li>必要なら <code>/api/convert</code> でプレビューと <code>regions</code> を取得し、ユーザーが基準領域を選べるようにする。</li>
            <li><code>/api/diff</code> に2ファイル、ページ番号、カテゴリ、しきい値、任意の <code>anchor_region</code> を送る。</li>
            <li>結果表示には <code>image_a</code> と <code>overlay</code> または <code>image_b_aligned</code> を使う。自動判定には <code>diff_ratio</code>, <code>diff_pixels</code>, <code>diff_rects</code> を使う。</li>
            <li>しきい値だけ変更する場合は <code>/api/rediff</code> を使う。</li>
          </ol>
        </ApiGuideSection>
      </section>
      {helpOpen && <ShortcutHelp page="api" onClose={() => setHelpOpen(false)} />}
    </main>
  );
}

function ApiGuideSection({ title, children }) {
  return (
    <section className="api-guide-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function ApiEndpoint({ method, path, purpose, request, response, notes }) {
  return (
    <section className="api-endpoint">
      <div className="api-endpoint-title">
        <span className="api-method">{method}</span>
        <code>{path}</code>
      </div>
      <p>{purpose}</p>
      <h3>Request</h3>
      <pre>{request}</pre>
      <h3>Response</h3>
      <pre>{response}</pre>
      <h3>Notes for AI clients</h3>
      <p>{notes}</p>
    </section>
  );
}

function GitToolbar({
  folder,
  folderHistory,
  setFolder,
  onSelectFolder,
  info,
  files,
  targets,
  currentFile,
  currentView,
  index,
  busy,
  onLoad,
  onPrevious,
  onNext,
  onSelect,
  onMemo,
  canMemo,
  onExport,
  canExport,
  exportBusy,
  onOpenExportSelection,
  exportCount,
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [filterText, setFilterText] = useState("");

  const filteredTargets = useMemo(() => {
    if (!filterText.trim()) {
      return targets.map((target, originalIndex) => ({ target, originalIndex }));
    }
    const query = filterText.trim().toLowerCase();
    return targets
      .map((target, originalIndex) => ({ target, originalIndex }))
      .filter(({ target }) => target.file.path.toLowerCase().includes(query));
  }, [targets, filterText]);

  return (
    <>
      <label className="git-folder">
        <span>フォルダ / Markdown</span>
        <div className="git-folder-input-row">
          <input
            type="text"
            value={folder}
            placeholder="/path/to/git/repo/or/subfolder または .md"
            onChange={(event) => setFolder(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onLoad();
            }}
          />
          <button
            type="button"
            className="git-folder-history-toggle"
            title="最近使ったフォルダ"
            aria-label="最近使ったフォルダ"
            aria-expanded={historyOpen}
            disabled={!folderHistory.length}
            onClick={() => setHistoryOpen((open) => !open)}
          >
            <ChevronDown size={16} />
          </button>
          {historyOpen && folderHistory.length > 0 && (
            <div className="git-folder-history" role="listbox" aria-label="最近使ったフォルダ">
              {folderHistory.map((item) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={item === folder}
                  key={item}
                  title={item}
                  onClick={() => {
                    onSelectFolder(item);
                    setHistoryOpen(false);
                  }}
                >
                  {item}
                </button>
              ))}
            </div>
          )}
        </div>
      </label>
      <button className="primary" disabled={!folder || busy} onClick={() => onLoad()}>
        {busy ? <Loader2 className="spin" size={18} /> : <FolderOpen size={18} />}
        読み込み
      </button>
      <div className="git-nav">
        {targets.length > 2 && (
          <input
            type="text"
            className="git-filter-input"
            value={filterText}
            placeholder="絞り込み..."
            title="ファイル名で絞り込み"
            onChange={(event) => setFilterText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && filteredTargets.length > 0) {
                onSelect(filteredTargets[0].originalIndex);
              }
            }}
          />
        )}
        <button title="前の差分対象" disabled={!targets.length || busy} onClick={onPrevious}>
          <ChevronLeft size={18} />
        </button>
        <select value={targets.length ? index : ""} disabled={!targets.length || busy} onChange={(event) => onSelect(Number(event.target.value))}>
          {filteredTargets.length ? (
            filteredTargets.map(({ target, originalIndex }) => (
              <option key={`${target.file.path}:${target.mode}`} value={originalIndex}>
                {originalIndex + 1}. {target.file.path}{target.mode === "excalidraw" ? " / Excalidraw" : target.mode === "text" ? " / テキスト" : ""}
              </option>
            ))
          ) : (
            <option value="">一致するファイルなし</option>
          )}
        </select>
        <button title="次の差分対象" disabled={!targets.length || busy} onClick={onNext}>
          <ChevronRight size={18} />
        </button>
        <button title="再読み込み" disabled={!folder || busy} onClick={() => onLoad()}>
          <RefreshCw size={18} />
        </button>
      </div>
      <button className="primary secondary" disabled={!canMemo || busy} onClick={onMemo}>
        <MessageSquarePlus size={18} />
        画像メモ
      </button>
      <button className="primary report-button" disabled={!canExport || busy || exportBusy} onClick={onExport}>
        {exportBusy ? <Loader2 className="spin" size={18} /> : <Download size={18} />}
        HTMLプレビュー
      </button>
      <button className="primary secondary export-selection-button" disabled={!files.length || busy || exportBusy} onClick={onOpenExportSelection}>
        HTML出力対象 ({exportCount}/{files.length})
      </button>
      <div className="git-meta">
        <strong>{currentFile?.path ?? "未選択"}{currentView === "excalidraw" ? " / Excalidraw" : currentView === "text" ? " / テキスト" : ""}</strong>
        <small>
          {info ? `${targets.length}件の差分対象（変更${files.length}件） / HTML出力 ${exportCount}件` : "git管理フォルダを指定"}
          {info?.source_markdown ? " / Markdown起点で関連ファイルのみ" : ""}
        </small>
      </div>
    </>
  );
}

function ExportSelectionModal({ files, excludedPaths, busy, onToggle, onIncludeAll, onExcludeAll, onClose }) {
  return (
    <div className="export-selection-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="export-selection-modal" role="dialog" aria-modal="true" aria-labelledby="export-selection-title">
        <header>
          <div>
            <h2 id="export-selection-title">HTML出力対象</h2>
            <p>HTMLに含める変更ファイルを選択してください。</p>
          </div>
          <button type="button" className="modal-close-button" aria-label="閉じる" onClick={onClose}>×</button>
        </header>
        <div className="export-selection-list">
          {files.length ? files.map((file) => {
            const included = !excludedPaths.includes(file.path);
            return (
              <label className="export-selection-item" key={file.path}>
                <input
                  type="checkbox"
                  checked={included}
                  disabled={busy}
                  onChange={(event) => onToggle(file.path, event.target.checked)}
                />
                <span>
                  <strong>{file.path}</strong>
                  <small>{file.kind === "text" ? "テキスト差分" : "画像差分"}</small>
                </span>
                <b className={included ? "included" : "excluded"}>{included ? "ON" : "OFF"}</b>
              </label>
            );
          }) : <p className="export-selection-empty">対象ファイルがありません。</p>}
        </div>
        <footer>
          <button type="button" onClick={onIncludeAll} disabled={busy || !files.length}>すべてON</button>
          <button type="button" onClick={onExcludeAll} disabled={busy || !files.length}>すべてOFF</button>
          <button type="button" className="primary" onClick={onClose}>閉じる</button>
        </footer>
      </section>
    </div>
  );
}

function ReportPreviewPage({ entries, busy, onClose, onChange, onRevertLine, onExport, error }) {
  const [helpOpen, setHelpOpen] = useShortcutHelp();
  const [dragIndex, setDragIndex] = useState(null);

  function moveEntry(from, to) {
    if (to < 0 || to >= entries.length || from === to) return;
    const next = [...entries];
    const [entry] = next.splice(from, 1);
    next.splice(to, 0, entry);
    onChange(next);
  }

  function updateImageEntry(index, fields) {
    onChange(entries.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...fields } : entry));
  }

  return (
    <main className="report-preview-page" aria-labelledby="report-preview-title">
      <header className="report-preview-header">
        <div><h1 id="report-preview-title">HTML出力プレビュー</h1><p>カードサイズ、画像の位置・倍率・出力領域、カード順を調整してから出力します。</p></div>
        <div><button type="button" onClick={() => setHelpOpen(true)}><HelpCircle size={17} />ヘルプ</button><button type="button" disabled={busy} onClick={onClose}>閉じる</button><button type="button" className="primary" disabled={busy} onClick={onExport}>{busy ? "処理中…" : "HTMLを出力"}</button></div>
      </header>
      {error && <div className="notice error report-preview-notice"><AlertTriangle size={18} />{error}</div>}
      <section className="report-preview-content">
        {entries.map((entry, index) => {
          const previewImage = entry.data.image_b_aligned ?? entry.data.image_current ?? entry.data.image_a ?? entry.data.image_head;
          const changedRows = (entry.data.rows ?? []).filter((row) => ["replace", "insert", "delete"].includes(row.kind) && (row.old_number != null || row.new_number != null));
          return (
            <article
              className="report-preview-card"
              key={`${entry.file.path}-${index}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => { if (dragIndex != null) moveEntry(dragIndex, index); setDragIndex(null); }}
            >
              <header draggable={!busy} onDragStart={() => setDragIndex(index)}>
                <GripVertical size={19} />
                <div><strong>{index + 1}. {entry.file.path}</strong><small>{entry.file.kind === "text" ? "テキスト差分" : "画像差分"}</small></div>
                <button type="button" disabled={busy || index === 0} onClick={() => moveEntry(index, index - 1)}>↑</button>
                <button type="button" disabled={busy || index === entries.length - 1} onClick={() => moveEntry(index, index + 1)}>↓</button>
              </header>
              {entry.file.kind === "text" ? (
                <div className="report-preview-text">
                  <div className="report-preview-labels"><b>変更前</b><b>変更後</b><span /></div>
                  {changedRows.length ? changedRows.map((row, rowIndex) => (
                    <div className={`report-preview-row ${row.kind}`} key={`${row.old_number}-${row.new_number}-${rowIndex}`}>
                      <code><i>{row.old_number ?? ""}</i>{row.old ?? ""}</code>
                      <code><i>{row.new_number ?? ""}</i>{row.new ?? ""}</code>
                      <button type="button" disabled={busy} title="この行を変更前へ戻す" aria-label="この行を変更前へ戻す" onClick={() => onRevertLine(index, row)}><RotateCcw size={16} /></button>
                    </div>
                  )) : <p className="report-preview-clean">差分行はありません。</p>}
                </div>
              ) : (
                <ReportImageEditor
                  image={previewImage}
                  imageMemo={entry.imageMemo}
                  reportOptions={entry.reportOptions}
                  filePath={entry.file.path}
                  memoId={entry.memoId}
                  onChange={(fields) => updateImageEntry(index, fields)}
                />
              )}
            </article>
          );
        })}
      </section>
      <footer><span>{entries.length}カード</span><button type="button" className="primary" disabled={busy} onClick={onExport}>{busy ? "処理中…" : "HTMLを出力"}</button></footer>
      {helpOpen && <ShortcutHelp page="report" onClose={() => setHelpOpen(false)} />}
    </main>
  );
}

function ReportImageEditor({ image, imageMemo, reportOptions, filePath, memoId, onChange }) {
  const notes = normalizeMemoNotes(imageMemo?.notes);
  const stickies = normalizeStickyNotes(imageMemo?.stickies);
  const renderStageSize = effectiveMemoStageSize(imageMemo);
  const [selectedNoteId, setSelectedNoteId] = useState(notes[0]?.id ?? null);
  const [annotatedImage, setAnnotatedImage] = useState(image ? toDataUri(image) : null);
  const selectedNote = notes.find((note) => note.id === selectedNoteId) ?? notes[0] ?? null;
  const selectedView = selectedNote
    ? normalizeReportView(reportOptions?.views?.[selectedNote.id], selectedNote, renderStageSize)
    : null;
  const selectedCrop = selectedNote ? normalizeReportCrop(reportOptions?.crops?.[selectedNote.id]) : null;

  useEffect(() => {
    if (!image) {
      setAnnotatedImage(null);
      return undefined;
    }
    let cancelled = false;
    renderImageWithNotesDataUri(toDataUri(image), notes, renderStageSize, stickies)
      .then((source) => { if (!cancelled) setAnnotatedImage(source); })
      .catch(() => { if (!cancelled) setAnnotatedImage(toDataUri(image)); });
    return () => { cancelled = true; };
  }, [image, imageMemo]);

  useEffect(() => {
    if (selectedNote && selectedNote.id !== selectedNoteId) setSelectedNoteId(selectedNote.id);
  }, [selectedNote?.id, selectedNoteId]);

  function setCrop(nextCrop) {
    if (!selectedNote) return;
    onChange({
      reportOptions: {
        ...reportOptions,
        crops: { ...(reportOptions?.crops ?? {}), [selectedNote.id]: normalizeReportCrop(nextCrop) },
      },
    });
  }

  function clearCrop() {
    if (!selectedNote) return;
    const crops = { ...(reportOptions?.crops ?? {}) };
    delete crops[selectedNote.id];
    onChange({ reportOptions: { ...normalizeReportOptions(reportOptions), crops } });
  }

  function setView(nextView) {
    if (!selectedNote) return;
    onChange({
      reportOptions: {
        ...normalizeReportOptions(reportOptions),
        views: { ...(reportOptions?.views ?? {}), [selectedNote.id]: normalizeReportView(nextView, selectedNote, renderStageSize) },
      },
    });
  }

  function updateMemoText(text) {
    if (!selectedNote) return;
    onChange({
      imageMemo: {
        ...(imageMemo ?? {}),
        notes: notes.map((note) => note.id === selectedNote.id ? { ...note, text } : note),
        stickies,
      },
    });
  }

  return (
    <div className="report-preview-image-editor">
      {notes.length > 1 && (
        <div className="report-preview-note-tabs" aria-label="編集する画像メモ">
          {notes.map((note, index) => <button type="button" className={selectedNote?.id === note.id ? "active" : ""} key={note.id} onClick={() => setSelectedNoteId(note.id)}>メモ {index + 1}</button>)}
        </div>
      )}
      <div className="report-crop-layout">
        <div>
          {annotatedImage ? (
            <ReportImageViewport
              src={annotatedImage}
              view={selectedView}
              crop={selectedCrop}
              alt={`${filePath} のメモ付き変更後画像`}
              onViewChange={setView}
              onCropChange={setCrop}
              onClearCrop={clearCrop}
            />
          ) : <p className="report-preview-clean">表示できる変更後画像がありません。</p>}
        </div>
        <div className="report-preview-memo-editor">
          <strong>メモ内容</strong>
          {selectedNote ? <>
            <span className="memo-list-type">{memoChangeTypeLabel(selectedNote.changeType)}</span>
            <textarea value={selectedNote.text} onChange={(event) => updateMemoText(event.target.value)} aria-label="HTMLへ出力する画像メモ本文" />
            <button type="button" onClick={() => setView(defaultMemoReportView(selectedNote, renderStageSize))}>表示をメモ位置へ戻す</button>
            {memoId && <button type="button" onClick={() => openStoredMemoTab(memoId)}>メモ編集</button>}
          </> : <p>画像メモはありません。画像メモ画面で追加してください。</p>}
        </div>
      </div>
    </div>
  );
}

function ReportImageViewport({ src, view, crop, alt, onViewChange, onCropChange, onClearCrop }) {
  const stageRef = useRef(null);
  const dragRef = useRef(null);
  const resizeRef = useRef(null);
  const [imageSize, setImageSize] = useState(null);
  const [stageSize, setStageSize] = useState(null);
  const [selecting, setSelecting] = useState(false);
  const [draftCrop, setDraftCrop] = useState(null);
  const safeView = normalizeReportView(view);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const update = () => setStageSize({ width: stage.clientWidth, height: stage.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [safeView.cardWidth, safeView.cardHeight]);

  const geometry = reportViewportGeometry(imageSize, stageSize, safeView);
  const visibleCrop = geometry ? reportVisibleCrop(imageSize, stageSize, safeView) : null;
  const shownCrop = draftCrop ?? crop;
  const cropStyle = shownCrop && geometry ? reportCropScreenStyle(shownCrop, geometry) : null;

  function sourcePoint(event) {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || !geometry || !imageSize) return null;
    return {
      x: clamp(((event.clientX - rect.left - geometry.left) / geometry.width) * 100, 0, 100),
      y: clamp(((event.clientY - rect.top - geometry.top) / geometry.height) * 100, 0, 100),
    };
  }

  function startPointer(event) {
    if (!geometry) return;
    event.preventDefault();
    if (selecting) {
      const point = sourcePoint(event);
      if (!point) return;
      dragRef.current = { mode: "crop", start: point };
      setDraftCrop({ x: point.x, y: point.y, width: 2, height: 2 });
    } else {
      dragRef.current = { mode: "pan", x: event.clientX, y: event.clientY, centerX: geometry.centerX, centerY: geometry.centerY };
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function movePointer(event) {
    const drag = dragRef.current;
    if (!drag || !geometry) return;
    if (drag.mode === "crop") {
      const point = sourcePoint(event);
      if (!point) return;
      setDraftCrop(normalizeReportCrop({
        x: Math.min(drag.start.x, point.x),
        y: Math.min(drag.start.y, point.y),
        width: Math.abs(point.x - drag.start.x),
        height: Math.abs(point.y - drag.start.y),
      }));
      return;
    }
    const centerX = drag.centerX - ((event.clientX - drag.x) / geometry.width) * 100;
    const centerY = drag.centerY - ((event.clientY - drag.y) / geometry.height) * 100;
    onViewChange({ ...safeView, centerX: clamp(centerX, 0, 100), centerY: clamp(centerY, 0, 100) });
  }

  function stopPointer() {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.mode === "crop" && draftCrop) {
      onCropChange(draftCrop);
      setDraftCrop(null);
      setSelecting(false);
    }
  }

  function moveImageWithWheel(event) {
    if (!geometry) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey || event.altKey) {
      const direction = event.deltaY < 0 ? 1 : -1;
      const nextZoom = clamp(safeView.zoom + direction * 5, 100, 500);
      const nextImageScale = Number.isFinite(safeView.imageScale)
        ? safeView.imageScale * (nextZoom / safeView.zoom)
        : null;
      onViewChange({ ...safeView, zoom: nextZoom, imageScale: nextImageScale });
      return;
    }
    onViewChange({
      ...safeView,
      centerX: clamp(geometry.centerX + (event.deltaX / geometry.width) * 100, 0, 100),
      centerY: clamp(geometry.centerY + (event.deltaY / geometry.height) * 100, 0, 100),
    });
  }

  function startResize(event) {
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = {
      x: event.clientX,
      y: event.clientY,
      width: safeView.cardWidth,
      height: safeView.cardHeight,
      imageScale: geometry && imageSize ? geometry.width / imageSize.width : null,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function resizeCard(event) {
    const resize = resizeRef.current;
    if (!resize) return;
    onViewChange({
      ...safeView,
      cardWidth: clamp(Math.round(resize.width + event.clientX - resize.x), 420, 1180),
      cardHeight: clamp(Math.round(resize.height + event.clientY - resize.y), 220, 720),
      imageScale: resize.imageScale ?? safeView.imageScale,
    });
  }

  function stopResize() {
    resizeRef.current = null;
  }

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    stage.addEventListener("wheel", moveImageWithWheel, { passive: false });
    return () => stage.removeEventListener("wheel", moveImageWithWheel);
  }, [geometry, safeView]);

  useEffect(() => {
    const move = (event) => resizeCard(event);
    const stop = () => stopResize();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [safeView]);

  return (
    <div className="report-view-editor" style={{ width: `min(${safeView.cardWidth}px, 100%)` }}>
      <div className="report-view-toolbar">
        <div className="report-view-actions">
          <button type="button" className={selecting ? "active" : ""} onClick={() => { setSelecting((current) => !current); setDraftCrop(null); }}>領域指定</button>
          {crop && <button type="button" onClick={onClearCrop}>領域指定を解除</button>}
          <span>画像倍率 {safeView.zoom}%</span>
          <span>カード {safeView.cardWidth} × {safeView.cardHeight}px</span>
        </div>
      </div>
      <p className="report-crop-hint">ドラッグまたは2本指スワイプで画像を移動、ピンチで拡大縮小します。右下ハンドルでカードを広げると、画像倍率を保ったまま表示範囲だけ広がります。</p>
      <div
        ref={stageRef}
        className={`report-crop-stage report-pan-stage ${selecting ? "selecting" : ""}`}
        style={{ height: `${safeView.cardHeight}px` }}
        onPointerDown={startPointer}
        onPointerMove={movePointer}
        onPointerUp={stopPointer}
        onPointerCancel={stopPointer}
      >
        <img
          src={src}
          alt={alt}
          draggable="false"
          onLoad={(event) => setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          style={geometry ? { width: `${geometry.width}px`, height: `${geometry.height}px`, left: `${geometry.left}px`, top: `${geometry.top}px` } : undefined}
        />
        {cropStyle && <div className="report-crop-selection" style={cropStyle}><i /><i /><i /><i /></div>}
        {!crop && visibleCrop && <span className="report-visible-area-badge">表示中の範囲を出力</span>}
      </div>
      <button
        type="button"
        className="report-card-resize-handle"
        aria-label="カードをドラッグしてサイズ変更"
        title="ドラッグしてカードサイズを変更"
        onPointerDown={startResize}
      />
    </div>
  );
}

function TextDiffView({ file, item, memo, busy, previewBusy, dirty, onEditText, onSave, onRevertLine, onMemoChange }) {
  const canRevertFile = Boolean(file.has_head && file.has_current);
  const editableLines = useMemo(() => normalizeLineEndings(item?.text_current ?? "").split("\n"), [item?.text_current]);
  return (
    <section className="text-diff-section">
      <div className="text-diff-heading">
        <div>
          <FileText size={20} />
          <strong>{file.path}</strong>
          <span className={`change-badge ${file.change_type}`}>{changeTypeLabel(file.change_type)}</span>
          {dirty && <span className="unsaved-badge">未保存</span>}
          <button
            type="button"
            className="text-save-button"
            disabled={!dirty || busy || previewBusy}
            onClick={onSave}
            title="変更後の内容を元のテキストファイルへ保存（Ctrl/Cmd+S）"
          >
            <Save size={15} />
            保存
          </button>
        </div>
        <label>
          <textarea
            aria-label="このファイルのメモ（HTMLへ出力）"
            title="このファイルのメモ（HTMLへ出力）"
            value={memo}
            placeholder="確認事項や変更理由を入力"
            onChange={(event) => onMemoChange(event.target.value)}
          />
        </label>
      </div>
      <div className="text-diff-columns" aria-label="テキスト差分">
        <div className="text-column-title">変更前: {file.head_path}</div>
        <div className="text-column-title text-diff-action-title" aria-hidden="true" />
        <div className="text-column-title">変更後: {file.path}</div>
        {(item?.rows ?? []).map((row, index) => (
          <React.Fragment key={`${row.old_number ?? "x"}-${row.new_number ?? "x"}-${index}`}>
            <DiffCodeCell side="old" row={row} />
            <DiffActionCell row={row} busy={busy || previewBusy} onRevertLine={canRevertFile ? onRevertLine : null} />
            <DiffCodeCell
              side="new"
              row={row}
              editable
              editableText={Number.isInteger(row.new_index) ? editableLines[row.new_index] ?? row.new ?? "" : row.new ?? ""}
              onEdit={onEditText}
              disabled={busy}
            />
          </React.Fragment>
        ))}
        {!item && <div className="text-diff-empty">差分を読み込んでいます。</div>}
      </div>
    </section>
  );
}

function DiffActionCell({ row, busy, onRevertLine }) {
  const canRevert = Boolean(
    onRevertLine
      && ["replace", "insert", "delete"].includes(row.kind)
      && Number.isInteger(row.old_index)
      && Number.isInteger(row.new_index),
  );
  return (
    <div className={`diff-action-cell ${canRevert ? "has-action" : ""}`}>
      {canRevert && (
        <button
          type="button"
          disabled={busy}
          title="HEAD側の内容を変更後ファイルへ反映して元に戻す"
          aria-label="HEAD側の内容を変更後ファイルへ反映して元に戻す"
          onClick={() => onRevertLine(row)}
        >
          <ArrowRight size={17} />
        </button>
      )}
    </div>
  );
}

function DiffLineEditor({ number, row, value, segments, onEdit, disabled }) {
  const segmentText = segments?.map((segment) => segment.text).join("") ?? "";
  const showHighlight = Boolean(segments?.length && segmentText === value);

  return (
    <span className="diff-line-editor-wrap">
      <span className="diff-line-sizer" aria-hidden="true">
        {showHighlight ? segments.map((segment, index) => (
          <mark key={index} className={segment.changed ? "changed" : ""}>{segment.text}</mark>
        )) : (value || " ")}
        {"\n"}
      </span>
      <textarea
        className="diff-line-editor"
        aria-label={`変更後 ${number ?? ""}行目`}
        rows={1}
        wrap="soft"
        value={value}
        disabled={disabled}
        spellCheck="false"
        onChange={(event) => onEdit(row, event.target.value)}
      />
    </span>
  );
}

function DiffCodeCell({ side, row, editable = false, editableText = "", onEdit, disabled = false }) {
  const number = side === "old" ? row.old_number : row.new_number;
  const text = side === "old" ? row.old : row.new;
  const segments = side === "old" ? row.old_segments : row.new_segments;
  const className = side === "old"
    ? row.kind === "delete" || row.kind === "replace" ? "removed" : row.kind === "insert" ? "added-gap" : ""
    : row.kind === "insert" || row.kind === "replace" ? "added" : row.kind === "delete" ? "removed-gap" : "";
  return (
    <div className={`diff-code-cell ${className}`}>
      <span className="line-number">{number ?? ""}</span>
      <code>{editable && side === "new" && row.new !== null && Number.isInteger(row.new_index) ? (
        <DiffLineEditor
          number={number}
          row={row}
          value={editableText}
          segments={segments}
          onEdit={onEdit}
          disabled={disabled}
        />
      ) : segments ? segments.map((segment, index) => (
        <mark key={index} className={segment.changed ? "changed" : ""}>{segment.text}</mark>
      )) : row.kind === "insert" || row.kind === "delete" ? <mark className="changed">{text ?? ""}</mark> : text ?? ""}</code>
    </div>
  );
}

function MemoDiffApp() {
  const [helpOpen, setHelpOpen] = useShortcutHelp();
  const [payload, setPayload] = useState(null);
  const [loadingPayload, setLoadingPayload] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [textExtensions, setTextExtensions] = useState(loadTextExtensions);
  const [extensionDraft, setExtensionDraft] = useState(() => loadTextExtensions().join(", "));
  const [obsidianFolder, setObsidianFolder] = useState("");
  const [obsidianFolderDraft, setObsidianFolderDraft] = useState("");
  const [obsidianReportFolder, setObsidianReportFolder] = useState("");
  const [obsidianReportFolderDraft, setObsidianReportFolderDraft] = useState("");
  const [obsidianSettingsBusy, setObsidianSettingsBusy] = useState(false);
  const [displayScale, setDisplayScale] = useState(loadDisplayScale);
  const [memoSidebarWidth, setMemoSidebarWidth] = useState(loadMemoSidebarWidth);
  const [memoSidebarVisible, setMemoSidebarVisible] = useState(loadMemoSidebarVisible);
  const [slider, setSlider] = useState(50);
  const [memoZoom, setMemoZoom] = useState(100);
  const [memoImageScale, setMemoImageScale] = useState(100);
  const [notes, setNotes] = useState([]);
  const [stickies, setStickies] = useState([]);
  const [selectedNoteId, setSelectedNoteId] = useState(null);
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [annotationTool, setAnnotationTool] = useState(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [notice, setNotice] = useState("");
  const [panning, setPanning] = useState(false);
  const stageRef = useRef(null);
  const stageWrapRef = useRef(null);
  const imageARef = useRef(null);
  const dragRef = useRef(null);
  const leaderDragRef = useRef(null);
  const sliderDragRef = useRef(false);
  const panDragRef = useRef(null);
  const sidebarResizeRef = useRef(null);
  const annotationDrawRef = useRef(null);
  const annotationDragRef = useRef(null);
  const stickyDragRef = useRef(null);
  const memoHistoryRef = useRef({ past: [], future: [] });
  const memoHistoryLastRef = useRef(null);
  const memoHistoryPendingRef = useRef(null);
  const memoHistoryTimerRef = useRef(null);
  const memoHistoryRestoringRef = useRef(false);
  const stagePointerRef = useRef({ clientX: 0, clientY: 0, inside: false });
  const memoNavigationBusyRef = useRef(false);
  const memoStateRef = useRef({ payload: null, notes: [], stickies: [], memoZoom: 100, memoImageScale: 100 });
  const safeNotes = useMemo(() => normalizeMemoNotes(notes), [notes]);
  const safeStickies = useMemo(() => normalizeStickyNotes(stickies), [stickies]);
  const selectedNote = useMemo(
    () => safeNotes.find((note) => note.id === selectedNoteId) ?? null,
    [safeNotes, selectedNoteId],
  );
  const selectedAnnotation = useMemo(
    () => selectedNote?.annotations.find((annotation) => annotation.id === selectedAnnotationId) ?? null,
    [selectedNote, selectedAnnotationId],
  );
  memoStateRef.current = { payload, notes, stickies, memoZoom, memoImageScale };

  async function persistCurrentMemoState() {
    const current = memoStateRef.current;
    if (!current.payload) return;
    const payloadId = memoPayloadIdFromHash();
    if (!payloadId) return;
    const latestStored = await readMemoPayload(payloadId);
    await storeMemoPayload(payloadId, {
      ...current.payload,
      notes: normalizeMemoNotes(current.notes),
      stickies: normalizeStickyNotes(current.stickies),
      reportOptions: latestStored?.reportOptions ?? current.payload.reportOptions ?? null,
      memoZoom: current.memoZoom,
      memoImageScale: current.memoImageScale,
      memoGeometryVersion: 2,
      stageSize: stageRef.current
        ? canonicalMemoStageSize(stageRef.current, current.memoZoom, current.memoImageScale)
        : current.payload.stageSize ?? null,
    });
  }

  useEffect(() => {
    let cancelled = false;
    readMemoPayload(memoPayloadIdFromHash()).then((nextPayload) => {
      if (cancelled) return;
      setPayload(nextPayload);
      setNotes(normalizeMemoNotes(nextPayload?.notes));
      setStickies(normalizeStickyNotes(nextPayload?.stickies));
      setMemoZoom(clamp(Number(nextPayload?.memoZoom) || 100, 10, 300));
      setMemoImageScale(clamp(Number(nextPayload?.memoImageScale) || 100, 25, 150));
      setLoadingPayload(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    getJson("/settings/obsidian").then((settings) => {
      const folder = String(settings.obsidian_folder || "");
      const reportFolder = String(settings.obsidian_report_folder || "");
      setObsidianFolder(folder);
      setObsidianFolderDraft(folder);
      setObsidianReportFolder(reportFolder);
      setObsidianReportFolderDraft(reportFolder);
    }).catch(() => {
      // メイン画面と同様、旧サーバーでもメモ機能自体は利用できる。
    });
  }, []);

  useEffect(() => {
    persistLocalStorage(DISPLAY_SCALE_STORAGE_KEY, displayScale);
  }, [displayScale]);

  useEffect(() => {
    persistLocalStorage(MEMO_SIDEBAR_WIDTH_STORAGE_KEY, memoSidebarWidth);
  }, [memoSidebarWidth]);

  useEffect(() => {
    persistLocalStorage(MEMO_SIDEBAR_VISIBLE_STORAGE_KEY, memoSidebarVisible);
  }, [memoSidebarVisible]);

  useEffect(() => {
    function syncSharedSettings(event) {
      if (event.key === DISPLAY_SCALE_STORAGE_KEY) setDisplayScale(loadDisplayScale());
      if (event.key === GIT_EXTENSION_STORAGE_KEY) {
        const next = loadTextExtensions();
        setTextExtensions(next);
        setExtensionDraft(next.join(", "));
      }
    }
    window.addEventListener("storage", syncSharedSettings);
    return () => window.removeEventListener("storage", syncSharedSettings);
  }, []);

  useEffect(() => {
    persistLocalStorage(GIT_EXTENSION_STORAGE_KEY, textExtensions);
  }, [textExtensions]);

  useEffect(() => {
    if (!payload) return undefined;
    const timer = window.setTimeout(() => {
      persistCurrentMemoState().catch(() => setNotice("メモをブラウザに保存できませんでした"));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [payload, notes, stickies, memoZoom, memoImageScale]);

  useEffect(() => {
    if (loadingPayload) return;
    const current = memoHistorySnapshot(notes, stickies);
    if (memoHistoryRestoringRef.current) {
      memoHistoryRestoringRef.current = false;
      memoHistoryLastRef.current = current;
      return;
    }
    if (!memoHistoryLastRef.current) {
      memoHistoryLastRef.current = current;
      return;
    }
    if (memoHistorySnapshotEquals(current, memoHistoryLastRef.current)) return;
    if (!memoHistoryPendingRef.current) {
      memoHistoryPendingRef.current = cloneMemoHistorySnapshot(memoHistoryLastRef.current);
    }
    window.clearTimeout(memoHistoryTimerRef.current);
    memoHistoryTimerRef.current = window.setTimeout(() => {
      const base = memoHistoryPendingRef.current;
      if (base) {
        memoHistoryRef.current.past.push(base);
        memoHistoryRef.current.past = memoHistoryRef.current.past.slice(-100);
        memoHistoryRef.current.future = [];
      }
      memoHistoryPendingRef.current = null;
      memoHistoryLastRef.current = memoHistorySnapshot(notes, stickies);
    }, 220);
  }, [loadingPayload, notes, stickies]);

  useEffect(() => () => window.clearTimeout(memoHistoryTimerRef.current), []);

  useEffect(() => {
    function closeMenu() {
      setContextMenu(null);
    }
    window.addEventListener("click", closeMenu);
    return () => window.removeEventListener("click", closeMenu);
  }, []);

  useEffect(() => {
    function handleShortcut(event) {
      if (isTypingTarget(event.target)) return;
      const rawKey = event.key.toLowerCase();
      const key = ({ "2": "r", "4": "o", "6": "l", "8": "t" })[rawKey] ?? rawKey;
      const annotation = MEMO_ANNOTATION_TYPES.find((type) => type.shortcut.toLowerCase() === key);
      if (key !== "t" && key !== "l" && key !== "n" && !annotation) return;
      event.preventDefault();
      if (key === "l") {
        addLeaderLine();
      } else if (key === "n") {
        addStickyNote();
      } else if (annotation) {
        selectAnnotationTool(annotation.id);
      } else {
        addNote();
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [selectedNoteId]);

  useEffect(() => {
    function handleMemoNavigation(event) {
      if (isTypingTarget(event.target) || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (!payload?.memoNavigation?.files?.length) return;
      event.preventDefault();
      navigateMemoImage(event.key === "ArrowRight" ? 1 : -1);
    }
    window.addEventListener("keydown", handleMemoNavigation);
    return () => window.removeEventListener("keydown", handleMemoNavigation);
  }, [payload]);

  useEffect(() => {
    function handleHistoryShortcut(event) {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) redoMemoChange();
      else undoMemoChange();
    }
    window.addEventListener("keydown", handleHistoryShortcut, true);
    return () => window.removeEventListener("keydown", handleHistoryShortcut, true);
  }, [notes, stickies]);

  useEffect(() => {
    function handleAnnotationDelete(event) {
      if (isTypingTarget(event.target) || !selectedNoteId || !selectedAnnotationId) return;
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      event.preventDefault();
      event.stopPropagation();
      deleteAnnotation(selectedNoteId, selectedAnnotationId);
      setNotice("選択中の図形を削除しました");
      window.setTimeout(() => setNotice(""), 1400);
    }
    window.addEventListener("keydown", handleAnnotationDelete, true);
    return () => window.removeEventListener("keydown", handleAnnotationDelete, true);
  }, [selectedNoteId, selectedAnnotationId]);

  useEffect(() => {
    function moveNote(event) {
      if (annotationDrawRef.current) {
        const draw = annotationDrawRef.current;
        const point = stagePercentPoint(event, draw.stageRect);
        const x = Math.min(draw.start.x, point.x);
        const width = Math.abs(point.x - draw.start.x);
        const height = Math.abs(point.y - draw.start.y);
        const y = Math.min(draw.start.y, point.y);
        draw.width = width;
        draw.height = height;
        const direction = draw.type === "arrow" ? {
          reverseX: point.x < draw.start.x,
          reverseY: point.y < draw.start.y,
        } : {};
        const minimumHeight = draw.type === "highlight" ? 0.05 : 0.4;
        setNotes((items) => normalizeMemoNotes(items).map((item) => updateMemoAnnotation(
          item,
          draw.noteId,
          draw.annotationId,
          { x, y, width: Math.max(0.4, width), height: Math.max(minimumHeight, height), ...direction },
        )));
        return;
      }
      if (annotationDragRef.current) {
        const drag = annotationDragRef.current;
        if (drag.mode === "arrow-start" || drag.mode === "arrow-end") {
          const point = stagePercentPoint(event, drag.stageRect);
          const endpoints = memoArrowEndpoints(drag.annotation);
          const start = drag.mode === "arrow-start" ? point : endpoints.start;
          const end = drag.mode === "arrow-end" ? point : endpoints.end;
          setNotes((items) => normalizeMemoNotes(items).map((item) => updateMemoAnnotation(
            item,
            drag.noteId,
            drag.annotationId,
            arrowAnnotationFromEndpoints(start, end),
          )));
          return;
        }
        const deltaX = ((event.clientX - drag.startX) / drag.stageRect.width) * 100;
        const deltaY = ((event.clientY - drag.startY) / drag.stageRect.height) * 100;
        const fields = drag.mode === "resize"
          ? {
              width: clamp(drag.annotation.width + deltaX, 1, 100 - drag.annotation.x),
              height: clamp(
                drag.annotation.height + deltaY,
                drag.annotation.type === "highlight" ? 0.05 : 1,
                100 - drag.annotation.y,
              ),
            }
          : {
              x: clamp(drag.annotation.x + deltaX, 0, 100 - drag.annotation.width),
              y: clamp(drag.annotation.y + deltaY, 0, 100 - drag.annotation.height),
            };
        setNotes((items) => normalizeMemoNotes(items).map((item) => updateMemoAnnotation(
          item,
          drag.noteId,
          drag.annotationId,
          fields,
        )));
        return;
      }
      if (stickyDragRef.current && stageRef.current) {
        const drag = stickyDragRef.current;
        const rect = stageRef.current.getBoundingClientRect();
        const x = clamp(((event.clientX - rect.left - drag.offsetX) / rect.width) * 100, 0, 90);
        const y = clamp(((event.clientY - rect.top - drag.offsetY) / rect.height) * 100, 0, 90);
        setStickies((items) => normalizeStickyNotes(items).map((sticky) => (
          sticky.id === drag.id ? { ...sticky, x, y } : sticky
        )));
        return;
      }
      if (sidebarResizeRef.current) {
        const resize = sidebarResizeRef.current;
        const delta = event.clientX - resize.startX;
        if (Math.abs(delta) > 2) resize.moved = true;
        setMemoSidebarWidth(clamp(resize.startWidth + delta, 160, 420));
        return;
      }
      if (sliderDragRef.current) {
        updateSliderFromPointer(event);
      }
      if (panDragRef.current && stageWrapRef.current) {
        const { startX, startY, startLeft, startTop } = panDragRef.current;
        stageWrapRef.current.scrollLeft = startLeft - (event.clientX - startX);
        stageWrapRef.current.scrollTop = startTop - (event.clientY - startY);
        return;
      }
      if (leaderDragRef.current) {
        const { id, lineId, rect, point, noteSize, scaleX, scaleY, grabOffsetX, grabOffsetY } = leaderDragRef.current;
        const localX = (event.clientX - rect.left) / scaleX - grabOffsetX;
        const localY = (event.clientY - rect.top) / scaleY - grabOffsetY;
        const x = clamp(localX, -420, 620);
        const y = clamp(localY, -240, 520);
        const start = snapMemoLeaderPoint({ x, y }, noteSize);
        setNotes((items) => normalizeMemoNotes(items).map((item) => updateMemoLeader(item, id, lineId, point, { start, end: { x, y } })));
        return;
      }
      if (!dragRef.current || !stageRef.current) return;
      const draggedNoteId = dragRef.current.id;
      const { offsetX, offsetY, originX, originY, note: originalNote, contentScale } = dragRef.current;
      const rect = stageRef.current.getBoundingClientRect();
      const x = clamp(((event.clientX - rect.left - offsetX) / rect.width) * 100, 0, 88);
      const y = clamp(((event.clientY - rect.top - offsetY) / rect.height) * 100, 0, 82);
      const deltaX = (((x - originX) / 100) * stageRef.current.offsetWidth) / contentScale;
      const deltaY = (((y - originY) / 100) * stageRef.current.offsetHeight) / contentScale;
      setNotes((items) => normalizeMemoNotes(items).map((item) => (item.id === draggedNoteId ? {
        ...item,
        x,
        y,
        leaderEndX: originalNote.leaderEndX - deltaX,
        leaderEndY: originalNote.leaderEndY - deltaY,
        extraLeaders: originalNote.extraLeaders.map((leader) => ({
          ...leader,
          leaderEndX: leader.leaderEndX - deltaX,
          leaderEndY: leader.leaderEndY - deltaY,
        })),
      } : item)));
    }
    function stopDrag() {
      const annotationDraw = annotationDrawRef.current;
      annotationDrawRef.current = null;
      annotationDragRef.current = null;
      stickyDragRef.current = null;
      if (annotationDraw) {
        const isThinHighlight = annotationDraw.type === "highlight" && annotationDraw.width >= 1;
        if (!isThinHighlight && (annotationDraw.width < 1 || annotationDraw.height < 1)) {
          const fallbackHeight = annotationDraw.type === "highlight" ? 0.25 : 10;
          setNotes((items) => normalizeMemoNotes(items).map((item) => updateMemoAnnotation(
            item,
            annotationDraw.noteId,
            annotationDraw.annotationId,
            {
              x: clamp(annotationDraw.start.x - 8, 0, 84),
              y: clamp(annotationDraw.start.y - fallbackHeight / 2, 0, 100 - fallbackHeight),
              width: 16,
              height: fallbackHeight,
            },
          )));
        }
        setAnnotationTool(null);
      }
      const sidebarResize = sidebarResizeRef.current;
      sidebarResizeRef.current = null;
      if (sidebarResize && !sidebarResize.moved) {
        setMemoSidebarVisible((visible) => !visible);
      }
      dragRef.current = null;
      leaderDragRef.current = null;
      sliderDragRef.current = false;
      if (panDragRef.current) {
        panDragRef.current = null;
        setPanning(false);
      }
    }
    window.addEventListener("pointermove", moveNote);
    window.addEventListener("pointerup", stopDrag);
    return () => {
      window.removeEventListener("pointermove", moveNote);
      window.removeEventListener("pointerup", stopDrag);
    };
  }, []);

  if (loadingPayload || !payload) {
    return (
      <main className="memo-page">
        <div className="memo-empty">
          <h1>差分メモ</h1>
          <p>{loadingPayload ? "比較結果を読み込んでいます。" : "比較結果が見つかりません。元の画面で比較してから「差分メモ」を開いてください。"}</p>
        </div>
      </main>
    );
  }

  const imageA = toDataUri(payload.imageA);
  const imageB = toDataUri(payload.imageB);

  function notePositionAtPointer(noteSize = memoSize({ ...MEMO_DEFAULTS, text: MEMO_DEFAULTS.text })) {
    const stage = stageRef.current;
    const rect = stage?.getBoundingClientRect();
    const pointer = stagePointerRef.current;
    if (!stage || !rect || !pointer.inside || !rect.width || !rect.height || !stage.offsetWidth || !stage.offsetHeight) {
      return { x: 42, y: 12 };
    }
    const centerX = ((pointer.clientX - rect.left) / rect.width) * 100;
    const centerY = ((pointer.clientY - rect.top) / rect.height) * 100;
    return {
      x: clamp(centerX - (noteSize.width / stage.offsetWidth) * 50, 0, 88),
      y: clamp(centerY - (noteSize.height / stage.offsetHeight) * 50, 0, 82),
    };
  }

  async function navigateMemoImage(step) {
    const current = memoStateRef.current;
    const navigation = current.payload?.memoNavigation;
    const files = Array.isArray(navigation?.files) ? navigation.files : [];
    if (!files.length || memoNavigationBusyRef.current) return;

    const currentIndex = Number.isInteger(Number(navigation.index)) ? Number(navigation.index) : 0;
    const nextIndex = (currentIndex + step + files.length) % files.length;
    const target = files[nextIndex];
    if (!target) return;

    memoNavigationBusyRef.current = true;
    setNotice("画像を読み込んでいます…");
    try {
      await persistCurrentMemoState();
      let data;
      if (target.diffable) {
        data = await postJson("/git/diff", {
          folder: navigation.folder,
          path: target.path,
          head_path: target.head_path,
          category: navigation.category ?? "汎用",
          diff_threshold: navigation.diff_threshold ?? 0.1,
        });
      } else {
        data = await postJson("/git/item", {
          folder: navigation.folder,
          text_extensions: navigation.text_extensions ?? [],
          include_text: false,
          ...target,
        });
      }

      const imageA = data.image_a ?? data.image_head ?? data.image_current;
      const imageB = data.image_b_aligned ?? data.image_current ?? data.image_head;
      if (!imageA || !imageB) throw new Error("画像を読み込めませんでした");

      const nextId = gitImageMemoId(navigation.repo_root, target.path);
      const existing = await readMemoPayload(nextId);
      const nextPayload = {
        ...current.payload,
        imageA,
        imageB,
        nameA: `変更前:${target.head_path || target.path}`,
        nameB: target.path,
        notes: normalizeMemoNotes(existing?.notes),
        stickies: normalizeStickyNotes(existing?.stickies),
        stageSize: existing?.stageSize ?? null,
        memoZoom: clamp(Number(existing?.memoZoom) || current.memoZoom || 100, 10, 300),
        memoImageScale: clamp(Number(existing?.memoImageScale) || current.memoImageScale || 100, 25, 150),
        memoGeometryVersion: existing?.memoGeometryVersion ?? null,
        reportOptions: existing?.reportOptions ?? null,
        memoNavigation: { ...navigation, index: nextIndex },
      };
      await storeMemoPayload(nextId, nextPayload);

      setPayload(nextPayload);
      setNotes(nextPayload.notes);
      setStickies(nextPayload.stickies);
      setMemoZoom(nextPayload.memoZoom);
      setMemoImageScale(nextPayload.memoImageScale);
      setSlider(50);
      setSelectedNoteId(null);
      setSelectedAnnotationId(null);
      setEditingNoteId(null);
      setAnnotationTool(null);
      setContextMenu(null);
      setPanning(false);
      memoHistoryRef.current = { past: [], future: [] };
      memoHistoryLastRef.current = memoHistorySnapshot(nextPayload.notes, nextPayload.stickies);
      memoHistoryPendingRef.current = null;
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}#diff-memo/${encodeURIComponent(nextId)}`,
      );
      setNotice("");
    } catch (err) {
      setNotice(`画像の切り替えに失敗しました: ${err.message}`);
    } finally {
      memoNavigationBusyRef.current = false;
    }
  }

  function addNote() {
    const id = crypto.randomUUID?.() ?? String(Date.now());
    const base = { id, ...MEMO_DEFAULTS };
    setNotes((items) => {
      const normalized = normalizeMemoNotes(items);
      const number = nextMemoNumber(normalized);
      const colorIndex = nextMemoColorIndex(normalized);
      const next = { ...base, number, colorIndex, ...notePositionAtPointer(memoSize(base)) };
      return [...normalized, next];
    });
    setSelectedNoteId(id);
    setSelectedAnnotationId(null);
    setEditingNoteId(id);
    window.requestAnimationFrame(() => {
      document.querySelector(`[data-note-id="${CSS.escape(String(id))}"] textarea`)?.focus();
    });
  }

  function addStickyNote() {
    const id = crypto.randomUUID?.() ?? `sticky-${Date.now()}`;
    const position = notePositionAtPointer({ width: STICKY_DEFAULTS.width, height: STICKY_DEFAULTS.height });
    setStickies((items) => [...normalizeStickyNotes(items), { id, ...STICKY_DEFAULTS, ...position }]);
    setAnnotationTool(null);
  }

  function updateSticky(id, text) {
    setStickies((items) => normalizeStickyNotes(items).map((sticky) => (
      sticky.id === id ? { ...sticky, text, height: calculateStickyAutoHeight(sticky, text) } : sticky
    )));
  }

  function deleteSticky(id) {
    setStickies((items) => normalizeStickyNotes(items).filter((sticky) => sticky.id !== id));
  }

  function startStickyDrag(event, sticky) {
    if (event.target.closest("button, textarea, input")) return;
    const stickyElement = event.currentTarget.closest(".memo-sticky") ?? event.currentTarget;
    const rect = stickyElement.getBoundingClientRect();
    stickyDragRef.current = {
      id: sticky.id,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    event.preventDefault();
    event.stopPropagation();
    stickyElement.setPointerCapture?.(event.pointerId);
  }

  function finishStickyEditing(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.blur();
    window.requestAnimationFrame(() => document.querySelector("[data-sticky-add]")?.focus());
  }

  async function saveMemoObsidianSettings() {
    setObsidianSettingsBusy(true);
    try {
      const response = await fetch(`${API_BASE}/settings/obsidian`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          obsidian_folder: obsidianFolderDraft.trim(),
          obsidian_report_folder: obsidianReportFolderDraft.trim(),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || `設定保存に失敗しました（${response.status}）`);
      const folder = String(body.obsidian_folder || "");
      const reportFolder = String(body.obsidian_report_folder || "");
      setObsidianFolder(folder);
      setObsidianFolderDraft(folder);
      setObsidianReportFolder(reportFolder);
      setObsidianReportFolderDraft(reportFolder);
      setNotice("設定を保存しました");
    } catch (err) {
      setNotice(`設定を保存できませんでした: ${err.message}`);
    } finally {
      setObsidianSettingsBusy(false);
    }
  }

  function addLeaderLine() {
    if (!selectedNoteId) {
      const id = crypto.randomUUID?.() ?? String(Date.now());
      const lineId = crypto.randomUUID?.() ?? `${id}-line`;
      setNotes((items) => {
        const normalized = normalizeMemoNotes(items);
        const next = {
          id,
          ...MEMO_DEFAULTS,
          number: nextMemoNumber(normalized),
          colorIndex: nextMemoColorIndex(normalized),
          ...notePositionAtPointer(memoSize(MEMO_DEFAULTS)),
          extraLeaders: [{ id: lineId, ...MEMO_EXTRA_LEADER_DEFAULT }],
        };
        return [...normalized, next];
      });
      setSelectedNoteId(id);
      return;
    }
    const lineId = crypto.randomUUID?.() ?? `${selectedNoteId}-line-${Date.now()}`;
    setNotes((items) => normalizeMemoNotes(items).map((item) => (
      item.id === selectedNoteId
        ? { ...item, extraLeaders: [...item.extraLeaders, { id: lineId, ...nextExtraLeader(item.extraLeaders.length) }] }
        : item
    )));
  }

  function updateNote(id, text) {
    setNotes((items) => normalizeMemoNotes(items).map((item) => (item.id === id ? { ...item, text } : item)));
  }

  function updateNoteFields(id, fields) {
    setNotes((items) => normalizeMemoNotes(items).map((item) => (item.id === id ? { ...item, ...fields } : item)));
  }

  function finishMemoTextEditing(event, id) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.blur();
    setEditingNoteId(null);
    setSelectedNoteId(id);
    window.requestAnimationFrame(() => {
      document.querySelector(`[data-memo-list-id="${CSS.escape(String(id))}"]`)?.focus();
    });
  }

  function activateMemoTextEditing(id, target = null) {
    setSelectedNoteId(id);
    setSelectedAnnotationId(null);
    setEditingNoteId(id);
    window.requestAnimationFrame(() => {
      const textarea = target?.isConnected
        ? target
        : document.querySelector(`[data-note-id="${CSS.escape(String(id))}"] textarea`);
      textarea?.focus();
    });
  }

  function deactivateMemoTextEditing() {
    setEditingNoteId(null);
    if (document.activeElement?.matches?.(".memo-note textarea, .memo-editor textarea")) {
      document.activeElement.blur();
    }
  }

  function focusMemoNote(id) {
    setSelectedNoteId(id);
    setSelectedAnnotationId(null);
    deactivateMemoTextEditing();
    window.requestAnimationFrame(() => {
      const wrap = stageWrapRef.current;
      const note = Array.from(stageRef.current?.querySelectorAll("[data-note-id]") ?? [])
        .find((element) => element.dataset.noteId === String(id));
      if (!wrap || !note) return;
      const wrapRect = wrap.getBoundingClientRect();
      const noteRect = note.getBoundingClientRect();
      const scaleX = wrap.offsetWidth ? wrapRect.width / wrap.offsetWidth : 1;
      const scaleY = wrap.offsetHeight ? wrapRect.height / wrap.offsetHeight : 1;
      const noteLeft = wrap.scrollLeft + (noteRect.left - wrapRect.left) / scaleX;
      const noteTop = wrap.scrollTop + (noteRect.top - wrapRect.top) / scaleY;
      wrap.scrollTo({
        left: noteLeft - (wrap.clientWidth - note.offsetWidth) / 2,
        top: noteTop - (wrap.clientHeight - note.offsetHeight) / 2,
        behavior: "smooth",
      });
    });
  }

  function deleteNote(id) {
    setNotes((items) => normalizeMemoNotes(items).filter((item) => item.id !== id));
    setSelectedNoteId((current) => (current === id ? null : current));
    setEditingNoteId((current) => (current === id ? null : current));
    setSelectedAnnotationId(null);
  }

  function selectAnnotationTool(type) {
    if (!selectedNoteId) {
      setNotice("先に関連付けるメモを選択してください");
      window.setTimeout(() => setNotice(""), 2400);
      return;
    }
    setAnnotationTool((current) => current === type ? null : type);
  }

  function startAnnotationDraw(event) {
    if (!annotationTool || !selectedNoteId || !stageRef.current || event.button !== 0) return false;
    if (event.target.closest(".memo-note, .memo-annotation, .comparison-handle, button, textarea, input, select")) return false;
    const stageRect = stageRef.current.getBoundingClientRect();
    const start = stagePercentPoint(event, stageRect);
    const annotationId = crypto.randomUUID?.() ?? `annotation-${Date.now()}`;
    const annotation = {
      id: annotationId,
      type: annotationTool,
      x: start.x,
      y: start.y,
      width: 0.4,
      height: annotationTool === "highlight" ? 0.05 : 0.4,
      opacity: annotationTool === "highlight" ? 28 : 82,
      strokeWidth: annotationTool === "arrow" ? 4 : undefined,
      arrowHeadSize: annotationTool === "arrow" ? 16 : undefined,
    };
    setNotes((items) => normalizeMemoNotes(items).map((item) => (
      item.id === selectedNoteId ? { ...item, annotations: [...item.annotations, annotation] } : item
    )));
    annotationDrawRef.current = {
      noteId: selectedNoteId,
      annotationId,
      stageRect,
      start,
      type: annotationTool,
      width: 0,
      height: 0,
    };
    setSelectedAnnotationId(annotationId);
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    return true;
  }

  function flushMemoHistory() {
    window.clearTimeout(memoHistoryTimerRef.current);
    const pending = memoHistoryPendingRef.current;
    if (pending) {
      memoHistoryRef.current.past.push(pending);
      memoHistoryRef.current.past = memoHistoryRef.current.past.slice(-100);
      memoHistoryRef.current.future = [];
    }
    memoHistoryPendingRef.current = null;
    memoHistoryLastRef.current = memoHistorySnapshot(notes, stickies);
  }

  function restoreMemoHistorySnapshot(snapshot) {
    memoHistoryRestoringRef.current = true;
    memoHistoryLastRef.current = cloneMemoHistorySnapshot(snapshot);
    setNotes(snapshot.notes);
    setStickies(snapshot.stickies);
    setSelectedAnnotationId(null);
  }

  function undoMemoChange() {
    flushMemoHistory();
    const target = memoHistoryRef.current.past.pop();
    if (!target) return;
    memoHistoryRef.current.future.push(memoHistorySnapshot(notes, stickies));
    restoreMemoHistorySnapshot(target);
    setNotice("前の操作に戻しました");
    window.setTimeout(() => setNotice(""), 1400);
  }

  function redoMemoChange() {
    window.clearTimeout(memoHistoryTimerRef.current);
    memoHistoryPendingRef.current = null;
    const target = memoHistoryRef.current.future.pop();
    if (!target) return;
    memoHistoryRef.current.past.push(memoHistorySnapshot(notes, stickies));
    restoreMemoHistorySnapshot(target);
    setNotice("操作をやり直しました");
    window.setTimeout(() => setNotice(""), 1400);
  }

  function updateSelectedAnnotation(fields) {
    if (!selectedNoteId || !selectedAnnotationId) return;
    setNotes((items) => normalizeMemoNotes(items).map((item) => updateMemoAnnotation(
      item,
      selectedNoteId,
      selectedAnnotationId,
      fields,
    )));
  }

  function startAnnotationTransform(event, note, annotation, mode) {
    event.preventDefault();
    event.stopPropagation();
    const stageRect = stageRef.current?.getBoundingClientRect();
    if (!stageRect) return;
    annotationDragRef.current = {
      noteId: note.id,
      annotationId: annotation.id,
      mode,
      stageRect,
      startX: event.clientX,
      startY: event.clientY,
      annotation: { ...annotation },
    };
    deactivateMemoTextEditing();
    setSelectedNoteId(note.id);
    setSelectedAnnotationId(annotation.id);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function startArrowEndpointDrag(event, note, annotation, endpoint) {
    startAnnotationTransform(event, note, annotation, `arrow-${endpoint}`);
  }

  function deleteAnnotation(noteId, annotationId) {
    setNotes((items) => normalizeMemoNotes(items).map((item) => (
      item.id === noteId
        ? { ...item, annotations: item.annotations.filter((annotation) => annotation.id !== annotationId) }
        : item
    )));
    setSelectedAnnotationId((current) => current === annotationId ? null : current);
  }

  function openMemoContextMenu(event, note) {
    event.preventDefault();
    event.stopPropagation();
    setSelectedNoteId(note.id);
    setContextMenu({ x: event.clientX, y: event.clientY, noteId: note.id });
  }

  function startDrag(event, note) {
    if (event.target.closest("button, input, .memo-leader-handle")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = {
      id: note.id,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      originX: note.x,
      originY: note.y,
      contentScale: memoZoom / 100,
      note: { ...note, extraLeaders: note.extraLeaders.map((leader) => ({ ...leader })) },
    };
    deactivateMemoTextEditing();
    setSelectedNoteId(note.id);
    setSelectedAnnotationId(null);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function startLeaderDrag(event, note, point) {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.closest(".memo-note")?.getBoundingClientRect();
    if (!rect) return;
    const lineId = event.currentTarget.dataset.lineId ?? "primary";
    const noteSize = memoSize(note);
    const scaleX = rect.width / noteSize.width || 1;
    const scaleY = rect.height / noteSize.height || 1;
    const leader = memoNoteLeaders(note).find((item) => item.id === lineId) ?? memoNoteLeaders(note)[0];
    const target = point === "end" ? { x: leader.endX, y: leader.endY } : leader.start;
    const pointerX = (event.clientX - rect.left) / scaleX;
    const pointerY = (event.clientY - rect.top) / scaleY;
    leaderDragRef.current = {
      id: note.id,
      lineId,
      rect,
      point,
      noteSize,
      scaleX,
      scaleY,
      grabOffsetX: pointerX - target.x,
      grabOffsetY: pointerY - target.y,
    };
    setSelectedNoteId(note.id);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function startSliderDrag(event) {
    sliderDragRef.current = true;
    updateSliderFromPointer(event);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function startSidebarResize(event) {
    event.preventDefault();
    event.stopPropagation();
    sidebarResizeRef.current = {
      startX: event.clientX,
      startWidth: memoSidebarWidth,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function startPan(event) {
    if (event.button !== 0 && event.button !== 1) return;
    if (startAnnotationDraw(event)) return;
    if (event.target.closest(".memo-note, .comparison-handle, button, textarea, input, select")) return;
    if (!stageWrapRef.current) return;
    event.preventDefault();
    panDragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startLeft: stageWrapRef.current.scrollLeft,
      startTop: stageWrapRef.current.scrollTop,
    };
    setPanning(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function updateSliderFromPointer(event) {
    if (!stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    setSlider(Math.round(clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100)));
  }

  function trackStagePointer(event) {
    stagePointerRef.current = { clientX: event.clientX, clientY: event.clientY, inside: true };
  }

  function zoomMemoWithWheel(event) {
    if (event.target.closest("textarea, input, button, select")) return;
    // macOS trackpad pinch is delivered as a wheel event with ctrl/meta/alt.
    // A normal wheel event is intentionally left to the scroll container so
    // two-finger swipes pan the image instead of changing its zoom.
    if (!event.ctrlKey && !event.metaKey && !event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    const direction = event.deltaY < 0 ? 1 : -1;
    setMemoZoom((current) => clamp(current + direction * 5, 10, 300));
  }

  function fitMemoToViewport() {
    const image = imageARef.current;
    const wrap = stageWrapRef.current;
    if (!image?.naturalWidth || !image?.naturalHeight || !wrap) {
      setMemoZoom(100);
      setMemoImageScale(100);
      return;
    }
    const styles = window.getComputedStyle(wrap);
    const horizontalPadding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
    const verticalPadding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
    const availableWidth = Math.max(1, wrap.clientWidth - horizontalPadding);
    const availableHeight = Math.max(1, wrap.clientHeight - verticalPadding);
    const baseWidth = availableWidth;
    const baseHeight = baseWidth * (image.naturalHeight / image.naturalWidth);
    const fitPercent = Math.min(100, (availableHeight / baseHeight) * 100);
    setMemoImageScale(100);
    setMemoZoom(Math.round(clamp(fitPercent, 10, 100)));
    window.requestAnimationFrame(() => {
      if (stageWrapRef.current) {
        stageWrapRef.current.scrollLeft = 0;
        stageWrapRef.current.scrollTop = 0;
      }
    });
  }

  async function copyMemoImage(side) {
    try {
      if (side === "pair") {
        await copySideBySideImageWithNotes(imageA, imageB, safeNotes, getMemoStageSize(), safeStickies);
      } else {
        await copyImageWithNotes(side === "a" ? imageA : imageB, safeNotes, getMemoStageSize(), safeStickies);
      }
      setContextMenu(null);
      setNotice(side === "pair" ? "A（旧） / B（新）を左右配置でクリップボードに保存しました" : `画像${side.toUpperCase()}（${side === "a" ? "旧" : "新"}）をメモ付きでクリップボードに保存しました`);
      window.setTimeout(() => setNotice(""), 2400);
    } catch (err) {
      setContextMenu(null);
      setNotice(err.message);
    }
  }

  function getMemoStageSize() {
    const stage = stageRef.current;
    if (!stage) return null;
    const baseSize = canonicalMemoStageSize(stage, memoZoom, memoImageScale);
    const imageScale = clamp(Number(memoImageScale) || 100, 25, 150) / 100;
    return {
      width: baseSize.width * imageScale,
      height: baseSize.height * imageScale,
    };
  }

  return (
    <main
      className="memo-page"
      style={{ zoom: displayScale, height: `${100 / displayScale}vh` }}
      onContextMenu={(event) => {
        event.preventDefault();
        setContextMenu({ x: event.clientX, y: event.clientY, noteId: null });
      }}>
      <header className="memo-header">
        <div className="memo-header-title">
          <h1>差分メモ</h1>
          <p>A（旧）: {payload.nameA ?? "画像A"} / B（新）: {payload.nameB ?? "画像B"}</p>
        </div>
        <div className="memo-header-tools">
          {payload.reportPreviewReturn && (
            <button type="button" className="memo-fit-button" onClick={returnToReportPreview}>
              戻る
            </button>
          )}
          <label className="control slider-control">
            <span>A（旧） / B（新） {slider}%</span>
            <input type="range" min="0" max="100" value={slider} onChange={(event) => setSlider(Number(event.target.value))} />
          </label>
          <label className="control slider-control">
            <span>表示倍率 {memoZoom}%</span>
            <input type="range" min="10" max="300" value={memoZoom} onChange={(event) => setMemoZoom(Number(event.target.value))} />
          </label>
          <label className="control slider-control" title="画像の表示幅だけを調整します。元画像の解像度や保存データは変わりません">
            <span>画像サイズ {memoImageScale}%</span>
            <input
              type="range"
              min="25"
              max="150"
              step="5"
              value={memoImageScale}
              aria-label="画像の表示サイズ"
              onChange={(event) => setMemoImageScale(Number(event.target.value))}
            />
          </label>
          <button type="button" className="memo-fit-button" onClick={fitMemoToViewport}>
            画面に合わせる
          </button>
          {notice && <span className="copy-notice">{notice}</span>}
        </div>
        <div className="header-menu">
          <button className="menu-button" type="button" aria-label="メニュー" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
            <Menu size={22} />
          </button>
          {menuOpen && (
            <div className="hamburger-menu memo-hamburger-menu" role="menu">
              <div className="extension-settings">
                <strong className="extension-settings-title">Git対象拡張子</strong>
                <label>
                  <span>テキスト拡張子（カンマ区切り）</span>
                  <textarea value={extensionDraft} onChange={(event) => setExtensionDraft(event.target.value)} />
                </label>
                <small>画像形式は常に対象です。設定はこのブラウザに保存されます。</small>
                <div>
                  <button
                    type="button"
                    onClick={() => {
                      const next = normalizeTextExtensions(extensionDraft);
                      setTextExtensions(next);
                      setExtensionDraft(next.join(", "));
                    }}
                  >
                    適用
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setExtensionDraft(DEFAULT_TEXT_EXTENSIONS.join(", "));
                      setTextExtensions(DEFAULT_TEXT_EXTENSIONS);
                    }}
                  >
                    初期値
                  </button>
                </div>
                <label className="obsidian-folder-setting">
                  <span>Obsidianフォルダー（サーバー保存）</span>
                  <input
                    type="text"
                    value={obsidianFolderDraft}
                    placeholder="/path/to/obsidian-vault"
                    onChange={(event) => setObsidianFolderDraft(event.target.value)}
                  />
                </label>
                <small>Markdownファイルを指定したときのリンク解決に使用します。</small>
                <label className="obsidian-folder-setting">
                  <span>Obsidianレポート保存先（サーバー保存）</span>
                  <input
                    type="text"
                    value={obsidianReportFolderDraft}
                    placeholder="/path/to/report-folder"
                    onChange={(event) => setObsidianReportFolderDraft(event.target.value)}
                  />
                </label>
                <small>Obsidian起点のHTML差分レポートをこのフォルダーへ保存します。</small>
                <label className="display-scale-setting">
                  <span>このアプリの表示倍率 {Math.round(displayScale * 100)}%</span>
                  <input
                    type="range"
                    min="50"
                    max="200"
                    step="5"
                    value={Math.round(displayScale * 100)}
                    onChange={(event) => setDisplayScale(Number(event.target.value) / 100)}
                  />
                </label>
                <div>
                  <button type="button" disabled={obsidianSettingsBusy} onClick={saveMemoObsidianSettings}>
                    {obsidianSettingsBusy ? "保存中…" : "サーバーへ保存"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setObsidianFolderDraft(obsidianFolder);
                      setObsidianReportFolderDraft(obsidianReportFolder);
                    }}
                  >
                    戻す
                  </button>
                  <button type="button" onClick={() => setDisplayScale(1)}>表示倍率100%</button>
                </div>
              </div>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  window.open("/api-guide", "_blank", "noopener,noreferrer");
                }}
              >
                <BookOpenText size={18} />
                APIエンドポイント説明
                <ExternalLink size={16} />
              </button>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setHelpOpen(true); }}>
                <HelpCircle size={18} />
                ショートカットと操作
              </button>
            </div>
          )}
        </div>
      </header>

      <div
        className={`memo-workspace ${memoSidebarVisible ? "" : "sidebar-hidden"}`}
        style={{ "--memo-sidebar-width": `${memoSidebarWidth}px` }}
      >
        {memoSidebarVisible && <aside className="memo-sidebar" aria-label="メモ一覧">
          <button type="button" className="primary memo-sidebar-action" onClick={addNote}>
            <MessageSquarePlus size={17} />
            メモ追加 <kbd>T</kbd>
          </button>
          <button type="button" className="memo-sidebar-action" onClick={addLeaderLine}>
            <span className="memo-line-icon">／</span>
            ライン追加 <kbd>L</kbd>
          </button>
          <button type="button" className="memo-sidebar-action sticky-action" data-sticky-add onClick={addStickyNote}>
            <span className="sticky-icon">付</span>
            付箋追加 <kbd>N</kbd>
          </button>
          <div className="memo-annotation-tools" aria-label="変更範囲の描画">
            {MEMO_ANNOTATION_TYPES.map((type) => (
              <button
                type="button"
                key={type.id}
                className={annotationTool === type.id ? "active" : ""}
                title={selectedNoteId ? `${type.label}を画像上でドラッグして追加` : "先にメモを選択してください"}
                onClick={() => selectAnnotationTool(type.id)}
              >
                {type.label} <kbd>{type.shortcut}</kbd>
              </button>
            ))}
          </div>
          {annotationTool && <p className="memo-tool-hint">画像上をドラッグして{memoAnnotationTypeLabel(annotationTool)}を描画</p>}
          <div className="memo-list-heading">メモ一覧（{safeNotes.length}）</div>
          <div className="memo-list">
            {safeNotes.map((note) => (
              <button
                type="button"
                key={note.id}
                className={`memo-list-item ${selectedNoteId === note.id ? "selected" : ""}`}
                style={{ "--memo-list-color": memoColor(note).line }}
                data-memo-list-id={note.id}
                onClick={() => focusMemoNote(note.id)}
                onContextMenu={(event) => openMemoContextMenu(event, note)}
              >
                <span className="memo-list-copy">
                  <span className="memo-list-text">{note.text.trim() || "めも"}</span>
                </span>
              </button>
            ))}
            {!safeNotes.length && <p className="memo-list-empty">Tキーまたは上のボタンで追加</p>}
          </div>
        </aside>}
        <button
          type="button"
          className={`memo-sidebar-resizer ${memoSidebarVisible ? "" : "hidden"}`}
          style={{ left: memoSidebarVisible ? `calc(var(--memo-sidebar-width) - 6px)` : "0px" }}
          aria-label={memoSidebarVisible ? "メモ一覧の幅を変更、クリックで非表示" : "メモ一覧を表示"}
          title={memoSidebarVisible ? "ドラッグで幅変更／クリックで表示・非表示" : "クリックでメモ一覧を表示"}
          onPointerDown={startSidebarResize}
        >
          <span>{memoSidebarVisible ? "‹" : "›"}</span>
        </button>

        <div className="memo-content">
          {selectedNote && (
        <section className="memo-editor" aria-label="選択中メモの編集">
          <label className="control memo-text-control">
            <span>{editingNoteId === selectedNote.id ? "メモ本文（編集中）" : "メモ本文（クリックで編集）"}</span>
            <textarea
              value={selectedNote.text}
              readOnly={editingNoteId !== selectedNote.id}
              tabIndex={editingNoteId === selectedNote.id ? 0 : -1}
              className={editingNoteId === selectedNote.id ? "editing" : ""}
              onClick={(event) => activateMemoTextEditing(selectedNote.id, event.currentTarget)}
              onFocus={(event) => {
                if (editingNoteId !== selectedNote.id) event.currentTarget.blur();
              }}
              onChange={(event) => updateNote(selectedNote.id, event.target.value)}
              onKeyDown={(event) => finishMemoTextEditing(event, selectedNote.id)}
            />
          </label>
          <label className="control compact-control">
            <span>メモ透過率 {selectedNote.opacity}%</span>
            <input
              type="range"
              min="20"
              max="100"
              value={selectedNote.opacity}
              onChange={(event) => updateNoteFields(selectedNote.id, { opacity: Number(event.target.value) })}
            />
          </label>
          <label className="control compact-control">
            <span>文字サイズ {selectedNote.fontSize}px</span>
            <input
              type="range"
              min="12"
              max="48"
              value={selectedNote.fontSize}
              onChange={(event) => updateNoteFields(selectedNote.id, { fontSize: Number(event.target.value) })}
            />
          </label>
          <label className="check-control">
            <input
              type="checkbox"
              checked={selectedNote.autoSize}
              onChange={(event) => updateNoteFields(selectedNote.id, { autoSize: event.target.checked })}
            />
            <span>文字数に合わせて自動調整</span>
          </label>
          {selectedAnnotation?.type === "arrow" && (
            <div className="memo-arrow-controls" aria-label="選択中の矢印設定">
              <label className="control compact-control">
                <span>矢印の線の太さ {selectedAnnotation.strokeWidth}px</span>
                <input
                  type="range"
                  min="1"
                  max="12"
                  step="1"
                  value={selectedAnnotation.strokeWidth}
                  onChange={(event) => updateSelectedAnnotation({ strokeWidth: Number(event.target.value) })}
                />
              </label>
              <label className="control compact-control">
                <span>矢印の大きさ {selectedAnnotation.arrowHeadSize}px</span>
                <input
                  type="range"
                  min="6"
                  max="32"
                  step="1"
                  value={selectedAnnotation.arrowHeadSize}
                  onChange={(event) => updateSelectedAnnotation({ arrowHeadSize: Number(event.target.value) })}
                />
              </label>
            </div>
          )}
        </section>
          )}

          <section className="memo-stage-wrap" ref={stageWrapRef} onWheelCapture={zoomMemoWithWheel}>
        <div
          className={`memo-stage ${panning ? "panning" : ""} ${annotationTool ? "annotation-drawing" : ""}`}
          ref={stageRef}
          onPointerDown={startPan}
          onPointerMove={trackStagePointer}
          onPointerEnter={trackStagePointer}
          onPointerLeave={() => { stagePointerRef.current.inside = false; }}
          style={{
            width: `${(memoZoom * memoImageScale) / 100}%`,
            "--memo-content-scale": memoZoom / 100,
          }}
        >
          <img className="memo-image memo-image-a" ref={imageARef} src={imageA} alt="画像A（旧）" draggable="false" />
          <div className="memo-image-b-clip" style={{ clipPath: `inset(0 0 0 ${slider}%)` }}>
            <img className="memo-image" src={imageB} alt="画像B（新）" draggable="false" />
          </div>
          <div className="comparison-handle" style={{ left: `${slider}%` }} onPointerDown={startSliderDrag}>
            <span>A（旧）</span>
            <span>B（新）</span>
          </div>
          {safeStickies.map((sticky) => (
            <div
              key={sticky.id}
              className="memo-sticky"
              style={{
                left: `${sticky.x}%`,
                top: `${sticky.y}%`,
                width: `${sticky.width}px`,
                height: `${sticky.height}px`,
                "--sticky-font-size": `${sticky.fontSize}px`,
              }}
              onPointerDown={(event) => startStickyDrag(event, sticky)}
            >
              <div
                className="sticky-grip"
                title="ドラッグして付箋を移動"
                aria-label="付箋を移動"
                onPointerDown={(event) => startStickyDrag(event, sticky)}
              >
                <span>•••</span>
              </div>
              <textarea
                value={sticky.text}
                aria-label="独立した付箋"
                onChange={(event) => updateSticky(sticky.id, event.target.value)}
                onKeyDown={finishStickyEditing}
              />
              <button type="button" className="sticky-delete" title="付箋を削除" onClick={() => deleteSticky(sticky.id)}>
                <X size={13} />
              </button>
            </div>
          ))}
          {safeNotes.flatMap((note) => note.annotations.map((annotation) => {
            const color = memoColor(note);
            const selected = selectedNoteId === note.id && selectedAnnotationId === annotation.id;
            return (
              <div
                key={`${note.id}-${annotation.id}`}
                className={`memo-annotation ${annotation.type} ${selected ? "selected" : ""}`}
                style={{
                  left: `${annotation.x}%`,
                  top: `${annotation.y}%`,
                  width: `${annotation.width}%`,
                  height: `${annotation.height}%`,
                  "--annotation-color": color.line,
                  "--annotation-opacity": annotation.opacity / 100,
                  "--arrow-stroke-width": annotation.strokeWidth,
                }}
                title={`${memoAnnotationTypeLabel(annotation.type)}（${memoChangeTypeLabel(note.changeType)}）`}
                onPointerDown={(event) => startAnnotationTransform(event, note, annotation, "move")}
                onClick={(event) => {
                  event.stopPropagation();
                  setSelectedNoteId(note.id);
                  setSelectedAnnotationId(annotation.id);
                }}
              >
                {annotation.type === "arrow" && (
                  <svg className="memo-arrow" aria-hidden="true">
                    <defs>
                      <marker
                        id={`arrowhead-${annotation.id}`}
                        viewBox="0 0 10 10"
                        markerWidth={annotation.arrowHeadSize * (memoZoom / 100)}
                        markerHeight={annotation.arrowHeadSize * (memoZoom / 100)}
                        refX="9"
                        refY="5"
                        orient="auto"
                        markerUnits="userSpaceOnUse"
                        preserveAspectRatio="xMidYMid"
                      >
                        <path d="M0,0 L10,5 L0,10 Z" fill="var(--annotation-color)" />
                      </marker>
                    </defs>
                    <line
                      x1={annotation.reverseX ? "100%" : "0%"}
                      y1={annotation.reverseY ? "100%" : "0%"}
                      x2={annotation.reverseX ? "0%" : "100%"}
                      y2={annotation.reverseY ? "0%" : "100%"}
                      markerEnd={`url(#arrowhead-${annotation.id})`}
                    />
                  </svg>
                )}
                {selected && <>
                  {annotation.type === "arrow" ? <>
                    <button
                      type="button"
                      className="memo-arrow-endpoint start"
                      style={{ left: annotation.reverseX ? "100%" : "0%", top: annotation.reverseY ? "100%" : "0%" }}
                      aria-label="矢印の起点をドラッグ"
                      title="ドラッグして矢印の起点を変更"
                      onPointerDown={(event) => startArrowEndpointDrag(event, note, annotation, "start")}
                    />
                    <button
                      type="button"
                      className="memo-arrow-endpoint end"
                      style={{ left: annotation.reverseX ? "0%" : "100%", top: annotation.reverseY ? "0%" : "100%" }}
                      aria-label="矢印の終点をドラッグ"
                      title="ドラッグして矢印の終点を変更"
                      onPointerDown={(event) => startArrowEndpointDrag(event, note, annotation, "end")}
                    />
                  </> : <button
                    type="button"
                    className="memo-annotation-resize"
                    aria-label="図形の大きさを変更"
                    title="ドラッグして大きさを変更"
                    onPointerDown={(event) => startAnnotationTransform(event, note, annotation, "resize")}
                  />}
                </>}
              </div>
            );
          }))}
          {safeNotes.map((note) => {
            const leaders = memoNoteLeaders(note);
            const color = memoColor(note);
            return (
              <div
                key={note.id}
                data-note-id={note.id}
                className={`memo-note ${selectedNoteId === note.id ? "selected" : ""} ${editingNoteId === note.id ? "editing" : ""}`}
                style={{
                  ...memoBoxStyle(note),
                  left: `${note.x}%`,
                  top: `${note.y}%`,
                  "--memo-alpha": note.opacity / 100,
                  "--memo-font-size": `${note.fontSize}px`,
                  "--memo-fill": color.fill,
                  "--memo-border": color.border,
                  "--memo-line": color.line,
                }}
                onPointerDown={(event) => startDrag(event, note)}
                onDoubleClick={(event) => {
                  if (event.target.closest("button, .memo-leader-handle")) return;
                  event.preventDefault();
                  event.stopPropagation();
                  activateMemoTextEditing(note.id);
                }}
                onContextMenu={(event) => openMemoContextMenu(event, note)}
              >
                <svg className="memo-leader" viewBox="-420 -240 1040 760" aria-hidden="true">
                  {leaders.map((leader) => (
                    <line
                      key={leader.id}
                      x1={leader.start.x}
                      y1={leader.start.y}
                      x2={leader.endX}
                      y2={leader.endY}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setSelectedNoteId(note.id);
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedNoteId(note.id);
                      }}
                      onContextMenu={(event) => openMemoContextMenu(event, note)}
                    />
                  ))}
                </svg>
                {leaders.map((leader, index) => (
                  <React.Fragment key={leader.id}>
                    <button
                      type="button"
                      className={`memo-leader-handle ${index > 0 ? "extra" : ""}`}
                      title="引出線の起点をドラッグ"
                      data-line-id={leader.id}
                      style={memoLeaderHandleStyle(leader.start, memoSize(note))}
                      onPointerDown={(event) => startLeaderDrag(event, note, "start")}
                    />
                    <button
                      type="button"
                      className={`memo-leader-handle end ${index > 0 ? "extra" : ""}`}
                      title="引出線の終点をドラッグ"
                      data-line-id={leader.id}
                      style={{ left: `${leader.endX}px`, top: `${leader.endY}px` }}
                      onPointerDown={(event) => startLeaderDrag(event, note, "end")}
                    />
                  </React.Fragment>
                ))}
                <textarea
                  value={note.text}
                  aria-label="メモ本文"
                  readOnly={editingNoteId !== note.id}
                  tabIndex={editingNoteId === note.id ? 0 : -1}
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    activateMemoTextEditing(note.id, event.currentTarget);
                  }}
                  onFocus={(event) => {
                    if (editingNoteId !== note.id) event.currentTarget.blur();
                  }}
                  onChange={(event) => updateNote(note.id, event.target.value)}
                  onKeyDown={(event) => finishMemoTextEditing(event, note.id)}
                />
                <button className="memo-delete" title="メモ削除" onClick={() => deleteNote(note.id)}>
                  <X size={14} />
                </button>
              </div>
            );
          })}
          </div>
          </section>
        </div>
      </div>

      {contextMenu && (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
          {contextMenu.noteId ? (
            <button onClick={() => { deleteNote(contextMenu.noteId); setContextMenu(null); }}>削除（メモ・ライン・図形）</button>
          ) : (
            <>
              <button onClick={() => copyMemoImage("pair")}>A（旧） / B（新）を左右配置でコピー</button>
              <button onClick={() => copyMemoImage("a")}>画像A（旧）をメモ付きでクリップボードに保存</button>
              <button onClick={() => copyMemoImage("b")}>画像B（新）をメモ付きでクリップボードに保存</button>
            </>
          )}
        </div>
      )}
      {helpOpen && <ShortcutHelp page="memo" onClose={() => setHelpOpen(false)} />}
    </main>
  );
}

function FilePicker({ label, side, active, data, page, setPage, onFile, onActivate, onPasteImage, onDropFile }) {
  const pages = data?.metadata?.pages ?? [];
  const pasted = Boolean(data?.attachment);
  const [dragging, setDragging] = useState(false);

  function handleDrop(event) {
    event.preventDefault();
    setDragging(false);
    onActivate(side);
    const file = firstDroppedFile(event.dataTransfer);
    if (file) onDropFile(file);
  }

  return (
    <div
      className={`file-picker ${active ? "active" : ""} ${dragging ? "dragging" : ""}`}
      tabIndex={0}
      onFocus={() => onActivate(side)}
      onClick={() => onActivate(side)}
      onPaste={(event) => onPasteImage(side, event)}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
        onActivate(side);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false);
      }}
      onDrop={handleDrop}
    >
      <label className="upload">
        <ImageUp size={18} />
        <span>File {label}</span>
        <input
          type="file"
          onChange={(event) => {
            if (event.target.files?.[0]) {
              onFile(event.target.files[0]);
              event.target.value = "";
            }
          }}
        />
      </label>
      <div className="paste-hint">
        <Clipboard size={16} />
        <span>cmd+V</span>
      </div>
      <div className="file-meta">
        <strong>{data?.file?.name ?? "未選択"}</strong>
        <small>
          {data
            ? `${data.metadata.format.toUpperCase()} / ${data.metadata.page_count} page${pasted ? " / 添付保存済み" : ""}`
            : "選択 / ドロップ / 貼り付け"}
        </small>
      </div>
      <label className="page-select">
        <Layers size={16} />
        <select value={page} onChange={(event) => setPage(Number(event.target.value))} disabled={!pages.length}>
          {pages.length ? pages.map((item) => (
            <option key={item.index} value={item.index}>
              {item.index + 1} ({item.width}x{item.height})
            </option>
          )) : <option>Page</option>}
        </select>
      </label>
    </div>
  );
}

function ImagePane({
  title,
  side,
  active,
  subtitle,
  image,
  zoom,
  regions = [],
  selectedRegion,
  onSelectRegion,
  onActivate,
  onPasteImage,
  onDropFile,
  onCanvasRef,
  onCanvasScroll,
  onCanvasWheel,
}) {
  const [imageSize, setImageSize] = useState(null);
  const [panning, setPanning] = useState(false);
  const panRef = useRef(null);
  useEffect(() => {
    setImageSize(null);
  }, [image]);

  const [dragging, setDragging] = useState(false);

  function startCanvasPan(event) {
    if (event.button !== 0 && event.button !== 1) return;
    // 基準領域ボタンはクリック選択を優先し、ドラッグパンを開始しない。
    if (event.button === 0 && event.target.closest?.("button")) return;
    event.preventDefault();
    const canvas = event.currentTarget;
    panRef.current = {
      pointerId: event.pointerId,
      button: event.button,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: canvas.scrollLeft,
      scrollTop: canvas.scrollTop,
      moved: false,
    };
    canvas.setPointerCapture?.(event.pointerId);
    setPanning(true);
  }

  function moveCanvasPan(event) {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    const canvas = event.currentTarget;
    const deltaX = event.clientX - pan.startX;
    const deltaY = event.clientY - pan.startY;
    if (!pan.moved && Math.hypot(deltaX, deltaY) < 4) return;
    pan.moved = true;
    event.preventDefault();
    canvas.scrollLeft = pan.scrollLeft - deltaX;
    canvas.scrollTop = pan.scrollTop - deltaY;
    setPanning(true);
  }

  function endCanvasPan(event) {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    panRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setPanning(false);
  }

  function handleDrop(event) {
    event.preventDefault();
    setDragging(false);
    onActivate(side);
    const file = firstDroppedFile(event.dataTransfer);
    if (file) onDropFile?.(file);
  }

  return (
    <article
      className={`pane ${active ? "active" : ""} ${dragging ? "dragging" : ""}`}
      tabIndex={0}
      onFocus={() => onActivate(side)}
      onClick={() => onActivate(side)}
      onPaste={(event) => onPasteImage(side, event)}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
        onActivate(side);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false);
      }}
      onDrop={handleDrop}
    >
      <div className="pane-title">
        <strong>{title}</strong>
        <span>{subtitle ?? "クリックしてcmd+V / ドロップ"}</span>
      </div>
      <div
        className={`canvas ${panning ? "panning" : ""}`}
        ref={onCanvasRef}
        onScroll={onCanvasScroll}
        onWheel={onCanvasWheel}
        onPointerDown={startCanvasPan}
        onPointerMove={moveCanvasPan}
        onPointerUp={endCanvasPan}
        onPointerCancel={endCanvasPan}
        onAuxClick={(event) => {
          if (event.button === 1) event.preventDefault();
        }}
      >
        {image ? (
          <div className="image-stage" style={{ width: `${zoom * 100}%` }}>
            <img
              src={image}
              alt={title}
              draggable={false}
              onLoad={(event) =>
                setImageSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
            />
            {imageSize && regions.length > 0 && (
              <div className="region-layer" aria-label="基準領域候補">
                {regions.map((region, index) => (
                  <button
                    key={`${region.x}-${region.y}-${region.width}-${region.height}-${index}`}
                    className={`region-box ${isSameRegion(region, selectedRegion) ? "selected" : ""}`}
                    title={`${region.label} (${region.width}x${region.height})`}
                    style={regionStyle(region, imageSize)}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelectRegion?.(region);
                    }}
                  >
                    {index + 1}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="empty">No image</div>
        )}
      </div>
    </article>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

async function postForm(path, form) {
  const response = await fetch(`${API_BASE}${path}`, { method: "POST", body: form });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw apiError(body.detail || `API error: ${response.status}`, response.status);
  }
  return body;
}

async function postJson(path, payload) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw apiError(body.detail || `API error: ${response.status}`, response.status);
  }
  return body;
}

async function getJson(path) {
  const response = await fetch(`${API_BASE}${path}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw apiError(body.detail || `API error: ${response.status}`, response.status);
  }
  return body;
}

function apiError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function toDataUri(image) {
  return `data:${image.mime_type};base64,${image.data}`;
}

function imageFileFromClipboard(clipboardData) {
  const items = Array.from(clipboardData?.items ?? []);
  const imageItem = items.find((item) => item.kind === "file" && item.type.startsWith("image/"));
  const blob = imageItem?.getAsFile();
  if (!blob) return null;
  const extension = extensionForMime(blob.type);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return new File([blob], `clipboard-${timestamp}.${extension}`, { type: blob.type || "image/png" });
}

function firstDroppedFile(dataTransfer) {
  return Array.from(dataTransfer?.files ?? []).find((file) => file.size > 0) ?? null;
}

function extensionForMime(mimeType) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

function regionStyle(region, imageSize) {
  return {
    left: `${(region.x / imageSize.width) * 100}%`,
    top: `${(region.y / imageSize.height) * 100}%`,
    width: `${(region.width / imageSize.width) * 100}%`,
    height: `${(region.height / imageSize.height) * 100}%`,
  };
}

function isSameRegion(a, b) {
  return Boolean(
    a &&
      b &&
      a.x === b.x &&
      a.y === b.y &&
      a.width === b.width &&
      a.height === b.height &&
      a.label === b.label,
  );
}

async function openDiffMemoTab(result, left, right, onError, fixedId = null, extraPayload = {}) {
  const id = fixedId ?? (crypto.randomUUID?.() ?? String(Date.now()));
  const existing = fixedId ? await readMemoPayload(id) : null;
  const payload = {
    imageA: result.image_a,
    imageB: result.image_b_aligned,
    nameA: left?.file?.name,
    nameB: right?.file?.name,
    notes: existing?.notes ?? [],
    stickies: existing?.stickies ?? [],
    stageSize: existing?.stageSize ?? null,
    memoZoom: existing?.memoZoom ?? 100,
    memoImageScale: existing?.memoImageScale ?? 100,
    memoGeometryVersion: existing?.memoGeometryVersion ?? null,
    reportOptions: existing?.reportOptions ?? null,
    ...extraPayload,
  };
  try {
    await storeMemoPayload(id, payload);
    window.open(`${window.location.origin}${window.location.pathname}${window.location.search}#diff-memo/${id}`, "_blank");
  } catch (err) {
    onError?.(`差分メモを開けませんでした: ${err.message}`);
  }
}

async function openStoredMemoTab(id) {
  const stored = await readMemoPayload(id);
  if (stored) await storeMemoPayload(id, { ...stored, reportPreviewReturn: true });
  window.open(`${window.location.origin}${window.location.pathname}${window.location.search}#diff-memo/${encodeURIComponent(id)}`, "_blank");
}

function returnToReportPreview() {
  if (window.opener && !window.opener.closed) {
    window.opener.focus();
    window.close();
    return;
  }
  window.location.href = `${window.location.origin}${window.location.pathname}${window.location.search}`;
}

function loadTextExtensions() {
  try {
    return normalizeTextExtensions(JSON.parse(localStorage.getItem(GIT_EXTENSION_STORAGE_KEY) || "null") ?? DEFAULT_TEXT_EXTENSIONS);
  } catch {
    return [...DEFAULT_TEXT_EXTENSIONS];
  }
}

function normalizeTextExtensions(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(/[,\s]+/);
  return [...new Set(items.map((item) => String(item).trim().toLowerCase()).filter(Boolean).map((item) => item.startsWith(".") ? item : `.${item}`)
    .filter((item) => /^\.[a-z0-9][a-z0-9._+-]{0,15}$/.test(item)))].slice(0, 50);
}

function loadGitTextMemos() {
  try {
    const value = JSON.parse(localStorage.getItem(GIT_TEXT_MEMO_STORAGE_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function loadDisplayScale() {
  try {
    const value = Number(localStorage.getItem(DISPLAY_SCALE_STORAGE_KEY));
    return Number.isFinite(value) ? Math.min(2, Math.max(0.5, value)) : 1;
  } catch {
    return 1;
  }
}

function loadMemoSidebarWidth() {
  try {
    const value = Number(localStorage.getItem(MEMO_SIDEBAR_WIDTH_STORAGE_KEY));
    return Number.isFinite(value) ? clamp(Math.round(value), 160, 420) : 230;
  } catch {
    return 230;
  }
}

function loadMemoSidebarVisible() {
  try {
    const value = localStorage.getItem(MEMO_SIDEBAR_VISIBLE_STORAGE_KEY);
    return value === null ? true : value !== "false";
  } catch {
    return true;
  }
}

function loadGitFolderHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(GIT_FOLDER_HISTORY_STORAGE_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].slice(0, 12);
  } catch {
    return [];
  }
}

function loadLastGitFolder() {
  return loadGitFolderHistory()[0] ?? "";
}

function persistLocalStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function gitMemoKey(repo, path) {
  return `${repo || "repo"}::${path}`;
}

function gitImageMemoId(repo, path) {
  const source = gitMemoKey(repo, path);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `git-image-${(hash >>> 0).toString(16)}`;
}

function changeTypeLabel(type) {
  return ({ modified: "変更", added: "追加", deleted: "削除", untracked: "未追跡", renamed: "名前変更", copied: "コピー" })[type] ?? type;
}

function gitReportFilename(infoOrRepo) {
  if (infoOrRepo && typeof infoOrRepo === "object" && infoOrRepo.source_markdown) {
    const markdownName = String(infoOrRepo.source_markdown).split(/[\\/]/).filter(Boolean).pop() || "note.md";
    const baseName = markdownName.replace(/\.md$/i, "") || "note";
    return `${baseName}_変更差分レポート.html`;
  }
  const repo = typeof infoOrRepo === "object" ? infoOrRepo?.repo_root : infoOrRepo;
  const name = String(repo || "repository").split(/[\\/]/).filter(Boolean).pop() || "repository";
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `${name}-diff-${stamp}.html`;
}

function downloadTextFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function buildStandaloneGitReport(info, entries) {
  const sections = [];
  for (const entry of entries) {
    sections.push(entry.file.kind === "text" ? buildTextReportSection(entry) : await buildImageReportSection(entry));
  }
  const generated = new Intl.DateTimeFormat("ja-JP", { dateStyle: "long", timeStyle: "medium" }).format(new Date());
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>差分レポート - ${escapeHtml(info.repo_root)}</title><style>${standaloneReportCss()}</style></head>
<body><header><h1>差分レポート</h1><dl><div><dt>リポジトリ</dt><dd>${escapeHtml(info.repo_root)}</dd></div><div><dt>出力日時</dt><dd>${escapeHtml(generated)}</dd></div><div><dt>変更ファイル</dt><dd>${entries.length}件</dd></div></dl></header>
<main id="report-content">${sections.join("\n")}</main><footer>Visual Diff Tool — このHTMLは画像・CSSを内包した自己完結ファイルです。</footer>
<script>${standaloneReportScript()}</script></body></html>`;
}

function buildTextReportSection({ file, data, memo }) {
  const rows = (data.rows ?? []).map((row) => `<div class="code-cell ${oldCellClass(row)}"${reportGapStyle(row, "old")}><span>${row.old_number ?? ""}</span><code>${reportLineHtml(row, "old")}</code></div><div class="code-cell ${newCellClass(row)}"${reportGapStyle(row, "new")}><span>${row.new_number ?? ""}</span><code>${reportLineHtml(row, "new")}</code></div>`).join("");
  return `<section><h2>${escapeHtml(file.path)} <b class="badge ${escapeHtml(file.change_type)}">${escapeHtml(changeTypeLabel(file.change_type))}</b></h2>${memo.trim() ? `<aside><strong>メモ</strong><p>${escapeHtml(memo).replaceAll("\n", "<br>")}</p></aside>` : ""}<div class="diff-grid"><h3>変更前: ${escapeHtml(file.head_path)}</h3><h3>変更後: ${escapeHtml(file.path)}</h3>${rows || '<p class="empty-report">差分行はありません。</p>'}</div></section>`;
}

async function buildImageReportSection({ file, data, imageMemo, reportOptions }) {
  const head = data.image_a ?? data.image_head ?? null;
  const current = data.image_b_aligned ?? data.image_current ?? null;
  const notes = normalizeMemoNotes(imageMemo?.notes);
  const stickies = normalizeStickyNotes(imageMemo?.stickies);
  const renderStageSize = effectiveMemoStageSize(imageMemo);
  const annotateHead = !current && Boolean(head);
  const hasAnnotations = notes.length || stickies.length;
  const headSrc = head ? (annotateHead && hasAnnotations ? await renderImageWithNotesDataUri(toDataUri(head), notes, renderStageSize, stickies) : toDataUri(head)) : null;
  const currentSrc = current ? (hasAnnotations ? await renderImageWithNotesDataUri(toDataUri(current), notes, renderStageSize, stickies) : toDataUri(current)) : null;
  const memoImageSrc = current ? toDataUri(current) : head ? toDataUri(head) : null;
  const memoCrops = memoImageSrc
    ? await renderMemoCropDataUris(memoImageSrc, notes, renderStageSize, stickies, reportOptions)
    : notes.map(() => null);
  const panels = [
    ["変更前", headSrc],
    ["変更後", currentSrc],
    ["差分オーバーレイ", data.overlay ? toDataUri(data.overlay) : null],
  ].filter(([, src]) => src).map(([label, src]) => `<figure><figcaption>${label}</figcaption><img src="${src}" alt="${label}"></figure>`).join("");
  const memoList = notes.length ? `<aside class="report-memos"><strong>画像メモ</strong><div class="memo-card-grid">${notes.map((note, index) => {
    const view = normalizeReportView(reportOptions?.views?.[note.id], note, renderStageSize);
    return `<article class="memo-card" style="border-color:${memoColor(note).hex};max-width:${view.cardWidth}px">${memoCrops[index] ? `<div class="memo-card-media" style="height:${view.cardHeight}px"><img src="${memoCrops[index]}" alt="${escapeHtml(memoAnnotationTypeLabel(note.annotations[0]?.type))}周辺の拡大画像"></div>` : ""}<div><b class="memo-type">${escapeHtml(memoChangeTypeLabel(note.changeType))}</b><p><i class="memo-color-dot" style="background:${memoColor(note).hex}"></i>${escapeHtml(note.text).replaceAll("\n", "<br>")}</p></div></article>`;
  }).join("")}</div></aside>` : "";
  const stickyList = stickies.length ? `<aside class="report-stickies"><strong>付箋</strong><ul>${stickies.map((sticky) => `<li>${escapeHtml(sticky.text).replaceAll("\n", "<br>")}</li>`).join("")}</ul></aside>` : "";
  return `<section><h2>${escapeHtml(file.path)} <b class="badge ${escapeHtml(file.change_type)}">${escapeHtml(changeTypeLabel(file.change_type))}</b></h2>${memoList}${stickyList}<div class="image-grid">${panels || '<p class="empty-report">表示できる画像がありません。</p>'}</div></section>`;
}

function oldCellClass(row) {
  return row.kind === "delete" || row.kind === "replace" ? "removed" : row.kind === "insert" ? "added-gap" : "";
}

function newCellClass(row) {
  return row.kind === "insert" || row.kind === "replace" ? "added" : row.kind === "delete" ? "removed-gap" : "";
}

function reportGapStyle(row, side) {
  if (side === "old" && row.kind === "insert") {
    return ' style="background:repeating-linear-gradient(135deg,#fff 0,#fff 6px,#dcfce7 6px,#dcfce7 12px)"';
  }
  if (side === "new" && row.kind === "delete") {
    return ' style="background:repeating-linear-gradient(135deg,#fff 0,#fff 6px,#fee2e2 6px,#fee2e2 12px)"';
  }
  return "";
}

function reportLineHtml(row, side) {
  const segments = side === "old" ? row.old_segments : row.new_segments;
  if (segments) return segments.map((segment) => segment.changed ? `<mark>${escapeHtml(segment.text)}</mark>` : escapeHtml(segment.text)).join("");
  const text = side === "old" ? row.old ?? "" : row.new ?? "";
  return row.kind === "insert" || row.kind === "delete" ? `<mark>${escapeHtml(text)}</mark>` : escapeHtml(text);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function standaloneReportCss() {
  return `:root{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#172033;background:#f1f5f9}*{box-sizing:border-box}body{margin:0;overflow-x:auto}header,footer{padding:14px 1.5vw;background:#172033;color:#fff}header h1{margin:0 0 10px}dl{margin:0;display:flex;gap:18px;flex-wrap:wrap}dl div{display:flex;gap:6px}dt{color:#a8b3c7}dd{margin:0}#report-content{width:100%;margin:12px 0;transform-origin:top left}section{margin:0 0 16px;background:#fff;border:1px solid #cbd5e1;border-radius:6px;overflow:hidden;page-break-inside:avoid}h2{margin:0;padding:10px 12px;background:#e2e8f0;font-size:16px}.badge{margin-left:8px;padding:3px 8px;border-radius:99px;background:#64748b;color:#fff;font-size:11px}.badge.added,.badge.untracked{background:#16803b}.badge.deleted{background:#b42318}aside{margin:8px 12px;padding:9px 11px;border-left:4px solid #eab308;background:#fefce8}aside p,aside ol,aside ul{margin:5px 0 0}.memo-card-grid{margin-top:8px;display:grid;grid-template-columns:1fr;gap:10px}.memo-card{width:100%;min-width:0;display:grid;grid-template-columns:minmax(180px,44%) 1fr;align-items:start;gap:14px;border:2px solid #64748b;border-radius:8px;padding:10px;background:#fff}.memo-card-media{display:grid;place-items:center;overflow:hidden;background:#fff;border:1px solid #cbd5e1}.memo-card img{display:block;width:100%;height:100%;object-fit:contain}.memo-card p{margin:6px 0 0;overflow-wrap:anywhere;font-size:clamp(15px,2vw,28px);line-height:1.45}.memo-type{display:inline-block;padding:2px 7px;border-radius:99px;background:#e2e8f0;font-size:11px}.memo-color-dot{display:inline-block;width:10px;height:10px;margin-right:6px;border-radius:99px}.diff-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);overflow:auto}.diff-grid h3{position:sticky;top:0;margin:0;padding:8px 10px;background:#172033;color:#fff;font-size:12px}.code-cell{min-width:0;display:grid;grid-template-columns:46px 1fr;border-bottom:1px solid #e2e8f0;background:#fff}.code-cell>span{padding:2px 6px;background:#f8fafc;border-right:1px solid #e2e8f0;text-align:right;color:#64748b;user-select:none}.code-cell code{padding:2px 6px;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace}.code-cell.removed{background:#ffebe9}.code-cell.added{background:#dafbe1}.code-cell mark{padding:0;background:#f7a8a8}.code-cell.added mark{background:#83d997}.image-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:8px;background:#e2e8f0}.image-grid figure{min-width:0;margin:0;background:#fff;border:1px solid #94a3b8}.image-grid figcaption{padding:6px 8px;background:#172033;color:#fff;font-weight:700;font-size:12px}.image-grid img{display:block;width:100%;height:auto}.empty-report{padding:18px}.report-zoom-indicator{position:fixed;right:10px;bottom:10px;padding:5px 8px;border-radius:4px;background:#172033e6;color:#fff;font:12px ui-sans-serif,system-ui,sans-serif;z-index:10}footer{text-align:center;color:#cbd5e1;font-size:12px}@media(max-width:900px){.image-grid{grid-template-columns:1fr}.memo-card{grid-template-columns:1fr;max-width:100%!important}}@media print{header{background:#fff;color:#000;border-bottom:2px solid #000}#report-content{width:100%;margin:8px 0}.diff-grid{font-size:9px}.image-grid{grid-template-columns:1fr 1fr}footer{display:none}}`;
}

function standaloneReportScript() {
  return `(function(){const root=document.getElementById("report-content");if(!root)return;let scale=1;const min=.5,max=3,step=.1;const label=document.createElement("div");label.className="report-zoom-indicator";label.textContent="表示倍率 100%（Ctrl+ホイール）";document.body.appendChild(label);const update=()=>{root.style.zoom=String(scale);label.textContent="表示倍率 "+Math.round(scale*100)+"%（Ctrl+ホイール）"};window.addEventListener("wheel",function(event){if(!event.ctrlKey)return;event.preventDefault();scale=Math.max(min,Math.min(max,scale+(event.deltaY<0?step:-step)));update()},{passive:false});update()})();`;
}

async function renderImageWithNotesDataUri(imageSrc, notes, stageSize = null, stickies = []) {
  const image = await loadImage(imageSrc);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  drawNotes(ctx, notes, canvas.width, canvas.height, stageSize, stickies);
  return canvas.toDataURL("image/png");
}

async function renderMemoCropDataUris(imageSrc, notes, stageSize = null, stickies = [], reportOptions = {}) {
  const image = await loadImage(imageSrc);
  const fullCanvas = document.createElement("canvas");
  fullCanvas.width = image.naturalWidth;
  fullCanvas.height = image.naturalHeight;
  const fullContext = fullCanvas.getContext("2d");
  fullContext.imageSmoothingEnabled = true;
  fullContext.imageSmoothingQuality = "high";
  fullContext.drawImage(image, 0, 0);
  drawNotes(fullContext, notes, fullCanvas.width, fullCanvas.height, stageSize, stickies);

  return notes.map((note) => {
    const selectedCrop = normalizeReportCrop(reportOptions?.crops?.[note.id]);
    let sourceX;
    let sourceY;
    let cropWidth;
    let cropHeight;
    if (selectedCrop) {
      sourceX = (selectedCrop.x / 100) * fullCanvas.width;
      sourceY = (selectedCrop.y / 100) * fullCanvas.height;
      cropWidth = Math.max(1, (selectedCrop.width / 100) * fullCanvas.width);
      cropHeight = Math.max(1, (selectedCrop.height / 100) * fullCanvas.height);
    } else {
      const view = normalizeReportView(reportOptions?.views?.[note.id], note, stageSize);
      const fallbackCrop = reportVisibleCrop(
        { width: fullCanvas.width, height: fullCanvas.height },
        { width: view.cardWidth, height: view.cardHeight },
        view,
      ) ?? defaultMemoReportCrop(note, stageSize);
      sourceX = (fallbackCrop.x / 100) * fullCanvas.width;
      sourceY = (fallbackCrop.y / 100) * fullCanvas.height;
      cropWidth = Math.max(1, (fallbackCrop.width / 100) * fullCanvas.width);
      cropHeight = Math.max(1, (fallbackCrop.height / 100) * fullCanvas.height);
    }
    const cropCanvas = document.createElement("canvas");
    const aspect = cropWidth / cropHeight;
    if (aspect >= 1) {
      cropCanvas.width = 720;
      cropCanvas.height = Math.max(1, Math.round(720 / aspect));
    } else {
      cropCanvas.height = 720;
      cropCanvas.width = Math.max(1, Math.round(720 * aspect));
    }
    const cropContext = cropCanvas.getContext("2d");
    cropContext.imageSmoothingEnabled = true;
    cropContext.imageSmoothingQuality = "high";
    cropContext.fillStyle = "#ffffff";
    cropContext.fillRect(0, 0, cropCanvas.width, cropCanvas.height);
    cropContext.drawImage(fullCanvas, sourceX, sourceY, cropWidth, cropHeight, 0, 0, cropCanvas.width, cropCanvas.height);
    return cropCanvas.toDataURL("image/jpeg", 0.88);
  });
}

function normalizeReportCrop(crop) {
  if (!crop || typeof crop !== "object") return null;
  const x = clamp(Number(crop.x) || 0, 0, 98);
  const y = clamp(Number(crop.y) || 0, 0, 98);
  const width = clamp(Number(crop.width) || 0, 2, 100 - x);
  const height = clamp(Number(crop.height) || 0, 2, 100 - y);
  return { x, y, width, height };
}

function normalizeReportOptions(options) {
  return {
    crops: options?.crops && typeof options.crops === "object" ? options.crops : {},
    views: options?.views && typeof options.views === "object" ? options.views : {},
  };
}

function canonicalMemoStageSize(stage, memoZoom, memoImageScale = 100) {
  const zoomScale = clamp(Number(memoZoom) || 100, 10, 300) / 100;
  const imageScale = clamp(Number(memoImageScale) || 100, 25, 150) / 100;
  return {
    width: Math.max(1, stage.offsetWidth / zoomScale / imageScale),
    height: Math.max(1, stage.offsetHeight / zoomScale / imageScale),
  };
}

function effectiveMemoStageSize(imageMemo) {
  const width = Number(imageMemo?.stageSize?.width);
  const height = Number(imageMemo?.stageSize?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  if (Number(imageMemo?.memoGeometryVersion) >= 2) {
    const imageScale = clamp(Number(imageMemo?.memoImageScale) || 100, 25, 150) / 100;
    return { width: width * imageScale, height: height * imageScale };
  }
  // Older payloads stored the already-zoomed stage. Values produced at very
  // small/large editor zooms make exported labels explode or shrink. Only
  // retain legacy dimensions that are plausibly a 100% editing stage.
  if (width < 600 || width > 1600 || height < 300 || height > 1400) return null;
  return { width, height };
}

function normalizeReportView(view, note = null, stageSize = null) {
  const fallback = defaultMemoReportView(note, stageSize);
  const imageScale = Number(view?.imageScale);
  return {
    centerX: clamp(Number(view?.centerX ?? fallback.centerX), 0, 100),
    centerY: clamp(Number(view?.centerY ?? fallback.centerY), 0, 100),
    zoom: clamp(Number(view?.zoom ?? fallback.zoom), 100, 500),
    cardWidth: clamp(Math.round(Number(view?.cardWidth ?? fallback.cardWidth)), 420, 1180),
    cardHeight: clamp(Math.round(Number(view?.cardHeight ?? fallback.cardHeight)), 220, 720),
    imageScale: Number.isFinite(imageScale) && imageScale > 0 ? clamp(imageScale, 0.01, 20) : null,
  };
}

function defaultMemoReportView(note, stageSize = null) {
  const width = Math.max(1, Number(stageSize?.width) || 1000);
  const height = Math.max(1, Number(stageSize?.height) || 700);
  if (!note) return { centerX: 50, centerY: 50, zoom: 100, cardWidth: 900, cardHeight: 420 };
  const focus = memoFocusPoint(note, width, height, stageSize);
  return {
    centerX: clamp((focus.x / width) * 100, 0, 100),
    centerY: clamp((focus.y / height) * 100, 0, 100),
    zoom: 200,
    cardWidth: 900,
    cardHeight: 420,
  };
}

function reportViewportGeometry(imageSize, viewportSize, view) {
  if (!imageSize?.width || !imageSize?.height || !viewportSize?.width || !viewportSize?.height) return null;
  const scale = Number.isFinite(view.imageScale) && view.imageScale > 0
    ? view.imageScale
    : Math.min(viewportSize.width / imageSize.width, viewportSize.height / imageSize.height) * (view.zoom / 100);
  const width = imageSize.width * scale;
  const height = imageSize.height * scale;
  const minCenterX = width > viewportSize.width ? (viewportSize.width / (2 * width)) * 100 : 50;
  const minCenterY = height > viewportSize.height ? (viewportSize.height / (2 * height)) * 100 : 50;
  const centerX = clamp(view.centerX, minCenterX, 100 - minCenterX);
  const centerY = clamp(view.centerY, minCenterY, 100 - minCenterY);
  return {
    width,
    height,
    centerX,
    centerY,
    left: viewportSize.width / 2 - (centerX / 100) * width,
    top: viewportSize.height / 2 - (centerY / 100) * height,
  };
}

function reportVisibleCrop(imageSize, viewportSize, view) {
  const geometry = reportViewportGeometry(imageSize, viewportSize, view);
  if (!geometry) return null;
  const left = clamp((-geometry.left / geometry.width) * 100, 0, 100);
  const top = clamp((-geometry.top / geometry.height) * 100, 0, 100);
  const right = clamp(((viewportSize.width - geometry.left) / geometry.width) * 100, 0, 100);
  const bottom = clamp(((viewportSize.height - geometry.top) / geometry.height) * 100, 0, 100);
  return normalizeReportCrop({ x: left, y: top, width: right - left, height: bottom - top });
}

function reportCropScreenStyle(crop, geometry) {
  return {
    left: `${geometry.left + (crop.x / 100) * geometry.width}px`,
    top: `${geometry.top + (crop.y / 100) * geometry.height}px`,
    width: `${(crop.width / 100) * geometry.width}px`,
    height: `${(crop.height / 100) * geometry.height}px`,
  };
}

function defaultMemoReportCrop(note, stageSize = null) {
  if (note?.annotations?.length) {
    const bounds = note.annotations.reduce((result, annotation) => ({
      left: Math.min(result.left, annotation.x),
      top: Math.min(result.top, annotation.y),
      right: Math.max(result.right, annotation.x + annotation.width),
      bottom: Math.max(result.bottom, annotation.y + annotation.height),
    }), { left: 100, top: 100, right: 0, bottom: 0 });
    const paddingX = Math.max(7, (bounds.right - bounds.left) * 0.45);
    const paddingY = Math.max(7, (bounds.bottom - bounds.top) * 0.65);
    const x = clamp(bounds.left - paddingX, 0, 98);
    const y = clamp(bounds.top - paddingY, 0, 98);
    return normalizeReportCrop({
      x,
      y,
      width: Math.min(100 - x, bounds.right - bounds.left + paddingX * 2),
      height: Math.min(100 - y, bounds.bottom - bounds.top + paddingY * 2),
    });
  }
  const leader = memoNoteLeaders(note)[0];
  const stageWidth = Number(stageSize?.width) || 1000;
  const stageHeight = Number(stageSize?.height) || 700;
  const focusX = clamp(note.x + (leader.endX / stageWidth) * 100, 0, 100);
  const focusY = clamp(note.y + (leader.endY / stageHeight) * 100, 0, 100);
  const left = Math.min(note.x, focusX);
  const top = Math.min(note.y, focusY);
  const right = Math.max(note.x + (memoSize(note).width / stageWidth) * 100, focusX);
  const bottom = Math.max(note.y + (memoSize(note).height / stageHeight) * 100, focusY);
  const x = clamp(left - 8, 0, 98);
  const y = clamp(top - 8, 0, 98);
  return normalizeReportCrop({ x, y, width: Math.min(100 - x, right - left + 16), height: Math.min(100 - y, bottom - top + 16) });
}

function memoFocusPoint(note, width, height, stageSize = null) {
  if (note.annotations.length) {
    const bounds = note.annotations.reduce((result, annotation) => ({
      left: Math.min(result.left, annotation.x),
      top: Math.min(result.top, annotation.y),
      right: Math.max(result.right, annotation.x + annotation.width),
      bottom: Math.max(result.bottom, annotation.y + annotation.height),
    }), { left: 100, top: 100, right: 0, bottom: 0 });
    return {
      x: ((bounds.left + bounds.right) / 200) * width,
      y: ((bounds.top + bounds.bottom) / 200) * height,
    };
  }
  const scale = stageSize?.width ? width / stageSize.width : Math.max(1, Math.min(width, height) / 900);
  const leader = memoNoteLeaders(note)[0];
  return {
    x: clamp((note.x / 100) * width + leader.endX * scale, 0, width),
    y: clamp((note.y / 100) * height + leader.endY * scale, 0, height),
  };
}

async function storeMemoPayload(id, payload) {
  try {
    const db = await openMemoDb();
    await idbRequest(db.transaction(MEMO_DB_STORE, "readwrite").objectStore(MEMO_DB_STORE).put({ id, payload, createdAt: Date.now() }));
  } catch {
    localStorage.setItem(`${MEMO_STORAGE_KEY}:${id}`, JSON.stringify(payload));
  }
}

async function readMemoPayload(id) {
  if (!id) return null;
  try {
    const db = await openMemoDb();
    const record = await idbRequest(db.transaction(MEMO_DB_STORE, "readonly").objectStore(MEMO_DB_STORE).get(id));
    if (record?.payload) return record.payload;
  } catch {
    // Fall back to localStorage below.
  }
  try {
    const raw = localStorage.getItem(`${MEMO_STORAGE_KEY}:${id}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function openMemoDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB is not available"));
      return;
    }
    const request = indexedDB.open(MEMO_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(MEMO_DB_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open memo storage"));
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Memo storage request failed"));
  });
}

function memoPayloadIdFromHash() {
  const [, id] = window.location.hash.match(/^#diff-memo\/(.+)$/) ?? [];
  return id ? decodeURIComponent(id) : null;
}

function externalResultIdFromLocation() {
  return new URLSearchParams(window.location.search).get("result_id");
}

function markdownPathFromLocation() {
  const params = new URLSearchParams(window.location.search);
  return params.get("markdown_path") || params.get("markdown_file") || "";
}

function externalFileData(side, result) {
  const filename = side === "A" ? result.filename_a : result.filename_b;
  const page = side === "A" ? result.page_a : result.page_b;
  return {
    file: { name: filename || `API File ${side}` },
    metadata: {
      format: extensionForFilename(filename),
      page_count: Math.max(1, Number(page ?? 0) + 1),
      pages: [
        {
          index: Number(page ?? 0),
          width: result.width,
          height: result.height,
          warnings: [],
        },
      ],
      warnings: [],
    },
    external: true,
  };
}

function extensionForFilename(filename) {
  const extension = String(filename || "").split(".").pop()?.toLowerCase();
  return extension && extension !== filename ? extension : "png";
}

function isTypingTarget(target) {
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName) || target?.isContentEditable;
}

function normalizeLineEndings(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizeStickyNotes(stickies) {
  if (!Array.isArray(stickies)) return [];
  return stickies
    .filter((sticky) => sticky && typeof sticky === "object")
    .map((sticky, index) => ({
      id: sticky.id ? String(sticky.id) : `recovered-sticky-${index}`,
      text: typeof sticky.text === "string" ? sticky.text : STICKY_DEFAULTS.text,
      x: Number.isFinite(Number(sticky.x)) ? clamp(Number(sticky.x), 0, 90) : STICKY_DEFAULTS.x,
      y: Number.isFinite(Number(sticky.y)) ? clamp(Number(sticky.y), 0, 90) : STICKY_DEFAULTS.y,
      width: Number.isFinite(Number(sticky.width)) ? clamp(Number(sticky.width), 120, 420) : STICKY_DEFAULTS.width,
      height: Number.isFinite(Number(sticky.height)) ? clamp(Number(sticky.height), 64, 320) : STICKY_DEFAULTS.height,
      fontSize: Number.isFinite(Number(sticky.fontSize)) ? clamp(Number(sticky.fontSize), 12, 36) : STICKY_DEFAULTS.fontSize,
    }));
}

function calculateStickyAutoHeight(sticky, text) {
  const fontSize = Number(sticky.fontSize) || STICKY_DEFAULTS.fontSize;
  const width = Number(sticky.width) || STICKY_DEFAULTS.width;
  const usableCharacters = Math.max(1, Math.floor((width - 24) / (fontSize * 0.62)));
  const rows = String(text || " ").split("\n").reduce((total, line) => (
    total + Math.max(1, Math.ceil(Array.from(line || " ").length / usableCharacters))
  ), 0);
  return clamp(Math.ceil(38 + rows * fontSize * 1.45), 64, 320);
}

function normalizeMemoNotes(notes) {
  if (!Array.isArray(notes)) return [];
  return notes
    .filter((note) => note && typeof note === "object")
    .map((note, index) => {
      const number = Number.isFinite(Number(note.number)) ? Math.max(1, Math.round(Number(note.number))) : index + 1;
      const legacyColorIndex = (number - 1) % MEMO_COLORS.length;
      return {
        id: note.id ? String(note.id) : `recovered-note-${index}`,
        number,
        colorIndex: Number.isFinite(Number(note.colorIndex))
          ? clamp(Math.round(Number(note.colorIndex)), 0, MEMO_COLORS.length - 1)
          : legacyColorIndex,
        text: typeof note.text === "string" ? note.text : MEMO_DEFAULTS.text,
        changeType: MEMO_CHANGE_TYPES.some((type) => type.id === note.changeType) ? note.changeType : MEMO_DEFAULTS.changeType,
        x: Number.isFinite(Number(note.x)) ? clamp(Number(note.x), 0, 88) : 42,
        y: Number.isFinite(Number(note.y)) ? clamp(Number(note.y), 0, 82) : 12,
        opacity: Number.isFinite(Number(note.opacity)) ? clamp(Number(note.opacity), 20, 100) : MEMO_DEFAULTS.opacity,
        fontSize: Number.isFinite(Number(note.fontSize)) ? clamp(Number(note.fontSize), 12, 48) : MEMO_DEFAULTS.fontSize,
        width: Number.isFinite(Number(note.width)) ? clamp(Number(note.width), 100, 520) : MEMO_DEFAULTS.width,
        height: Number.isFinite(Number(note.height)) ? clamp(Number(note.height), 44, 320) : MEMO_DEFAULTS.height,
        autoSize: typeof note.autoSize === "boolean" ? note.autoSize : MEMO_DEFAULTS.autoSize,
        leaderX: Number.isFinite(Number(note.leaderX)) ? clamp(Number(note.leaderX), -420, 620) : MEMO_DEFAULTS.leaderX,
        leaderY: Number.isFinite(Number(note.leaderY)) ? clamp(Number(note.leaderY), -240, 520) : MEMO_DEFAULTS.leaderY,
        leaderEndX: Number.isFinite(Number(note.leaderEndX)) ? clamp(Number(note.leaderEndX), -420, 620) : MEMO_DEFAULTS.leaderEndX,
        leaderEndY: Number.isFinite(Number(note.leaderEndY)) ? clamp(Number(note.leaderEndY), -240, 520) : MEMO_DEFAULTS.leaderEndY,
        extraLeaders: normalizeExtraMemoLeaders(note.extraLeaders),
        annotations: normalizeMemoAnnotations(note.annotations),
      };
    });
}

function normalizeMemoAnnotations(annotations) {
  if (!Array.isArray(annotations)) return [];
  return annotations
    .filter((annotation) => annotation && typeof annotation === "object")
    .map((annotation, index) => {
      const type = MEMO_ANNOTATION_TYPES.some((item) => item.id === annotation.type) ? annotation.type : "rectangle";
      const x = clamp(Number(annotation.x) || 0, 0, 99);
      const y = clamp(Number(annotation.y) || 0, 0, 99);
      const minimumHeight = type === "highlight" ? 0.05 : 0.4;
      return {
        id: annotation.id ? String(annotation.id) : `recovered-annotation-${index}`,
        type,
        x,
        y,
        width: clamp(Number(annotation.width) || 1, 0.4, 100 - x),
        height: clamp(Number(annotation.height) || minimumHeight, minimumHeight, 100 - y),
        opacity: clamp(Number(annotation.opacity) || (type === "highlight" ? 28 : 82), 10, 100),
        strokeWidth: clamp(Number(annotation.strokeWidth) || 4, 1, 12),
        arrowHeadSize: clamp(Number(annotation.arrowHeadSize) || 16, 6, 32),
        reverseX: Boolean(annotation.reverseX),
        reverseY: Boolean(annotation.reverseY),
      };
    });
}

function memoHistorySnapshot(notes, stickies) {
  return {
    notes: normalizeMemoNotes(notes),
    stickies: normalizeStickyNotes(stickies),
  };
}

function cloneMemoHistorySnapshot(snapshot) {
  return JSON.parse(JSON.stringify(snapshot));
}

function memoHistorySnapshotEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function memoArrowEndpoints(annotation) {
  return {
    start: {
      x: annotation.x + (annotation.reverseX ? annotation.width : 0),
      y: annotation.y + (annotation.reverseY ? annotation.height : 0),
    },
    end: {
      x: annotation.x + (annotation.reverseX ? 0 : annotation.width),
      y: annotation.y + (annotation.reverseY ? 0 : annotation.height),
    },
  };
}

function arrowAnnotationFromEndpoints(rawStart, rawEnd) {
  const start = { x: clamp(rawStart.x, 0, 100), y: clamp(rawStart.y, 0, 100) };
  const end = { x: clamp(rawEnd.x, 0, 100), y: clamp(rawEnd.y, 0, 100) };
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x,
    y,
    width: clamp(Math.abs(end.x - start.x), 0.4, 100 - x),
    height: clamp(Math.abs(end.y - start.y), 0.4, 100 - y),
    reverseX: start.x > end.x,
    reverseY: start.y > end.y,
  };
}

function updateMemoAnnotation(note, noteId, annotationId, fields) {
  if (note.id !== noteId) return note;
  return {
    ...note,
    annotations: note.annotations.map((annotation) => (
      annotation.id === annotationId ? { ...annotation, ...fields } : annotation
    )),
  };
}

function stagePercentPoint(event, rect) {
  return {
    x: clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100),
    y: clamp(((event.clientY - rect.top) / rect.height) * 100, 0, 100),
  };
}

function memoChangeTypeLabel(value) {
  return MEMO_CHANGE_TYPES.find((type) => type.id === value)?.label ?? "変更";
}

function memoAnnotationTypeLabel(value) {
  return MEMO_ANNOTATION_TYPES.find((type) => type.id === value)?.label ?? "図形";
}

function nextMemoNumber(notes) {
  return normalizeMemoNotes(notes).reduce((max, note) => Math.max(max, note.number), 0) + 1;
}

function nextMemoColorIndex(notes) {
  const normalized = normalizeMemoNotes(notes);
  const used = new Set(normalized.map((note) => note.colorIndex));
  const available = MEMO_COLORS.findIndex((_, index) => !used.has(index));
  return available >= 0 ? available : normalized.length % MEMO_COLORS.length;
}

function memoColor(note) {
  const fallback = Number.isFinite(Number(note?.number)) ? (Math.max(1, Number(note.number)) - 1) % MEMO_COLORS.length : 0;
  const colorIndex = Number.isFinite(Number(note?.colorIndex))
    ? clamp(Math.round(Number(note.colorIndex)), 0, MEMO_COLORS.length - 1)
    : fallback;
  return MEMO_COLORS[colorIndex];
}

function normalizeExtraMemoLeaders(leaders) {
  if (!Array.isArray(leaders)) return [];
  return leaders
    .filter((leader) => leader && typeof leader === "object")
    .map((leader, index) => ({
      id: leader.id ? String(leader.id) : `recovered-line-${index}`,
      leaderX: Number.isFinite(Number(leader.leaderX)) ? clamp(Number(leader.leaderX), -420, 620) : MEMO_EXTRA_LEADER_DEFAULT.leaderX,
      leaderY: Number.isFinite(Number(leader.leaderY)) ? clamp(Number(leader.leaderY), -240, 520) : MEMO_EXTRA_LEADER_DEFAULT.leaderY,
      leaderEndX: Number.isFinite(Number(leader.leaderEndX)) ? clamp(Number(leader.leaderEndX), -420, 620) : MEMO_EXTRA_LEADER_DEFAULT.leaderEndX,
      leaderEndY: Number.isFinite(Number(leader.leaderEndY)) ? clamp(Number(leader.leaderEndY), -240, 520) : MEMO_EXTRA_LEADER_DEFAULT.leaderEndY,
    }));
}

function memoBoxStyle(note) {
  const size = memoSize(note);
  return {
    width: `${size.width}px`,
    height: `${size.height}px`,
  };
}

function memoSize(note) {
  return note.autoSize ? calculateMemoAutoSize(note) : { width: note.width, height: note.height };
}

function memoLeaderStart(note) {
  return snapMemoLeaderPoint({ x: note.leaderX, y: note.leaderY }, memoSize(note));
}

function memoNoteLeaders(note) {
  const size = memoSize(note);
  return [
    {
      id: "primary",
      start: snapMemoLeaderPoint({ x: note.leaderX, y: note.leaderY }, size),
      endX: note.leaderEndX,
      endY: note.leaderEndY,
    },
    ...note.extraLeaders.map((leader) => ({
      id: leader.id,
      start: snapMemoLeaderPoint({ x: leader.leaderX, y: leader.leaderY }, size),
      endX: leader.leaderEndX,
      endY: leader.leaderEndY,
    })),
  ];
}

function memoLeaderHandleStyle(point, size) {
  const offset = 7;
  let x = point.x;
  let y = point.y;
  if (point.x <= 0) x -= offset;
  else if (point.x >= size.width) x += offset;
  if (point.y <= 0) y -= offset;
  else if (point.y >= size.height) y += offset;
  return { left: `${x}px`, top: `${y}px` };
}

function updateMemoLeader(note, noteId, lineId, point, points) {
  if (note.id !== noteId) return note;
  const fields = point === "end"
    ? { leaderEndX: points.end.x, leaderEndY: points.end.y }
    : { leaderX: points.start.x, leaderY: points.start.y };
  if (lineId === "primary") return { ...note, ...fields };
  return {
    ...note,
    extraLeaders: note.extraLeaders.map((leader) => (leader.id === lineId ? { ...leader, ...fields } : leader)),
  };
}

function nextExtraLeader(index) {
  const offset = index * 28;
  return {
    ...MEMO_EXTRA_LEADER_DEFAULT,
    leaderY: clamp(MEMO_EXTRA_LEADER_DEFAULT.leaderY + offset, -240, 520),
    leaderEndY: clamp(MEMO_EXTRA_LEADER_DEFAULT.leaderEndY + offset, -240, 520),
  };
}

function snapMemoLeaderPoint(point, size) {
  const x = clamp(point.x, 0, size.width);
  const y = clamp(point.y, 0, size.height);
  const distances = [
    { edge: "left", value: x },
    { edge: "right", value: size.width - x },
    { edge: "top", value: y },
    { edge: "bottom", value: size.height - y },
  ];
  const nearest = distances.reduce((best, item) => (item.value < best.value ? item : best), distances[0]).edge;
  if (nearest === "left") return { x: 0, y };
  if (nearest === "right") return { x: size.width, y };
  if (nearest === "top") return { x, y: 0 };
  return { x, y: size.height };
}

function calculateMemoAutoSize(note) {
  const lines = String(note.text || MEMO_DEFAULTS.text).split("\n");
  const longestLine = Math.max(...lines.map((line) => Array.from(line || " ").length), 1);
  const width = clamp(Math.round(longestLine * note.fontSize * 0.72 + 24), 100, 420);
  const usableChars = Math.max(1, Math.floor((width - 28) / (note.fontSize * 0.72)));
  const lineCount = lines.reduce((total, line) => total + Math.max(1, Math.ceil(Array.from(line || " ").length / usableChars)), 0);
  const height = clamp(Math.round(lineCount * note.fontSize * 1.18 + 16), 42, 260);
  return { width, height };
}

async function copyImageWithNotes(imageSrc, notes, stageSize = null, stickies = []) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("このブラウザでは画像のクリップボード保存に対応していません");
  }
  const image = await loadImage(imageSrc);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth * CLIPBOARD_IMAGE_SCALE;
  canvas.height = image.naturalHeight * CLIPBOARD_IMAGE_SCALE;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  drawNotes(ctx, notes, canvas.width, canvas.height, stageSize, stickies);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("メモ付き画像を作成できませんでした");
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

async function copySideBySideImageWithNotes(imageASrc, imageBSrc, notes, stageSize = null, stickies = []) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("このブラウザでは画像のクリップボード保存に対応していません");
  }
  const [imageA, imageB] = await Promise.all([loadImage(imageASrc), loadImage(imageBSrc)]);
  const padding = 24;
  const gap = 24;
  const labelHeight = 56;
  const imageTop = padding + labelHeight;
  const scaledPadding = padding * CLIPBOARD_IMAGE_SCALE;
  const scaledGap = gap * CLIPBOARD_IMAGE_SCALE;
  const scaledLabelHeight = labelHeight * CLIPBOARD_IMAGE_SCALE;
  const scaledImageTop = imageTop * CLIPBOARD_IMAGE_SCALE;
  const imageAWidth = imageA.naturalWidth * CLIPBOARD_IMAGE_SCALE;
  const imageAHeight = imageA.naturalHeight * CLIPBOARD_IMAGE_SCALE;
  const imageBWidth = imageB.naturalWidth * CLIPBOARD_IMAGE_SCALE;
  const imageBHeight = imageB.naturalHeight * CLIPBOARD_IMAGE_SCALE;
  const canvas = document.createElement("canvas");
  canvas.width = scaledPadding * 2 + imageAWidth + scaledGap + imageBWidth;
  canvas.height = scaledPadding * 2 + scaledLabelHeight + Math.max(imageAHeight, imageBHeight);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const leftX = scaledPadding;
  const rightX = scaledPadding + imageAWidth + scaledGap;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawCopyPanelLabel(ctx, "A（旧）", leftX, scaledPadding, imageAWidth, scaledLabelHeight);
  drawCopyPanelLabel(ctx, "B（新）", rightX, scaledPadding, imageBWidth, scaledLabelHeight);
  ctx.drawImage(imageA, leftX, scaledImageTop, imageAWidth, imageAHeight);
  ctx.drawImage(imageB, rightX, scaledImageTop, imageBWidth, imageBHeight);
  ctx.save();
  ctx.translate(rightX, scaledImageTop);
  drawNotes(ctx, notes, imageBWidth, imageBHeight, stageSize, stickies);
  ctx.restore();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("左右配置の画像を作成できませんでした");
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

function drawCopyPanelLabel(ctx, label, x, y, width, height) {
  ctx.save();
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = "#cbd5e1";
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, width, height);
  ctx.fillStyle = "#0f172a";
  ctx.font = `700 ${Math.max(24, Math.round(height * 0.43))}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + width / 2, y + height / 2);
  ctx.restore();
}

function drawStickyNotes(ctx, stickies, width, height, stageSize = null) {
  const scale = stageSize?.width ? width / stageSize.width : Math.max(1, Math.min(width, height) / 900);
  stickies.forEach((sticky) => {
    const x = (sticky.x / 100) * width;
    const y = (sticky.y / 100) * height;
    const stickyWidth = sticky.width * scale;
    const stickyHeight = sticky.height * scale;
    ctx.save();
    ctx.fillStyle = "#fef3c7";
    ctx.strokeStyle = "#d6b85b";
    ctx.lineWidth = Math.max(1, scale);
    ctx.fillRect(x, y, stickyWidth, stickyHeight);
    ctx.strokeRect(x, y, stickyWidth, stickyHeight);
    ctx.fillStyle = "#1f2937";
    ctx.font = `700 ${sticky.fontSize * scale}px sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const lines = wrapCanvasText(ctx, sticky.text.trim() || "付箋", stickyWidth - 20 * scale);
    lines.slice(0, Math.max(1, Math.floor((stickyHeight - 16 * scale) / (sticky.fontSize * 1.4 * scale)))).forEach((line, index) => {
      ctx.fillText(line, x + 10 * scale, y + 8 * scale + index * sticky.fontSize * 1.4 * scale, stickyWidth - 20 * scale);
    });
    ctx.restore();
  });
}

function drawNotes(ctx, notes, width, height, stageSize = null, stickies = []) {
  drawStickyNotes(ctx, normalizeStickyNotes(stickies), width, height, stageSize);
  notes.forEach((note) => {
    const text = note.text.trim() || "めも";
    const scale = stageSize?.width ? width / stageSize.width : Math.max(1, Math.min(width, height) / 900);
    const x = (note.x / 100) * width;
    const y = (note.y / 100) * height;
    const noteSize = memoSize(note);
    const leaders = memoNoteLeaders(note);
    const color = memoColor(note);
    drawMemoAnnotations(ctx, note, width, height, color, scale);
    ctx.save();
    ctx.font = `700 ${note.fontSize * scale}px sans-serif`;
    const labelWidth = noteSize.width * scale;
    const lines = wrapCanvasText(ctx, text, labelWidth - 28 * scale);
    const labelHeight = noteSize.height * scale;
    const memoAlpha = note.opacity / 100;
    ctx.globalAlpha = memoAlpha;
    ctx.fillStyle = color.hex;
    ctx.strokeStyle = color.line;
    ctx.lineWidth = 6 * scale;
    ctx.lineCap = "butt";
    leaders.forEach((leader) => {
      ctx.beginPath();
      ctx.moveTo(x + leader.start.x * scale, y + leader.start.y * scale);
      ctx.lineTo(x + leader.endX * scale, y + leader.endY * scale);
      ctx.stroke();
    });
    roundedRect(ctx, x, y, labelWidth, labelHeight, 10 * scale);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    lines.forEach((line, index) => {
      ctx.fillText(line, x + labelWidth / 2, y + 8 * scale + index * note.fontSize * 1.18 * scale, labelWidth - 24 * scale);
    });
    ctx.restore();
  });
}

function drawMemoAnnotations(ctx, note, width, height, color, scale = 1) {
  note.annotations.forEach((annotation) => {
    const x = (annotation.x / 100) * width;
    const y = (annotation.y / 100) * height;
    const annotationWidth = (annotation.width / 100) * width;
    const annotationHeight = (annotation.height / 100) * height;
    const lineWidth = Math.max(3, Math.min(width, height) / 260);
    ctx.save();
    ctx.globalAlpha = annotation.opacity / 100;
    ctx.strokeStyle = color.line;
    ctx.fillStyle = color.hex;
    ctx.lineWidth = lineWidth;
    if (annotation.type === "highlight") {
      ctx.fillRect(x, y, annotationWidth, annotationHeight);
    } else if (annotation.type === "arrow") {
      const arrowLineWidth = Math.max(1, annotation.strokeWidth * scale);
      const startX = x + (annotation.reverseX ? annotationWidth : 0);
      const startY = y + (annotation.reverseY ? annotationHeight : 0);
      const endX = x + (annotation.reverseX ? 0 : annotationWidth);
      const endY = y + (annotation.reverseY ? 0 : annotationHeight);
      const angle = Math.atan2(endY - startY, endX - startX);
      const arrowSize = annotation.arrowHeadSize * scale;
      ctx.lineWidth = arrowLineWidth;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(endX, endY);
      ctx.lineTo(endX - arrowSize * Math.cos(angle - Math.PI / 6), endY - arrowSize * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(endX - arrowSize * Math.cos(angle + Math.PI / 6), endY - arrowSize * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fill();
    } else if (annotation.type === "ellipse") {
      ctx.beginPath();
      ctx.ellipse(x + annotationWidth / 2, y + annotationHeight / 2, annotationWidth / 2, annotationHeight / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (annotation.type === "cloud") {
      ctx.lineWidth = lineWidth * 1.8;
      ctx.lineCap = "round";
      ctx.setLineDash([1, lineWidth * 2.5]);
      roundedRect(ctx, x, y, annotationWidth, annotationHeight, Math.min(18, annotationWidth / 5, annotationHeight / 5));
      ctx.stroke();
    } else {
      ctx.strokeRect(x, y, annotationWidth, annotationHeight);
    }
    ctx.restore();
  });
}

function wrapCanvasText(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const char of Array.from(paragraph || " ")) {
      const candidate = `${line}${char}`;
      if (line && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = char;
      } else {
        line = candidate;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("画像を読み込めませんでした"));
    image.src = src;
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function Root() {
  const [route, setRoute] = useState({ hash: window.location.hash, pathname: window.location.pathname });
  useEffect(() => {
    const updateRoute = () => setRoute({ hash: window.location.hash, pathname: window.location.pathname });
    const originalPushState = window.history.pushState;
    const originalReplaceState = window.history.replaceState;
    window.history.pushState = function pushState(...args) {
      originalPushState.apply(this, args);
      updateRoute();
    };
    window.history.replaceState = function replaceState(...args) {
      originalReplaceState.apply(this, args);
      updateRoute();
    };
    const onHashChange = updateRoute;
    const onPopState = updateRoute;
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("popstate", onPopState);
    return () => {
      window.history.pushState = originalPushState;
      window.history.replaceState = originalReplaceState;
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("popstate", onPopState);
    };
  }, []);
  if (route.pathname === "/api-guide") return <ApiGuideApp />;
  return route.hash.startsWith("#diff-memo") ? <MemoDiffApp /> : <App />;
}

createRoot(document.getElementById("root")).render(<Root />);
