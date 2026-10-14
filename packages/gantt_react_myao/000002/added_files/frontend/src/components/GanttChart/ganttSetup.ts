/**
 * DHTMLX Gantt の静的な設定（プラグイン・基本設定・Lightbox・列・ズーム・今日マーカー）
 * gantt.init() の前に configureGantt() を1度呼ぶ。
 */
import { gantt } from 'dhtmlx-gantt';
import type { Task as GanttTask } from 'dhtmlx-gantt';
import {
  OWNERS,
  KIND_TASKS,
  COLOR_OPTIONS,
  ZOOM_CONFIG,
  getOwnerLabel,
} from '../../constants/gantt';
import { escapeHtml } from '../../utils/taskText';
import { getTaskHierarchyHtml } from './ganttTaskUtils';

export type TimeScale = 'day' | 'month' | 'quarter' | 'year';

export const BASE_ROW_HEIGHT = 27;
export const BASE_BAR_HEIGHT = 18;
const OWNER_COLUMN_WIDTH = 60;
const UNDO_STEPS = 10;
const TODAY_MARKER_ID = 'today-marker';

/**
 * タイムラインの表示範囲を「今日の1年前〜1年後」に設定する。
 * fit_tasks=false と合わせ、タスクに合わせて範囲が勝手に狭まるのを防ぐ。
 */
export function resetDisplayRange(): void {
  const today = new Date();
  const oneYearAgo = new Date(today);
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const oneYearLater = new Date(today);
  oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);
  gantt.config.start_date = oneYearAgo;
  gantt.config.end_date = oneYearLater;
}

/** 現在時刻を示す「Now」マーカー（赤い縦線）を追加、または現在時刻へ移動する */
export function showTodayMarker(): void {
  const marker = gantt.getMarker(TODAY_MARKER_ID);
  if (marker) {
    marker.start_date = new Date();
    gantt.updateMarker(TODAY_MARKER_ID);
    return;
  }
  gantt.addMarker({
    id: TODAY_MARKER_ID,
    start_date: new Date(),
    css: 'today',
    text: 'Now',
  });
}

function configureLightbox(): void {
  // 種別・オーナー・色は右クリックメニューで設定するため、Lightboxにはテキスト項目だけを置く
  gantt.config.lightbox.sections = [
    { name: 'hierarchy', height: 22, type: 'template', map_to: 'hierarchy_path' },
    { name: 'description', height: 35, map_to: 'text', type: 'textarea', focus: true },
    { name: 'hyperlink', height: 30, map_to: 'hyperlink', type: 'textarea' },
    { name: 'ToDo', height: 60, map_to: 'ToDo', type: 'textarea' },
    { name: 'memo', height: 60, map_to: 'memo', type: 'textarea' },
    { name: 'task_schedule', height: 60, map_to: 'task_schedule', type: 'textarea' },
    { name: 'edit_date', height: 35, map_to: 'edit_date', type: 'textarea' },
  ];

  gantt.locale.labels.section_hierarchy = '';
  gantt.locale.labels.section_description = 'タスク名';
  gantt.locale.labels.section_hyperlink = 'hyperlink';
  gantt.locale.labels.section_ToDo = 'ToDo';
  gantt.locale.labels.section_memo = 'memo';
  gantt.locale.labels.section_task_schedule = 'task_schedule';
  gantt.locale.labels.section_edit_date = 'edit_date';

  // Lightbox最上部に階層パスを表示する
  if (gantt.form_blocks?.template) {
    gantt.form_blocks.template.set_value = (node: HTMLElement, _value: unknown, task: GanttTask) => {
      node.innerHTML = `<div class="hierarchy-path">${getTaskHierarchyHtml(task.id)}</div>`;
    };
  }
}

function configureColumns(): void {
  // 追加・複製などの操作は右クリックメニューで行う。
  // インラインエディタの誤作動を避けるため、列に editor は定義しない
  gantt.config.columns = [
    {
      name: 'text',
      label: 'Task name',
      tree: true,
      width: '*', // 幅を自動調整
      resize: true,
      // 既定ではタスク名がHTMLとして解釈されるため、文字どおり表示する
      template: (task: GanttTask) => escapeHtml(task.text),
    },
    {
      // オーナー列の幅は一定に保つ
      name: 'owner_id',
      label: 'owner',
      width: OWNER_COLUMN_WIDTH,
      min_width: OWNER_COLUMN_WIDTH,
      max_width: OWNER_COLUMN_WIDTH,
      align: 'center',
      template: (task: GanttTask) => getOwnerLabel(task.owner_id),
      resize: false,
    },
  ];
}

/** gantt.init() の前に行う設定一式 */
export function configureGantt(timeScale: TimeScale): void {
  gantt.plugins({
    keyboard_navigation: false,
    undo: true,
    marker: true,
    multiselect: true,
  });

  gantt.config.date_format = '%Y-%m-%d %H:%i:%s';
  gantt.config.order_branch = true;
  gantt.config.order_branch_free = true;
  gantt.config.sort = true;
  gantt.config.open_tree_initially = true;
  gantt.config.keyboard_navigation_cells = false;
  gantt.config.row_height = BASE_ROW_HEIGHT;
  gantt.config.bar_height = BASE_BAR_HEIGHT;
  gantt.config.multiselect = true;

  gantt.config.undo = true;
  gantt.config.undo_steps = UNDO_STEPS;

  gantt.config.fit_tasks = false;
  resetDisplayRange();

  gantt.serverList('kind_task', KIND_TASKS.map((kind) => ({ key: kind.key, label: kind.label })));
  gantt.serverList('owner_id', OWNERS.map((owner) => ({ key: owner.key, label: owner.label })));
  gantt.serverList('color', COLOR_OPTIONS.map((color) => ({ key: color.key, label: color.label })));
  gantt.serverList('textColor', COLOR_OPTIONS.map((color) => ({ key: color.key, label: color.label })));

  configureLightbox();
  configureColumns();

  if (gantt.ext?.zoom) {
    gantt.ext.zoom.init(ZOOM_CONFIG as unknown as Parameters<typeof gantt.ext.zoom.init>[0]);
    gantt.ext.zoom.setLevel(timeScale);
  }
}
