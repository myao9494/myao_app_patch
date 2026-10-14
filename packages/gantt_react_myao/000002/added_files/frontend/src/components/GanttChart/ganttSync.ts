/**
 * サーバーから取得したタスク・リンク（Reactのstate）を DHTMLX Gantt 内部のデータへ差分反映する。
 *
 * - clearAll() による全再構築は原則せず、前回反映した内容から変わったタスクだけを更新する
 *   （ちらつき防止と、大量データでの負荷軽減のため）。
 * - Gantt上の操作（ドラッグ・Lightbox・削除など）は先に画面へ反映され、APIの応答は後から届く。
 *   応答待ちの間に別の再取得が走っても操作結果を巻き戻さないよう、
 *   「保存中」「削除中」「追加中」のIDを GanttSyncState で管理する。
 * - 反映によってAPIが再度呼ばれたり、Undo/Redo の履歴が汚れたりしないようにする。
 *   更新と削除は gantt.silent()（イベントを発火させない）で行う。
 *   追加だけは silent で行うと DHTMLX 内部の並び順キャッシュが更新されず行が表示されなくなるため、
 *   通常の追加として行い、その間は Undo の記録を止め、同期中フラグでイベントハンドラ側のAPI呼び出しを止める。
 */
import { gantt } from 'dhtmlx-gantt';
import type { Link, Task } from '../../types/gantt';
import { addTaskToGantt, toGanttTask } from './ganttTaskUtils';

/** 作成APIの応答が届いてから、サーバーの一覧に現れるまで待つ時間の上限 */
const PENDING_ADD_GRACE_MS = 10_000;
/** これより多くのタスクを一度に追加する場合（CSVインポート等）は、全体を読み込み直す */
const BULK_ADD_THRESHOLD = 50;

export interface GanttSyncState {
  /** 最後にGanttへ反映したサーバー側タスクの内容（タスクID → シグネチャ） */
  lastSynced: Map<number, string>;
  /** 保存APIの応答待ち件数（タスクID → 件数）。待っている間はサーバーの値で上書きしない */
  pendingSaves: Map<number, number>;
  /** Gantt上では削除済みで、削除APIの応答待ちのタスクID。待っている間は復活させない */
  pendingDeletes: Set<number>;
  /**
   * Gantt上に先に存在し、バックエンドへ作成中のタスク（Undoでの復活）。ID → 保護期限(ms)。
   * 期限までは、サーバーの一覧に無くても消さない
   */
  pendingTaskAdds: Map<string, number>;
  /** Gantt上に先に存在し、バックエンドへ作成中のリンク。ID → 保護期限(ms) */
  pendingLinkAdds: Map<string, number>;
  /** true の間は同期処理中。Ganttのイベントハンドラ側でAPI呼び出しを抑止するために参照する */
  isSyncing: boolean;
}

export function createGanttSyncState(): GanttSyncState {
  return {
    lastSynced: new Map(),
    pendingSaves: new Map(),
    pendingDeletes: new Set(),
    pendingTaskAdds: new Map(),
    pendingLinkAdds: new Map(),
    isSyncing: false,
  };
}

/** 作成APIを呼んでいる間の保護を始める（応答が届くまで無期限） */
export function protectPendingAdd(pending: Map<string, number>, id: string | number): void {
  pending.set(String(id), Infinity);
}

/**
 * 作成APIが成功した後の保護に切り替える。
 * サーバーの一覧に現れた時点で保護は解除されるが、現れないままでも一定時間で解除する。
 */
export function confirmPendingAdd(pending: Map<string, number>, id: string | number): void {
  pending.set(String(id), Date.now() + PENDING_ADD_GRACE_MS);
}

function isProtected(pending: Map<string, number>, id: string): boolean {
  const protectedUntil = pending.get(id);
  return protectedUntil !== undefined && Date.now() < protectedUntil;
}

/** サーバーの一覧に現れた、または期限が切れた「追加中」の記録を捨てる */
function releasePendingAdds(pending: Map<string, number>, serverIds: Set<string>): void {
  for (const id of pending.keys()) {
    if (serverIds.has(id) || !isProtected(pending, id)) {
      pending.delete(id);
    }
  }
}

/** タスクの内容が前回反映時から変わったかを判定するための文字列 */
export function taskSignature(task: Task): string {
  return JSON.stringify(task);
}

