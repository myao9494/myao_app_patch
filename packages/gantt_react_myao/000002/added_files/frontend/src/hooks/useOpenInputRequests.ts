/**
 * 外部（ランチャー等）からの「タスク入力画面を開く」リクエストを受け取るフック
 *
 * - 5秒ごとにハートビートを送り、このタブが開いていることをバックエンドに知らせる
 *   （Windowsでは、タブが開いていれば新しいタブを開かずに既存ウィンドウを前面に出す判断に使われる）
 * - 1秒ごとにリクエストをポーリングし、未処理のものがあれば Gantt 画面へ切り替えて開かせる
 * - 開けたら ack を送ってバックエンドのリクエストを消す
 */
import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import * as api from '../services/api';

const HEARTBEAT_INTERVAL_MS = 5000;
const REQUEST_POLL_INTERVAL_MS = 1000;
// リロード後に同じリクエストを二重に処理しないよう、処理済みの最大IDをタブ単位で覚えておく
const LAST_HANDLED_REQUEST_KEY = 'gantt_lastOpenInputRequestId';

export interface ExternalOpenTaskRequest {
  requestId: number;
  taskId: number;
  /** 同じリクエストの再試行でも値が変わるようにするための時刻 */
  attempt: number;
}

export function useOpenInputRequests() {
  const location = useLocation();
  const navigate = useNavigate();
  const [request, setRequest] = useState<ExternalOpenTaskRequest | null>(null);
  const [lastHandledRequestId, setLastHandledRequestId] = useState(() =>
    Number(window.sessionStorage.getItem(LAST_HANDLED_REQUEST_KEY) || '0')
  );

  useEffect(() => {
    const sendHeartbeat = () => {
      void api.sendTaskInputOpenClientHeartbeat();
    };

    sendHeartbeat();
    const timerId = window.setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(timerId);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const pollRequest = async () => {
      const result = await api.getTaskInputOpenRequest();
      if (cancelled || !result.success || !result.data) return;

      const pending = result.data;
      if (pending.request_id <= lastHandledRequestId) return;

      setRequest({
        requestId: pending.request_id,
        taskId: pending.task_id,
        attempt: Date.now(),
      });

      if (location.pathname !== '/') {
        navigate('/');
      }
    };

    void pollRequest();
    const timerId = window.setInterval(pollRequest, REQUEST_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timerId);
    };
  }, [lastHandledRequestId, location.pathname, navigate]);

  const markHandled = useCallback((requestId: number) => {
    setLastHandledRequestId((prev) => {
      const next = Math.max(prev, requestId);
      window.sessionStorage.setItem(LAST_HANDLED_REQUEST_KEY, String(next));
      return next;
    });
    void api.acknowledgeTaskInputOpenRequest(requestId);
  }, []);

  return { request, markHandled };
}
