/**
 * DHTMLX Ganttを用いたガントチャートコンポーネント。
 * - タスクの表示、追加、編集、削除や、ドラッグアンドドロップによる期間変更・並び替え
 * - 右クリックメニュー、キーボードショートカット、スケジュールピン、フィルタ表示
 *
 * gantt はアプリ全体で1つのシングルトン。このコンポーネントはその初期化・破棄と、
 * React の props（tasks / links / 表示設定）を gantt へ反映する役割を持つ。処理の実体は次のモジュールにある:
 *   ganttSetup      … 設定（プラグイン・Lightbox・列・ズーム）
 *   ganttTemplates  … 表示テンプレート
 *   ganttEvents     … Gantt上の操作をバックエンドへ保存するイベントハンドラ
 *   ganttSync       … サーバーのデータを gantt へ差分反映
 *   useGanttKeyboard / useSchedulePins / useTimelineScroll … 入力操作
 **/
import { useEffect, useRef, useCallback, useState } from 'react';
import { gantt } from 'dhtmlx-gantt';
import 'dhtmlx-gantt/codebase/dhtmlxgantt.css';
import type { BusinessTripEntry, Task, Link, TaskKind, TaskFilter } from '../../types/gantt';
import { ContextMenu } from './ContextMenu';
import {
  getTaskContextMenuItems,
  getEmptyAreaContextMenuItems,
  getDateHeaderContextMenuItems,
  type ContextMenuItem,
} from './contextMenuItems';
import { DEFAULT_TASK_FILTER, formatDateString } from '../../constants/gantt';
import { formatDateToYMD } from '../../utils/dateUtils';
import { addOrUpdateSchedule, updateScheduleAtIndex } from '../../utils/scheduleParser';
import { useLatestRef } from '../../hooks/useLatestRef';
import '../../styles/gantt.css';
import { DateSettingModal } from './DateSettingModal';
import { ScheduleAddModal } from './ScheduleAddModal';
import {
  BASE_ROW_HEIGHT,
  configureGantt,
  resetDisplayRange,
  showTodayMarker,
  type TimeScale,
} from './ganttSetup';
import { applyStaticTemplates, applyTaskBarTemplates } from './ganttTemplates';
import { attachGanttEvents, type GanttDataCallbacks } from './ganttEvents';
import { createGanttSyncState, syncGanttData } from './ganttSync';
import {
  dateFromClientX,
  resolveTargetTaskIds,
  addTaskToGantt,
  resolveTimelineContext,
  type GanttId,
} from './ganttTaskUtils';
import { trackTimelinePointer, type TimelinePointerTracker } from './timelinePointer';
import { useTimelineDragScroll, useVerticalWheelScroll } from './useTimelineScroll';
import { useSchedulePins, type SchedulePin, type SchedulePinHandlers } from './useSchedulePins';
import { useGanttDisplaySettings } from './useGanttDisplaySettings';
import { useGanttFilter } from './useGanttFilter';
import { useTaskHyperlinks } from './useTaskHyperlinks';
import { useGanttKeyboard, type GanttKeyboardActions, type KeyboardCursor } from './useGanttKeyboard';

