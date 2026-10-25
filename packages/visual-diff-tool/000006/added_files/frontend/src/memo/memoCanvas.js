/**
 * メモ付き画像のCanvas描画（クリップボード保存・HTMLレポート用の画像生成）。
 */
import { loadImage } from "../lib/files.js";
import { defaultMemoReportCrop, normalizeReportCrop, normalizeReportView, reportVisibleCrop } from "../report/reportGeometry.js";
import { memoColor, memoNoteLeaders, memoSize, normalizeStickyNotes } from "./memoModel.js";

const CLIPBOARD_IMAGE_SCALE = 2;

export async function renderImageWithNotesDataUri(imageSrc, notes, stageSize = null, stickies = []) {
  const image = await loadImage(imageSrc);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  drawNotes(ctx, notes, canvas.width, canvas.height, stageSize, stickies);
  return canvas.toDataURL("image/png");
}

export async function renderMemoCropDataUris(imageSrc, notes, stageSize = null, stickies = [], reportOptions = {}) {
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

export async function copyImageWithNotes(imageSrc, notes, stageSize = null, stickies = []) {
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

export async function copySideBySideImageWithNotes(imageASrc, imageBSrc, notes, stageSize = null, stickies = []) {
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
