/**
 * DHTMLX Gantt のイベントハンドラ登録
 * Gantt上の操作（更新・削除・並び替え・リンク・Undo/Redo）をバックエンドへ保存する。
 *
 * gantt はアプリ全体で1つのシングルトンなので、登録したハンドラは必ず解除する
 * （解除しないと、画面を切り替えて戻るたびにハンドラが増え、保存APIが多重に呼ばれる）。
 * attachGanttEvents() は解除用の関数を返す。
 */
import { gantt } from 'dhtmlx-gantt';
import type { Link as GanttLink, Task as GanttTask } from 'dhtmlx-gantt';
import type { Link, Task } from '../../types/gantt';
import { reorderTasks } from '../../services/api';
import { formatEditDate } from '../../constants/gantt';
import { stripLeadingNoise } from '../../utils/taskText';
import { confirmPendingAdd, protectPendingAdd, type GanttSyncState } from './ganttSync';
import {
  buildTaskSavePayload,
  getSelectedTaskIds,
  getTaskHierarchyHtml,
  isProjectTask,
  isTaskSelected,
  type GanttId,
} from './ganttTaskUtils';

/** データ変更を親コンポーネント（API呼び出し側）へ伝えるコールバック */
export interface GanttDataCallbacks {
  /** 保存に成功したら true。false の場合、Gantt上の表示はサーバーの値へ戻される */
  onTaskUpdate?: (id: number, task: Partial<Task>) => Promise<boolean>;
  /** 作成されたタスクを返す（失敗時は undefined） */
  onTaskCreate?: (task: Partial<Task>) => Promise<Task | undefined>;
  /** 削除に成功したら true。false の場合、Gantt上にタスクが復元される */
  onTaskDelete?: (id: number) => Promise<boolean>;
  onLinkCreate?: (link: Omit<Link, 'id'>) => Promise<Link | undefined>;
  onLinkUpdate?: (id: number, link: Partial<Link>) => void;
  onLinkDelete?: (id: number) => void;
}

export interface GanttEventDeps {
  /** 常に最新のコールバックを返す */
  getCallbacks: () => GanttDataCallbacks;
  getSyncState: () => GanttSyncState;
  /** 最新の tasks / links で Gantt を同期し直す */
  requestSync: () => void;
  onTaskSelected: (id: GanttId) => void;
  onContextMenu: (taskId: GanttId | null, event: MouseEvent) => void;
}

/** DHTMLXのUndo/Redo履歴に積まれる1操作分のコマンド（value / oldValue は操作対象のコピー） */
interface UndoCommand {
  entity: 'task' | 'link';
  type: 'add' | 'update' | 'remove' | 'move';
  value?: { id?: GanttId };
}

type UndoDirection = 'undo' | 'redo';

function toLinkPayload(link: GanttLink): Omit<Link, 'id'> {
  return {
    source: Number(link.source),
    target: Number(link.target),
    type: Number(link.type) as Link['type'],
  };
}

