/**
 * @vitest-environment jsdom
 * ガントチャートのキーボードショートカット（useGanttKeyboard）のテスト
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { gantt } from 'dhtmlx-gantt';
import {
  handleLightboxKeyDown,
  useGanttKeyboard,
  type GanttKeyboardActions,
  type KeyboardCursor,
} from '../useGanttKeyboard';
import { createGanttSyncState, syncGanttData } from '../ganttSync';
import { flushPromises, makeTask, setupGantt } from './ganttTestHarness';

function pressKey(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

describe('Lightbox表示中のキー操作', () => {
  let saveClicked: number;

  beforeEach(() => {
    saveClicked = 0;
    document.body.innerHTML = `
      <div class="gantt_cal_light">
        <textarea id="name"></textarea>
        <textarea id="memo"></textarea>
        <textarea id="schedule"></textarea>
      </div>
      <div class="gantt_btn_set gantt_save_btn_set"></div>
    `;
    document.querySelector('.gantt_save_btn_set')?.addEventListener('click', () => {
      saveClicked++;
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  function keydown(init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { cancelable: true, ...init });
    vi.spyOn(event, 'stopPropagation');
    handleLightboxKeyDown(event);
    return event;
  }

  it('Enter で保存すること', () => {
    const event = keydown({ key: 'Enter' });

    expect(saveClicked).toBe(1);
    expect(event.defaultPrevented).toBe(true);
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it('Shift+Enter は保存せず、改行できるようDHTMLXへのイベント伝播だけ止めること', () => {
    const event = keydown({ key: 'Enter', shiftKey: true });

    expect(saveClicked).toBe(0);
    expect(event.defaultPrevented).toBe(false);
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it('日本語入力の変換確定の Enter では保存しないこと', () => {
    keydown({ key: 'Enter', isComposing: true });

    expect(saveClicked).toBe(0);
  });

  it('Tab / Shift+Tab で入力欄を順に移動し、端では反対側へ回ること', () => {
    document.getElementById('name')?.focus();

    keydown({ key: 'Tab' });
    expect(document.activeElement?.id).toBe('memo');

    keydown({ key: 'Tab' });
    keydown({ key: 'Tab' });
    expect(document.activeElement?.id).toBe('name');

    keydown({ key: 'Tab', shiftKey: true });
    expect(document.activeElement?.id).toBe('schedule');
  });
});

describe('チャート上のショートカット', () => {
  let teardown: () => void;
  let cursor: { current: KeyboardCursor };
  let actions: { current: GanttKeyboardActions };

  beforeEach(() => {
    teardown = setupGantt();
    syncGanttData(
      [
        makeTask(1, { text: 'Project', kind_task: 2 }),
        makeTask(2, { parent: 1, sortorder: 0 }),
        makeTask(3, { parent: 1, sortorder: 1 }),
        makeTask(4, { sortorder: 1 }),
      ],
      [],
      createGanttSyncState(),
    );
    gantt.render();
    sessionStorage.clear();

    cursor = { current: { taskId: null, isFocusMode: false } };
    actions = {
      current: {
        addChildTask: vi.fn(() => Promise.resolve(undefined)),
        addRootTask: vi.fn(() => Promise.resolve(undefined)),
        cloneTask: vi.fn(() => Promise.resolve(undefined)),
        createObsidianNote: vi.fn(),
        openScheduleModal: vi.fn(),
        getTimelinePointerTarget: vi.fn(() => null),
        scrollTaskIntoView: vi.fn(),
      },
    };
    renderHook(() => useGanttKeyboard(cursor, actions));
  });

  afterEach(() => {
    cleanup();
    teardown();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  function focusSearchInput(): HTMLInputElement {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    return input;
  }

  describe('A: タスク追加', () => {
    it('プロジェクトを選択中なら、その子として追加すること', () => {
      cursor.current.taskId = 1;

      pressKey('a');

      expect(actions.current.addChildTask).toHaveBeenCalledWith(1);
    });

    it('子タスクを選択中なら、同じ親の中でそのタスクの直下に追加すること', () => {
      cursor.current.taskId = 3;

      pressKey('a');

      expect(actions.current.addChildTask).toHaveBeenCalledWith(1, 1);
    });

    it('最上位のタスクを選択中なら、最上位でそのタスクの直下に追加すること', () => {
      cursor.current.taskId = 4;

      pressKey('A');

      expect(actions.current.addRootTask).toHaveBeenCalledWith(1);
    });

    it('追加できたら、そのタスクの編集画面を開くこと', async () => {
      const showLightbox = vi.spyOn(gantt, 'showLightbox').mockImplementation(() => {});
      vi.mocked(actions.current.addChildTask).mockResolvedValue(makeTask(50));
      cursor.current.taskId = 1;

      pressKey('a');
      await flushPromises();

      expect(showLightbox).toHaveBeenCalledWith(50);
    });

    it('入力欄にフォーカスがある間は反応しないこと', () => {
      cursor.current.taskId = 1;
      focusSearchInput();

      pressKey('a');

      expect(actions.current.addChildTask).not.toHaveBeenCalled();
    });
  });

  it('O: 選択中のタスクのObsidianノートを作成すること', () => {
    cursor.current.taskId = 2;

    pressKey('o');

    expect(actions.current.createObsidianNote).toHaveBeenCalledWith(2);
  });

  it('S: マウスが指しているタスクと日付でスケジュール追加モーダルを開くこと', () => {
    const date = new Date(2026, 2, 11);
    vi.mocked(actions.current.getTimelinePointerTarget).mockReturnValue({ taskId: 3, date });

    pressKey('s');

    expect(actions.current.openScheduleModal).toHaveBeenCalledWith(3, date);
  });

  it('S: マウスがタイムライン上に無ければ何もしないこと', () => {
    pressKey('s');

    expect(actions.current.openScheduleModal).not.toHaveBeenCalled();
  });

  describe('矢印キー', () => {
    it('↓ で次の行を選択すること', () => {
      gantt.selectTask(2);
      cursor.current.taskId = 2;

      pressKey('ArrowDown');

      expect(gantt.getSelectedTasks().map(Number)).toEqual([3]);
      expect(cursor.current.taskId).toBe(3);
      expect(actions.current.scrollTaskIntoView).toHaveBeenCalledWith(3);
    });

    it('Shift+↓ で選択範囲を広げ、Shift+↑ で縮めること', () => {
      gantt.selectTask(2);
      cursor.current.taskId = 2;

      pressKey('ArrowDown', { shiftKey: true });
      expect(gantt.getSelectedTasks().map(Number).sort()).toEqual([2, 3]);

      pressKey('ArrowUp', { shiftKey: true });
      expect(gantt.getSelectedTasks().map(Number)).toEqual([2]);
      expect(cursor.current.taskId).toBe(2);
    });

    it('Ctrl+↓ は選択を変えずにフォーカスだけ移動すること', () => {
      gantt.selectTask(2);
      cursor.current.taskId = 2;

      pressKey('ArrowDown', { ctrlKey: true });

      expect(gantt.getSelectedTasks().map(Number)).toEqual([2]);
      expect(cursor.current).toEqual({ taskId: 3, isFocusMode: true });
    });
  });

  describe('Delete', () => {
    it('確認のうえ選択中のタスクを削除し、その上の行を選択すること', () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      gantt.selectTask(3);

      pressKey('Delete');

      expect(gantt.isTaskExists(3)).toBe(false);
      expect(gantt.getSelectedTasks().map(Number)).toEqual([2]);
      expect(cursor.current.taskId).toBe(2);
    });

    it('確認でキャンセルしたら削除しないこと', () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      gantt.selectTask(3);

      pressKey('Backspace');

      expect(gantt.isTaskExists(3)).toBe(true);
    });
  });

  describe('コピーと貼り付け', () => {
    it('Ctrl+C で選択中のタスクを表示順に覚え、Ctrl+V で選択タスクの後ろへ順に複製すること', async () => {
      vi.mocked(actions.current.cloneTask)
        .mockResolvedValueOnce(makeTask(50, { parent: 1 }))
        .mockResolvedValueOnce(makeTask(51, { parent: 1 }));
      gantt.selectTask(3);
      gantt.selectTask(2);

      pressKey('c', { ctrlKey: true });
      expect(JSON.parse(sessionStorage.getItem('gantt_copied_task_ids') ?? '[]').map(Number)).toEqual([2, 3]);

      pressKey('v', { metaKey: true });
      await flushPromises();
      await flushPromises();

      const targetOfFirstPaste = vi.mocked(actions.current.cloneTask).mock.calls[0][1];
      expect(vi.mocked(actions.current.cloneTask).mock.calls).toEqual([
        [2, targetOfFirstPaste],
        [3, 50],
      ]);
      expect(gantt.isTaskExists(50)).toBe(true);
      expect(gantt.isTaskExists(51)).toBe(true);
    });

    it('入力欄での Ctrl+C / Ctrl+V / Ctrl+Z はブラウザ標準の動作に任せること', () => {
      const undo = vi.spyOn(gantt, 'undo').mockImplementation(() => {});
      sessionStorage.setItem('gantt_copied_task_ids', JSON.stringify([2]));
      gantt.selectTask(2);
      focusSearchInput();

      const events = [
        pressKey('c', { ctrlKey: true }),
        pressKey('v', { ctrlKey: true }),
        pressKey('z', { ctrlKey: true }),
      ];

      expect(events.map((event) => event.defaultPrevented)).toEqual([false, false, false]);
      expect(actions.current.cloneTask).not.toHaveBeenCalled();
      expect(undo).not.toHaveBeenCalled();
    });
  });

  describe('Undo / Redo', () => {
    it('Ctrl+Z で元に戻し、Ctrl+Shift+Z と Ctrl+Y でやり直すこと', () => {
      const undo = vi.spyOn(gantt, 'undo').mockImplementation(() => {});
      const redo = vi.spyOn(gantt, 'redo').mockImplementation(() => {});

      pressKey('z', { ctrlKey: true });
      pressKey('z', { metaKey: true, shiftKey: true });
      pressKey('y', { ctrlKey: true });

      expect(undo).toHaveBeenCalledTimes(1);
      expect(redo).toHaveBeenCalledTimes(2);
    });
  });
});
