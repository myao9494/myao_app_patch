/**
 * ガントチャート（DHTMLX Gantt）のタスクを扱う小さなヘルパー群
 * - APIのタスク（日付は文字列）⇔ Gantt内部のタスク（日付は Date）の変換
 * - 階層パス・ハイパーリンク・複数選択・タイムライン上の座標解決
 */
import { gantt } from 'dhtmlx-gantt';
import type { Task as GanttTask } from 'dhtmlx-gantt';
import type { Task } from '../../types/gantt';
import { formatDateString } from '../../constants/gantt';
import { escapeHtml } from '../../utils/taskText';
import {
  resolveTimelineCellContext,
  type TimelineShortcutContext,
} from '../../utils/ganttTimelineShortcut';

export type GanttId = string | number;

/** ローカルファイルを開くための外部 open-path API（既定はポート8001。VITE_OPEN_PATH_API_URL で変更できる） */
const OPEN_PATH_API_URL = import.meta.env.VITE_OPEN_PATH_API_URL || 'http://localhost:8001/api/fullpath';

/** "YYYY-MM-DD HH:mm:ss" 形式の文字列を Date に変換する（不正な値は undefined） */
export function parseTaskDate(value: string | Date | null | undefined): Date | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value;
  const parsed = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * APIのタスクをGanttに渡す形へ変換する。
 * DHTMLX Gantt内部の "date.getFullYear is not a function" エラーを避けるため、日付は必ず Date にする。
 */
export function toGanttTask(task: Task) {
  return {
    ...task,
    start_date: parseTaskDate(task.start_date),
    end_date: parseTaskDate(task.end_date),
    open: task.expanded !== false,
  };
}

/**
 * サーバーで作成済みのタスクを gantt に追加する（開いた状態で追加する）。
 * @param index 親の子タスク内での挿入位置。省略時は末尾
 */
export function addTaskToGantt(task: Task, index?: number): void {
  const now = new Date();
  const ganttTask = toGanttTask(task);
  gantt.addTask(
    {
      ...ganttTask,
      start_date: ganttTask.start_date ?? now,
      end_date: ganttTask.end_date ?? now,
      open: true,
      $open: true,
    },
    task.parent || 0,
    index,
  );
}

/** anchorId のタスクの直後にあたる挿入位置を返す（anchorId が parentId の子でなければ undefined） */
export function indexAfterTask(anchorId: GanttId | undefined, parentId: GanttId): number | undefined {
  if (anchorId === undefined || !gantt.isTaskExists(anchorId)) return undefined;
  if (String(gantt.getTask(anchorId).parent || 0) !== String(parentId || 0)) return undefined;
  return gantt.getTaskIndex(anchorId) + 1;
}

/** Gantt内部のタスクから、バックエンドへ保存する項目を取り出す */
export function buildTaskSavePayload(task: GanttTask): Partial<Task> {
  return {
    text: task.text,
    start_date: task.start_date instanceof Date ? formatDateString(task.start_date) : task.start_date,
    end_date: task.end_date instanceof Date ? formatDateString(task.end_date) : task.end_date,
    duration: task.duration,
    progress: task.progress,
    parent: Number(task.parent) || 0,
    kind_task: task.kind_task,
    owner_id: task.owner_id,
    sortorder: task.sortorder,
    hyperlink: task.hyperlink,
    ToDo: task.ToDo,
    memo: task.memo,
    task_schedule: task.task_schedule,
    edit_date: task.edit_date,
    color: task.color,
    textColor: task.textColor,
    is_pinned: Boolean(task.is_pinned),
  };
}

export function isProjectTask(task: GanttTask): boolean {
  return String(task.kind_task) === '2';
}

/** "[id]タスク名" 形式のラベル（HTMLエスケープ済み）。separator はIDと名前の間に入れる文字 */
export function buildTaskLabelHtml(task: GanttTask, separator = ''): string {
  const text = escapeHtml(task.text);
  return task.id ? `[${escapeHtml(task.id)}]${separator}${text}` : text;
}

