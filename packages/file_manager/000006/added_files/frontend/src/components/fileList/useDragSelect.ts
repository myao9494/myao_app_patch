/**
 * ファイル一覧の範囲選択（ラバーバンド選択）
 * - 余白からドラッグした矩形に重なる行を選択に追加する（行は data-path 属性でパスを持つ）
 * - Shift を押しながらなら行の上からでも開始できる（ボタン・入力欄・リンクの上は除く）
 * - 5px 未満の小さなドラッグはクリックとみなして選択を変えない
 * - ペインの外でマウスを離しても確定する
 */
import { useEffect, useEffectEvent, useState, type MouseEvent, type RefObject } from "react";

export interface Box {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

interface DragSelectOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  selectedItems: Set<string>;
  setSelectedItems: (items: Set<string>) => void;
}

export function boxRect(box: Box) {
  return {
    left: Math.min(box.startX, box.endX),
    top: Math.min(box.startY, box.endY),
    width: Math.abs(box.endX - box.startX),
    height: Math.abs(box.endY - box.startY),
  };
}

export function useDragSelect({ containerRef, selectedItems, setSelectedItems }: DragSelectOptions) {
  const [selectionBox, setSelectionBox] = useState<Box | null>(null);
  const [isShiftDragSelecting, setIsShiftDragSelecting] = useState(false);
  const isDragSelecting = selectionBox !== null;

  const pointInContainer = (e: MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    return rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : null;
  };

  const handleMouseDown = (e: MouseEvent) => {
    // コンテナにフォーカスを当てる（これによりキーボードイベントを受け取れる）
    containerRef.current?.focus();
    if (e.button !== 0) return;

    const target = e.target as HTMLElement;
    if (e.shiftKey) {
      if (target.closest("button, input, a")) return;
      // テキスト選択や行のドラッグを防ぐ
      e.preventDefault();
    } else if (target.closest("button, input, a, .file-table tr")) {
      return;
    }

    const point = pointInContainer(e);
    if (!point) return;
    setIsShiftDragSelecting(e.shiftKey);
    setSelectionBox({ startX: point.x, startY: point.y, endX: point.x, endY: point.y });
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!selectionBox) return;
    const point = pointInContainer(e);
    if (!point) return;
    setSelectionBox({ ...selectionBox, endX: point.x, endY: point.y });
  };

  const finishSelection = () => {
    const container = containerRef.current;
    const box = selectionBox;
    setSelectionBox(null);
    setIsShiftDragSelecting(false);
    if (!box || !container) return;

    const { left, top, width, height } = boxRect(box);
    if (width < 5 && height < 5) return;

    // 矩形はコンテナ内の座標なので、行の位置もコンテナ基準（スクロール込み）に直して比べる
    const containerRect = container.getBoundingClientRect();
    const newSelected = new Set(selectedItems);
    container.querySelectorAll(".file-table tbody tr").forEach((row) => {
      const rowRect = row.getBoundingClientRect();
      const rowTop = rowRect.top - containerRect.top + container.scrollTop;
      const rowLeft = rowRect.left - containerRect.left + container.scrollLeft;
      const intersects =
        rowLeft < left + width &&
        rowLeft + rowRect.width > left &&
        rowTop < top + height &&
        rowTop + rowRect.height > top;
      const path = row.getAttribute("data-path");
      if (intersects && path) {
        newSelected.add(path);
      }
    });
    setSelectedItems(newSelected);
  };

  // ペインの外でマウスを離した場合も確定する
  const onWindowMouseUp = useEffectEvent(() => finishSelection());
  useEffect(() => {
    if (!isDragSelecting) return;
    const listener = () => onWindowMouseUp();
    window.addEventListener("mouseup", listener);
    return () => window.removeEventListener("mouseup", listener);
  }, [isDragSelecting]);

  return {
    selectionBox,
    isShiftDragSelecting,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp: finishSelection,
  };
}

