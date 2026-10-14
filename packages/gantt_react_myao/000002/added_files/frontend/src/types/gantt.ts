/** タスクの種類 */
export type TaskKind = 1 | 2 | 3; // 1: task, 2: project, 3: MS (milestone)

/** オーナーID */
export type OwnerId = 0 | 10 | 20 | 30; // 0: 自分, 10: 待, 20: サイン取, 30: 他

/** タスクデータ */
export interface Task {
  id: number;
  text: string;
  start_date: string; // "YYYY-MM-DD HH:mm:ss"
  end_date: string;
  duration: number;
  progress: number; // 0.0 ~ 1.0
  parent: number; // 0 = トップレベル
  kind_task: TaskKind;
  owner_id: OwnerId;
  sortorder: number;
  color?: string; // "#RRGGBBAA"
  textColor?: string;
  ToDo?: string;
  task_schedule?: string;
  folder?: string;
  url_adress?: string;
  mail?: string;
  memo?: string;
  hyperlink?: string;
  edit_date?: string; // カンマ区切りの編集日履歴
  is_pinned?: boolean;
  // フロントエンド専用
  expanded?: boolean; // 展開状態（プロジェクトのみ）
  open?: boolean; // DHTMLX Gantt用（expandedと同義）
  indent?: number; // 階層の深さ（表示用）
}

/** リンク（依存関係） */
export interface Link {
  id: number;
  source: number; // 元タスクID
  target: number; // 先タスクID
  type: 0 | 1 | 2 | 3; // 0:FS, 1:SS, 2:FF, 3:SF
}

/** APIレスポンス */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/** フィルター条件 */
export interface TaskFilter {
  searchText?: string;
  searchProject?: string;
  showCompleted: boolean; // true: 全て, false: 未完了のみ
  showType: 'all' | 'task' | 'project';
  pinnedMode?: 'all' | 'pinned' | 'unpinned';
  category?: string;
  owner?: string; // All/自分/待/サイン取/他
  periodMode: 'all' | 'before_today' | 'limited'; // 表示期間モード
  dateRangeStart?: number; // 日数（今日からの相対）- limitedモード時のみ使用
  dateRangeEnd?: number;
}

/** ガントチャートデータ */
export interface GanttData {
  tasks: Task[];
  links: Link[];
}

/** タスク作成リクエスト */
export interface CreateTaskRequest {
  id?: number;
  text: string;
  start_date: string;
  end_date: string;
  duration?: number;
  parent?: number;
  kind_task?: TaskKind;
  owner_id?: OwnerId;
  progress?: number;
  color?: string;
  textColor?: string;
  ToDo?: string;
  task_schedule?: string;
  folder?: string;
  url_adress?: string;
  mail?: string;
  memo?: string;
  hyperlink?: string;
  edit_date?: string;
  sortorder?: number;
  is_pinned?: boolean;
}

/** タスク更新リクエスト */
export interface UpdateTaskRequest {
  text?: string;
  start_date?: string;
  end_date?: string;
  duration?: number;
  progress?: number;
  parent?: number;
  kind_task?: TaskKind;
  owner_id?: OwnerId;
  sortorder?: number;
  color?: string;
  textColor?: string;
  ToDo?: string;
  task_schedule?: string;
  folder?: string;
  url_adress?: string;
  mail?: string;
  memo?: string;
  hyperlink?: string;
  edit_date?: string;
  is_pinned?: boolean;
}

/** タスク並び替えアイテム */
export interface TaskReorderItem {
  id: number;
  sortorder: number;
  parent: number;
}

/** タスク並び替えリクエスト */
export interface TaskReorderRequest {
  items: TaskReorderItem[];
}

export interface TaskOpenInputRequest {
  request_id: number;
  task_id: number;
  created_at: string;
}

export interface TaskOpenInputResponse {
  status: string;
  task_id: number;
  input_opened: boolean;
  gantt_visible: boolean;
  request: TaskOpenInputRequest;
  visibility_error?: string | null;
}

/** グリッド差分1件 */
export interface GridDiffItem {
  id: number;
  table: 'tasks' | 'links';
  field: string;
  original: string | null;
  current: string | null;
}

export interface CsvDiffExample {
  id: string;
  label: string;
  changed_fields: string[];
}

export interface CsvDiffSection {
  added_count: number;
  deleted_count: number;
  modified_count: number;
  unchanged_count: number;
  added_examples: CsvDiffExample[];
  deleted_examples: CsvDiffExample[];
  modified_examples: CsvDiffExample[];
}

export interface ObsidianCsvSyncHistoryEntry {
  exists: boolean;
  status: 'initial_save' | 'updated' | 'unchanged';
  checked_at: string;
  saved_at: string | null;
  output_dir: string;
  task_csv_path: string;
  link_csv_path: string;
  summary_json_path: string;
  summary_markdown_path: string;
  tasks: CsvDiffSection;
  links: CsvDiffSection;
}

export interface ObsidianCsvSyncSummary {
  exists: boolean;
  status: 'initial_save' | 'updated' | 'unchanged';
  checked_at: string;
  saved_at: string | null;
  output_dir: string;
  task_csv_path: string;
  link_csv_path: string;
  summary_json_path: string;
  summary_markdown_path: string;
  tasks: CsvDiffSection;
  links: CsvDiffSection;
  history: ObsidianCsvSyncHistoryEntry[];
}

export interface ObsidianCsvSyncSummaryNotFound {
  exists: false;
  output_dir: string;
  summary_json_path: string;
  summary_markdown_path: string;
}

export interface ResolvedTaskLink {
  task_id: number;
  hyperlink: string;
  updated: boolean;
}

export interface HolidaySettings {
  holidays: string[];
  raw_text: string;
  file_path: string;
}

export type BusinessTripType = 'normal_trip' | 'day_trip';

export interface BusinessTripEntry {
  date: string;
  type: BusinessTripType;
}

export interface BusinessTripSettings {
  business_trips: BusinessTripEntry[];
  raw_text: string;
  file_path: string;
}
