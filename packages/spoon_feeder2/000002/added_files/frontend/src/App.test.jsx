/**
 * Spoonfeeder2 App 単体テスト (App.test.jsx)
 * 
 * 仕様:
 * 1. flattenFiles で無視ファイルを除外して全選択可能ファイルを抽出する。
 * 2. filterReferenceFilesByInclusion で「呼び出されているモジュールを含む」がONなら選択された参照ファイルを返し、OFFなら空配列を返す。
 * 3. mergeAutoSelectedFiles で現在選択中のファイル一覧に自動検出されたモジュールを重複なく追加する。
 **/

import { describe, expect, it } from 'vitest';

import { filterReferenceFilesByInclusion, flattenFiles, mergeAutoSelectedFiles } from './App';


describe('flattenFiles', () => {
  it('returns selectable files recursively and excludes ignored entries', () => {
    const tree = [{
      type: 'directory', path: 'src', children: [
        { type: 'file', path: 'src/main.py', ignored: false },
        { type: 'file', path: 'src/generated.py', ignored: true },
      ],
    }];

    expect(flattenFiles(tree)).toEqual(['src/main.py']);
  });
});

describe('filterReferenceFilesByInclusion', () => {
  it('呼び出されているモジュールを含むがOFFなら空配列を返す', () => {
    const repos = [{ path: '/common_lib', files: ['util.py'] }];
    const selected = new Set(['/common_lib::util.py']);
    expect(filterReferenceFilesByInclusion(repos, selected, false)).toEqual([]);
  });

  it('呼び出されているモジュールを含むがONなら選択された参照ファイルのみを返す', () => {
    const repos = [
      { path: '/common_lib', files: ['util.py', 'helper.py'] }
    ];
    const selected = new Set(['/common_lib::util.py']);
    expect(filterReferenceFilesByInclusion(repos, selected, true)).toEqual([
      { repository_path: '/common_lib', files: ['util.py'] }
    ]);
  });
});

describe('mergeAutoSelectedFiles', () => {
  it('現在選択されているファイルに新規検出モジュールを追加する', () => {
    const current = new Set(['main.py']);
    const detected = ['service.py', 'helper.py'];
    const merged = mergeAutoSelectedFiles(current, detected);
    expect(Array.from(merged).sort()).toEqual(['helper.py', 'main.py', 'service.py']);
  });
});
