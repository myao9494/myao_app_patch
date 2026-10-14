/**
 * UniverSheet コンポーネント
 * Univer を使用したExcelライクなタスク編集グリッド。
 * - Preset モードで初期化（UniverSheetsCorePreset + UniverSheetsFilterPreset）
 * - 日本語ロケール
 * - シート: Tasks, Links（DBテーブル別）
 * - 差分ハイライト: 変更セルの背景色を変更
 * - ステージングDB更新: セル編集→grid_tasks/grid_linksを更新
 * - セル選択時に差分情報を親に通知
 *
 * 行とデータの対応: 1行目はヘッダー、N行目（0始まりで N）が tasks[N-1] / links[N-1]。
 */
import { useEffect, useRef } from 'react';
import { createUniver, LocaleType } from '@univerjs/presets';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter';
import UniverPresetSheetsCoreJaJP from '@univerjs/preset-sheets-core/locales/ja-JP';
import UniverPresetSheetsFilterJaJP from '@univerjs/preset-sheets-filter/locales/ja-JP';
import { useTheme } from '../../contexts/useTheme';
import { useLatestRef } from '../../hooks/useLatestRef';
import type { Task, Link, GridDiffItem } from '../../types/gantt';
import * as api from '../../services/api';

// Univer CSS をインポート
import '@univerjs/presets/lib/styles/preset-sheets-core.css';
import '@univerjs/presets/lib/styles/preset-sheets-filter.css';

import {
  TASK_COLUMN_DEFINITIONS,
  LINK_COLUMN_DEFINITIONS,
  type ColumnDefinition,
} from './gridColumns';
import { formatDateToYMD } from '../../utils/dateUtils';
import { buildTaskNamePrefix, stripTaskNamePrefix } from './gridTaskName';
import './UniverSheet.css';

type DiffFieldMap = Map<number, Map<string, GridDiffItem>>;
type CellStyle = Record<string, unknown>;
type CellData = Record<number, { v: string | number; s?: CellStyle }>;
type SheetCellData = Record<number, CellData>;

const TASKS_SHEET_NAME = 'Tasks';
const LINKS_SHEET_NAME = 'Links';
const HEADER_ROW_HEIGHT = 30;
const MIN_ROW_COUNT = 1000;
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

/** UniverSheet のプロパティ */
interface UniverSheetProps {
  /** 表示/非表示の制御 */
  visible?: boolean;
  /** タスクデータ */
  tasks?: Task[];
  /** リンク（依存関係）データ */
  links?: Link[];
  /** 差分一覧（ハイライト用） */
  diffs?: GridDiffItem[];
  /** セル選択時に差分情報を親に通知するコールバック */
  onCellSelect?: (diff: GridDiffItem | null) => void;
  /** グリッドの値変更後に差分を再取得させるコールバック */
  onDiffRefresh?: () => void;
}

/** ヘッダー行（カラム名、罫線、中央揃え）のセルデータを生成する */
function createHeaderRow(columns: ColumnDefinition[]): CellData {
  const cellData: CellData = {};
  columns.forEach((column, index) => {
    cellData[index] = { v: column.name, s: { ...borderStyle, ht: HORIZONTAL_ALIGN_CENTER } };
  });
  return cellData;
}

