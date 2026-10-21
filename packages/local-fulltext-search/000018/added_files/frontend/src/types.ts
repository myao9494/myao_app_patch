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
  /** 一致理由バッジ用の値。バックエンドが match_type から導出して返す。 */
  match_source?: "both" | "vector" | "keyword" | null;
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
    /** 中止要求で途中終了した結果か */
    cancelled?: boolean;
  } | null;
};

/** ベクトルインデックスの単一ファイル更新・本文測定にかかった時間 */
export type VectorBenchmarkResult = {
  relative_path: string;
  /** created / updated / skipped / deleted / measured（本文だけの測定。保存なし） */
  status: string;
  chunk_count: number;
  io_hash_time_ms: number;
  chunking_time_ms: number;
  embedding_time_ms: number;
  db_time_ms: number;
  total_time_ms: number;
};

/** Embedding モデル 1 つ分のベクトルインデックスの規模 */
export type VectorModelIndexStats = {
  document_count: number;
  chunk_count: number;
  db_size_bytes: number;
  db_size_mb: number;
  db_path?: string;
};

export type VectorIndexStats = {
  document_count: number;
  chunk_count: number;
  db_size_bytes: number;
  db_size_mb: number;
  model_identifier?: string;
  db_path?: string;
  /** モデル識別子（ruri-v3-30m など）ごとの規模。読み込み中のモデル以外も含む。 */
  models?: Record<string, VectorModelIndexStats>;
};

export type VectorPendingDeletionsResponse = {
  pending_deletions: string[];
  count: number;
};


export type ExpandedNode = {
  full_path: string;
  file_name: string;
  depth_level: number;
  root_path: string;
  parent_path?: string | null;
  parent_name?: string | null;
  has_top_tag?: boolean;
};


export type AiHtmlExportResponse = {
  html_content: string;
  file_name: string;
  total_documents: number;
  total_linked_emails?: number;
  total_images_embedded: number;
  size_bytes: number;
  expanded_nodes?: ExpandedNode[];
  /** 見つからない・時間切れ・エラーで飛ばした項目（出力を優先し、詰まった箇所を示すため） */
  skipped_links?: SkippedLink[];
  /** 社内AIの上限（20万文字・4.5MB）に収めた HTML ファイル。上限以内なら 1 つ */
  html_parts?: AiHtmlPart[];
  /** 分割前の文字数（埋め込み画像の base64 部分を除く） */
  total_chars?: number;
  char_limit?: number;
  size_limit_bytes?: number;
  /** 上限に収めきれなかったときの内容（空なら収まっている） */
  limit_problems?: string[];
};

/** 上限に合わせて分割した HTML の 1 ファイル分 */
export type AiHtmlPart = {
  index: number;
  total: number;
  /** 文字数（埋め込み画像の base64 部分を除く） */
  chars: number;
  bytes: number;
  html_content: string;
};

/** AI用HTMLの書き出しで処理できなかった項目 */
export type SkippedLink = {
  /** note / linked_note / image / figure / email / render / folder_scan */
  kind: string;
  /** 対象（パスまたはリンクの文字列） */
  target: string;
  /** リンク元のノート名（選んだノートそのものは空） */
  source: string;
  /** not_found / timeout / error */
  reason: string;
  detail: string;
  seconds: number;
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
