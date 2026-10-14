/**
 * 画面の操作テストで使う、バックエンド API の応答のひな形。
 * installAppApi は、アプリが起動時に呼ぶ API へ既定の応答を返す fetch の代用品を設定する。
 * テストごとに、確かめたい経路の応答だけを差し替える。
 */
import type {
  AppSettings,
  IndexStatus,
  LauncherStatus,
  SchedulerSettings,
  SearchResponse,
  SearchResult,
} from "../types.ts";
import { installFetchStub, type FetchStub } from "./dom.ts";

export function appSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    exclude_keywords: ".git\nnode_modules",
    web_exclude_keywords: "",
    web_fetch_mode: "http",
    hidden_indexed_targets: "",
    synonym_groups: "",
    obsidian_sidebar_explorer_data_path: "",
    gantt_parent: 0,
    launcher_hotkey: "command_option",
    index_selected_extensions: ".md\n.txt\n.pdf",
    custom_content_extensions: "",
    custom_filename_extensions: "",
    confirm_index_deletion: true,
    ...overrides,
  };
}

export function indexStatus(overrides: Partial<IndexStatus> = {}): IndexStatus {
  return {
    last_started_at: null,
    last_finished_at: null,
    total_files: 0,
    error_count: 0,
    is_running: false,
    cancel_requested: false,
    last_error: null,
    ...overrides,
  };
}

export function schedulerSettings(overrides: Partial<SchedulerSettings> = {}): SchedulerSettings {
  return {
    paths: [],
    start_at: null,
    is_enabled: false,
    status: "idle",
    last_started_at: null,
    last_finished_at: null,
    current_path: null,
    last_error: null,
    logs: [],
    ...overrides,
  };
}

export function launcherStatus(overrides: Partial<LauncherStatus> = {}): LauncherStatus {
  return {
    status: "stopped",
    is_running: false,
    pid: null,
    returncode: null,
    autostart: false,
    log_path: "/tmp/launcher.log",
    logs: [],
    ...overrides,
  };
}

export function searchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    file_id: 1,
    result_kind: "file",
    source_type: "local",
    target_path: "/docs",
    file_name: "note.md",
    full_path: "/docs/note.md",
    file_ext: ".md",
    created_at: "2026-01-01T00:00:00Z",
    mtime: "2026-01-02T00:00:00Z",
    click_count: 0,
    snippet: "本文の抜粋",
    ...overrides,
  } as SearchResult;
}

export function searchResponse(items: SearchResult[], overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    total: items.length,
    items,
    has_more: false,
    next_offset: null,
    used_existing_index: false,
    background_refresh_scheduled: false,
    search_type: "hybrid",
    ...overrides,
  };
}

/** アプリが起動時に呼ぶ API へ既定の応答を返す。routes で経路ごとに差し替えられる。 */
export function installAppApi(routes: Parameters<typeof installFetchStub>[0] = {}): FetchStub {
  return installFetchStub({
    "GET /api/index/settings": appSettings(),
    "GET /api/index/status": indexStatus(),
    "GET /api/index/scheduler": schedulerSettings(),
    "GET /api/launcher/status": launcherStatus(),
    "GET /api/index/search-targets": { items: [] },
    "GET /api/index/targets": { items: [] },
    "GET /api/index/failed-files": { items: [] },
    "GET /api/index/search-targets/coverage": {
      normalized_path: "",
      source_type: "local",
      is_covered: false,
      covering_path: null,
    },
    ...routes,
  });
}
