import { describe, expect, it } from 'vitest';
import {
  buildAppUrlForFile,
  getFilePathFromUrl,
  getParentFolder,
  isExcalidrawFile,
  isRelativePath,
  normalizePath,
  resolveRelativePath,
} from './pathUtils';

describe('normalizePath / getParentFolder', () => {
  it('Windowsの区切りを / に統一する', () => {
    expect(normalizePath('C:\\work\\a.excalidraw')).toBe('C:/work/a.excalidraw');
  });

  it('親フォルダを返し、区切りがなければ null', () => {
    expect(getParentFolder('/tmp/dir/a.excalidraw')).toBe('/tmp/dir');
    expect(getParentFolder('C:\\work\\a.excalidraw')).toBe('C:/work');
    expect(getParentFolder('a.excalidraw')).toBeNull();
    expect(getParentFolder(null)).toBeNull();
  });
});

describe('isExcalidrawFile', () => {
  it.each([
    ['/a/b.excalidraw', true],
    ['/a/b.EXCALIDRAW.md', true],
    ['/a/b.md', false],
    ['/a/b.png', false],
    ['', false],
  ])('%s -> %s', (path, expected) => {
    expect(isExcalidrawFile(path)).toBe(expected);
  });
});

describe('isRelativePath / resolveRelativePath', () => {
  it.each([
    ['docs/a.pdf', true],
    ['../a.pdf', true],
    ['/abs/a.pdf', false],
    ['C:\\abs\\a.pdf', false],
    ['https://example.com', false],
    ['obsidian://open?vault=v', false],
  ])('isRelativePath(%s) -> %s', (path, expected) => {
    expect(isRelativePath(path)).toBe(expected);
  });

  it('. と .. を解決して絶対パスにする', () => {
    expect(resolveRelativePath('../docs/./a.pdf', '/home/u/work')).toBe('/home/u/docs/a.pdf');
    expect(resolveRelativePath('uploads\\files\\a.txt', 'C:/work')).toBe('C:/work/uploads/files/a.txt');
  });
});

describe('URL helpers', () => {
  it('パーセント記号を含むファイル名を二重デコードしない', () => {
    window.history.pushState({}, '', '/?filepath=%2Ftmp%2F100%252Fdone.excalidraw');
    expect(getFilePathFromUrl()).toBe('/tmp/100%2Fdone.excalidraw');
  });

  it('filepath だけを差し替えたURLを作る', () => {
    window.history.pushState({}, '', '/?filepath=%2Fold.excalidraw&x=1');
    const url = new URL(buildAppUrlForFile('/new dir/a.excalidraw'));
    expect(url.searchParams.get('filepath')).toBe('/new dir/a.excalidraw');
    expect(url.searchParams.get('x')).toBe('1');
  });
});
