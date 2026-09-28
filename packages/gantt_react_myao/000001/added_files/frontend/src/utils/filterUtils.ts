/**
 * フィルタ処理の高速化ユーティリティ
 * - 事前にMap（インデックス）を構築し、O(n²)の走査をO(n)に改善する
 * - タスク名・同義語だけでなくID番号での検索（searchText / searchProject）に対応
 * - 先祖・子孫コンテキストの維持と高速ツリー順構築
 */
import { getOwnerLabel } from '../constants/gantt';
import type { Task, TaskFilter } from '../types/gantt';

export interface TaskFilterIndexes {
  taskMap: Map<number, Task>;
  childrenMap: Map<number, Task[]>;
  textLowerMap: Map<number, string>;
  ownerLabelMap: Map<number, string>;
  startDateMsMap: Map<number, number | null>;
  endDateMsMap: Map<number, number | null>;
  synonymMap?: Map<string, string[]>;
  normalizedSynonymGroups?: string[][];
}

interface FilterDateBounds {
  beforeTodayEndMs?: number;
  limitedStartMs?: number;
  limitedEndMs?: number;
}

/**
 * 親ID → 子タスク配列のMapを構築する
 * sortorderでソート済みの状態で格納する
 * @param tasks 全タスク配列
 * @returns Map<parentId, Task[]>
 */
export function buildChildrenMap(tasks: Task[]): Map<number, Task[]> {
  const map = new Map<number, Task[]>();
  for (const task of tasks) {
    const parentId = task.parent ?? 0;
    let children = map.get(parentId);
    if (!children) {
      children = [];
      map.set(parentId, children);
    }
    children.push(task);
  }
  // 各子タスク配列をsortorderでソート
  for (const children of map.values()) {
    children.sort((a, b) => (a.sortorder || 0) - (b.sortorder || 0));
  }
  return map;
}

