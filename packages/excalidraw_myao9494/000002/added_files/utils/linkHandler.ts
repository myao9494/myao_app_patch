/**
 * 図形リンク（付箋のリンク）のクリック処理と、OS側でファイルを開く処理
 *
 * リンクの種類ごとの動作:
 * - `cmd ...`            : バックエンドでシェルコマンドを実行（作業フォルダ = 図面のフォルダ）
 * - `obsidian://...`     : バックエンド経由でOSのURLハンドラーへ渡す
 * - `http(s)://...`      : 新しいタブで開く
 * - `.excalidraw(.md)`   : このアプリの新しいタブで開く（相対パスは図面のフォルダ基準）
 * - その他のファイル     : port 8001 のリダイレクトサービス、なければOSの既定アプリで開く
 */
import { openFileViaBackend, openUrlViaBackend, runCommandViaBackend } from './backendApi';
import {
  isExcalidrawFile,
  isRelativePath,
  normalizePath,
  openFileInNewTab,
  resolveRelativePath,
} from './pathUtils';

const CMD_LINK_PATTERN = /^cmd(\s|$)/i;

const alertUser = (message: string): void => {
  if (typeof window !== 'undefined' && window.alert) {
    window.alert(message);
  }
};

const getRedirectServiceBaseUrl = (): string => {
  const configuredUrl = import.meta.env.VITE_REDIRECT_SERVICE_URL?.trim();
  if (configuredUrl) {
    return configuredUrl.replace(/\/$/, '');
  }
  const host = window.location.hostname || 'localhost';
  return `http://${host}:8001`;
};

/** 任意の外部リダイレクトサービス（既定: 同じホストの port 8001） */
export const REDIRECT_SERVICE_BASE_URL = getRedirectServiceBaseUrl();

/** port 8001 のリダイレクトサービスが応答するか確認する */
export const checkRedirectServiceAvailable = async (timeoutMs: number = 500): Promise<boolean> => {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(`${REDIRECT_SERVICE_BASE_URL}/api/config`, {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store',
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeoutId);
  }
};

/**
 * port 8001 のリダイレクトサービスを優先し、なければ同梱FastAPIから
 * OSの既定アプリで開く。redirectWindow にはユーザー操作中に開いた空タブを渡せる
 * （非同期処理の後では window.open がポップアップブロックされるため）。
 */
export const openPathWithFallback = async (
  filePath: string,
  redirectWindow?: Window | null,
): Promise<'redirect-service' | 'system-handler'> => {
  if (await checkRedirectServiceAvailable()) {
    const redirectUrl = `${REDIRECT_SERVICE_BASE_URL}/api/open-path?path=${encodeURIComponent(filePath)}`;
    if (redirectWindow) {
      redirectWindow.location.href = redirectUrl;
    } else {
      window.location.href = redirectUrl;
    }
    return 'redirect-service';
  }

  if (redirectWindow && redirectWindow !== window && !redirectWindow.closed) {
    redirectWindow.close();
  }
  await openFileViaBackend(filePath);
  return 'system-handler';
};

/** `cmd <command>` リンクをバックエンドで実行する */
const runCommandLink = async (command: string, currentFolder?: string): Promise<void> => {
  const workingDirectory = currentFolder && currentFolder.trim() ? normalizePath(currentFolder) : undefined;
  console.log('[Link] Running command:', command, 'in', workingDirectory ?? '(not provided)');
  try {
    const result = await runCommandViaBackend(command, workingDirectory);
    if (!result.success) {
      throw new Error(result.error || 'Backend reported command execution failure');
    }
  } catch (error) {
    console.error('Error executing command via backend:', error);
    alertUser('コマンドを実行できませんでした。コマンドの形式を確認してください。');
  }
};

/**
 * 図形リンクのクリック処理
 * @param linkUrl 図形に設定されたリンク
 * @param currentFolder 開いている図面のフォルダ（相対パス解決とコマンドの作業フォルダに使用）
 */
export const handleStickyNoteLink = async (linkUrl: string, currentFolder?: string): Promise<void> => {
  try {
    // HTMLエンティティをデコード（&quot; → "）
    const link = linkUrl.trim().replace(/&quot;/g, '"');

    if (CMD_LINK_PATTERN.test(link)) {
      await runCommandLink(link, currentFolder);
      return;
    }

    if (link.startsWith('obsidian://')) {
      try {
        if (!(await openUrlViaBackend(link))) {
          alertUser('Obsidianを開くことができませんでした。');
        }
      } catch (error) {
        console.error('Error opening Obsidian URL:', error);
        alertUser('Obsidianを開く際にエラーが発生しました。');
      }
      return;
    }

    if (link.startsWith('http://') || link.startsWith('https://')) {
      window.open(link, '_blank');
      return;
    }

    const targetPath = isRelativePath(link) && currentFolder
      ? resolveRelativePath(link, currentFolder)
      : link;
    console.log(`[Link] ${link} -> ${targetPath}`);

    if (isExcalidrawFile(targetPath)) {
      openFileInNewTab(targetPath);
      return;
    }

    try {
      const redirectWindow = window.open('about:blank', '_blank');
      await openPathWithFallback(targetPath, redirectWindow);
    } catch (error) {
      console.error('Error opening file via bundled backend:', error);
      alertUser('ファイルを開けませんでした。ファイルが存在し、OSに対応アプリが設定されているか確認してください。');
    }
  } catch (error) {
    console.error('Error handling sticky note link:', error);
    alertUser('リンクの処理中にエラーが発生しました。');
  }
};
