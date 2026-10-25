import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import type { BusinessTripSettings, HolidaySettings } from '../../types/gantt';
import { CalendarSettingsModal } from './CalendarSettingsModal';
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
        setHolidayModalOpen(true);
        setMenuOpen(false);
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
                <CalendarSettingsModal
                    holidaySettings={holidaySettings}
                    onHolidaySettingsChange={onHolidaySettingsChange}
                    businessTripSettings={businessTripSettings}
                    onBusinessTripSettingsChange={onBusinessTripSettingsChange}
                    onClose={() => setHolidayModalOpen(false)}
                />
            )}
        </>
    );
}
