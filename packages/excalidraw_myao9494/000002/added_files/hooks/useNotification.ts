import { useCallback, useEffect, useRef, useState } from 'react';

export interface Notification {
  message: string;
  isError?: boolean;
}

/** 通知の表示時間（エラーは内容を読めるよう長めに表示） */
const DISPLAY_MS = { info: 2000, error: 10000 };

/**
 * 画面右上の通知（保存完了・エラーなど）
 * 新しい通知が来たら前の通知の消去タイマーは取り消す（後の通知が早く消えないように）。
 */
export const useNotification = () => {
  const [notification, setNotification] = useState<Notification | null>(null);
  const timerRef = useRef<number | null>(null);

  const notify = useCallback((message: string, isError: boolean = false) => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    setNotification({ message, isError });
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setNotification(null);
    }, isError ? DISPLAY_MS.error : DISPLAY_MS.info);
  }, []);

  useEffect(() => () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
  }, []);

  return { notification, notify };
};