function parseTaskDate(value?: string): Date | null {
  if (!value) return null;
  const parsed = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function buildTaskFilterIndexes(tasks: Task[], synonymGroups?: string[][]): TaskFilterIndexes {
  const taskMap = new Map<number, Task>();
  const textLowerMap = new Map<number, string>();
  const ownerLabelMap = new Map<number, string>();
  const startDateMsMap = new Map<number, number | null>();
  const endDateMsMap = new Map<number, number | null>();

  for (const task of tasks) {
    taskMap.set(task.id, task);
    textLowerMap.set(task.id, task.text?.toLowerCase() ?? '');
    ownerLabelMap.set(task.id, getOwnerLabel(task.owner_id));

    const startDate = parseTaskDate(task.start_date);
    const endDate = parseTaskDate(task.end_date);

    if (startDate) {
      startDate.setHours(0, 0, 0, 0);
    }
    if (endDate) {
      endDate.setHours(0, 0, 0, 0);
    }

    startDateMsMap.set(task.id, startDate ? startDate.getTime() : null);
    endDateMsMap.set(task.id, endDate ? endDate.getTime() : null);
  }

  // 同義語マップの構築
  let synonymMap: Map<string, string[]> | undefined;
  if (synonymGroups && synonymGroups.length > 0) {
    synonymMap = new Map<string, string[]>();
    for (const group of synonymGroups) {
      const normalizedGroup = group
        .map((word) => word.toLowerCase().trim())
        .filter(Boolean);
      if (normalizedGroup.length === 0) continue;
      for (const word of normalizedGroup) {
        synonymMap.set(word, normalizedGroup);
      }
    }
  }

  return {
    taskMap,
    childrenMap: buildChildrenMap(tasks),
    textLowerMap,
    ownerLabelMap,
    startDateMsMap,
    endDateMsMap,
    synonymMap,
    normalizedSynonymGroups: synonymGroups
      ?.map((group) => group.map((word) => word.toLowerCase().trim()).filter(Boolean))
      .filter((group) => group.length > 0),
  };
}

function expandSearchToken(token: string, indexes: TaskFilterIndexes): string[] {
  const normalizedToken = token.toLowerCase().trim();
  if (!normalizedToken) return [];

  const expansions = new Set<string>([normalizedToken]);
  const directSynonyms = indexes.synonymMap?.get(normalizedToken);
  if (directSynonyms) {
    for (const word of directSynonyms) {
      expansions.add(word);
    }
  }

  for (const group of indexes.normalizedSynonymGroups ?? []) {
    if (group.some((word) => word.includes(normalizedToken) || normalizedToken.includes(word))) {
      for (const word of group) {
        expansions.add(word);
      }
    }
  }

  return Array.from(expansions);
}

/**
 * ボトムアップ方式で各タスクの子孫にマッチするものがあるかを事前計算する
 * 再帰的に子→親へ結果を伝播させ、各タスクIDに対して結果をMapに格納する
 * @param tasks 全タスク配列
 * @param childrenMap buildChildrenMapの結果
 * @param matchFn マッチ判定関数
 * @returns Map<taskId, boolean> (trueなら子孫にマッチあり)
 */
export function buildDescendantMatchMap(
  tasks: Task[],
  childrenMap: Map<number, Task[]>,
  matchFn: (task: Task) => boolean,
): Map<number, boolean> {
  const resultMap = new Map<number, boolean>();

  // 再帰的にチェック（メモ化付き）
  const check = (taskId: number): boolean => {
    if (resultMap.has(taskId)) {
      return resultMap.get(taskId)!;
    }

    const children = childrenMap.get(taskId);
    if (!children || children.length === 0) {
      resultMap.set(taskId, false);
      return false;
    }

    let hasMatch = false;
    for (const child of children) {
      // 子自身がマッチするか
      if (matchFn(child)) {
        hasMatch = true;
        // 早期リターンせず、全子のキャッシュを構築する
      }
      // 子の子孫がマッチするか
      if (check(child.id)) {
        hasMatch = true;
      }
    }

    resultMap.set(taskId, hasMatch);
    return hasMatch;
  };

  // 全タスクについてチェック（メモ化で重複計算回避）
  for (const task of tasks) {
    check(task.id);
  }

  return resultMap;
}

/**
 * 各タスクの先祖にマッチするものがあるかをメモ化計算する
 * 親チェインを1度辿り、結果をキャッシュする
 * @param tasks 全タスク配列
 * @param taskMap Map<taskId, Task>（ID→タスクの高速参照用）
 * @param matchFn マッチ判定関数
 * @returns Map<taskId, boolean> (trueなら先祖にマッチあり)
 */
export function buildAncestorMatchMap(
  tasks: Task[],
  taskMap: Map<number, Task>,
  matchFn: (task: Task) => boolean,
): Map<number, boolean> {
  const resultMap = new Map<number, boolean>();

  // 各タスクについて先祖チェインを辿る（メモ化付き）
  const check = (taskId: number): boolean => {
    if (resultMap.has(taskId)) {
      return resultMap.get(taskId)!;
    }

    const task = taskMap.get(taskId);
    if (!task) {
      resultMap.set(taskId, false);
      return false;
    }

    const parentId = task.parent;
    if (!parentId || parentId === 0) {
      resultMap.set(taskId, false);
      return false;
    }

    const parent = taskMap.get(parentId);
    if (!parent) {
      resultMap.set(taskId, false);
      return false;
    }

    // 親自身がマッチするか、または親の先祖がマッチするか
    const result = matchFn(parent) || check(parentId);
    resultMap.set(taskId, result);
    return result;
  };

  for (const task of tasks) {
    check(task.id);
  }

  return resultMap;
}

/**
 * childrenMapを使った高速ツリー構築（深さ優先順）
 * 各タスクにindent（階層の深さ）を付与する
 * @param tasks フィルタ済みタスク配列
 * @param childrenMap buildChildrenMapの結果
 * @param taskMap Map<taskId, Task>
 * @returns ツリー順にソートされ、indentが付与されたタスク配列
 */
export function buildTreeOrderFromMap(
  tasks: Task[],
  childrenMap: Map<number, Task[]>,
  taskMap: Map<number, Task>,
): Task[] {
  if (tasks.length === 0) return [];

  const result: Task[] = [];
  const visited = new Set<number>();

  const walk = (task: Task, depth: number) => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    result.push({ ...task, indent: depth });

    const children = childrenMap.get(task.id) ?? [];
    for (const child of children) {
      walk(child, depth + 1);
    }
  };

  const rootTasks = childrenMap.get(0) ?? [];
  for (const rootTask of rootTasks) {
    walk(rootTask, 0);
  }

  for (const task of tasks) {
    if (!visited.has(task.id) && (!task.parent || task.parent === 0 || !taskMap.has(task.parent))) {
      walk(task, 0);
    }
  }

  for (const task of tasks) {
    if (!visited.has(task.id)) {
      walk(task, 0);
    }
  }

  return result;
}

