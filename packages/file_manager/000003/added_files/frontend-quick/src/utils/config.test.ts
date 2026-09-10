/**
 * 設定ユーティリティのテスト
 * - デフォルト設定の生成
 * - Tailscaleホスト名やExcalidraw URLの解決検証
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TAILSCALE_HOST,
  DEFAULT_BASE_PATH,
  getExcalidrawUrl,
  getApiBaseUrl,
} from './config';
import { AppSettings } from '../types';

describe('config utils', () => {
  const dummySettings: AppSettings = {
    serverHost: DEFAULT_TAILSCALE_HOST,
    serverPort: '8001',
    excalidrawPort: '3001',
    basePath: DEFAULT_BASE_PATH,
    theme: 'dark',
  };

  it('Excalidraw URLが正しく構築されること', () => {
    const url = getExcalidrawUrl(dummySettings, '/Users/mine/000_work/diagram.excalidraw');
    expect(url).toContain(DEFAULT_TAILSCALE_HOST);
    expect(url).toContain('3001');
    expect(url).toContain('file=%2FUsers%2Fmine%2F000_work%2Fdiagram.excalidraw');
  });

  it('別ホスト指定時にAPIベースURLが絶対パスで構築されること', () => {
    const url = getApiBaseUrl(dummySettings);
    expect(url).toContain(DEFAULT_TAILSCALE_HOST);
    expect(url).toContain('8001');
  });
});
