/**
 * URL履歴・ナビゲーションユーティリティのテスト
 * - URLクエリパラメータからのファイルパス抽出
 * - ファイル閲覧時のURL同期とブラウザ履歴制御
 */
import { describe, it, expect } from 'vitest';
import { getFilePathFromUrl, buildFileUrl } from './navigation';

describe('navigation utility', () => {
  it('URLクエリ文字列からファイルパスを正しく取得できること', () => {
    const search = '?file=%2FUsers%2Fmine%2F000_work%2Fnotes%2Ftest.md';
    const path = getFilePathFromUrl(search);
    expect(path).toBe('/Users/mine/000_work/notes/test.md');
  });

  it('クエリにfileが存在しない場合はnullを返すこと', () => {
    expect(getFilePathFromUrl('')).toBeNull();
    expect(getFilePathFromUrl('?other=123')).toBeNull();
  });

  it('ファイルパスからURLを正しく構築できること', () => {
    const url = buildFileUrl('/Users/mine/000_work/notes/test.md');
    expect(url).toBe('/quick/?file=%2FUsers%2Fmine%2F000_work%2Fnotes%2Ftest.md');
  });
});
