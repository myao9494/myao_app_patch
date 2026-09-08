/**
 * DHTMLX Ganttを用いたガントチャートコンポーネント。
 * タスクの表示、追加、編集、削除や、ドラッグアンドドロップによる期間変更、
 * コンテキストメニューによる操作等を提供する。
 * 左側グリッドの所有者(Owner)幅は一定(60px)に保つ仕様。
 **/
import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { gantt } from 'dhtmlx-gantt';
import 'dhtmlx-gantt/codebase/dhtmlxgantt.css';
import type { BusinessTripEntry, Task, Link, TaskKind, TaskFilter } from '../../types/gantt';
import {
  ContextMenu,
  getTaskContextMenuItems,
  getEmptyAreaContextMenuItems,
  getDateHeaderContextMenuItems,
  type ContextMenuItem,
} from './ContextMenu';
import { reorderTasks, createObsidianNote, resolveTaskLink } from '../../services/api';
import {
  OWNERS,
  KIND_TASKS,
  COLOR_OPTIONS,
  ZOOM_CONFIG,
  getTaskKindClass,
  formatDateString,
  formatEditDate,
  getOwnerLabel,
} from '../../constants/gantt';
import { formatDateToYMD } from '../../utils/dateUtils';
import { getTaskIconName } from '../../utils/iconUtils';
import '../../styles/gantt.css';
import { DateSettingModal } from './DateSettingModal';
import { ScheduleAddModal } from './ScheduleAddModal';
import {
  addOrUpdateSchedule,
  parseSchedule,
  formatDateForSchedule,
  updateScheduleAtIndex,
  removeScheduleAtIndex,
  moveScheduleAtIndex,
  getScheduleAtIndex,
} from '../../utils/scheduleParser';
import { buildTaskFilterIndexes, computeVisibleTaskIds } from '../../utils/filterUtils';
import { resolveTimelineShortcutContext } from '../../utils/ganttTimelineShortcut';

interface GanttChartProps {
  tasks: Task[];
  links: Link[];
  timeScale: 'day' | 'month' | 'quarter' | 'year';
  gridCollapsed?: boolean;
  displaySize?: number;
  filter?: TaskFilter;
  onFilterChange?: (filter: TaskFilter) => void;
  expandAllTrigger?: number;
  collapseAllTrigger?: number;
  onTaskUpdate?: (id: number, task: Partial<Task>) => void;
  // タスク作成後に作成されたタスクを返す（ライトボックス表示用）
  onTaskCreate?: (task: Partial<Task>) => Promise<Task | undefined>;
  onTaskDelete?: (id: number) => void;
  onTaskClone?: (id: number, targetId?: number) => Promise<any | void>;
  onLinkCreate?: (link: Omit<Link, 'id'>) => Promise<Link | undefined>;
  onLinkUpdate?: (id: number, link: Partial<Link>) => void;
  onLinkDelete?: (id: number) => void;
  isPrintMode?: boolean;
  gridWidth: number;
  obsidianHome: string;
  holidays?: string[];
  onAddHoliday?: (date: string) => Promise<void>;
  onRemoveHoliday?: (date: string) => Promise<void>;
  businessTrips?: BusinessTripEntry[];
  synonyms?: string[][];
  externalOpenTaskRequest?: {
    requestId: number;
    taskId: number;
    attempt: number;
  } | null;
  onExternalOpenHandled?: (requestId: number) => void;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
}

interface TimelineShortcutState {
  taskId: number;
  date: Date;
}

interface TimelinePointerPosition {
  clientX: number;
  clientY: number;
}

interface SchedulePinContext {
  taskId: number;
  sourceIndex: number;
  text: string;
  date: Date;
}

// Get task hierarchy path
function getTaskHierarchy(taskId: string | number): string {
  try {
    let task = gantt.getTask(taskId);
    const hierarchy: string[] = [];

    while (task) {
      const idPrefix = task.id ? `[${task.id}]` : '';
      hierarchy.unshift(`${idPrefix}${task.text}`);

      if (task.parent && task.parent !== 0 && gantt.isTaskExists(task.parent)) {
        task = gantt.getTask(task.parent);
      } else {
        break;
      }
    }

    return hierarchy.join(' > ');
  } catch {
    return '';
  }
}

// Helper to format hyperlinks
const formatHyperlink = (link: string): string => {
  if (!link) return '';
  if (link.startsWith('http://') || link.startsWith('https://')) {
    return link;
  }
  // すでにエンコードされている（%が含まれる）場合はそのまま渡す。
  // そうでない場合はエンコードして渡す（二重エンコード防止）
  const encodedPath = link.includes('%') ? link : encodeURIComponent(link);
  return `http://localhost:8001/api/fullpath?path=${encodedPath}`;
};

const isObsidianLink = (link: string, obsidianHome: string): boolean => {
  const trimmedLink = link.trim();
  const trimmedHome = obsidianHome.trim();
  if (!trimmedLink || !trimmedHome) return false;
  return (
    trimmedLink === trimmedHome ||
    trimmedLink.startsWith(`${trimmedHome}/`) ||
    trimmedLink.startsWith(`${trimmedHome}\\`)
  );
};