/** タスク自身か、その先祖のいずれかが削除APIの応答待ちかどうか */
function isAwaitingDelete(task: Task, taskMap: Map<number, Task>, pendingDeletes: Set<number>): boolean {
  if (pendingDeletes.size === 0) return false;
  const visited = new Set<number>();
  let current: Task | undefined = task;
  while (current && !visited.has(current.id)) {
    if (pendingDeletes.has(current.id)) return true;
    visited.add(current.id);
    current = current.parent ? taskMap.get(current.parent) : undefined;
  }
  return false;
}

/**
 * 他の画面や外部から追加されたタスクを、並び順（sortorder）どおりの位置に入れるための挿入位置を返す。
 * 兄弟の並び順はサーバー側の最新値で比べる（gantt上の値は、挿入に伴う繰り下げがまだ反映されていないため）。
 */
function findInsertIndex(task: Task, taskMap: Map<number, Task>): number | undefined {
  const sortorder = task.sortorder ?? 0;
  const index = gantt.getChildren(task.parent || 0).findIndex((siblingId) => {
    const sibling = taskMap.get(Number(siblingId));
    return sibling !== undefined && (sibling.sortorder ?? 0) > sortorder;
  });
  return index === -1 ? undefined : index;
}

function toGanttLink(link: Link) {
  return { ...link, type: String(link.type) };
}

/** Ganttが空の状態から parse でまとめて読み込む（1件ずつ追加するより大幅に速い） */
function loadAll(tasks: Task[], links: Link[], state: GanttSyncState): void {
  gantt.parse({
    data: tasks.map(toGanttTask),
    links: links.map(toGanttLink),
  });
  state.lastSynced.clear();
  for (const task of tasks) {
    state.lastSynced.set(task.id, taskSignature(task));
  }
}

/** 全データを読み込み直す（大量追加時用）。開閉状態は引き継ぐが、Undo/Redoの履歴は消える */
function reloadAll(tasks: Task[], links: Link[], state: GanttSyncState): void {
  const closedIds: (string | number)[] = [];
  gantt.eachTask((task) => {
    if (!task.$open) closedIds.push(task.id);
  });

  gantt.clearAll();
  loadAll(tasks, links, state);

  for (const id of closedIds) {
    if (gantt.isTaskExists(id)) {
      gantt.getTask(id).$open = false;
    }
  }
}

/**
 * サーバーから消えたタスクの削除と、内容が変わったタスクの更新を行う（gantt.silent 内で呼ぶ）。
 * @returns 変更の有無と、gantt にまだ無い（追加が必要な）タスク
 */
function removeAndUpdateTasks(
  tasks: Task[],
  taskMap: Map<number, Task>,
  state: GanttSyncState,
): { changed: boolean; missing: Task[] } {
  let changed = false;
  const serverIds = new Set(tasks.map((task) => String(task.id)));

  // 親を消すと子も消えるので、都度存在を確認する
  const staleIds: (string | number)[] = [];
  gantt.eachTask((task) => {
    const id = String(task.id);
    if (!serverIds.has(id) && !isProtected(state.pendingTaskAdds, id)) {
      staleIds.push(task.id);
    }
  });
  for (const id of staleIds) {
    if (gantt.isTaskExists(id)) {
      gantt.deleteTask(id);
      changed = true;
    }
  }

  const missing: Task[] = [];
  for (const task of tasks) {
    if (!gantt.isTaskExists(task.id)) {
      if (!isAwaitingDelete(task, taskMap, state.pendingDeletes)) {
        missing.push(task);
      }
      continue;
    }

    if ((state.pendingSaves.get(task.id) ?? 0) > 0) continue;
    const signature = taskSignature(task);
    if (state.lastSynced.get(task.id) === signature) continue;

    // 開閉状態はサーバーに保存していないので、Gantt上の状態を保つ
    const existing = gantt.getTask(task.id);
    const wasOpen = existing.$open;
    Object.assign(existing, toGanttTask(task));
    existing.$open = wasOpen;
    existing.open = wasOpen;
    gantt.updateTask(task.id);
    state.lastSynced.set(task.id, signature);
    changed = true;
  }

  return { changed, missing };
}

/** ルートからの階層の深さ（親を辿れる範囲で数える） */
function depthOf(task: Task, taskMap: Map<number, Task>): number {
  let depth = 0;
  const visited = new Set<number>([task.id]);
  let parent = task.parent ? taskMap.get(task.parent) : undefined;
  while (parent && !visited.has(parent.id)) {
    visited.add(parent.id);
    depth++;
    parent = parent.parent ? taskMap.get(parent.parent) : undefined;
  }
  return depth;
}

