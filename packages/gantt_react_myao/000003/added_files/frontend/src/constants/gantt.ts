import type { OwnerId, TaskFilter } from '../types/gantt';

/** フィルターの初期値（起動時と「フィルターをリセット」で使う）。既定では今日以前のタスクだけを表示する */
export const DEFAULT_TASK_FILTER: TaskFilter = {
  searchText: '',
  searchProject: '',
  showCompleted: false,
  showType: 'all',
  pinnedMode: 'all',
  category: '',
  owner: '',
  periodMode: 'before_today',
  dateRangeStart: 0,
  dateRangeEnd: 0,
};

/** オーナー選択肢 */
export const OWNERS = [
  { key: 0 as OwnerId, label: '自分' },
  { key: 10 as OwnerId, label: '待' },
  { key: 20 as OwnerId, label: 'サイン取' },
  { key: 30 as OwnerId, label: '他' },
] as const;

/** オーナーIDからラベルへのマッピング */
export const OWNER_LABELS: Record<OwnerId, string> = {
  0: '自分',
  10: '待',
  20: 'サイン取',
  30: '他',
};

/** タスク種別選択肢 */
export const KIND_TASKS = [
  { key: '1', label: 'task' },
  { key: '2', label: 'pro' },
  { key: '3', label: 'MS' },
] as const;

/** カラー選択肢 */
export const COLOR_OPTIONS = [
  { key: '', label: 'Default' },
  { key: '#4B008270', label: 'Indigo' },
  { key: '#FFFFF070', label: 'Ivory' },
  { key: '#F0E68C70', label: 'Khaki' },
  { key: '#B0C4DE70', label: 'LightSteelBlue' },
  { key: '#32CD3270', label: 'LimeGreen' },
  { key: '#7B68EE70', label: 'MediumSlateBlue' },
  { key: '#FFA50070', label: 'Orange' },
  { key: '#FF450070', label: 'OrangeRed' },
] as const;

/** ズーム設定 */
export const ZOOM_CONFIG = {
  levels: [
    {
      name: 'day',
      scale_height: 60,
      min_column_width: 80,
      scales: [
        { unit: 'month', format: '%F, %Y' },
        { unit: 'day', step: 1, format: '%j %D' },
      ],
    },
    {
      name: 'month',
      scale_height: 60,
      min_column_width: 30,
      scales: [
        { unit: 'month', format: '%F, %Y' },
        { unit: 'day', step: 1, format: '%j' },
        { unit: 'day', step: 1, format: '%D' },
      ],
    },
    {
      name: 'quarter',
      scale_height: 70,
      min_column_width: 26,
      scales: [
        { unit: 'year', step: 1, format: '%Y' },
        { unit: 'month', format: '%F' },
        { unit: 'week', format: '#%W' },
      ],
    },
    {
      name: 'year',
      scale_height: 60,
      min_column_width: 60,
      scales: [
        { unit: 'year', step: 1, format: '%Y' },
        { unit: 'month', format: '%F' },
      ],
    },
  ],
} as const;

/** オーナーIDからラベルを取得 */
export function getOwnerLabel(ownerId: number): string {
  return OWNER_LABELS[ownerId as OwnerId] ?? '自分';
}

/** タスク種別からCSSクラス名を取得 */
export function getTaskKindClass(kindTask: number | string): string {
  switch (String(kindTask)) {
    case '1':
      return 'task';
    case '2':
      return 'pro';
    case '3':
      return 'ms';
    default:
      return 'task';
  }
}

/** 日付フォーマット (YYYY-MM-DD 00:00:00) */
export function formatDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day} 00:00:00`;
}

/** 日付フォーマット (YYYY-M-D) - edit_date用 */
export function formatEditDate(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}
