/**
 * フォルダ移動の戻る/進む履歴（ペインごと）
 * - 各エントリはパスに加えて、そのフォルダを離れたときのカーソル位置と選択項目を持つ
 *   （戻る/進むで戻ってきたときに復元する）
 * - 新しいフォルダへ移動すると、現在位置より先（進む側）の履歴は捨てる
 * - 最大 100 件。超えたら古いものから捨てる
 */

export interface NavigationEntry {
  path: string;
  focusedIndex: number;
  selectedItems: string[];
}

export interface NavigationState {
  entries: NavigationEntry[];
  index: number;
}

/** フォルダを離れるときに保存する状態 */
export interface NavigationSnapshot {
  focusedIndex: number;
  selectedItems: Iterable<string>;
}

export const MAX_NAVIGATION_ENTRIES = 100;

export function createNavigation(path: string): NavigationState {
  return { entries: [{ path, focusedIndex: 0, selectedItems: [] }], index: 0 };
}

function saveCurrent(state: NavigationState, snapshot: NavigationSnapshot): NavigationEntry[] {
  return state.entries.map((entry, i) =>
    i === state.index
      ? { ...entry, focusedIndex: snapshot.focusedIndex, selectedItems: Array.from(snapshot.selectedItems) }
      : entry
  );
}

/** 新しいフォルダへ移動する */
export function pushNavigation(state: NavigationState, snapshot: NavigationSnapshot, path: string): NavigationState {
  const entries = [
    ...saveCurrent(state, snapshot).slice(0, state.index + 1),
    { path, focusedIndex: 0, selectedItems: [] },
  ].slice(-MAX_NAVIGATION_ENTRIES);
  return { entries, index: entries.length - 1 };
}

/** 戻る（delta = -1）/ 進む（delta = 1）。移動できなければ null */
export function stepNavigation(
  state: NavigationState,
  snapshot: NavigationSnapshot,
  delta: -1 | 1
): { state: NavigationState; target: NavigationEntry } | null {
  const index = state.index + delta;
  const target = state.entries[index];
  if (!target) return null;
  return { state: { entries: saveCurrent(state, snapshot), index }, target };
}

export function canGoBack(state: NavigationState): boolean {
  return state.index > 0;
}

export function canGoForward(state: NavigationState): boolean {
  return state.index < state.entries.length - 1;
}
