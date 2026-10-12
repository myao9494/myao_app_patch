/**
 * useFileSync（読み込み・自動保存・外部更新の取り込み）のテスト
 * バックエンド呼び出しはモックし、Excalidraw API は最小限のフェイクを使う。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../utils/backendApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../utils/backendApi')>();
  return {
    ...original,
    loadExcalidrawFile: vi.fn(),
    getFileInfo: vi.fn(),
    saveExcalidrawFile: vi.fn(),
    archiveFile: vi.fn(),
  };
});
vi.mock('../utils/embeddedMarkdown', () => ({
  resolveEmbeddedMarkdownSources: vi.fn(async (_data: unknown, paths: Record<string, string> = {}) => paths),
  hydrateEmbeddedMarkdownFiles: vi.fn(async (data: { files?: Record<string, unknown> }) => ({ ...(data.files || {}) })),
}));
vi.mock('../utils/libraryItems', () => ({ fetchLibraryItems: vi.fn(async () => null) }));
vi.mock('../utils/linkHandler', () => ({ openPathWithFallback: vi.fn(async () => 'system-handler') }));

import * as backendApi from '../utils/backendApi';
import { SAVE_DELAY_MS, useFileSync, type UseFileSyncResult } from './useFileSync';

const loadMock = vi.mocked(backendApi.loadExcalidrawFile);
const infoMock = vi.mocked(backendApi.getFileInfo);
const saveMock = vi.mocked(backendApi.saveExcalidrawFile);
const archiveMock = vi.mocked(backendApi.archiveFile);

let nextVersion = 1;
const element = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  angle: 0,
  strokeColor: '#000',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 1,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 100,
  groupIds: [],
  isDeleted: false,
  version: nextVersion,
  versionNonce: nextVersion++,
  ...overrides,
});

const fileResult = (elements: any[], modified = 100, extra: Record<string, unknown> = {}) => ({
  data: { type: 'excalidraw', version: 2, source: 'test', elements, appState: {}, files: {} },
  modified,
  resolvedPath: '/work/a.excalidraw',
  shouldMigrateToMarkdown: false,
  ...extra,
}) as any;

/** シーンを保持するだけの Excalidraw API フェイク */
const createFakeApi = () => {
  let elements: any[] = [];
  return {
    getSceneElements: vi.fn(() => elements.filter((e) => !e.isDeleted)),
    getSceneElementsIncludingDeleted: vi.fn(() => elements),
    getAppState: vi.fn(() => ({ viewBackgroundColor: '#fff', scrollX: 0, scrollY: 0 })),
    getFiles: vi.fn(() => ({})),
    addFiles: vi.fn(),
    updateScene: vi.fn((scene: { elements?: any[] }) => {
      if (scene.elements) {
        elements = scene.elements;
      }
    }),
    /** ユーザーの編集を再現する */
    setElements: (next: any[]) => {
      elements = next;
    },
  };
};