function buildDefaultFilter(): TaskFilter {
  return {
    searchText: '',
    searchProject: '',
    showCompleted: true,
    showType: 'all',
    pinnedMode: 'all',
    category: '',
    owner: '',
    periodMode: 'all',
    dateRangeStart: 0,
    dateRangeEnd: 0,
  };
}

function resolveFilterDateBounds(filter: TaskFilter): FilterDateBounds {
  if (filter.periodMode === 'before_today') {
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    return { beforeTodayEndMs: today.getTime() };
  }

  if (filter.periodMode === 'limited') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startBoundary = new Date(today);
    startBoundary.setDate(startBoundary.getDate() + (filter.dateRangeStart || 0));
    const endBoundary = new Date(today);
    endBoundary.setDate(endBoundary.getDate() + (filter.dateRangeEnd || 0));
    return {
      limitedStartMs: startBoundary.getTime(),
      limitedEndMs: endBoundary.getTime(),
    };
  }

  return {};
}

function matchesDirectFilters(
  task: Task,
  filter: TaskFilter,
  indexes: TaskFilterIndexes,
  dateBounds: FilterDateBounds,
): boolean {
  if (!filter.showCompleted && task.progress >= 1) {
    return false;
  }

  if (filter.owner && filter.owner !== '' && indexes.ownerLabelMap.get(task.id) !== filter.owner) {
    return false;
  }

  if (filter.searchText) {
    const searchTokens = filter.searchText
      .toLowerCase()
      .split(/[\s\u3000]+/)
      .map((token) => token.trim())
      .filter(Boolean);
    const taskTextLower = indexes.textLowerMap.get(task.id) ?? '';
    const taskIdStr = String(task.id);

    for (const token of searchTokens) {
      const candidates = expandSearchToken(token, indexes);
      const matched =
        taskIdStr.includes(token) ||
        candidates.some((candidate) => taskTextLower.includes(candidate) || taskIdStr.includes(candidate));
      if (!matched) {
        return false;
      }
    }
  }

  if (filter.showType && filter.showType !== 'all') {
    const targetKind = filter.showType === 'task' ? 1 : 2;
    if (task.kind_task !== targetKind) {
      return false;
    }
  }

  if (filter.pinnedMode === 'pinned' && !task.is_pinned) {
    return false;
  }

  if (filter.pinnedMode === 'unpinned' && task.is_pinned) {
    return false;
  }

  if (filter.periodMode === 'before_today') {
    const taskStartDateMs = indexes.startDateMsMap.get(task.id);
    if (taskStartDateMs != null && dateBounds.beforeTodayEndMs != null && taskStartDateMs > dateBounds.beforeTodayEndMs) {
      return false;
    }
  } else if (filter.periodMode === 'limited') {
    const taskStartDateMs = indexes.startDateMsMap.get(task.id);
    const taskEndDateMs = indexes.endDateMsMap.get(task.id);
    if (taskStartDateMs != null && taskEndDateMs != null) {
      if (
        (dateBounds.limitedStartMs != null && taskEndDateMs < dateBounds.limitedStartMs) ||
        (dateBounds.limitedEndMs != null && taskStartDateMs > dateBounds.limitedEndMs)
      ) {
        return false;
      }
    }
  }

  return true;
}

