import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useSyncedState } from '../../hooks/useSyncedState';
import { addBusinessTrip, addHoliday, updateBusinessTripRawText, updateHolidayRawText } from '../../services/api';
import type { BusinessTripSettings, BusinessTripType, HolidaySettings } from '../../types/gantt';
import './Header.css';

interface HamburgerMenuProps {
    darkMode: boolean;
    toggleDarkMode: () => void;
    displaySize: number;
    onDisplaySizeChange: (size: number) => void;
    onAutoMoveTasks: () => void;
    onReloadData: () => void;
    onExportCSV: () => void;
    onDiffCompare: () => void; // 差分比較
    isPrintMode: boolean;
    onPrintModeToggle: () => void;
    gridWidth: number;
    onGridWidthChange: (width: number) => void;
    obsidianHome: string;
    onObsidianHomeChange: (path: string) => void;
    onShowCsvSyncSummary: () => void;
    holidaySettings: HolidaySettings | null;
    onHolidaySettingsChange: (settings: HolidaySettings) => void;
    businessTripSettings: BusinessTripSettings | null;
    onBusinessTripSettingsChange: (settings: BusinessTripSettings) => void;
}

export function HamburgerMenu({
    darkMode,
    toggleDarkMode,
    displaySize,
    onDisplaySizeChange,
    onAutoMoveTasks,
    onReloadData,
    onExportCSV,
    onDiffCompare,
    isPrintMode,
    onPrintModeToggle,
    gridWidth,
    onGridWidthChange,
    obsidianHome,
    onObsidianHomeChange,
    onShowCsvSyncSummary,
    holidaySettings,
    onHolidaySettingsChange,
    businessTripSettings,
    onBusinessTripSettingsChange,
}: HamburgerMenuProps) {
    const [menuOpen, setMenuOpen] = useState(false);
    const [holidayModalOpen, setHolidayModalOpen] = useState(false);
    const [holidayInput, setHolidayInput] = useState('');
    const [holidayRawText, setHolidayRawText] = useSyncedState(holidaySettings?.raw_text || '');
    const [holidayError, setHolidayError] = useState<string | null>(null);
    const [holidaySaving, setHolidaySaving] = useState(false);
    const [tripInput, setTripInput] = useState('');
    const [tripType, setTripType] = useState<BusinessTripType>('normal_trip');
    const [tripRawText, setTripRawText] = useSyncedState(businessTripSettings?.raw_text || '');
    const [tripError, setTripError] = useState<string | null>(null);
    const [tripSaving, setTripSaving] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    // Close menu when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setMenuOpen(false);
            }
        };

        if (menuOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [menuOpen]);

    const handleAction = (action: () => void) => {
        action();
        setMenuOpen(false);
    };

    const handleOpenHolidayModal = () => {
        setHolidayRawText(holidaySettings?.raw_text || '');
        setTripRawText(businessTripSettings?.raw_text || '');
        setHolidayInput('');
        setTripInput('');
        setTripType('normal_trip');
        setHolidayError(null);
        setTripError(null);
        setHolidayModalOpen(true);
        setMenuOpen(false);
    };

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
        <>
            <div className="menu-container" ref={menuRef}>
                <button
                    className={`hamburger-btn ${menuOpen ? 'active' : ''}`}
                    onClick={() => setMenuOpen(!menuOpen)}
                    title="設定メニュー"
                >
                    <span></span>
                    <span></span>
                    <span></span>
                </button>

                {menuOpen && (
                    <div className="hamburger-menu">
                        <div className="menu-title">設定</div>

                        <div className="menu-item">
                            <label>
                                <span className="icon">🌙</span>
                                <span>ダークモード</span>
                            </label>
                            <label className="toggle-switch">
                                <input
                                    type="checkbox"
                                    checked={darkMode}
                                    onChange={toggleDarkMode}
                                />
                                <span className="toggle-slider"></span>
                            </label>
                        </div>

                        <div className="menu-divider"></div>

                        <div className="menu-item">
                            <label>
                                <span className="icon">📏</span>
                                <span>表示サイズ</span>
                            </label>
                        </div>
                        <div className="menu-item size-control">
                            <input
                                type="range"
                                min="50"
                                max="200"
                                value={displaySize}
                                onChange={(e) => onDisplaySizeChange(Number(e.target.value))}
                            />
                            <span>{displaySize}%</span>
                        </div>

                        <div className="menu-item">
                            <label>
                                <span className="icon">↔</span>
                                <span>リスト幅</span>
                            </label>
                        </div>
                        <div className="menu-item size-control">
                            <input
                                type="range"
                                min="200"
                                max="800"
                                value={gridWidth}
                                onChange={(e) => onGridWidthChange(Number(e.target.value))}
                            />
                            <span>{gridWidth}px</span>
                        </div>

                        <div className="menu-item">
                            <label>
                                <span className="icon">📝</span>
                                <span>Obsidianホーム</span>
                            </label>
                        </div>
                        <div className="menu-item size-control">
                            <input
                                type="text"
                                value={obsidianHome}
                                onChange={(e) => onObsidianHomeChange(e.target.value)}
                                placeholder="各端末のObsidian Vault絶対パス"
                                style={{ width: '100%', padding: '4px' }}
                                title="ObsidianのVaultフォルダの絶対パスを指定（PWAでは端末ごとに設定）"
                            />
                        </div>

                        <div className="menu-divider"></div>

                        <div className="menu-section-label">操作</div>

                        <button
                            className="menu-button"
                            onClick={handleOpenHolidayModal}
                            title="バックエンドの休日ファイルを編集"
                        >
                            <span className="icon">🏖️</span>
                            <span>休日・出張の追加</span>
                        </button>

                        <button
                            className="menu-button"
                            onClick={() => handleAction(onAutoMoveTasks)}
                            title="未完了タスクの開始日を今日に移動"
                        >
                            <span className="icon">📅</span>
                            <span>task自動移動</span>
                        </button>

                        <button
                            className="menu-button"
                            onClick={() => handleAction(onReloadData)}
                        >
                            <span className="icon">🔄</span>
                            <span>データ読み込み</span>
                        </button>

                        <button
                            className="menu-button"
                            onClick={() => handleAction(onExportCSV)}
                        >
                            <span className="icon">📥</span>
                            <span>CSVエクスポート</span>
                        </button>

                        <button
                            className="menu-button"
                            onClick={() => handleAction(onShowCsvSyncSummary)}
                            title="Obsidian保存との差分サマリを表示"
                        >
                            <span className="icon">🗂</span>
                            <span>差分サマリ</span>
                        </button>

                        <button
                            className="menu-button"
                            onClick={() => handleAction(onDiffCompare)}
                            title="CSVファイルと現在のデータを比較"
                        >
                            <span className="icon">📊</span>
                            <span>差分比較</span>
                        </button>

                        <div className="menu-divider"></div>

                        <div className="menu-item">
                            <label>
                                <span className="icon">🖨️</span>
                                <span>印刷モード</span>
                            </label>
                            <label className="toggle-switch">
                                <input
                                    type="checkbox"
                                    checked={isPrintMode}
                                    onChange={() => handleAction(onPrintModeToggle)}
                                />
                                <span className="toggle-slider"></span>
                            </label>
                        </div>

                        <div className="menu-divider"></div>

                        <Link
                            to="/api-guide"
                            target="_blank"
                            className="menu-button guide-link"
                            onClick={() => setMenuOpen(false)}
                        >
                            <span className="icon">📖</span>
                            <span>APIガイド (AI参照用)</span>
                        </Link>
                    </div>
                )}
            </div>

            {holidayModalOpen && (
                <div className="settings-modal-overlay" onClick={() => setHolidayModalOpen(false)}>
                    <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="settings-modal-header">
                            <h2>休日・出張の追加</h2>
                            <button className="close-btn" onClick={() => setHolidayModalOpen(false)}>✕</button>
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
                            <button className="btn" onClick={() => setHolidayModalOpen(false)}>
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
            )}
        </>
    );
}