/** ルートからそのタスクまでの階層パス（"[1]親 > [2]子"、HTMLエスケープ済み）を返す */
export function getTaskHierarchyHtml(taskId: GanttId): string {
  try {
    let task = gantt.getTask(taskId);
    const hierarchy: string[] = [];

    while (task) {
      hierarchy.unshift(buildTaskLabelHtml(task));

      if (task.parent && task.parent !== 0 && gantt.isTaskExists(task.parent)) {
        task = gantt.getTask(task.parent);
      } else {
        break;
      }
    }

    return hierarchy.join(' &gt; ');
  } catch {
    return '';
  }
}

/** ハイパーリンクをブラウザで開けるURLにする（ローカルパスは open-path API 経由） */
export function formatHyperlink(link: string): string {
  if (!link) return '';
  if (link.startsWith('http://') || link.startsWith('https://')) {
    return link;
  }
  // すでにエンコードされている（%が含まれる）場合はそのまま渡す。
  // そうでない場合はエンコードして渡す（二重エンコード防止）
  const encodedPath = link.includes('%') ? link : encodeURIComponent(link);
  return `${OPEN_PATH_API_URL}?path=${encodedPath}`;
}

/** リンク先が Obsidian Vault（obsidianHome 配下）のファイルかどうか */
export function isObsidianLink(link: string, obsidianHome: string): boolean {
  const trimmedLink = link.trim();
  const trimmedHome = obsidianHome.trim();
  if (!trimmedLink || !trimmedHome) return false;
  return (
    trimmedLink === trimmedHome ||
    trimmedLink.startsWith(`${trimmedHome}/`) ||
    trimmedLink.startsWith(`${trimmedHome}\\`)
  );
}

/** Shift+クリック等で複数選択されているタスクIDを返す */
export function getSelectedTaskIds(): GanttId[] {
  return gantt.getSelectedTasks ? gantt.getSelectedTasks() : [];
}

export function isTaskSelected(taskId: GanttId): boolean {
  return getSelectedTaskIds().map(String).includes(String(taskId));
}

/**
 * 右クリック等の操作対象タスクを決める。
 * 複数選択中で、対象タスクがその選択に含まれていれば選択全体、そうでなければそのタスクのみ。
 */
export function resolveTargetTaskIds(taskId: number): number[] {
  const selectedTasks = getSelectedTaskIds();
  return selectedTasks.length > 1 && isTaskSelected(taskId)
    ? selectedTasks.map(Number)
    : [taskId];
}

function getTimelineElement(): HTMLElement | undefined {
  return gantt.$task_data as HTMLElement | undefined;
}

/** タイムライン上の縦位置（スクロール込みのY座標）から行インデックスを求める */
function getRowIndexByTopPosition(top: number): number {
  const timelineView = gantt.$ui.getView('timeline') as {
    getItemIndexByTopPosition?: (top: number) => number;
  } | null;
  return timelineView?.getItemIndexByTopPosition?.(top) ?? -1;
}

/** マウス座標のX位置に対応するタイムライン上の日時を返す */
export function dateFromClientX(clientX: number): Date | null {
  const timeline = getTimelineElement();
  if (!timeline) return null;
  const rect = timeline.getBoundingClientRect();
  const date = gantt.dateFromPos(clientX - rect.left + timeline.scrollLeft);
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

/** マウス座標のY位置にある行のタスクIDを返す */
export function taskIdFromClientY(clientY: number): number | null {
  const timeline = getTimelineElement();
  if (!timeline) return null;
  const rect = timeline.getBoundingClientRect();
  const index = getRowIndexByTopPosition(clientY - rect.top + timeline.scrollTop);
  if (index < 0) return null;

  const task = gantt.getTaskByIndex(index);
  if (!task?.id || !gantt.isTaskExists(task.id)) return null;
  return Number(task.id);
}

/** マウス座標から、タイムライン上の行（タスクID）と列（日付）を解決する */
export function resolveTimelineContext(
  clientX: number,
  clientY: number,
  eventTarget: EventTarget | null,
): TimelineShortcutContext | null {
  const timeline = getTimelineElement();
  if (!timeline) return null;
  return resolveTimelineCellContext({
    clientX,
    clientY,
    timelineElement: timeline,
    taskAttribute: gantt.config.task_attribute,
    eventTarget,
    dateFromPos: (x) => gantt.dateFromPos(x),
    getItemIndexByTopPosition: getRowIndexByTopPosition,
    getTaskByIndex: (index) => gantt.getTaskByIndex(index),
    locateTask: (element) => gantt.locate(element as unknown as Event),
  });
}
