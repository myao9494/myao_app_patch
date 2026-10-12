/**
 * タイムライン上のマウス位置の追跡
 * 「S」キー（マウス位置のタスク・日付にスケジュールを追加）で、
 * キーを押した時点でマウスが指している行（タスク）と列（日付）を解決するために使う。
 */
import { gantt } from 'dhtmlx-gantt';
import type { TimelineShortcutContext } from '../../utils/ganttTimelineShortcut';
import { resolveTimelineContext } from './ganttTaskUtils';

export interface TimelinePointerTracker {
  /** マウスがタイムライン上にあれば、その位置のタスクと日付を返す */
  getShortcutTarget: () => TimelineShortcutContext | null;
  detach: () => void;
}

/** gantt.init() の後に呼ぶこと（タイムライン要素が必要なため） */
export function trackTimelinePointer(): TimelinePointerTracker {
  const timeline = gantt.$task_data as HTMLElement | undefined;
  if (!timeline) {
    return { getShortcutTarget: () => null, detach: () => {} };
  }

  let isPointerInside = false;
  let lastPosition: { clientX: number; clientY: number } | null = null;
  let lastResolved: TimelineShortcutContext | null = null;

  const resolveAt = (clientX: number, clientY: number) =>
    resolveTimelineContext(clientX, clientY, document.elementFromPoint(clientX, clientY));

  const handlePointer = (event: MouseEvent) => {
    const rect = timeline.getBoundingClientRect();
    isPointerInside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    if (!isPointerInside) return;

    lastPosition = { clientX: event.clientX, clientY: event.clientY };
    lastResolved = resolveAt(event.clientX, event.clientY) ?? lastResolved;
  };

  const handleLeave = () => {
    isPointerInside = false;
  };

  document.addEventListener('mousemove', handlePointer, true);
  document.addEventListener('mousedown', handlePointer, true);
  timeline.addEventListener('mouseleave', handleLeave, true);

  return {
    getShortcutTarget: () => {
      if (!isPointerInside || !lastPosition) return null;
      // スクロール等で位置がずれている可能性があるため、キー入力時点で解決し直す
      return resolveAt(lastPosition.clientX, lastPosition.clientY) ?? lastResolved;
    },
    detach: () => {
      document.removeEventListener('mousemove', handlePointer, true);
      document.removeEventListener('mousedown', handlePointer, true);
      timeline.removeEventListener('mouseleave', handleLeave, true);
    },
  };
}
