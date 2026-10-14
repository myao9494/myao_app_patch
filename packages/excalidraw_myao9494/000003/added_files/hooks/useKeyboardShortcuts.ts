import { useEffect, useRef } from 'react';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { useMousePosition } from './useMousePosition';
import { createDefaultStickyNote, createLinkStickyNote } from '../utils/stickyNoteUtils';
import { toggleMarkerForElements, sendMarkerBehindOverlappingText, MARKER_COLOR, DEFAULT_MARKER_OPACITY } from '../utils/markerUtils';
import { toggleUnderlineForElements, sendUnderlineWithOverlappingText, UNDERLINE_COLOR, DEFAULT_UNDERLINE_STROKE_WIDTH } from '../utils/underlineUtils';
import { createDrawWatcher, createStampWatcher, type DrawWatcher, type StampWatcher } from '../utils/drawWatcher';
import { createCheckMarkElement } from '../utils/checkMarkUtils';
import type { AnnotationSettings } from '../utils/annotationSettings';

/**
 * キーボードショートカット機能のオプション
 */
export interface KeyboardShortcutsOptions {
  /** ExcalidrawのAPIインスタンス */
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  /** ビューポート座標をシーン座標に変換する関数 */
  viewportCoordsToSceneCoords?: (coords: { clientX: number; clientY: number }, appState: any) => { x: number; y: number };
  /** 保存ショートカット用のコールバック関数 */
  onSave?: () => void;
  /** アノテーション設定パネルの開閉トグルコールバック */
  onToggleAnnotationSettings?: () => void;
  /** ショートカット一覧ヘルプの開閉トグルコールバック */
  onToggleShortcutHelp?: () => void;
  /** マーカー・アンダーラインの現在設定 */
  annotationSettings?: AnnotationSettings;
  /** チェックモードか（M / U を連続で引き、C でチェックマークを置く） */
  checkMode?: boolean;
  /** チェックモードのオン / オフ切り替え（Option/Alt + C）のコールバック */
  onToggleCheckMode?: () => void;
}

const SHAPE_CYCLE = ['rectangle', 'diamond', 'ellipse'];

/** チェックマークを置くカスタムツールの名前 */
const CHECK_MARK_TOOL = 'checkmark';

/** チェックモードの連続描画の種類 */
type ContinuousKind = 'marker' | 'underline' | 'check';

/** 連続描画の前に退避しておく、描画スタイルの項目 */
const STYLE_KEYS = [
  'currentItemStrokeColor',
  'currentItemStrokeWidth',
  'currentItemBackgroundColor',
  'currentItemFillStyle',
  'currentItemRoughness',
  'currentItemRoundness',
  'currentItemOpacity',
] as const;

/** ダブルクリックと見なして、直前のスタンプを取り消す時間（ミリ秒） */
const DOUBLE_CLICK_WINDOW_MS = 600;

/** クリックだけで生まれた（ドラッグで描いていない）要素と見なす大きさ（px） */
const CLICK_ONLY_SIZE = 8;

/** ドラッグで描いたのではなく、クリックだけで生まれた要素か（大きさがほぼない） */
const isClickOnly = (element: { width: number; height: number }) => Math.max(element.width, element.height) < CLICK_ONLY_SIZE;

/**
 * カスタムキーボードショートカット機能を提供するフック
 *
 * 以下の機能を提供（入力欄にフォーカスがあるときは無効）：
 * - .: ショートカット一覧ヘルプの表示/非表示
 * - C: 矢印なしの直線描画
 * - N: 基本付箋作成（マウス位置）
 * - W: クリップボードからリンク付箋作成（マウス位置）
 * - M: マーカー機能（選択テキストにハイライト付与/解除、未選択時はマーカー描画ツール起動）
 * - U: アンダーライン機能（選択テキストに下線付与/解除、未選択時は下線描画ツール起動）
 * - ,: マーカーとアンダーラインの設定パネルの開閉トグル
 * - Tab: 選択されたオブジェクトの形状を順番に変更（四角形 → ひし形 → 円 → ...）
 * - Cmd/Ctrl + S: 保存
 * - Cmd/Ctrl + M: 選択要素を最前面に移動
 * - Cmd/Ctrl + B: 選択要素を最背面に移動
 * - Option/Alt + C: チェックモードのオン / オフ
 *
 * C / M / U で描画ツールに切り替えた後、描かずに Esc などでツールを変えた場合は
 * 後処理を取り消し、変更した描画スタイルも元に戻す。
 *
 * チェックモード（checkMode）では、ツールが 1 回描いても終わらず、Esc かチェックモードを
 * オフにするまで連続で描ける。C は矢印なし直線ではなくチェックマーク（✓）の連続配置になる。
 * ただしダブルクリックはテキスト編集を優先し、連続描画を終えて通常のダブルクリックを通す。
 */
