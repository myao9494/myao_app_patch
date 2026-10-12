/**
 * グリッド（UniverSheet）の列定義
 * 列の並び順がそのままシートの列番号になる。field はバックエンドのカラム名で、
 * ステージング更新API（/api/grid/tasks, /api/grid/links）へ送るキーとして使う。
 */

export interface ColumnDefinition {
  /** カラム名（ヘッダー表示用） */
  name: string;
  /** フィールド名（DBのカラム名） */
  field: string;
  /** 列幅(px) */
  width: number;
}

/** Tasksシートの列: DBの全カラムを表示する */
export const TASK_COLUMN_DEFINITIONS: ColumnDefinition[] = [
  { name: 'ID', field: 'id', width: 60 },
  { name: 'タスク名', field: 'text', width: 300 },
  { name: '開始日', field: 'start_date', width: 130 },
  { name: '終了日', field: 'end_date', width: 130 },
  { name: '期間', field: 'duration', width: 50 },
  { name: '進捗率(%)', field: 'progress', width: 70 },
  { name: '親ID', field: 'parent', width: 60 },
  { name: '種類', field: 'kind_task', width: 50 },
  { name: 'オーナー', field: 'owner_id', width: 70 },
  { name: '並び順', field: 'sortorder', width: 60 },
  { name: '色', field: 'color', width: 80 },
  { name: '文字色', field: 'textColor', width: 80 },
  { name: 'ToDo', field: 'ToDo', width: 120 },
  { name: 'スケジュール', field: 'task_schedule', width: 120 },
  { name: 'フォルダ', field: 'folder', width: 120 },
  { name: 'URL', field: 'url_adress', width: 150 },
  { name: 'メール', field: 'mail', width: 120 },
  { name: 'メモ', field: 'memo', width: 200 },
  { name: 'リンク', field: 'hyperlink', width: 150 },
  { name: '編集日', field: 'edit_date', width: 120 },
  { name: '作成日', field: 'created_at', width: 130 },
  { name: '更新日', field: 'updated_at', width: 130 },
];

/** Linksシートの列 */
export const LINK_COLUMN_DEFINITIONS: ColumnDefinition[] = [
  { name: 'ID', field: 'id', width: 60 },
  { name: 'ソースタスクID (source)', field: 'source', width: 120 },
  { name: 'ターゲットタスクID (target)', field: 'target', width: 120 },
  { name: 'リンクタイプ (type)', field: 'type', width: 100 },
];
