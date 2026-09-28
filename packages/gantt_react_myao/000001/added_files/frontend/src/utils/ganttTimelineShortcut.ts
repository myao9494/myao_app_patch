/**
 * ガントチャートのタイムライン（カレンダー領域）における行列座標解決ユーティリティ
 * - マウス座標（X: 列, Y: 行）から該当列のカレンダー日付と該当行のタスクIDを特定する
 * - タスクバーの要素クリック、空きセル（背景セル）クリックの両方に対応
 * - スケジュール追加やショートカット操作（Sキー）の対象コンテキスト解決に使用
 */

export interface TimelineShortcutContext {
  taskId: number;
  date: Date;
}

function toDateOnly(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isValidDate(date: Date | null): date is Date {
  return !!date && !Number.isNaN(date.getTime());
}

export function resolveTimelineShortcutContext(params: {
  eventTarget: EventTarget | null;
  clientX: number;
  timelineElement: HTMLElement;
  taskAttribute: string;
  dateFromPos: (x: number) => Date | null;
}): TimelineShortcutContext | null {
  const { eventTarget, clientX, timelineElement, taskAttribute, dateFromPos } = params;

  if (!(eventTarget instanceof Element)) {
    return null;
  }

  if (!eventTarget.closest('.gantt_task_data')) {
    return null;
  }

  const taskHost = eventTarget.closest(`[${taskAttribute}]`);
  const taskId = taskHost?.getAttribute(taskAttribute);
  if (!taskId) {
    return null;
  }

  const rect = timelineElement.getBoundingClientRect();
  const relativeX = clientX - rect.left + timelineElement.scrollLeft;
  const date = dateFromPos(relativeX);

  if (!isValidDate(date)) {
    return null;
  }

  return {
    taskId: Number(taskId),
    date: toDateOnly(date),
  };
}

export interface ResolveTimelineCellParams {
  clientX: number;
  clientY: number;
  timelineElement: HTMLElement;
  taskAttribute?: string;
  eventTarget?: EventTarget | null;
  dateFromPos: (x: number) => Date | null;
  getItemIndexByTopPosition?: (top: number) => number;
  getTaskByIndex?: (index: number) => { id: string | number } | null | undefined;
  locateTask?: (target: HTMLElement) => string | number | null;
}

/**
 * カレンダー対象部のマウス座標から、行（タスクID）と列（日付）を行列から解決する
 */
export function resolveTimelineCellContext(params: ResolveTimelineCellParams): TimelineShortcutContext | null {
  const {
    clientX,
    clientY,
    timelineElement,
    taskAttribute,
    eventTarget,
    dateFromPos,
    getItemIndexByTopPosition,
    getTaskByIndex,
    locateTask,
  } = params;

  // タイムライン要素の矩形情報から列（X: 日付）を算出
  const rect = timelineElement.getBoundingClientRect();
  const relativeX = clientX - rect.left + timelineElement.scrollLeft;
  const date = dateFromPos(relativeX);

  if (!isValidDate(date)) {
    return null;
  }

  // 行（Y: タスクID）の特定
  let rawTaskId: string | number | null = null;

  // 1. タスクバーまたは要素自体からタスクIDを検出
  if (eventTarget instanceof Element) {
    if (taskAttribute) {
      const taskHost = eventTarget.closest(`[${taskAttribute}]`);
      if (taskHost) {
        rawTaskId = taskHost.getAttribute(taskAttribute);
      }
    }
    if (!rawTaskId && locateTask && eventTarget instanceof HTMLElement) {
      rawTaskId = locateTask(eventTarget);
    }
  }

  // 2. 要素から取れない場合、Y座標（スクロール考慮）から行インデックスとタスクを算出
  if (!rawTaskId && getItemIndexByTopPosition && getTaskByIndex) {
    const relativeY = clientY - rect.top + timelineElement.scrollTop;
    const rowIndex = getItemIndexByTopPosition(relativeY);
    if (typeof rowIndex === 'number' && rowIndex >= 0) {
      const task = getTaskByIndex(rowIndex);
      if (task?.id != null) {
        rawTaskId = task.id;
      }
    }
  }

  if (rawTaskId == null || rawTaskId === '') {
    return null;
  }

  const taskIdNum = Number(rawTaskId);
  if (Number.isNaN(taskIdNum)) {
    return null;
  }

  return {
    taskId: taskIdNum,
    date: toDateOnly(date),
  };
}
