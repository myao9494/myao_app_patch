/**
 * 選択・モード判定ロジックのテスト (selection.test.js)
 * 
 * 仕様:
 * 1. flattenFiles で無視ファイルを除外して全選択可能ファイルを抽出する。
 * 2. filterReferenceFilesByInclusion で「呼び出されているモジュールを含む」がONなら選択された参照ファイルを返し、OFFなら空配列を返す。
 * 3. mergeAutoSelectedFiles で現在選択中のファイル一覧に自動検出されたモジュールを重複なく追加する。
 **/

import { describe, expect, it } from 'vitest';

import {
  filterReferenceFilesByInclusion, flattenFiles, initialSelection, mergeAutoSelectedFiles, mergeReferenceSelection,
  nodeMatchesFilter, parseIgnoreText, resolveRepositoryMode, toggleSelection
} from './selection';


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

describe('resolveRepositoryMode', () => {
  it('手動オーバーライドが未指定の場合、YAML判定がtrueならmkdocsモード、falseならcodeモードを返す', () => {
    expect(resolveRepositoryMode(true, '')).toBe('mkdocs');
    expect(resolveRepositoryMode(false, '')).toBe('code');
  });

  it('手動オーバーライドが指定されている場合はそのモードを優先する', () => {
    expect(resolveRepositoryMode(true, 'code')).toBe('code');
    expect(resolveRepositoryMode(false, 'mkdocs')).toBe('mkdocs');
  });
});


describe('initialSelection', () => {
  const all = ['a.py', 'b.py', 'c.py'];
  it('保存済みの選択がなければ全ファイルを選択する', () => {
    expect(Array.from(initialSelection([], all))).toEqual(all);
    expect(Array.from(initialSelection(undefined, all))).toEqual(all);
  });
  it('保存済みの選択のうち現在も存在するファイルだけを復元する', () => {
    expect(Array.from(initialSelection(['b.py', 'deleted.py'], all))).toEqual(['b.py']);
  });
});

describe('toggleSelection', () => {
  it('全チェック済みなら外し、そうでなければ全て追加する（元の集合は変更しない）', () => {
    const before = new Set(['a', 'b']);
    expect(Array.from(toggleSelection(before, ['a', 'b'], true))).toEqual([]);
    expect(Array.from(toggleSelection(before, ['a', 'c'], false)).sort()).toEqual(['a', 'b', 'c']);
    expect(Array.from(before)).toEqual(['a', 'b']);
  });
});

describe('mergeReferenceSelection', () => {
  it('新しく現れた参照ファイルは選択し、既存は直前の選択状態を維持する', () => {
    const previousAvailable = new Set(['r::a', 'r::b']);
    const available = new Set(['r::a', 'r::b', 'r::c']);
    const previousSelected = new Set(['r::a']);
    expect(Array.from(mergeReferenceSelection(available, previousAvailable, previousSelected)).sort()).toEqual(['r::a', 'r::c']);
  });
  it('消えた参照ファイルは選択から外れる', () => {
    expect(Array.from(mergeReferenceSelection(new Set(['r::a']), new Set(['r::a', 'r::b']), new Set(['r::a', 'r::b'])))).toEqual(['r::a']);
  });
});

describe('parseIgnoreText', () => {
  it('区切りを/に統一し、空行と重複を除く', () => {
    expect(parseIgnoreText('logs\r\n  build\\out  \n\nlogs\n*.tmp\n')).toEqual(['logs', 'build/out', '*.tmp']);
  });
});

describe('nodeMatchesFilter', () => {
  it('空フィルターは常に一致し、大文字小文字を区別しない', () => {
    expect(nodeMatchesFilter('src/Main.py', '')).toBe(true);
    expect(nodeMatchesFilter('src/Main.py', 'main')).toBe(true);
    expect(nodeMatchesFilter('src/Main.py', 'zzz')).toBe(false);
  });
});
