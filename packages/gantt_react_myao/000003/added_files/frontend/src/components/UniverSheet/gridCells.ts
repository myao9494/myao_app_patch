/**
 * グリッド（Univer）のセルデータの生成と、編集値の変換。Univer 本体には依存しない純粋な処理。
 * 行とデータの対応: 1行目はヘッダー、N行目（0始まりで N）が tasks[N-1] / links[N-1]。
 */
import type { Task, Link, GridDiffItem } from '../../types/gantt';
import { formatDateToYMD } from '../../utils/dateUtils';
import { TASK_COLUMN_DEFINITIONS, LINK_COLUMN_DEFINITIONS, type ColumnDefinition } from './gridColumns';
import { buildTaskNamePrefix, stripTaskNamePrefix } from './gridTaskName';

type DiffFieldMap = Map<number, Map<string, GridDiffItem>>;
type CellStyle = Record<string, unknown>;
export type CellData = Record<number, { v: string | number; s?: CellStyle }>;
export type SheetCellData = Record<number, CellData>;

const HORIZONTAL_ALIGN_CENTER = 2;
// Tasksシートで中央揃えにする列（開始日〜文字色）
const CENTERED_TASK_COLUMNS = { first: 2, last: 11 };
const BORDER_LINE = { s: 1, cl: { rgb: '#888888' } };
/** 罫線スタイル（通常セル用） */
const borderStyle: CellStyle = {
  bd: { t: BORDER_LINE, b: BORDER_LINE, l: BORDER_LINE, r: BORDER_LINE },
};
/** 差分ハイライト用（ライト: 黄色背景 / ダーク: 暗い黄色背景） */
const diffStyleLight: CellStyle = { ...borderStyle, bg: { rgb: '#FFF3CD' } };
const diffStyleDark: CellStyle = { ...borderStyle, bg: { rgb: '#5C4B00' } };

function buildDiffFieldMap(diffs: GridDiffItem[], table: 'tasks' | 'links'): DiffFieldMap {
  const fieldMap: DiffFieldMap = new Map();
  for (const diff of diffs) {
    if (diff.table !== table) continue;
    let itemMap = fieldMap.get(diff.id);
    if (!itemMap) {
      itemMap = new Map();
      fieldMap.set(diff.id, itemMap);
    }
    itemMap.set(diff.field, diff);
  }
  return fieldMap;
}

/** ヘッダー行（カラム名、罫線、中央揃え）のセルデータを生成する */
export function createHeaderRow(columns: ColumnDefinition[]): CellData {
  const cellData: CellData = {};
  columns.forEach((column, index) => {
    cellData[index] = { v: column.name, s: { ...borderStyle, ht: HORIZONTAL_ALIGN_CENTER } };
  });
  return cellData;
}

export function columnWidths(columns: ColumnDefinition[]): Record<number, { w: number }> {
  return Object.fromEntries(columns.map((column, index) => [index, { w: column.width }]));
}

/**
 * タスクのセルに表示する値を返す。
 * ステージングに差分がある場合は、本データではなくステージングの値（diffCurrent）を表示する。
 */
function taskCellValue(task: Task, field: string, diffCurrent: string | null | undefined): string | number {
  const rawValue = (task as unknown as Record<string, unknown>)[field];
  const fallback = rawValue != null ? String(rawValue) : '';

  switch (field) {
    case 'text':
      // タスクはツリー順で渡される。階層の深さ分のインデントと種類アイコンを付けて表示する
      return buildTaskNamePrefix(task) + (diffCurrent ?? task.text ?? '');
    case 'progress':
      // 内部値 0.0〜1.0 を 0〜100(%) で表示する
      return Math.round((diffCurrent != null ? Number(diffCurrent) : (task.progress || 0)) * 100);
    case 'start_date':
    case 'end_date':
      // 時刻は省き、年月日だけを表示する
      return formatDateToYMD(diffCurrent ?? fallback);
    default:
      return diffCurrent ?? fallback;
  }
}

/** タスクデータから行データを生成する（全カラム対応・差分ハイライト・インデント） */
export function createRowsFromTasks(tasks: Task[], diffs: GridDiffItem[], isDark: boolean): SheetCellData {
  const rows: SheetCellData = {};
  const diffMap = buildDiffFieldMap(diffs, 'tasks');
  const diffStyle = isDark ? diffStyleDark : diffStyleLight;

  tasks.forEach((task, rowIndex) => {
    const cellData: CellData = {};
    const taskDiffs = diffMap.get(task.id);

    TASK_COLUMN_DEFINITIONS.forEach((column, columnIndex) => {
      const diff = taskDiffs?.get(column.field);
      const isCentered = columnIndex >= CENTERED_TASK_COLUMNS.first && columnIndex <= CENTERED_TASK_COLUMNS.last;
      const baseStyle = diff ? diffStyle : borderStyle;

      cellData[columnIndex] = {
        v: taskCellValue(task, column.field, diff?.current),
        s: isCentered ? { ...baseStyle, ht: HORIZONTAL_ALIGN_CENTER } : baseStyle,
      };
    });

    rows[rowIndex + 1] = cellData;
  });

  return rows;
}

/** リンクデータから行データを生成する（差分ハイライト対応） */
export function createRowsFromLinks(links: Link[], diffs: GridDiffItem[], isDark: boolean): SheetCellData {
  const rows: SheetCellData = {};
  const diffMap = buildDiffFieldMap(diffs, 'links');
  const diffStyle = isDark ? diffStyleDark : diffStyleLight;

  links.forEach((link, rowIndex) => {
    const cellData: CellData = {};
    const linkDiffs = diffMap.get(link.id);

    LINK_COLUMN_DEFINITIONS.forEach((column, columnIndex) => {
      const diff = linkDiffs?.get(column.field);
      const original = column.field === 'type'
        ? (link.type || 0)
        : (link as unknown as Record<string, number>)[column.field];
      cellData[columnIndex] = {
        v: diff?.current ?? original,
        s: diff ? diffStyle : borderStyle,
      };
    });

    rows[rowIndex + 1] = cellData;
  });

  return rows;
}

/**
 * 編集されたセルの値を、ステージング更新APIへ送る値に変換する。
 * - 空文字は null（バックエンドのバリデーションエラー回避。必須項目の null はバックエンドが無視する）
 * - タスク名は表示用の装飾（インデント・アイコン）を取り除く
 * - 進捗率は 0〜100(%) を 0.0〜1.0 にする
 */
export function toStagingValue(field: string, cellValue: unknown, item: Task | Link): unknown {
  const value = cellValue === '' ? null : cellValue;

  if (field === 'text' && typeof value === 'string') {
    return stripTaskNamePrefix(value, item as Task);
  }
  if (field === 'progress') {
    if (typeof value === 'number') return value / 100;
    if (value === null) return 0;
  }
  return value;
}
