/**
 * チェックモードの描画色（useCheckModeStrokeColor）のテスト
 *
 * 仕様:
 * - チェックモードをオンにしたとき、描画色（文字・線の色）を赤に強制する
 * - その後ユーザーが色を変えたら、その色を使う（こちらからは触らない）
 * - チェックモードをオフにしたとき、描画色を黒に戻す。その後は自由に変えられる
 * - 起動直後（オフのまま）は何もしない
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { CHECK_MODE_STROKE_COLOR, DEFAULT_STROKE_COLOR, useCheckModeStrokeColor } from './useCheckModeStrokeColor';

describe('useCheckModeStrokeColor', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let api: any;

  const TestComponent = ({ checkMode }: { checkMode: boolean }) => {
    useCheckModeStrokeColor(api, checkMode);
    return null;
  };
  const render = async (checkMode: boolean) => {
    await act(async () => {
      root.render(React.createElement(TestComponent, { checkMode }));
    });
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    api = { updateScene: vi.fn() };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('起動直後（オフのまま）は色を変えない', async () => {
    await render(false);

    expect(api.updateScene).not.toHaveBeenCalled();
  });

  it('オンにしたとき、描画色を赤にする', async () => {
    await render(false);
    await render(true);

    expect(api.updateScene).toHaveBeenCalledTimes(1);
    expect(api.updateScene).toHaveBeenCalledWith({ appState: { currentItemStrokeColor: CHECK_MODE_STROKE_COLOR } });
    expect(CHECK_MODE_STROKE_COLOR).toBe('#e03131');
  });

  it('オンの間にユーザーが色を変えても、こちらからは上書きしない', async () => {
    await render(false);
    await render(true);
    api.updateScene.mockClear();

    // 再描画（設定の変更など）が起きても、色は触らない
    await render(true);

    expect(api.updateScene).not.toHaveBeenCalled();
  });

  it('オフにしたとき、描画色を黒に戻す', async () => {
    await render(false);
    await render(true);
    api.updateScene.mockClear();

    await render(false);

    expect(api.updateScene).toHaveBeenCalledTimes(1);
    expect(api.updateScene).toHaveBeenCalledWith({ appState: { currentItemStrokeColor: DEFAULT_STROKE_COLOR } });
    expect(DEFAULT_STROKE_COLOR).toBe('#1e1e1e');
  });

  it('オン・オフを繰り返すたびに赤・黒に切り替える', async () => {
    await render(false);
    await render(true);
    await render(false);
    await render(true);

    const colors = api.updateScene.mock.calls.map(([data]: any[]) => data.appState.currentItemStrokeColor);
    expect(colors).toEqual(['#e03131', '#1e1e1e', '#e03131']);
  });
});
