import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDrawWatcher } from './drawWatcher';

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
    emitTool: (type: string) => listeners.forEach((listener) => listener(elements, { activeTool: { type } })),
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
});