export function attachGanttEvents(deps: GanttEventDeps): () => void {
  const eventIds: string[] = [];
  const on = (name: string, handler: (...args: never[]) => unknown) => {
    eventIds.push(gantt.attachEvent(name as never, handler as never, undefined as never));
  };

  // --- バックエンドへの保存 ---

  const saveTask = (id: GanttId, task: GanttTask) => {
    const { onTaskUpdate } = deps.getCallbacks();
    const taskId = Number(id);
    if (!onTaskUpdate || Number.isNaN(taskId)) return;

    // タスク名の先頭に混入したインデント(空白)やアイコン(絵文字)を除去する
    if (typeof task.text === 'string') {
      task.text = stripLeadingNoise(task.text);
    }

    const state = deps.getSyncState();
    state.pendingSaves.set(taskId, (state.pendingSaves.get(taskId) ?? 0) + 1);
    onTaskUpdate(taskId, buildTaskSavePayload(task))
      .catch(() => false)
      .then((saved) => {
        // 保存に失敗した場合は、次の同期でサーバーの値に戻す
        if (!saved) state.lastSynced.delete(taskId);
        const remaining = (state.pendingSaves.get(taskId) ?? 1) - 1;
        if (remaining > 0) {
          state.pendingSaves.set(taskId, remaining);
        } else {
          state.pendingSaves.delete(taskId);
        }
        deps.requestSync();
      });
  };

  // 削除APIの応答待ち（タスクID → 完了を待つPromise）。直後のUndoによる再作成はこれを待ってから行う
  const deletesInFlight = new Map<number, Promise<void>>();

  const deleteTaskOnServer = (id: GanttId) => {
    const { onTaskDelete } = deps.getCallbacks();
    const taskId = Number(id);
    if (!onTaskDelete || Number.isNaN(taskId)) return;

    const state = deps.getSyncState();
    state.pendingDeletes.add(taskId);
    const settled = onTaskDelete(taskId)
      .catch(() => false)
      .then((deleted) => {
        // 削除に失敗した場合は、次の同期でタスクを復元する
        if (!deleted) state.pendingDeletes.delete(taskId);
        if (deletesInFlight.get(taskId) === settled) deletesInFlight.delete(taskId);
        deps.requestSync();
      });
    deletesInFlight.set(taskId, settled);
  };

  /**
   * Undo/Redo でGantt上に復活したタスクを、同じIDのままバックエンドに作り直す
   * （IDを保つことで、子タスクの親参照やリンクがそのまま有効になる）。
   */
  const restoreTaskOnServer = (id: GanttId) => {
    const { onTaskCreate } = deps.getCallbacks();
    const taskId = Number(id);
    if (!onTaskCreate || Number.isNaN(taskId)) return;

    const state = deps.getSyncState();
    protectPendingAdd(state.pendingTaskAdds, id);
    (deletesInFlight.get(taskId) ?? Promise.resolve())
      .then(() => {
        if (!gantt.isTaskExists(id)) return undefined;
        state.pendingDeletes.delete(taskId);
        return onTaskCreate({ ...buildTaskSavePayload(gantt.getTask(id)), id: taskId });
      })
      .catch(() => undefined)
      .then((createdTask) => {
        if (createdTask) {
          // 作成後の再取得結果が画面に届くまでの間、古いデータでの同期に消されないよう保護を続ける
          confirmPendingAdd(state.pendingTaskAdds, id);
        } else {
          // 作り直せなかった場合は保護を外し、次の同期でサーバーの状態（タスク無し）に合わせる
          state.pendingTaskAdds.delete(String(id));
        }
        deps.requestSync();
      });
  };

  /** Gantt上で引かれたリンクをバックエンドに作成し、採番されたIDへ付け替える */
  const createLinkOnServer = (ganttId: GanttId, link: GanttLink) => {
    const { onLinkCreate } = deps.getCallbacks();
    if (!onLinkCreate) return;

    const state = deps.getSyncState();
    protectPendingAdd(state.pendingLinkAdds, ganttId);
    onLinkCreate(toLinkPayload(link))
      .catch(() => undefined)
      .then((createdLink) => {
        state.pendingLinkAdds.delete(String(ganttId));
        if (createdLink?.id && gantt.isLinkExists(ganttId)) {
          if (String(ganttId) !== String(createdLink.id)) {
            gantt.changeLinkId(ganttId, createdLink.id);
          }
          confirmPendingAdd(state.pendingLinkAdds, createdLink.id);
        }
        deps.requestSync();
      });
  };

  // --- タスク ---

  // 読み込んだタスクはすべて開いた状態にする
  on('onTaskLoading', (task: GanttTask) => {
    task.$open = true;
    return true;
  });

  // gantt.createTask() で作られるタスクの初期値
  on('onTaskCreated', (task: GanttTask) => {
    const today = new Date();
    task.duration = 1;
    task.start_date = today;
    task.edit_date = formatEditDate(today);
    task.kind_task = '1';
    task.owner_id = 0;
    return true;
  });

  // Gantt上で削除されたタスクをバックエンドからも削除する（子孫はバックエンド側でまとめて削除される）
  on('onBeforeTaskDelete', (id: GanttId) => {
    if (!deps.getSyncState().isSyncing) {
      deleteTaskOnServer(id);
    }
    return true; // DHTMLXにデフォルトの削除処理（UI更新など）を続行させる
  });

  // タスク更新時に edit_date（編集日の履歴）へ今日を追記し、バックエンドに保存する
  on('onAfterTaskUpdate', (id: GanttId, task: GanttTask) => {
    if (deps.getSyncState().isSyncing) return true;

    const todayStr = formatEditDate(new Date());
    if (task.edit_date) {
      if (!String(task.edit_date).split(',').includes(todayStr)) {
        task.edit_date = `${task.edit_date},${todayStr}`;
      }
    } else {
      task.edit_date = todayStr;
    }

    saveTask(id, task);
    return true;
  });

  on('onTaskSelected', (id: GanttId) => {
    deps.onTaskSelected(id);
    return true;
  });

  // --- リンク ---

  on('onAfterLinkAdd', (id: GanttId, link: GanttLink) => {
    if (deps.getSyncState().isSyncing) return;
    createLinkOnServer(id, link);
  });

  on('onAfterLinkUpdate', (id: GanttId, link: GanttLink) => {
    if (deps.getSyncState().isSyncing) return;
    deps.getCallbacks().onLinkUpdate?.(Number(id), toLinkPayload(link));
  });

  on('onAfterLinkDelete', (id: GanttId) => {
    if (deps.getSyncState().isSyncing) return;
    deps.getCallbacks().onLinkDelete?.(Number(id));
  });

  // --- Undo/Redo ---
  // Undo/Redo による更新・削除・並び替え・リンク操作は、DHTMLXが通常の操作と同じイベント
  // （onAfterTaskUpdate / onBeforeTaskDelete / onAfterTaskMove / onAfterLink*）を発火するので、
  // 上のハンドラでそのまま保存される。
  // タスクの「復活」（削除のUndo、追加のRedo）だけは対応するイベントが無いため、ここで保存する。
  const handleUndoRedo = (direction: UndoDirection) => (action: { commands?: UndoCommand[] } | null) => {
    const restoringType = direction === 'undo' ? 'remove' : 'add';
    for (const command of action?.commands ?? []) {
      const id = command.value?.id;
      if (command.entity === 'task' && command.type === restoringType && id != null && gantt.isTaskExists(id)) {
        restoreTaskOnServer(id);
      }
    }
  };
  on('onAfterUndo', handleUndoRedo('undo'));
  on('onAfterRedo', handleUndoRedo('redo'));

  // --- 行のドラッグ&ドロップ（並び替え） ---

  // order_branch_free=true でも、折りたたんだプロジェクトには兄弟としてしかドロップできない。
  // 直前の行が閉じたプロジェクトの場合は、その子として配置し直してプロジェクトを開く
  on('onBeforeRowDragEnd', (id: GanttId) => {
    try {
      const globalIndex = gantt.getGlobalTaskIndex(id);
      const previousRow = globalIndex > 0 ? gantt.getTaskByIndex(globalIndex - 1) : null;
      if (previousRow && gantt.isTaskExists(previousRow.id)) {
        const previousTask = gantt.getTask(previousRow.id);
        const isDroppedAsSibling = String(gantt.getTask(id).parent) !== String(previousTask.id);
        if (isProjectTask(previousTask) && !previousTask.$open && isDroppedAsSibling) {
          gantt.moveTask(id, gantt.getChildren(previousTask.id).length, previousTask.id);
          previousTask.$open = true;
          previousTask.open = true;
          gantt.render();
        }
      }
    } catch {
      // タスクが見つからない場合は無視
    }
    return true;
  });

  // 並び替え後、移動先の親に属する全兄弟の並び順（と親）をまとめて保存する
  let isMovingSelection = false;
  on('onAfterTaskMove', (id: GanttId, parent: GanttId, tindex: number) => {
    if (isMovingSelection) return true;

    // 複数選択中のタスクをドラッグした場合は、残りの選択タスクも直後に並べる
    const selectedTasks = getSelectedTaskIds();
    if (selectedTasks.length > 1 && isTaskSelected(id)) {
      isMovingSelection = true;
      let offset = 1;
      for (const selectedId of selectedTasks) {
        if (String(selectedId) !== String(id)) {
          gantt.moveTask(selectedId, tindex + offset, parent);
          offset++;
        }
      }
      isMovingSelection = false;
    }

    const items = gantt.getChildren(parent).map((childId, index) => ({
      id: Number(childId),
      sortorder: index,
      parent: Number(parent),
    }));
    void reorderTasks({ items });

    return true;
  });

  // --- Lightbox ---

  on('onBeforeLightbox', (id: GanttId) => {
    gantt.getTask(id).hierarchy_path = getTaskHierarchyHtml(id);
    return true;
  });

  // Lightboxを開いたらタスク名の入力欄にフォーカスする
  on('onLightbox', () => {
    setTimeout(() => {
      document.querySelector<HTMLTextAreaElement>('.gantt_cal_ltext textarea')?.focus();
    }, 0);
  });

  // --- コンテキストメニュー ---

  on('onContextMenu', (taskId: GanttId | null, _linkId: GanttId | null, event: MouseEvent) => {
    event.preventDefault();
    deps.onContextMenu(taskId, event);
    return false;
  });

  return () => {
    for (const eventId of eventIds) {
      gantt.detachEvent(eventId);
    }
  };
}
