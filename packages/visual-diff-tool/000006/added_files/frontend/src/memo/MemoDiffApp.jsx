/**
 * 差分メモ画面（別タブ）。A（旧）と補正済みB（新）をスライダーで比較し、メモ・引出線・描画・付箋を配置する。
 * 編集内容は自動で memoStore へ保存され、Git差分のHTML出力プレビューからも参照される。
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { SettingsMenu, useAppSettings } from "../components/SettingsMenu.jsx";
import { ShortcutHelp, useShortcutHelp } from "../components/ShortcutHelp.jsx";
import { postJson } from "../lib/api.js";
import { toDataUri } from "../lib/files.js";
import {
  gitImageMemoId,
  memoPayloadIdFromHash,
  readMemoPayload,
  returnToReportPreview,
  storeMemoPayload,
} from "../lib/memoStore.js";
import {
  loadMemoSidebarVisible,
  loadMemoSidebarWidth,
  MEMO_SIDEBAR_VISIBLE_STORAGE_KEY,
  MEMO_SIDEBAR_WIDTH_STORAGE_KEY,
  persistLocalStorage,
} from "../lib/storage.js";
import { clamp, isTypingTarget } from "../lib/util.js";
import { canonicalMemoStageSize } from "../report/reportGeometry.js";
import { copyImageWithNotes, copySideBySideImageWithNotes } from "./memoCanvas.js";
import { MemoNoteEditor, MemoSidebar } from "./MemoSidebar.jsx";
import { MemoAnnotationShape, MemoNoteBox, StickyNote } from "./MemoStageItems.jsx";
import {
  arrowAnnotationFromEndpoints,
  calculateStickyAutoHeight,
  cloneMemoHistorySnapshot,
  MEMO_ANNOTATION_TYPES,
  MEMO_DEFAULTS,
  MEMO_EXTRA_LEADER_DEFAULT,
  memoArrowEndpoints,
  memoHistorySnapshot,
  memoHistorySnapshotEquals,
  memoNoteLeaders,
  memoSize,
  nextExtraLeader,
  nextMemoColorIndex,
  nextMemoNumber,
  normalizeMemoNotes,
  normalizeStickyNotes,
  snapMemoLeaderPoint,
  stagePercentPoint,
  STICKY_DEFAULTS,
  updateMemoAnnotation,
  updateMemoLeader,
} from "./memoModel.js";

export function MemoDiffApp() {
  const [helpOpen, setHelpOpen] = useShortcutHelp();
  const [payload, setPayload] = useState(null);
  const [loadingPayload, setLoadingPayload] = useState(true);
  const settings = useAppSettings();
  const { displayScale } = settings;
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
    persistLocalStorage(MEMO_SIDEBAR_WIDTH_STORAGE_KEY, memoSidebarWidth);
  }, [memoSidebarWidth]);

  useEffect(() => {
    persistLocalStorage(MEMO_SIDEBAR_VISIBLE_STORAGE_KEY, memoSidebarVisible);
  }, [memoSidebarVisible]);

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
    try {
      await settings.saveObsidianSettings();
      setNotice("設定を保存しました");
    } catch (err) {
      setNotice(`設定を保存できませんでした: ${err.message}`);
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
          <label className="control slider-control" title="A（旧）とB（新）の境界の位置。画像上の境界線をドラッグしても動かせます">
            <span>A｜B 境界 {slider}%</span>
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
        <SettingsMenu
          settings={settings}
          className="memo-hamburger-menu"
          onSaveObsidianSettings={saveMemoObsidianSettings}
          onOpenHelp={() => setHelpOpen(true)}
        />
      </header>

      <div
        className={`memo-workspace ${memoSidebarVisible ? "" : "sidebar-hidden"}`}
        style={{ "--memo-sidebar-width": `${memoSidebarWidth}px` }}
      >
        {memoSidebarVisible && (
          <MemoSidebar
            notes={safeNotes}
            selectedNoteId={selectedNoteId}
            annotationTool={annotationTool}
            onAddNote={addNote}
            onAddLeaderLine={addLeaderLine}
            onAddSticky={addStickyNote}
            onSelectTool={selectAnnotationTool}
            onFocusNote={focusMemoNote}
            onNoteContextMenu={openMemoContextMenu}
          />
        )}
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
            <MemoNoteEditor
              note={selectedNote}
              annotation={selectedAnnotation}
              editing={editingNoteId === selectedNote.id}
              onActivateEditing={activateMemoTextEditing}
              onChangeText={updateNote}
              onFinishEditing={finishMemoTextEditing}
              onChangeFields={updateNoteFields}
              onChangeAnnotation={updateSelectedAnnotation}
            />
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
                <StickyNote
                  key={sticky.id}
                  sticky={sticky}
                  onStartDrag={startStickyDrag}
                  onChangeText={updateSticky}
                  onFinishEditing={finishStickyEditing}
                  onDelete={deleteSticky}
                />
              ))}
              {safeNotes.flatMap((note) => note.annotations.map((annotation) => (
                <MemoAnnotationShape
                  key={`${note.id}-${annotation.id}`}
                  note={note}
                  annotation={annotation}
                  selected={selectedNoteId === note.id && selectedAnnotationId === annotation.id}
                  memoZoom={memoZoom}
                  onSelect={(noteId, annotationId) => {
                    setSelectedNoteId(noteId);
                    setSelectedAnnotationId(annotationId);
                  }}
                  onStartTransform={startAnnotationTransform}
                  onStartEndpointDrag={startArrowEndpointDrag}
                />
              )))}
              {safeNotes.map((note) => (
                <MemoNoteBox
                  key={note.id}
                  note={note}
                  selected={selectedNoteId === note.id}
                  editing={editingNoteId === note.id}
                  onStartDrag={startDrag}
                  onActivateEditing={activateMemoTextEditing}
                  onContextMenu={openMemoContextMenu}
                  onSelect={setSelectedNoteId}
                  onStartLeaderDrag={startLeaderDrag}
                  onChangeText={updateNote}
                  onFinishEditing={finishMemoTextEditing}
                  onDelete={deleteNote}
                />
              ))}
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
