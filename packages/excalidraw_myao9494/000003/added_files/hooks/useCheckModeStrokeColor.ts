import { useEffect, useRef } from 'react';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

/** チェックモードの描画色（赤） */
export const CHECK_MODE_STROKE_COLOR = '#e03131';

/** Excalidraw の既定の描画色（黒）。チェックモードを外したときに戻す */
export const DEFAULT_STROKE_COLOR = '#1e1e1e';

/**
 * チェックモードのオン / オフに合わせて、描画色（これから作る文字・線の色）を切り替える
 *
 * - オンにしたとき: 赤に強制する。その後ユーザーが色を変えたら、その色のまま（こちらからは触らない）
 * - オフにしたとき: 黒に戻す。その後は自由に変えられる
 * - 起動直後（オフのまま）は何もしない
 *
 * Excalidraw には文字だけの色設定がなく、描画色は図形・線と共通のため、これらも同じ色になる。
 */
export const useCheckModeStrokeColor = (api: ExcalidrawImperativeAPI | null, checkMode: boolean) => {
  const previousCheckModeRef = useRef(checkMode);

  useEffect(() => {
    if (!api || previousCheckModeRef.current === checkMode) return;
    previousCheckModeRef.current = checkMode;
    api.updateScene({
      appState: { currentItemStrokeColor: checkMode ? CHECK_MODE_STROKE_COLOR : DEFAULT_STROKE_COLOR },
    });
  }, [api, checkMode]);
};
