/**
 * キーボードショートカットフック（useKeyboardShortcuts）のテスト
 * 
 * 仕様:
 * 1. 'm' キー押下時:
 *    - テキスト要素が選択されている場合: toggleMarkerForElements を呼び出してシーンの elements を更新する。
 *    - 選択されていない場合: setActiveTool({ type: 'freedraw', locked: false }) を呼び出し、
 *      updateScene でマーカー描画スタイル（太さ、色、透過度）を設定する。
 * 2. 入力フィールドにフォーカスがある場合はショートカットを無視する。
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
    const newLine: NonDeletedExcalidrawElement = {
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
    };
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


