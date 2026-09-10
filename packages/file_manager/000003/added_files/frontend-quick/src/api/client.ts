/**
 * バックエンドAPIクライアント
 * - ファイル検索（全文検索スニペット取得 + ファイル名検索フォールバック）
 * - ファイル内容の取得・更新
 * - 画像・SVGビューワー用URL生成
 * - 動的ホスト（Tailscale・ローカル）対応
 */
import { AppSettings, SearchResultItem, FileContentResponse } from '../types';
import { getApiBaseUrl } from '../utils/config';

/**
 * ファイル検索
 * 1. 全文検索（/api/fulltext-search）で中身のキーワードとスニペットを取得
 * 2. 同時にファイル名検索（/api/search）も行い、結果を統合して重複排除
 */
export async function searchFiles(
  query: string,
  settings: AppSettings
): Promise<SearchResultItem[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const baseUrl = getApiBaseUrl(settings);
  const basePath = settings.basePath;
  const results: SearchResultItem[] = [];
  const seenPaths = new Set<string>();

  // 1. 全文検索（ファイル中身の検索）
  try {
    const fulltextParams = new URLSearchParams({
      search: trimmed,
      path: basePath,
      depth: '20', // 深さ20階層まで再帰検索
      count: '100',
    });

    const res = await fetch(`${baseUrl}/api/fulltext-search?${fulltextParams.toString()}`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.results)) {
        for (const item of data.results) {
          if (!seenPaths.has(item.path)) {
            seenPaths.add(item.path);
            results.push({
              name: item.name,
              path: item.path,
              is_directory: item.type === 'directory',
              size: item.size,
              modified: item.date_modified,
              snippet: item.snippet,
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn('Fulltext search failed or not available:', err);
  }

  // 2. ファイル名検索（/api/search）
  try {
    const nameSearchParams = new URLSearchParams({
      path: basePath,
      query: trimmed,
      depth: '0',
    });

    const res = await fetch(`${baseUrl}/api/search?${nameSearchParams.toString()}`);
    if (res.ok) {
      const data = await res.json();
      const items = data.items || data.results || [];
      if (Array.isArray(items)) {
        for (const item of items) {
          const itemPath = item.path || item.full_path;
          if (itemPath && !seenPaths.has(itemPath)) {
            seenPaths.add(itemPath);
            results.push({
              name: item.name || itemPath.split('/').pop() || '',
              path: itemPath,
              is_directory: item.is_directory ?? (item.type === 'directory'),
              size: item.size,
              modified: item.modified,
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn('Name search failed:', err);
  }

  return results;
}

/**
 * ファイル内容を取得
 */
export async function fetchFileContent(
  filePath: string,
  settings: AppSettings
): Promise<FileContentResponse> {
  const baseUrl = getApiBaseUrl(settings);
  const params = new URLSearchParams({ path: filePath });

  const res = await fetch(`${baseUrl}/api/file-content?${params.toString()}`);
  if (!res.ok) {
    const errData = await res.json().catch(() => ({ detail: 'ファイルの取得に失敗しました' }));
    throw new Error(errData.detail || `HTTP ${res.status}`);
  }

  const data = await res.json();
  const name = filePath.split('/').pop() || '';
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() || '' : '';

  return {
    path: filePath,
    name,
    content: data.content ?? '',
    extension: ext,
    is_editable: !data.is_binary,
  };
}

/**
 * ファイル内容を更新・保存
 */
export async function saveFileContent(
  filePath: string,
  content: string,
  settings: AppSettings
): Promise<void> {
  const baseUrl = getApiBaseUrl(settings);

  const res = await fetch(`${baseUrl}/api/update-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: filePath,
      content,
    }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({ detail: 'ファイルの保存に失敗しました' }));
    throw new Error(errData.detail || `HTTP ${res.status}`);
  }
}

/**
 * 画像・SVG・Excalidraw図面の表示用URLを生成
 * - baseDir が指定されている場合、Obsidian Vault 相対パスや Vault ルートの探索のためにクエリパラメータとして付与
 */
export function getImageViewUrl(filePath: string, settings: AppSettings, baseDir?: string): string {
  const baseUrl = getApiBaseUrl(settings);
  let url = `${baseUrl}/api/view-image?path=${encodeURIComponent(filePath)}`;
  if (baseDir) {
    url += `&baseDir=${encodeURIComponent(baseDir)}`;
  }
  return url;
}

