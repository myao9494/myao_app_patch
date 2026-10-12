/**
 * ファイルサイズを B / KB / MB で表示用に整形する（未取得は "-"）
 */
export function formatFileSize(bytes?: number): string {
  if (bytes === undefined) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
