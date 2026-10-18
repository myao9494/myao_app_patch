/**
 * 一定時間後に自動で消える通知 (Toast.jsx)
 *
 * 仕様:
 * 1. message が変わるたびに3.2秒のタイマーを張り直し、時間経過後に onClose を呼ぶ。
 * 2. 親の再描画で onClose の参照が変わってもタイマーはリセットしない（最新の onClose を ref で保持）。
 **/

import { useEffect, useRef } from 'react';
import { Check } from 'lucide-react';

export function Toast({ message, onClose }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => { const id = setTimeout(() => closeRef.current(), 3200); return () => clearTimeout(id); }, [message]);
  return <div className="toast"><Check size={16}/><span>{message}</span></div>;
}
