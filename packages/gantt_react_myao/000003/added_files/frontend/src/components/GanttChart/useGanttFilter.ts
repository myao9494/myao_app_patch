/**
 * フィルタの反映。表示対象のタスクIDを事前計算し、対象が変わったときだけ gantt を再描画する。
 * 親タスクを維持して、マッチした子タスクが孤立しないようにする（判定は filterUtils）。
 * gantt の初期化後に反映するため、必ず初期化の useEffect より後に呼ぶこと。
 */
import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { gantt } from 'dhtmlx-gantt';
import type { Task, TaskFilter } from '../../types/gantt';
import { buildTaskFilterIndexes, computeVisibleTaskIds } from '../../utils/filterUtils';

interface UseGanttFilterOptions {
  initialized: RefObject<boolean>;
  tasks: Task[];
  filter?: TaskFilter;
  synonyms: string[][];
  /** onBeforeTaskDisplay から参照される、表示対象のタスクID（このフックが更新する） */
  visibleTaskIdsRef: RefObject<Set<number>>;
}

export function useGanttFilter({ initialized, tasks, filter, synonyms, visibleTaskIdsRef }: UseGanttFilterOptions): void {
  const visibleSignatureRef = useRef('');
  const refreshFrameRef = useRef<number | null>(null);

  const taskFilterIndexes = useMemo(() => buildTaskFilterIndexes(tasks, synonyms), [tasks, synonyms]);

  useEffect(() => {
    if (!initialized.current) return;

    const visibleTaskIds = computeVisibleTaskIds(tasks, filter, taskFilterIndexes, synonyms);
    visibleTaskIdsRef.current = visibleTaskIds;

    let visibleSignature = '';
    for (const task of tasks) {
      if (visibleTaskIds.has(task.id)) {
        visibleSignature += `${task.id},`;
      }
    }
    if (visibleSignatureRef.current === visibleSignature) {
      return;
    }
    visibleSignatureRef.current = visibleSignature;

    if (refreshFrameRef.current !== null) {
      cancelAnimationFrame(refreshFrameRef.current);
    }
    refreshFrameRef.current = requestAnimationFrame(() => {
      refreshFrameRef.current = null;
      gantt.refreshData();
    });
  }, [initialized, tasks, taskFilterIndexes, synonyms, filter, visibleTaskIdsRef]);

  // アンマウント時（gantt を作り直す前）に、保留中の再描画を取り消し、次回は必ず反映させる
  useEffect(() => {
    return () => {
      if (refreshFrameRef.current !== null) {
        cancelAnimationFrame(refreshFrameRef.current);
        refreshFrameRef.current = null;
      }
      visibleSignatureRef.current = '';
    };
  }, []);
}
