/**
 * ヘッダーコンポーネント
 * - アプリタイトルと接続先ホスト情報の表示
 * - 設定モーダル起動ボタン
 */
import React from 'react';
import { Settings as SettingsIcon, Zap } from 'lucide-react';
import { AppSettings } from '../types';

interface HeaderProps {
  settings: AppSettings;
  onOpenSettings: () => void;
}

export const Header: React.FC<HeaderProps> = ({ settings, onOpenSettings }) => {
  return (
    <header className="quick-header">
      <div className="quick-header-title">
        <Zap className="quick-icon-bolt" size={22} />
        <span className="quick-logo-text">Quick</span>
        <span className="quick-host-badge" title={settings.serverHost}>
          {settings.serverHost === 'localhost' || settings.serverHost === '127.0.0.1'
            ? 'Local'
            : settings.serverHost.split('.')[0]}
        </span>
      </div>
      <div className="quick-header-actions">
        <button
          className="quick-btn-icon"
          onClick={onOpenSettings}
          title="設定"
          aria-label="設定を開く"
        >
          <SettingsIcon size={20} />
        </button>
      </div>
    </header>
  );
};
