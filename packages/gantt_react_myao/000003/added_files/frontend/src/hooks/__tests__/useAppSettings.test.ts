/**
 * @vitest-environment jsdom
 * アプリ設定系フック（休日・出張、同義語、Obsidian CSV同期）のテスト。APIはモックする。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import * as api from '../../services/api';
import type { BusinessTripSettings, HolidaySettings, ObsidianCsvSyncSummary } from '../../types/gantt';
import { useCalendarSettings, useObsidianCsvSync, useSynonyms } from '../useAppSettings';

vi.mock('../../services/api');

const holidays: HolidaySettings = { holidays: ['2026-01-01'], raw_text: '2026-01-01', file_path: 'h.txt' };
const trips: BusinessTripSettings = { business_trips: [], raw_text: '', file_path: 't.txt' };
const summary = { exists: true, status: 'updated' } as unknown as ObsidianCsvSyncSummary;
let alertSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.mocked(api.getHolidays).mockResolvedValue({ success: true, data: holidays });
  vi.mocked(api.getBusinessTrips).mockResolvedValue({ success: true, data: trips });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe('useCalendarSettings', () => {
  it('休日と出張日を取得すること', async () => {
    const { result } = renderHook(() => useCalendarSettings());

    await waitFor(() => expect(result.current.holidaySettings).toEqual(holidays));
    expect(result.current.businessTripSettings).toEqual(trips);
  });

  it('休日の追加・解除に成功したら、設定を置き換えること', async () => {
    const added = { ...holidays, holidays: ['2026-01-01', '2026-02-01'] };
    vi.mocked(api.addHoliday).mockResolvedValue({ success: true, data: added });
    const { result } = renderHook(() => useCalendarSettings());

    await act(() => result.current.addHoliday('2026-02-01'));
    expect(result.current.holidaySettings).toEqual(added);

    vi.mocked(api.deleteHoliday).mockResolvedValue({ success: true, data: holidays });
    await act(() => result.current.removeHoliday('2026-02-01'));
    expect(result.current.holidaySettings).toEqual(holidays);
  });

  it('休日の追加・解除に失敗したら、エラーを表示して設定は変えないこと', async () => {
    vi.mocked(api.addHoliday).mockResolvedValue({ success: false, error: 'date is invalid' });
    vi.mocked(api.deleteHoliday).mockResolvedValue({ success: false });
    const { result } = renderHook(() => useCalendarSettings());
    await waitFor(() => expect(result.current.holidaySettings).toEqual(holidays));

    await act(() => result.current.addHoliday('bad'));
    expect(alertSpy).toHaveBeenLastCalledWith('date is invalid');

    await act(() => result.current.removeHoliday('2026-01-01'));
    expect(alertSpy).toHaveBeenLastCalledWith('休日の解除に失敗しました');
    expect(result.current.holidaySettings).toEqual(holidays);
  });
});

describe('useSynonyms', () => {
  it('同義語グループを取得し、取得できなければ空のままにすること', async () => {
    vi.mocked(api.getSynonyms).mockResolvedValue({ success: true, data: { groups: [['PC', 'パソコン']] } });
    const ok = renderHook(() => useSynonyms());
    await waitFor(() => expect(ok.result.current).toEqual([['PC', 'パソコン']]));

    vi.mocked(api.getSynonyms).mockResolvedValue({ success: false, error: 'failed to fetch synonyms' });
    const ng = renderHook(() => useSynonyms());
    await act(async () => {});
    expect(ng.result.current).toEqual([]);
  });
});

describe('useObsidianCsvSync', () => {
  it('Obsidianホームが未設定なら、保存せず、サマリの再取得もできないこと', async () => {
    const { result } = renderHook(() => useObsidianCsvSync('  '));

    expect(api.syncObsidianCsv).not.toHaveBeenCalled();
    expect(await result.current.reloadSummary()).toBe(false);
    expect(result.current.summary).toBeNull();
  });

  it('設定されていれば開いたときに保存し、差分サマリを保持すること', async () => {
    vi.mocked(api.syncObsidianCsv).mockResolvedValue({ success: true, data: summary });
    const { result } = renderHook(() => useObsidianCsvSync(' /vault '));

    await waitFor(() => expect(result.current.summary).toBe(summary));
    expect(api.syncObsidianCsv).toHaveBeenCalledWith('/vault');
    expect(result.current.error).toBeNull();
  });

  it('保存に失敗したらエラーを保持すること', async () => {
    vi.mocked(api.syncObsidianCsv).mockResolvedValue({ success: false, error: 'disk full' });
    const { result } = renderHook(() => useObsidianCsvSync('/vault'));

    await waitFor(() => expect(result.current.error).toBe('disk full'));
  });

  it('保存済みサマリの再取得に成功したら、サマリを置き換えること', async () => {
    vi.mocked(api.syncObsidianCsv).mockResolvedValue({ success: true, data: summary });
    const latest = { exists: true, status: 'unchanged' } as unknown as ObsidianCsvSyncSummary;
    vi.mocked(api.getObsidianCsvSyncSummary).mockResolvedValue({ success: true, data: latest });
    const { result } = renderHook(() => useObsidianCsvSync('/vault'));
    await waitFor(() => expect(result.current.summary).toBe(summary));

    let reloaded = false;
    await act(async () => { reloaded = await result.current.reloadSummary(); });

    expect(reloaded).toBe(true);
    expect(result.current.summary).toBe(latest);
  });
});
