import { useEffect } from 'react';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useMousePosition } from './useMousePosition';
import { createDefaultStickyNote, createLinkStickyNote } from '../utils/stickyNoteUtils';
import { toggleMarkerForElements, sendMarkerBehindOverlappingText, MARKER_COLOR, DEFAULT_MARKER_OPACITY } from '../utils/markerUtils';
import { toggleUnderlineForElements, sendUnderlineWithOverlappingText, UNDERLINE_COLOR, DEFAULT_UNDERLINE_STROKE_WIDTH } from '../utils/underlineUtils';
import type { AnnotationSettings } from '../utils/annotationSettings';

/**
 * キーボードショートカット機能のオプション
 */
export interface KeyboardShortcutsOptions {
  /** ExcalidrawのAPIインスタンス */
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  /** ビューポート座標をシーン座標に変換する関数 */
  viewportCoordsToSceneCoords: (coords: { clientX: number; clientY: number }, appState: any) => { x: number; y: number };
  /** 保存ショートカット用のコールバック関数 */
  onSave?: () => void;
  /** アノテーション設定パネルの開閉トグルコールバック */
  onToggleAnnotationSettings?: () => void;
  /** ショートカット一覧ヘルプの開閉トグルコールバック */
  onToggleShortcutHelp?: () => void;
  /** マーカー・アンダーラインの現在設定 */
  annotationSettings?: AnnotationSettings;
}

/**
 * カスタムキーボードショートカット機能を提供するフック
 * 
 * 以下の機能を提供：
 * - .: ショートカット一覧ヘルプの表示/非表示
 * - C: 矢印なしの直線描画
 * - N: 基本付箋作成
 * - W: クリップボードからリンク付箋作成
 * - M: マーカー機能（選択テキストにハイライト付与/解除、未選択時はマーカー描画ツール起動）
 * - U: アンダーライン機能（選択テキストに赤色下線付与/解除、未選択時は赤色直線ツール起動・描画後スタイル自動復元）
 * - ,: マーカーとアンダーラインの設定パネルの開閉トグル
 * - Tab: 選択されたオブジェクトの形状を順番に変更（四角形 → ひし形 → 円 → ...）
 * - Cmd/Ctrl + M: 選択要素を最前面に移動
 * - Cmd/Ctrl + B: 選択要素を最背面に移動
 * 
 * @param options - キーボードショートカットのオプション
 */
