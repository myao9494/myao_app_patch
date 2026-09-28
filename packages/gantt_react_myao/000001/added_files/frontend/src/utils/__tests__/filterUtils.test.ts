/**
 * @vitest-environment jsdom
 * フィルタユーティリティ関数のテスト
 * 事前計算によるO(n)フィルタリングの正当性を検証する
 */
import { describe, it, expect } from 'vitest';
import type { Task } from '../../types/gantt';
import {
  buildChildrenMap,
  buildDescendantMatchMap,
  buildAncestorMatchMap,
  buildTreeOrderFromMap,
  computeVisibleTaskIds,
  computeVisibleTreeTasks,
} from '../filterUtils';

// テスト用のタスク生成ヘルパー
function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 0,
    text: '',
    start_date: '2026-01-01 00:00:00',
    end_date: '2026-01-02 00:00:00',
    duration: 1,
    progress: 0,
    parent: 0,
    kind_task: 1,
    owner_id: 0,
    sortorder: 0,
    ...overrides,
  };
}

/**
 * テスト用ツリー構造:
 *
 *   Project A (id:1, parent:0, kind:2)
 *   ├── Task B (id:2, parent:1, kind:1)
 *   ├── Project C (id:3, parent:1, kind:2)
 *   │   └── Task D (id:4, parent:3, kind:1)
 *   └── Task E (id:5, parent:1, kind:1)
 *   Task F (id:6, parent:0, kind:1)
 */
const sampleTasks: Task[] = [
  makeTask({ id: 1, text: 'Project A', parent: 0, kind_task: 2, sortorder: 1 }),
  makeTask({ id: 2, text: 'Task B', parent: 1, kind_task: 1, sortorder: 1 }),
  makeTask({ id: 3, text: 'Project C', parent: 1, kind_task: 2, sortorder: 2 }),
  makeTask({ id: 4, text: 'Task D', parent: 3, kind_task: 1, sortorder: 1 }),
  makeTask({ id: 5, text: 'Task E', parent: 1, kind_task: 1, sortorder: 3 }),
  makeTask({ id: 6, text: 'Task F', parent: 0, kind_task: 1, sortorder: 2 }),
];

describe('buildChildrenMap', () => {
  it('親ID→子タスク配列のMapを正しく構築すること', () => {
    const map = buildChildrenMap(sampleTasks);

    // ルート（parent=0）の子
    const rootChildren = map.get(0);
    expect(rootChildren).toBeDefined();
    expect(rootChildren!.map(t => t.id)).toEqual([1, 6]);

    // Project A (id:1) の子
    const projectAChildren = map.get(1);
    expect(projectAChildren).toBeDefined();
    expect(projectAChildren!.map(t => t.id)).toEqual([2, 3, 5]);

    // Project C (id:3) の子
    const projectCChildren = map.get(3);
    expect(projectCChildren).toBeDefined();
    expect(projectCChildren!.map(t => t.id)).toEqual([4]);

    // リーフタスクには子がない
    expect(map.has(2)).toBe(false);
    expect(map.has(4)).toBe(false);
  });

  it('空配列の場合、空Mapを返すこと', () => {
    const map = buildChildrenMap([]);
    expect(map.size).toBe(0);
  });
});

describe('buildDescendantMatchMap', () => {
  it('子孫にマッチするタスクがある場合、trueを返すこと', () => {
    const childrenMap = buildChildrenMap(sampleTasks);
    // "Task D" にマッチする条件
    const matchFn = (t: Task) => t.text.includes('Task D');
    const map = buildDescendantMatchMap(sampleTasks, childrenMap, matchFn);

    // Project C (id:3) は Task D を子に持つ → true
    expect(map.get(3)).toBe(true);
    // Project A (id:1) は Project C を子に持ち、その中に Task D がある → true
    expect(map.get(1)).toBe(true);
    // Task D 自身は子孫ではなく自分なので false
    expect(map.get(4)).toBeFalsy();
    // Task B, Task E, Task F は無関係 → false/undefined
    expect(map.get(2)).toBeFalsy();
    expect(map.get(5)).toBeFalsy();
    expect(map.get(6)).toBeFalsy();
  });

  it('マッチするタスクがない場合、全てfalsy', () => {
    const childrenMap = buildChildrenMap(sampleTasks);
    const matchFn = (_t: Task) => false;
    const map = buildDescendantMatchMap(sampleTasks, childrenMap, matchFn);

    for (const task of sampleTasks) {
      expect(map.get(task.id)).toBeFalsy();
    }
  });

  it('リーフタスクのみの場合、全てfalsy', () => {
    const leafTasks = [
      makeTask({ id: 10, text: 'Leaf 1', parent: 0 }),
      makeTask({ id: 11, text: 'Leaf 2', parent: 0 }),
    ];
    const childrenMap = buildChildrenMap(leafTasks);
    const matchFn = (t: Task) => t.text.includes('Leaf');
    const map = buildDescendantMatchMap(leafTasks, childrenMap, matchFn);

    expect(map.get(10)).toBeFalsy();
    expect(map.get(11)).toBeFalsy();
  });
});

