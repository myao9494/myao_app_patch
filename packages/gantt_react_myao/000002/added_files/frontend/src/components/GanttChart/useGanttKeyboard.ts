/**
 * ガントチャートのキーボードショートカット
 *
 * Lightbox（タスク編集）表示中:
 *   Enter 保存 / Shift+Enter 改行 / Tab・Shift+Tab 入力欄の移動 / Esc キャンセル（DHTMLX標準）
 * チャート上:
 *   Ctrl(Cmd)+Z 元に戻す / Ctrl(Cmd)+Shift+Z・Ctrl(Cmd)+Y やり直し
 *   ↑↓ 選択の移動 / Shift+↑↓ 複数選択 / Ctrl(Cmd)+↑↓ フォーカスのみ移動 / Ctrl(Cmd)+Enter フォーカス行の選択切替
 *   Enter 編集 / Delete・Backspace 選択タスクの削除
 *   A タスク追加 / S マウス位置のタスク・日付にスケジュール追加 / O Obsidianノート作成
 *   Ctrl(Cmd)+C コピー / Ctrl(Cmd)+V 選択タスクの後ろへ貼り付け
 */
import { useEffect, type RefObject } from 'react';
import { gantt } from 'dhtmlx-gantt';
import type { Task } from '../../types/gantt';
import type { TimelineShortcutContext } from '../../utils/ganttTimelineShortcut';
import {
  addTaskToGantt,
  getSelectedTaskIds,
  indexAfterTask,
  isProjectTask,
  isTaskSelected,
  type GanttId,
} from './ganttTaskUtils';

const COPIED_TASK_IDS_KEY = 'gantt_copied_task_ids';
// 複数ID対応前の保存形式（単一ID）。読み取りのみ対応する
const LEGACY_COPIED_TASK_ID_KEY = 'gantt_copied_task_id';
const LIGHTBOX_SAVE_BUTTON_SELECTOR = '.gantt_btn_set.gantt_save_btn_set';
const LIGHTBOX_INPUT_SELECTOR = '.gantt_cal_light textarea';

/** キーボード操作の起点となる「現在の行」 */
export interface KeyboardCursor {
  /** 最後に選択、またはフォーカス移動した行のタスクID */
  taskId: GanttId | null;
  /** true の間は Ctrl(Cmd)+矢印キーによるフォーカス移動中（選択は変えず、フォーカス行を強調表示する） */
  isFocusMode: boolean;
}

export interface GanttKeyboardActions {
  addChildTask: (parentId: number, insertAfterSortOrder?: number) => Promise<Task | undefined>;
  addRootTask: (insertAfterSortOrder?: number) => Promise<Task | undefined>;
  cloneTask: (taskId: number, targetId?: number) => Promise<Task | undefined>;
  createObsidianNote: (taskId: number) => void;
  openScheduleModal: (taskId: number, date: Date) => void;
  /** マウスが指しているタイムライン上のタスクと日付（タイムライン外なら null） */
  getTimelinePointerTarget: () => TimelineShortcutContext | null;
  scrollTaskIntoView: (taskId: GanttId) => void;
}

function isTypingTarget(element: Element | null, extraTags: string[] = []): boolean {
  const tag = element?.tagName.toLowerCase() ?? '';
  return ['input', 'textarea', ...extraTags].includes(tag);
}

/**
 * Lightbox表示中のキー操作。
 * DHTMLX標準では Enter で改行できないため、Enter=保存 / Shift+Enter=改行 に割り当て直す。
 */
export function handleLightboxKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.isComposing) {
    if (event.shiftKey) {
      // テキストエリア内での改行を許可し、DHTMLX標準の「Enterで保存」は止める
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    document.querySelector<HTMLElement>(LIGHTBOX_SAVE_BUTTON_SELECTOR)?.click();
    return;
  }

  if (event.key === 'Tab') {
    const inputs = Array.from(document.querySelectorAll<HTMLTextAreaElement>(LIGHTBOX_INPUT_SELECTOR));
    if (inputs.length === 0) return;

    event.preventDefault();
    event.stopPropagation();
    const currentIndex = inputs.indexOf(document.activeElement as HTMLTextAreaElement);
    const step = event.shiftKey ? -1 : 1;
    const nextIndex = currentIndex === -1
      ? (event.shiftKey ? inputs.length - 1 : 0)
      : (currentIndex + step + inputs.length) % inputs.length;
    inputs[nextIndex].focus();
  }
  // Esc はDHTMLX標準のキャンセル処理に任せる
}

function readCopiedTaskIds(): number[] {
  const stored = sessionStorage.getItem(COPIED_TASK_IDS_KEY);
  let ids: unknown[] = [];
  if (stored) {
    try {
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed)) ids = parsed;
    } catch {
      // 壊れた値は無視する
    }
  } else {
    const legacyId = sessionStorage.getItem(LEGACY_COPIED_TASK_ID_KEY);
    if (legacyId) ids = [legacyId];
  }
  return ids.map(Number).filter((id) => !Number.isNaN(id));
}

