/**
 * キーボードショートカットフック（useKeyboardShortcuts）のテスト
 *
 * 仕様:
 * - M: テキスト選択時はマーカーをトグル。未選択時はマーカー用スタイルで矩形ツールを起動し、
 *      描画完了（pointerup）後に元のスタイルへ戻す。
 * - U: テキスト選択時は下線をトグル。未選択時は下線用スタイルで直線ツールを起動し、
 *      描画完了後に元のスタイルへ戻す。
 * - , : 設定パネル、. : ショートカット一覧の開閉
 * - 入力フィールドにフォーカスがある場合・Ctrl/Cmd との組み合わせは無視する。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { MARKER_COLOR } from '../utils/markerUtils';
import { UNDERLINE_COLOR } from '../utils/underlineUtils';

describe('useKeyboardShortcuts - M key marker', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let mockExcalidrawAPI: Partial<ExcalidrawImperativeAPI>;

  const TestComponent = ({ api }: { api: any }) => {
    useKeyboardShortcuts({
      excalidrawAPI: api,
      viewportCoordsToSceneCoords: () => ({ x: 0, y: 0 }),
    });
    return null;
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    mockExcalidrawAPI = {
      getAppState: vi.fn().mockReturnValue({
        selectedElementIds: {},
      }),
      getSceneElements: vi.fn().mockReturnValue([]),
      updateScene: vi.fn(),
      setActiveTool: vi.fn(),
    };
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('テキスト要素未選択時にMキーを押すとマーカー矩形ツールが起動する', async () => {
    await act(async () => {
      root.render(React.createElement(TestComponent, { api: mockExcalidrawAPI }));
    });

    const event = new KeyboardEvent('keydown', { key: 'm', bubbles: true });
    document.dispatchEvent(event);

    expect(mockExcalidrawAPI.setActiveTool).toHaveBeenCalledWith({
      type: 'rectangle',
      locked: false,
    });
    expect(mockExcalidrawAPI.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({
        appState: expect.objectContaining({
          currentItemBackgroundColor: MARKER_COLOR,
          currentItemFillStyle: 'solid',
          currentItemStrokeColor: 'transparent',
          currentItemRoughness: 1,
          currentItemRoundness: 'round',
          currentItemOpacity: 50,
        }),
      })
    );
  });

  it('マーカー描画完了後（pointerup時）に元の描画スタイルが復元される', async () => {
    const originalStyles = {
      selectedElementIds: {},
      currentItemStrokeColor: '#1e1e1e',
      currentItemBackgroundColor: 'transparent',
      currentItemFillStyle: 'hachure',
      currentItemRoughness: 0,
      currentItemRoundness: 'sharp',
      currentItemOpacity: 100,
    };

    mockExcalidrawAPI.getAppState = vi.fn().mockReturnValue(originalStyles);
    mockExcalidrawAPI.getSceneElements = vi.fn().mockReturnValue([]);

    await act(async () => {
      root.render(React.createElement(TestComponent, { api: mockExcalidrawAPI }));
    });

    // Mキーを押してマーカーツールを起動
    const mEvent = new KeyboardEvent('keydown', { key: 'm', bubbles: true });
    document.dispatchEvent(mEvent);

    // 新しいマーカー矩形が作成された状態をシミュレート
    const newMarker: NonDeletedExcalidrawElement = {
      id: 'marker-1',
      type: 'rectangle',
      x: 10,
      y: 10,
      width: 100,
      height: 30,
      angle: 0,
      strokeColor: 'transparent',
      backgroundColor: MARKER_COLOR,
      fillStyle: 'solid',
      strokeWidth: 1,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: { type: 3 },
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
      customData: {},
      index: 'a0' as any,
    };
    mockExcalidrawAPI.getSceneElements = vi.fn().mockReturnValue([newMarker]);

    // pointerupイベントを発火
    const pointerUpEvent = new Event('pointerup', { bubbles: true });
    document.dispatchEvent(pointerUpEvent);

    // updateSceneで元のスタイルが復元されたことを検証
    expect(mockExcalidrawAPI.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({
        appState: expect.objectContaining({
          currentItemStrokeColor: '#1e1e1e',
          currentItemBackgroundColor: 'transparent',
          currentItemFillStyle: 'hachure',
          currentItemRoughness: 0,
          currentItemRoundness: 'sharp',
        }),
      })
    );
  });

  it('テキスト要素選択時にMキーを押すとマーカーが生成されてシーンが更新される', async () => {
    const textElement: NonDeletedExcalidrawElement = {
      id: 'text-1',
      type: 'text',
      x: 50,
      y: 100,
      width: 100,
      height: 30,
      angle: 0,
      strokeColor: '#000000',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 1,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 123,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
      text: 'あいうえお',
      fontSize: 20,
      fontFamily: 1,
      textAlign: 'left',
      verticalAlign: 'top',
      containerId: null,
      originalText: 'あいうえお',
      autoResize: true,
      lineHeight: 1.25 as any,
      index: 'a1' as any,
    };

    mockExcalidrawAPI.getAppState = vi.fn().mockReturnValue({
      selectedElementIds: { 'text-1': true },
    });
    mockExcalidrawAPI.getSceneElements = vi.fn().mockReturnValue([textElement]);

    await act(async () => {
      root.render(React.createElement(TestComponent, { api: mockExcalidrawAPI }));
    });

    const event = new KeyboardEvent('keydown', { key: 'm', bubbles: true });
    document.dispatchEvent(event);

    expect(mockExcalidrawAPI.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({
        elements: expect.arrayContaining([
          expect.objectContaining({
            type: 'rectangle',
            backgroundColor: MARKER_COLOR,
            customData: { markerFor: 'text-1' },
          }),
        ]),
      })
    );
  });
});

describe('useKeyboardShortcuts - U key underline', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let mockExcalidrawAPI: Partial<ExcalidrawImperativeAPI>;

  const TestComponent = ({ api }: { api: any }) => {
    useKeyboardShortcuts({ excalidrawAPI: api });
    return null;
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    mockExcalidrawAPI = {
      getAppState: vi.fn().mockReturnValue({
        selectedElementIds: {},
        currentItemStrokeColor: '#000000',
        currentItemStrokeWidth: 1,
        currentItemRoughness: 1,
        currentItemOpacity: 100,
      }),
      getSceneElements: vi.fn().mockReturnValue([]),
      setActiveTool: vi.fn(),
      updateScene: vi.fn(),
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('テキスト要素未選択時にUキーを押すと赤色の直線ツールが起動する', async () => {
    await act(async () => {
      root.render(React.createElement(TestComponent, { api: mockExcalidrawAPI }));
    });

    const event = new KeyboardEvent('keydown', { key: 'u', bubbles: true });
    document.dispatchEvent(event);

    expect(mockExcalidrawAPI.setActiveTool).toHaveBeenCalledWith({
      type: 'line',
      locked: false,
    });
    expect(mockExcalidrawAPI.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({
        appState: expect.objectContaining({
          currentItemStrokeColor: UNDERLINE_COLOR,
          currentItemStrokeWidth: 2,
        }),
      })
    );
  });

  it('アンダーライン描画完了後（pointerup時）に元の描画スタイルが復元される', async () => {
    const originalStyles = {
      selectedElementIds: {},
      currentItemStrokeColor: '#1e1e1e',
      currentItemStrokeWidth: 1,
      currentItemRoughness: 0,
      currentItemOpacity: 80,
    };

    mockExcalidrawAPI.getAppState = vi.fn().mockReturnValue(originalStyles);
    mockExcalidrawAPI.getSceneElements = vi.fn().mockReturnValue([]);

    await act(async () => {
      root.render(React.createElement(TestComponent, { api: mockExcalidrawAPI }));
    });

    // Uキーを押してアンダーラインツールを起動
    const uEvent = new KeyboardEvent('keydown', { key: 'u', bubbles: true });
    document.dispatchEvent(uEvent);

    // 新しい下線要素が作成された状態をシミュレート
    const newLine = {
      id: 'line-1',
      type: 'line',
      x: 10,
      y: 10,
      width: 100,
      height: 0,
      angle: 0,
      strokeColor: UNDERLINE_COLOR,
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
      customData: {},
      index: 'a0' as any,
    } as unknown as NonDeletedExcalidrawElement;
    mockExcalidrawAPI.getSceneElements = vi.fn().mockReturnValue([newLine]);

    // pointerupイベントを発火
    const pointerUpEvent = new Event('pointerup', { bubbles: true });
    document.dispatchEvent(pointerUpEvent);

    // updateSceneで元のスタイルが復元されたことを検証
    expect(mockExcalidrawAPI.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({
        appState: expect.objectContaining({
          currentItemStrokeColor: '#1e1e1e',
          currentItemStrokeWidth: 1,
          currentItemRoughness: 0,
          currentItemOpacity: 80,
        }),
      })
    );
  });

  it('テキスト要素選択時にUキーを押すとアンダーラインが生成されてシーンが更新される', async () => {
    const textElement: NonDeletedExcalidrawElement = {
      id: 'text-1',
      type: 'text',
      x: 50,
      y: 100,
      width: 150,
      height: 30,
      angle: 0,
      strokeColor: '#000000',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 1,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 123,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
      text: 'あいうえお',
      fontSize: 20,
      fontFamily: 1,
      textAlign: 'left',
      verticalAlign: 'top',
      containerId: null,
      originalText: 'あいうえお',
      autoResize: true,
      lineHeight: 1.25 as any,
      index: 'a1' as any,
    };

    mockExcalidrawAPI.getAppState = vi.fn().mockReturnValue({
      selectedElementIds: { 'text-1': true },
    });
    mockExcalidrawAPI.getSceneElements = vi.fn().mockReturnValue([textElement]);

    await act(async () => {
      root.render(React.createElement(TestComponent, { api: mockExcalidrawAPI }));
    });

    const event = new KeyboardEvent('keydown', { key: 'u', bubbles: true });
    document.dispatchEvent(event);

    expect(mockExcalidrawAPI.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({
        elements: expect.arrayContaining([
          expect.objectContaining({
            type: 'line',
            strokeColor: UNDERLINE_COLOR,
            customData: { underlineFor: 'text-1' },
          }),
        ]),
      })
    );
  });
});

describe('useKeyboardShortcuts - comma key and annotation settings', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let mockExcalidrawAPI: Partial<ExcalidrawImperativeAPI>;
  let onToggleAnnotationSettingsMock: ReturnType<typeof vi.fn>;

  const TestComponent = ({ api, onToggle, settings }: { api: any; onToggle?: () => void; settings?: any }) => {
    useKeyboardShortcuts({
      excalidrawAPI: api,
      onToggleAnnotationSettings: onToggle,
      annotationSettings: settings,
    });
    return null;
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onToggleAnnotationSettingsMock = vi.fn();

    mockExcalidrawAPI = {
      getAppState: vi.fn().mockReturnValue({
        selectedElementIds: {},
        currentItemStrokeColor: '#000000',
        currentItemStrokeWidth: 1,
        currentItemRoughness: 1,
        currentItemOpacity: 100,
      }),
      getSceneElements: vi.fn().mockReturnValue([]),
      setActiveTool: vi.fn(),
      updateScene: vi.fn(),
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('カンマ（,）キーを押すとonToggleAnnotationSettingsが呼び出される', async () => {
    await act(async () => {
      root.render(
        React.createElement(TestComponent, {
          api: mockExcalidrawAPI,
          onToggle: onToggleAnnotationSettingsMock,
        })
      );
    });

    const event = new KeyboardEvent('keydown', { key: ',', bubbles: true });
    document.dispatchEvent(event);

    expect(onToggleAnnotationSettingsMock).toHaveBeenCalledTimes(1);
  });

  it('カスタム設定が渡されている場合、MキーおよびUキー押下時にその設定が反映される', async () => {
    const customSettings = {
      marker: {
        color: '#bae6fd',
        opacity: 75,
      },
      underline: {
        color: '#1971c2',
        strokeWidth: 4,
        opacity: 90,
      },
    };

    await act(async () => {
      root.render(
        React.createElement(TestComponent, {
          api: mockExcalidrawAPI,
          settings: customSettings,
        })
      );
    });

    // Mキーテスト
    const mEvent = new KeyboardEvent('keydown', { key: 'm', bubbles: true });
    document.dispatchEvent(mEvent);

    expect(mockExcalidrawAPI.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({
        appState: expect.objectContaining({
          currentItemBackgroundColor: '#bae6fd',
          currentItemOpacity: 75,
        }),
      })
    );

    // Uキーテスト
    const uEvent = new KeyboardEvent('keydown', { key: 'u', bubbles: true });
    document.dispatchEvent(uEvent);

    expect(mockExcalidrawAPI.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({
        appState: expect.objectContaining({
          currentItemStrokeColor: '#1971c2',
          currentItemStrokeWidth: 4,
        }),
      })
    );
  });
});

describe('useKeyboardShortcuts - dot key shortcut help', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let mockExcalidrawAPI: Partial<ExcalidrawImperativeAPI>;
  let onToggleShortcutHelpMock: ReturnType<typeof vi.fn>;

  const TestComponent = ({
    api,
    onToggleHelp,
  }: {
    api: any;
    onToggleHelp?: () => void;
  }) => {
    useKeyboardShortcuts({
      excalidrawAPI: api,
      viewportCoordsToSceneCoords: () => ({ x: 0, y: 0 }),
      onToggleShortcutHelp: onToggleHelp,
    });
    return null;
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    mockExcalidrawAPI = {
      getAppState: vi.fn().mockReturnValue({
        selectedElementIds: {},
      }),
      getSceneElements: vi.fn().mockReturnValue([]),
      updateScene: vi.fn(),
      setActiveTool: vi.fn(),
    };

    onToggleShortcutHelpMock = vi.fn();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('.（ピリオド）キーを押すとonToggleShortcutHelpが呼び出される', async () => {
    await act(async () => {
      root.render(
        React.createElement(TestComponent, {
          api: mockExcalidrawAPI,
          onToggleHelp: onToggleShortcutHelpMock,
        })
      );
    });

    const event = new KeyboardEvent('keydown', { key: '.', bubbles: true });
    document.dispatchEvent(event);

    expect(onToggleShortcutHelpMock).toHaveBeenCalledTimes(1);
  });

  it('Hキーを押してもonToggleShortcutHelpは呼び出されない（Excalidraw標準機能と競合防止）', async () => {
    await act(async () => {
      root.render(
        React.createElement(TestComponent, {
          api: mockExcalidrawAPI,
          onToggleHelp: onToggleShortcutHelpMock,
        })
      );
    });

    const event = new KeyboardEvent('keydown', { key: 'h', bubbles: true });
    document.dispatchEvent(event);

    expect(onToggleShortcutHelpMock).not.toHaveBeenCalled();
  });

  it('入力要素にフォーカスがある場合は.（ピリオド）キーを押しても呼び出されない', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    await act(async () => {
      root.render(
        React.createElement(TestComponent, {
          api: mockExcalidrawAPI,
          onToggleHelp: onToggleShortcutHelpMock,
        })
      );
    });

    const event = new KeyboardEvent('keydown', { key: '.', bubbles: true });
    input.dispatchEvent(event);

    expect(onToggleShortcutHelpMock).not.toHaveBeenCalled();
    input.remove();
  });

  it('CmdまたはCtrlキーと同時に.（ピリオド）キーを押した場合は呼び出されない', async () => {
    await act(async () => {
      root.render(
        React.createElement(TestComponent, {
          api: mockExcalidrawAPI,
          onToggleHelp: onToggleShortcutHelpMock,
        })
      );
    });

    const cmdEvent = new KeyboardEvent('keydown', { key: '.', metaKey: true, bubbles: true });
    document.dispatchEvent(cmdEvent);
    expect(onToggleShortcutHelpMock).not.toHaveBeenCalled();

    const ctrlEvent = new KeyboardEvent('keydown', { key: '.', ctrlKey: true, bubbles: true });
    document.dispatchEvent(ctrlEvent);
    expect(onToggleShortcutHelpMock).not.toHaveBeenCalled();
  });
});



describe('useKeyboardShortcuts - チェックモード', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let api: any;
  let sceneElements: any[];
  let toolListeners: Array<(elements: any[], appState: any) => void>;
  let pointerDownListeners: Array<(tool: any, state: any) => void>;
  let onToggleCheckMode: ReturnType<typeof vi.fn>;

  const baseStyles = {
    selectedElementIds: {},
    currentItemStrokeColor: '#1e1e1e',
    currentItemStrokeWidth: 1,
    currentItemBackgroundColor: 'transparent',
    currentItemFillStyle: 'solid',
    currentItemRoughness: 0,
    currentItemRoundness: 'sharp',
    currentItemOpacity: 80,
  };

  const TestComponent = ({ checkMode }: { checkMode: boolean }) => {
    useKeyboardShortcuts({ excalidrawAPI: api, checkMode, onToggleCheckMode: onToggleCheckMode as any });
    return null;
  };

  const render = async (checkMode: boolean) => {
    await act(async () => {
      root.render(React.createElement(TestComponent, { checkMode }));
    });
  };

  const press = (init: KeyboardEventInit) => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  const pointerUp = () => document.dispatchEvent(new Event('pointerup'));
  /** setActiveTool が反映されたあとの onChange 通知 */
  const emitTool = (tool: any) => toolListeners.forEach((listener) => listener(sceneElements, { activeTool: tool }));
  const drawNew = (id: string, type: string, size = 100) => {
    sceneElements = [...sceneElements, { id, type, isDeleted: false, groupIds: [], x: 0, y: 0, width: size, height: size }];
    pointerUp();
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    sceneElements = [];
    toolListeners = [];
    pointerDownListeners = [];
    onToggleCheckMode = vi.fn();

    api = {
      getAppState: vi.fn(() => ({ ...baseStyles })),
      getSceneElements: vi.fn(() => sceneElements),
      setActiveTool: vi.fn(),
      updateScene: vi.fn((data: any) => {
        if (data.elements) sceneElements = data.elements;
      }),
      onChange: (callback: any) => {
        toolListeners.push(callback);
        return () => {
          toolListeners = toolListeners.filter((listener) => listener !== callback);
        };
      },
      onPointerDown: (callback: any) => {
        pointerDownListeners.push(callback);
        return () => {
          pointerDownListeners = pointerDownListeners.filter((listener) => listener !== callback);
        };
      },
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('Option/Alt + C でチェックモードを切り替える（Mac の ç にも対応）', async () => {
    await render(false);

    press({ key: 'ç', code: 'KeyC', altKey: true });
    press({ key: 'c', code: 'KeyC', altKey: true });

    expect(onToggleCheckMode).toHaveBeenCalledTimes(2);
    // 切り替えのキーでは矢印ツールも起動しない
    expect(api.setActiveTool).not.toHaveBeenCalled();
  });

  it('チェックモードでなければ M は 1 回描くと終わる（locked: false）', async () => {
    await render(false);
    press({ key: 'm' });

    expect(api.setActiveTool).toHaveBeenCalledWith({ type: 'rectangle', locked: false });
  });

  it('チェックモードの M は locked: true で、描き終えても続けて描ける', async () => {
    await render(true);
    press({ key: 'm' });
    expect(api.setActiveTool).toHaveBeenCalledWith({ type: 'rectangle', locked: true });
    emitTool({ type: 'rectangle' });

    drawNew('r1', 'rectangle');
    drawNew('r2', 'rectangle');

    // 2 つ描いても描画スタイルは戻らない（マーカー用スタイルのまま）
    const restored = api.updateScene.mock.calls.filter(([data]: any[]) => data.appState?.currentItemOpacity === 80);
    expect(restored).toHaveLength(0);
  });

  it('チェックモードの M は Esc（選択ツールへの切り替え）で終わり、描画スタイルが元に戻る', async () => {
    await render(true);
    press({ key: 'm' });
    emitTool({ type: 'rectangle' });
    drawNew('r1', 'rectangle');

    emitTool({ type: 'selection' });

    expect(api.updateScene).toHaveBeenLastCalledWith({
      appState: expect.objectContaining({ currentItemStrokeColor: '#1e1e1e', currentItemOpacity: 80, currentItemBackgroundColor: 'transparent' }),
    });
  });

  it('連続描画が終わったら「ツールを固定」を元（オフ）に戻す', async () => {
    await render(true);
    press({ key: 'm' });
    // Excalidraw 側で locked: true が反映された状態
    api.getAppState = vi.fn(() => ({ ...baseStyles, activeTool: { type: 'selection', locked: true } }));

    emitTool({ type: 'rectangle' });
    emitTool({ type: 'selection' });

    expect(api.updateScene).toHaveBeenCalledWith({ appState: { activeTool: { type: 'selection', locked: false } } });
  });

  it('連続描画の前から「ツールを固定」していた場合は、固定したままにする', async () => {
    api.getAppState = vi.fn(() => ({ ...baseStyles, activeTool: { type: 'selection', locked: true } }));
    await render(true);
    press({ key: 'm' });

    emitTool({ type: 'rectangle' });
    emitTool({ type: 'selection' });

    const unlocked = api.updateScene.mock.calls.filter(([data]: any[]) => data.appState?.activeTool);
    expect(unlocked).toHaveLength(0);
  });

  it('チェックモードの U は直線ツールを locked: true で起動する', async () => {
    await render(true);
    press({ key: 'u' });

    expect(api.setActiveTool).toHaveBeenCalledWith({ type: 'line', locked: true });
  });

  it('M → U と切り替えても、描画スタイルは最初の状態に戻る（マーカー用スタイルを元と取り違えない）', async () => {
    await render(true);
    press({ key: 'm' });
    // 画面の描画スタイルがマーカー用に変わった状態を再現する
    api.getAppState = vi.fn(() => ({ ...baseStyles, currentItemStrokeColor: 'transparent', currentItemOpacity: 50 }));
    emitTool({ type: 'rectangle' });
    press({ key: 'u' });
    emitTool({ type: 'line' });
    emitTool({ type: 'selection' });

    expect(api.updateScene).toHaveBeenLastCalledWith({
      appState: expect.objectContaining({ currentItemStrokeColor: '#1e1e1e', currentItemOpacity: 80 }),
    });
  });

  it('チェックモードの C は矢印ではなくチェックマーク用のツールを locked: true で起動する', async () => {
    await render(true);
    press({ key: 'c' });

    expect(api.setActiveTool).toHaveBeenCalledWith({ type: 'custom', customType: 'checkmark', locked: true });
    expect(api.setActiveTool).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'arrow' }));
  });

  it('チェックモードでなければ C は従来どおり矢印ツール（矢印なし直線）', async () => {
    await render(false);
    press({ key: 'c' });

    expect(api.setActiveTool).toHaveBeenCalledWith({ type: 'arrow', locked: false });
  });

  it('チェックマークのツールで図面をクリックするたびに ✓ が置かれる', async () => {
    await render(true);
    press({ key: 'c' });
    emitTool({ type: 'custom', customType: 'checkmark' });

    pointerDownListeners.forEach((listener) => listener({ type: 'custom', customType: 'checkmark' }, { origin: { x: 100, y: 200 } }));
    pointerDownListeners.forEach((listener) => listener({ type: 'custom', customType: 'checkmark' }, { origin: { x: 300, y: 400 } }));

    const checkMarks = sceneElements.filter((element) => element.customData?.checkMark);
    expect(checkMarks).toHaveLength(2);
    expect(checkMarks[0].x + checkMarks[0].width / 2).toBeCloseTo(100);
    expect(checkMarks[1].y + checkMarks[1].height / 2).toBeCloseTo(400);
  });

  it('チェックモードをオフにすると連続描画が終わり、選択ツールへ戻る', async () => {
    await render(true);
    press({ key: 'm' });
    emitTool({ type: 'rectangle' });
    api.setActiveTool.mockClear();

    await render(false);

    expect(api.setActiveTool).toHaveBeenCalledWith({ type: 'selection', locked: false });
    expect(api.updateScene).toHaveBeenLastCalledWith({
      appState: expect.objectContaining({ currentItemStrokeColor: '#1e1e1e', currentItemOpacity: 80 }),
    });
  });

  it('チェックモードをオフにしても、連続描画をしていなければツールは変えない', async () => {
    await render(true);
    api.setActiveTool.mockClear();

    await render(false);

    expect(api.setActiveTool).not.toHaveBeenCalled();
  });

  describe('ダブルクリック（テキスト編集を優先）', () => {
    const canvas = () => {
      const element = document.createElement('canvas');
      container.appendChild(element);
      return element;
    };

    it('連続描画中のダブルクリックは連続描画を終えて選択ツールへ戻し、ダブルクリックを届け直す', async () => {
      vi.useFakeTimers();
      try {
        await render(true);
        press({ key: 'm' });
        emitTool({ type: 'rectangle' });

        const target = canvas();
        const received: boolean[] = [];
        container.addEventListener('dblclick', (event) => received.push(event.isTrusted));
        const stopped = vi.fn();
        // 元のダブルクリックは Excalidraw に届かない
        document.addEventListener('dblclick', stopped);
        target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 5, clientY: 6 }));

        expect(stopped).not.toHaveBeenCalled();
        expect(api.setActiveTool).toHaveBeenLastCalledWith({ type: 'selection', locked: false });
        expect(received).toHaveLength(0);

        vi.runAllTimers();
        // 選択ツールに戻ったあとで 1 回だけ届け直される
        expect(received).toHaveLength(1);
        expect(stopped).toHaveBeenCalledTimes(1);
        document.removeEventListener('dblclick', stopped);
      } finally {
        vi.useRealTimers();
      }
    });

    it('チェックマークを置いた直後のダブルクリックでは、そのチェックマークを取り消す', async () => {
      vi.useFakeTimers();
      try {
        await render(true);
        press({ key: 'c' });
        emitTool({ type: 'custom', customType: 'checkmark' });
        pointerDownListeners.forEach((listener) => listener({ type: 'custom', customType: 'checkmark' }, { origin: { x: 1, y: 2 } }));
        pointerDownListeners.forEach((listener) => listener({ type: 'custom', customType: 'checkmark' }, { origin: { x: 1, y: 2 } }));
        expect(sceneElements.filter((element) => element.customData?.checkMark && !element.isDeleted)).toHaveLength(2);

        canvas().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));

        expect(sceneElements.filter((element) => element.customData?.checkMark && !element.isDeleted)).toHaveLength(0);
        vi.runAllTimers();
      } finally {
        vi.useRealTimers();
      }
    });

    it('下線の連続描画中のダブルクリックでは、クリックで始まった折れ線を取り消して作図の途中状態も捨てる', async () => {
      vi.useFakeTimers();
      try {
        await render(true);
        press({ key: 'u' });
        emitTool({ type: 'line' });
        const now = Date.now();
        const base = { isDeleted: false, groupIds: [], x: 0, y: 0, updated: now };
        // 少し前にドラッグで引いた下線（残す）と、クリックだけで始まった折れ線（消す）
        sceneElements = [
          { ...base, id: 'underline', type: 'line', width: 120, height: 0, updated: now - 5000 },
          { ...base, id: 'stray', type: 'line', width: 0, height: 0 },
        ];

        canvas().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));

        expect(sceneElements.find((element) => element.id === 'stray').isDeleted).toBe(true);
        expect(sceneElements.find((element) => element.id === 'underline').isDeleted).toBe(false);
        expect(api.updateScene).toHaveBeenCalledWith({ appState: { multiElement: null, selectedLinearElement: null } });
        vi.runAllTimers();
      } finally {
        vi.useRealTimers();
      }
    });

    it('ドラッグせずクリックしただけで生まれた線・矩形は、下線・マーカーとして扱わない（グループ化しない）', async () => {
      await render(true);
      press({ key: 'u' });
      emitTool({ type: 'line' });
      api.updateScene.mockClear();
      drawNew('stray-line', 'line', 0);
      expect(api.updateScene).not.toHaveBeenCalled();

      press({ key: 'm' });
      emitTool({ type: 'rectangle' });
      api.updateScene.mockClear();
      drawNew('stray-rect', 'rectangle', 0);
      expect(api.updateScene).not.toHaveBeenCalled();
    });

    it('連続描画をしていないときのダブルクリックには触れない', async () => {
      await render(true);
      const listener = vi.fn();
      document.addEventListener('dblclick', listener);

      canvas().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));

      expect(listener).toHaveBeenCalledTimes(1);
      expect(api.setActiveTool).not.toHaveBeenCalled();
      document.removeEventListener('dblclick', listener);
    });

    it('チェックモードでなければダブルクリックには触れない', async () => {
      await render(false);
      press({ key: 'm' });
      const listener = vi.fn();
      document.addEventListener('dblclick', listener);

      canvas().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));

      expect(listener).toHaveBeenCalledTimes(1);
      document.removeEventListener('dblclick', listener);
    });
  });
});
