/**
 * バックエンドAPIとの通信を担当するサービスモジュール
 */
import axios from 'axios';
import type {
  ApiResponse,
  Task,
  Link,
  GanttData,
  CreateTaskRequest,
  UpdateTaskRequest,
  TaskReorderRequest,
  TaskOpenInputRequest,
  TaskOpenInputResponse,
  GridDiffItem,
  BusinessTripSettings,
  BusinessTripType,
  HolidaySettings,
  ObsidianCsvSyncSummary,
  ObsidianCsvSyncSummaryNotFound,
  ResolvedTaskLink,
} from '../types/gantt';

// バックエンドから配信時は同一オリジンのため空文字列
// 開発時はViteプロキシが/apiを転送
const API_BASE_URL = import.meta.env.VITE_API_URL || '';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// タスク API
export async function getTasks(): Promise<ApiResponse<GanttData>> {
  try {
    const response = await api.get('/api/tasks');
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export async function getTask(id: number): Promise<ApiResponse<Task>> {
  try {
    const response = await api.get(`/api/tasks/${id}`);
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export async function createTask(
  task: CreateTaskRequest
): Promise<ApiResponse<Task>> {
  try {
    const response = await api.post('/api/tasks', task);
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export async function updateTask(
  id: number,
  task: UpdateTaskRequest
): Promise<ApiResponse<Task>> {
  try {
    const response = await api.put(`/api/tasks/${id}`, task);
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export async function deleteTask(
  id: number
): Promise<ApiResponse<{ deleted_id: number; deleted_children: number[] }>> {
  try {
    const response = await api.delete(`/api/tasks/${id}`);
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

// ... (existing code)
export async function cloneTask(id: number, targetId?: number): Promise<ApiResponse<Task>> {
  try {
    const params = targetId !== undefined ? { target_id: targetId } : {};
    const response = await api.post(`/api/tasks/${id}/clone`, null, { params });
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export async function createObsidianNote(id: number, obsidianHome?: string): Promise<ApiResponse<Task>> {
  try {
    const response = await api.post(`/api/tasks/${id}/obsidian`, null, {
      params: obsidianHome ? { obsidian_home: obsidianHome } : undefined,
    });
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export async function resolveTaskLink(id: number, obsidianHome?: string): Promise<ApiResponse<ResolvedTaskLink>> {
  try {
    const response = await api.post(`/api/tasks/${id}/resolve-link`, null, {
      params: obsidianHome ? { obsidian_home: obsidianHome } : undefined,
    });
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export async function reorderTasks(
  request: TaskReorderRequest
): Promise<ApiResponse<{ status: string; updated_count: number }>> {
  try {
    const response = await api.post('/api/tasks/reorder', request);
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export async function requestTaskInputOpen(id: number): Promise<ApiResponse<TaskOpenInputResponse>> {
  try {
    const response = await api.post(`/api/tasks/${id}/open-input`);
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export async function getTaskInputOpenRequest(): Promise<ApiResponse<TaskOpenInputRequest | null>> {
  try {
    const response = await api.get('/api/tasks/open-input-request');
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export async function acknowledgeTaskInputOpenRequest(
  requestId: number
): Promise<ApiResponse<{ status: string; cleared: boolean; request_id: number }>> {
  try {
    const response = await api.post(`/api/tasks/open-input-request/${requestId}/ack`);
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export async function sendTaskInputOpenClientHeartbeat(): Promise<ApiResponse<{ status: string }>> {
  try {
    const response = await api.post('/api/tasks/open-input-client-heartbeat');
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

// リンク API
export async function getLinks(): Promise<ApiResponse<Link[]>> {
  try {
    const response = await api.get('/api/links');
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export async function createLink(
  link: Omit<Link, 'id'>
): Promise<ApiResponse<Link>> {
  try {
    const response = await api.post('/api/links', link);
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export async function deleteLink(id: number): Promise<ApiResponse<void>> {
  try {
    await api.delete(`/api/links/${id}`);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export async function updateLink(
  id: number,
  link: Partial<Link>
): Promise<ApiResponse<Link>> {
  try {
    const response = await api.put(`/api/links/${id}`, link);
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

// エクスポート/インポート API
export async function exportCSV(): Promise<Blob | null> {
  try {
    const response = await api.get('/api/export/csv', {
      responseType: 'blob',
    });
    return response.data;
  } catch (error) {
    console.error('CSV export error:', error);
    return null;
  }
}

export async function importCSV(
  file: File
): Promise<
  ApiResponse<{ imported_count: number; skipped_count: number; errors: string[] }>
> {
  try {
    const formData = new FormData();
    formData.append('file', file);
    const response = await api.post('/api/import/csv', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export async function syncObsidianCsv(
  obsidianHome: string
): Promise<ApiResponse<ObsidianCsvSyncSummary>> {
  try {
    const response = await api.post('/api/obsidian/export-sync', null, {
      params: { obsidian_home: obsidianHome },
    });
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export async function getObsidianCsvSyncSummary(
  obsidianHome: string
): Promise<ApiResponse<ObsidianCsvSyncSummary | ObsidianCsvSyncSummaryNotFound>> {
  try {
    const response = await api.get('/api/obsidian/export-sync-summary', {
      params: { obsidian_home: obsidianHome },
    });
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export async function getHolidays(): Promise<ApiResponse<HolidaySettings>> {
  try {
    const response = await api.get('/api/holidays');
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export async function getSynonyms(): Promise<ApiResponse<{ groups: string[][] }>> {
  try {
    const response = await api.get('/api/synonyms');
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '同義語APIエラー',
    };
  }
}

/**
 * 現在のGanttデータ更新シーケンス番号を取得する
 */
export async function getGanttUpdateSequence(): Promise<ApiResponse<{ sequence: number }>> {
  try {
    const response = await api.get('/api/tasks/update-sequence');
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export async function addHoliday(date: string): Promise<ApiResponse<HolidaySettings>> {
  try {
    const response = await api.post('/api/holidays', { date });
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export async function deleteHoliday(date: string): Promise<ApiResponse<HolidaySettings>> {
  try {
    const response = await api.delete(`/api/holidays/${encodeURIComponent(date)}`);
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export async function updateHolidayRawText(rawText: string): Promise<ApiResponse<HolidaySettings>> {
  try {
    const response = await api.put('/api/holidays/raw', { raw_text: rawText });
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export async function getBusinessTrips(): Promise<ApiResponse<BusinessTripSettings>> {
  try {
    const response = await api.get('/api/business-trips');
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export async function addBusinessTrip(
  date: string,
  type: BusinessTripType
): Promise<ApiResponse<BusinessTripSettings>> {
  try {
    const response = await api.post('/api/business-trips', { date, type });
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export async function updateBusinessTripRawText(rawText: string): Promise<ApiResponse<BusinessTripSettings>> {
  try {
    const response = await api.put('/api/business-trips/raw', { raw_text: rawText });
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '通信エラー',
    };
  }
}

export default api;

// --- グリッド差分確認・アップロード API ---

/** ステージング初期化: tasks→grid_tasks, links→grid_links にコピー */
export async function initGrid(): Promise<ApiResponse<{ tasks_count: number; links_count: number }>> {
  try {
    const response = await api.post('/api/grid/init');
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '通信エラー' };
  }
}

/** ステージング上のタスクを更新 */
export async function updateGridTask(
  id: number,
  data: Record<string, unknown>
): Promise<ApiResponse<{ status: string; id: number }>> {
  try {
    const response = await api.put(`/api/grid/tasks/${id}`, data);
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '通信エラー' };
  }
}

/** ステージング上のリンクを更新 */
export async function updateGridLink(
  id: number,
  data: Record<string, unknown>
): Promise<ApiResponse<{ status: string; id: number }>> {
  try {
    const response = await api.put(`/api/grid/links/${id}`, data);
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '通信エラー' };
  }
}

/** 本テーブルとステージングの差分を取得 */
export async function getGridDiff(): Promise<ApiResponse<{ diffs: GridDiffItem[] }>> {
  try {
    const response = await api.get('/api/grid/diff');
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '通信エラー' };
  }
}

/** ステージングの変更を本テーブルに反映（一括アップロード） */
export async function commitGrid(): Promise<
  ApiResponse<{ updated_tasks: number; updated_links: number; errors: string[] }>
> {
  try {
    const response = await api.post('/api/grid/commit');
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '通信エラー' };
  }
}

/** ステージングの指定した差分を本テーブルの値に戻す（元に戻す） */
export async function revertGridDiff(
  table: string,
  id: number,
  field: string
): Promise<ApiResponse<{ status: string }>> {
  try {
    const response = await api.post('/api/grid/revert', { table, id, field });
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '通信エラー' };
  }
}
