/**
 * バックエンドAPIとの通信を担当するサービスモジュール
 * 各関数は例外を投げず、成否を ApiResponse（success / data / error）で返す。
 * 失敗時の error には、バックエンドが返した詳細メッセージ（detail）があればそれを入れる。
 */
import axios from 'axios';
import type { AxiosResponse } from 'axios';
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

const DEFAULT_ERROR_MESSAGE = '通信エラー';

// --- 更新シーケンス ---
// バックエンドは、すべてのAPI応答に現在の更新シーケンス番号を付ける。
// 変更系（GET以外）の応答で受け取った番号を、観測者（データ管理フック）へ渡す。

const UPDATE_SEQUENCE_HEADER = 'x-update-sequence';

type UpdateSequenceListener = (sequence: number) => void;
const updateSequenceListeners = new Set<UpdateSequenceListener>();

/** 変更系APIが成功するたびに、その応答時点の更新シーケンス番号を受け取る。戻り値は解除関数 */
export function observeMutationSequence(listener: UpdateSequenceListener): () => void {
  updateSequenceListeners.add(listener);
  return () => {
    updateSequenceListeners.delete(listener);
  };
}

api.interceptors.response.use((response) => {
  const method = response.config.method?.toLowerCase();
  const rawSequence = response.headers?.[UPDATE_SEQUENCE_HEADER];
  if (method && method !== 'get' && rawSequence !== undefined) {
    const sequence = Number(rawSequence);
    if (Number.isInteger(sequence)) {
      updateSequenceListeners.forEach((listener) => listener(sequence));
    }
  }
  return response;
});