function columnWidths(columns: ColumnDefinition[]): Record<number, { w: number }> {
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
function createRowsFromTasks(tasks: Task[], diffs: GridDiffItem[], isDark: boolean): SheetCellData {
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
function createRowsFromLinks(links: Link[], diffs: GridDiffItem[], isDark: boolean): SheetCellData {
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
function toStagingValue(field: string, cellValue: unknown, item: Task | Link): unknown {
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

export function UniverSheet({
  visible = true,
  tasks = [],
  links = [],
  diffs = [],
  onCellSelect,
  onDiffRefresh,
}: UniverSheetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { darkMode } = useTheme();

  // イベントリスナーから最新の値を参照するための ref
  const onCellSelectRef = useLatestRef(onCellSelect);
  const onDiffRefreshRef = useLatestRef(onDiffRefresh);
  const diffsRef = useLatestRef(diffs);

  // データや差分が変わるたびにシート全体を作り直す（フィルタ結果・差分ハイライトの反映のため）
  useEffect(() => {
    if (!containerRef.current || !visible) return;

    // Univer インスタンスのDOM競合を防ぐため専用のコンテナを生成する
    const univerContainer = document.createElement('div');
    univerContainer.style.width = '100%';
    univerContainer.style.height = '100%';
    univerContainer.style.position = 'absolute';
    univerContainer.style.top = '0';
    univerContainer.style.left = '0';
    containerRef.current.appendChild(univerContainer);

    const { univer, univerAPI } = createUniver({
      locale: LocaleType.JA_JP,
      locales: {
        [LocaleType.JA_JP]: {
          ...UniverPresetSheetsCoreJaJP,
          ...UniverPresetSheetsFilterJaJP,
        },
      },
      darkMode: darkMode,
      presets: [
        UniverSheetsCorePreset({
          container: univerContainer,
        }),
        UniverSheetsFilterPreset(),
      ],
    });

    univerAPI.createWorkbook({
      id: 'gantt-task-sheet',
      appVersion: '1.0.0',
      name: 'Task Management',
      sheets: {
        'sheet-01': {
          id: 'sheet-01',
          name: TASKS_SHEET_NAME,
          rowCount: Math.max(tasks.length + 1, MIN_ROW_COUNT),
          columnCount: TASK_COLUMN_DEFINITIONS.length,
          cellData: {
            0: createHeaderRow(TASK_COLUMN_DEFINITIONS),
            ...createRowsFromTasks(tasks, diffs, darkMode),
          },
          columnData: columnWidths(TASK_COLUMN_DEFINITIONS),
          rowData: { 0: { h: HEADER_ROW_HEIGHT } },
        },
        'sheet-02': {
          id: 'sheet-02',
          name: LINKS_SHEET_NAME,
          rowCount: Math.max(links.length + 1, MIN_ROW_COUNT),
          columnCount: LINK_COLUMN_DEFINITIONS.length,
          cellData: {
            0: createHeaderRow(LINK_COLUMN_DEFINITIONS),
            ...createRowsFromLinks(links, diffs, darkMode),
          },
          columnData: columnWidths(LINK_COLUMN_DEFINITIONS),
          rowData: { 0: { h: HEADER_ROW_HEIGHT } },
        },
      },
      sheetOrder: ['sheet-01', 'sheet-02'],
    });

    /** アクティブなシートに対応するテーブル名・列定義・データを返す */
    const getActiveSheetContext = () => {
      const sheet = univerAPI.getActiveWorkbook()?.getActiveSheet();
      if (!sheet) return null;
      const isLinksSheet = sheet.getSheetName() === LINKS_SHEET_NAME;
      return {
        sheet,
        isLinksSheet,
        table: (isLinksSheet ? 'links' : 'tasks') as GridDiffItem['table'],
        columns: isLinksSheet ? LINK_COLUMN_DEFINITIONS : TASK_COLUMN_DEFINITIONS,
        items: (isLinksSheet ? links : tasks) as (Task | Link)[],
      };
    };

    // 変更検知リスナー: セル編集 → ステージングDB更新 → 差分リフレッシュ
    const valueChangeListener = univerAPI.addEvent(
      univerAPI.Event.SheetValueChanged,
      async (params) => {
        const context = getActiveSheetContext();
        if (!context) return;
        const { sheet, isLinksSheet, columns, items } = context;
        let hasMisalignedRow = false;

        for (const changedRange of params.effectedRanges) {
          const { startRow, endRow, startColumn, endColumn } = changedRange.getRange();

          for (let row = Math.max(startRow, 1); row <= endRow; row++) {
            const item = items[row - 1];
            if (!item) continue;

            // 行の挿入・削除などで行とデータの対応がずれていた場合は、別のタスクを書き換えないよう保存しない
            if (Number(sheet.getRange(row, 0, 1, 1).getValue()) !== item.id) {
              hasMisalignedRow = true;
              continue;
            }

            const updateData: Record<string, unknown> = {};
            for (let column = Math.max(startColumn, 0); column <= endColumn && column < columns.length; column++) {
              const field = columns[column].field;
              if (field === 'id') continue; // IDは変更不可
              updateData[field] = toStagingValue(field, sheet.getRange(row, column, 1, 1).getValue(), item);
            }

            if (Object.keys(updateData).length > 0) {
              if (isLinksSheet) {
                await api.updateGridLink(item.id, updateData);
              } else {
                await api.updateGridTask(item.id, updateData);
              }
            }
          }
        }

        if (hasMisalignedRow) {
          alert('行とIDの対応がずれているため、一部の変更を保存しませんでした。画面を再読み込みしてください。');
        }
        onDiffRefreshRef.current?.();
      }
    );

    // セル選択イベント: 選択セルの差分情報を親に通知
    const selectionListener = univerAPI.addEvent(
      univerAPI.Event.SelectionChanged,
      (params) => {
        const notify = onCellSelectRef.current;
        const context = getActiveSheetContext();
        if (!context || !notify) return;

        // 最初の選択範囲の先頭セルを使用
        const selection = params.selections?.[0];
        const item = selection ? context.items[selection.startRow - 1] : undefined;
        const column = selection ? context.columns[selection.startColumn] : undefined;
        if (!item || !column) {
          notify(null);
          return;
        }

        const matchingDiff = diffsRef.current.find(
          (diff) => diff.id === item.id && diff.table === context.table && diff.field === column.field
        );
        notify(matchingDiff || null);
      }
    );

    return () => {
      valueChangeListener?.dispose();
      selectionListener?.dispose();
      // Reactのレンダリング中に同期的に破棄するとエラーになるため、次のタスクで破棄する
      setTimeout(() => {
        univer.dispose();
        univerContainer.remove();
      }, 0);
    };
  }, [visible, darkMode, diffs, tasks, links, onCellSelectRef, onDiffRefreshRef, diffsRef]);

  if (!visible) return null;

  return (
    <div className="univer-sheet-wrapper">
      <div
        ref={containerRef}
        className="univer-sheet-container"
        style={{ position: 'relative', width: '100%', height: '100%' }}
      />
    </div>
  );
}
