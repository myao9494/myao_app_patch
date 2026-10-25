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

import { TASK_COLUMN_DEFINITIONS, LINK_COLUMN_DEFINITIONS } from './gridColumns';
import {
  columnWidths,
  createHeaderRow,
  createRowsFromLinks,
  createRowsFromTasks,
  toStagingValue,
} from './gridCells';
import './UniverSheet.css';

const TASKS_SHEET_NAME = 'Tasks';
const LINKS_SHEET_NAME = 'Links';
const HEADER_ROW_HEIGHT = 30;
const MIN_ROW_COUNT = 1000;

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
