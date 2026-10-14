/**
 * タスクバー上のスケジュールピン（📌）の操作
 * - 右クリック: スケジュール名の編集・削除メニュー
 * - ドラッグ&ドロップ: 別の日付へ移動（別の行に落とすと、そのタスクのスケジュールへ移す）
 * ピンは ganttTemplates.buildScheduleHtml が出力する data-* 属性付きの要素。
 */
import { useEffect, type RefObject } from 'react';
import { gantt } from 'dhtmlx-gantt';
import type { ContextMenuItem } from './contextMenuItems';
import {
  addOrUpdateSchedule,
  formatDateForSchedule,
  getScheduleAtIndex,
  moveScheduleAtIndex,
  removeScheduleAtIndex,
} from '../../utils/scheduleParser';
import { dateFromClientX, taskIdFromClientY } from './ganttTaskUtils';

// この距離(px)以上動かしたらクリックではなくドラッグとみなす
const DRAG_THRESHOLD_PX = 3;

export interface SchedulePin {
  taskId: number;
  /** task_schedule 内での、そのスケジュールの位置（パース順） */
  sourceIndex: number;
  text: string;
  date: Date;
}

export interface SchedulePinHandlers {
  /** タスクの task_schedule を保存する */
  saveSchedule: (taskId: number, newSchedule: string) => void;
  /** スケジュール編集モーダルを開く */
  editPin: (pin: SchedulePin) => void;
  showContextMenu: (x: number, y: number, items: ContextMenuItem[]) => void;
}

interface PinDragState {
  taskId: number;
  sourceIndex: number;
  startX: number;
  startY: number;
  element: HTMLElement;
  dragged: boolean;
}

function findPinElement(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest('.gantt-schedule-event');
  return element instanceof HTMLElement ? element : null;
}

function readPin(element: HTMLElement): SchedulePin | null {
  const taskId = Number(element.dataset.taskId);
  const sourceIndex = Number(element.dataset.scheduleIndex);
  const date = new Date(`${element.dataset.scheduleDate || ''}T00:00:00`);

  if (!taskId || Number.isNaN(sourceIndex) || Number.isNaN(date.getTime())) {
    return null;
  }
  return { taskId, sourceIndex, text: element.dataset.scheduleText || '', date };
}

export function useSchedulePins(
  containerRef: RefObject<HTMLDivElement | null>,
  handlersRef: RefObject<SchedulePinHandlers>,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let dragState: PinDragState | null = null;

    const handleContextMenu = (event: MouseEvent) => {
      const element = findPinElement(event.target);
      const pin = element && readPin(element);
      if (!pin) return;

      event.preventDefault();
      event.stopPropagation();
      handlersRef.current.showContextMenu(event.clientX, event.clientY, [
        {
          label: 'スケジュール名を編集',
          icon: '✏️',
          action: () => handlersRef.current.editPin(pin),
        },
        {
          label: 'スケジュールを削除',
          icon: '🗑️',
          danger: true,
          action: () => {
            const currentSchedule = gantt.getTask(pin.taskId).task_schedule || '';
            handlersRef.current.saveSchedule(pin.taskId, removeScheduleAtIndex(currentSchedule, pin.sourceIndex));
          },
        },
      ]);
    };

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const element = findPinElement(event.target);
      const pin = element && readPin(element);
      if (!element || !pin) return;

      // タスクバー自体のドラッグ（DHTMLX）を始めさせない
      event.preventDefault();
      event.stopPropagation();
      dragState = {
        taskId: pin.taskId,
        sourceIndex: pin.sourceIndex,
        startX: event.clientX,
        startY: event.clientY,
        element,
        dragged: false,
      };
      element.classList.add('dragging');
    };

    const handleMouseMove = (event: MouseEvent) => {
      if (!dragState) return;

      const deltaX = event.clientX - dragState.startX;
      const deltaY = event.clientY - dragState.startY;
      if (Math.abs(deltaX) > DRAG_THRESHOLD_PX || Math.abs(deltaY) > DRAG_THRESHOLD_PX) {
        dragState.dragged = true;
      }
      dragState.element.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
    };

    const handleMouseUp = (event: MouseEvent) => {
      const finished = dragState;
      if (!finished) return;

      finished.element.classList.remove('dragging');
      finished.element.style.transform = '';
      dragState = null;

      if (!finished.dragged || !gantt.isTaskExists(finished.taskId)) return;

      const targetDate = dateFromClientX(event.clientX);
      if (!targetDate) return;

      const sourceSchedule = gantt.getTask(finished.taskId).task_schedule || '';
      const movedEvent = getScheduleAtIndex(sourceSchedule, finished.sourceIndex);
      if (!movedEvent) return;

      const targetTaskId = taskIdFromClientY(event.clientY) ?? finished.taskId;
      const targetDateStr = formatDateForSchedule(targetDate);
      const { saveSchedule } = handlersRef.current;

      if (targetTaskId === finished.taskId) {
        saveSchedule(finished.taskId, moveScheduleAtIndex(sourceSchedule, finished.sourceIndex, targetDateStr));
        return;
      }

      if (!gantt.isTaskExists(targetTaskId)) return;

      // 別のタスクの行に落とした場合は、元のタスクから外して移動先のタスクに追加する
      const targetSchedule = gantt.getTask(targetTaskId).task_schedule || '';
      saveSchedule(finished.taskId, removeScheduleAtIndex(sourceSchedule, finished.sourceIndex));
      saveSchedule(targetTaskId, addOrUpdateSchedule(targetSchedule, targetDateStr, movedEvent.text));
    };

    container.addEventListener('contextmenu', handleContextMenu, true);
    container.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('mouseup', handleMouseUp, true);

    return () => {
      container.removeEventListener('contextmenu', handleContextMenu, true);
      container.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('mousemove', handleMouseMove, true);
      document.removeEventListener('mouseup', handleMouseUp, true);
    };
  }, [containerRef, handlersRef]);
}
