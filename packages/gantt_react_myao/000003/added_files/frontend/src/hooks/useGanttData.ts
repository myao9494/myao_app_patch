/**
 * タスク・リンクのデータ管理フック
 * - 初回取得と、更新シーケンスのポーリングによる自動更新（他のタブやランチャーからの変更を反映）
 * - タスク・リンクの作成/更新/削除/複製（APIを呼び、成功したらローカルの state に反映する）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../services/api';
import { formatDateString } from '../constants/gantt';
import type { CreateTaskRequest, Link, Task } from '../types/gantt';

const UPDATE_SEQUENCE_POLL_INTERVAL_MS = 2000;
const DEFAULT_NEW_TASK_DAYS = 7;

export function useGanttData() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 最後に取得したデータに対応する更新シーケンス番号（未取得なら null）
  const knownSequenceRef = useRef<number | null>(null);
  const isFetchingRef = useRef(false);

  const fetchData = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    isFetchingRef.current = true;
    try {
      // シーケンス番号はデータより「先に」読む。
      // 取得中に別の更新が入った場合でも、次のポーリングで差に気づいて取り直せる。
      const sequenceResult = await api.getGanttUpdateSequence();
      const result = await api.getTasks();
      if (result.success && result.data) {
        setTasks(result.data.tasks || []);
        setLinks(result.data.links || []);
        setError(null);
        if (sequenceResult.success && sequenceResult.data) {
          knownSequenceRef.current = sequenceResult.data.sequence;
        }
      } else {
        // 取得に失敗しても、表示中のデータは消さずに残す（一時的な通信断で画面を空にしない）
        setError(result.error || 'データの取得に失敗しました');
      }
    } finally {
      isFetchingRef.current = false;
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData(true);
  }, [fetchData]);

  // 更新シーケンスのポーリングによる自動更新。
  // バックエンドの再起動でシーケンスは 0 に戻るため、大小ではなく「値が変わったか」で判定する。
  useEffect(() => {
    let cancelled = false;

    const checkUpdateSequence = async () => {
      if (isFetchingRef.current) return;
      const result = await api.getGanttUpdateSequence();
      if (cancelled || isFetchingRef.current || !result.success || !result.data) return;

      if (result.data.sequence !== knownSequenceRef.current) {
        await fetchData(false);
      }
    };

    const timerId = window.setInterval(checkUpdateSequence, UPDATE_SEQUENCE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timerId);
    };
  }, [fetchData]);

  // 自分の変更でシーケンスがちょうど1つ進んだだけなら、他の変更は入っていない。
  // ローカルの state は既に最新なので、その番号を既知として扱い、次のポーリングでの再取得を省く。
  // 番号が飛んでいる（他の変更が混じっている）場合は何もせず、ポーリングに取り直させる。
  useEffect(() => {
    return api.observeMutationSequence((sequence) => {
      const known = knownSequenceRef.current;
      if (known !== null && sequence === known + 1) {
        knownSequenceRef.current = sequence;
      }
    });
  }, []);

  // --- タスク ---

  /** タスクを更新する。成功したら true（失敗時はエラーを表示して false） */
  const updateTask = useCallback(async (id: number, taskData: Partial<Task>): Promise<boolean> => {
    const result = await api.updateTask(id, taskData);
    if (result.success && result.data) {
      // バックエンドの応答（実際のDBの状態）をそのまま使い、ローカルの state とDBの一貫性を保つ
      const saved = result.data;
      setTasks((prev) => prev.map((task) => (task.id === id ? { ...task, ...saved } : task)));
      return true;
    }
    setError(`タスクの保存に失敗しました: ${result.error ?? ''}`);
    return false;
  }, []);

  /** タスクを作成し、正しい並び順で表示するため全データを取り直す。作成したタスクを返す */
  const createTask = useCallback(async (taskData: Partial<Task>): Promise<Task | undefined> => {
    const today = new Date();
    const defaultEnd = new Date(today);
    defaultEnd.setDate(defaultEnd.getDate() + DEFAULT_NEW_TASK_DAYS);

    const requestData: CreateTaskRequest = {
      ...taskData,
      text: taskData.text || '新規タスク',
      start_date: taskData.start_date || formatDateString(today),
      end_date: taskData.end_date || formatDateString(defaultEnd),
    };
    const result = await api.createTask(requestData);
    if (result.success && result.data) {
      await fetchData();
      return result.data;
    }
    setError(`タスクの作成に失敗しました: ${result.error ?? ''}`);
    return undefined;
  }, [fetchData]);

  /** タスクと、その子孫をまとめて削除する。成功したら true（失敗時はエラーを表示して false） */
  const deleteTask = useCallback(async (id: number): Promise<boolean> => {
    const result = await api.deleteTask(id);
    if (result.success && result.data) {
      const deletedIds = new Set([result.data.deleted_id, ...result.data.deleted_children]);
      setTasks((prev) => prev.filter((task) => !deletedIds.has(task.id)));
      return true;
    }
    setError(`タスクの削除に失敗しました: ${result.error ?? ''}`);
    return false;
  }, []);

  /** タスクを子孫ごと複製する。targetId を指定するとそのタスクの直後に挿入する */
  const cloneTask = useCallback(async (id: number, targetId?: number): Promise<Task | undefined> => {
    const result = await api.cloneTask(id, targetId);
    if (result.success && result.data) {
      // 子孫も複製されるため、全データを取り直す
      await fetchData();
      return result.data;
    }
    setError(`タスクの複製に失敗しました: ${result.error ?? ''}`);
    return undefined;
  }, [fetchData]);

  // --- リンク ---

  const createLink = useCallback(async (linkData: Omit<Link, 'id'>): Promise<Link | undefined> => {
    const result = await api.createLink(linkData);
    if (result.success && result.data) {
      const newLink = result.data;
      setLinks((prev) => [...prev, newLink]);
      return newLink;
    }
    setError(`リンクの作成に失敗しました: ${result.error ?? ''}`);
    return undefined;
  }, []);

  const updateLink = useCallback(async (id: number, linkData: Partial<Link>) => {
    const result = await api.updateLink(id, linkData);
    if (result.success) {
      setLinks((prev) => prev.map((link) => (link.id === id ? { ...link, ...linkData } : link)));
    } else {
      setError(`リンクの更新に失敗しました: ${result.error ?? ''}`);
    }
  }, []);

  const deleteLink = useCallback(async (id: number) => {
    const result = await api.deleteLink(id);
    if (result.success) {
      setLinks((prev) => prev.filter((link) => link.id !== id));
    } else {
      setError(`リンクの削除に失敗しました: ${result.error ?? ''}`);
    }
  }, []);

  return {
    tasks,
    links,
    loading,
    error,
    fetchData,
    updateTask,
    createTask,
    deleteTask,
    cloneTask,
    createLink,
    updateLink,
    deleteLink,
  };
}
