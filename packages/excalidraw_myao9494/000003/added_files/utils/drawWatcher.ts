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
  /**
   * true なら、1 つ描いても監視を続け、描くたびに onCreated を呼ぶ（チェックモード）。
   * ツールを別のものに切り替えるか cancel() するまで終わらない。
   * ツールが残るよう、呼び出し側は `locked: true` でツールを選ぶこと。
   */
  continuous?: boolean;
}

export interface DrawWatcher {
  start: (options: DrawWatchOptions) => void;
  cancel: () => void;
  /** 監視中か */
  isActive: () => boolean;
}

export const createDrawWatcher = (api: ExcalidrawImperativeAPI): DrawWatcher => {
  let cleanup: (() => void) | null = null;

  const stop = () => {
    const finish = cleanup;
    cleanup = null;
    finish?.();
  };

  const start = ({ toolType, onCreated, onFinish, continuous = false }: DrawWatchOptions) => {
    stop();
    let knownCount = api.getSceneElements().length;

    const handlePointerUp = () => {
      const elements = api.getSceneElements();
      if (elements.length <= knownCount) {
        // 取り消しなどで減った場合も基準を合わせる
        knownCount = Math.min(knownCount, elements.length);
        return;
      }
      knownCount = elements.length;
      const newElement = elements[elements.length - 1];
      if (newElement.type === toolType) {
        onCreated(newElement, elements);
      }
      if (!continuous) {
        stop();
      }
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

  return { start, cancel: stop, isActive: () => cleanup !== null };
};

export interface StampWatchOptions {
  /** 監視対象のカスタムツール名（`setActiveTool({ type: 'custom', customType })`） */
  customType: string;
  /** 図面をクリックするたびに、シーン座標で呼ばれる */
  onStamp: (x: number, y: number) => void;
  /** ツールが切り替わった・cancel() されたときに最後に呼ばれる */
  onFinish?: () => void;
}

export interface StampWatcher {
  start: (options: StampWatchOptions) => void;
  cancel: () => void;
  isActive: () => boolean;
}

/**
 * カスタムツール上のクリックを検知して、その位置にスタンプ（チェックマーク）を置くための監視
 *
 * カスタムツールは Excalidraw 側では何も描かないので、クリック位置は onPointerDown で受け取る。
 * 別のツールに切り替えられたら（Esc など）終了する。
 */
export const createStampWatcher = (api: ExcalidrawImperativeAPI): StampWatcher => {
  let cleanup: (() => void) | null = null;

  const stop = () => {
    const finish = cleanup;
    cleanup = null;
    finish?.();
  };

  const start = ({ customType, onStamp, onFinish }: StampWatchOptions) => {
    stop();

    const unsubscribePointerDown = api.onPointerDown?.((activeTool, pointerDownState) => {
      if (activeTool.type === 'custom' && activeTool.customType === customType) {
        onStamp(pointerDownState.origin.x, pointerDownState.origin.y);
      }
    });

    // setActiveTool の反映は非同期のため、対象ツールが有効になったのを確認してから判定する
    let toolActivated = false;
    const unsubscribeChange = api.onChange?.((_elements, appState) => {
      const tool = appState.activeTool;
      if (tool?.type === 'custom' && tool.customType === customType) {
        toolActivated = true;
      } else if (toolActivated) {
        stop();
      }
    });

    cleanup = () => {
      unsubscribePointerDown?.();
      unsubscribeChange?.();
      onFinish?.();
    };
  };

  return { start, cancel: stop, isActive: () => cleanup !== null };
};
