import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDrawWatcher, createStampWatcher } from './drawWatcher';

/** onChange の購読と要素一覧だけを持つ、Excalidraw API の最小モック */
const createFakeApi = () => {
  let elements: any[] = [];
  const listeners = new Set<(elements: any[], appState: any) => void>();
  return {
    api: {
      getSceneElements: () => elements,
      onChange: (callback: (elements: any[], appState: any) => void) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    } as any,
    setElements: (next: any[]) => {
      elements = next;
    },
    emitTool: (type: string, customType?: string) =>
      listeners.forEach((listener) => listener(elements, { activeTool: { type, customType } })),
    listenerCount: () => listeners.size,
  };
};

const pointerUp = () => document.dispatchEvent(new Event('pointerup'));

describe('createDrawWatcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('対象ツールで要素が描かれたら onCreated → onFinish の順に呼び、監視を終える', () => {
    const fake = createFakeApi();
    const calls: string[] = [];
    createDrawWatcher(fake.api).start({
      toolType: 'rectangle',
      onCreated: (element) => calls.push(`created:${element.id}`),
      onFinish: () => calls.push('finish'),
    });

    fake.setElements([{ id: 'r1', type: 'rectangle' }]);
    pointerUp();
    pointerUp();

    expect(calls).toEqual(['created:r1', 'finish']);
    expect(fake.listenerCount()).toBe(0);
  });

  it('要素が増えない pointerup（クリックだけ）では監視を続ける', () => {
    const fake = createFakeApi();
    const onCreated = vi.fn();
    createDrawWatcher(fake.api).start({ toolType: 'rectangle', onCreated });

    pointerUp();
    fake.setElements([{ id: 'r1', type: 'rectangle' }]);
    pointerUp();

    expect(onCreated).toHaveBeenCalledOnce();
  });

  it('描かずに別のツールへ切り替えたら取り消し、onFinish だけ呼ぶ', () => {
    const fake = createFakeApi();
    const onCreated = vi.fn();
    const onFinish = vi.fn();
    createDrawWatcher(fake.api).start({ toolType: 'arrow', onCreated, onFinish });

    fake.emitTool('arrow'); // setActiveTool が反映された
    fake.emitTool('selection'); // ユーザーが選択ツールに戻した
    fake.setElements([{ id: 'a1', type: 'arrow' }]);
    pointerUp();

    expect(onFinish).toHaveBeenCalledOnce();
    expect(onCreated).not.toHaveBeenCalled();
    expect(fake.listenerCount()).toBe(0);
  });

  it('ツールの反映前に届いた古い状態の通知では取り消さない', () => {
    const fake = createFakeApi();
    const onCreated = vi.fn();
    createDrawWatcher(fake.api).start({ toolType: 'line', onCreated });

    fake.emitTool('selection'); // setActiveTool 反映前の通知
    fake.setElements([{ id: 'l1', type: 'line' }]);
    pointerUp();

    expect(onCreated).toHaveBeenCalledOnce();
  });

  it('別の種類の要素が描かれた場合は onCreated を呼ばずに終える', () => {
    const fake = createFakeApi();
    const onCreated = vi.fn();
    const onFinish = vi.fn();
    createDrawWatcher(fake.api).start({ toolType: 'arrow', onCreated, onFinish });

    fake.setElements([{ id: 't1', type: 'text' }]);
    pointerUp();

    expect(onCreated).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it('新しい監視を始めると前の監視は取り消される', () => {
    const fake = createFakeApi();
    const watcher = createDrawWatcher(fake.api);
    const first = { onCreated: vi.fn(), onFinish: vi.fn() };
    const second = { onCreated: vi.fn(), onFinish: vi.fn() };

    watcher.start({ toolType: 'rectangle', ...first });
    watcher.start({ toolType: 'line', ...second });
    fake.setElements([{ id: 'l1', type: 'line' }]);
    pointerUp();

    expect(first.onFinish).toHaveBeenCalledOnce();
    expect(first.onCreated).not.toHaveBeenCalled();
    expect(second.onCreated).toHaveBeenCalledOnce();
  });

  describe('continuous（チェックモードの連続描画）', () => {
    it('要素を描いても監視を続け、描くたびに onCreated を呼ぶ', () => {
      const fake = createFakeApi();
      const onCreated = vi.fn();
      const onFinish = vi.fn();
      createDrawWatcher(fake.api).start({ toolType: 'rectangle', continuous: true, onCreated, onFinish });

      fake.emitTool('rectangle');
      fake.setElements([{ id: 'r1', type: 'rectangle' }]);
      pointerUp();
      fake.setElements([{ id: 'r1', type: 'rectangle' }, { id: 'r2', type: 'rectangle' }]);
      pointerUp();

      expect(onCreated.mock.calls.map(([element]) => element.id)).toEqual(['r1', 'r2']);
      expect(onFinish).not.toHaveBeenCalled();
    });

    it('クリックだけ（要素が増えない）では何もしない', () => {
      const fake = createFakeApi();
      const onCreated = vi.fn();
      createDrawWatcher(fake.api).start({ toolType: 'line', continuous: true, onCreated });

      pointerUp();

      expect(onCreated).not.toHaveBeenCalled();
    });

    it('別のツールへ切り替えたら（Esc など）終了して onFinish を呼ぶ', () => {
      const fake = createFakeApi();
      const onFinish = vi.fn();
      const watcher = createDrawWatcher(fake.api);
      watcher.start({ toolType: 'rectangle', continuous: true, onCreated: vi.fn(), onFinish });

      fake.emitTool('rectangle');
      fake.emitTool('selection');

      expect(onFinish).toHaveBeenCalledOnce();
      expect(watcher.isActive()).toBe(false);
      expect(fake.listenerCount()).toBe(0);
    });

    it('cancel() でも終了して onFinish を呼ぶ', () => {
      const fake = createFakeApi();
      const onFinish = vi.fn();
      const watcher = createDrawWatcher(fake.api);
      watcher.start({ toolType: 'line', continuous: true, onCreated: vi.fn(), onFinish });
      expect(watcher.isActive()).toBe(true);

      watcher.cancel();

      expect(onFinish).toHaveBeenCalledOnce();
      expect(watcher.isActive()).toBe(false);
    });
  });
});

