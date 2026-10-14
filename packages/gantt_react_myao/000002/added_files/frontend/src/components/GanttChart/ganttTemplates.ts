/**
 * ガントチャートの表示テンプレート（タスクバー・右側テキスト・ツリーアイコン・セル背景）
 * DHTMLX Gantt のテンプレートはHTML文字列を返すため、タスク名などユーザー入力は必ずエスケープする。
 */
import { gantt } from 'dhtmlx-gantt';
import type { Task as GanttTask } from 'dhtmlx-gantt';
import type { BusinessTripType, Task } from '../../types/gantt';
import { getTaskKindClass } from '../../constants/gantt';
import { getTaskIconName } from '../../utils/iconUtils';
import { formatDateForSchedule, parseSchedule } from '../../utils/scheduleParser';
import { escapeHtml } from '../../utils/taskText';
import { buildTaskLabelHtml, isProjectTask, type GanttId } from './ganttTaskUtils';

const ICON_BASE_PATH = '/icons/catppuccin';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// プロジェクトバー内のラベル。スケジュールのピン(z-index: 5)より手前に置き、
// ラッパーは pointer-events: none で背面のクリックを通し、ラベル（リンク）だけクリック可能にする
const BAR_LABEL_WRAPPER_STYLE =
  'position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: 10; pointer-events: none; display: flex; align-items: center; overflow: visible;';
const BAR_LABEL_STYLE =
  'margin-left: 30px; pointer-events: auto; flex-shrink: 0; white-space: nowrap; display: inline-block;';

/** テンプレートが参照する、コンポーネント側の最新状態 */
export interface GanttTemplateState {
  /** 休日として背景を塗る日付（YYYY-MM-DD） */
  getHolidays: () => Set<string>;
  /** 出張日（YYYY-MM-DD → 種別） */
  getBusinessTrips: () => Map<string, BusinessTripType>;
  /** Cmd+矢印キーでフォーカス中のタスクID（フォーカスモードでなければ null） */
  getKeyboardFocusTaskId: () => GanttId | null;
}

/**
 * タスクのスケジュール（task_schedule）をバー上のピン📌として描画するHTMLを返す。
 * ピンは対象日のセルの中央に置く。data-* 属性はピンの右クリック・ドラッグ処理で使う。
 */
export function buildScheduleHtml(task: GanttTask): string {
  if (!task.task_schedule) return '';

  const taskStartPos = gantt.posFromDate(task.start_date as Date);
  return parseSchedule(task.task_schedule)
    .map((event) => {
      const eventPos = gantt.posFromDate(event.date);
      const dayCellWidth = gantt.posFromDate(new Date(event.date.getTime() + ONE_DAY_MS)) - eventPos;
      const relativeLeft = eventPos - taskStartPos + dayCellWidth * 0.5;
      const dateStr = formatDateForSchedule(event.date);
      // ツールチップには日付とテキストだけを出す（時刻 00:00:00 などは除く）
      const text = escapeHtml(event.text.replace(/\d{2}:\d{2}:\d{2}/g, '').trim());

      return `
          <div
            class="gantt-schedule-event"
            data-task-id="${escapeHtml(task.id)}"
            data-schedule-index="${event.sourceIndex ?? 0}"
            data-schedule-date="${dateStr}"
            data-schedule-text="${text}"
            style="left: ${relativeLeft}px; top: 0; margin-left: -5px;"
          >
            <div class="gantt-schedule-icon">📌</div>
            <div class="gantt-schedule-tooltip">${dateStr} ${text}</div>
          </div>
        `;
    })
    .join('');
}

/** ハイパーリンク付きならクリックで開けるリンク、なければ fallbackTag で包んだHTMLを返す */
function wrapWithHyperlink(task: GanttTask, innerHtml: string, style = '', fallbackTag = ''): string {
  const styleAttr = style ? ` style="${style}"` : '';
  if (task.hyperlink) {
    return `<a href="#" data-task-id="${escapeHtml(task.id)}" data-hyperlink="${escapeHtml(task.hyperlink)}"${styleAttr}>${innerHtml}</a>`;
  }
  return fallbackTag ? `<${fallbackTag}${styleAttr}>${innerHtml}</${fallbackTag}>` : innerHtml;
}