describe('buildAncestorMatchMap', () => {
  it('先祖にマッチするタスクがある場合、trueを返すこと', () => {
    const taskMap = new Map(sampleTasks.map(t => [t.id, t]));
    // "Project A" にマッチする条件
    const matchFn = (t: Task) => t.kind_task === 2 && t.text.includes('Project A');
    const map = buildAncestorMatchMap(sampleTasks, taskMap, matchFn);

    // Task B (id:2) の先祖に Project A がある → true
    expect(map.get(2)).toBe(true);
    // Project C (id:3) の先祖に Project A がある → true
    expect(map.get(3)).toBe(true);
    // Task D (id:4) の先祖に Project C → Project A がある → true
    expect(map.get(4)).toBe(true);
    // Task E (id:5) の先祖に Project A がある → true
    expect(map.get(5)).toBe(true);
    // Project A 自身は先祖ではない → false
    expect(map.get(1)).toBeFalsy();
    // Task F (id:6) はルート直下 → false
    expect(map.get(6)).toBeFalsy();
  });

  it('マッチする先祖がない場合、全てfalsy', () => {
    const taskMap = new Map(sampleTasks.map(t => [t.id, t]));
    const matchFn = (_t: Task) => false;
    const map = buildAncestorMatchMap(sampleTasks, taskMap, matchFn);

    for (const task of sampleTasks) {
      expect(map.get(task.id)).toBeFalsy();
    }
  });

  it('メモ化が正しく動作すること（同じ先祖チェインを重複走査しない）', () => {
    const taskMap = new Map(sampleTasks.map(t => [t.id, t]));
    let callCount = 0;
    const matchFn = (t: Task) => {
      callCount++;
      return t.kind_task === 2 && t.text.includes('Project A');
    };

    buildAncestorMatchMap(sampleTasks, taskMap, matchFn);

    // メモ化により、各ユニークな先祖ノードは1回だけcheckされる
    // Project A(1), Project C(3) の2つの先祖候補 + Task B,D,E,F は直接の親チェック程度
    // 最大でもタスク数以下のコール数になるはず
    expect(callCount).toBeLessThanOrEqual(sampleTasks.length);
  });
});