export function computeVisibleTaskIds(
  tasks: Task[],
  filter?: TaskFilter,
  indexes?: TaskFilterIndexes,
  synonymGroups?: string[][],
): Set<number> {
  if (tasks.length === 0) return new Set();

  const effectiveFilter = { ...buildDefaultFilter(), ...filter };
  const effectiveIndexes = indexes ?? buildTaskFilterIndexes(tasks, synonymGroups);
  const { taskMap, childrenMap, textLowerMap } = effectiveIndexes;
  const dateBounds = resolveFilterDateBounds(effectiveFilter);

  const projectScopeMap = new Map<number, boolean>();
  if (effectiveFilter.searchProject) {
    const searchLower = effectiveFilter.searchProject.toLowerCase();
    const projectMatchFn = (task: Task) =>
      task.kind_task === 2 &&
      (!!textLowerMap.get(task.id)?.includes(searchLower) || String(task.id).includes(searchLower));

    const ancestorProjectMap = buildAncestorMatchMap(tasks, taskMap, projectMatchFn);
    const descendantProjectMap = buildDescendantMatchMap(tasks, childrenMap, projectMatchFn);

    for (const task of tasks) {
      const inProjectScope =
        projectMatchFn(task) ||
        !!ancestorProjectMap.get(task.id) ||
        !!descendantProjectMap.get(task.id);
      projectScopeMap.set(task.id, inProjectScope);
    }
  } else {
    for (const task of tasks) {
      projectScopeMap.set(task.id, true);
    }
  }

  const hasDirectFilter =
    !!effectiveFilter.searchText ||
    !effectiveFilter.showCompleted ||
    !!effectiveFilter.owner ||
    effectiveFilter.showType !== 'all' ||
    effectiveFilter.pinnedMode !== 'all' ||
    effectiveFilter.periodMode !== 'all';
  const keepAncestorContext =
    !!effectiveFilter.searchText ||
    effectiveFilter.pinnedMode !== 'all' ||
    effectiveFilter.periodMode !== 'all';

  const directMatchMap = new Map<number, boolean>();
  for (const task of tasks) {
    const directMatch =
      !!projectScopeMap.get(task.id) &&
      matchesDirectFilters(task, effectiveFilter, effectiveIndexes, dateBounds);
    directMatchMap.set(task.id, directMatch);
  }

  const descendantMatchMap = buildDescendantMatchMap(
    tasks,
    childrenMap,
    (task) => !!directMatchMap.get(task.id),
  );
  const visibleTaskIds = new Set<number>();

  if (!hasDirectFilter && effectiveFilter.searchProject) {
    for (const task of tasks) {
      if (projectScopeMap.get(task.id)) {
        visibleTaskIds.add(task.id);
      }
    }
    return visibleTaskIds;
  }

  for (const task of tasks) {
    if (!projectScopeMap.get(task.id)) {
      continue;
    }

    if (
      directMatchMap.get(task.id) ||
      (keepAncestorContext && descendantMatchMap.get(task.id))
    ) {
      visibleTaskIds.add(task.id);
    }
  }

  return visibleTaskIds;
}

export function computeVisibleTreeTasks(
  tasks: Task[],
  filter?: TaskFilter,
  indexes?: TaskFilterIndexes,
  synonymGroups?: string[][],
): Task[] {
  const effectiveIndexes = indexes ?? buildTaskFilterIndexes(tasks, synonymGroups);
  const visibleTaskIds = computeVisibleTaskIds(tasks, filter, effectiveIndexes, synonymGroups);
  const visibleTasks = tasks.filter((task) => visibleTaskIds.has(task.id));
  const childrenMap = buildChildrenMap(visibleTasks);
  const taskMap = new Map<number, Task>();
  for (const task of visibleTasks) {
    taskMap.set(task.id, task);
  }
  return buildTreeOrderFromMap(visibleTasks, childrenMap, taskMap);
}