describe('useFileSync', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let api: ReturnType<typeof createFakeApi>;
  let notify: ReturnType<typeof vi.fn>;
  let result: UseFileSyncResult;

  const Harness = () => {
    const embeddedFilePathsRef = useRef<Record<string, string>>({});
    result = useFileSync({ excalidrawAPI: api as any, notify, embeddedFilePathsRef });
    return null;
  };

  /** フックを描画し、初期データの読み込み完了まで進める */
  const mount = async () => {
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    const scene = await result.initialDataPromise;
    api.setElements((scene?.elements as any[]) ?? []);
    return scene;
  };

  /** ユーザーが要素を変更し、Excalidraw が onChange を呼んだ状態にする */
  const edit = (elements: any[]) => {
    api.setElements(elements);
    result.handleChange(elements);
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.history.pushState({}, '', '/?filepath=%2Fwork%2Fa.excalidraw');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    api = createFakeApi();
    notify = vi.fn();
    infoMock.mockResolvedValue({ exists: true, modified: 100 });
    saveMock.mockResolvedValue({ success: true, modified: 200 });
    archiveMock.mockResolvedValue({ success: true });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('URLのファイルを読み込んで初期データにし、読み込んだだけでは保存しない', async () => {
    loadMock.mockResolvedValue(fileResult([element('r1')]));

    const scene = await mount();

    expect(loadMock).toHaveBeenCalledWith('/work/a.excalidraw');
    expect((scene?.elements as any[]).map((e) => e.id)).toEqual(['r1']);
    expect(result.currentFilePath).toBe('/work/a.excalidraw');
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS * 2);
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('編集から10秒後に1回だけ保存する（10秒以内の編集はまとめる）', async () => {
    loadMock.mockResolvedValue(fileResult([element('r1')]));
    await mount();

    edit([element('r1', { x: 5 })]);
    await vi.advanceTimersByTimeAsync(3000);
    edit([element('r1', { x: 9 })]);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS - 3000 - 100);
    expect(saveMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(saveMock).toHaveBeenCalledOnce();
    const [path, data, forceBackup] = saveMock.mock.calls[0];
    expect(path).toBe('/work/a.excalidraw');
    expect(data.elements[0].x).toBe(9);
    expect(forceBackup).toBe(false);
  });

  it('バージョンが変わっても内容が保存済みと同じなら保存しない', async () => {
    const original = element('r1');
    loadMock.mockResolvedValue(fileResult([original]));
    await mount();

    edit([{ ...original, version: 99, versionNonce: 99 }]);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 100);

    expect(saveMock).not.toHaveBeenCalled();
  });

  it('要素が変わらない onChange（スクロール・選択など）では保存処理を始めない', async () => {
    const elements = [element('r1')];
    loadMock.mockResolvedValue(fileResult(elements));
    await mount();

    infoMock.mockClear();
    result.handleChange(elements);
    result.handleChange(elements);
    result.handleChange(elements);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 100);

    expect(infoMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('削除は保存され、削除後に変更がなければ保存し続けない', async () => {
    loadMock.mockResolvedValue(fileResult([element('r1'), element('r2')]));
    await mount();

    edit([element('r1'), element('r2', { isDeleted: true })]);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 100);
    expect(saveMock).toHaveBeenCalledOnce();
    expect(saveMock.mock.calls[0][1].elements.map((e: any) => e.id)).toEqual(['r1']);

    // 同じシーンで onChange が続いても再保存しない
    const scene = api.getSceneElementsIncludingDeleted();
    result.handleChange([...scene.map((e: any) => ({ ...e, versionNonce: e.versionNonce + 1000 }))]);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 100);
    expect(saveMock).toHaveBeenCalledOnce();
  });

  it('手動保存は内容が同じでもバックアップ付きで保存し、成功時だけ「保存しました」と通知する', async () => {
    loadMock.mockResolvedValue(fileResult([element('r1')]));
    await mount();

    await act(async () => result.saveNow());
    expect(saveMock).toHaveBeenCalledWith('/work/a.excalidraw', expect.anything(), true);
    expect(notify).toHaveBeenCalledWith('保存しました');

    notify.mockClear();
    saveMock.mockResolvedValueOnce({ success: false, message: 'disk full' });
    await act(async () => result.saveNow());
    expect(notify).toHaveBeenCalledWith('disk full', true);
    expect(notify).not.toHaveBeenCalledWith('保存しました');
  });

  it('外部で更新されていたら、最新の内容を読み込んで画面を置き換え、保存し直す', async () => {
    loadMock.mockResolvedValueOnce(fileResult([element('r1')], 100));
    await mount();

    infoMock.mockResolvedValue({ exists: true, modified: 150 });
    loadMock.mockResolvedValueOnce(fileResult([element('r1'), element('external')], 150));
    edit([element('r1', { x: 7 })]);
    await vi.advanceTimersByTimeAsync(100);

    expect(api.updateScene).toHaveBeenCalledWith(expect.objectContaining({
      elements: expect.arrayContaining([expect.objectContaining({ id: 'external' })]),
    }));
    expect(saveMock).toHaveBeenCalledOnce();
    expect(saveMock.mock.calls[0][2]).toBe(true);
    expect(notify).toHaveBeenCalledWith('最新の内容を読み込んで保存しました');
  });

  it('自分の保存による更新日時の変化は外部更新とみなさない', async () => {
    loadMock.mockResolvedValue(fileResult([element('r1')], 100));
    saveMock.mockResolvedValue({ success: true, modified: 200 });
    await mount();

    edit([element('r1', { x: 1 })]);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 100);
    expect(saveMock).toHaveBeenCalledOnce();

    infoMock.mockResolvedValue({ exists: true, modified: 200 });
    await vi.advanceTimersByTimeAsync(6000);
    edit([element('r1', { x: 2 })]);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 100);

    expect(loadMock).toHaveBeenCalledOnce();
    expect(saveMock).toHaveBeenCalledTimes(2);
  });

  it('読み込みに失敗したファイルは、空の図面で上書きしないよう保存を止める', async () => {
    loadMock.mockRejectedValue({ status: 400, error: { error_type: 'json_syntax', message: 'JSON構文エラー' } });
    await mount();

    expect(notify).toHaveBeenCalledWith(expect.stringContaining('ファイルを読み込めませんでした'), true);
    edit([element('new')]);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 100);
    await act(async () => result.saveNow());

    expect(saveMock).not.toHaveBeenCalled();
  });

  it('存在しないファイルは新規ファイルとして始め、編集すると保存する', async () => {
    loadMock.mockResolvedValue(null);
    infoMock.mockResolvedValue({ exists: false, modified: 0 });
    await mount();

    edit([element('first')]);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 100);

    expect(saveMock).toHaveBeenCalledOnce();
  });

  it('Vault内の .excalidraw は .excalidraw.md に変換して開き直し、元ファイルを退避する', async () => {
    loadMock.mockResolvedValue(fileResult([element('r1')], 100, { shouldMigrateToMarkdown: true }));
    await mount();
    await vi.advanceTimersByTimeAsync(0);

    expect(saveMock).toHaveBeenCalledWith('/work/a.excalidraw.md', expect.anything(), true);
    expect(archiveMock).toHaveBeenCalledWith('/work/a.excalidraw');
    expect(result.currentFilePath).toBe('/work/a.excalidraw.md');
    expect(new URL(window.location.href).searchParams.get('filepath')).toBe('/work/a.excalidraw.md');
  });
});