/** gantt にまだ無いタスクを、並び順どおりの位置へ追加する（Undoには記録させない） */
function addMissingTasks(missing: Task[], taskMap: Map<number, Task>, state: GanttSyncState): void {
  // 親が先に存在するよう、浅い階層から追加する（同じ深さの中ではサーバーの並び順のまま）
  const parentsFirst = missing
    .map((task) => ({ task, depth: depthOf(task, taskMap) }))
    .sort((a, b) => a.depth - b.depth)
    .map(({ task }) => task);

  const undoEnabled = gantt.config.undo;
  gantt.config.undo = false;
  try {
    for (const task of parentsFirst) {
      addTaskToGantt(task, findInsertIndex(task, taskMap));
      state.lastSynced.set(task.id, taskSignature(task));
    }
  } finally {
    gantt.config.undo = undoEnabled;
  }
}

function syncLinks(links: Link[], state: GanttSyncState): boolean {
  let changed = false;
  const serverIds = new Set(links.map((link) => String(link.id)));

  for (const ganttLink of gantt.getLinks()) {
    const id = String(ganttLink.id);
    if (!serverIds.has(id) && !isProtected(state.pendingLinkAdds, id) && gantt.isLinkExists(ganttLink.id)) {
      gantt.deleteLink(ganttLink.id);
      changed = true;
    }
  }

  for (const link of links) {
    const next = toGanttLink(link);
    if (!gantt.isLinkExists(link.id)) {
      gantt.addLink(next);
      changed = true;
      continue;
    }

    const existing = gantt.getLink(link.id);
    if (
      String(existing.source) !== String(next.source) ||
      String(existing.target) !== String(next.target) ||
      String(existing.type) !== next.type
    ) {
      Object.assign(existing, next);
      gantt.updateLink(link.id);
      changed = true;
    }
  }

  return changed;
}

/** サーバーに存在しなくなったID・不要になった保護の管理情報を捨てる */
function releaseStaleState(tasks: Task[], links: Link[], state: GanttSyncState): void {
  const serverIds = new Set(tasks.map((task) => task.id));
  for (const id of state.lastSynced.keys()) {
    if (!serverIds.has(id)) state.lastSynced.delete(id);
  }
  for (const id of state.pendingDeletes) {
    if (!serverIds.has(id)) state.pendingDeletes.delete(id);
  }
  releasePendingAdds(state.pendingTaskAdds, new Set(tasks.map((task) => String(task.id))));
  releasePendingAdds(state.pendingLinkAdds, new Set(links.map((link) => String(link.id))));
}

/**
 * tasks / links を Gantt に差分反映する。
 * @returns Ganttのデータを変更した場合は true（呼び出し側で再描画する）
 */
export function syncGanttData(tasks: Task[], links: Link[], state: GanttSyncState): boolean {
  releaseStaleState(tasks, links, state);

  state.isSyncing = true;
  try {
    if (state.lastSynced.size === 0 && gantt.getTaskCount() === 0) {
      if (tasks.length === 0 && links.length === 0) return false;
      loadAll(tasks, links, state);
      return true;
    }

    // 同期による変更が Undo/Redo の履歴に残らないよう、前後で履歴を保存・復元する
    const undoStack = gantt.getUndoStack ? gantt.getUndoStack().slice() : [];
    const redoStack = gantt.getRedoStack ? gantt.getRedoStack().slice() : [];

    const taskMap = new Map(tasks.map((task) => [task.id, task]));
    let changed = false;
    let missing: Task[] = [];
    gantt.silent(() => {
      ({ changed, missing } = removeAndUpdateTasks(tasks, taskMap, state));
    });

    if (missing.length > BULK_ADD_THRESHOLD) {
      reloadAll(tasks, links, state);
      return true;
    }
    if (missing.length > 0) {
      addMissingTasks(missing, taskMap, state);
      changed = true;
    }

    gantt.silent(() => {
      changed = syncLinks(links, state) || changed;
    });

    if (gantt.getUndoStack) {
      gantt.getUndoStack().splice(0, Infinity, ...undoStack);
    }
    if (gantt.getRedoStack) {
      gantt.getRedoStack().splice(0, Infinity, ...redoStack);
    }

    return changed;
  } finally {
    state.isSyncing = false;
  }
}
