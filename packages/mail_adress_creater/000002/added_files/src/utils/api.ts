/**
 * バックエンドAPIとの通信ユーティリティ
 */
export type BackendSettings = {
  keywords: string[]
  address_interval_minutes: number
  keyword_interval_minutes: number
  my_email?: string
  my_phone?: string
  my_address?: string
  my_dept?: string
  my_home_email?: string
}

export type KeywordMatch = {
  received_time: string
  subject: string
  line: string
  keyword: string
  is_new: boolean
  id?: number
  confirmed?: boolean
}

export type Favorite = {
  name: string
  addresses: string[]
  cc_addresses?: string[]
  updated_at?: string
}

export type DatabaseSnapshot = {
  settings: Array<{ key: string; value: string }>
  recipients: Array<{ name: string; count: number; updated_at: string }>
  favorites: Array<{ name: string; addresses: string[]; cc_addresses: string[]; updated_at: string }>
  keyword_matches: Array<{
    id: number
    received_time: string
    subject: string
    line: string
    keyword: string
    first_seen_at: string
    confirmed: boolean
  }>
  job_runs: Array<{ job_name: string; last_run_at: string; status: string; message: string }>
}

export type KeywordCheckResult = {
  matches: KeywordMatch[]
  new_matches: KeywordMatch[]
  keywords: string[]
}

export type ParsedScheduleEvent = {
  start: string
  end: string
  subject: string
  location: string
  body: string
  all_day: boolean
  duration_minutes: number
  normalized_text: string
}

export const DEFAULT_SETTINGS: BackendSettings = {
  keywords: ['棚卸', '棚おろし', 'ユーザID'],
  address_interval_minutes: 43200,
  keyword_interval_minutes: 60,
  my_email: '',
  my_phone: '',
  my_address: '',
  my_dept: '',
  my_home_email: '',
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const { headers, ...rest } = init ?? {}
  const response = await fetch(path, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : 'バックエンド処理に失敗しました')
  }
  return payload as T
}

export async function loadSettings(): Promise<BackendSettings> {
  return requestJson<BackendSettings>('/api/settings')
}

export async function saveSettings(settings: BackendSettings): Promise<BackendSettings> {
  return requestJson<BackendSettings>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
  })
}

export async function loadFavorites(): Promise<{ favorites: Favorite[] }> {
  return requestJson<{ favorites: Favorite[] }>('/api/favorites')
}

export async function saveFavorites(favorites: Favorite[]): Promise<{ favorites: Favorite[] }> {
  return requestJson<{ favorites: Favorite[] }>('/api/favorites', {
    method: 'PUT',
    body: JSON.stringify({ favorites }),
  })
}

export async function addFavorite(name: string, addresses: string[], cc_addresses: string[]): Promise<{ favorite: Favorite; favorites: Favorite[] }> {
  return requestJson<{ favorite: Favorite; favorites: Favorite[] }>('/api/favorites/add', {
    method: 'POST',
    body: JSON.stringify({ name, addresses, cc_addresses }),
  })
}

export async function refreshAddresses(): Promise<{ saved_count: number; zero_count: number }> {
  return requestJson<{ saved_count: number; zero_count: number }>('/api/refresh-addresses', {
    method: 'POST',
    body: JSON.stringify({ limit: 150 }),
  })
}

export async function checkKeywords(): Promise<KeywordCheckResult> {
  return requestJson<KeywordCheckResult>('/api/check-keywords', {
    method: 'POST',
    body: JSON.stringify({ limit: 500 }),
  })
}

export async function parseSchedule(text: string): Promise<{ event: ParsedScheduleEvent }> {
  return requestJson<{ event: ParsedScheduleEvent }>('/api/parse-schedule', {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
}

export async function addSchedule(
  text: string,
  event?: ParsedScheduleEvent,
): Promise<{ event: ParsedScheduleEvent; saved: boolean }> {
  return requestJson<{ event: ParsedScheduleEvent; saved: boolean }>('/api/add-schedule', {
    method: 'POST',
    body: JSON.stringify({ text, event }),
  })
}

export async function loadDatabase(): Promise<DatabaseSnapshot> {
  return requestJson<DatabaseSnapshot>('/api/database')
}

export async function seedDummyData(): Promise<{ inserted: Record<string, number>; database: DatabaseSnapshot }> {
  return requestJson<{ inserted: Record<string, number>; database: DatabaseSnapshot }>('/api/seed-dummy-data', {
    method: 'POST',
  })
}

export async function deleteDatabaseRecords(
  table: Exclude<keyof DatabaseSnapshot, 'settings'>,
  keys: string[],
): Promise<{ result: { table: string; deleted: number }; database: DatabaseSnapshot }> {
  return requestJson<{ result: { table: string; deleted: number }; database: DatabaseSnapshot }>('/api/database/delete', {
    method: 'POST',
    body: JSON.stringify({ table, keys }),
  })
}

export async function loadUnconfirmedMatches(): Promise<{ matches: KeywordMatch[] }> {
  return requestJson<{ matches: KeywordMatch[] }>('/api/keyword-matches?unconfirmed=1')
}

export async function confirmMatches(ids: number[]): Promise<{ updated: number }> {
  return requestJson<{ updated: number }>('/api/keyword-matches/confirm', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
}