describe('buildTreeOrderFromMap', () => {
  it('ツリー順（深さ優先）でソートされたタスク配列を返すこと', () => {
    const childrenMap = buildChildrenMap(sampleTasks);
    const taskMap = new Map(sampleTasks.map(t => [t.id, t]));
    const result = buildTreeOrderFromMap(sampleTasks, childrenMap, taskMap);
    const ids = result.map(t => t.id);

    // 期待される深さ優先順:
    // Project A(1) → Task B(2) → Project C(3) → Task D(4) → Task E(5) → Task F(6)
    expect(ids).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('indentが正しく設定されること', () => {
    const childrenMap = buildChildrenMap(sampleTasks);
    const taskMap = new Map(sampleTasks.map(t => [t.id, t]));
    const result = buildTreeOrderFromMap(sampleTasks, childrenMap, taskMap);

    // Project A: depth 0
    expect(result.find(t => t.id === 1)?.indent).toBe(0);
    // Task B: depth 1
    expect(result.find(t => t.id === 2)?.indent).toBe(1);
    // Project C: depth 1
    expect(result.find(t => t.id === 3)?.indent).toBe(1);
    // Task D: depth 2
    expect(result.find(t => t.id === 4)?.indent).toBe(2);
    // Task E: depth 1
    expect(result.find(t => t.id === 5)?.indent).toBe(1);
    // Task F: depth 0
    expect(result.find(t => t.id === 6)?.indent).toBe(0);
  });

  it('孤児タスク（親がフィルタで除外された場合）は末尾に追加されること', () => {
    // id:3の親(id:1)が存在しないリスト
    const partialTasks = [
      makeTask({ id: 3, text: 'Project C', parent: 1, kind_task: 2, sortorder: 1 }),
      makeTask({ id: 4, text: 'Task D', parent: 3, kind_task: 1, sortorder: 1 }),
      makeTask({ id: 6, text: 'Task F', parent: 0, kind_task: 1, sortorder: 1 }),
    ];
    const childrenMap = buildChildrenMap(partialTasks);
    const taskMap = new Map(partialTasks.map(t => [t.id, t]));
    const result = buildTreeOrderFromMap(partialTasks, childrenMap, taskMap);
    const ids = result.map(t => t.id);

    // Task F はルート直下なので先に来る
    // Project C と Task D は孤児として末尾に追加
    expect(ids[0]).toBe(6);
    expect(ids).toContain(3);
    expect(ids).toContain(4);
  });

  it('sortorderに基づいて兄弟がソートされること', () => {
    const tasks = [
      makeTask({ id: 1, text: 'C', parent: 0, sortorder: 3 }),
      makeTask({ id: 2, text: 'A', parent: 0, sortorder: 1 }),
      makeTask({ id: 3, text: 'B', parent: 0, sortorder: 2 }),
    ];
    const childrenMap = buildChildrenMap(tasks);
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const result = buildTreeOrderFromMap(tasks, childrenMap, taskMap);
    const ids = result.map(t => t.id);

    expect(ids).toEqual([2, 3, 1]); // sortorder 1, 2, 3
  });

  it('空配列の場合、空配列を返すこと', () => {
    const childrenMap = buildChildrenMap([]);
    const result = buildTreeOrderFromMap([], childrenMap, new Map());
    expect(result).toEqual([]);
  });
});

describe('computeVisibleTaskIds', () => {
  it('showType=task では task だけを表示すること', () => {
    const visibleIds = computeVisibleTaskIds(sampleTasks, {
      showCompleted: true,
      showType: 'task',
      periodMode: 'all',
    });

    expect([...visibleIds].sort((a, b) => a - b)).toEqual([2, 4, 5, 6]);
  });

  it('searchProject 配下に絞りつつ祖先コンテキストを残すこと', () => {
    const visibleIds = computeVisibleTaskIds(sampleTasks, {
      showCompleted: true,
      showType: 'all',
      periodMode: 'all',
      searchProject: 'Project C',
    });

    expect([...visibleIds].sort((a, b) => a - b)).toEqual([1, 3, 4]);
  });

  it('searchProject にプロジェクトIDの番号を指定した場合でも検索に引っかかること', () => {
    const visibleIds = computeVisibleTaskIds(sampleTasks, {
      showCompleted: true,
      showType: 'all',
      periodMode: 'all',
      searchProject: '3', // Project C の id: 3
    });

    // Project C (id:3), その子 Task D (id:4), 祖先 Project A (id:1)
    expect([...visibleIds].sort((a, b) => a - b)).toEqual([1, 3, 4]);
  });

  it('searchText にタスクIDの番号を指定した場合でも検索に引っかかること', () => {
    const visibleIds = computeVisibleTaskIds(sampleTasks, {
      showCompleted: true,
      showType: 'all',
      periodMode: 'all',
      searchText: '4', // Task D の id: 4
    });

    // Task D (id:4) とその祖先 Project C (id:3), Project A (id:1)
    expect([...visibleIds].sort((a, b) => a - b)).toEqual([1, 3, 4]);
  });

  it('searchText にルートタスクIDの番号を指定した場合に該当タスクが表示されること', () => {
    const visibleIds = computeVisibleTaskIds(sampleTasks, {
      showCompleted: true,
      showType: 'all',
      periodMode: 'all',
      searchText: '6', // Task F の id: 6
    });

    expect([...visibleIds].sort((a, b) => a - b)).toEqual([6]);
  });

  it('pinnedMode=pinned では固定タスクだけを表示すること', () => {
    const pinnedTasks = [
      makeTask({ id: 1, text: 'Pinned Task', is_pinned: true }),
      makeTask({ id: 2, text: 'Normal Task', is_pinned: false }),
      makeTask({ id: 3, text: 'Also Pinned', is_pinned: true }),
    ];

    const visibleIds = computeVisibleTaskIds(pinnedTasks, {
      showCompleted: true,
      showType: 'all',
      pinnedMode: 'pinned',
      periodMode: 'all',
    });

    expect([...visibleIds].sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it('pinnedMode=pinned では固定タスクの祖先も表示すること', () => {
    const pinnedTasks = [
      makeTask({ id: 1, text: 'Project A', parent: 0, kind_task: 2, is_pinned: false }),
      makeTask({ id: 2, text: 'Pinned Child', parent: 1, is_pinned: true }),
      makeTask({ id: 3, text: 'Normal Child', parent: 1, is_pinned: false }),
    ];

    const visibleIds = computeVisibleTaskIds(pinnedTasks, {
      showCompleted: true,
      showType: 'all',
      pinnedMode: 'pinned',
      periodMode: 'all',
    });

    expect([...visibleIds].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('pinnedMode=unpinned では非固定タスクだけを表示すること', () => {
    const pinnedTasks = [
      makeTask({ id: 1, text: 'Pinned Task', is_pinned: true }),
      makeTask({ id: 2, text: 'Normal Task' }),
      makeTask({ id: 3, text: 'Also Pinned', is_pinned: true }),
    ];

    const visibleIds = computeVisibleTaskIds(pinnedTasks, {
      showCompleted: true,
      showType: 'all',
      pinnedMode: 'unpinned',
      periodMode: 'all',
    });

    expect([...visibleIds].sort((a, b) => a - b)).toEqual([2]);
  });

  it('searchText では一致ノードとその祖先だけを表示すること', () => {
    const visibleIds = computeVisibleTaskIds(sampleTasks, {
      showCompleted: true,
      showType: 'all',
      periodMode: 'all',
      searchText: 'Project A',
    });

    expect([...visibleIds].sort((a, b) => a - b)).toEqual([1]);
  });

  it('期間外の子しか持たない親は表示しないこと', () => {
    const today = new Date();
    const toDateString = (offsetDays: number) => {
      const date = new Date(today);
      date.setDate(date.getDate() + offsetDays);
      const yyyy = date.getFullYear();
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const dd = String(date.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd} 00:00:00`;
    };

    const datedTasks: Task[] = [
      makeTask({ id: 1, text: 'Project A', parent: 0, kind_task: 2, start_date: toDateString(-10), end_date: toDateString(-9) }),
      makeTask({ id: 2, text: 'Future Task', parent: 1, start_date: toDateString(10), end_date: toDateString(11) }),
      makeTask({ id: 3, text: 'Current Task', parent: 1, start_date: toDateString(0), end_date: toDateString(1) }),
    ];

    const visibleIds = computeVisibleTaskIds(datedTasks, {
      showCompleted: true,
      showType: 'all',
      periodMode: 'limited',
      dateRangeStart: -1,
      dateRangeEnd: 1,
    });

    expect([...visibleIds].sort((a, b) => a - b)).toEqual([1, 3]);
  });
});

describe('computeVisibleTreeTasks', () => {
  it('フィルター後もツリー順とindentを保つこと', () => {
    const result = computeVisibleTreeTasks(sampleTasks, {
      showCompleted: true,
      showType: 'all',
      periodMode: 'all',
      searchText: 'Task D',
    });

    expect(result.map((task) => task.id)).toEqual([1, 3, 4]);
    expect(result.find((task) => task.id === 1)?.indent).toBe(0);
    expect(result.find((task) => task.id === 3)?.indent).toBe(1);
    expect(result.find((task) => task.id === 4)?.indent).toBe(2);
  });
});

describe('synonym search', () => {
  it('同義語グループに含まれる単語で検索した際、グループ内の他の単語を含むタスクも表示すること', () => {
    const tasks: Task[] = [
      makeTask({ id: 1, text: 'PCのセットアップ' }),
      makeTask({ id: 2, text: 'パソコンの購入' }),
      makeTask({ id: 3, text: '会議' }),
    ];
    
    // 同義語グループ: PC, パソコン
    const synonymGroups = [['PC', 'パソコン']];
    
    // PCで検索 -> PC(id:1) と パソコン(id:2) がヒットするはず
    const visibleIds = computeVisibleTaskIds(tasks, {
      searchText: 'PC',
      showCompleted: true,
      showType: 'all',
      periodMode: 'all',
    }, undefined, synonymGroups);

    expect(visibleIds.has(1)).toBe(true);
    expect(visibleIds.has(2)).toBe(true);
    expect(visibleIds.has(3)).toBe(false);
  });

  it('複数語検索でも各語に対して同義語展開されること', () => {
    const tasks: Task[] = [
      makeTask({ id: 1, text: 'パソコンの購入メモ' }),
      makeTask({ id: 2, text: 'PCのセットアップ' }),
      makeTask({ id: 3, text: 'スマホの購入' }),
    ];

    const visibleIds = computeVisibleTaskIds(tasks, {
      searchText: 'PC 購入',
      showCompleted: true,
      showType: 'all',
      periodMode: 'all',
    }, undefined, [['PC', 'パソコン']]);

    expect(visibleIds.has(1)).toBe(true);
    expect(visibleIds.has(2)).toBe(false);
    expect(visibleIds.has(3)).toBe(false);
  });

  it('部分一致クエリでも同義語候補に展開されること', () => {
    const tasks: Task[] = [
      makeTask({ id: 1, text: 'パソコンの購入' }),
      makeTask({ id: 2, text: '会議メモ' }),
    ];

    const visibleIds = computeVisibleTaskIds(tasks, {
      searchText: 'pcの',
      showCompleted: true,
      showType: 'all',
      periodMode: 'all',
    }, undefined, [['PC', 'パソコン']]);

    expect(visibleIds.has(1)).toBe(true);
    expect(visibleIds.has(2)).toBe(false);
  });
});
