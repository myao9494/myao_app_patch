import { useState, type Dispatch, type SetStateAction } from 'react';

/**
 * 外部の値（props など）で初期化し、その値が変わったら追従するローカル state。
 * 入力欄のように「編集中はローカルの値を持ち、外部から値が変えられたらそれに合わせる」用途に使う。
 */
export function useSyncedState<T>(source: T): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState(source);
  const [previousSource, setPreviousSource] = useState(source);
  if (source !== previousSource) {
    setPreviousSource(source);
    setState(source);
  }
  return [state, setState];
}