/** 例外から画面表示用のエラーメッセージを取り出す */
export function describeApiError(error: unknown, fallback: string = DEFAULT_ERROR_MESSAGE): string {
  if (axios.isAxiosError(error)) {
    const detail: unknown = error.response?.data?.detail;
    if (typeof detail === 'string' && detail) {
      return detail;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

/** API呼び出しを実行し、結果を ApiResponse に包んで返す */
async function request<T>(
  call: () => Promise<AxiosResponse<T>>,
  fallbackError: string = DEFAULT_ERROR_MESSAGE,
): Promise<ApiResponse<T>> {
  try {
    const response = await call();
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: describeApiError(error, fallbackError) };
  }
}

// --- タスク API ---

export function getTasks(): Promise<ApiResponse<GanttData>> {
  return request(() => api.get('/api/tasks'));
}

export function getTask(id: number): Promise<ApiResponse<Task>> {
  return request(() => api.get(`/api/tasks/${id}`));
}

export function createTask(task: CreateTaskRequest): Promise<ApiResponse<Task>> {
  return request(() => api.post('/api/tasks', task));
}

export function updateTask(id: number, task: UpdateTaskRequest): Promise<ApiResponse<Task>> {
  return request(() => api.put(`/api/tasks/${id}`, task));
}

export function deleteTask(
  id: number
): Promise<ApiResponse<{ deleted_id: number; deleted_children: number[] }>> {
  return request(() => api.delete(`/api/tasks/${id}`));
}

/** タスクを再帰的に複製する。targetId を指定するとそのタスクの直後に挿入する */
export function cloneTask(id: number, targetId?: number): Promise<ApiResponse<Task>> {
  const params = targetId !== undefined ? { target_id: targetId } : {};
  return request(() => api.post(`/api/tasks/${id}/clone`, null, { params }));
}

export function createObsidianNote(id: number, obsidianHome?: string): Promise<ApiResponse<Task>> {
  return request(() =>
    api.post(`/api/tasks/${id}/obsidian`, null, {
      params: obsidianHome ? { obsidian_home: obsidianHome } : undefined,
    })
  );
}

export function resolveTaskLink(id: number, obsidianHome?: string): Promise<ApiResponse<ResolvedTaskLink>> {
  return request(() =>
    api.post(`/api/tasks/${id}/resolve-link`, null, {
      params: obsidianHome ? { obsidian_home: obsidianHome } : undefined,
    })
  );
}

export function reorderTasks(
  reorderRequest: TaskReorderRequest
): Promise<ApiResponse<{ status: string; updated_count: number }>> {
  return request(() => api.post('/api/tasks/reorder', reorderRequest));
}

/** 現在のGanttデータ更新シーケンス番号を取得する */
export function getGanttUpdateSequence(): Promise<ApiResponse<{ sequence: number }>> {
  return request(() => api.get('/api/tasks/update-sequence'));
}

// --- タスク入力画面（Lightbox）の外部呼び出し API ---

export function requestTaskInputOpen(id: number): Promise<ApiResponse<TaskOpenInputResponse>> {
  return request(() => api.post(`/api/tasks/${id}/open-input`));
}

export function getTaskInputOpenRequest(): Promise<ApiResponse<TaskOpenInputRequest | null>> {
  return request(() => api.get('/api/tasks/open-input-request'));
}

export function acknowledgeTaskInputOpenRequest(
  requestId: number
): Promise<ApiResponse<{ status: string; cleared: boolean; request_id: number }>> {
  return request(() => api.post(`/api/tasks/open-input-request/${requestId}/ack`));
}

export function sendTaskInputOpenClientHeartbeat(): Promise<ApiResponse<{ status: string }>> {
  return request(() => api.post('/api/tasks/open-input-client-heartbeat'));
}

// --- リンク API ---

export function getLinks(): Promise<ApiResponse<Link[]>> {
  return request(() => api.get('/api/links'));
}

export function createLink(link: Omit<Link, 'id'>): Promise<ApiResponse<Link>> {
  return request(() => api.post('/api/links', link));
}

export function updateLink(id: number, link: Partial<Link>): Promise<ApiResponse<Link>> {
  return request(() => api.put(`/api/links/${id}`, link));
}

export function deleteLink(id: number): Promise<ApiResponse<{ message: string }>> {
  return request(() => api.delete(`/api/links/${id}`));
}

// --- エクスポート/インポート API ---

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

export function importCSV(
  file: File
): Promise<ApiResponse<{ imported_count: number; skipped_count: number; errors: string[] }>> {
  const formData = new FormData();
  formData.append('file', file);
  return request(() =>
    api.post('/api/import/csv', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    })
  );
}

// --- Obsidian VaultへのCSV定期保存 API ---

export function syncObsidianCsv(obsidianHome: string): Promise<ApiResponse<ObsidianCsvSyncSummary>> {
  return request(() =>
    api.post('/api/obsidian/export-sync', null, {
      params: { obsidian_home: obsidianHome },
    })
  );
}

export function getObsidianCsvSyncSummary(
  obsidianHome: string
): Promise<ApiResponse<ObsidianCsvSyncSummary | ObsidianCsvSyncSummaryNotFound>> {
  return request(() =>
    api.get('/api/obsidian/export-sync-summary', {
      params: { obsidian_home: obsidianHome },
    })
  );
}

// --- 休日・出張・同義語 API ---

export function getHolidays(): Promise<ApiResponse<HolidaySettings>> {
  return request(() => api.get('/api/holidays'));
}

export function addHoliday(date: string): Promise<ApiResponse<HolidaySettings>> {
  return request(() => api.post('/api/holidays', { date }));
}

export function deleteHoliday(date: string): Promise<ApiResponse<HolidaySettings>> {
  return request(() => api.delete(`/api/holidays/${encodeURIComponent(date)}`));
}

export function updateHolidayRawText(rawText: string): Promise<ApiResponse<HolidaySettings>> {
  return request(() => api.put('/api/holidays/raw', { raw_text: rawText }));
}

export function getBusinessTrips(): Promise<ApiResponse<BusinessTripSettings>> {
  return request(() => api.get('/api/business-trips'));
}

export function addBusinessTrip(
  date: string,
  type: BusinessTripType
): Promise<ApiResponse<BusinessTripSettings>> {
  return request(() => api.post('/api/business-trips', { date, type }));
}

export function updateBusinessTripRawText(rawText: string): Promise<ApiResponse<BusinessTripSettings>> {
  return request(() => api.put('/api/business-trips/raw', { raw_text: rawText }));
}

export function getSynonyms(): Promise<ApiResponse<{ groups: string[][] }>> {
  return request(() => api.get('/api/synonyms'), '同義語APIエラー');
}

// --- グリッド差分確認・アップロード API ---

/** ステージング初期化: tasks→grid_tasks, links→grid_links にコピー */
export function initGrid(): Promise<ApiResponse<{ tasks_count: number; links_count: number }>> {
  return request(() => api.post('/api/grid/init'));
}

/** ステージング上のタスクを更新 */
export function updateGridTask(
  id: number,
  data: Record<string, unknown>
): Promise<ApiResponse<{ status: string; id: number }>> {
  return request(() => api.put(`/api/grid/tasks/${id}`, data));
}

/** ステージング上のリンクを更新 */
export function updateGridLink(
  id: number,
  data: Record<string, unknown>
): Promise<ApiResponse<{ status: string; id: number }>> {
  return request(() => api.put(`/api/grid/links/${id}`, data));
}

/** 本テーブルとステージングの差分を取得 */
export function getGridDiff(): Promise<ApiResponse<{ diffs: GridDiffItem[] }>> {
  return request(() => api.get('/api/grid/diff'));
}

/** ステージングの変更を本テーブルに反映（一括アップロード） */
export function commitGrid(): Promise<
  ApiResponse<{ updated_tasks: number; updated_links: number; errors: string[] }>
> {
  return request(() => api.post('/api/grid/commit'));
}

/** ステージングの指定した差分を本テーブルの値に戻す（元に戻す） */
export function revertGridDiff(
  table: string,
  id: number,
  field: string
): Promise<ApiResponse<{ status: string }>> {
  return request(() => api.post('/api/grid/revert', { table, id, field }));
}

export default api;
