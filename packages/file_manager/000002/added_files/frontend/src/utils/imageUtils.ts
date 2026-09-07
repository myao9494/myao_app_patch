/**
 * 画像関連ユーティリティ
 * - 画像拡張子の定義および判定 (isImageFile)
 * - バックエンド画像インライン表示エンドポイントURLの生成 (getImageViewUrl)
 * - 同一フォルダ内の画像一覧抽出およびカレントインデックス計算 (getImageSiblings)
 */
import { API_BASE_URL } from "../config";
import type { FileItem } from "../types/file";

/**
 * サポート対象の画像拡張子一覧
 */
export const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
]);

/**
 * ファイル名またはパスから画像ファイルかどうか判定する
 */
export function isImageFile(fileNameOrPath: string): boolean {
  if (!fileNameOrPath) return false;
  const lastDot = fileNameOrPath.lastIndexOf(".");
  if (lastDot < 0 || lastDot === fileNameOrPath.length - 1) {
    return false;
  }
  const ext = fileNameOrPath.slice(lastDot + 1).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * 画像インライン表示用のAPI URLを生成する
 */
export function getImageViewUrl(path: string): string {
  const encodedPath = encodeURIComponent(path);
  return `${API_BASE_URL}/api/view-image?path=${encodedPath}`;
}

/**
 * 同一フォルダ内のアイテム一覧から画像ファイルのみを抽出し、
 * 現在選択中の画像のインデックスを特定する
 */
export function getImageSiblings(
  items: FileItem[],
  currentPath: string
): { images: FileItem[]; currentIndex: number } {
  const images = items.filter((item) => item.type === "file" && isImageFile(item.name));
  const currentIndex = images.findIndex((img) => img.path === currentPath);
  return { images, currentIndex };
}

/**
 * バイト数を読みやすいサイズ文字列（KB, MB, GB）にフォーマットする
 */
export function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null || isNaN(bytes)) return "-";
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${sizes[i]}`;
}
