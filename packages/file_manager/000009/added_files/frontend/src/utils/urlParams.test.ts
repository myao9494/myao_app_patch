/**
 * URLクエリパラメータからのパス取得のテスト
 * - デコードは URLSearchParams による1回だけ（二重デコードしない）
 * - "_" や "%" を含むパスがそのまま取得できる
 */

import { describe, it, expect } from 'vitest';
import { getPathParam } from './urlParams';

describe('getPathParam', () => {
  it('指定がなければ null を返す', () => {
    expect(getPathParam('', 'path')).toBeNull();
    expect(getPathParam('?open_file=a', 'path')).toBeNull();
  });

  it('アンダースコアはそのまま、%5F で書かれても _ として取得できる', () => {
    expect(getPathParam('?path=/tmp/a_b__c/_x_', 'path')).toBe('/tmp/a_b__c/_x_');
    expect(getPathParam('?path=%2Ftmp%2Fa%5Fb__c%2F%5Fx%5F', 'path')).toBe('/tmp/a_b__c/_x_');
  });

  it('% を含む実在のパスを二重デコードしない', () => {
    expect(getPathParam('?path=/tmp/100%2541', 'path')).toBe('/tmp/100%41');
    expect(getPathParam('?path=/tmp/50%2525', 'path')).toBe('/tmp/50%25');
  });

  it('不正なエスケープ（単独の %）でも例外にならない', () => {
    expect(getPathParam('?path=/tmp/50%25%', 'path')).toBe('/tmp/50%%');
  });

  it('UNCパスをエンコードして渡せる', () => {
    expect(getPathParam('?path=%5C%5Cserver%5Cshare%5Cfolder', 'path')).toBe('\\\\server\\share\\folder');
  });
});
