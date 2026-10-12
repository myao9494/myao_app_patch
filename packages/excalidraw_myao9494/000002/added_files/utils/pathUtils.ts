/**
 * ファイルパス・URL まわりの純粋関数
 *
 * フロントエンドではパス区切りを常に `/` に正規化して扱う（Windowsパスも同様）。
 */

/** パス区切りを `/` に統一する */
export const normalizePath = (path: string): string => path.replace(/\\/g, '/');

/** ファイルパスの親フォルダを返す。区切りを含まない場合は null */
export const getParentFolder = (filePath: string | null | undefined): string | null => {
  if (!filePath) {
    return null;
  }
  const normalized = normalizePath(filePath);
  const lastSlashIndex = normalized.lastIndexOf('/');
  return lastSlashIndex !== -1 ? normalized.substring(0, lastSlashIndex) : null;
};

/** Excalidraw の図面ファイル（.excalidraw / .excalidraw.md）か判定する */
export const isExcalidrawFile = (filePath: string): boolean => {
  if (!filePath) return false;
  const pathLower = filePath.toLowerCase();
  return pathLower.endsWith('.excalidraw') || pathLower.endsWith('.excalidraw.md');
};

/** 相対パスか判定する（URL・Unix/Windowsの絶対パスは除外） */
export const isRelativePath = (path: string): boolean => {
  if (path.startsWith('/')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(path)) return false;
  if (path.startsWith('http://') || path.startsWith('https://')) return false;
  if (path.startsWith('obsidian://')) return false;
  return true;
};

/** 基準フォルダからの相対パスを絶対パスに変換する（`.` と `..` を解決） */
export const resolveRelativePath = (relativePath: string, currentFolder: string): string => {
  const normalizedFolder = normalizePath(currentFolder);
  const folderParts = normalizedFolder.split('/').filter((part) => part !== '');

  for (const part of normalizePath(relativePath).split('/')) {
    if (part === '..') {
      folderParts.pop();
    } else if (part !== '.' && part !== '') {
      folderParts.push(part);
    }
  }

  const prefix = normalizedFolder.startsWith('/') ? '/' : '';
  return prefix + folderParts.join('/');
};

/** URLの `?filepath=` を返す。URLSearchParams が1回デコード済みなので二重デコードしない */
export const getFilePathFromUrl = (): string | null =>
  new URLSearchParams(window.location.search).get('filepath');

/** 指定ファイルをこのアプリで開くURL（現在のURLの filepath だけを差し替える） */
export const buildAppUrlForFile = (filePath: string): string => {
  const url = new URL(window.location.href);
  url.searchParams.set('filepath', filePath);
  return url.toString();
};

/** 指定ファイルをこのアプリの新しいタブで開く */
export const openFileInNewTab = (filePath: string): void => {
  window.open(buildAppUrlForFile(filePath), '_blank', 'noopener');
};
