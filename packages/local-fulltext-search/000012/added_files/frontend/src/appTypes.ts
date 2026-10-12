/**
 * 画面全体（App とその配下の画面・フック）で共有する型。
 * API の応答やリクエストの型は types.ts に置く。
 */
export type PageView = "search" | "indexed-targets" | "search-targets" | "scheduler" | "launcher" | "indexed-web-targets" | "rule-management" | "vector-management" | "ai-input";
export type SearchSource = "local" | "web";
export type SearchTarget = "all" | "body" | "filename" | "folder" | "filename_and_folder";
export type SearchExecutionParams = {
  q: string;
  full_path: string;
  search_all_enabled?: boolean;
  skip_refresh?: boolean;
  source_type?: SearchSource;
  search_type?: "hybrid" | "vector" | "keyword";
  index_depth?: number;
  refresh_window_minutes: number;
  regex_enabled?: boolean;
  search_target?: SearchTarget;
  index_types?: string;
  types?: string;
  date_field?: "created" | "modified";
  sort_by?: "default" | "hybrid_score" | "vector_score" | "keyword_score" | "created" | "modified" | "click_count";
  sort_order?: "asc" | "desc";
  created_from?: string;
  created_to?: string;
  include_gantt_tasks?: boolean;
};
export type PendingAutoRefresh = {
  params: SearchExecutionParams;
  searchKey: string;
  baselineLastFinishedAt: string | null;
  hasObservedRunning: boolean;
};
export type RuleSnapshot = {
  excludeKeywords: string;
  synonymGroups: string;
};
export type RuleKind = "exclude" | "synonym" | "extension";
export type RuleContextMenu = { kind: RuleKind; item: string; x: number; y: number };
