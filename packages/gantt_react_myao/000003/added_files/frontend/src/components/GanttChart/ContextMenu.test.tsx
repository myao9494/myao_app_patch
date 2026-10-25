/**
 * @vitest-environment jsdom
 * ガントチャートの右クリックメニュー（ContextMenu）のテスト
 **/
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu } from './ContextMenu';
import type { ContextMenuItem } from './contextMenuItems';

afterEach(cleanup);

function renderMenu(items: ContextMenuItem[]) {
  const onClose = vi.fn();
  const view = render(<ContextMenu x={10} y={20} items={items} onClose={onClose} />);
  return { onClose, ...view };
}

describe('ContextMenu', () => {
  it('項目を押すと、その操作を実行してメニューを閉じること', () => {
    const action = vi.fn();
    const { onClose } = renderMenu([{ label: '編集', icon: '✏️', action }]);

    fireEvent.click(screen.getByText('編集'));

    expect(action).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('区切り線は項目として押せず、危険な操作には danger のクラスが付くこと', () => {
    const { container } = renderMenu([{ divider: true }, { label: '削除', danger: true, action: vi.fn() }]);

    expect(container.querySelectorAll('.gantt-context-menu-divider')).toHaveLength(1);
    expect(screen.getByText('削除').parentElement?.className).toContain('danger');
  });

  it('サブメニューの親を押しても操作は実行せず、サブメニューの項目を押すと実行して閉じること', () => {
    const parentAction = vi.fn();
    const childAction = vi.fn();
    const { onClose } = renderMenu([
      { label: '進捗', action: parentAction, submenu: [{ label: '50%', action: childAction }] },
    ]);

    fireEvent.click(screen.getByText('進捗'));
    expect(parentAction).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('50%'));
    expect(childAction).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('メニューの外を押すか Escape を押すと閉じ、メニュー内を押しても閉じないこと', () => {
    const { onClose } = renderMenu([{ label: '編集', action: vi.fn() }]);

    fireEvent.mouseDown(screen.getByText('編集'));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('画面からはみ出す位置に出すときは、画面内に収まるよう位置をずらすこと', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 200, height: 100, top: 0, left: 0, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}),
    });
    Object.defineProperty(window, 'innerWidth', { value: 300, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 150, configurable: true });

    const { container } = render(<ContextMenu x={250} y={120} items={[{ label: 'A', action: vi.fn() }]} onClose={vi.fn()} />);

    const menu = container.querySelector('.gantt-context-menu') as HTMLElement;
    expect(menu.style.left).toBe('90px');
    expect(menu.style.top).toBe('40px');
    vi.restoreAllMocks();
  });
});
