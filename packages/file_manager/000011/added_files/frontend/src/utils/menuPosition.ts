/**
 * 右クリックメニューの位置
 * - メニューの実際の大きさ（描画後に測る）で、画面の端からはみ出さない位置にする
 * - 項目を足してメニューが伸びても、決め打ちの高さに頼らずに全項目が見えるようにする
 * - 画面より高いときは上端に合わせる（上の項目から見られるように）
 */
import { useLayoutEffect, useState, type RefObject } from "react";

const MARGIN = 8;

export interface MenuSize {
  width: number;
  height: number;
}

export function clampMenuPosition(x: number, y: number, size: MenuSize, viewport: MenuSize): { left: number; top: number } {
  const left = Math.max(MARGIN, Math.min(x, viewport.width - size.width - MARGIN));
  const top = Math.max(MARGIN, Math.min(y, viewport.height - size.height - MARGIN));
  return { left, top };
}

/** 押した位置 (x, y) から、メニューを画面の内側に収めた位置を返す（描画後に大きさを測って直す） */
export function useClampedMenuPosition(ref: RefObject<HTMLElement | null>, x: number, y: number, deps: unknown[] = []) {
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    // 描画したメニューの大きさを測ってから位置を決める
    setPosition(clampMenuPosition(x, y, { width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps は、メニューの中身が変わるとき（リネーム表示など）に測り直すため
  }, [ref, x, y, ...deps]);
  return position;
}