export function GanttChart({
  tasks,
  links,
  timeScale,
  gridCollapsed = false,
  displaySize = 100,
  filter,
  onFilterChange,
  expandAllTrigger = 0,
  collapseAllTrigger = 0,
  onTaskUpdate,
  onTaskCreate,
  onTaskDelete,
  onTaskClone,
  onLinkCreate,
  onLinkUpdate,
  onLinkDelete,
  isPrintMode = false,
  gridWidth,
  obsidianHome,
  holidays = [],
  onAddHoliday,
  onRemoveHoliday,
  businessTrips = [],
  synonyms = [],
  externalOpenTaskRequest = null,
  onExternalOpenHandled,
}: GanttChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const externalOpenHandledRequestIdRef = useRef<number | null>(null);
  const filterRef = useRef<TaskFilter | undefined>(filter);
  // onTaskUpdateをイベントハンドラ内で使用するためのref
  const onTaskUpdateRef = useRef(onTaskUpdate);
  // onTaskDeleteをイベントハンドラ内で使用するためのref
  const onTaskDeleteRef = useRef(onTaskDelete);
  // onTaskCreateをイベントハンドラ内で使用するためのref
  const onTaskCreateRef = useRef(onTaskCreate);
  const onLinkCreateRef = useRef(onLinkCreate);
  const onLinkUpdateRef = useRef(onLinkUpdate);
  const onLinkDeleteRef = useRef(onLinkDelete);
  // onTaskUpdate/onTaskDelete/onTaskCreateが変更されたらrefを更新
  useEffect(() => {
    onTaskUpdateRef.current = onTaskUpdate;
    onTaskDeleteRef.current = onTaskDelete;
    onTaskCreateRef.current = onTaskCreate;
    onLinkCreateRef.current = onLinkCreate;
    onLinkUpdateRef.current = onLinkUpdate;
    onLinkDeleteRef.current = onLinkDelete;
  }, [onTaskUpdate, onTaskDelete, onTaskCreate, onLinkCreate, onLinkUpdate, onLinkDelete]);

  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    items: [],
  });

  const [dateModal, setDateModal] = useState<{
    isOpen: boolean;
    taskId: number | null;
    initialDate: Date;
    initialDuration: number;
  }>({
    isOpen: false,
    taskId: null,
    initialDate: new Date(),
    initialDuration: 1,
  });

  const [scheduleModal, setScheduleModal] = useState<{
    isOpen: boolean;
    taskId: number | null;
    initialDate: Date;
    initialText: string;
    sourceIndex: number | null;
    mode: 'create' | 'edit';
  }>({
    isOpen: false,
    taskId: null,
    initialDate: new Date(),
    initialText: '',
    sourceIndex: null,
    mode: 'create',
  });

  // Batch move loop prevention
  const ignoreMoveEvent = useRef(false);
  const lastSelectedIdRef = useRef<string | number | null>(null);
  const isKeyboardFocusModeRef = useRef(false);
  const lastTimelineShortcutRef = useRef<TimelineShortcutState | null>(null);
  const isTimelinePointerActiveRef = useRef(false);
  const lastTimelinePointerPositionRef = useRef<TimelinePointerPosition | null>(null);
  const scheduleDragRef = useRef<{
    taskId: number;
    sourceIndex: number;
    startX: number;
    startY: number;
    element: HTMLElement;
    dragged: boolean;
  } | null>(null);
  const persistScheduleRef = useRef<(taskId: number, newSchedule: string) => void>(() => {});

  // カウンタ方式: 複数の非同期更新が重なってもレースコンディションを回避
  const isInternalChange = useRef(0);
  const initialRenderRef = useRef(false);
  // 差分同期中フラグ: onBeforeTaskDeleteなどのイベントハンドラからのAPI呼び出しを防ぐ
  const isSyncingRef = useRef(false);

  // --- コンテキストメニュー/キーボードショートカット用コールバックのref ---
  // gantt初期化useEffectの依存配列からこれらを除外し、
  // ganttの不必要な再初期化（clearAll→描画崩壊）を防止する
  const handleEditTaskRef = useRef<(taskId: number) => void>(() => {});
  const handleDeleteTaskRef = useRef<(taskId: number) => void>(() => {});
  const handleSetProgressRef = useRef<(taskId: number, progress: number) => void>(() => {});
  const handleSetOwnerRef = useRef<(taskId: number, ownerId: number) => void>(() => {});
  const handleSetKindRef = useRef<(taskId: number, kind: string) => void>(() => {});
  const handleSetColorRef = useRef<(taskId: number, color: string) => void>(() => {});
  const handleSetTextColorRef = useRef<(taskId: number, textColor: string) => void>(() => {});
  const handleSetTimePeriodRef = useRef<(taskId: number) => void>(() => {});
  const handleAddChildRef = useRef<(parentId: number, kind: TaskKind, insertAfterSortOrder?: number) => Promise<any>>(() => Promise.resolve());
  const handleCopyTaskRef = useRef<(taskId: number, targetId?: number) => Promise<any>>(() => Promise.resolve());
  const handleAddNewTaskRef = useRef<(date: Date | null, kind: TaskKind, insertAfterSortOrder?: number) => Promise<any>>(() => Promise.resolve());
  const handleAddScheduleRef = useRef<(taskId: number, initialDate?: Date) => void>(() => {});
  const handleCreateObsidianNoteRef = useRef<(taskId: number) => void>(() => {});
  const handleAddToFilterRef = useRef<(taskId: number) => void>(() => {});
  const handleTogglePinnedRef = useRef<(taskId: number, pinned: boolean) => void>(() => {});
  const handleAddHolidayRef = useRef<((date: string) => Promise<void>) | undefined>(undefined);
  const handleRemoveHolidayRef = useRef<((date: string) => Promise<void>) | undefined>(undefined);

  // Context menu callbacks
  const handleEditTask = useCallback((taskId: number) => {
    gantt.showLightbox(taskId);
  }, []);

  // シフト+クリックで複数選択されたタスクを全て削除する
  const handleDeleteTask = useCallback(
    (taskId: number) => {
      // 複数選択されているかチェック
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const selectedTasks = (gantt as any).getSelectedTasks ? (gantt as any).getSelectedTasks() : [];

      // 複数選択されていて、右クリックしたタスクが選択済みの場合は全て削除
      const tasksToDelete: number[] =
        selectedTasks.length > 1 && selectedTasks.map(String).includes(String(taskId))
          ? selectedTasks.map(Number)
          : [taskId];

      const message = tasksToDelete.length > 1
        ? `${tasksToDelete.length}件のタスクを削除しますか？`
        : 'このタスクを削除しますか？';

      if (confirm(message)) {
        // 全ての選択タスクを削除 (イベント側でAPIを呼ぶためここではgantt.deleteTaskのみ)
        tasksToDelete.forEach((id) => {
          if (gantt.isTaskExists(id)) {
            gantt.deleteTask(id);
          }
        });
      }
    },
    []
  );

  const handleSetProgress = useCallback(
    (taskId: number, progress: number) => {
      const task = gantt.getTask(taskId);
      task.progress = progress;
      gantt.updateTask(taskId);
      if (onTaskUpdate) {
        onTaskUpdate(taskId, { progress });
      }
    },
    [onTaskUpdate]
  );

  // Owner変更のハンドラ
  const handleSetOwner = useCallback(
    (taskId: number, ownerId: number) => {
      const task = gantt.getTask(taskId);
      task.owner_id = ownerId;
      gantt.updateTask(taskId);
      if (onTaskUpdate) {
        onTaskUpdate(taskId, { owner_id: ownerId as 0 | 10 | 20 | 30 });
      }
    },
    [onTaskUpdate]
  );

  // Task Kind変更のハンドラ
  const handleSetKind = useCallback(
    (taskId: number, kind: string) => {
      const task = gantt.getTask(taskId);
      task.kind_task = kind;
      gantt.updateTask(taskId);
      if (onTaskUpdate) {
        onTaskUpdate(taskId, { kind_task: kind as unknown as TaskKind });
      }
    },
    [onTaskUpdate]
  );

  // Bar Color変更のハンドラ
  const handleSetColor = useCallback(
    (taskId: number, color: string) => {
      const task = gantt.getTask(taskId);
      task.color = color;
      gantt.updateTask(taskId);
      if (onTaskUpdate) {
        onTaskUpdate(taskId, { color });
      }
    },
    [onTaskUpdate]
  );

  // Text Color変更のハンドラ
  const handleSetTextColor = useCallback(
    (taskId: number, textColor: string) => {
      const task = gantt.getTask(taskId);
      task.textColor = textColor;
      gantt.updateTask(taskId);
      if (onTaskUpdate) {
        onTaskUpdate(taskId, { textColor });
      }
    },
    [onTaskUpdate]
  );

  const handleTogglePinned = useCallback(
    (taskId: number, pinned: boolean) => {
      // 複数選択されていて、右クリックしたタスクが選択済みの場合は全て更新
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const selectedTasks = (gantt as any).getSelectedTasks ? (gantt as any).getSelectedTasks() : [];
      const targetTaskIds: number[] =
        selectedTasks.length > 1 && selectedTasks.map(String).includes(String(taskId))
          ? selectedTasks.map(Number)
          : [taskId];

      targetTaskIds.forEach((id) => {
        if (!gantt.isTaskExists(id)) {
          return;
        }
        const task = gantt.getTask(id);
        task.is_pinned = pinned;
        gantt.updateTask(id);
        if (onTaskUpdate) {
          onTaskUpdate(id, { is_pinned: pinned });
        }
      });
    },
    [onTaskUpdate]
  );

  const handleAddChild = useCallback(
    async (parentId: number, kind: TaskKind, insertAfterSortOrder?: number) => {
      const today = new Date();
      const endDate = new Date(today);
      endDate.setDate(endDate.getDate() + 1);

      const newTask: Partial<Task> = {
        text: kind === 2 ? '新規プロジェクト' : '新規タスク',
        start_date: formatDateString(today),
        end_date: formatDateString(endDate),
        duration: 1,
        progress: 0,
        parent: parentId,
        kind_task: kind,
        owner_id: 0,
        sortorder: insertAfterSortOrder !== undefined ? insertAfterSortOrder + 1 : -1,
      };

      if (onTaskCreateRef.current) {
        const createdTask = await onTaskCreateRef.current(newTask);

        if (createdTask && createdTask.id) {
          // ganttに直接追加してUndoスタックに記録させる
          // 差分同期はUndoスタック保護付きで走るので二重記録にならない
          if (!gantt.isTaskExists(createdTask.id)) {
            const t = {
              ...createdTask,
              start_date: createdTask.start_date ? new Date(String(createdTask.start_date).replace(' ', 'T')) : today,
              end_date: createdTask.end_date ? new Date(String(createdTask.end_date).replace(' ', 'T')) : endDate,
              open: true,
            };
            (t as any).$open = true;
            // 挿入インデックスを計算（insertAfterSortOrderの次の位置に挿入）
            let insertIndex: number | undefined;
            if (insertAfterSortOrder !== undefined) {
              // 同じ親の子タスクの中で、insertAfterSortOrderのタスクの次の位置を探す
              const parentTaskId = createdTask.parent || parentId || 0;
              const children = gantt.getChildren(parentTaskId);
              // insertAfterSortOrderに対応するタスクのインデックスを見つける
              for (let i = 0; i < children.length; i++) {
                const child = gantt.getTask(children[i]);
                if (child.sortorder === insertAfterSortOrder) {
                  insertIndex = i + 1;
                  break;
                }
              }
            }
            gantt.addTask(t, createdTask.parent || parentId || 0, insertIndex);
          }

          return createdTask;
        }
      }
    },
    []
  );

  const handleCopyTask = useCallback(
    async (taskId: number, targetId?: number) => {
      if (onTaskClone) {
        return await onTaskClone(taskId, targetId);
      }
    },
    [onTaskClone]
  );

  // 新規タスク/プロジェクト追加ハンドラ
  const handleAddNewTask = useCallback(
    async (date: Date | null, kind: TaskKind, insertAfterSortOrder?: number) => {
      const startDate = date || new Date();
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 1);

      const newTask: Partial<Task> = {
        text: kind === 2 ? '新規プロジェクト' : '新規タスク',
        start_date: formatDateString(startDate),
        end_date: formatDateString(endDate),
        duration: 1,
        progress: 0,
        parent: 0,
        kind_task: kind,
        owner_id: 0,
        sortorder: insertAfterSortOrder !== undefined ? insertAfterSortOrder + 1 : -1,
      };

      if (onTaskCreateRef.current) {
        const createdTask = await onTaskCreateRef.current(newTask);

        if (createdTask && createdTask.id) {
          // ganttに直接追加してUndoスタックに記録させる
          if (!gantt.isTaskExists(createdTask.id)) {
            const t = {
              ...createdTask,
              start_date: createdTask.start_date ? new Date(String(createdTask.start_date).replace(' ', 'T')) : startDate,
              end_date: createdTask.end_date ? new Date(String(createdTask.end_date).replace(' ', 'T')) : endDate,
              open: true,
            };
            (t as any).$open = true;
            // 挿入インデックスを計算
            let insertIndex: number | undefined;
            if (insertAfterSortOrder !== undefined) {
              const children = gantt.getChildren(0);
              for (let i = 0; i < children.length; i++) {
                const child = gantt.getTask(children[i]);
                if (child.sortorder === insertAfterSortOrder) {
                  insertIndex = i + 1;
                  break;
                }
              }
            }
            gantt.addTask(t, createdTask.parent || 0, insertIndex);
          }

          return createdTask;
        }
      }
    },
    []
  );

  // 期間設定モーダルを開く
  const handleSetTimePeriod = useCallback((taskId: number) => {
    const task = gantt.getTask(taskId);
    setDateModal({
      isOpen: true,
      taskId: taskId,
      initialDate: task.start_date ? new Date(task.start_date) : new Date(),
      initialDuration: Number(task.duration) || 1,
    });
  }, []);

  // 期間設定保存
  const handleSaveDate = useCallback((startDate: Date, duration: number) => {
    if (dateModal.taskId) {
      const task = gantt.getTask(dateModal.taskId);
      // dates must be objects for gantt
      task.start_date = startDate;
      task.duration = duration;
      const endDate = gantt.calculateEndDate({ start_date: startDate, duration: duration, task: task });
      task.end_date = endDate;

      gantt.updateTask(dateModal.taskId);

      if (onTaskUpdate) {
        onTaskUpdate(dateModal.taskId, {
          start_date: formatDateString(startDate),
          duration: duration,
          end_date: formatDateString(endDate),
        });
      }
    }
    setDateModal(prev => ({ ...prev, isOpen: false }));
  }, [dateModal.taskId, onTaskUpdate]);

  // スケジュール追加モーダルを開く
  const handleAddSchedule = useCallback((taskId: number, initialDate?: Date) => {
    const task = gantt.getTask(taskId);
    setScheduleModal({
      isOpen: true,
      taskId: taskId,
      initialDate: initialDate ?? (task.start_date ? new Date(task.start_date) : new Date()),
      initialText: '',
      sourceIndex: null,
      mode: 'create',
    });
  }, []);

  const persistTaskSchedule = useCallback((taskId: number, newSchedule: string) => {
    const task = gantt.getTask(taskId);
    task.task_schedule = newSchedule;
    gantt.updateTask(taskId);

    if (onTaskUpdate) {
      onTaskUpdate(taskId, {
        task_schedule: newSchedule,
      });
    }
  }, [onTaskUpdate]);

  useEffect(() => {
    persistScheduleRef.current = persistTaskSchedule;
  }, [persistTaskSchedule]);

  // スケジュール保存
  const handleSaveSchedule = useCallback((dateStr: string, text: string) => {
    if (scheduleModal.taskId) {
      const task = gantt.getTask(scheduleModal.taskId);
      const currentSchedule = task.task_schedule || '';

      const newSchedule = scheduleModal.mode === 'edit' && scheduleModal.sourceIndex !== null
        ? updateScheduleAtIndex(currentSchedule, scheduleModal.sourceIndex, dateStr, text)
        : addOrUpdateSchedule(currentSchedule, dateStr, text);

      persistTaskSchedule(scheduleModal.taskId, newSchedule);
    }
    setScheduleModal(prev => ({ ...prev, isOpen: false }));
  }, [scheduleModal.taskId, scheduleModal.mode, scheduleModal.sourceIndex, persistTaskSchedule]);

  const isCreatingObsidianRef = useRef(false);
  const isResolvingHyperlinkRef = useRef(false);
  const taskFilterIndexes = useMemo(() => buildTaskFilterIndexes(tasks, synonyms), [tasks, synonyms]);
  const holidaySetRef = useRef<Set<string>>(new Set());
  const businessTripMapRef = useRef<Map<string, BusinessTripEntry['type']>>(new Map());
  const visibleTaskIdsRef = useRef<Set<number>>(new Set());
  const visibleSignatureRef = useRef('');
  const filterRefreshFrameRef = useRef<number | null>(null);

  const scrollTaskIntoView = useCallback((taskId: string | number) => {
    if (!initialized.current || !gantt.isTaskExists(taskId)) return;

    const taskDataElement = gantt.$task_data as HTMLElement | undefined;
    if (!taskDataElement) return;

    const rowIndex = gantt.getGlobalTaskIndex(taskId);
    if (rowIndex < 0) return;

    const scrollState = gantt.getScrollState();
    const rowHeight = gantt.config.row_height || 27;
    const rowTop = rowIndex * rowHeight;
    const rowBottom = rowTop + rowHeight;
    const viewportTop = scrollState.y;
    const viewportBottom = viewportTop + taskDataElement.clientHeight;

    if (rowTop < viewportTop) {
      gantt.scrollTo(scrollState.x, rowTop);
      return;
    }

    if (rowBottom > viewportBottom) {
      gantt.scrollTo(scrollState.x, Math.max(0, rowBottom - taskDataElement.clientHeight));
    }
  }, []);

  const openTaskInput = useCallback((taskId: number) => {
    if (!initialized.current) return false;

    const ganttTaskId = gantt.isTaskExists(taskId)
      ? taskId
      : gantt.isTaskExists(String(taskId))
        ? String(taskId)
        : null;
    if (ganttTaskId === null) return false;

    let current = gantt.getTask(ganttTaskId);
    while (current?.parent && current.parent !== 0 && gantt.isTaskExists(current.parent)) {
      gantt.open(current.parent);
      current = gantt.getTask(current.parent);
    }

    gantt.selectTask(ganttTaskId);
    scrollTaskIntoView(ganttTaskId);
    window.focus();
    gantt.showLightbox(ganttTaskId);
    return true;
  }, [scrollTaskIntoView]);

  const buildScheduleHtml = (task: any) => {
    let scheduleHtml = '';
    if (task.task_schedule) {
      const events = parseSchedule(task.task_schedule);
      events.forEach(event => {
        const taskStartPos = gantt.posFromDate(task.start_date);
        const eventPos = gantt.posFromDate(event.date);
        const nextDay = new Date(event.date.getTime() + 24 * 60 * 60 * 1000);
        const nextDayPos = gantt.posFromDate(nextDay);
        const dayCellWidth = nextDayPos - eventPos;
        const relativeLeft = eventPos - taskStartPos + (dayCellWidth * 0.5);
        const cleanText = event.text.replace(/\d{2}:\d{2}:\d{2}/g, '').trim();
        const escapedText = cleanText
          .replace(/&/g, '&amp;')
          .replace(/"/g, '&quot;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');

        scheduleHtml += `
          <div
            class="gantt-schedule-event"
            data-task-id="${task.id}"
            data-schedule-index="${event.sourceIndex ?? 0}"
            data-schedule-date="${formatDateForSchedule(event.date)}"
            data-schedule-text="${escapedText}"
            style="left: ${relativeLeft}px; top: 0; margin-left: -5px;"
          >
            <div class="gantt-schedule-icon">📌</div>
            <div class="gantt-schedule-tooltip">${formatDateForSchedule(event.date)} ${escapedText}</div>
          </div>
        `;
      });
    }

    return scheduleHtml;
  };

  // Obsidianノート作成処理
  const handleCreateObsidianNote = useCallback(async (taskId: number) => {
    if (isCreatingObsidianRef.current) return;
    isCreatingObsidianRef.current = true;
    try {
      const response = await createObsidianNote(taskId, obsidianHome);
      if (response.success && response.data) {
        const task = gantt.getTask(taskId);
        task.hyperlink = response.data.hyperlink;
        gantt.updateTask(taskId);

        if (onTaskUpdate) {
          // これにより親コンポーネント(App.tsxなど)側に変更を伝える
          onTaskUpdate(taskId, {
            hyperlink: response.data.hyperlink
          });
        }

        // 作成したノートを自動で開く
        if (response.data.hyperlink) {
          const link = formatHyperlink(response.data.hyperlink);
          window.open(link, '_blank');
        }
      } else {
        console.error("Failed to create Obsidian note:", response.error);
        alert(`ファイル作成に失敗しました: ${response.error}`);
      }
    } catch (error) {
      console.error(error);
      alert("エラーが発生しました");
    } finally {
      isCreatingObsidianRef.current = false;
    }
  }, [obsidianHome, onTaskUpdate]);

  const handleAddToFilter = useCallback((taskId: number) => {
    const task = gantt.getTask(taskId);
    if (task && onFilterChange) {
      const defaultFilter: TaskFilter = {
        searchText: '',
        searchProject: '',
        showCompleted: false,
        showType: 'all',
        category: '',
        periodMode: 'all',
        dateRangeStart: 0,
        dateRangeEnd: 0,
      };
      const currentFilter = filterRef.current || defaultFilter;
      onFilterChange({ ...currentFilter, searchProject: task.text });
    }
  }, [onFilterChange]);

  const openResolvedHyperlink = useCallback(async (taskId: number, hyperlink: string) => {
    if (!hyperlink) return;

    if (!isObsidianLink(hyperlink, obsidianHome)) {
      window.open(formatHyperlink(hyperlink), '_blank');
      return;
    }

    if (isResolvingHyperlinkRef.current) return;
    isResolvingHyperlinkRef.current = true;

    try {
      const response = await resolveTaskLink(taskId, obsidianHome);
      if (!response.success || !response.data?.hyperlink) {
        alert(response.error || 'Obsidianリンクの再解決に失敗しました');
        return;
      }

      const resolvedHyperlink = response.data.hyperlink;
      if (response.data.updated && gantt.isTaskExists(taskId)) {
        const task = gantt.getTask(taskId);
        task.hyperlink = resolvedHyperlink;
        gantt.updateTask(taskId);

        if (onTaskUpdate) {
          onTaskUpdate(taskId, { hyperlink: resolvedHyperlink });
        }
      }

      window.open(formatHyperlink(resolvedHyperlink), '_blank');
    } catch (error) {
      console.error(error);
      alert('Obsidianリンクを開けませんでした');
    } finally {
      isResolvingHyperlinkRef.current = false;
    }
  }, [obsidianHome, onTaskUpdate]);

  // --- refの更新: コールバックが変わったらrefを自動更新 ---
  useEffect(() => {
    handleEditTaskRef.current = handleEditTask;
    handleDeleteTaskRef.current = handleDeleteTask;
    handleSetProgressRef.current = handleSetProgress;
    handleSetOwnerRef.current = handleSetOwner;
    handleSetKindRef.current = handleSetKind;
    handleSetColorRef.current = handleSetColor;
    handleSetTextColorRef.current = handleSetTextColor;
    handleSetTimePeriodRef.current = handleSetTimePeriod;
    handleAddChildRef.current = handleAddChild;
    handleCopyTaskRef.current = handleCopyTask;
    handleAddNewTaskRef.current = handleAddNewTask;
    handleAddScheduleRef.current = handleAddSchedule;
    handleCreateObsidianNoteRef.current = handleCreateObsidianNote;
    handleAddToFilterRef.current = handleAddToFilter;
    handleTogglePinnedRef.current = handleTogglePinned;
    handleAddHolidayRef.current = onAddHoliday;
    handleRemoveHolidayRef.current = onRemoveHoliday;
  });

  // Close context menu
  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  // Initialize gantt (only once)
  useEffect(() => {
    if (!containerRef.current || initialized.current) return;

    // Enable plugins
    gantt.plugins({
      keyboard_navigation: false,
      undo: true,
      marker: true,
      multiselect: true,
    });

    // Basic config
    gantt.config.date_format = '%Y-%m-%d %H:%i:%s';
    gantt.config.order_branch = true;
    gantt.config.order_branch_free = true;
    gantt.config.sort = true;
    gantt.config.open_tree_initially = true;
    gantt.config.keyboard_navigation_cells = false;
    gantt.config.row_height = 27;
    gantt.config.bar_height = 18;
    gantt.config.multiselect = true;

    // Undo config
    gantt.config.undo = true;
    gantt.config.undo_steps = 10;

    // タイムラインの表示範囲を設定（1年前から1年後まで）
    // fit_tasksをfalseにしてタスクに合わせた自動フィットを無効化
    gantt.config.fit_tasks = false;
    const today = new Date();
    const oneYearAgo = new Date(today);
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const oneYearLater = new Date(today);
    oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);
    gantt.config.start_date = oneYearAgo;
    gantt.config.end_date = oneYearLater;

    // Register server lists for lightbox
    // kind_task, owner_id, color, textColorはコンテキストメニューで設定するため、リスト登録は不要かもしれないが
    // 互換性維持のため残しておくか、使用箇所がないなら削除可能。
    // Lightboxで使用しないなら削除しても良いが、一応残しておく。
    gantt.serverList('kind_task', KIND_TASKS.map(k => ({ key: k.key, label: k.label })));
    gantt.serverList('owner_id', OWNERS.map(o => ({ key: o.key, label: o.label })));
    gantt.serverList('color', COLOR_OPTIONS.map(c => ({ key: c.key, label: c.label })));
    gantt.serverList('textColor', COLOR_OPTIONS.map(c => ({ key: c.key, label: c.label })));

    // Lightbox configuration (matching original app)
    // コンテキストメニューに移動した項目（kind, owner, barColor, textColor）を削除
    (gantt.config.lightbox as any).sections = [
      {
        name: 'hierarchy',
        height: 22,
        type: 'template',
        map_to: 'hierarchy_path',
      },
      { name: 'description', height: 35, map_to: 'text', type: 'textarea', focus: true },
      { name: 'hyperlink', height: 30, map_to: 'hyperlink', type: 'textarea' },
      { name: 'ToDo', height: 60, map_to: 'ToDo', type: 'textarea' },
      { name: 'memo', height: 60, map_to: 'memo', type: 'textarea' },
      { name: 'task_schedule', height: 60, map_to: 'task_schedule', type: 'textarea' },
      { name: 'edit_date', height: 35, map_to: 'edit_date', type: 'textarea' },
    ];

    // Lightbox labels
    gantt.locale.labels.section_hierarchy = '';
    gantt.locale.labels.section_description = 'タスク名';
    gantt.locale.labels.section_hyperlink = 'hyperlink';
    gantt.locale.labels.section_ToDo = 'ToDo';
    gantt.locale.labels.section_memo = 'memo';
    gantt.locale.labels.section_task_schedule = 'task_schedule';
    gantt.locale.labels.section_edit_date = 'edit_date';

    // Hierarchy template for lightbox
    if (gantt.form_blocks && gantt.form_blocks.template) {
      gantt.form_blocks.template.set_value = function (node: any, _value: any, task: any) {
        node.innerHTML = `<div class="hierarchy-path">${getTaskHierarchy(task.id)}</div>`;
      };
    }

    // Columns configuration
    // add/clone/owner列は削除し、右クリックメニューで操作する
    // editor定義は使用しない（インラインエディタの誤作動を避けるため）
    gantt.config.columns = [
      {
        name: 'text',
        label: 'Task name',
        tree: true,
        width: '*', // 幅を自動調整
        resize: true,
      },
      {
        name: 'owner_id',
        label: 'owner',
        width: 60,
        min_width: 60,
        max_width: 60,
        align: 'center',
        template: (task: any) => {
          return getOwnerLabel(task.owner_id);
        },
        resize: false,
      },
    ];


    // Templates
    gantt.templates.task_class = (_start: Date, _end: Date, task: any) => {
      const classes = [getTaskKindClass(task.kind_task)];
      if (task.is_pinned) {
        classes.push('pinned-task');
      }
      return classes.join(' ');
    };

    gantt.templates.rightside_text = (_start: Date, _end: Date, task: any) => {
      if (String(task.kind_task) === '2') {
        return '';
      }

      const idPrefix = task.id ? `[${task.id}]` : '';
      const currentTaskInfo = idPrefix ? `${idPrefix} ${task.text}` : task.text;

      let parentInfo = '';
      try {
        if (task.parent && task.parent !== 0 && gantt.isTaskExists(task.parent)) {
          const parentTask = gantt.getTask(task.parent);
          if (parentTask) {
            const parentIdPrefix = parentTask.id ? `[${parentTask.id}]` : '';
            parentInfo = parentIdPrefix ? `${parentIdPrefix} ${parentTask.text}` : parentTask.text;
          }
        }
      } catch {
        // Parent task not found
      }

      const displayText = parentInfo
        ? `${currentTaskInfo} > ${parentInfo}`
        : currentTaskInfo;

      if (task.hyperlink) {
        return `<a href="#" data-task-id="${task.id}" data-hyperlink="${task.hyperlink}">${displayText}</a>`;
      }
      return displayText;
    };

    gantt.templates.task_text = (_start: Date, _end: Date, task: any) => {
      const scheduleHtml = buildScheduleHtml(task);

      if (String(task.kind_task) === '1' || String(task.kind_task) === '3') {
        return scheduleHtml;
      }

      const idPrefix = task.id ? `[${task.id}]` : '';
      const label = idPrefix ? `${idPrefix}${task.text}` : task.text;

      // ピン要素(scheduleHtml)と、テキスト表示用コンテナを別々に配置する
      // ピン(z-index: 5)の手前に確実に来るように絶対配置のラッパーで囲む
      // pointer-events: none で背面のクリックを阻害せず、リンク部分のみ pointer-events: auto にする
      const wrapperStyle = "position: absolute; left: 0; top: 1px; width: 100%; height: 100%; z-index: 10; pointer-events: none; display: flex; align-items: center; overflow: visible;";
      const labelStyle = "margin-left: 30px; pointer-events: auto; flex-shrink: 0; white-space: nowrap; display: inline-block;";

      let labelHtml = '';
      if (task.hyperlink) {
        labelHtml = `<a href="#" data-task-id="${task.id}" data-hyperlink="${task.hyperlink}" style="${labelStyle}">${label}</a>`;
      } else {
        labelHtml = `<span style="${labelStyle}">${label}</span>`;
      }

      return `${scheduleHtml}<div style="${wrapperStyle}">${labelHtml}</div>`;
    };

    gantt.templates.timeline_cell_class = (_task: any, date: Date) => {
      const dateKey = formatDateForSchedule(date);
      const tripType = businessTripMapRef.current.get(dateKey);
      if (tripType === 'normal_trip') {
        return 'business-trip-normal';
      }
      if (tripType === 'day_trip') {
        return 'business-trip-day';
      }
      if (date.getDay() === 0 || date.getDay() === 6 || holidaySetRef.current.has(dateKey)) {
        return 'weekend';
      }
      return '';
    };

    // カスタムフォーカス用のクラス追加 (Cmd+Arrow移動用)
    gantt.templates.grid_row_class = (_start, _end, task) => {
      if (isKeyboardFocusModeRef.current && task.id === lastSelectedIdRef.current) return 'keyboard-focus-row';
      return '';
    };
    gantt.templates.task_row_class = (_start, _end, task) => {
      if (isKeyboardFocusModeRef.current && task.id === lastSelectedIdRef.current) return 'keyboard-focus-row';
      return '';
    };

    // Tree icons templates (Catppuccin)
    gantt.templates.grid_folder = (item: any) => {
      const isOpen = !!(item.$open || item.open);
      const iconName = getTaskIconName(item, isOpen, true);
      const ext = iconName === 'excalidraw' ? 'ico' : 'svg';
      return `<div class='gantt_tree_icon gantt_folder_${isOpen ? 'open' : 'closed'}' style='background-image:url(/icons/catppuccin/${iconName}.${ext})'></div>`;
    };
    gantt.templates.grid_file = (item: any) => {
      const iconName = getTaskIconName(item, false, false);
      const ext = iconName === 'excalidraw' ? 'ico' : 'svg';
      return `<div class='gantt_tree_icon gantt_file' style='background-image:url(/icons/catppuccin/${iconName}.${ext})'></div>`;
    };

    // Open all tasks by default
    gantt.attachEvent('onTaskLoading', (task: any) => {
      task.$open = true;
      return true;
    });

    // Set initial edit_date for new tasks
    gantt.attachEvent('onTaskCreated', (task: any) => {
      const today = new Date();
      const formatDate = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;
      task.duration = 1;
      task.start_date = today;
      task.edit_date = formatDate;
      task.kind_task = '1';
      task.owner_id = 0;
      return true;
    });

    // API呼び出しによるタスク削除（一括削除のループはキー操作側等で管理）
    // 差分同期中（isSyncingRef=true）の場合はAPIを呼ばない（二重削除防止）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gantt.attachEvent('onBeforeTaskDelete', (id: any, _item: any) => {
      if (isSyncingRef.current) {
        return true; // 差分同期中はAPI呼び出しをスキップ
      }
      if (onTaskDeleteRef.current) {
        isInternalChange.current += 1;
        onTaskDeleteRef.current(Number(id));
      }
      return true; // DHTMLXにデフォルトの削除処理（UI更新など）を続行させる
    });

    // Update edit_date on task update and save to backend
    // タスク更新時にedit_dateを更新し、バックエンドに保存
    // Helper to save task to backend
    const saveTask = (id: string | number, task: any) => {
      if (onTaskUpdateRef.current && typeof Number(id) === 'number') {
        // Prevent undo stack clearing on re-render
        isInternalChange.current += 1;

        // タスク名の先頭に含まれるインデント(空白)やアイコン(絵文字等)を除去する
        let cleanText = task.text || '';
        if (typeof cleanText === 'string') {
          // 先頭の空白類、インデント用文字列などを正規表現で除去
          cleanText = cleanText.replace(/^[\s\u3000📁📄📅🔍📝📌]+/g, '');
          task.text = cleanText; // gantt側のデータも更新しておく
        }

        const numericId = Number(id);
        onTaskUpdateRef.current(numericId, {
          text: task.text,
          start_date: task.start_date instanceof Date ? formatDateString(task.start_date) : task.start_date,
          end_date: task.end_date instanceof Date ? formatDateString(task.end_date) : task.end_date,
          duration: task.duration,
          progress: task.progress,
          parent: task.parent || 0,
          kind_task: task.kind_task,
          owner_id: task.owner_id,
          sortorder: task.sortorder, // sortorderも保存
          hyperlink: task.hyperlink,
          ToDo: task.ToDo,
          memo: task.memo,
          task_schedule: task.task_schedule,
          edit_date: task.edit_date,
          color: task.color,
          textColor: task.textColor,
        });
      }
    };

    // Update edit_date on task update and save to backend
    // タスク更新時にedit_dateを更新し、バックエンドに保存
    gantt.attachEvent('onAfterTaskUpdate', (id: any, task: any) => {
      const today = new Date();
      const todayStr = formatEditDate(today);
      if (task.edit_date) {
        if (!task.edit_date.split(',').includes(todayStr)) {
          task.edit_date = task.edit_date + ',' + todayStr;
        }
      } else {
        task.edit_date = todayStr;
      }

      // API経由でバックエンドに保存
      saveTask(id, task);
      return true;
    });

    gantt.attachEvent('onTaskSelected', (id) => {
      lastSelectedIdRef.current = id;
      isKeyboardFocusModeRef.current = false;
      return true;
    });

    // リンクの作成・更新・削除をバックエンドに同期
    gantt.attachEvent('onAfterLinkAdd', (id, link) => {
      if (isSyncingRef.current) return;
      if (onLinkCreateRef.current) {
        isInternalChange.current += 1;
        onLinkCreateRef.current({
          source: Number(link.source),
          target: Number(link.target),
          type: Number(link.type) as 0 | 1 | 2 | 3,
        }).then((newLink) => {
          if (newLink && newLink.id) {
            if (gantt.isLinkExists(id) && String(id) !== String(newLink.id)) {
              gantt.changeLinkId(id, newLink.id);
            }
          }
        });
      }
    });

    gantt.attachEvent('onAfterLinkUpdate', (id, link) => {
      if (isSyncingRef.current) return;
      if (onLinkUpdateRef.current) {
        isInternalChange.current += 1;
        onLinkUpdateRef.current(Number(id), {
          source: Number(link.source),
          target: Number(link.target),
          type: Number(link.type) as 0 | 1 | 2 | 3,
        });
      }
    });

    gantt.attachEvent('onAfterLinkDelete', (id) => {
      if (isSyncingRef.current) return;
      if (onLinkDeleteRef.current) {
        isInternalChange.current += 1;
        onLinkDeleteRef.current(Number(id));
      }
    });

    // Handle Undo/Redo persistence
    // Undo/Redoで変更されたタスクをバックエンドに同期する
    // 注意: onBeforeTaskDeleteが既にremove時のAPI呼び出しを担当しているため、
    // ここではupdate操作のみを処理する（add/removeはDHTMLXのイベントに委譲）
    const handleUndoRedo = (command: any) => {
      if (command && command.commands) {
        command.commands.forEach((cmd: any) => {
          if (cmd.entity === 'task') {
            const taskId = cmd.id;
            if (cmd.type === 'update') {
              if (gantt.isTaskExists(taskId)) {
                const task = gantt.getTask(taskId);
                saveTask(taskId, task);
              }
            }
            // remove: onBeforeTaskDeleteイベントで処理済み
            // add: Undo/Redoでタスクが復活した場合、バックエンドに再作成する
            if (cmd.type === 'add') {
              if (gantt.isTaskExists(taskId)) {
                const task = gantt.getTask(taskId);
                if (onTaskCreateRef.current) {
                  // fetchDataによる再描画の2回分をスキップ
                  isInternalChange.current += 2;
                  onTaskCreateRef.current({
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
                  }).then((createdTask: any) => {
                    if (createdTask && createdTask.id) {
                      if (gantt.isTaskExists(taskId) && String(taskId) !== String(createdTask.id)) {
                        gantt.changeTaskId(taskId, createdTask.id);
                      }
                    }
                  });
                }
              }
            }
          }
          if (cmd.entity === 'link') {
            const linkId = cmd.id;
            if (cmd.type === 'update') {
              if (gantt.isLinkExists(linkId)) {
                const link = gantt.getLink(linkId);
                if (onLinkUpdateRef.current) {
                  onLinkUpdateRef.current(Number(linkId), {
                    source: Number(link.source),
                    target: Number(link.target),
                    type: Number(link.type) as any,
                  });
                }
              }
            }
            if (cmd.type === 'add') {
              if (gantt.isLinkExists(linkId)) {
                const link = gantt.getLink(linkId);
                if (onLinkCreateRef.current) {
                  onLinkCreateRef.current({
                    source: Number(link.source),
                    target: Number(link.target),
                    type: Number(link.type) as any,
                  }).then((newLink: any) => {
                    if (newLink && newLink.id) {
                      if (gantt.isLinkExists(linkId) && String(linkId) !== String(newLink.id)) {
                        gantt.changeLinkId(linkId, newLink.id);
                      }
                    }
                  });
                }
              }
            }
          }
        });
      }
    };

    gantt.attachEvent('onAfterUndo', handleUndoRedo);
    gantt.attachEvent('onAfterRedo', handleUndoRedo);

    // 閉じたプロジェクトへのドラッグ&ドロップ時に自動的に子要素として配置する
    // order_branch_free=trueでも、折りたたんだプロジェクトには兄弟としてしかドロップできないため、
    // ドロップ直前のタスクがプロジェクトかつ閉じている場合に子要素として再配置する
    gantt.attachEvent('onBeforeRowDragEnd', (id: string | number, _origParent: string | number, _origTindex: number) => {
      try {
        const task = gantt.getTask(id);
        const newParent = task.parent;

        // ドロップ後の位置（グローバルインデックス）を取得し、直前のタスクを確認
        const globalIndex = gantt.getGlobalTaskIndex(id);
        if (globalIndex > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const prevTask = gantt.getTaskByIndex(globalIndex - 1) as any;
          if (prevTask && gantt.isTaskExists(prevTask.id)) {
            const prevFullTask = gantt.getTask(prevTask.id);
            // 直前のタスクがプロジェクト（kind_task=2）で折りたたまれており、
            // かつ現在の親がそのプロジェクトでない場合（兄弟としてドロップされた場合）
            if (
              String(prevFullTask.kind_task) === '2' &&
              !prevFullTask.$open &&
              String(newParent) !== String(prevFullTask.id)
            ) {
              // プロジェクトの子として移動
              const childCount = gantt.getChildren(prevFullTask.id).length;
              gantt.moveTask(id, childCount, prevFullTask.id);
              // プロジェクトを展開
              prevFullTask.$open = true;
              prevFullTask.open = true;
              gantt.render();
            }
          }
        }
      } catch {
        // タスクが見つからない場合は無視
      }
      return true;
    });

    // Handle Task Reordering
    gantt.attachEvent('onAfterTaskMove', (id: string | number, parent: string | number, tindex: number) => {
      if (ignoreMoveEvent.current) return true;

      // Handle multi-select move
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const selectedTasks = (gantt as any).getSelectedTasks ? (gantt as any).getSelectedTasks() : [];

      if (selectedTasks.length > 1 && selectedTasks.map(String).includes(String(id))) {
        ignoreMoveEvent.current = true;

        let offset = 1;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        selectedTasks.forEach((sid: any) => {
          if (String(sid) !== String(id)) {
            // Move other selected tasks to immediately follow the dragged task
            gantt.moveTask(sid, tindex + offset, parent);
            offset++;
          }
        });

        ignoreMoveEvent.current = false;
      }

      // id: moved task id
      // parent: new parent id
      // tindex: new index (0-based)

      // Get all children of the new parent (siblings including the moved task)
      const children = gantt.getChildren(parent);

      const items = children.map((childId, index) => {
        return {
          id: Number(childId),
          sortorder: index,
          parent: Number(parent),
        };
      });

      // Send batch update to backend
      isInternalChange.current += 1;
      reorderTasks({ items });

      return true;
    });

    // Update hierarchy display when lightbox opens
    gantt.attachEvent('onLightbox', (taskId: any) => {
      const task = gantt.getTask(taskId);
      task.hierarchy_path = getTaskHierarchy(taskId);

      setTimeout(() => {
        const descriptionField = document.querySelector('.gantt_cal_ltext textarea') as HTMLTextAreaElement;
        if (descriptionField) {
          descriptionField.focus();
        }
      }, 0);
    });

    gantt.attachEvent('onBeforeLightbox', (id: any) => {
      const task = gantt.getTask(id);
      task.hierarchy_path = getTaskHierarchy(id);
      return true;
    });

    // Context menu event
    gantt.attachEvent('onContextMenu', (taskId: string | number | null, _linkId: string | number | null, event: MouseEvent) => {
      event.preventDefault();

      if (taskId) {
        try {
          const task = gantt.getTask(taskId);
          const scheduleContext = taskDataElement
            ? resolveTimelineShortcutContext({
              eventTarget: event.target,
              clientX: event.clientX,
              timelineElement: taskDataElement,
              taskAttribute: gantt.config.task_attribute,
              dateFromPos: (x) => gantt.dateFromPos(x),
            })
            : null;
          // ref経由でコールバックを参照し、gantt初期化useEffectの依存配列から排除
          const items = getTaskContextMenuItems(Number(taskId), task.kind_task, Boolean(task.is_pinned), {
            onEdit: (id) => handleEditTaskRef.current(id),
            onDelete: (id) => handleDeleteTaskRef.current(id),
            onSetProgress: (id, p) => handleSetProgressRef.current(id, p),
            onSetOwner: (id, o) => handleSetOwnerRef.current(id, o),
            onSetKind: (id, k) => handleSetKindRef.current(id, k),
            onSetColor: (id, c) => handleSetColorRef.current(id, c),
            onSetTextColor: (id, c) => handleSetTextColorRef.current(id, c),
            onSetTimePeriod: (id) => handleSetTimePeriodRef.current(id),
            onAddChild: (pid, k) => handleAddChildRef.current(pid, k),
            onCopy: (id) => handleCopyTaskRef.current(id),
            onAddSchedule: (id) => handleAddScheduleRef.current(id, scheduleContext?.date),
            onCreateObsidian: (id) => handleCreateObsidianNoteRef.current(id),
            onAddToFilter: (id) => handleAddToFilterRef.current(id),
            onTogglePinned: (id, pinned) => handleTogglePinnedRef.current(id, pinned),
          });
          setContextMenu({
            visible: true,
            x: event.clientX,
            y: event.clientY,
            items,
          });
        } catch {
          // Task not found
        }
      } else {
        const target = event.target as HTMLElement | null;
        const isScaleHeader = !!target?.closest('.gantt_task_scale, .gantt_scale_cell, .gantt_scale_line');

        let clickedDate: Date | null = null;
        const taskData = gantt.$task_data as HTMLElement | undefined;
        if (taskData) {
          const rect = taskData.getBoundingClientRect();
          const relativeX = event.clientX - rect.left + taskData.scrollLeft;
          clickedDate = gantt.dateFromPos(relativeX);
        }

        const dateStr = clickedDate ? formatDateToYMD(clickedDate) : '';
        const isHoliday = dateStr ? holidaySetRef.current.has(dateStr) : false;

        if (isScaleHeader && clickedDate) {
          const items = getDateHeaderContextMenuItems(clickedDate, isHoliday, {
            onAddHoliday: (d) => handleAddHolidayRef.current?.(d),
            onRemoveHoliday: (d) => handleRemoveHolidayRef.current?.(d),
          });
          setContextMenu({
            visible: true,
            x: event.clientX,
            y: event.clientY,
            items,
          });
        } else {
          const items = getEmptyAreaContextMenuItems(clickedDate, {
            onAddProject: (date) => handleAddNewTaskRef.current(date, 2),
            onAddTask: (date) => handleAddNewTaskRef.current(date, 1),
            onAddHoliday: (d) => handleAddHolidayRef.current?.(d),
            onRemoveHoliday: (d) => handleRemoveHolidayRef.current?.(d),
            isHoliday,
          });
          setContextMenu({
            visible: true,
            x: event.clientX,
            y: event.clientY,
            items,
          });
        }
      }

      return false;
    });

    // Initialize zoom
    if (gantt.ext && gantt.ext.zoom) {
      gantt.ext.zoom.init(ZOOM_CONFIG as any);
      gantt.ext.zoom.setLevel(timeScale);
    }

    // Initialize gantt
    gantt.init(containerRef.current);
    initialized.current = true;

    let detachTimelineShortcutListeners: (() => void) | null = null;
    const taskDataElement = gantt.$task_data as HTMLElement | undefined;
    if (taskDataElement) {
      const resolveShortcutContextFromPointer = (clientX: number, clientY: number) => {
        const target = document.elementFromPoint(clientX, clientY);
        const shortcutContext = resolveTimelineShortcutContext({
          eventTarget: target,
          clientX,
          timelineElement: taskDataElement,
          taskAttribute: gantt.config.task_attribute,
          dateFromPos: (x) => gantt.dateFromPos(x),
        });

        if (shortcutContext && gantt.isTaskExists(shortcutContext.taskId)) {
          return shortcutContext;
        }

        const rect = taskDataElement.getBoundingClientRect();
        const relativeY = clientY - rect.top + taskDataElement.scrollTop;
        const timelineView = gantt.$ui.getView('timeline') as {
          getItemIndexByTopPosition?: (top: number) => number;
        } | null;
        const index = timelineView?.getItemIndexByTopPosition?.(relativeY);

        if (typeof index === 'number' && index >= 0) {
          const task = gantt.getTaskByIndex(index);
          const date = gantt.dateFromPos(clientX - rect.left + taskDataElement.scrollLeft);
          if (task?.id && date) {
            return {
              taskId: Number(task.id),
              date: new Date(date.getFullYear(), date.getMonth(), date.getDate()),
            };
          }
        }

        return null;
      };

      const updateTimelineShortcutState = (event: MouseEvent) => {
        const rect = taskDataElement.getBoundingClientRect();
        const isInsideTimeline =
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom;

        if (!isInsideTimeline) {
          isTimelinePointerActiveRef.current = false;
          return;
        }

        lastTimelinePointerPositionRef.current = {
          clientX: event.clientX,
          clientY: event.clientY,
        };
        isTimelinePointerActiveRef.current = true;

        const shortcutContext = resolveShortcutContextFromPointer(event.clientX, event.clientY);
        if (shortcutContext) {
          lastTimelineShortcutRef.current = shortcutContext;
        }
      };

      const clearTimelineShortcutState = () => {
        isTimelinePointerActiveRef.current = false;
      };

      document.addEventListener('mousemove', updateTimelineShortcutState, true);
      document.addEventListener('mousedown', updateTimelineShortcutState, true);
      taskDataElement.addEventListener('mouseleave', clearTimelineShortcutState, true);
      detachTimelineShortcutListeners = () => {
        document.removeEventListener('mousemove', updateTimelineShortcutState, true);
        document.removeEventListener('mousedown', updateTimelineShortcutState, true);
        taskDataElement.removeEventListener('mouseleave', clearTimelineShortcutState, true);
      };
    }

    gantt.attachEvent('onBeforeTaskDisplay', function (id: string | number) {
      const currentFilter = filterRef.current;
      if (!currentFilter) return true;
      return visibleTaskIdsRef.current.has(Number(id));
    });

    // Add today marker
    gantt.addMarker({
      start_date: new Date(),
      css: 'today',
      text: 'Now',
    });



    // cleanup
    return () => {
      if (detachTimelineShortcutListeners) {
        detachTimelineShortcutListeners();
      }
      if (filterRefreshFrameRef.current !== null) {
        cancelAnimationFrame(filterRefreshFrameRef.current);
        filterRefreshFrameRef.current = null;
      }

      gantt.clearAll();
    };
  // 初期化は一度だけ行い、timeScale変更は専用Effectで反映する
  }, []);

  // Drag Scroll Logic - Dedicated Effect
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let scrollLeft = 0;
    let scrollTop = 0;

    const handleMouseDown = (e: MouseEvent) => {
      // Middle mouse button (1) or Left mouse button (0)
      if (e.button === 1 || e.button === 0) {
        // For Left click, check if the target is an "empty" area
        if (e.button === 0) {
          // 0. Check if DHTMLX is already handling a drag
          if ((gantt.getState() as any).drag_id) return;

          const isDhtmlxInteractiveElement = (element: Element | null) => {
            if (!element) return false;
            return !!element.closest(
              '.gantt_task_line, .gantt_task_content, .gantt_task_progress, .gantt_task_drag, .gantt_link_control, .gantt_link_point, .gantt_task_link'
            );
          };

          // 1. Precise Hit Test: Check all elements at the click position
          // This handles cases where z-index causes e.target to be the background even when over a task
          const elements = document.elementsFromPoint(e.clientX, e.clientY);
          const isTaskRelated = elements.some(el => isDhtmlxInteractiveElement(el));

          if (isTaskRelated) {
            return;
          }

          let targetNode: Node | null = e.target as Node;
          if (targetNode && !(targetNode instanceof Element)) {
            targetNode = targetNode.parentElement;
          }
          if (!targetNode) return;
          const target = targetNode as HTMLElement;

          // 2. Ignore interactions in the Grid (Left side) and Scale (Header)
          if (target.closest('.gantt_grid') || target.closest('.gantt_grid_scale') || target.closest('.gantt_task_scale')) {
            return;
          }

          // 3. Fallback: Check if DHTMLX identifies a task (via bubbling logic usually)
          if (gantt.locate(e)) return;

          // 4. Standard interactive class check (for things not caught by above)
          const interactiveClasses = [
            'gantt_task_line', 'gantt_task_content',
            'gantt_link_control', 'gantt_link_point', 'gantt_link_line',
            'gantt_task_drag',
            'gantt_hor_scroll', 'gantt_ver_scroll'
          ];

          let isInteractive = false;
          let current = target;
          while (current && current !== container) {
            if (isDhtmlxInteractiveElement(current) || interactiveClasses.some(cls => current.classList.contains(cls))) { isInteractive = true; break; }
            if (['circle', 'path', 'INPUT', 'TEXTAREA', 'A', 'SELECT'].includes(current.tagName)) { isInteractive = true; break; }
            current = current.parentElement as HTMLElement;
          }
          if (isInteractive) return;
        }

        e.preventDefault();
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        scrollLeft = gantt.getScrollState().x;
        scrollTop = gantt.getScrollState().y;
        container.style.cursor = 'grabbing';
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      e.preventDefault();
      const x = e.clientX;
      const y = e.clientY;
      const walkX = (x - startX);
      const walkY = (y - startY);
      gantt.scrollTo(scrollLeft - walkX, scrollTop - walkY);
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (isDragging) {
        if (e.button === 1) e.preventDefault();
        isDragging = false;
        container.style.cursor = 'default';
      }
    };

    container.addEventListener('mousedown', handleMouseDown, { capture: true });
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      container.removeEventListener('mousedown', handleMouseDown, { capture: true });
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (event: WheelEvent) => {
      if (event.defaultPrevented) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

      const target = event.target;
      if (target instanceof Element && target.closest('.gantt_hor_scroll, .gantt_ver_scroll')) {
        return;
      }

      const scrollState = gantt.getScrollState();
      const nextY = Math.max(0, scrollState.y + event.deltaY);
      if (nextY === scrollState.y) return;

      event.preventDefault();
      gantt.scrollTo(scrollState.x, nextY);
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleLinkClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const linkElement = target.closest('a[data-task-id][data-hyperlink]');
      if (!(linkElement instanceof HTMLAnchorElement)) return;

      const taskId = Number(linkElement.dataset.taskId);
      const hyperlink = linkElement.dataset.hyperlink || '';
      if (!taskId || !hyperlink) return;

      event.preventDefault();
      void openResolvedHyperlink(taskId, hyperlink);
    };

    container.addEventListener('click', handleLinkClick, true);
    return () => {
      container.removeEventListener('click', handleLinkClick, true);
    };
  }, [openResolvedHyperlink]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const getSchedulePinContext = (target: EventTarget | null): SchedulePinContext | null => {
      if (!(target instanceof Element)) return null;
      const scheduleEl = target.closest('.gantt-schedule-event');
      if (!(scheduleEl instanceof HTMLElement)) return null;

      const taskId = Number(scheduleEl.dataset.taskId);
      const sourceIndex = Number(scheduleEl.dataset.scheduleIndex);
      const dateStr = scheduleEl.dataset.scheduleDate || '';
      const text = scheduleEl.dataset.scheduleText || '';
      const date = new Date(`${dateStr}T00:00:00`);

      if (!taskId || Number.isNaN(sourceIndex) || Number.isNaN(date.getTime())) {
        return null;
      }

      return { taskId, sourceIndex, text, date };
    };

    const resolveDropTaskId = (clientY: number): number | null => {
      const taskDataElement = gantt.$task_data as HTMLElement | undefined;
      if (!taskDataElement) return null;

      const rect = taskDataElement.getBoundingClientRect();
      const relativeY = clientY - rect.top + taskDataElement.scrollTop;
      const timelineView = gantt.$ui.getView('timeline') as {
        getItemIndexByTopPosition?: (top: number) => number;
      } | null;
      const index = timelineView?.getItemIndexByTopPosition?.(relativeY);

      if (typeof index !== 'number' || index < 0) return null;

      const task = gantt.getTaskByIndex(index);
      if (!task?.id || !gantt.isTaskExists(task.id)) return null;

      return Number(task.id);
    };

    const handleScheduleContextMenu = (event: MouseEvent) => {
      const context = getSchedulePinContext(event.target);
      if (!context) return;

      event.preventDefault();
      event.stopPropagation();
      setContextMenu({
        visible: true,
        x: event.clientX,
        y: event.clientY,
        items: [
          {
            label: 'スケジュール名を編集',
            icon: '✏️',
            action: () => {
              setScheduleModal({
                isOpen: true,
                taskId: context.taskId,
                initialDate: context.date,
                initialText: context.text,
                sourceIndex: context.sourceIndex,
                mode: 'edit',
              });
            },
          },
          {
            label: 'スケジュールを削除',
            icon: '🗑️',
            danger: true,
            action: () => {
              const task = gantt.getTask(context.taskId);
              const currentSchedule = task.task_schedule || '';
              const newSchedule = removeScheduleAtIndex(currentSchedule, context.sourceIndex);
              persistScheduleRef.current(context.taskId, newSchedule);
            },
          },
        ],
      });
    };

    const handleScheduleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const context = getSchedulePinContext(event.target);
      if (!context) return;

      const scheduleEl = (event.target as Element).closest('.gantt-schedule-event');
      if (!(scheduleEl instanceof HTMLElement)) return;

      event.preventDefault();
      event.stopPropagation();
      scheduleDragRef.current = {
        taskId: context.taskId,
        sourceIndex: context.sourceIndex,
        startX: event.clientX,
        startY: event.clientY,
        element: scheduleEl,
        dragged: false,
      };
      scheduleEl.classList.add('dragging');
    };

    const handleScheduleMouseMove = (event: MouseEvent) => {
      const dragState = scheduleDragRef.current;
      if (!dragState) return;

      const deltaX = event.clientX - dragState.startX;
      const deltaY = event.clientY - dragState.startY;
      if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
        dragState.dragged = true;
      }
      dragState.element.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
    };

    const handleScheduleMouseUp = (event: MouseEvent) => {
      const dragState = scheduleDragRef.current;
      if (!dragState) return;

      dragState.element.classList.remove('dragging');
      dragState.element.style.transform = '';
      scheduleDragRef.current = null;

      if (!dragState.dragged) {
        return;
      }

      const taskDataElement = gantt.$task_data as HTMLElement | undefined;
      if (!taskDataElement || !gantt.isTaskExists(dragState.taskId)) return;

      const rect = taskDataElement.getBoundingClientRect();
      const relativeX = event.clientX - rect.left + taskDataElement.scrollLeft;
      const targetDate = gantt.dateFromPos(relativeX);
      if (!targetDate) return;

      const sourceTask = gantt.getTask(dragState.taskId);
      const sourceSchedule = sourceTask.task_schedule || '';
      const movedEvent = getScheduleAtIndex(sourceSchedule, dragState.sourceIndex);
      if (!movedEvent) return;

      const targetTaskId = resolveDropTaskId(event.clientY) ?? dragState.taskId;
      const targetDateStr = formatDateForSchedule(targetDate);

      if (targetTaskId === dragState.taskId) {
        const newSchedule = moveScheduleAtIndex(sourceSchedule, dragState.sourceIndex, targetDateStr);
        persistScheduleRef.current(dragState.taskId, newSchedule);
        return;
      }

      if (!gantt.isTaskExists(targetTaskId)) return;

      const targetTask = gantt.getTask(targetTaskId);
      const newSourceSchedule = removeScheduleAtIndex(sourceSchedule, dragState.sourceIndex);
      const newTargetSchedule = addOrUpdateSchedule(targetTask.task_schedule || '', targetDateStr, movedEvent.text);

      persistScheduleRef.current(dragState.taskId, newSourceSchedule);
      persistScheduleRef.current(targetTaskId, newTargetSchedule);
    };

    const handleHeaderContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.gantt_task_scale, .gantt_scale_cell, .gantt_scale_line')) return;

      const taskData = gantt.$task_data as HTMLElement | undefined;
      if (!taskData) return;

      event.preventDefault();
      event.stopPropagation();

      const rect = taskData.getBoundingClientRect();
      const relativeX = event.clientX - rect.left + taskData.scrollLeft;
      const clickedDate = gantt.dateFromPos(relativeX);
      if (!clickedDate) return;

      const dateStr = formatDateToYMD(clickedDate);
      const isHoliday = holidaySetRef.current.has(dateStr);
      const items = getDateHeaderContextMenuItems(clickedDate, isHoliday, {
        onAddHoliday: (d) => handleAddHolidayRef.current?.(d),
        onRemoveHoliday: (d) => handleRemoveHolidayRef.current?.(d),
      });

      setContextMenu({
        visible: true,
        x: event.clientX,
        y: event.clientY,
        items,
      });
    };

    container.addEventListener('contextmenu', handleHeaderContextMenu, true);
    container.addEventListener('contextmenu', handleScheduleContextMenu, true);
    container.addEventListener('mousedown', handleScheduleMouseDown, true);
    document.addEventListener('mousemove', handleScheduleMouseMove, true);
    document.addEventListener('mouseup', handleScheduleMouseUp, true);

    return () => {
      container.removeEventListener('contextmenu', handleHeaderContextMenu, true);
      container.removeEventListener('contextmenu', handleScheduleContextMenu, true);
      container.removeEventListener('mousedown', handleScheduleMouseDown, true);
      document.removeEventListener('mousemove', handleScheduleMouseMove, true);
      document.removeEventListener('mouseup', handleScheduleMouseUp, true);
    };
  }, []);

  // Load data when tasks/links change
  useEffect(() => {
    if (!initialized.current) return;

    if (isInternalChange.current > 0) {
      isInternalChange.current -= 1;
      return;
    }

    // 差分更新: clearAll()による全DOM再構築を回避し、画面のちらつきを防止
    // （Windows環境での画面真っ黒問題の対策）
    const ganttTasks = tasks.map((task) => {
      // DHTMLX Gantt内部で TypeError date.getFullYear is not a function エラーを
      // 回避するために明示的にDateオブジェクトに変換する
      const startDate = task.start_date ? new Date(String(task.start_date).replace(' ', 'T')) : undefined;
      const endDate = task.end_date ? new Date(String(task.end_date).replace(' ', 'T')) : undefined;

      return {
        ...task,
        start_date: startDate,
        end_date: endDate,
        open: task.expanded !== false,
      };
    });
    const ganttLinks = links.map((link) => ({
      ...link,
      type: String(link.type),
    }));

    // 差分同期中フラグをONにして、onBeforeTaskDeleteなどのAPI呼び出しを防ぐ
    isSyncingRef.current = true;

    // Undoスタックを保存して差分同期後に復元する
    // （silent内のaddTask/deleteTask/updateTaskがUndoスタックを汚染するのを防ぐ）
    const undoStack = gantt.getUndoStack ? gantt.getUndoStack().slice() : [];
    const redoStack = gantt.getRedoStack ? gantt.getRedoStack().slice() : [];

    // silent()でイベント発火を抑制し、onAfterTaskUpdateの無限ループを防止
    gantt.silent(() => {
      // 既存のタスクの開閉状態をすべて保存しておく
      const openStates = new Map<string | number, boolean>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      gantt.eachTask((t: any) => {
        openStates.set(t.id, t.$open);
      });

      // 既存のタスクIDセットを取得
      const existingTaskIds = new Set<string | number>();
      gantt.eachTask((task: any) => {
        existingTaskIds.add(String(task.id));
      });
      const newTaskIds = new Set(ganttTasks.map(t => String(t.id)));

      // 削除されたタスクを除去
      const toDelete: (string | number)[] = [];
      existingTaskIds.forEach(id => {
        if (!newTaskIds.has(String(id))) {
          toDelete.push(id);
        }
      });
      toDelete.forEach(id => {
        if (gantt.isTaskExists(id)) {
          gantt.deleteTask(id);
        }
      });

      // 新規・更新タスクを処理
      ganttTasks.forEach(task => {
        if (gantt.isTaskExists(task.id)) {
          // 既存タスクを更新
          const existing = gantt.getTask(task.id);
          Object.assign(existing, task);
          gantt.updateTask(task.id);
        } else {
          // 新規タスクを追加（初期値は全てオープン）
          task.open = true;
          (task as any).$open = true;
          gantt.addTask(task);

          if (gantt.isTaskExists(task.id)) {
            const addedTask = gantt.getTask(task.id);
            addedTask.open = true;
            addedTask.$open = true;
          }
        }
      });

      // リンクの差分更新
      const existingLinkIds = new Set<string | number>();
      gantt.getLinks().forEach((link: any) => {
        existingLinkIds.add(String(link.id));
      });
      const newLinkIds = new Set(ganttLinks.map(l => String(l.id)));

      // 削除されたリンクを除去
      existingLinkIds.forEach(id => {
        if (!newLinkIds.has(String(id)) && gantt.isLinkExists(id)) {
          gantt.deleteLink(id);
        }
      });

      // 新規・更新リンクを処理
      ganttLinks.forEach(link => {
        if (gantt.isLinkExists(link.id)) {
          const existing = gantt.getLink(link.id);
          Object.assign(existing, link);
          gantt.updateLink(link.id);
        } else {
          gantt.addLink(link);
        }
      });

      // すべての処理が終わったあとに、保存しておいた開閉状態を復元する
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      gantt.eachTask((t: any) => {
        if (openStates.has(t.id)) {
          t.$open = openStates.get(t.id);
          t.open = openStates.get(t.id);
        }
      });
    });

    // Undoスタックを復元（差分同期で汚染された履歴を元に戻す）
    if (gantt.getUndoStack) {
      const currentUndo = gantt.getUndoStack();
      currentUndo.length = 0;
      undoStack.forEach((item: any) => currentUndo.push(item));
    }
    if (gantt.getRedoStack) {
      const currentRedo = gantt.getRedoStack();
      currentRedo.length = 0;
      redoStack.forEach((item: any) => currentRedo.push(item));
    }

    // 差分同期完了
    isSyncingRef.current = false;

    // 今日のマーカー（赤い線）がなければ追加
    const todayMarkerId = 'today-marker';
    if (!gantt.getMarker(todayMarkerId)) {
      gantt.addMarker({
        id: todayMarkerId,
        start_date: new Date(),
        css: 'today',
        text: 'Now',
      });
    }

    // 初回のみ：全タスクを開いた状態にし、今日へスクロール
    if (!initialRenderRef.current && tasks.length > 0) {
      initialRenderRef.current = true;
      gantt.eachTask((task: any) => {
        task.$open = true;
      });
      setTimeout(() => {
        gantt.showDate(new Date());
      }, 50);
    }

    // timelineが勝手に狭まってタスクが消えるのを防ぐため、表示範囲を再設定
    const todayData = new Date();
    const oneYearAgoData = new Date(todayData);
    oneYearAgoData.setFullYear(oneYearAgoData.getFullYear() - 1);
    const oneYearLaterData = new Date(todayData);
    oneYearLaterData.setFullYear(oneYearLaterData.getFullYear() + 1);
    gantt.config.start_date = oneYearAgoData;
    gantt.config.end_date = oneYearLaterData;

    gantt.render();
  }, [tasks, links]);

  useEffect(() => {
    if (!externalOpenTaskRequest) return;
    if (externalOpenHandledRequestIdRef.current === externalOpenTaskRequest.requestId) return;

    const opened = openTaskInput(externalOpenTaskRequest.taskId);
    if (opened) {
      externalOpenHandledRequestIdRef.current = externalOpenTaskRequest.requestId;
      onExternalOpenHandled?.(externalOpenTaskRequest.requestId);
    }
  }, [externalOpenTaskRequest, onExternalOpenHandled, openTaskInput, tasks]);

  // Update zoom level when timeScale changes
  useEffect(() => {
    if (initialized.current && gantt.ext && gantt.ext.zoom) {
      gantt.ext.zoom.setLevel(timeScale);
      gantt.render();
    }
  }, [timeScale]);

  useEffect(() => {
    holidaySetRef.current = new Set(holidays.map((holiday) => holiday.trim()).filter(Boolean));
    if (initialized.current) {
      gantt.render();
    }
  }, [holidays]);

  useEffect(() => {
    businessTripMapRef.current = new Map(
      businessTrips
        .filter((trip) => trip.date && (trip.type === 'normal_trip' || trip.type === 'day_trip'))
        .map((trip) => [trip.date.trim(), trip.type])
    );
    if (initialized.current) {
      gantt.render();
    }
  }, [businessTrips]);

  // Handle grid collapse/expand - グリッド折りたたみ時にチャートを拡張
  useEffect(() => {
    if (!initialized.current) return;

    // 印刷モード時は無視（印刷モード用のEffectで制御）
    if (isPrintMode) return;

    // DHTMLXの公式APIを使ってグリッドの表示/非表示を切り替える
    gantt.config.show_grid = !gridCollapsed;
    gantt.config.grid_width = gridCollapsed ? 0 : gridWidth;

    // サイズを再計算して再描画
    gantt.render();
  }, [gridCollapsed, isPrintMode, gridWidth]);

  // Handle Print Mode
  useEffect(() => {
    if (!initialized.current) return;

    if (isPrintMode) {
      // Print View Configuration
      gantt.config.show_grid = false;

      // Simplify task text for print - display on right side
      gantt.templates.task_text = () => '';
      gantt.templates.rightside_text = (_start: Date, _end: Date, task: any) => {
        return task.text;
      };

      // Scroll to today
      gantt.showDate(new Date());

    } else {
      // Restore Normal View Configuration (respecting current grid collapse state)
      gantt.config.show_grid = !gridCollapsed;
      gantt.config.grid_width = gridCollapsed ? 0 : gridWidth;

      // Restore templates (matching initialization)
      gantt.templates.task_text = (_start: Date, _end: Date, task: any) => {
        const scheduleHtml = buildScheduleHtml(task);

        if (String(task.kind_task) === '1' || String(task.kind_task) === '3') {
          return scheduleHtml;
        }

        const idPrefix = task.id ? `[${task.id}]` : '';
        const label = idPrefix ? `${idPrefix}${task.text}` : task.text;

        // ピン要素(scheduleHtml)と、テキスト表示用コンテナを別々に配置する
        const wrapperStyle = "position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: 10; pointer-events: none; display: flex; align-items: center; overflow: visible;";
        const labelStyle = "margin-left: 30px; pointer-events: auto; flex-shrink: 0; white-space: nowrap; display: inline-block;";

        let labelHtml = '';
        if (task.hyperlink) {
          labelHtml = `<a href="#" data-task-id="${task.id}" data-hyperlink="${task.hyperlink}" style="${labelStyle}">${label}</a>`;
        } else {
          labelHtml = `<span style="${labelStyle}">${label}</span>`;
        }

        return `${scheduleHtml}<div style="${wrapperStyle}">${labelHtml}</div>`;
      };

      gantt.templates.rightside_text = (_start: Date, _end: Date, task: any) => {
        if (String(task.kind_task) === '2') {
          return '';
        }
        const idPrefix = task.id ? `[${task.id}]` : '';
        const currentTaskInfo = idPrefix ? `${idPrefix} ${task.text}` : task.text;
        let parentInfo = '';
        try {
          if (task.parent && task.parent !== 0 && gantt.isTaskExists(task.parent)) {
            const parentTask = gantt.getTask(task.parent);
            if (parentTask) {
              const parentIdPrefix = parentTask.id ? `[${parentTask.id}]` : '';
              parentInfo = parentIdPrefix ? `${parentIdPrefix} ${parentTask.text}` : parentTask.text;
            }
          }
        } catch { }
        const displayText = parentInfo ? `${currentTaskInfo} > ${parentInfo}` : currentTaskInfo;
        if (task.hyperlink) {
          return `<a href="#" data-task-id="${task.id}" data-hyperlink="${task.hyperlink}">${displayText}</a>`;
        }
        return displayText;
      };
    }

    gantt.render();
  }, [isPrintMode, gridCollapsed, gridWidth]);


  // Render
  // Gantt container needs to be wrapped or have the modal adjacent
  // But GanttChart returns pure DOM initialization in useEffect.
  // We need to return JSX. 
  // The current component structure returns:
  /*
    return () => {
      gantt.clearAll();
    };
  }, [handleEditTask, ...]); 
  */
  // Wait, the component currently does NOT return JSX at the end of the functional component?
  // Let me check the full file content again to see where the return statement is.
  // Ah, I need to see the end of the file.

  // Checking the file content previously viewed:
  // It ends with useEffect hooks. I haven't seen the `return` statement of the component `GanttChart`.
  // I need to find where to put the Modal in the return JSX key.

  // Let's assume standard React component structure.

  // Since I cannot see the return statement in the previous view_file output (it was truncated),
  // I should probably view the end of the file first.

  // Changing strategy: I will apply the other changes first, then view the end of the file to add the modal to JSX.

  // I will just apply the logic changes for now.
  // And I will assume the return statement is at the end.



  // Expand all tasks - オリジナルアプリと同じ方式でgantt内部を直接操作
  useEffect(() => {
    if (!initialized.current || expandAllTrigger === 0) return;

    gantt.eachTask(function (task) {
      task.$open = true;
    });
    gantt.render();
  }, [expandAllTrigger]);

  // Collapse all tasks - オリジナルアプリと同じ方式でgantt内部を直接操作
  useEffect(() => {
    if (!initialized.current || collapseAllTrigger === 0) return;

    gantt.eachTask(function (task) {
      task.$open = false;
    });
    gantt.render();
  }, [collapseAllTrigger]);

  // Update display size when displaySize changes
  useEffect(() => {
    if (!initialized.current) return;

    const scale = displaySize / 100;

    // Update gantt config
    gantt.config.scale_height = Math.round(60 * scale);
    gantt.config.row_height = Math.round(27 * scale);
    gantt.config.bar_height = Math.max(12, Math.round(18 * scale));
    gantt.config.min_column_width = Math.round(30 * scale);

    // Calculate font sizes (minimum 8px)
    const baseFontSize = Math.max(8, Math.round(12 * scale));
    const taskContentFontSize = Math.max(8, Math.round(10 * scale));
    const sideContentFontSize = Math.max(8, Math.round(11 * scale));

    // Update or create dynamic style element
    let styleElement = document.getElementById('gantt-scale-style');
    if (!styleElement) {
      styleElement = document.createElement('style');
      styleElement.id = 'gantt-scale-style';
      document.head.appendChild(styleElement);
    }

    styleElement.textContent = `
      /* 基本的なフォントサイズ */
      .gantt_scale_cell, 
      .gantt_grid_head_cell, 
      .gantt_task_cell, 
      .gantt_grid_data,
      .gantt_row,
      .gantt_cell,
      .gantt_grid_data .gantt_cell.gantt_last_cell,
      .gantt_grid_scale .gantt_grid_head_cell,
      .gantt_grid_data .gantt_row.odd:hover, 
      .gantt_grid_data .gantt_row:hover {
        font-size: ${baseFontSize}px !important;
      }
      
      /* タスクコンテンツのフォントサイズ */
      .gantt_task_content {
        font-size: ${taskContentFontSize}px !important;
      }
      
      /* サイドコンテンツのフォントサイズ */
      .gantt_side_content {
        font-size: ${sideContentFontSize}px !important;
      }
      
      /* 階層パスのフォントサイズ */
      .hierarchy-path {
        font-size: ${baseFontSize}px !important;
      }
      
      /* ライトボックスのフォントサイズ */
      .gantt_cal_light,
      .gantt_cal_light .gantt_cal_ltext .gantt_section_time,
      .gantt_cal_light .gantt_cal_larea,
      .gantt_cal_light .gantt_cal_ltext textarea,
      .gantt_cal_light select,
      .gantt_cal_light input {
        font-size: ${baseFontSize}px !important;
      }
    `;

    // Re-render gantt to apply changes
    gantt.render();
  }, [displaySize]);

  // 検索フィルタリング処理: onBeforeTaskDisplayイベントを使用して
  // 親タスクを維持しながら子タスクが孤立しないようにする
  // 事前計算Map方式でO(n)に最適化
  useEffect(() => {
    if (!initialized.current) return;

    // Update filter ref
    filterRef.current = filter;
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

    if (filterRefreshFrameRef.current !== null) {
      cancelAnimationFrame(filterRefreshFrameRef.current);
    }
    filterRefreshFrameRef.current = requestAnimationFrame(() => {
      filterRefreshFrameRef.current = null;
      gantt.refreshData();
    });
  }, [
    tasks,
    taskFilterIndexes,
    synonyms,
    filter?.searchText,
    filter?.searchProject,
    filter?.showCompleted,
    filter?.owner,
    filter?.showType,
    filter?.pinnedMode,
    filter?.periodMode,
    filter?.dateRangeStart,
    filter?.dateRangeEnd,
  ]);

  // Keyboard shortcuts for undo/redo and copy/paste
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // Lightbox open case: Lightbox使用中のキーボードイベント制御
      if (gantt.getState().lightbox) {
        if (e.key === 'Enter' && !e.isComposing) {
          if (!e.shiftKey) {
            // Normal enter: 保存処理を実行
            e.preventDefault();
            e.stopPropagation();
            const saveBtn = document.querySelector('.gantt_btn_set.gantt_save_btn_set');
            if (saveBtn) (saveBtn as HTMLElement).click();
          } else {
            // Shift + Enter: テキストエリア内での改行を許可し、Ganttデフォルトの保存機能(Enterで保存)をブロック
            e.stopPropagation();
          }
        } else if (e.key === 'Tab') {
          // Tab: 次の入力欄へ移動（Ganttのデフォルト挙動を上書き）
          const inputs = Array.from(document.querySelectorAll('.gantt_cal_light textarea')) as HTMLTextAreaElement[];
          if (inputs.length > 0) {
            e.preventDefault();
            e.stopPropagation();
            const activeEl = document.activeElement as HTMLTextAreaElement;
            const currentIndex = inputs.indexOf(activeEl);
            let nextIndex;
            if (currentIndex === -1) {
              nextIndex = e.shiftKey ? inputs.length - 1 : 0;
            } else {
              nextIndex = e.shiftKey ? currentIndex - 1 : currentIndex + 1;
            }
            if (nextIndex >= inputs.length) nextIndex = 0;
            if (nextIndex < 0) nextIndex = inputs.length - 1;
            inputs[nextIndex].focus();
          }
        } else if (e.key === 'Escape') {
          // Escキーでのキャンセルは通常通りDHTMLXに任せる、またはここで明示的に処理
          // 伝播を止めないのでそのままDHTMLXの処理に委ねる
        }
        return; // Lightbox表示中は以下のGanttチャート上の操作を行わない
      }

      const modifierPressed = e.ctrlKey || e.metaKey;

      if (modifierPressed && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          gantt.redo();
        } else {
          gantt.undo();
        }
        return;
      }

      if (modifierPressed && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        gantt.redo();
        return;
      }

      // Enter key -> Cmd+Enter → 選択のトグル、Enter → Lightbox表示
      if (e.key === 'Enter') {
        // Lightbox以外のモーダルや入力欄でのEnter押下をGanttとしてのEnterと誤認しないようにする
        const activeTag = document.activeElement?.tagName.toLowerCase();
        if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'button' || activeTag === 'select') return;

        const currentActiveId = lastSelectedIdRef.current || gantt.getSelectedId();
        if (currentActiveId) {
          e.preventDefault();
          if (modifierPressed) {
            // Cmd + Enter: Toggle selection
            const selectedTasks = (gantt as any).getSelectedTasks ? (gantt as any).getSelectedTasks() : [];
            if (selectedTasks.includes(String(currentActiveId)) || selectedTasks.includes(Number(currentActiveId))) {
              gantt.unselectTask(currentActiveId);
            } else {
              gantt.selectTask(currentActiveId);
            }
            gantt.render(); // update focus indicator if any
            return;
          }

          // Normal Enter: Open Lightbox immediately
          isKeyboardFocusModeRef.current = false;
          gantt.showLightbox(currentActiveId);
          return;
        }
      }

      // Delete / Backspace for multi-delete
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Gantt内にフォーカスがあるか確認（input/textareaの場合はスキップ）
        const activeTag = document.activeElement?.tagName.toLowerCase();
        if (activeTag === 'input' || activeTag === 'textarea') return;

        const selectedTasks = (gantt as any).getSelectedTasks ? (gantt as any).getSelectedTasks() : [];
        if (selectedTasks.length > 0) {
          e.preventDefault();
          if (window.confirm(`選択された ${selectedTasks.length} 件のタスクを削除しますか？`)) {
            // 複数選択の中で最も上に表示されているタスク（Global Indexが最小のもの）を特定する
            let topMostTaskId = selectedTasks[0];
            let minIndex = gantt.getGlobalTaskIndex(topMostTaskId);

            for (let i = 1; i < selectedTasks.length; i++) {
              const idx = gantt.getGlobalTaskIndex(selectedTasks[i]);
              if (idx < minIndex) {
                minIndex = idx;
                topMostTaskId = selectedTasks[i];
              }
            }
            // 一番上のタスクの直前のタスクIDを取得
            const prevId = gantt.getPrev(topMostTaskId);

            // 現在の選択配列をコピー。削除処理中に配列が変化することを防ぐ。
            const tasksToDelete = [...selectedTasks];
            tasksToDelete.forEach((taskId) => {
              // 既に親と一緒に削除されている可能性もあるため存在チェック
              if (gantt.isTaskExists(taskId)) {
                gantt.deleteTask(taskId);
              }
            });

            // 削除後、上のタスクがあれば選択状態にする
            if (prevId && gantt.isTaskExists(prevId)) {
              gantt.selectTask(prevId);
              lastSelectedIdRef.current = prevId;
            } else {
              // なければフォーカスをリセット
              lastSelectedIdRef.current = null;
            }
          }
          return;
        }
      }

      // Shift + UP / DOWN for multi-select
      if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const currentActiveId = lastSelectedIdRef.current || gantt.getSelectedId();
        if (currentActiveId) {
          e.preventDefault();
          const nextId = e.key === 'ArrowUp' ? gantt.getPrev(currentActiveId) : gantt.getNext(currentActiveId);
          if (nextId) {
            const selectedTasks = (gantt as any).getSelectedTasks ? (gantt as any).getSelectedTasks() : [];
            const isNextSelected = selectedTasks.includes(String(nextId)) || selectedTasks.includes(Number(nextId));

            if (!isNextSelected) {
              // 範囲を広げる：新たに追加選択
              gantt.selectTask(nextId);
              lastSelectedIdRef.current = nextId;
            } else {
              // 選択しすぎたので戻る：現在のタスクの選択を解除
              gantt.unselectTask(currentActiveId);
              lastSelectedIdRef.current = nextId;
            }
            scrollTaskIntoView(nextId);
          }
          return;
        }
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // 単一選択での移動、またはCmd押しでのフォーカスのみ移動
        const currentActiveId = lastSelectedIdRef.current || gantt.getSelectedId();
        if (currentActiveId) {
          e.preventDefault();
          const nextId = e.key === 'ArrowUp' ? gantt.getPrev(currentActiveId) : gantt.getNext(currentActiveId);
          if (nextId) {
            if (modifierPressed) {
              // Cmd + Arrow: フォーカスだけ移動して選択状態は変えない
              lastSelectedIdRef.current = nextId;
              isKeyboardFocusModeRef.current = true;
              gantt.render(); // force render to update focus class
              scrollTaskIntoView(nextId);
            } else {
              // Normal Arrow: これまでの選択をクリアして次を選択
              const selectedTasks = (gantt as any).getSelectedTasks ? (gantt as any).getSelectedTasks() : [];
              selectedTasks.forEach((taskId: string | number) => gantt.unselectTask(taskId));
              isKeyboardFocusModeRef.current = false;
              gantt.selectTask(nextId);
              lastSelectedIdRef.current = nextId;
              scrollTaskIntoView(nextId);
            }
          }
          return;
        }
      }

      // A key for adding tasks
      if (!modifierPressed && e.key.toLowerCase() === 'a') {
        const activeTag = document.activeElement?.tagName.toLowerCase();
        if (activeTag === 'input' || activeTag === 'textarea') return;

        const currentActiveId = lastSelectedIdRef.current || gantt.getSelectedId();
        if (currentActiveId && gantt.isTaskExists(currentActiveId)) {
          e.preventDefault();
          const task = gantt.getTask(currentActiveId);
          const isProject = String(task.kind_task) === '2';

          let createdTask: Task | undefined;
          if (isProject) {
            createdTask = await handleAddChildRef.current(Number(currentActiveId), 1 as any);
          } else {
            const parentId = task.parent ? Number(task.parent) : 0;
            const sortorder = task.sortorder;
            if (parentId === 0) {
              createdTask = await handleAddNewTaskRef.current(null, 1 as any, sortorder);
            } else {
              createdTask = await handleAddChildRef.current(parentId, 1 as any, sortorder);
            }
          }

          // タスク追加後、すぐに編集ウィンドウを開く
          if (createdTask && createdTask.id) {
            gantt.showLightbox(createdTask.id);
          }
        }
        return;
      }

      // O key for creating Obsidian note
      if (!modifierPressed && e.key.toLowerCase() === 's') {
        const activeTag = document.activeElement?.tagName.toLowerCase();
        if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'button' || activeTag === 'select') return;

        const pointerPosition = lastTimelinePointerPositionRef.current;
        const taskDataElement = gantt.$task_data as HTMLElement | undefined;
        if (!isTimelinePointerActiveRef.current || !pointerPosition || !taskDataElement) {
          return;
        }

        const shortcutTarget = resolveTimelineShortcutContext({
          eventTarget: document.elementFromPoint(pointerPosition.clientX, pointerPosition.clientY),
          clientX: pointerPosition.clientX,
          timelineElement: taskDataElement,
          taskAttribute: gantt.config.task_attribute,
          dateFromPos: (x) => gantt.dateFromPos(x),
        }) ?? lastTimelineShortcutRef.current;

        if (!shortcutTarget) {
          return;
        }

        if (gantt.isTaskExists(shortcutTarget.taskId)) {
          e.preventDefault();
          setScheduleModal({
            isOpen: true,
            taskId: shortcutTarget.taskId,
            initialDate: shortcutTarget.date,
            initialText: '',
            sourceIndex: null,
            mode: 'create',
          });
        }
        return;
      }

      // O key for creating Obsidian note
      if (!modifierPressed && e.key.toLowerCase() === 'o') {
        const activeTag = document.activeElement?.tagName.toLowerCase();
        if (activeTag === 'input' || activeTag === 'textarea') return;

        const currentActiveId = lastSelectedIdRef.current || gantt.getSelectedId();
        if (currentActiveId && gantt.isTaskExists(currentActiveId)) {
          e.preventDefault();
          handleCreateObsidianNoteRef.current(Number(currentActiveId));
        }
        return;
      }

      // Copy task
      if (modifierPressed && e.key.toLowerCase() === 'c') {
        const selectedTasks = (gantt as any).getSelectedTasks ? (gantt as any).getSelectedTasks() : [];
        if (selectedTasks.length > 0) {
          e.preventDefault();
          // タスクを表示順（上から下）にソートして保存
          const sortedTasks = [...selectedTasks].sort((a, b) => gantt.getGlobalTaskIndex(a) - gantt.getGlobalTaskIndex(b));
          sessionStorage.setItem('gantt_copied_task_ids', JSON.stringify(sortedTasks));
        } else {
          const selectedId = gantt.getSelectedId();
          if (selectedId) {
            e.preventDefault();
            sessionStorage.setItem('gantt_copied_task_ids', JSON.stringify([selectedId]));
          }
        }
        return;
      }

      // Paste task（選択中のタスクの後ろに挿入、複数対応）
      if (modifierPressed && e.key.toLowerCase() === 'v') {
        const copiedIdsStr = sessionStorage.getItem('gantt_copied_task_ids');
        // 後方互換性（以前の単一ID保存への対応）
        const oldCopiedId = sessionStorage.getItem('gantt_copied_task_id');

        let copiedIds: string[] = [];
        if (copiedIdsStr) {
          try {
            copiedIds = JSON.parse(copiedIdsStr);
          } catch {
            // parse error
          }
        } else if (oldCopiedId) {
          copiedIds = [oldCopiedId];
        }

        if (copiedIds.length > 0 && handleCopyTaskRef.current) {
          e.preventDefault();
          let currentTargetId = gantt.getSelectedId() ? Number(gantt.getSelectedId()) : undefined;

          // 非同期で順番にペースト処理を実行
          const runPaste = async () => {
            const newlyCreatedIds: number[] = [];

            for (const cid of copiedIds) {
              const numericId = Number(cid);
              if (isNaN(numericId)) continue;

              const createdTask = await handleCopyTaskRef.current(numericId, currentTargetId);
              if (createdTask && createdTask.id) {
                newlyCreatedIds.push(createdTask.id);
                // 次のタスクはこの新しく作られたタスクの後ろに挿入する
                currentTargetId = createdTask.id;

                // ganttに直接追加してUndoスタックに記録させる
                // （差分同期はUndoスタック保護付きなので二重記録にならない）
                if (!gantt.isTaskExists(createdTask.id)) {
                  const t = {
                    ...createdTask,
                    start_date: createdTask.start_date ? new Date(String(createdTask.start_date).replace(' ', 'T')) : new Date(),
                    end_date: createdTask.end_date ? new Date(String(createdTask.end_date).replace(' ', 'T')) : new Date(),
                    open: true,
                  };
                  (t as any).$open = true;
                  gantt.addTask(t, createdTask.parent || 0);
                }
              }
            }

            if (newlyCreatedIds.length > 0) {
              // 少し待ってから（Ganttの再描画後）、新しく作られたすべてのタスクを選択状態にする
              setTimeout(() => {
                gantt.unselectTask(); // 単一選択用のクリア
                const currentSelectedTasks = (gantt as any).getSelectedTasks ? (gantt as any).getSelectedTasks() : [];
                currentSelectedTasks.forEach((tid: string | number) => gantt.unselectTask(tid));

                newlyCreatedIds.forEach(nid => {
                  if (gantt.isTaskExists(nid)) {
                    gantt.selectTask(nid);
                  }
                });

                // key downでの基準を示すため、最後に作られたものを activeRef に
                if (newlyCreatedIds.length > 0) {
                  lastSelectedIdRef.current = newlyCreatedIds[newlyCreatedIds.length - 1];
                }
              }, 100);
            }
          };

          runPaste();
        }
        return;
      }
    };

    // capture phaseでイベントを登録し、DHTMLX内部のイベント処理より先に捕捉する
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [scrollTaskIntoView]);

  return (
    <div
      className={`gantt-container ${gridCollapsed ? 'grid-collapsed' : ''}`}
      ref={containerRef}
      tabIndex={-1}
    >
      {contextMenu.visible && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={closeContextMenu}
        />
      )}
      <DateSettingModal
        isOpen={dateModal.isOpen}
        onClose={() => setDateModal(prev => ({ ...prev, isOpen: false }))}
        onSave={handleSaveDate}
        initialDate={dateModal.initialDate}
        initialDuration={dateModal.initialDuration}
      />
      <ScheduleAddModal
        isOpen={scheduleModal.isOpen}
        onClose={() => setScheduleModal(prev => ({ ...prev, isOpen: false }))}
        onSave={handleSaveSchedule}
        initialDate={scheduleModal.initialDate}
        initialText={scheduleModal.initialText}
        taskTitle={
          scheduleModal.taskId && gantt.isTaskExists(scheduleModal.taskId)
            ? gantt.getTask(scheduleModal.taskId).text
            : ''
        }
        existingSchedule={
          scheduleModal.taskId && gantt.isTaskExists(scheduleModal.taskId)
            ? gantt.getTask(scheduleModal.taskId).task_schedule || ''
            : ''
        }
        title={scheduleModal.mode === 'edit' ? 'スケジュール編集' : 'スケジュール追加'}
        saveLabel={scheduleModal.mode === 'edit' ? '保存' : '追加'}
      />
    </div>
  );
}
