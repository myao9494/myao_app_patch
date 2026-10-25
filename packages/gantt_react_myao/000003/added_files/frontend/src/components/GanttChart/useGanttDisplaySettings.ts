/**
 * 表示設定（タイムスケール・休日/出張・左グリッド・印刷モード・全展開/全折りたたみ・表示倍率）を gantt へ反映する。
 * gantt の初期化後に反映するため、必ず初期化の useEffect より後に呼ぶこと。
 */
import { useEffect, type RefObject } from 'react';
import { gantt } from 'dhtmlx-gantt';
import type { BusinessTripEntry } from '../../types/gantt';
import { BASE_BAR_HEIGHT, BASE_ROW_HEIGHT, type TimeScale } from './ganttSetup';
import { applyTaskBarTemplates } from './ganttTemplates';

const SCALE_STYLE_ELEMENT_ID = 'gantt-scale-style';

/** 表示倍率に合わせて、Gantt各部のフォントサイズを上書きするCSSを生成する */
function buildScaleStyle(scale: number): string {
  const baseFontSize = Math.max(8, Math.round(12 * scale));
  const taskContentFontSize = Math.max(8, Math.round(10 * scale));
  const sideContentFontSize = Math.max(8, Math.round(11 * scale));

  return `
      .gantt_scale_cell,
      .gantt_grid_head_cell,
      .gantt_task_cell,
      .gantt_grid_data,
      .gantt_row,
      .gantt_cell,
      .gantt_grid_data .gantt_cell.gantt_last_cell,
      .gantt_grid_scale .gantt_grid_head_cell,
      .gantt_grid_data .gantt_row.odd:hover,
      .gantt_grid_data .gantt_row:hover,
      .hierarchy-path,
      .gantt_cal_light,
      .gantt_cal_light .gantt_cal_ltext .gantt_section_time,
      .gantt_cal_light .gantt_cal_larea,
      .gantt_cal_light .gantt_cal_ltext textarea,
      .gantt_cal_light select,
      .gantt_cal_light input {
        font-size: ${baseFontSize}px !important;
      }

      .gantt_task_content {
        font-size: ${taskContentFontSize}px !important;
      }

      .gantt_side_content {
        font-size: ${sideContentFontSize}px !important;
      }
    `;
}

interface UseGanttDisplaySettingsOptions {
  initialized: RefObject<boolean>;
  timeScale: TimeScale;
  isPrintMode: boolean;
  gridCollapsed: boolean;
  gridWidth: number;
  displaySize: number;
  /** 値が増えるたびに全タスクを展開する */
  expandAllTrigger: number;
  /** 値が増えるたびに全タスクを折りたたむ */
  collapseAllTrigger: number;
  holidays: string[];
  businessTrips: BusinessTripEntry[];
  /** テンプレートから参照される、休日・出張の集合（このフックが更新する） */
  holidaySetRef: RefObject<Set<string>>;
  businessTripMapRef: RefObject<Map<string, BusinessTripEntry['type']>>;
}

export function useGanttDisplaySettings({
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
}: UseGanttDisplaySettingsOptions): void {
  useEffect(() => {
    if (initialized.current && gantt.ext?.zoom) {
      gantt.ext.zoom.setLevel(timeScale);
      gantt.render();
    }
  }, [initialized, timeScale]);

  useEffect(() => {
    holidaySetRef.current = new Set(holidays.map((holiday) => holiday.trim()).filter(Boolean));
    if (initialized.current) {
      gantt.render();
    }
  }, [initialized, holidays, holidaySetRef]);

  useEffect(() => {
    businessTripMapRef.current = new Map(
      businessTrips
        .filter((trip) => trip.date && (trip.type === 'normal_trip' || trip.type === 'day_trip'))
        .map((trip) => [trip.date.trim(), trip.type])
    );
    if (initialized.current) {
      gantt.render();
    }
  }, [initialized, businessTrips, businessTripMapRef]);

  // 左側グリッドの表示/幅と、印刷モード（グリッド非表示・バー右にタスク名のみ）
  useEffect(() => {
    if (!initialized.current) return;

    if (isPrintMode) {
      gantt.config.show_grid = false;
      gantt.showDate(new Date());
    } else {
      gantt.config.show_grid = !gridCollapsed;
      gantt.config.grid_width = gridCollapsed ? 0 : gridWidth;
    }
    applyTaskBarTemplates(isPrintMode);
    gantt.render();
  }, [initialized, isPrintMode, gridCollapsed, gridWidth]);

  useEffect(() => {
    if (!initialized.current || expandAllTrigger === 0) return;
    gantt.eachTask((task) => {
      task.$open = true;
    });
    gantt.render();
  }, [initialized, expandAllTrigger]);

  useEffect(() => {
    if (!initialized.current || collapseAllTrigger === 0) return;
    gantt.eachTask((task) => {
      task.$open = false;
    });
    gantt.render();
  }, [initialized, collapseAllTrigger]);

  // 表示倍率: 行・バー・列の大きさとフォントサイズを変える
  useEffect(() => {
    if (!initialized.current) return;

    const scale = displaySize / 100;
    gantt.config.scale_height = Math.round(60 * scale);
    gantt.config.row_height = Math.round(BASE_ROW_HEIGHT * scale);
    gantt.config.bar_height = Math.max(12, Math.round(BASE_BAR_HEIGHT * scale));
    gantt.config.min_column_width = Math.round(30 * scale);

    let styleElement = document.getElementById(SCALE_STYLE_ELEMENT_ID);
    if (!styleElement) {
      styleElement = document.createElement('style');
      styleElement.id = SCALE_STYLE_ELEMENT_ID;
      document.head.appendChild(styleElement);
    }
    styleElement.textContent = buildScaleStyle(scale);

    gantt.render();
  }, [initialized, displaySize]);
}
