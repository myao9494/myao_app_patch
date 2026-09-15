export type SearchResult = {
  file_id: number;
  result_kind: "file" | "folder";
  source_type: "local" | "web" | "gantt";
  target_path: string;
  file_name: string;
  full_path: string;
  file_ext: string;
  created_at: string;
  mtime: string;
  click_count: number;
  has_obsidian_top_tag?: boolean;
  filename_match_priority?: boolean;
  filename_match_level?: number;
  relevance_bucket?: number;
  utility_score?: number;
  query_click_score?: number;
  snippet: string;
  gantt_link?: string | null;
  match_type?: "both" | "vector_only" | "keyword_only" | null;
  hybrid_score?: number | null;
  salient_sentence?: string | null;
  vector_score?: number | null;
  keyword_score?: number | null;
};

export type SearchResponse = {
  total: number;
  items: SearchResult[];
  has_more: boolean;
  next_offset: number | null;
  used_existing_index: boolean;
  background_refresh_scheduled: boolean;
  search_type?: "hybrid" | "vector" | "keyword";
  rag_context_xml?: string | null;
  rag_context_markdown?: string | null;
  detected_terms?: Array<{ term: string; synonyms?: string[]; description?: string }> | null;
};

export type VectorModelStatus = {
  loaded: boolean;
  model_path: string | null;
  current_model?: string | null;
  saved_model_path?: string | null;
  dim: number;
  is_mock: boolean;
  default_light_path: string;
  default_standard_path: string;
  light_available: boolean;
  standard_available: boolean;
  device?: string;
  device_name?: string;
  cuda_available?: boolean;
  mps_available?: boolean;
  has_faiss?: boolean;
};

export type VectorIndexProgress = {
  is_indexing: boolean;
  progress: {
    processed_files: number;
    total_files: number;
    progress_pct: number;
    current_file: string;
    elapsed_sec: number;
    estimated_remaining_sec: number;
  } | null;
  last_result: {
    total_files: number;
    new_count: number;
    updated_count: number;
    skipped_count: number;
    deleted_count: number;
    document_count: number;
    chunk_count: number;
    indexing_time_sec: number;
    embedding_time_sec: number;
    db_size_mb: number;
  } | null;
};

export type VectorIndexStats = {
  document_count: number;
  chunk_count: number;
  db_size_bytes: number;
  db_size_mb: number;
  model_identifier?: string;
  db_path?: string;
};

export type VectorPendingDeletionsResponse = {
  pending_deletions: string[];
  count: number;
};


export type AiHtmlExportResponse = {
  html_content: string;
  file_name: string;
  total_documents: number;
  total_linked_emails?: number;
  total_images_embedded: number;
  size_bytes: number;
};


export type IndexStatus = {
  last_started_at: string | null;
  last_finished_at: string | null;
  total_files: number;
  error_count: number;
  is_running: boolean;
  cancel_requested: boolean;
  last_error: string | null;
};

export type FailedFile = {
  normalized_path: string;
  file_name: string;
  error_message: string;
  last_failed_at: string;
};

export type FailedFileListResponse = {
  items: FailedFile[];
};

export type IndexedTarget = {
  full_path: string;
  source_type: "local" | "web" | "gantt";
  last_indexed_at: string | null;
  indexed_file_count: number;
};

export type IndexedTargetListResponse = {
  items: IndexedTarget[];
};

export type SearchTargetFolder = {
  full_path: string;
  source_type: "local" | "web" | "gantt";
  is_enabled: boolean;
  last_indexed_at: string | null;
  indexed_file_count: number;
};

export type SearchTargetListResponse = {
  items: SearchTargetFolder[];
};

export type SearchTargetCoverage = {
  normalized_path: string;
  source_type: "local" | "web" | "gantt";
  is_covered: boolean;
  covering_path: string | null;
};

export type AppSettings = {
  exclude_keywords: string;
  web_exclude_keywords: string;
  web_fetch_mode: "http" | "edge" | "chrome";
  hidden_indexed_targets: string;
  synonym_groups: string;
  obsidian_sidebar_explorer_data_path: string;
  gantt_parent: number;
  launcher_hotkey: "command_option" | "double_shift";
  index_selected_extensions: string;
  custom_content_extensions: string;
  custom_filename_extensions: string;
  confirm_index_deletion: boolean;
};

export type SchedulerLog = {
  logged_at: string;
  level: string;
  message: string;
  folder_path: string | null;
};

export type SchedulerSettings = {
  paths: string[];
  start_at: string | null;
  is_enabled: boolean;
  status: string;
  last_started_at: string | null;
  last_finished_at: string | null;
  current_path: string | null;
  last_error: string | null;
  logs: SchedulerLog[];
};

export type LauncherStatus = {
  status: "running" | "stopped" | "exited";
  is_running: boolean;
  pid: number | null;
  returncode: number | null;
  autostart: boolean;
  log_path: string;
  logs: string[];
};
