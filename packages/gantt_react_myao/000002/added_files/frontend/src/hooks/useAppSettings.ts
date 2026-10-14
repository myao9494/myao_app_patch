/**
 * バックエンドから取得するアプリ設定系データのフック
 * - 休日・出張日（タイムラインの背景色に使う）と、休日の追加/解除
 * - 検索用の同義語グループ
 * - Obsidian Vault へのCSV定期保存と、その差分サマリ
 */
import { useCallback, useEffect, useState } from 'react';
import * as api from '../services/api';
import type {
  BusinessTripSettings,
  HolidaySettings,
  ObsidianCsvSyncSummary,
  ObsidianCsvSyncSummaryNotFound,
} from '../types/gantt';

const OBSIDIAN_CSV_SYNC_INTERVAL_MS = 30 * 60 * 1000;

/** 休日・出張日の設定。holidays は右クリックメニューからも追加/解除できる */
export function useCalendarSettings() {
  const [holidaySettings, setHolidaySettings] = useState<HolidaySettings | null>(null);
  const [businessTripSettings, setBusinessTripSettings] = useState<BusinessTripSettings | null>(null);

  useEffect(() => {
    void api.getHolidays().then((result) => {
      if (result.success && result.data) setHolidaySettings(result.data);
    });
    void api.getBusinessTrips().then((result) => {
      if (result.success && result.data) setBusinessTripSettings(result.data);
    });
  }, []);

  const addHoliday = useCallback(async (dateStr: string) => {
    const result = await api.addHoliday(dateStr);
    if (result.success && result.data) {
      setHolidaySettings(result.data);
    } else {
      alert(result.error || '休日の追加に失敗しました');
    }
  }, []);

  const removeHoliday = useCallback(async (dateStr: string) => {
    const result = await api.deleteHoliday(dateStr);
    if (result.success && result.data) {
      setHolidaySettings(result.data);
    } else {
      alert(result.error || '休日の解除に失敗しました');
    }
  }, []);

  return {
    holidaySettings,
    setHolidaySettings,
    businessTripSettings,
    setBusinessTripSettings,
    addHoliday,
    removeHoliday,
  };
}

/** 検索語の同義語グループ。外部の同義語APIが使えない場合は空のまま（通常の検索になる） */
export function useSynonyms(): string[][] {
  const [synonyms, setSynonyms] = useState<string[][]>([]);

  useEffect(() => {
    void api.getSynonyms().then((result) => {
      if (result.success && result.data) setSynonyms(result.data.groups || []);
    });
  }, []);

  return synonyms;
}

/**
 * Obsidian Vault へのCSV保存。
 * Obsidianホームが設定されていれば、起動時と30分ごとに現在のデータを保存し、差分サマリを保持する。
 */
export function useObsidianCsvSync(obsidianHome: string) {
  const [summary, setSummary] = useState<ObsidianCsvSyncSummary | ObsidianCsvSyncSummaryNotFound | null>(null);
  const [error, setError] = useState<string | null>(null);
  const targetHome = obsidianHome.trim();

  useEffect(() => {
    if (!targetHome) return;

    let cancelled = false;
    const runSync = async () => {
      const result = await api.syncObsidianCsv(targetHome);
      if (cancelled) return;
      if (result.success && result.data) {
        setSummary(result.data);
        setError(null);
      } else {
        setError(result.error || 'Obsidian CSV同期に失敗しました');
      }
    };

    void runSync();
    const timerId = window.setInterval(runSync, OBSIDIAN_CSV_SYNC_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timerId);
    };
  }, [targetHome]);

  /** 保存済みの最新サマリを取得し直す。Obsidianホーム未設定の場合は false を返す */
  const reloadSummary = useCallback(async (): Promise<boolean> => {
    if (!targetHome) return false;

    const result = await api.getObsidianCsvSyncSummary(targetHome);
    if (result.success && result.data) {
      setSummary(result.data);
      setError(null);
    } else {
      setError(result.error || '差分サマリの取得に失敗しました');
    }
    return true;
  }, [targetHome]);

  // Obsidianホームが未設定の間は、以前の結果を見せない
  return {
    summary: targetHome ? summary : null,
    error: targetHome ? error : null,
    reloadSummary,
  };
}
