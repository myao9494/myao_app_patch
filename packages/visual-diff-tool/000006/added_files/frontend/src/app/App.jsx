/**
 * メイン画面（ファイル差分・git差分・3D差分のタブ）。
 * ファイル差分: 画像A/Bを選択して /api/diff で比較し、しきい値の変更は /api/rediff で再計算する。
 * git差分: 変更ファイルを順に表示し、画像は /api/git/diff、テキストは /api/git/item で左右差分を取得する。
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  FolderGit2,
  Loader2,
  ScanSearch,
  X,
} from "lucide-react";
import { AppHeader } from "../components/AppHeader.jsx";
import { DiffInspector } from "../components/DiffInspector.jsx";
import { ImagePane } from "../components/ImagePane.jsx";
import { useAppSettings } from "../components/SettingsMenu.jsx";
import { ShortcutHelp, useShortcutHelp } from "../components/ShortcutHelp.jsx";
import { SourceCard } from "../components/SourceCard.jsx";
import { VIEWS, ViewerToolbar } from "../components/ViewerToolbar.jsx";
import { changeTypeLabel } from "../git/gitLabels.js";
import { GitSidebar } from "../git/GitSidebar.jsx";
import { TextDiffView } from "../git/TextDiffView.jsx";
import { useGitTextEditor } from "../git/useGitTextEditor.js";
import { getJson, postForm, postJson } from "../lib/api.js";
import { downloadTextFile, imageFileFromClipboard, toDataUri } from "../lib/files.js";
import { externalFileData, externalResultIdFromLocation, markdownPathFromLocation } from "../lib/location.js";
import {
  gitImageMemoId,
  gitMemoKey,
  openDiffMemoTab,
  readMemoPayload,
  storeMemoPayload,
} from "../lib/memoStore.js";
import {
  GIT_FOLDER_HISTORY_STORAGE_KEY,
  GIT_TEXT_MEMO_STORAGE_KEY,
  loadGitFolderHistory,
  loadGitTextMemos,
  loadLastGitFolder,
  persistLocalStorage,
} from "../lib/storage.js";
import { isTypingTarget, normalizeLineEndings } from "../lib/util.js";
import { normalizeReportOptions } from "../report/reportGeometry.js";
import { ReportPreviewPage } from "../report/ReportPreviewPage.jsx";
import { collectReportEntries } from "../report/reportEntries.js";
import { buildStandaloneGitReport, gitReportFilename } from "../report/standaloneReport.js";

const ThreeDiffViewer = React.lazy(() =>
  import("../three-diff/ThreeDiffViewer.jsx").then((m) => ({ default: m.ThreeDiffViewer }))
);

const EXPORT_FETCH_CONCURRENCY = Math.max(2, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2)));

const TAB_TOGGLE_VIEWS = ["aligned", "overlay"];

const INSPECTOR_OPEN_STORAGE_KEY = "visual-diff-inspector-open";
const ACTIVE_TAB_STORAGE_KEY = "visual-diff-active-tab";

// 前回開いていたモード（ファイル差分 / Git差分 / 3D差分）で開く。URLで指定された場合はそちらを優先する。
function loadActiveTab() {
  try {
    const stored = JSON.parse(localStorage.getItem(ACTIVE_TAB_STORAGE_KEY) || "null");
    return ["files", "git", "3d"].includes(stored) ? stored : "files";
  } catch {
    return "files";
  }
}

// 保存された設定がなければ、狭い画面（右パネルが画像に重なる幅）では閉じた状態で始める
function loadInspectorOpen() {
  try {
    const stored = localStorage.getItem(INSPECTOR_OPEN_STORAGE_KEY);
    if (stored !== null) return stored !== "false";
  } catch {
    // localStorage が使えない場合は画面幅で決める
  }
  return window.innerWidth > 900;
}

function sameRect(a, b) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function App() {
  const [helpOpen, setHelpOpen] = useShortcutHelp();
  const settings = useAppSettings();
  const { textExtensions, displayScale, obsidianReportFolder } = settings;
  const [activeTab, setActiveTab] = useState(loadActiveTab);
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
  const [focusedRect, setFocusedRect] = useState(null);
  const [pickingAnchor, setPickingAnchor] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(loadInspectorOpen);
  const [reportPreview, setReportPreview] = useState(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [gitError, setGitError] = useState("");
  const requestIdRef = useRef(0);
  const gitRequestIdRef = useRef(0);
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
    if (file.kind === "3d") {
      return [{ file, mode: "3d" }];
    }
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
  const git3dMode = activeTab === "git" && (currentGitFile?.kind === "3d" || currentGitView === "3d");
  const currentTextMemoKey = currentGitFile && gitInfo ? gitMemoKey(gitInfo.repo_root, currentGitFile.path) : "";
  const currentTextMemo = currentTextMemoKey ? gitTextMemos[currentTextMemoKey] ?? "" : "";
  const textEditor = useGitTextEditor({
    enabled: gitTextMode,
    file: currentGitFile,
    info: gitInfo,
    folder: gitFolder,
    textExtensions,
    item: gitItem,
    setItem: setGitItem,
    onError: setGitError,
    onNotice: setExportNotice,
  });
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
    : activeTab === "git" ? "変更後（作業ツリー）" : "B 比較対象";

  function invalidateComparison() {
    requestIdRef.current += 1;
    setResult(null);
    setBusy(false);
  }

  async function loadFile(side, file, attachment = null) {
    setError("");
    invalidateComparison();
    if (side === "left") {
      setAnchorRegion(null);
      setPickingAnchor(false);
    }
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
      setPickingAnchor(false);
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

  // ドロップ領域の外にファイルを落としても、ブラウザがそのファイルを開いて画面を離れないようにする
  useEffect(() => {
    const preventFileNavigation = (event) => {
      if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
    return () => {
      window.removeEventListener("dragover", preventFileNavigation);
      window.removeEventListener("drop", preventFileNavigation);
    };
  }, []);

  // ファイル差分では、どこで Ctrl/Cmd+V しても選択中の側（A / B）へ画像を貼り付ける
  useEffect(() => {
    if (activeTab !== "files") return undefined;
    const pasteAnywhere = (event) => {
      if (event.defaultPrevented || isTypingTarget(event.target)) return;
      pasteImage(activeSide, event);
    };
    window.addEventListener("paste", pasteAnywhere);
    return () => window.removeEventListener("paste", pasteAnywhere);
  }, [activeTab, activeSide]);

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

  // 結果が変わったら（再比較・しきい値変更・ファイル切り替え）、強調中の変更箇所は解除する
  useEffect(() => {
    setFocusedRect(null);
  }, [activeResult]);

  useEffect(() => {
    function handleViewerKeys(event) {
      if (activeTab === "3d" || gitTextMode || isTypingTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      const viewByKey = VIEWS.find((item) => item.key === event.key);
      const rects = activeResult?.diff_rects ?? [];
      if (viewByKey && activeResult) {
        event.preventDefault();
        setView(viewByKey.id);
      } else if ((event.key === "]" || event.key === "[") && rects.length) {
        // 変更箇所を順に移動する（] = 次、[ = 前）
        event.preventDefault();
        const current = focusedRect ? rects.findIndex((rect) => sameRect(rect, focusedRect)) : -1;
        const next = event.key === "]" ? (current + 1) % rects.length : (current <= 0 ? rects.length - 1 : current - 1);
        focusDiffRect(rects[next]);
      } else if (event.key === "Escape" && focusedRect) {
        setFocusedRect(null);
      } else if (event.key.toLowerCase() === "i") {
        event.preventDefault();
        setInspectorOpen((open) => !open);
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        fitWholeImage();
      } else if (event.key.toLowerCase() === "w") {
        event.preventDefault();
        setZoom(1);
      }
    }
    window.addEventListener("keydown", handleViewerKeys);
    return () => window.removeEventListener("keydown", handleViewerKeys);
  }, [activeTab, gitTextMode, activeResult, focusedRect, zoom, view]);

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
    persistLocalStorage(INSPECTOR_OPEN_STORAGE_KEY, inspectorOpen);
  }, [inspectorOpen]);

  useEffect(() => {
    persistLocalStorage(ACTIVE_TAB_STORAGE_KEY, activeTab);
  }, [activeTab]);

  // 完了の通知は数秒で自動的に消す（エラーは操作し直すまで残す）
  useEffect(() => {
    if (!exportNotice) return undefined;
    const timer = window.setTimeout(() => setExportNotice(""), 5000);
    return () => window.clearTimeout(timer);
  }, [exportNotice]);

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

  // 画像全体がペインに収まる倍率（倍率1 = ペインの幅に合わせる）
  function fitWholeImage() {
    const canvas = canvasRefs.current.left ?? canvasRefs.current.right;
    const image = canvas?.querySelector("img");
    if (!canvas || !image?.naturalWidth) {
      setZoom(1);
      return;
    }
    const heightRatio = canvas.clientHeight / canvas.clientWidth;
    const imageRatio = image.naturalHeight / image.naturalWidth;
    setZoom(Math.max(0.25, Math.min(1, heightRatio / imageRatio)));
  }

  // 変更箇所を強調し、左右の画像をその位置へスクロールする（小さな箇所は見やすい倍率まで拡大）
  function focusDiffRect(rect) {
    if (!activeResult || !rect) return;
    setFocusedRect(rect);
    if (view === "original") setView("overlay");
    const imageWidth = activeResult.width || 1;
    const imageHeight = activeResult.height || 1;
    const nextZoom = Math.max(zoom, Math.min(3, (imageWidth * 0.25) / Math.max(1, rect.width)));
    setZoom(nextZoom);
    window.requestAnimationFrame(() => {
      ["left", "right"].forEach((side) => {
        const canvas = canvasRefs.current[side];
        if (!canvas) return;
        const scale = (canvas.clientWidth * nextZoom) / imageWidth;
        canvas.scrollTo({
          left: (rect.x + rect.width / 2) * scale - canvas.clientWidth / 2,
          top: Math.min(imageHeight, rect.y + rect.height / 2) * scale - canvas.clientHeight / 2,
          behavior: "smooth",
        });
      });
    });
  }

  function handleImageWheel(event) {
    if (!event.ctrlKey && !event.metaKey && !event.altKey) return;
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    setZoom((value) => Math.max(0.25, Math.min(3, value + direction * 0.05)));
  }

  async function saveObsidianFolderSetting() {
    try {
      await settings.saveObsidianSettings();
      setGitError("");
    } catch (err) {
      setGitError(`Obsidianフォルダー設定を保存できませんでした: ${err.message}`);
    }
  }

  // フォルダー入力の変更・履歴からの選択時は、表示中の結果と進行中の読み込みをすべて破棄する。
  function changeGitFolder(value) {
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
    setPickingAnchor(false);
    invalidateComparison();
  }

  // 基準領域の候補枠は、選ぶときだけ A の画像上に表示する（常に出すと画像が見づらいため）
  function startPickingAnchor() {
    if (activeResult) setView("original");
    setPickingAnchor(true);
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

  const showFilesViewer = activeTab === "files";
  const showGitImageViewer = activeTab === "git" && !gitTextMode && !git3dMode;
  const filesReady = Boolean(left || right);
  const inspectorAvailable = (showFilesViewer && filesReady) || (gitImageMode && Boolean(activeResult));
  const showInspector = inspectorAvailable && inspectorOpen;
  const currentError = activeTab === "git" ? gitError : error;
  const leftPaneImage = leftImage;
  const rightPaneImage = activeResult ? rightImage : activeTab === "git" ? (gitItem?.image_current ? toDataUri(gitItem.image_current) : null) : rightPreviewImage;
  const viewerHasImage = Boolean(leftPaneImage || rightPaneImage);
  const gitPosition = currentGitTarget ? `${gitIndex + 1} / ${gitTargets.length}` : "";

  return (
    <main className={`app-shell ${gitTextMode ? "text-diff-mode" : ""}`} style={{ zoom: displayScale, height: `${100 / displayScale}vh` }}>
      <AppHeader
        activeTab={activeTab}
        onChangeTab={setActiveTab}
        settings={settings}
        onExtensionsApplied={() => {
          setGitInfo(null);
          setGitResult(null);
          setGitItem(null);
        }}
        onSaveObsidianSettings={saveObsidianFolderSetting}
        onOpenHelp={() => setHelpOpen(true)}
      />

      {activeTab === "3d" ? (
        <React.Suspense fallback={<div className="loading-panel"><Loader2 className="spin" size={20} />3D差分ビューアーを読み込み中…</div>}>
          <ThreeDiffViewer />
        </React.Suspense>
      ) : (
        <div className={`workspace ${activeTab === "git" ? "has-sidebar" : ""} ${showInspector ? "has-inspector" : ""}`}>
          {activeTab === "git" && (
            <GitSidebar
              folder={gitFolder}
              folderHistory={gitFolderHistory}
              onFolderChange={changeGitFolder}
              onLoad={loadGitImages}
              info={gitInfo}
              files={comparableGitFiles}
              targets={gitTargets}
              currentFile={currentGitFile}
              currentView={currentGitView}
              busy={gitBusy}
              onSelectTarget={(index) => index >= 0 && selectGitIndex(index)}
              excludedPaths={gitExportExcluded}
              onToggleExport={(path, included) => setGitExportExcluded((paths) => included
                ? paths.filter((item) => item !== path)
                : [...new Set([...paths, path])])}
              onIncludeAll={() => setGitExportExcluded([])}
              onExcludeAll={() => setGitExportExcluded(comparableGitFiles.map((file) => file.path))}
              onExport={exportGitHtml}
              exportBusy={exportBusy}
            />
          )}

          <section className="main-column">
            {activeTab === "files" && (
              <div className="source-bar">
                <SourceCard
                  label="A"
                  role="基準（変更前）"
                  side="left"
                  active={activeSide === "left"}
                  data={left}
                  page={pageA}
                  setPage={(page) => selectPage("left", page)}
                  onActivate={setActiveSide}
                  onPasteImage={pasteImage}
                  onFile={(file) => loadFile("left", file)}
                />
                <ArrowRight className="source-arrow" size={18} aria-hidden="true" />
                <SourceCard
                  label="B"
                  role="比較対象（変更後）"
                  side="right"
                  active={activeSide === "right"}
                  data={right}
                  page={pageB}
                  setPage={(page) => selectPage("right", page)}
                  onActivate={setActiveSide}
                  onPasteImage={pasteImage}
                  onFile={(file) => loadFile("right", file)}
                />
                <button type="button" className="btn btn-primary btn-lg compare-button" disabled={!canCompare || busy} onClick={() => compare()}>
                  {busy ? <Loader2 className="spin" size={18} /> : <ScanSearch size={18} />}
                  {result ? "再比較" : "比較"}
                </button>
              </div>
            )}

            {activeTab === "git" && currentGitFile && (
              <div className="git-file-header">
                <div className="git-file-title">
                  <strong title={currentGitFile.path}>{currentGitFile.path}</strong>
                  {currentGitView === "excalidraw" && <span className="badge">Excalidraw図</span>}
                  <span className={`badge ${currentGitFile.change_type}`}>{changeTypeLabel(currentGitFile.change_type)}</span>
                  {currentGitFile.head_path !== currentGitFile.path && <span className="git-file-from">← {currentGitFile.head_path}</span>}
                </div>
                <div className="git-file-nav">
                  <span>{gitPosition}</span>
                  <button type="button" className="btn btn-ghost btn-icon" title="前のファイル（←）" aria-label="前のファイル" disabled={gitBusy} onClick={() => selectGitIndex(gitIndex - 1)}>
                    <ChevronLeft size={18} />
                  </button>
                  <button type="button" className="btn btn-ghost btn-icon" title="次のファイル（→）" aria-label="次のファイル" disabled={gitBusy} onClick={() => selectGitIndex(gitIndex + 1)}>
                    <ChevronRight size={18} />
                  </button>
                </div>
              </div>
            )}

            {exportNotice && <div className="banner success" role="status">{exportNotice}<button type="button" aria-label="閉じる" onClick={() => setExportNotice("")}><X size={14} /></button></div>}
            {currentError && <div className="banner error" role="alert"><AlertTriangle size={16} />{currentError}</div>}

            {gitTextMode ? (
              <TextDiffView
                file={currentGitFile}
                item={gitItem}
                memo={currentTextMemo}
                busy={gitBusy}
                previewBusy={textEditor.busy}
                dirty={textEditor.dirty}
                onEditText={textEditor.editLine}
                onSave={textEditor.save}
                onRevertLine={textEditor.revertLine}
                onMemoChange={(value) => setGitTextMemos((current) => ({ ...current, [currentTextMemoKey]: value }))}
              />
            ) : git3dMode ? (
              <React.Suspense fallback={<div className="loading-panel"><Loader2 className="spin" size={20} />3D差分ビューアーを読み込み中…</div>}>
                <ThreeDiffViewer gitMode={true} gitFile={currentGitFile} gitFolder={gitInfo?.folder || gitFolder} />
              </React.Suspense>
            ) : (showFilesViewer || showGitImageViewer) && (activeTab === "files" || currentGitFile) ? (
              <section className="viewer-area" aria-busy={activeTab === "git" ? gitBusy : busy}>
                {(activeTab === "git" ? gitBusy : busy) && <div className="progress-bar" role="progressbar" aria-label="処理中" />}
                {viewerHasImage && <ViewerToolbar
                  view={view}
                  onViewChange={setView}
                  viewsEnabled={Boolean(activeResult)}
                  zoom={zoom}
                  onZoom={(delta) => setZoom((value) => Math.max(0.25, Math.min(3, value + delta)))}
                  onFitWidth={() => setZoom(1)}
                  onFitAll={fitWholeImage}
                  memoLabel={activeTab === "git" ? "画像メモ" : "差分メモ"}
                  onOpenMemo={viewerHasImage ? (activeTab === "git" ? openGitMemo : () => openDiffMemoTab(result, left, right, setError)) : null}
                  canOpenMemo={activeTab === "git" ? Boolean(gitResult || gitItem?.image_head || gitItem?.image_current) : Boolean(result)}
                  status={(activeTab === "git" ? gitBusy : busy) ? "処理中…" : ""}
                  inspectorOpen={showInspector}
                  onToggleInspector={inspectorAvailable ? () => setInspectorOpen((open) => !open) : null}
                />}
                <div className="viewer">
                  <ImagePane
                    title={activeTab === "git" ? "変更前（HEAD）" : "A 基準"}
                    side="left"
                    active={activeSide === "left"}
                    subtitle={activeTab === "git" ? currentGitFile?.head_path : left?.file?.name}
                    image={leftPaneImage}
                    zoom={zoom}
                    regions={activeTab === "git" || (activeResult && view !== "original") ? [] : pickingAnchor ? left?.regions ?? [] : anchorRegion ? [anchorRegion] : []}
                    selectedRegion={anchorRegion}
                    onSelectRegion={selectAnchorRegion}
                    onActivate={setActiveSide}
                    onPasteImage={pasteImage}
                    onDropFile={activeTab === "files" ? (file) => loadFile("left", file) : undefined}
                    onPickFile={activeTab === "files" ? (file) => loadFile("left", file) : undefined}
                    emptyTitle={activeTab === "git" ? "変更前の画像はありません" : "A：基準になる画像"}
                    emptyHint={activeTab === "git" ? "このファイルは新しく追加されました" : "ファイルをドロップ、またはこの枠をクリックして Ctrl+V で貼り付け"}
                    loading={activeTab === "git" ? gitBusy : busy && !left?.preview}
                    focusRect={activeResult && view !== "original" ? focusedRect : null}
                    onCanvasRef={(element) => registerCanvas("left", element)}
                    onCanvasScroll={(event) => syncCanvasScroll("left", event)}
                    onCanvasWheel={handleImageWheel}
                  />
                  <ImagePane
                    title={rightPaneTitle}
                    side="right"
                    active={activeSide === "right"}
                    subtitle={activeTab === "git" ? currentGitFile?.path : right?.file?.name}
                    image={rightPaneImage}
                    zoom={zoom}
                    regions={[]}
                    selectedRegion={null}
                    onActivate={setActiveSide}
                    onPasteImage={pasteImage}
                    onDropFile={activeTab === "files" ? (file) => loadFile("right", file) : undefined}
                    onPickFile={activeTab === "files" ? (file) => loadFile("right", file) : undefined}
                    emptyTitle={activeTab === "git" ? "変更後の画像はありません" : "B：比較する画像"}
                    emptyHint={activeTab === "git" ? "このファイルは削除されました" : "ファイルをドロップ、またはこの枠をクリックして Ctrl+V で貼り付け"}
                    loading={activeTab === "git" ? gitBusy : false}
                    focusRect={activeResult && view !== "original" ? focusedRect : null}
                    onCanvasRef={(element) => registerCanvas("right", element)}
                    onCanvasScroll={(event) => syncCanvasScroll("right", event)}
                    onCanvasWheel={handleImageWheel}
                  />
                </div>
              </section>
            ) : (
              activeTab === "git" && !gitBusy && (
                <div className="placeholder-panel">
                  <FolderGit2 size={36} strokeWidth={1.4} />
                  <strong>{gitInfo ? "変更されたファイルはありません" : "左のパネルでフォルダーを指定してください"}</strong>
                  <span>{gitInfo ? "HEAD との差分が見つかりませんでした。" : "Gitリポジトリのフォルダー、またはObsidianのMarkdownファイルを指定して読み込みます。"}</span>
                </div>
              )
            )}
          </section>

          {showInspector && (
            <DiffInspector
              result={activeResult}
              threshold={diffThreshold}
              onThresholdChange={setDiffThreshold}
              category={category}
              onCategoryChange={selectCategory}
              anchor={activeTab === "files" && left?.file instanceof File ? {
                selected: anchorRegion,
                count: left?.regions?.length ?? 0,
                picking: pickingAnchor,
                onStartPicking: startPickingAnchor,
                onCancelPicking: () => setPickingAnchor(false),
                onClear: clearAnchorRegion,
              } : null}
              focusedRect={focusedRect}
              onFocusRect={focusDiffRect}
              busy={activeTab === "git" ? gitBusy : busy}
              onClose={() => setInspectorOpen(false)}
            />
          )}
        </div>
      )}
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
        await loadGitFile(nextFiles[0], requestId, info.folder || folder, nextFiles[0].kind === "text" ? "text" : nextFiles[0].kind === "3d" ? "3d" : "image");
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

  async function loadGitFile(file, requestId = gitRequestIdRef.current, folderOverride = gitInfo?.folder || gitFolder, targetMode = file.kind === "text" ? "text" : file.kind === "3d" ? "3d" : "image") {
    if (file.kind === "3d" || targetMode === "3d") {
      setGitItem(null);
      setGitResult(null);
      return;
    }
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
        textEditor.resetHistory(file.path);
      } else {
        setGitItem(nextItem);
        textEditor.resetHistory();
      }
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
    // Markdown内のExcalidraw図は本文テキストのメモと別物なので、メモIDを分けて保存する。
    const id = gitImageMemoId(
      gitInfo.repo_root,
      currentGitView === "excalidraw" ? `${currentGitFile.path}#excalidraw` : currentGitFile.path,
    );
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
      const entries = await collectReportEntries({
        files: exportableGitFiles,
        info: gitInfo,
        folder: gitFolder,
        current: { file: currentGitFile, view: currentGitView, result: gitResult, item: gitItem },
        category,
        diffThreshold,
        textExtensions,
        textMemos: gitTextMemos,
        concurrency: EXPORT_FETCH_CONCURRENCY,
      });
      setReportPreview(entries);
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
        setGitItem((current) => {
          if (!current) return current;
          // 未保存の編集中テキストは上書きしない（表示行と本文の整合を保つ）。保存時はサーバーが
          // base_text を照合し、ファイルが変わっていれば409で拒否するので、編集内容は失われない。
          const dirty = normalizeLineEndings(current.text_current ?? "") !== normalizeLineEndings(current.text_saved ?? "");
          if (dirty || typeof restored.text_current !== "string") return current;
          return { ...current, rows: restored.rows, text_current: restored.text_current, text_saved: restored.text_current };
        });
      }
      setExportNotice(`${entry.file.path} の1行を変更前へ戻しました。`);
    } catch (err) {
      setGitError(`行を戻せませんでした: ${err.message}`);
    } finally {
      setExportBusy(false);
    }
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
