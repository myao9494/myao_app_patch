/**
 * HTML出力プレビューの画像表示範囲（中心・倍率・カードサイズ）と出力領域（crop）の計算。
 * 値はすべて画像サイズに対する % で保存し、表示サイズが変わっても同じ範囲を指す。
 */
import { clamp } from "../lib/util.js";
import { memoNoteLeaders, memoSize } from "../memo/memoModel.js";

export function normalizeReportCrop(crop) {
  if (!crop || typeof crop !== "object") return null;
  const x = clamp(Number(crop.x) || 0, 0, 98);
  const y = clamp(Number(crop.y) || 0, 0, 98);
  const width = clamp(Number(crop.width) || 0, 2, 100 - x);
  const height = clamp(Number(crop.height) || 0, 2, 100 - y);
  return { x, y, width, height };
}

export function normalizeReportOptions(options) {
  return {
    crops: options?.crops && typeof options.crops === "object" ? options.crops : {},
    views: options?.views && typeof options.views === "object" ? options.views : {},
  };
}

export function canonicalMemoStageSize(stage, memoZoom, memoImageScale = 100) {
  const zoomScale = clamp(Number(memoZoom) || 100, 10, 300) / 100;
  const imageScale = clamp(Number(memoImageScale) || 100, 25, 150) / 100;
  return {
    width: Math.max(1, stage.offsetWidth / zoomScale / imageScale),
    height: Math.max(1, stage.offsetHeight / zoomScale / imageScale),
  };
}

export function effectiveMemoStageSize(imageMemo) {
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

export function normalizeReportView(view, note = null, stageSize = null) {
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

export function defaultMemoReportView(note, stageSize = null) {
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

export function reportViewportGeometry(imageSize, viewportSize, view) {
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

export function reportVisibleCrop(imageSize, viewportSize, view) {
  const geometry = reportViewportGeometry(imageSize, viewportSize, view);
  if (!geometry) return null;
  const left = clamp((-geometry.left / geometry.width) * 100, 0, 100);
  const top = clamp((-geometry.top / geometry.height) * 100, 0, 100);
  const right = clamp(((viewportSize.width - geometry.left) / geometry.width) * 100, 0, 100);
  const bottom = clamp(((viewportSize.height - geometry.top) / geometry.height) * 100, 0, 100);
  return normalizeReportCrop({ x: left, y: top, width: right - left, height: bottom - top });
}

export function reportCropScreenStyle(crop, geometry) {
  return {
    left: `${geometry.left + (crop.x / 100) * geometry.width}px`,
    top: `${geometry.top + (crop.y / 100) * geometry.height}px`,
    width: `${(crop.width / 100) * geometry.width}px`,
    height: `${(crop.height / 100) * geometry.height}px`,
  };
}

export function defaultMemoReportCrop(note, stageSize = null) {
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