/** タスクバー内: タスク/マイルストーンはピンのみ、プロジェクトは "[id]名前" ラベルも表示する */
function taskBarText(_start: Date, _end: Date, task: GanttTask): string {
  const scheduleHtml = buildScheduleHtml(task);
  const kind = String(task.kind_task);
  if (kind === '1' || kind === '3') {
    return scheduleHtml;
  }

  const labelHtml = wrapWithHyperlink(task, buildTaskLabelHtml(task), BAR_LABEL_STYLE, 'span');
  return `${scheduleHtml}<div style="${BAR_LABEL_WRAPPER_STYLE}">${labelHtml}</div>`;
}

/** バー右側: タスク/マイルストーンのみ "[id] 名前 > [親id] 親の名前" を表示する */
function taskRightsideText(_start: Date, _end: Date, task: GanttTask): string {
  if (isProjectTask(task)) {
    return '';
  }

  let displayHtml = buildTaskLabelHtml(task, ' ');
  if (task.parent && task.parent !== 0 && gantt.isTaskExists(task.parent)) {
    displayHtml += ` &gt; ${buildTaskLabelHtml(gantt.getTask(task.parent), ' ')}`;
  }
  return wrapWithHyperlink(task, displayHtml);
}

/**
 * タスクバーまわりのテンプレートを設定する。
 * 印刷モードではバー内を空にし、右側にタスク名だけを表示する。
 */
export function applyTaskBarTemplates(isPrintMode: boolean): void {
  if (isPrintMode) {
    gantt.templates.task_text = () => '';
    gantt.templates.rightside_text = (_start: Date, _end: Date, task: GanttTask) => escapeHtml(task.text);
    return;
  }
  gantt.templates.task_text = taskBarText;
  gantt.templates.rightside_text = taskRightsideText;
}

function treeIconHtml(task: GanttTask, cssClass: string, isOpen: boolean, isFolder: boolean): string {
  const iconName = getTaskIconName(task as unknown as Task, isOpen, isFolder);
  const extension = iconName === 'excalidraw' ? 'ico' : 'svg';
  return `<div class='gantt_tree_icon ${cssClass}' style='background-image:url(${ICON_BASE_PATH}/${iconName}.${extension})'></div>`;
}

/** モードに依存しないテンプレート（行・セルのクラス、ツリーアイコン）を設定する */
export function applyStaticTemplates(state: GanttTemplateState): void {
  gantt.templates.task_class = (_start: Date, _end: Date, task: GanttTask) => {
    const classes = [getTaskKindClass(task.kind_task)];
    if (task.is_pinned) {
      classes.push('pinned-task');
    }
    return classes.join(' ');
  };

  // 出張日 > 土日・休日 の優先順で背景クラスを決める
  gantt.templates.timeline_cell_class = (_task: GanttTask, date: Date) => {
    const dateKey = formatDateForSchedule(date);
    const tripType = state.getBusinessTrips().get(dateKey);
    if (tripType === 'normal_trip') {
      return 'business-trip-normal';
    }
    if (tripType === 'day_trip') {
      return 'business-trip-day';
    }
    if (date.getDay() === 0 || date.getDay() === 6 || state.getHolidays().has(dateKey)) {
      return 'weekend';
    }
    return '';
  };

  // Cmd+矢印キーでのフォーカス移動中の行を強調する
  const keyboardFocusRowClass = (_start: Date, _end: Date, task: GanttTask) =>
    task.id === state.getKeyboardFocusTaskId() ? 'keyboard-focus-row' : '';
  gantt.templates.grid_row_class = keyboardFocusRowClass;
  gantt.templates.task_row_class = keyboardFocusRowClass;

  // ツリーのデフォルトアイコンを Catppuccin アイコンに置き換える
  gantt.templates.grid_folder = (task: GanttTask) => {
    const isOpen = !!(task.$open || task.open);
    return treeIconHtml(task, `gantt_folder_${isOpen ? 'open' : 'closed'}`, isOpen, true);
  };
  gantt.templates.grid_file = (task: GanttTask) => treeIconHtml(task, 'gantt_file', false, false);
}