describe('createStampWatcher', () => {
  const createStampApi = () => {
    const fake = createFakeApi();
    let pointerDown: ((tool: any, state: any) => void) | null = null;
    const api = {
      ...fake.api,
      onPointerDown: (callback: (tool: any, state: any) => void) => {
        pointerDown = callback;
        return () => {
          pointerDown = null;
        };
      },
    } as any;
    return { fake, api, click: (tool: any, x: number, y: number) => pointerDown?.(tool, { origin: { x, y } }), hasPointerListener: () => pointerDown !== null };
  };
  const stampTool = { type: 'custom', customType: 'checkmark' };

  it('対象のカスタムツールでクリックするたびに onStamp をシーン座標で呼ぶ', () => {
    const { api, click } = createStampApi();
    const onStamp = vi.fn();
    createStampWatcher(api).start({ customType: 'checkmark', onStamp });

    click(stampTool, 10, 20);
    click(stampTool, 30, 40);

    expect(onStamp.mock.calls).toEqual([[10, 20], [30, 40]]);
  });

  it('別のツールでのクリックは無視する', () => {
    const { api, click } = createStampApi();
    const onStamp = vi.fn();
    createStampWatcher(api).start({ customType: 'checkmark', onStamp });

    click({ type: 'selection' }, 10, 20);

    expect(onStamp).not.toHaveBeenCalled();
  });

  it('別のツールへ切り替えたら終了して onFinish を呼ぶ', () => {
    const { fake, api, hasPointerListener } = createStampApi();
    const onFinish = vi.fn();
    const watcher = createStampWatcher(api);
    watcher.start({ customType: 'checkmark', onStamp: vi.fn(), onFinish });

    fake.emitTool('custom', 'checkmark'); // setActiveTool が反映された
    fake.emitTool('selection');

    expect(onFinish).toHaveBeenCalledOnce();
    expect(watcher.isActive()).toBe(false);
    expect(hasPointerListener()).toBe(false);
  });
});
