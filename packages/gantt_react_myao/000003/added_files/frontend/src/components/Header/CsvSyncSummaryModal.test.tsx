/**
 * @vitest-environment jsdom
 * Obsidian CSV差分サマリのモーダルのテスト
 **/
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CsvDiffSection, ObsidianCsvSyncSummary } from '../../types/gantt';
import { CsvSyncSummaryModal } from './CsvSyncSummaryModal';

afterEach(cleanup);

const section = (overrides: Partial<CsvDiffSection> = {}): CsvDiffSection => ({
  added_count: 1, deleted_count: 0, modified_count: 1, unchanged_count: 5,
  added_examples: [{ id: '3', label: 'New task', changed_fields: [] }],
  deleted_examples: [],
  modified_examples: [{ id: '4', label: 'Edited task', changed_fields: ['text', 'memo'] }],
  ...overrides,
});

const summary = {
  exists: true,
  status: 'updated',
  checked_at: '2026-01-02 03:04:05',
  saved_at: null,
  output_dir: '/vault/70_gantt_csv',
  history: [{}, {}],
  tasks: section(),
  links: section({ added_count: 0, modified_count: 0, added_examples: [], modified_examples: [] }),
} as unknown as ObsidianCsvSyncSummary;

describe('CsvSyncSummaryModal', () => {
  it('状態・保存先・履歴件数と、追加/変更の一覧を表示すること', () => {
    render(<CsvSyncSummaryModal summary={summary} error={null} onClose={vi.fn()} />);

    expect(screen.getByText('状態: 差分ありで保存')).toBeTruthy();
    expect(screen.getByText('最終保存: -')).toBeTruthy();
    expect(screen.getByText('履歴件数: 2')).toBeTruthy();
    expect(screen.getByText('New task')).toBeTruthy();
    expect(screen.getByText('変更: text, memo')).toBeTruthy();
    expect(screen.getAllByText('追加 1').length).toBeGreaterThan(0);
  });

  it.each([
    ['initial_save', '初回保存'],
    ['unchanged', '差分なし'],
  ])('状態 %s は「%s」と表示すること', (status, label) => {
    render(<CsvSyncSummaryModal summary={{ ...summary, status } as ObsidianCsvSyncSummary} error={null} onClose={vi.fn()} />);

    expect(screen.getByText(`状態: ${label}`)).toBeTruthy();
  });

  it('サマリが未保存なら、その旨と保存先を表示すること', () => {
    render(
      <CsvSyncSummaryModal
        summary={{ exists: false, output_dir: '/vault/70_gantt_csv', summary_json_path: '', summary_markdown_path: '' }}
        error={null}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('まだ差分サマリは保存されていません。')).toBeTruthy();
    expect(screen.getByText('保存先: /vault/70_gantt_csv')).toBeTruthy();
  });

  it('エラーがあるときは、サマリより優先してエラーだけを表示すること', () => {
    render(<CsvSyncSummaryModal summary={summary} error="disk full" onClose={vi.fn()} />);

    expect(screen.getByText('disk full')).toBeTruthy();
    expect(screen.queryByText('履歴件数: 2')).toBeNull();
  });

  it('✕ボタンと背景のクリックで閉じ、モーダル内のクリックでは閉じないこと', () => {
    const onClose = vi.fn();
    const { container } = render(<CsvSyncSummaryModal summary={summary} error={null} onClose={onClose} />);

    fireEvent.click(screen.getByText('Obsidian CSV差分サマリ'));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('✕'));
    fireEvent.click(container.querySelector('.csv-summary-overlay') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
