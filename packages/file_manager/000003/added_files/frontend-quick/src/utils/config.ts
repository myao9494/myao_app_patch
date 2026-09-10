/**
 * 設定管理ユーティリティ
 * - localStorageによる設定の永続化
 * - Tailscaleホスト/ローカルホストの動的解決
 * - 外部アプリ（Excalidraw等）連携URLの生成
 */
import { AppSettings } from '../types';

const SETTINGS_KEY = 'quick_app_settings';

// デフォルトのTailscaleドメイン
export const DEFAULT_TAILSCALE_HOST = 'mineomacbook-air.taild3cb7c.ts.net';
export const DEFAULT_BASE_PATH = '/Users/mine/000_work';

/**
 * 初期設定値を取得
 */
export function getDefaultSettings(): AppSettings {
  const currentHost = typeof window !== 'undefined' ? window.location.hostname : '';
  const currentPort = typeof window !== 'undefined' ? window.location.port : '8001';

  // 現在のホストが localhost/127.0.0.1 でなければそのまま利用、ローカルホストならTailscaleホストを優先初期値に
  const initialHost =
    currentHost && currentHost !== 'localhost' && currentHost !== '127.0.0.1'
      ? currentHost
      : DEFAULT_TAILSCALE_HOST;

  return {
    serverHost: initialHost,
    serverPort: currentPort || '8001',
    excalidrawPort: '3001',
    basePath: DEFAULT_BASE_PATH,
    theme: 'dark',
  };
}

/**
 * 保存された設定を読み込み（なければデフォルト）
 */
export function loadSettings(): AppSettings {
  try {
    const data = localStorage.getItem(SETTINGS_KEY);
    if (data) {
      return { ...getDefaultSettings(), ...JSON.parse(data) };
    }
  } catch (e) {
    console.warn('Failed to load settings from localStorage:', e);
  }
  return getDefaultSettings();
}

/**
 * 設定を保存
 */
export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save settings to localStorage:', e);
  }
}

/**
 * APIベースURLを取得
 * - スマホから同一オリジン（例: http://mineomacbook-air.taild3cb7c.ts.net:8001/quick/）でアクセスしている場合は相対パス "" でOK
 * - もし異なるホストやポートが指定されている場合は絶対URLを構築
 */
export function getApiBaseUrl(settings: AppSettings): string {
  const currentHost = typeof window !== 'undefined' ? window.location.hostname : '';
  const currentPort =
    typeof window !== 'undefined'
      ? window.location.port || (window.location.protocol === 'https:' ? '443' : '80')
      : '';

  // 設定されたホスト・ポートが現在のブラウザアクセス先と同一なら相対パス
  if (currentHost && settings.serverHost === currentHost && settings.serverPort === currentPort) {
    return '';
  }

  // 異なるホスト指定時やテスト環境
  const protocol =
    typeof window !== 'undefined' && window.location.protocol
      ? window.location.protocol
      : 'http:';
  return `${protocol}//${settings.serverHost}:${settings.serverPort}`;
}

/**
 * Excalidrawの連携URLを構築
 */
export function getExcalidrawUrl(settings: AppSettings, filePath?: string): string {
  const protocol = typeof window !== 'undefined' ? window.location.protocol : 'http:';
  let url = `${protocol}//${settings.serverHost}:${settings.excalidrawPort}`;
  if (filePath) {
    url += `?file=${encodeURIComponent(filePath)}`;
  }
  return url;
}
