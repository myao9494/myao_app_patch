/**
 * 画像データ（Base64）・クリップボード・ドロップ・ダウンロードに関する処理。
 */

// APIの画像オブジェクトごとに data URI を1回だけ作る。画像は数MBのBase64なので、描画のたびに
// 文字列を組み立てると、Reactが毎回その巨大な文字列どうしを比較することになる。
// 画像オブジェクトは置き換えで更新される（中身を書き換えない）ため、オブジェクト単位のキャッシュで安全。
const dataUriCache = new WeakMap();

export function toDataUri(image) {
  let uri = dataUriCache.get(image);
  if (uri === undefined) {
    uri = `data:${image.mime_type};base64,${image.data}`;
    dataUriCache.set(image, uri);
  }
  return uri;
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("画像を読み込めませんでした"));
    image.src = src;
  });
}

export function imageFileFromClipboard(clipboardData) {
  const items = Array.from(clipboardData?.items ?? []);
  const imageItem = items.find((item) => item.kind === "file" && item.type.startsWith("image/"));
  const blob = imageItem?.getAsFile();
  if (!blob) return null;
  const extension = extensionForMime(blob.type);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return new File([blob], `clipboard-${timestamp}.${extension}`, { type: blob.type || "image/png" });
}

export function firstDroppedFile(dataTransfer) {
  return Array.from(dataTransfer?.files ?? []).find((file) => file.size > 0) ?? null;
}

function extensionForMime(mimeType) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

export function extensionForFilename(filename) {
  const extension = String(filename || "").split(".").pop()?.toLowerCase();
  return extension && extension !== filename ? extension : "png";
}

export function downloadTextFile(content, filename, mimeType) {
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