interface GanttChartProps extends Pick<GanttDataCallbacks, 'onTaskUpdate' | 'onTaskCreate' | 'onTaskDelete' | 'onLinkCreate' | 'onLinkUpdate' | 'onLinkDelete'> {
  tasks: Task[];
  links: Link[];
  timeScale: TimeScale;
  gridCollapsed?: boolean;
  /** 表示倍率（%） */
  displaySize?: number;
  filter?: TaskFilter;
  onFilterChange?: (filter: TaskFilter) => void;
  /** 値が増えるたびに全タスクを展開する */
  expandAllTrigger?: number;
  /** 値が増えるたびに全タスクを折りたたむ */
  collapseAllTrigger?: number;
  /** タスクを再帰的に複製し、複製されたタスクを返す。targetId 指定時はそのタスクの直後に挿入する */
  onTaskClone?: (id: number, targetId?: number) => Promise<Task | undefined>;
  isPrintMode?: boolean;
  gridWidth: number;
  obsidianHome: string;
  holidays?: string[];
  onAddHoliday?: (date: string) => Promise<void>;
  onRemoveHoliday?: (date: string) => Promise<void>;
  businessTrips?: BusinessTripEntry[];
  synonyms?: string[][];
  /** 外部（ランチャー等）からの「このタスクの入力画面を開く」リクエスト */
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

interface DateModalState {
  isOpen: boolean;
  taskId: number | null;
  initialDate: Date;
  initialDuration: number;
}

interface ScheduleModalState {
  isOpen: boolean;
  taskId: number | null;
  initialDate: Date;
  initialText: string;
  /** 編集対象スケジュールの位置（新規追加時は null） */
  sourceIndex: number | null;
  mode: 'create' | 'edit';
}

interface NewTaskOptions {
  parentId: number;
  kind: TaskKind;
  /** 開始日（省略時は今日） */
  date?: Date | null;
  /** 指定した並び順のタスクの直後に挿入する。省略時は親の先頭に追加する */
  insertAfterSortOrder?: number;
}

const SCALE_HEADER_SELECTOR = '.gantt_task_scale, .gantt_scale_cell, .gantt_scale_line';
const TODAY_MARKER_REFRESH_MS = 5 * 60 * 1000;

function isScaleHeaderTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(SCALE_HEADER_SELECTOR);
}

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
  const hasScrolledToToday = useRef(false);
  const syncStateRef = useRef(createGanttSyncState());
  const pointerTrackerRef = useRef<TimelinePointerTracker | null>(null);
  const cursorRef = useRef<KeyboardCursor>({ taskId: null, isFocusMode: false });
  const handledExternalRequestIdRef = useRef<number | null>(null);
  const holidaySetRef = useRef<Set<string>>(new Set());
  const businessTripMapRef = useRef<Map<string, BusinessTripEntry['type']>>(new Map());
  const visibleTaskIdsRef = useRef<Set<number>>(new Set());

  // gantt に一度だけ登録するイベントハンドラから、最新の props を参照するための ref
  const dataRef = useLatestRef({ tasks, links });
  const filterRef = useLatestRef(filter);
  const initialTimeScaleRef = useLatestRef(timeScale);
  const initialPrintModeRef = useLatestRef(isPrintMode);
  const holidayCallbacksRef = useLatestRef({ onAddHoliday, onRemoveHoliday });
  const dataCallbacksRef = useLatestRef<GanttDataCallbacks>({
    onTaskUpdate,
    onTaskCreate,
    onTaskDelete,
    onLinkCreate,
    onLinkUpdate,
    onLinkDelete,
  });

  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    items: [],
  });
  const [dateModal, setDateModal] = useState<DateModalState>({
    isOpen: false,
    taskId: null,
    initialDate: new Date(),
    initialDuration: 1,
  });
  const [scheduleModal, setScheduleModal] = useState<ScheduleModalState>({
    isOpen: false,
    taskId: null,
    initialDate: new Date(),
    initialText: '',
    sourceIndex: null,
    mode: 'create',
  });

  const showContextMenu = useCallback((x: number, y: number, items: ContextMenuItem[]) => {
    setContextMenu({ visible: true, x, y, items });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  // --- サーバーのデータを gantt へ反映 ---

  const syncData = useCallback(() => {
    if (!initialized.current) return;

    const { tasks: latestTasks, links: latestLinks } = dataRef.current;
    let changed = syncGanttData(latestTasks, latestLinks, syncStateRef.current);
    showTodayMarker();

    // 初回のみ：全タスクを開いた状態にし、今日へスクロールする
    if (!hasScrolledToToday.current && latestTasks.length > 0) {
      hasScrolledToToday.current = true;
      gantt.eachTask((task) => {
        task.$open = true;
      });
      setTimeout(() => {
        gantt.showDate(new Date());
      }, 50);
      changed = true;
    }

    resetDisplayRange();
    if (changed) {
      gantt.render();
    }
  }, [dataRef]);

  // --- タスク操作（右クリックメニュー・キーボードショートカットから呼ばれる） ---

  /**
   * gantt上のタスクを書き換える。
   * gantt.updateTask() が onAfterTaskUpdate を発火し、ganttEvents 側でバックエンドに保存される。
   */
  const updateTaskFields = useCallback((taskId: GanttId, fields: Record<string, unknown>) => {
    if (!gantt.isTaskExists(taskId)) return;
    Object.assign(gantt.getTask(taskId), fields);
    gantt.updateTask(taskId);
  }, []);

  // 複数選択中で、対象タスクがその選択に含まれている場合は選択全体を削除する
  const handleDeleteTask = useCallback((taskId: number) => {
    const taskIds = resolveTargetTaskIds(taskId);
    const message = taskIds.length > 1
      ? `${taskIds.length}件のタスクを削除しますか？`
      : 'このタスクを削除しますか？';
    if (!confirm(message)) return;

    for (const id of taskIds) {
      if (gantt.isTaskExists(id)) {
        gantt.deleteTask(id); // バックエンドへの削除は onBeforeTaskDelete で行われる
      }
    }
  }, []);

  // 複数選択中で、対象タスクがその選択に含まれている場合は選択全体の固定を切り替える
  const handleTogglePinned = useCallback((taskId: number, pinned: boolean) => {
    for (const id of resolveTargetTaskIds(taskId)) {
      updateTaskFields(id, { is_pinned: pinned });
    }
  }, [updateTaskFields]);

  /**
   * タスク/プロジェクトを新規作成する。
   * バックエンドで作成してIDを確定させてから gantt に追加する（Undoの履歴に「追加」として記録される）。
   */
  const createTask = useCallback(async ({ parentId, kind, date, insertAfterSortOrder }: NewTaskOptions) => {
    const createOnServer = dataCallbacksRef.current.onTaskCreate;
    if (!createOnServer) return undefined;

    const startDate = date || new Date();
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 1);

    const createdTask = await createOnServer({
      text: kind === 2 ? '新規プロジェクト' : '新規タスク',
      start_date: formatDateString(startDate),
      end_date: formatDateString(endDate),
      duration: 1,
      progress: 0,
      parent: parentId,
      kind_task: kind,
      owner_id: 0,
      // バックエンドは、負の値なら親の先頭、正の値ならその位置に挿入する
      sortorder: insertAfterSortOrder !== undefined ? insertAfterSortOrder + 1 : -1,
    });
    if (!createdTask?.id) return undefined;

    if (!gantt.isTaskExists(createdTask.id)) {
      // バックエンドでの挿入位置に合わせる: 指定タスクの直後、指定がなければ親の先頭
      let insertIndex: number | undefined = 0;
      if (insertAfterSortOrder !== undefined) {
        const siblingIndex = gantt
          .getChildren(createdTask.parent || parentId || 0)
          .findIndex((childId) => gantt.getTask(childId).sortorder === insertAfterSortOrder);
        insertIndex = siblingIndex === -1 ? undefined : siblingIndex + 1;
      }
      addTaskToGantt({ ...createdTask, parent: createdTask.parent || parentId || 0 }, insertIndex);
    }

    return createdTask;
  }, [dataCallbacksRef]);

  const handleCopyTask = useCallback(async (taskId: number, targetId?: number) => {
    return onTaskClone?.(taskId, targetId);
  }, [onTaskClone]);

  const handleSetTimePeriod = useCallback((taskId: number) => {
    const task = gantt.getTask(taskId);
    setDateModal({
      isOpen: true,
      taskId,
      initialDate: task.start_date ? new Date(task.start_date) : new Date(),
      initialDuration: Number(task.duration) || 1,
    });
  }, []);

  const handleSaveDate = useCallback((startDate: Date, duration: number) => {
    if (dateModal.taskId && gantt.isTaskExists(dateModal.taskId)) {
      const task = gantt.getTask(dateModal.taskId);
      updateTaskFields(dateModal.taskId, {
        start_date: startDate,
        duration,
        end_date: gantt.calculateEndDate({ start_date: startDate, duration, task }),
      });
    }
    setDateModal((prev) => ({ ...prev, isOpen: false }));
  }, [dateModal.taskId, updateTaskFields]);

  const openScheduleModal = useCallback((taskId: number, initialDate?: Date) => {
    const task = gantt.getTask(taskId);
    setScheduleModal({
      isOpen: true,
      taskId,
      initialDate: initialDate ?? (task.start_date ? new Date(task.start_date) : new Date()),
      initialText: '',
      sourceIndex: null,
      mode: 'create',
    });
  }, []);

  const saveTaskSchedule = useCallback((taskId: number, newSchedule: string) => {
    updateTaskFields(taskId, { task_schedule: newSchedule });
  }, [updateTaskFields]);

  const handleSaveSchedule = useCallback((dateStr: string, text: string) => {
    const { taskId, mode, sourceIndex } = scheduleModal;
    if (taskId && gantt.isTaskExists(taskId)) {
      const currentSchedule = gantt.getTask(taskId).task_schedule || '';
      const newSchedule = mode === 'edit' && sourceIndex !== null
        ? updateScheduleAtIndex(currentSchedule, sourceIndex, dateStr, text)
        : addOrUpdateSchedule(currentSchedule, dateStr, text);
      saveTaskSchedule(taskId, newSchedule);
    }
    setScheduleModal((prev) => ({ ...prev, isOpen: false }));
  }, [scheduleModal, saveTaskSchedule]);

  const { createObsidianNote: handleCreateObsidianNote, openHyperlink } = useTaskHyperlinks({
    obsidianHome,
    updateTaskFields,
  });

  // プロジェクト名をプロジェクト検索フィルターに設定して絞り込む
  const handleAddToFilter = useCallback((taskId: number) => {
    const task = gantt.getTask(taskId);
    if (task && onFilterChange) {
      onFilterChange({ ...(filterRef.current || DEFAULT_TASK_FILTER), searchProject: task.text });
    }
  }, [onFilterChange, filterRef]);

  const scrollTaskIntoView = useCallback((taskId: GanttId) => {
    if (!initialized.current || !gantt.isTaskExists(taskId)) return;

    const taskDataElement = gantt.$task_data as HTMLElement | undefined;
    if (!taskDataElement) return;

    const rowIndex = gantt.getGlobalTaskIndex(taskId);
    if (rowIndex < 0) return;

    const scrollState = gantt.getScrollState();
    const rowHeight = gantt.config.row_height || BASE_ROW_HEIGHT;
    const rowTop = rowIndex * rowHeight;
    const rowBottom = rowTop + rowHeight;
    const viewportBottom = scrollState.y + taskDataElement.clientHeight;

    if (rowTop < scrollState.y) {
      gantt.scrollTo(scrollState.x, rowTop);
    } else if (rowBottom > viewportBottom) {
      gantt.scrollTo(scrollState.x, Math.max(0, rowBottom - taskDataElement.clientHeight));
    }
  }, []);

  // 指定タスクを（先祖を展開して）選択・表示し、入力画面（Lightbox）を開く
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

  // --- 右クリックメニュー ---

  const openContextMenu = (taskId: GanttId | null, event: MouseEvent) => {
    // クリック位置の行列からタスクIDと日付を解決する
    const timelineContext = resolveTimelineContext(event.clientX, event.clientY, event.target);
    let clickedDate: Date | null = timelineContext?.date ?? null;
    if (!clickedDate) {
      const positionDate = dateFromClientX(event.clientX);
      if (positionDate) {
        clickedDate = new Date(positionDate.getFullYear(), positionDate.getMonth(), positionDate.getDate());
      }
    }

    const holidayCallbacks = {
      onAddHoliday: (date: string) => holidayCallbacksRef.current.onAddHoliday?.(date),
      onRemoveHoliday: (date: string) => holidayCallbacksRef.current.onRemoveHoliday?.(date),
    };

    if (taskId) {
      if (!gantt.isTaskExists(taskId)) return;
      const task = gantt.getTask(taskId);
      const items = getTaskContextMenuItems(Number(taskId), task.kind_task, Boolean(task.is_pinned), {
        onEdit: (id) => gantt.showLightbox(id),
        onDelete: handleDeleteTask,
        onSetProgress: (id, progress) => updateTaskFields(id, { progress }),
        onSetOwner: (id, ownerId) => updateTaskFields(id, { owner_id: ownerId }),
        onSetKind: (id, kind) => updateTaskFields(id, { kind_task: kind }),
        onSetColor: (id, color) => updateTaskFields(id, { color }),
        onSetTextColor: (id, textColor) => updateTaskFields(id, { textColor }),
        onSetTimePeriod: handleSetTimePeriod,
        onAddChild: (parentId, kind) => void createTask({ parentId, kind }),
        onCopy: (id) => void handleCopyTask(id),
        onAddSchedule: (id) => openScheduleModal(id, clickedDate ?? undefined),
        onCreateObsidian: (id) => void handleCreateObsidianNote(id),
        onAddToFilter: handleAddToFilter,
        onTogglePinned: handleTogglePinned,
      });
      showContextMenu(event.clientX, event.clientY, items);
      return;
    }

    const dateStr = clickedDate ? formatDateToYMD(clickedDate) : '';
    const isHoliday = dateStr ? holidaySetRef.current.has(dateStr) : false;

    if (isScaleHeaderTarget(event.target) && clickedDate) {
      showContextMenu(
        event.clientX,
        event.clientY,
        getDateHeaderContextMenuItems(clickedDate, isHoliday, holidayCallbacks),
      );
      return;
    }

    // タイムラインの空き領域・背景セル。行からタスクが解決できた場合は「スケジュールを追加」も表示する
    const rowTaskId = timelineContext && gantt.isTaskExists(timelineContext.taskId)
      ? timelineContext.taskId
      : null;
    const items = getEmptyAreaContextMenuItems(clickedDate, {
      onAddProject: (date) => void createTask({ parentId: 0, kind: 2, date }),
      onAddTask: (date) => void createTask({ parentId: 0, kind: 1, date }),
      onAddSchedule: (id, date) => openScheduleModal(id, date),
      ...holidayCallbacks,
      isHoliday,
      taskId: rowTaskId,
    });
    showContextMenu(event.clientX, event.clientY, items);
  };
  const openContextMenuRef = useLatestRef(openContextMenu);

  // --- gantt の初期化と破棄（マウント中に1度だけ） ---

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    configureGantt(initialTimeScaleRef.current);
    applyStaticTemplates({
      getHolidays: () => holidaySetRef.current,
      getBusinessTrips: () => businessTripMapRef.current,
      getKeyboardFocusTaskId: () => (cursorRef.current.isFocusMode ? cursorRef.current.taskId : null),
    });
    applyTaskBarTemplates(initialPrintModeRef.current);

    const detachDataEvents = attachGanttEvents({
      getCallbacks: () => dataCallbacksRef.current,
      getSyncState: () => syncStateRef.current,
      requestSync: () => syncData(),
      onTaskSelected: (id) => {
        cursorRef.current.taskId = id;
        cursorRef.current.isFocusMode = false;
      },
      onContextMenu: (taskId, event) => openContextMenuRef.current(taskId, event),
    });

    // フィルタ: 事前計算した表示対象IDの集合を参照するだけにして、行ごとの判定を O(1) にする
    const displayFilterEventId = gantt.attachEvent('onBeforeTaskDisplay', (id: GanttId) => {
      if (!filterRef.current) return true;
      return visibleTaskIdsRef.current.has(Number(id));
    });

    gantt.init(container);
    initialized.current = true;
    pointerTrackerRef.current = trackTimelinePointer();

    return () => {
      pointerTrackerRef.current?.detach();
      pointerTrackerRef.current = null;

      detachDataEvents();
      gantt.detachEvent(displayFilterEventId);
      gantt.clearAll();

      // 再マウント時に、空の gantt へ最初から読み込み直せるようにする
      initialized.current = false;
      hasScrolledToToday.current = false;
      syncStateRef.current = createGanttSyncState();
    };
  }, [initialTimeScaleRef, initialPrintModeRef, dataCallbacksRef, filterRef, openContextMenuRef, syncData]);

  useEffect(() => {
    syncData();
  }, [tasks, links, syncData]);

  // 開いたままでも「Now」マーカーが現在時刻を指すよう、定期的に更新する
  useEffect(() => {
    const timerId = window.setInterval(() => {
      if (initialized.current) showTodayMarker();
    }, TODAY_MARKER_REFRESH_MS);
    return () => window.clearInterval(timerId);
  }, []);

  // --- 入力操作 ---

  useTimelineDragScroll(containerRef);
  useVerticalWheelScroll(containerRef);

  const schedulePinHandlersRef = useLatestRef<SchedulePinHandlers>({
    saveSchedule: saveTaskSchedule,
    showContextMenu,
    editPin: (pin: SchedulePin) => {
      setScheduleModal({
        isOpen: true,
        taskId: pin.taskId,
        initialDate: pin.date,
        initialText: pin.text,
        sourceIndex: pin.sourceIndex,
        mode: 'edit',
      });
    },
  });
  useSchedulePins(containerRef, schedulePinHandlersRef);

  const keyboardActionsRef = useLatestRef<GanttKeyboardActions>({
    addChildTask: (parentId, insertAfterSortOrder) => createTask({ parentId, kind: 1, insertAfterSortOrder }),
    addRootTask: (insertAfterSortOrder) => createTask({ parentId: 0, kind: 1, insertAfterSortOrder }),
    cloneTask: handleCopyTask,
    createObsidianNote: (taskId) => void handleCreateObsidianNote(taskId),
    openScheduleModal,
    getTimelinePointerTarget: () => pointerTrackerRef.current?.getShortcutTarget() ?? null,
    scrollTaskIntoView,
  });
  useGanttKeyboard(cursorRef, keyboardActionsRef);

  // 日付ヘッダー（スケール）の右クリック: 休日の追加・解除メニュー
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleHeaderContextMenu = (event: MouseEvent) => {
      if (!isScaleHeaderTarget(event.target)) return;

      const clickedDate = dateFromClientX(event.clientX);
      if (!clickedDate) return;

      event.preventDefault();
      event.stopPropagation();
      const isHoliday = holidaySetRef.current.has(formatDateToYMD(clickedDate));
      showContextMenu(
        event.clientX,
        event.clientY,
        getDateHeaderContextMenuItems(clickedDate, isHoliday, {
          onAddHoliday: (date) => holidayCallbacksRef.current.onAddHoliday?.(date),
          onRemoveHoliday: (date) => holidayCallbacksRef.current.onRemoveHoliday?.(date),
        }),
      );
    };

    container.addEventListener('contextmenu', handleHeaderContextMenu, true);
    return () => {
      container.removeEventListener('contextmenu', handleHeaderContextMenu, true);
    };
  }, [showContextMenu, holidayCallbacksRef]);

  // タスク名などに埋め込んだリンク（data-hyperlink）のクリックでハイパーリンクを開く
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
      void openHyperlink(taskId, hyperlink);
    };

    container.addEventListener('click', handleLinkClick, true);
    return () => {
      container.removeEventListener('click', handleLinkClick, true);
    };
  }, [openHyperlink]);

  // 外部からの「入力画面を開く」リクエスト。対象タスクがまだ読み込まれていなければ、tasks 更新時に再試行する
  useEffect(() => {
    if (!externalOpenTaskRequest) return;
    if (handledExternalRequestIdRef.current === externalOpenTaskRequest.requestId) return;

    if (openTaskInput(externalOpenTaskRequest.taskId)) {
      handledExternalRequestIdRef.current = externalOpenTaskRequest.requestId;
      onExternalOpenHandled?.(externalOpenTaskRequest.requestId);
    }
  }, [externalOpenTaskRequest, onExternalOpenHandled, openTaskInput, tasks]);

  // --- 表示設定・フィルタの反映（gantt の初期化後に反映するため、初期化の useEffect より後に置く） ---

  useGanttDisplaySettings({
    initialized,
    timeScale,
    isPrintMode,
    gridCollapsed,
    gridWidth,
    displaySize,
    expandAllTrigger,
    collapseAllTrigger,
    holidays,
    businessTrips,
    holidaySetRef,
    businessTripMapRef,
  });
  useGanttFilter({ initialized, tasks, filter, synonyms, visibleTaskIdsRef });

  const scheduleModalTask = scheduleModal.taskId && gantt.isTaskExists(scheduleModal.taskId)
    ? gantt.getTask(scheduleModal.taskId)
    : null;

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
        onClose={() => setDateModal((prev) => ({ ...prev, isOpen: false }))}
        onSave={handleSaveDate}
        initialDate={dateModal.initialDate}
        initialDuration={dateModal.initialDuration}
      />
      <ScheduleAddModal
        isOpen={scheduleModal.isOpen}
        onClose={() => setScheduleModal((prev) => ({ ...prev, isOpen: false }))}
        onSave={handleSaveSchedule}
        initialDate={scheduleModal.initialDate}
        initialText={scheduleModal.initialText}
        taskTitle={scheduleModalTask?.text ?? ''}
        existingSchedule={scheduleModalTask?.task_schedule || ''}
        title={scheduleModal.mode === 'edit' ? 'スケジュール編集' : 'スケジュール追加'}
        saveLabel={scheduleModal.mode === 'edit' ? '保存' : '追加'}
      />
    </div>
  );
}
