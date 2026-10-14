import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * 常に最新の値を指す ref を返す。
 * 一度だけ登録するイベントハンドラ（DHTMLX Gantt や document のリスナー）から、
 * 再登録なしで最新の props / コールバックを参照するために使う。
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
