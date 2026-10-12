import { useEffect, useRef, type MutableRefObject } from 'react';

/** マウス位置（クライアント座標系） */
export interface MousePosition {
  x: number;
  y: number;
}

/**
 * マウス位置を追跡するフック
 *
 * 付箋をマウス位置に作成するために使う。マウス移動のたびに再レンダリングしないよう、
 * state ではなく ref で保持する（読むときは `ref.current`）。
 */
export const useMousePosition = (): MutableRefObject<MousePosition> => {
  const positionRef = useRef<MousePosition>({ x: 0, y: 0 });

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      positionRef.current = { x: event.clientX, y: event.clientY };
    };
    document.addEventListener('mousemove', handleMouseMove);
    return () => document.removeEventListener('mousemove', handleMouseMove);
  }, []);

  return positionRef;
};
