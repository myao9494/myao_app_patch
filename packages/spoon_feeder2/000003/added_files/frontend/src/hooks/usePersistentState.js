/**
 * localStorage に自動保存する state (usePersistentState.js)
 *
 * 仕様:
 * 1. 初回は localStorage から読み出し（read で文字列→値へ変換）、変更のたびに保存する。
 * 2. localStorage が使えない環境（プライベートモード等）でも例外にせず、メモリ上の state として動作する。
 **/

import { useEffect, useState } from 'react';

const readStorage = key => { try { return localStorage.getItem(key); } catch { return null; } };
const writeStorage = (key, value) => { try { localStorage.setItem(key, value); } catch { /* 保存できなくても動作は継続する */ } };

export function usePersistentState(key, defaultValue, read = raw => raw ?? defaultValue) {
  const [value, setValue] = useState(() => read(readStorage(key)));
  useEffect(() => { writeStorage(key, String(value)); }, [key, value]);
  return [value, setValue];
}
