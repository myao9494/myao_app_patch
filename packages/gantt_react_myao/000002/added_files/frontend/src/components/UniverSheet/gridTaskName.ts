/**
 * グリッドのタスク名セルの装飾（インデント＋種類アイコン）
 *
 * グリッドはテキストしか表示できないため、タスク名の前に
 * 「階層の深さ分の全角スペース」と「種類を表す絵文字」を付けて表示する。
 * この装飾はDBに保存してはいけないので、編集されたセルの値からは必ず取り除く。
 */
import type { Task } from '../../types/gantt';
import { getTaskIconName } from '../../utils/iconUtils';

const INDENT_UNIT = '\u3000';
const DEFAULT_ICON = '📄';
// Ganttで使う Catppuccin アイコン名 → グリッド用の絵文字
const ICON_BY_NAME: Record<string, string> = {
  folder_project: '📂',
  folder_project_open: '📂',
  folder: '📁',
  folder_open: '📁',
  markdown: '📝',
  pdf: '📕',
  python: '🐍',
  javascript: '📜',
  typescript: '📜',
  excalidraw: '🎨',
  url: '🔗',
};

/** タスク名の前に付ける装飾（インデント＋アイコン＋半角スペース）を返す */
export function buildTaskNamePrefix(task: Task): string {
  const isOpen = !!task.open;
  const icon = ICON_BY_NAME[getTaskIconName(task, isOpen, isOpen)] ?? DEFAULT_ICON;
  return `${INDENT_UNIT.repeat(task.indent || 0)}${icon} `;
}

/**
 * 編集後のセルの値から、表示用の装飾を取り除いてタスク名だけを返す。
 * 装飾を残したまま編集された場合はその装飾を、セル全体を打ち直された場合は先頭の空白だけを除く。
 */
export function stripTaskNamePrefix(value: string, task: Task): string {
  const prefix = buildTaskNamePrefix(task);
  if (value.startsWith(prefix)) {
    return value.slice(prefix.length);
  }
  // インデントだけ消された／アイコンの後ろの空白だけ消された、などの編集にも対応する
  const withoutIndent = value.replace(/^[\s\u3000]+/, '');
  const iconOnly = prefix.trim();
  return withoutIndent.startsWith(iconOnly)
    ? withoutIndent.slice(iconOnly.length).replace(/^[\s\u3000]+/, '')
    : withoutIndent;
}