export const useKeyboardShortcuts = ({
  excalidrawAPI,
  viewportCoordsToSceneCoords,
  onSave,
  onToggleAnnotationSettings,
  onToggleShortcutHelp,
  annotationSettings,
}: KeyboardShortcutsOptions) => {
  const mousePosition = useMousePosition();

  useEffect(() => {
    if (!excalidrawAPI) return;

    /**
     * キーボードイベントハンドラー
     * @param event - KeyboardEventオブジェクト
     */
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // 入力フィールドにフォーカスがある場合は処理をスキップ
      const isInputFocused = Boolean(target && typeof target.matches === 'function' && target.matches('input, textarea, [contenteditable]'));

      if (isInputFocused) return;

      const key = event.key.toLowerCase();
      const isCtrlOrCmd = event.ctrlKey || event.metaKey;

      // Cmd/Ctrl + S: 保存
      if (isCtrlOrCmd && key === 's') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (onSave) {
          onSave();
        }
        return;
      }

      // Cmd/Ctrl + M: 最前面に移動
      if (isCtrlOrCmd && key === 'm') {
        event.preventDefault();
        handleMoveToFront();
        return;
      }

      // Cmd/Ctrl + B: 最背面に移動
      if (isCtrlOrCmd && key === 'b') {
        event.preventDefault();
        handleMoveToBack();
        return;
      }

      // 他のCtrl/Cmdキーの組み合わせは処理をスキップ
      if (isCtrlOrCmd) return;

      switch (key) {
        case '.':
          event.preventDefault();
          if (onToggleShortcutHelp) {
            onToggleShortcutHelp();
          }
          break;
        case 'c':
          event.preventDefault();
          handleArrowlesLine();
          break;
        case 'n':
          event.preventDefault();
          handleCreateStickyNote();
          break;
        case 'w':
          event.preventDefault();
          handleCreateClipboardStickyNote();
          break;
        case 'm':
          event.preventDefault();
          handleMarker();
          break;
        case 'u':
          event.preventDefault();
          handleUnderline();
          break;
        case ',':
          event.preventDefault();
          if (onToggleAnnotationSettings) {
            onToggleAnnotationSettings();
          }
          break;
        case 'tab':
          event.preventDefault();
          handleShapeTransform();
          break;
      }
    };

    /**
     * Cキー: 矢印なしの直線描画機能
     * 
     * 矢印ツールを選択し、要素作成後に矢印ヘッドを無効化することで
     * 矢印なしの直線を描画可能にする。
     */
    const handleArrowlesLine = () => {
      try {
        const currentElementsCount = excalidrawAPI.getSceneElements().length;

        // 矢印ツールを選択
        excalidrawAPI.setActiveTool({
          type: 'arrow',
          locked: false,
        });

        /**
         * 新しい要素が作成されたかチェックし、矢印ヘッドを無効化
         */
        const checkNewElement = () => {
          const elements = excalidrawAPI.getSceneElements();
          if (elements.length > currentElementsCount) {
            const newElement = elements[elements.length - 1];
            if (newElement.type === 'arrow') {
              // 矢印ヘッドを無効化
              (newElement as any).startArrowhead = null;
              (newElement as any).endArrowhead = null;
              
              excalidrawAPI.updateScene({
                elements: elements
              });
            }
            document.removeEventListener('pointerup', checkNewElement);
          }
        };

        // ポインターアップイベントで新要素をチェック
        document.addEventListener('pointerup', checkNewElement);
      } catch (error) {
        console.error('線ツールの設定に失敗しました:', error);
      }
    };

    /**
     * Nキー: 基本付箋作成機能
     * 
     * 現在のマウス位置に黄色の基本付箋を作成し、
     * 作成後にテキスト要素を選択状態にする。
     */
    const handleCreateStickyNote = () => {
      try {
        const appState = excalidrawAPI.getAppState();
        // マウス位置をシーン座標に変換
        const sceneCoords = viewportCoordsToSceneCoords(
          { clientX: mousePosition.x, clientY: mousePosition.y },
          appState
        );

        // 基本付箋を作成
        const stickyNoteElements = createDefaultStickyNote(sceneCoords.x, sceneCoords.y);
        const textElement = stickyNoteElements[1];

        // シーンを更新し、テキスト要素を選択状態に
        excalidrawAPI.updateScene({
          elements: [...excalidrawAPI.getSceneElements(), ...stickyNoteElements],
          appState: {
            ...appState,
            selectedElementIds: { [textElement.id]: true }
          }
        });
      } catch (error) {
        console.error('付箋の作成に失敗しました:', error);
      }
    };

    /**
     * Wキー: クリップボードからリンク付箋作成機能
     * 
     * クリップボードの内容を取得し、ファイルパスやURLの場合は
     * 適切なリンクテキストを生成してリンク付箋を作成する。
     */
    const handleCreateClipboardStickyNote = async () => {
      try {
        const clipboardText = await navigator.clipboard.readText();
        if (!clipboardText) return;

        const appState = excalidrawAPI.getAppState();
        // マウス位置をシーン座標に変換
        const sceneCoords = viewportCoordsToSceneCoords(
          { clientX: mousePosition.x, clientY: mousePosition.y },
          appState
        );

        let linkText = clipboardText;
        // ファイル名を表示テキストとして抽出
        let displayText = decodeURIComponent(clipboardText.split(/[\/\\]/).pop() || clipboardText);

        // ファイル種別に応じてコマンドプレフィックスを追加
        if (clipboardText.toLowerCase().endsWith('.py')) {
          linkText = `cmd python ${clipboardText}`;
        } else if (clipboardText.toLowerCase().endsWith('.sh') || clipboardText.toLowerCase().endsWith('.bat')) {
          linkText = `cmd ${clipboardText}`;
        }

        // リンク付箋を作成
        const stickyNoteElements = createLinkStickyNote(sceneCoords.x, sceneCoords.y, displayText, linkText);
        const textElement = stickyNoteElements[1];

        // シーンを更新し、テキスト要素を選択状態に
        excalidrawAPI.updateScene({
          elements: [...excalidrawAPI.getSceneElements(), ...stickyNoteElements],
          appState: {
            ...appState,
            selectedElementIds: { [textElement.id]: true }
          }
        });
      } catch (error) {
        console.error('クリップボード付箋の作成に失敗しました:', error);
      }
    };

    /**
     * Mキー: マーカー機能
     * 
     * - テキスト要素が選択されている場合: 文字の下半分に重なる手書き風マーカーを自動生成して背面に配置（すでに存在する場合はトグル解除）
     * - 選択されていない場合: フリーハンド（freedraw）マーカーツールに切り替え、太線・半透明黄色のスタイルを設定
     */
    const handleMarker = () => {
      try {
        const appState = excalidrawAPI.getAppState();
        const selectedElementIds = appState.selectedElementIds;
        const allElements = excalidrawAPI.getSceneElements();

        // 選択されたテキスト要素があるか確認
        const hasSelectedText = allElements.some(
          (el) => selectedElementIds[el.id] && el.type === 'text' && !el.isDeleted
        );

        const markerColor = annotationSettings?.marker.color ?? MARKER_COLOR;
        const markerOpacity = annotationSettings?.marker.opacity ?? DEFAULT_MARKER_OPACITY;

        if (hasSelectedText) {
          // テキスト要素にマーカーを付加・トグル解除
          const { updatedElements } = toggleMarkerForElements(allElements, selectedElementIds, {
            color: markerColor,
            opacity: markerOpacity,
          });
          excalidrawAPI.updateScene({
            elements: updatedElements,
          });
        } else {
          // 何も選択されていない場合はマーカー矩形描画ツールを起動
          const currentElementsCount = allElements.length;

          // 描画前のスタイルを退避
          const previousStyles = {
            currentItemStrokeColor: appState.currentItemStrokeColor,
            currentItemBackgroundColor: appState.currentItemBackgroundColor,
            currentItemFillStyle: appState.currentItemFillStyle,
            currentItemRoughness: appState.currentItemRoughness,
            currentItemRoundness: appState.currentItemRoundness,
            currentItemOpacity: appState.currentItemOpacity,
          };

          // マーカー用のスタイルを設定（activeToolを上書きしないよう...appStateは展開しない）
          excalidrawAPI.updateScene({
            appState: {
              currentItemBackgroundColor: markerColor,
              currentItemFillStyle: 'solid',
              currentItemStrokeColor: 'transparent',
              currentItemRoughness: 1,
              currentItemRoundness: 'round',
              currentItemOpacity: markerOpacity,
            },
          });

          // 矩形ツールを選択（updateSceneの後に呼ぶことで確実にactiveToolがrectangleになる）
          excalidrawAPI.setActiveTool({
            type: 'rectangle',
            locked: false,
          });

          /**
           * 矩形描画完了時にテキストとの重なりを判定し、自動で背面に送る。
           * また、元の描画スタイルを復元する。
           */
          const checkNewMarkerElement = () => {
            const currentElements = excalidrawAPI.getSceneElements();
            if (currentElements.length > currentElementsCount) {
              const newElement = currentElements[currentElements.length - 1];
              if (newElement.type === 'rectangle') {
                // 重なるテキスト要素があれば背面に送る
                const reorderedElements = sendMarkerBehindOverlappingText(
                  currentElements,
                  newElement.id
                );
                if (reorderedElements !== currentElements) {
                  excalidrawAPI.updateScene({
                    elements: reorderedElements,
                  });
                }
              }
              // マーカー描画完了後、元の描画スタイルを復元
              excalidrawAPI.updateScene({
                appState: previousStyles,
              });
              document.removeEventListener('pointerup', checkNewMarkerElement);
            }
          };

          // ポインターアップイベントで新要素をチェック
          document.addEventListener('pointerup', checkNewMarkerElement);
        }
      } catch (error) {
        console.error('マーカー機能の実行に失敗しました:', error);
      }
    };

    /**
     * Uキー: テキスト要素のアンダーライン（赤色下線）機能
     * 
     * 1. テキスト要素が選択されている場合:
     *    - 選択されたテキストの下端に赤色直線アンダーライン（line）を自動生成しグループ化。
     *    - すでにアンダーラインが存在する場合はトグル解除（削除）。
     * 2. テキスト要素が選択されていない場合:
     *    - 直線ツール（line）を選択し、設定された色・太さ・透明度を適用。
     *    - 描画完了時（pointerup時）に、重なる/近接するテキスト要素があれば自動でグループ化。
     *    - 描画完了後、直前の描画スタイル（文字色/枠線色、太さなど）を自動復元。
     */
    const handleUnderline = () => {
      try {
        const appState = excalidrawAPI.getAppState();
        const selectedElementIds = appState.selectedElementIds || {};
        const allElements = excalidrawAPI.getSceneElements();

        // 選択中の要素のうちテキスト要素があるか確認
        const hasSelectedText = allElements.some(
          (el) => selectedElementIds[el.id] && el.type === 'text' && !el.isDeleted
        );

        const underlineColor = annotationSettings?.underline.color ?? UNDERLINE_COLOR;
        const underlineStrokeWidth = annotationSettings?.underline.strokeWidth ?? DEFAULT_UNDERLINE_STROKE_WIDTH;
        const underlineOpacity = annotationSettings?.underline.opacity ?? 100;

        if (hasSelectedText) {
          // テキスト要素が選択されている場合はトグル実行
          const { updatedElements } = toggleUnderlineForElements(allElements, selectedElementIds, {
            color: underlineColor,
            strokeWidth: underlineStrokeWidth,
          });
          excalidrawAPI.updateScene({
            elements: updatedElements,
          });
        } else {
          // 何も選択されていない場合は赤色アンダーライン直線描画ツールを起動
          const currentElementsCount = allElements.length;

          // 描画前のスタイルを退避
          const previousStyles = {
            currentItemStrokeColor: appState.currentItemStrokeColor,
            currentItemStrokeWidth: appState.currentItemStrokeWidth,
            currentItemRoughness: appState.currentItemRoughness,
            currentItemOpacity: appState.currentItemOpacity,
          };

          // アンダーライン用のスタイルを設定（activeToolを上書きしないよう...appStateは展開しない）
          excalidrawAPI.updateScene({
            appState: {
              currentItemStrokeColor: underlineColor,
              currentItemStrokeWidth: underlineStrokeWidth,
              currentItemRoughness: 1,
              currentItemOpacity: underlineOpacity,
            },
          });

          // 直線ツールを選択（updateSceneの後に呼ぶことで確実にactiveToolがlineになる）
          excalidrawAPI.setActiveTool({
            type: 'line',
            locked: false,
          });

          /**
           * 直線描画完了時にテキストとの近接を判定し、グループ化する。
           * また、元の描画スタイルを復元する。
           */
          const checkNewUnderlineElement = () => {
            const currentElements = excalidrawAPI.getSceneElements();
            if (currentElements.length > currentElementsCount) {
              const newElement = currentElements[currentElements.length - 1];
              if (newElement.type === 'line') {
                // 近接・重なるテキスト要素があればグループ化
                const reorderedElements = sendUnderlineWithOverlappingText(
                  currentElements,
                  newElement.id
                );
                if (reorderedElements !== currentElements) {
                  excalidrawAPI.updateScene({
                    elements: reorderedElements,
                  });
                }
              }
              // アンダーライン描画完了後、元の描画スタイルを復元
              excalidrawAPI.updateScene({
                appState: previousStyles,
              });
              document.removeEventListener('pointerup', checkNewUnderlineElement);
            }
          };

          // ポインターアップイベントで新要素をチェック
          document.addEventListener('pointerup', checkNewUnderlineElement);
        }
      } catch (error) {
        console.error('アンダーライン機能の実行に失敗しました:', error);
      }
    };

    /**
     * Tabキー: 選択されたオブジェクトの形状変更機能
     * 
     * 選択されたオブジェクトの形状を順番に変更する。
     * 変更順序: 四角形 → ひし形 → 円 → 四角形（ループ）
     * 選択されたオブジェクトがない場合は何もしない。
     */
    const handleShapeTransform = () => {
      try {
        const allElements = excalidrawAPI.getSceneElements();
        const selectedElementIds = excalidrawAPI.getAppState().selectedElementIds;
        
        // 選択された要素を取得
        const selectedElements = allElements.filter(element => 
          selectedElementIds[element.id]
        );

        if (selectedElements.length === 0) return;

        // 形状変更可能な要素のタイプ定義
        const shapeTypes = ['rectangle', 'diamond', 'ellipse'];
        
        // 更新された要素を格納する配列
        const updatedElements = allElements.map(element => {
          // 選択されている要素で、かつ形状変更可能な場合のみ処理
          if (selectedElementIds[element.id] && shapeTypes.includes(element.type)) {
            const currentIndex = shapeTypes.indexOf(element.type);
            const nextIndex = (currentIndex + 1) % shapeTypes.length;
            const nextType = shapeTypes[nextIndex];
            
            return {
              ...element,
              type: nextType as any
            };
          }
          return element;
        });

        // シーンを更新
        excalidrawAPI.updateScene({
          elements: updatedElements,
          appState: {
            ...excalidrawAPI.getAppState(),
            selectedElementIds: selectedElementIds
          }
        });
      } catch (error) {
        console.error('形状変更に失敗しました:', error);
      }
    };

    /**
     * Cmd/Ctrl + M: 選択要素を最前面に移動
     * 
     * 選択された要素とその関連するテキスト要素を特定し、
     * 要素配列の末尾に移動して最前面に表示する。
     */
    const handleMoveToFront = () => {
      try {
        const allElements = excalidrawAPI.getSceneElements();
        const selectedElementIds = excalidrawAPI.getAppState().selectedElementIds;

        // 選択された要素を取得
        let selectedElements = allElements.filter(element => 
          selectedElementIds[element.id]
        );

        // 選択された要素に紐づくテキスト要素のIDを収集
        const boundElementIds = new Set();
        selectedElements.forEach(element => {
          if (element.boundElements) {
            element.boundElements.forEach(bound => {
              boundElementIds.add(bound.id);
            });
          }
        });

        // 選択された要素と紐づくテキスト要素を結合
        selectedElements = [
          ...selectedElements,
          ...allElements.filter(element => boundElementIds.has(element.id))
        ];

        if (selectedElements.length === 0) return;

        // 選択されていない要素を取得
        const nonSelectedElements = allElements.filter(
          element => !selectedElements.some(selected => selected.id === element.id)
        );

        // 選択された要素を配列の末尾に配置（最前面）
        const newElements = [...nonSelectedElements, ...selectedElements];

        excalidrawAPI.updateScene({
          elements: newElements,
          appState: {
            ...excalidrawAPI.getAppState(),
            selectedElementIds: selectedElementIds
          }
        });
      } catch (error) {
        console.error('最前面移動に失敗しました:', error);
      }
    };

    /**
     * Cmd/Ctrl + B: 選択要素を最背面に移動
     * 
     * 選択された要素とその関連するテキスト要素を特定し、
     * 要素配列の先頭に移動して最背面に表示する。
     */
    const handleMoveToBack = () => {
      try {
        const allElements = excalidrawAPI.getSceneElements();
        const selectedElementIds = excalidrawAPI.getAppState().selectedElementIds;

        // 選択された要素を取得
        let selectedElements = allElements.filter(element => 
          selectedElementIds[element.id]
        );

        // 選択された要素に紐づくテキスト要素のIDを収集
        const boundElementIds = new Set();
        selectedElements.forEach(element => {
          if (element.boundElements) {
            element.boundElements.forEach(bound => {
              boundElementIds.add(bound.id);
            });
          }
        });

        // 選択された要素と紐づくテキスト要素を結合
        selectedElements = [
          ...selectedElements,
          ...allElements.filter(element => boundElementIds.has(element.id))
        ];

        if (selectedElements.length === 0) return;

        // 選択されていない要素を取得
        const nonSelectedElements = allElements.filter(
          element => !selectedElements.some(selected => selected.id === element.id)
        );

        // 選択された要素を配列の先頭に配置（最背面）
        const newElements = [...selectedElements, ...nonSelectedElements];

        excalidrawAPI.updateScene({
          elements: newElements,
          appState: {
            ...excalidrawAPI.getAppState(),
            selectedElementIds: selectedElementIds
          }
        });
      } catch (error) {
        console.error('最背面移動に失敗しました:', error);
      }
    };

    // キーボードイベントリスナーを登録（キャプチャフェーズで実行）
    document.addEventListener('keydown', handleKeyDown, true);

    // クリーンアップ関数：コンポーネントがアンマウントされる際にイベントリスナーを削除
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [excalidrawAPI, mousePosition, viewportCoordsToSceneCoords, onSave]);
};
