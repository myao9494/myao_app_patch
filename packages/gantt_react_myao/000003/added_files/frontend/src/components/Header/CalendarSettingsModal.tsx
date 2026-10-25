/**
 * 休日・出張の追加モーダル。
 * 日付を1件ずつ追加するほか、バックエンドのテキストファイル（holidays.txt / business_trips.txt）を
 * まとめて編集して保存できる。開くたびに入力欄を初期状態から始めるため、閉じている間はマウントしない。
 */
import { useState } from 'react';
import { useSyncedState } from '../../hooks/useSyncedState';
import { addBusinessTrip, addHoliday, updateBusinessTripRawText, updateHolidayRawText } from '../../services/api';
import type { BusinessTripSettings, BusinessTripType, HolidaySettings } from '../../types/gantt';
import './Header.css';

interface CalendarSettingsModalProps {
  holidaySettings: HolidaySettings | null;
  onHolidaySettingsChange: (settings: HolidaySettings) => void;
  businessTripSettings: BusinessTripSettings | null;
  onBusinessTripSettingsChange: (settings: BusinessTripSettings) => void;
  onClose: () => void;
}

export function CalendarSettingsModal({
  holidaySettings,
  onHolidaySettingsChange,
  businessTripSettings,
  onBusinessTripSettingsChange,
  onClose,
}: CalendarSettingsModalProps) {
  const [holidayInput, setHolidayInput] = useState('');
  const [holidayRawText, setHolidayRawText] = useSyncedState(holidaySettings?.raw_text || '');
  const [holidayError, setHolidayError] = useState<string | null>(null);
  const [holidaySaving, setHolidaySaving] = useState(false);
  const [tripInput, setTripInput] = useState('');
  const [tripType, setTripType] = useState<BusinessTripType>('normal_trip');
  const [tripRawText, setTripRawText] = useSyncedState(businessTripSettings?.raw_text || '');
  const [tripError, setTripError] = useState<string | null>(null);
  const [tripSaving, setTripSaving] = useState(false);

  const handleAddHoliday = async () => {
    if (!holidayInput.trim()) {
      setHolidayError('日付を入力してください');
      return;
    }

    setHolidaySaving(true);
    setHolidayError(null);
    const result = await addHoliday(holidayInput.trim());
    setHolidaySaving(false);

    if (result.success && result.data) {
      onHolidaySettingsChange(result.data);
      setHolidayRawText(result.data.raw_text);
      setHolidayInput('');
      return;
    }

    setHolidayError(result.error || '休日の追加に失敗しました');
  };

  const handleAddBusinessTrip = async () => {
    if (!tripInput.trim()) {
      setTripError('日付を入力してください');
      return;
    }

    setTripSaving(true);
    setTripError(null);
    const result = await addBusinessTrip(tripInput.trim(), tripType);
    setTripSaving(false);

    if (result.success && result.data) {
      onBusinessTripSettingsChange(result.data);
      setTripRawText(result.data.raw_text);
      setTripInput('');
      return;
    }

    setTripError(result.error || '出張の追加に失敗しました');
  };

  const handleSaveHolidayText = async () => {
    setHolidaySaving(true);
    setHolidayError(null);
    const result = await updateHolidayRawText(holidayRawText);
    setHolidaySaving(false);

    if (result.success && result.data) {
      onHolidaySettingsChange(result.data);
      setHolidayRawText(result.data.raw_text);
      return;
    }

    setHolidayError(result.error || '休日ファイルの保存に失敗しました');
  };

  const handleSaveBusinessTripText = async () => {
    setTripSaving(true);
    setTripError(null);
    const result = await updateBusinessTripRawText(tripRawText);
    setTripSaving(false);

    if (result.success && result.data) {
      onBusinessTripSettingsChange(result.data);
      setTripRawText(result.data.raw_text);
      return;
    }

    setTripError(result.error || '出張ファイルの保存に失敗しました');
  };

  return (
    <div className="settings-modal-overlay" onClick={() => onClose()}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-modal-header">
          <h2>休日・出張の追加</h2>
          <button className="close-btn" onClick={() => onClose()}>✕</button>
        </div>
        <div className="settings-modal-body">
          <div className="settings-field">
            <label htmlFor="holiday-date-input">カレンダーで追加</label>
            <div className="holiday-inline-row">
              <input
                id="holiday-date-input"
                type="date"
                value={holidayInput}
                onChange={(e) => setHolidayInput(e.target.value)}
              />
              <button className="btn primary" onClick={handleAddHoliday} disabled={holidaySaving}>
                追加
              </button>
            </div>
          </div>

          <div className="settings-field">
            <label htmlFor="holiday-text-input">直打ちで追加</label>
            <input
              id="holiday-text-input"
              type="text"
              value={holidayInput}
              onChange={(e) => setHolidayInput(e.target.value)}
              placeholder="YYYY-MM-DD"
            />
          </div>

          <div className="settings-field">
            <label htmlFor="holiday-raw-text">休日ファイルをまとめて編集</label>
            <textarea
              id="holiday-raw-text"
              className="holiday-textarea"
              value={holidayRawText}
              onChange={(e) => setHolidayRawText(e.target.value)}
              placeholder={'1行に1日ずつ入力します\n例: 2026-01-05'}
            />
          </div>

          <div className="settings-path">
            保存先: {holidaySettings?.file_path || 'backend/data/holidays.txt'}
          </div>
          {holidayError && <div className="settings-error">{holidayError}</div>}

          <div className="settings-field">
            <label htmlFor="trip-date-input">出張をカレンダーで追加</label>
            <div className="holiday-inline-row">
              <input
                id="trip-date-input"
                type="date"
                value={tripInput}
                onChange={(e) => setTripInput(e.target.value)}
              />
              <label className="trip-type-checkbox">
                <input
                  type="checkbox"
                  checked={tripType === 'day_trip'}
                  onChange={(e) => setTripType(e.target.checked ? 'day_trip' : 'normal_trip')}
                />
                <span>日帰り出張</span>
              </label>
              <button className="btn primary" onClick={handleAddBusinessTrip} disabled={tripSaving}>
                追加
              </button>
            </div>
          </div>

          <div className="settings-field">
            <label htmlFor="trip-raw-text">出張ファイルをまとめて編集</label>
            <textarea
              id="trip-raw-text"
              className="holiday-textarea"
              value={tripRawText}
              onChange={(e) => setTripRawText(e.target.value)}
              placeholder={'1行に1日ずつ入力します\n例: 2026-01-05,normal_trip\n例: 2026-01-06,day_trip'}
            />
          </div>

          <div className="settings-path">
            出張保存先: {businessTripSettings?.file_path || 'backend/data/business_trips.txt'}
          </div>
          {tripError && <div className="settings-error">{tripError}</div>}
        </div>
        <div className="settings-modal-footer">
          <button className="btn" onClick={() => onClose()}>
            閉じる
          </button>
          <button className="btn primary" onClick={handleSaveBusinessTripText} disabled={tripSaving}>
            出張テキストを保存
          </button>
          <button className="btn primary" onClick={handleSaveHolidayText} disabled={holidaySaving}>
            休日テキストを保存
          </button>
        </div>
      </div>
    </div>
  );
}
