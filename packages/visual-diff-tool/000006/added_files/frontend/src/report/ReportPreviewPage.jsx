/**
 * HTML出力プレビュー画面（カード順・サイズ、画像の位置・倍率・出力領域の調整、テキスト差分行の1行復元）。
 */
import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, GripVertical, HelpCircle, RotateCcw } from "lucide-react";
import { ShortcutHelp, useShortcutHelp } from "../components/ShortcutHelp.jsx";
import { toDataUri } from "../lib/files.js";
import { openStoredMemoTab } from "../lib/memoStore.js";
import { clamp } from "../lib/util.js";
import { renderImageWithNotesDataUri } from "../memo/memoCanvas.js";
import { memoChangeTypeLabel, normalizeMemoNotes, normalizeStickyNotes } from "../memo/memoModel.js";
import {
  defaultMemoReportView,
  effectiveMemoStageSize,
  normalizeReportCrop,
  normalizeReportOptions,
  normalizeReportView,
  reportCropScreenStyle,
  reportViewportGeometry,
  reportVisibleCrop,
} from "./reportGeometry.js";

export function ReportPreviewPage({ entries, busy, onClose, onChange, onRevertLine, onExport, error }) {
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
                <div><strong>{index + 1}. {entry.file.display_path ?? entry.file.path}</strong><small>{entry.file.kind === "text" ? "テキスト差分" : "画像差分"}</small></div>
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
                  filePath={entry.file.display_path ?? entry.file.path}
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
