/**
 * コンテキストメニューの項目生成ユーティリティ
 * - タスク行・バー右クリック時の操作メニュー（編集、Obsidian連携、固定、フィルター追加、スケジュール追加など）
 * - カレンダー日付ヘッダー右クリック時の休日追加・解除メニュー
 * - カレンダー空き領域・背景セル右クリック時の新規プロジェクト・タスク追加、
 *   スケジュール追加（行列から取得したタスク・日付）、休日メニュー
 */
import type { TaskKind } from '../../types/gantt';
import { OWNERS, KIND_TASKS, COLOR_OPTIONS } from '../../constants/gantt';
import { formatDateToYMD } from '../../utils/dateUtils';

export interface ContextMenuItem {
  label?: string;
  icon?: string;
  action?: () => void;
  danger?: boolean;
  divider?: boolean;
  submenu?: ContextMenuItem[];
}

// タスク用のメニュー項目
export function getTaskContextMenuItems(
  taskId: number,
  taskKind: number,
  isPinned: boolean,
  callbacks: {
    onEdit: (id: number) => void;
    onDelete: (id: number) => void;
    onSetProgress: (id: number, progress: number) => void;
    onSetOwner: (id: number, ownerId: number) => void;
    onSetKind: (id: number, kind: string) => void;
    onSetColor: (id: number, color: string) => void;
    onSetTextColor: (id: number, color: string) => void;
    onSetTimePeriod: (id: number) => void;
    onAddChild: (parentId: number, kind: TaskKind) => void;
    onCopy: (id: number) => void;
    onAddSchedule: (id: number, initialDate?: Date) => void;
    onCreateObsidian: (id: number) => void;
    onAddToFilter: (id: number) => void;
    onTogglePinned: (id: number, nextPinned: boolean) => void;
  }
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      label: '子タスク追加',
      icon: '⏰',
      action: () => callbacks.onAddChild(taskId, 1),
    },
    {
      label: '子プロジェクト追加',
      icon: '📁',
      action: () => callbacks.onAddChild(taskId, 2),
    },
    { divider: true },
    {
      label: 'タスク編集',
      icon: '✏️',
      action: () => callbacks.onEdit(taskId),
    },
    {
      label: 'Obsidian (O)',
      icon: '📝',
      action: () => callbacks.onCreateObsidian(taskId),
    },
    {
      label: isPinned ? '固定を解除' : '固定',
      icon: isPinned ? '🟢' : '📍',
      action: () => callbacks.onTogglePinned(taskId, !isPinned),
    },
    ...(taskKind == 2 ? [{ divider: true }, {
      label: 'フィルターに追加',
      icon: '🔍',
      action: () => callbacks.onAddToFilter(taskId),
    }] : []),
    { divider: true },
    {
      label: '期間設定',
      icon: '📅',
      action: () => callbacks.onSetTimePeriod(taskId),
    },
    {
      label: 'スケジュールを追加',
      icon: '📌',
      action: () => callbacks.onAddSchedule(taskId),
    },
    {
      label: '種別変更',
      icon: '🏷️',
      submenu: KIND_TASKS.map((kind) => ({
        label: kind.label,
        action: () => callbacks.onSetKind(taskId, kind.key),
      })),
    },
    {
      label: '進捗設定',
      icon: '📊',
      submenu: [
        {
          label: '100%',
          action: () => callbacks.onSetProgress(taskId, 1),
        },
        {
          label: '75%',
          action: () => callbacks.onSetProgress(taskId, 0.75),
        },
        {
          label: '50%',
          action: () => callbacks.onSetProgress(taskId, 0.5),
        },
        {
          label: '25%',
          action: () => callbacks.onSetProgress(taskId, 0.25),
        },
        {
          label: '0%',
          action: () => callbacks.onSetProgress(taskId, 0),
        },
      ],
    },
    {
      label: 'バー色設定',
      icon: '🎨',
      submenu: COLOR_OPTIONS.map((color) => ({
        label: color.label,
        icon: color.key ? '■' : '□', // 色付きアイコンがあれば良いが、一旦文字で
        action: () => callbacks.onSetColor(taskId, color.key),
      })),
    },
    {
      label: '文字色設定',
      icon: '🅰️',
      submenu: COLOR_OPTIONS.map((color) => ({
        label: color.label,
        action: () => callbacks.onSetTextColor(taskId, color.key),
      })),
    },
    {
      label: 'オーナー変更',
      icon: '👤',
      submenu: OWNERS.map((owner) => ({
        label: owner.label,
        action: () => callbacks.onSetOwner(taskId, owner.key),
      })),
    },
    { divider: true },
    {
      label: 'コピー',
      icon: '📋',
      action: () => callbacks.onCopy(taskId),
    },
    { divider: true },
    {
      label: '削除',
      icon: '🗑️',
      danger: true,
      action: () => callbacks.onDelete(taskId),
    },
  ];
  return items;
}

// カレンダー日付ヘッダー用のメニューアイテム
export function getDateHeaderContextMenuItems(
  date: Date,
  isHoliday: boolean,
  callbacks: {
    onAddHoliday?: (dateStr: string) => void;
    onRemoveHoliday?: (dateStr: string) => void;
  }
): ContextMenuItem[] {
  const dateStr = formatDateToYMD(date);
  if (isHoliday) {
    return [
      {
        label: `休日を解除 (${dateStr})`,
        icon: '🗑️',
        danger: true,
        action: () => callbacks.onRemoveHoliday?.(dateStr),
      },
    ];
  }
  return [
    {
      label: `休日を追加 (${dateStr})`,
      icon: '🎌',
      action: () => callbacks.onAddHoliday?.(dateStr),
    },
  ];
}

// Menu items for empty area
export function getEmptyAreaContextMenuItems(
  date: Date | null,
  callbacks: {
    onAddProject: (date: Date | null) => void;
    onAddTask: (date: Date | null) => void;
    onAddSchedule?: (taskId: number, date: Date) => void;
    onAddHoliday?: (dateStr: string) => void;
    onRemoveHoliday?: (dateStr: string) => void;
    isHoliday?: boolean;
    taskId?: number | null;
  }
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      label: '新規プロジェクト追加',
      icon: '📁',
      action: () => callbacks.onAddProject(date),
    },
    {
      label: '新規タスク追加',
      icon: '⏰',
      action: () => callbacks.onAddTask(date),
    },
  ];

  if (callbacks.taskId != null && date && callbacks.onAddSchedule) {
    items.push({
      label: 'スケジュールを追加',
      icon: '📌',
      action: () => callbacks.onAddSchedule!(callbacks.taskId!, date),
    });
  }

  if (date && (callbacks.onAddHoliday || callbacks.onRemoveHoliday)) {
    const dateStr = formatDateToYMD(date);
    items.push({ divider: true });
    if (callbacks.isHoliday) {
      items.push({
        label: `休日を解除 (${dateStr})`,
        icon: '🗑️',
        danger: true,
        action: () => callbacks.onRemoveHoliday?.(dateStr),
      });
    } else {
      items.push({
        label: `休日を追加 (${dateStr})`,
        icon: '🎌',
        action: () => callbacks.onAddHoliday?.(dateStr),
      });
    }
  }

  return items;
}
