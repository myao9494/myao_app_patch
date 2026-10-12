/**
 * 「ツールを切り替えた後、次に描かれた要素に後処理をする」ための監視
 *
 * C / M / U キーは描画ツールを選んだうえで、描き終えた要素に処理
 * （矢じりを消す・テキストの背面へ送る・テキストとグループ化する）を行う。
 * 描かずにツールを切り替えた（Esc など）場合は監視をやめ、onCancel を呼ぶ。
 * 監視は同時に1つだけで、新しい監視を始めると前の監視はキャンセルされる。
 */
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types';

export interface DrawWatchOptions {
  /** 監視対象のツール（このツール以外に切り替わったらキャンセル） */
  toolType: string;
  /** 新しい要素が描かれたとき（ポインタを離した時点）に呼ばれる */
  onCreated: (newElement: NonDeletedExcalidrawElement, elements: readonly NonDeletedExcalidrawElement[]) => void;
  /** 描画完了・キャンセルのどちらでも最後に呼ばれる（スタイルの復元など） */
  onFinish?: () => void;
}

export interface DrawWatcher {
  start: (options: DrawWatchOptions) => void;
  cancel: () => void;
}

export const createDrawWatcher = (api: ExcalidrawImperativeAPI): DrawWatcher => {
  let cleanup: (() => void) | null = null;

  const stop = () => {
    const finish = cleanup;
    cleanup = null;
    finish?.();
  };

  const start = ({ toolType, onCreated, onFinish }: DrawWatchOptions) => {
    stop();
    const initialCount = api.getSceneElements().length;

    const handlePointerUp = () => {
      const elements = api.getSceneElements();
      if (elements.length <= initialCount) {
        return;
      }
      const newElement = elements[elements.length - 1];
      if (newElement.type === toolType) {
        onCreated(newElement, elements);
      }
      stop();
    };

    // 描かずに別ツールへ切り替えたら監視をやめる。
    // setActiveTool の反映は非同期のため、対象ツールが有効になったのを確認してから判定する。
    // （描画中の pointerup は、Excalidraw がツールを戻すより先に document で受け取る）
    let toolActivated = false;
    const unsubscribeChange = api.onChange?.((_elements, appState) => {
      if (appState.activeTool?.type === toolType) {
        toolActivated = true;
      } else if (toolActivated) {
        stop();
      }
    });

    document.addEventListener('pointerup', handlePointerUp);
    cleanup = () => {
      document.removeEventListener('pointerup', handlePointerUp);
      unsubscribeChange?.();
      onFinish?.();
    };
  };

  return { start, cancel: stop };
};
