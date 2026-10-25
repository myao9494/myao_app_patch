/**
 * @vitest-environment jsdom
 * グリッドの差分パネルのテスト
 **/
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GridDiffItem } from '../../types/gantt';
import { GridDiffPanel } from './GridDiffPanel';

afterEach(cleanup);

const taskDiff = (id: number, field: string, original: string | null, current: string | null): GridDiffItem => ({
  id, table: 'tasks', field, original, current,
});
const linkDiff: GridDiffItem = { id: 9, table: 'links', field: 'type', original: '0', current: '1' };

function renderPanel(props: Partial<Parameters<typeof GridDiffPanel>[0]> = {}) {
  const handlers = { onCommit: vi.fn(), onToggle: vi.fn(), onRevert: vi.fn() };
  render(
    <GridDiffPanel
      diffs={[taskDiff(1, 'text', 'A', 'B'), taskDiff(1, 'memo', null, 'x'), linkDiff]}
      selectedDiff={null}
      collapsed={false}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe('GridDiffPanel', () => {
  it('件数を表示し、Tasks と Links をタブで切り替えること', () => {
    renderPanel();

    expect(screen.getByText('3件の変更')).toBeTruthy();
    expect(screen.getByText('Tasks (2)')).toBeTruthy();
    expect(screen.getByText('Links (1)')).toBeTruthy();
    expect(screen.getByText('タスク名')).toBeTruthy();

    fireEvent.click(screen.getByText('Links (1)'));

    expect(screen.getByText('ID: 9')).toBeTruthy();
    expect(screen.getByText('タイプ')).toBeTruthy();
    expect(screen.queryByText('タスク名')).toBeNull();
  });

  it('値がない側は「(なし)」と表示し、フィールドは同じIDごとにまとめること', () => {
    renderPanel();

    expect(screen.getAllByText('ID: 1')).toHaveLength(1);
    expect(screen.getByText('(なし)')).toBeTruthy();
  });

  it('差分がなければ「変更なし」を表示し、アップロードを押せないこと', () => {
    renderPanel({ diffs: [] });

    expect(screen.getByText('変更なし')).toBeTruthy();
    expect((screen.getByRole('button', { name: /DBにアップロード/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('アップロードボタンで onCommit を呼び、処理中は押せないこと', () => {
    const handlers = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: '⬆ DBにアップロード (3件)' }));
    expect(handlers.onCommit).toHaveBeenCalledTimes(1);

    cleanup();
    renderPanel({ committing: true });
    expect((screen.getByRole('button', { name: /アップロード中/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('折りたたまれているときは本体を出さず、トグルで onToggle を呼ぶこと', () => {
    const handlers = renderPanel({ collapsed: true });

    expect(screen.queryByText('差分確認', { exact: false })).toBeNull();
    fireEvent.click(screen.getByTitle('差分パネル 表示/非表示'));
    expect(handlers.onToggle).toHaveBeenCalledTimes(1);
  });

  it('差分を右クリックして「元に戻す」を選ぶと、その差分で onRevert を呼ぶこと', () => {
    const handlers = renderPanel();

    fireEvent.contextMenu(screen.getByText('タスク名'));
    fireEvent.click(screen.getByText('元に戻す (Undo)'));

    expect(handlers.onRevert).toHaveBeenCalledWith(taskDiff(1, 'text', 'A', 'B'));
    expect(screen.queryByText('元に戻す (Undo)')).toBeNull();
  });

  it('メニューの外をクリックすると、何もせずメニューを閉じること', () => {
    const handlers = renderPanel();

    fireEvent.contextMenu(screen.getByText('タスク名'));
    fireEvent.click(document.body);

    expect(screen.queryByText('元に戻す (Undo)')).toBeNull();
    expect(handlers.onRevert).not.toHaveBeenCalled();
  });
});