export const useKeyboardShortcuts = (options: KeyboardShortcutsOptions) => {
  const { excalidrawAPI } = options;
  const mousePositionRef = useMousePosition();
  // コールバックや設定が変わってもリスナーを付け直さないよう、最新値は ref から読む
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // チェックモードをオフにしたとき、連続描画を終えるための関数（effect 内で設定する）
  const endContinuousRef = useRef<() => void>(() => {});

  const checkMode = !!options.checkMode;
  useEffect(() => {
    if (!checkMode) {
      endContinuousRef.current();
    }
  }, [checkMode, excalidrawAPI]);

  useEffect(() => {
    if (!excalidrawAPI) return;
    const api = excalidrawAPI;
    const drawWatcher: DrawWatcher = createDrawWatcher(api);
    const stampWatcher: StampWatcher = createStampWatcher(api);

    // チェックモードの連続描画の状態
    let continuousKind: ContinuousKind | null = null;
    let originalStyles: any = null;
    /** 連続描画を始める前の「ツールを固定」の状態（終了時に戻す） */
    let originalLocked: boolean | null = null;
    let recentStamps: { id: string; time: number }[] = [];
    let redispatching = false;

    const isCheckMode = () => !!optionsRef.current.checkMode;

    const snapshotStyles = (appState: Record<string, any>, keys: readonly string[]): any =>
      Object.fromEntries(keys.map((key) => [key, appState[key]]));

    /**
     * 連続描画を始める準備。実行中の連続描画があれば先に終わらせ、描画スタイルは最初の状態を引き継ぐ
     * （2 回目以降に現在のスタイル = マーカー用スタイルを「元の状態」と取り違えないため）
     */
    const prepareContinuous = (appState: Record<string, any>): any => {
      const carriedStyles = continuousKind ? originalStyles : null;
      const carriedLocked = continuousKind ? originalLocked : null;
      if (continuousKind) {
        drawWatcher.cancel();
        stampWatcher.cancel();
      }
      originalLocked = carriedLocked ?? !!appState.activeTool?.locked;
      return carriedStyles ?? snapshotStyles(appState, STYLE_KEYS);
    };

    /** 連続描画の終了処理: 「ツールを固定」を元の状態へ戻す（固定したまま残さない） */
    const finishContinuous = () => {
      const locked = originalLocked ?? false;
      continuousKind = null;
      originalStyles = null;
      originalLocked = null;
      recentStamps = [];
      const tool = api.getAppState().activeTool;
      if (tool && !!tool.locked !== locked) {
        api.updateScene({ appState: { activeTool: { ...tool, locked } } as any });
      }
    };

    /** チェックモードの連続描画を終えて、選択ツールへ戻す（チェックモードをオフにしたとき） */
    const endContinuous = () => {
      if (!continuousKind) return;
      const locked = originalLocked ?? false;
      drawWatcher.cancel();
      stampWatcher.cancel();
      api.setActiveTool({ type: 'selection', locked });
    };
    endContinuousRef.current = endContinuous;

    const getMouseScenePosition = () => {
      const { viewportCoordsToSceneCoords } = optionsRef.current;
      const { x, y } = mousePositionRef.current;
      return viewportCoordsToSceneCoords
        ? viewportCoordsToSceneCoords({ clientX: x, clientY: y }, api.getAppState())
        : { x, y };
    };

    const hasSelectedText = (elements: readonly NonDeletedExcalidrawElement[], selectedIds: Readonly<Record<string, true>>) =>
      elements.some((el) => selectedIds[el.id] && el.type === 'text' && !el.isDeleted);

    /** 付箋を追加し、テキスト要素を選択状態にする */
    const addStickyNote = (stickyNoteElements: NonDeletedExcalidrawElement[]) => {
      const textElement = stickyNoteElements[1];
      api.updateScene({
        elements: [...api.getSceneElements(), ...stickyNoteElements],
        appState: {
          ...api.getAppState(),
          selectedElementIds: { [textElement.id]: true },
        },
      });
    };

    /** チェックモードの C: 図面をクリックした位置にチェックマーク（✓）を連続で置く */
    const handleCheckMark = () => {
      if (continuousKind === 'check') return;
      // マーカー / 下線の連続描画中なら先に終わらせる（描画スタイルはその終了時に元へ戻る）
      prepareContinuous(api.getAppState());

      continuousKind = 'check';
      api.setActiveTool({ type: 'custom', customType: CHECK_MARK_TOOL, locked: true });

      stampWatcher.start({
        customType: CHECK_MARK_TOOL,
        onStamp: (x, y) => {
          const checkMark = createCheckMarkElement(x, y);
          recentStamps.push({ id: checkMark.id, time: Date.now() });
          api.updateScene({ elements: [...api.getSceneElements(), checkMark] });
        },
        onFinish: () => finishContinuous(),
      });
    };

    /** C: 矢印ツールで描き、描いた矢印の矢じりを消して直線にする */
    const handleArrowlessLine = () => {
      if (isCheckMode()) {
        handleCheckMark();
        return;
      }
      api.setActiveTool({ type: 'arrow', locked: false });
      drawWatcher.start({
        toolType: 'arrow',
        onCreated: (newElement, elements) => {
          // 描画中の要素を Excalidraw と共有しているため、直接書き換える
          (newElement as any).startArrowhead = null;
          (newElement as any).endArrowhead = null;
          api.updateScene({ elements });
        },
      });
    };

    /** N: マウス位置に基本付箋を作成 */
    const handleCreateStickyNote = () => {
      const { x, y } = getMouseScenePosition();
      addStickyNote(createDefaultStickyNote(x, y));
    };

    /** W: クリップボードのパス/URLからリンク付箋を作成（.py / .sh / .bat は実行コマンドにする） */
    const handleCreateClipboardStickyNote = async () => {
      const clipboardText = await navigator.clipboard.readText();
      if (!clipboardText) return;

      const { x, y } = getMouseScenePosition();
      const lower = clipboardText.toLowerCase();
      let linkText = clipboardText;
      if (lower.endsWith('.py')) {
        linkText = `cmd python ${clipboardText}`;
      } else if (lower.endsWith('.sh') || lower.endsWith('.bat')) {
        linkText = `cmd ${clipboardText}`;
      }

      let displayText = clipboardText.split(/[\/\\]/).pop() || clipboardText;
      try {
        displayText = decodeURIComponent(displayText);
      } catch {
        // % を含むが URL エンコードでないファイル名はそのまま表示する
      }
      addStickyNote(createLinkStickyNote(x, y, displayText, linkText));
    };

    /**
     * M: マーカー
     * - テキスト選択時: テキストの下半分にマーカーを付与（付与済みなら解除）
     * - 未選択時: マーカー用スタイルで矩形ツールを起動し、描いた矩形を重なるテキストの背面へ送る
     */
    const handleMarker = () => {
      const appState = api.getAppState();
      const allElements = api.getSceneElements();
      const { annotationSettings } = optionsRef.current;
      const markerColor = annotationSettings?.marker.color ?? MARKER_COLOR;
      const markerOpacity = annotationSettings?.marker.opacity ?? DEFAULT_MARKER_OPACITY;

      if (hasSelectedText(allElements, appState.selectedElementIds)) {
        const { updatedElements } = toggleMarkerForElements(allElements, appState.selectedElementIds, {
          color: markerColor,
          opacity: markerOpacity,
        });
        api.updateScene({ elements: updatedElements });
        return;
      }

      const continuous = isCheckMode();
      if (continuous && continuousKind === 'marker') return;
      const previousStyles = continuous
        ? prepareContinuous(appState)
        : {
            currentItemStrokeColor: appState.currentItemStrokeColor,
            currentItemBackgroundColor: appState.currentItemBackgroundColor,
            currentItemFillStyle: appState.currentItemFillStyle,
            currentItemRoughness: appState.currentItemRoughness,
            currentItemRoundness: appState.currentItemRoundness,
            currentItemOpacity: appState.currentItemOpacity,
          };

      // activeTool を上書きしないよう appState は展開しない
      api.updateScene({
        appState: {
          currentItemBackgroundColor: markerColor,
          currentItemFillStyle: 'solid',
          currentItemStrokeColor: 'transparent',
          currentItemRoughness: 1,
          currentItemRoundness: 'round',
          currentItemOpacity: markerOpacity,
        },
      });
      // updateScene の後に呼ぶことで確実に矩形ツールになる。チェックモードではツールを残して連続で描けるようにする
      api.setActiveTool({ type: 'rectangle', locked: continuous });
      if (continuous) {
        continuousKind = 'marker';
        originalStyles = previousStyles;
      }

      drawWatcher.start({
        toolType: 'rectangle',
        continuous,
        onCreated: (newElement, elements) => {
          // ドラッグせずにクリックしただけ（大きさのない矩形）ならマーカーとして扱わない
          if (continuous && isClickOnly(newElement)) return;
          const reordered = sendMarkerBehindOverlappingText(elements, newElement.id);
          if (reordered !== elements) {
            api.updateScene({ elements: reordered });
          }
        },
        onFinish: () => {
          if (continuous) finishContinuous();
          api.updateScene({ appState: previousStyles });
        },
      });
    };

    /**
     * U: アンダーライン
     * - テキスト選択時: テキストの下端に下線を付与してグループ化（付与済みなら解除）
     * - 未選択時: 下線用スタイルで直線ツールを起動し、描いた線を近くのテキストとグループ化
     */
    const handleUnderline = () => {
      const appState = api.getAppState();
      const selectedElementIds = appState.selectedElementIds || {};
      const allElements = api.getSceneElements();
      const { annotationSettings } = optionsRef.current;
      const underlineColor = annotationSettings?.underline.color ?? UNDERLINE_COLOR;
      const underlineStrokeWidth = annotationSettings?.underline.strokeWidth ?? DEFAULT_UNDERLINE_STROKE_WIDTH;
      const underlineOpacity = annotationSettings?.underline.opacity ?? 100;

      if (hasSelectedText(allElements, selectedElementIds)) {
        const { updatedElements } = toggleUnderlineForElements(allElements, selectedElementIds, {
          color: underlineColor,
          strokeWidth: underlineStrokeWidth,
        });
        api.updateScene({ elements: updatedElements });
        return;
      }

      const continuous = isCheckMode();
      if (continuous && continuousKind === 'underline') return;
      const previousStyles = continuous
        ? prepareContinuous(appState)
        : {
            currentItemStrokeColor: appState.currentItemStrokeColor,
            currentItemStrokeWidth: appState.currentItemStrokeWidth,
            currentItemRoughness: appState.currentItemRoughness,
            currentItemOpacity: appState.currentItemOpacity,
          };

      api.updateScene({
        appState: {
          currentItemStrokeColor: underlineColor,
          currentItemStrokeWidth: underlineStrokeWidth,
          currentItemRoughness: 1,
          currentItemOpacity: underlineOpacity,
        },
      });
      api.setActiveTool({ type: 'line', locked: continuous });
      if (continuous) {
        continuousKind = 'underline';
        originalStyles = previousStyles;
      }

      drawWatcher.start({
        toolType: 'line',
        continuous,
        onCreated: (newElement, elements) => {
          // 直線ツールは、ドラッグせずクリックすると折れ線の作図が始まる。下線として扱わない
          if (continuous && isClickOnly(newElement)) return;
          const grouped = sendUnderlineWithOverlappingText(elements, newElement.id);
          if (grouped !== elements) {
            api.updateScene({ elements: grouped });
          }
        },
        onFinish: () => {
          if (continuous) finishContinuous();
          api.updateScene({ appState: previousStyles });
        },
      });
    };

    /** Tab: 選択図形を 四角形 → ひし形 → 円 の順に変える */
    const handleShapeTransform = () => {
      const allElements = api.getSceneElements();
      const { selectedElementIds } = api.getAppState();
      if (!allElements.some((element) => selectedElementIds[element.id])) return;

      const updatedElements = allElements.map((element) => {
        if (!selectedElementIds[element.id] || !SHAPE_CYCLE.includes(element.type)) {
          return element;
        }
        const nextType = SHAPE_CYCLE[(SHAPE_CYCLE.indexOf(element.type) + 1) % SHAPE_CYCLE.length];
        return { ...element, type: nextType as any };
      });

      api.updateScene({
        elements: updatedElements,
        appState: { ...api.getAppState(), selectedElementIds },
      });
    };

    /** Cmd/Ctrl + M / B: 選択要素（と結び付いたテキスト・矢印）を最前面 / 最背面へ */
    const moveSelection = (toFront: boolean) => {
      const allElements = api.getSceneElements();
      const { selectedElementIds } = api.getAppState();

      const movingIds = new Set<string>();
      for (const element of allElements) {
        if (selectedElementIds[element.id]) {
          movingIds.add(element.id);
          element.boundElements?.forEach((bound) => movingIds.add(bound.id));
        }
      }
      if (movingIds.size === 0) return;

      // 選択要素 → 結び付いた要素の順で並べる（従来どおり）
      const selected = allElements.filter((element) => selectedElementIds[element.id]);
      const bound = allElements.filter((element) => movingIds.has(element.id) && !selectedElementIds[element.id]);
      const moving = [...selected, ...bound];
      const rest = allElements.filter((element) => !movingIds.has(element.id));

      api.updateScene({
        elements: toFront ? [...rest, ...moving] : [...moving, ...rest],
        appState: { ...api.getAppState(), selectedElementIds },
      });
    };

    const runSafely = (label: string, action: () => void | Promise<void>) => {
      try {
        const result = action();
        if (result instanceof Promise) {
          result.catch((error) => console.error(`${label}に失敗しました:`, error));
        }
      } catch (error) {
        console.error(`${label}に失敗しました:`, error);
      }
    };

    /**
     * チェックモードの連続描画中のダブルクリック: テキスト編集を優先する
     * 連続描画を終えて選択ツールへ戻し、ダブルクリックを選択ツールのときと同じように届け直す
     * （1 回目・2 回目のクリックで置いたチェックマークは取り消す）
     */
    const handleDoubleClick = (event: MouseEvent) => {
      if (redispatching || !continuousKind || !isCheckMode()) return;
      const target = event.target as HTMLElement | null;
      if (!target || target.tagName !== 'CANVAS') return;

      event.stopImmediatePropagation();
      event.preventDefault();

      // 1 回目・2 回目のクリックで生まれた要素を取り消す
      // （チェックマーク、直線ツールのクリックで始まった折れ線、大きさのない矩形）
      const now = Date.now();
      const stampIds = new Set(recentStamps.filter(({ time }) => now - time <= DOUBLE_CLICK_WINDOW_MS).map(({ id }) => id));
      const strayType = continuousKind === 'underline' ? 'line' : continuousKind === 'marker' ? 'rectangle' : null;
      const isStrayClick = (element: NonDeletedExcalidrawElement) =>
        element.type === strayType && isClickOnly(element) && now - element.updated <= DOUBLE_CLICK_WINDOW_MS;
      const sceneElements = api.getSceneElements();
      const strays = sceneElements.filter((element) => stampIds.has(element.id) || isStrayClick(element));
      if (strays.length > 0) {
        const strayIds = new Set(strays.map((element) => element.id));
        api.updateScene({
          elements: sceneElements.map((element) => (strayIds.has(element.id) ? { ...element, isDeleted: true } : element)) as any,
        });
      }
      // 作図の途中だった折れ線の状態も捨てる
      api.updateScene({ appState: { multiElement: null, selectedLinearElement: null } as any });

      endContinuous();
      // setActiveTool が反映されてから、本来のダブルクリックを届ける
      setTimeout(() => {
        redispatching = true;
        try {
          target.dispatchEvent(
            new MouseEvent('dblclick', {
              bubbles: true,
              cancelable: true,
              clientX: event.clientX,
              clientY: event.clientY,
              shiftKey: event.shiftKey,
              altKey: event.altKey,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
            }),
          );
        } finally {
          redispatching = false;
        }
      }, 0);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && typeof target.matches === 'function' && target.matches('input, textarea, [contenteditable]')) {
        return;
      }

      const key = event.key.toLowerCase();
      const { onSave, onToggleAnnotationSettings, onToggleShortcutHelp, onToggleCheckMode } = optionsRef.current;

      // Option/Alt + C: チェックモードのオン / オフ（Mac の Option+C は key が 'ç' になるので code で見る）
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyC') {
        event.preventDefault();
        event.stopImmediatePropagation();
        onToggleCheckMode?.();
        return;
      }

      if (event.ctrlKey || event.metaKey) {
        if (key === 's') {
          event.preventDefault();
          event.stopImmediatePropagation();
          onSave?.();
        } else if (key === 'm') {
          event.preventDefault();
          runSafely('最前面移動', () => moveSelection(true));
        } else if (key === 'b') {
          event.preventDefault();
          runSafely('最背面移動', () => moveSelection(false));
        }
        return;
      }

      const actions: Record<string, [string, () => void | Promise<void>]> = {
        '.': ['ショートカット一覧の表示', () => onToggleShortcutHelp?.()],
        c: ['線ツールの設定', handleArrowlessLine],
        n: ['付箋の作成', handleCreateStickyNote],
        w: ['クリップボード付箋の作成', handleCreateClipboardStickyNote],
        m: ['マーカー機能の実行', handleMarker],
        u: ['アンダーライン機能の実行', handleUnderline],
        ',': ['設定パネルの表示', () => onToggleAnnotationSettings?.()],
        tab: ['形状変更', handleShapeTransform],
      };
      const action = actions[key];
      if (action) {
        event.preventDefault();
        runSafely(...action);
      }
    };

    // Excalidraw 本体のショートカットより先に処理するため、キャプチャフェーズで登録
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('dblclick', handleDoubleClick, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('dblclick', handleDoubleClick, true);
      endContinuousRef.current = () => {};
      drawWatcher.cancel();
      stampWatcher.cancel();
    };
  }, [excalidrawAPI, mousePositionRef]);
};
