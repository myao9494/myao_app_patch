/**
 * @vitest-environment jsdom
 * 休日・出張の追加モーダルのテスト。APIはモックする。
 **/
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../services/api';
import type { BusinessTripSettings, HolidaySettings } from '../../types/gantt';
import { CalendarSettingsModal } from './CalendarSettingsModal';

vi.mock('../../services/api');

const holidays: HolidaySettings = { holidays: [], raw_text: '', file_path: '/data/holidays.txt' };
const trips: BusinessTripSettings = { business_trips: [], raw_text: '', file_path: '/data/trips.txt' };

const handlers = {
  onHolidaySettingsChange: vi.fn(),
  onBusinessTripSettingsChange: vi.fn(),
  onClose: vi.fn(),
};

function renderModal() {
  return render(<CalendarSettingsModal holidaySettings={holidays} businessTripSettings={trips} {...handlers} />);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('CalendarSettingsModal', () => {
  it('休日を追加すると、APIを呼んで結果を親へ渡し、入力欄を空にすること', async () => {
    const saved = { ...holidays, holidays: ['2026-05-01'], raw_text: '2026-05-01' };
    vi.mocked(api.addHoliday).mockResolvedValue({ success: true, data: saved });
    renderModal();

    fireEvent.change(screen.getByLabelText('カレンダーで追加'), { target: { value: '2026-05-01' } });
    fireEvent.click(screen.getAllByRole('button', { name: '追加' })[0]);

    await waitFor(() => expect(handlers.onHolidaySettingsChange).toHaveBeenCalledWith(saved));
    expect(api.addHoliday).toHaveBeenCalledWith('2026-05-01');
    expect((screen.getByLabelText('カレンダーで追加') as HTMLInputElement).value).toBe('');
  });

  it('日付が空のまま追加しようとすると、APIを呼ばずにエラーを出すこと', () => {
    renderModal();

    fireEvent.click(screen.getAllByRole('button', { name: '追加' })[0]);

    expect(api.addHoliday).not.toHaveBeenCalled();
    expect(screen.getByText('日付を入力してください')).toBeTruthy();
  });

  it('出張の追加に失敗したら、バックエンドのエラーメッセージを表示すること', async () => {
    vi.mocked(api.addBusinessTrip).mockResolvedValue({ success: false, error: 'date is invalid' });
    renderModal();

    fireEvent.change(screen.getByLabelText('出張をカレンダーで追加'), { target: { value: '2026-05-02' } });
    fireEvent.click(screen.getByLabelText('日帰り出張'));
    fireEvent.click(screen.getAllByRole('button', { name: '追加' })[1]);

    await waitFor(() => expect(screen.getByText('date is invalid')).toBeTruthy());
    expect(api.addBusinessTrip).toHaveBeenCalledWith('2026-05-02', 'day_trip');
    expect(handlers.onBusinessTripSettingsChange).not.toHaveBeenCalled();
  });

  it('休日テキストの保存で、編集した内容をAPIへ送ること', async () => {
    vi.mocked(api.updateHolidayRawText).mockResolvedValue({ success: true, data: holidays });
    renderModal();

    fireEvent.change(screen.getByLabelText('休日ファイルをまとめて編集'), { target: { value: '2026-01-05' } });
    fireEvent.click(screen.getByRole('button', { name: '休日テキストを保存' }));

    await waitFor(() => expect(api.updateHolidayRawText).toHaveBeenCalledWith('2026-01-05'));
  });

  it('閉じるボタンで onClose を呼ぶこと', () => {
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));

    expect(handlers.onClose).toHaveBeenCalled();
  });
});
