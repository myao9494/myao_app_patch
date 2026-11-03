/**
 * 比較画像の表示ペイン（拡大縮小・左右スクロール同期・基準領域候補の表示）。
 * onDragRegion を渡すと、左ドラッグが移動ではなく「位置合わせに使う範囲の囲み」になる。
 * 画像がないときは、ドロップ／クリックで選択／貼り付けを案内する空の状態を表示する。
 * focusRect（画像ピクセル座標）を渡すと、その変更箇所を強調枠で示す。
 */
import React, { useEffect, useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
import { regionFromDrag } from "../lib/anchorRegion.js";
import { firstDroppedFile } from "../lib/files.js";

export function ImagePane({
  title,
  side,
  active,
  subtitle,
  image,
  zoom,
  regions = [],
  selectedRegion,
  onSelectRegion,
  onDragRegion,
  markedRegion = null,
  onActivate,
  onPasteImage,
  onDropFile,
  onCanvasRef,
  onCanvasScroll,
  onCanvasWheel,
  onPickFile,
  emptyTitle,
  emptyHint,
  focusRect = null,
  loading = false,
}) {
  const inputRef = useRef(null);
  const [imageSize, setImageSize] = useState(null);
  const [panning, setPanning] = useState(false);
  const panRef = useRef(null);
  const regionDragRef = useRef(null);
  const [dragRegion, setDragRegion] = useState(null);
  const imageRef = useRef(null);
  const canvasRef = useRef(null);
  const wheelHandlerRef = useRef(onCanvasWheel);
  wheelHandlerRef.current = onCanvasWheel;
  useEffect(() => {
    // Reactの onWheel は preventDefault できず、Ctrl+ホイールでブラウザー自体も拡大されるため直接登録する
    const canvas = canvasRef.current;
    const handleWheel = (event) => wheelHandlerRef.current?.(event);
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, []);
  useEffect(() => {
    // 読み込み済みの画像では load イベントがこの effect より先に来ることがあるため、要素から直接読む
    const element = imageRef.current;
    setImageSize(element?.complete && element.naturalWidth
      ? { width: element.naturalWidth, height: element.naturalHeight }
      : null);
  }, [image]);

  const [dragging, setDragging] = useState(false);

  function imagePoint(event) {
    const element = imageRef.current;
    if (!element?.naturalWidth) return null;
    const rect = element.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * element.naturalWidth,
      y: ((event.clientY - rect.top) / rect.height) * element.naturalHeight,
    };
  }

  function startCanvasPan(event) {
    if (event.button !== 0 && event.button !== 1) return;
    if (onDragRegion && event.button === 0) {
      const start = imagePoint(event);
      // 候補枠が画像全体を覆っていても囲めるよう、枠の上からも始める（動かなければ枠のクリックになる）
      if (start) regionDragRef.current = { pointerId: event.pointerId, start, clientX: event.clientX, clientY: event.clientY, moved: false };
      return;
    }
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
    const drag = regionDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      if (!drag.moved && Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY) < 4) return;
      if (!drag.moved) event.currentTarget.setPointerCapture?.(event.pointerId);
      drag.moved = true;
      event.preventDefault();
      const element = imageRef.current;
      const imageBounds = { width: element.naturalWidth, height: element.naturalHeight };
      setDragRegion(regionFromDrag(drag.start, imagePoint(event), imageBounds));
      return;
    }
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
    const drag = regionDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      regionDragRef.current = null;
      setDragRegion(null);
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!drag.moved || event.type === "pointercancel") return;
      const element = imageRef.current;
      const region = regionFromDrag(drag.start, imagePoint(event), { width: element.naturalWidth, height: element.naturalHeight });
      if (region) onDragRegion?.(region);
      return;
    }
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
        <span className={`pane-dot ${side}`} aria-hidden="true" />
        <strong>{title}</strong>
        {subtitle && <span title={subtitle}>{subtitle}</span>}
      </div>
      <div
        className={`canvas ${panning ? "panning" : ""} ${onDragRegion ? "picking" : ""}`}
        ref={(element) => {
          canvasRef.current = element;
          onCanvasRef?.(element);
        }}
        onScroll={onCanvasScroll}
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
              ref={imageRef}
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
            {imageSize && focusRect && (
              <div className="focus-box" style={regionStyle(focusRect, imageSize)} aria-hidden="true" />
            )}
            {imageSize && markedRegion && !dragRegion && (
              <div className="anchor-mark" style={regionStyle(markedRegion, imageSize)} aria-hidden="true" />
            )}
            {imageSize && dragRegion && (
              <div className="anchor-mark dragging" style={regionStyle(dragRegion, imageSize)} aria-hidden="true" />
            )}
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
          <div className={`empty-state ${dragging ? "dragging" : ""}`}>
            {loading ? (
              <span className="empty-loading" aria-label="読み込み中" />
            ) : (
              <>
                <ImagePlus size={34} strokeWidth={1.5} />
                <strong>{emptyTitle ?? "画像がありません"}</strong>
                {emptyHint && <span>{emptyHint}</span>}
                {onPickFile && (
                  <>
                    <button
                      type="button"
                      className="btn"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        inputRef.current?.click();
                      }}
                    >
                      ファイルを選択
                    </button>
                    <input
                      ref={inputRef}
                      type="file"
                      hidden
                      onChange={(event) => {
                        if (event.target.files?.[0]) {
                          onPickFile(event.target.files[0]);
                          event.target.value = "";
                        }
                      }}
                    />
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </article>
  );
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