function clearSelection(): void {
  gantt.unselectTask();
  for (const taskId of getSelectedTaskIds()) {
    gantt.unselectTask(taskId);
  }
}

export function useGanttKeyboard(
  cursorRef: RefObject<KeyboardCursor>,
  actionsRef: RefObject<GanttKeyboardActions>,
): void {
  useEffect(() => {
    const currentTaskId = (): GanttId | null => cursorRef.current.taskId || gantt.getSelectedId();

    /** Ctrl(Cmd)+Z: 元に戻す / Ctrl(Cmd)+Shift+Z・Ctrl(Cmd)+Y: やり直し */
    const handleUndoRedo = (event: KeyboardEvent) => {
      event.preventDefault();
      if (event.key.toLowerCase() === 'y' || event.shiftKey) {
        gantt.redo();
      } else {
        gantt.undo();
      }
    };

    /** Enter: 編集画面を開く / Ctrl(Cmd)+Enter: フォーカス行の選択を切り替える */
    const handleEnter = (event: KeyboardEvent, modifierPressed: boolean) => {
      // Lightbox以外のモーダルや入力欄でのEnterを、ガント上のEnterと誤認しない
      if (isTypingTarget(document.activeElement, ['button', 'select'])) return;

      const activeId = currentTaskId();
      if (!activeId) return;

      event.preventDefault();
      if (modifierPressed) {
        if (isTaskSelected(activeId)) {
          gantt.unselectTask(activeId);
        } else {
          gantt.selectTask(activeId);
        }
        gantt.render();
        return;
      }

      cursorRef.current.isFocusMode = false;
      gantt.showLightbox(activeId);
    };

    /** Delete / Backspace: 選択中のタスクをまとめて削除し、その上の行を選択する */
    const handleDelete = (event: KeyboardEvent) => {
      if (isTypingTarget(document.activeElement)) return;

      const selectedTasks = getSelectedTaskIds();
      if (selectedTasks.length === 0) return;

      event.preventDefault();
      if (!window.confirm(`選択された ${selectedTasks.length} 件のタスクを削除しますか？`)) return;

      // 選択の中で最も上に表示されている行の、1つ上の行を覚えておく
      const topMostTaskId = selectedTasks.reduce((top, id) =>
        gantt.getGlobalTaskIndex(id) < gantt.getGlobalTaskIndex(top) ? id : top
      );
      const previousId = gantt.getPrev(topMostTaskId);

      for (const taskId of [...selectedTasks]) {
        // 親と一緒に既に削除されている場合がある
        if (gantt.isTaskExists(taskId)) {
          gantt.deleteTask(taskId);
        }
      }

      if (previousId && gantt.isTaskExists(previousId)) {
        gantt.selectTask(previousId);
        cursorRef.current.taskId = previousId;
      } else {
        cursorRef.current.taskId = null;
      }
    };

    /** ↑↓: 選択の移動 / Shift+↑↓: 複数選択の伸縮 / Ctrl(Cmd)+↑↓: フォーカスのみ移動 */
    const handleArrow = (event: KeyboardEvent, modifierPressed: boolean) => {
      const activeId = currentTaskId();
      if (!activeId) return;

      event.preventDefault();
      const nextId = event.key === 'ArrowUp' ? gantt.getPrev(activeId) : gantt.getNext(activeId);
      if (!nextId) return;

      const cursor = cursorRef.current;
      if (event.shiftKey) {
        if (isTaskSelected(nextId)) {
          // 選択範囲を縮める：現在の行の選択を解除して戻る
          gantt.unselectTask(activeId);
        } else {
          gantt.selectTask(nextId);
        }
      } else if (modifierPressed) {
        cursor.isFocusMode = true;
      } else {
        for (const taskId of getSelectedTaskIds()) {
          gantt.unselectTask(taskId);
        }
        cursor.isFocusMode = false;
        gantt.selectTask(nextId);
      }
      cursor.taskId = nextId;
      if (cursor.isFocusMode) {
        gantt.render(); // フォーカス行の強調表示を更新する
      }
      actionsRef.current.scrollTaskIntoView(nextId);
    };

    /**
     * A: タスクを追加してすぐ編集画面を開く。
     * 現在の行がプロジェクトならその子として、タスクならその直下（同じ親）に追加する。
     */
    const handleAddTask = async (event: KeyboardEvent) => {
      if (isTypingTarget(document.activeElement)) return;

      const activeId = currentTaskId();
      if (!activeId || !gantt.isTaskExists(activeId)) return;

      event.preventDefault();
      const task = gantt.getTask(activeId);
      const parentId = task.parent ? Number(task.parent) : 0;
      const actions = actionsRef.current;

      let createdTask: Task | undefined;
      if (isProjectTask(task)) {
        createdTask = await actions.addChildTask(Number(activeId));
      } else if (parentId === 0) {
        createdTask = await actions.addRootTask(task.sortorder);
      } else {
        createdTask = await actions.addChildTask(parentId, task.sortorder);
      }

      if (createdTask?.id) {
        gantt.showLightbox(createdTask.id);
      }
    };

    /** S: マウスが指しているタスク・日付を初期値にしてスケジュール追加モーダルを開く */
    const handleAddSchedule = (event: KeyboardEvent) => {
      if (isTypingTarget(document.activeElement, ['button', 'select'])) return;

      const target = actionsRef.current.getTimelinePointerTarget();
      if (!target || !gantt.isTaskExists(target.taskId)) return;

      event.preventDefault();
      actionsRef.current.openScheduleModal(target.taskId, target.date);
    };

    /** O: 現在の行のタスクにObsidianノートを作成する */
    const handleCreateObsidianNote = (event: KeyboardEvent) => {
      if (isTypingTarget(document.activeElement)) return;

      const activeId = currentTaskId();
      if (!activeId || !gantt.isTaskExists(activeId)) return;

      event.preventDefault();
      actionsRef.current.createObsidianNote(Number(activeId));
    };

    /** Ctrl(Cmd)+C: 選択中のタスクIDを表示順（上から下）で覚える */
    const handleCopy = (event: KeyboardEvent) => {
      const selectedTasks = getSelectedTaskIds();
      const selectedId = gantt.getSelectedId();
      const copiedIds = selectedTasks.length > 0
        ? [...selectedTasks].sort((a, b) => gantt.getGlobalTaskIndex(a) - gantt.getGlobalTaskIndex(b))
        : (selectedId ? [selectedId] : []);
      if (copiedIds.length === 0) return;

      event.preventDefault();
      sessionStorage.setItem(COPIED_TASK_IDS_KEY, JSON.stringify(copiedIds));
    };

    /** Ctrl(Cmd)+V: コピーしたタスクを、選択中のタスクの後ろへ順に複製し、複製したタスクを選択する */
    const handlePaste = (event: KeyboardEvent) => {
      const copiedIds = readCopiedTaskIds();
      if (copiedIds.length === 0) return;

      event.preventDefault();
      const selectedId = gantt.getSelectedId();
      let targetId = selectedId ? Number(selectedId) : undefined;

      const paste = async () => {
        const createdIds: number[] = [];

        for (const copiedId of copiedIds) {
          // 貼り付け先の指定がなければ、バックエンドはコピー元の直後に挿入する
          const anchorId = targetId ?? copiedId;
          const createdTask = await actionsRef.current.cloneTask(copiedId, targetId);
          if (!createdTask?.id) continue;

          createdIds.push(createdTask.id);
          // 次のタスクは、いま作ったタスクの後ろに挿入する
          targetId = createdTask.id;

          // ganttに直接追加してUndoの履歴に記録させる（差分同期は履歴に影響しない）
          if (!gantt.isTaskExists(createdTask.id)) {
            addTaskToGantt(createdTask, indexAfterTask(anchorId, createdTask.parent || 0));
          }
        }

        if (createdIds.length === 0) return;

        // Ganttの再描画を待ってから、複製したタスクをすべて選択状態にする
        setTimeout(() => {
          clearSelection();
          for (const id of createdIds) {
            if (gantt.isTaskExists(id)) {
              gantt.selectTask(id);
            }
          }
          cursorRef.current.taskId = createdIds[createdIds.length - 1];
        }, 100);
      };

      void paste();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (gantt.getState().lightbox) {
        handleLightboxKeyDown(event);
        return;
      }

      const modifierPressed = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (modifierPressed && ['z', 'y', 'c', 'v'].includes(key)) {
        // 入力欄（検索ボックスやモーダル）では、ブラウザ標準の元に戻す・コピー・貼り付けを優先する
        if (isTypingTarget(document.activeElement)) return;

        if (key === 'c') {
          handleCopy(event);
        } else if (key === 'v') {
          handlePaste(event);
        } else {
          handleUndoRedo(event);
        }
        return;
      }

      if (event.key === 'Enter') {
        handleEnter(event, modifierPressed);
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        handleDelete(event);
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        handleArrow(event, modifierPressed);
      } else if (!modifierPressed && key === 'a') {
        void handleAddTask(event);
      } else if (!modifierPressed && key === 's') {
        handleAddSchedule(event);
      } else if (!modifierPressed && key === 'o') {
        handleCreateObsidianNote(event);
      }
    };

    // capture phaseで登録し、DHTMLX内部のイベント処理より先に捕捉する
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [cursorRef, actionsRef]);
}
