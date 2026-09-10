/**
 * 設定モーダルコンポーネント
 * - Tailscaleホスト名、サーバーポート、Excalidrawポートの設定
 * - 検索対象ルートディレクトリの変更
 * - localStorageへの保存と初期化
 */
import React, { useState } from 'react';
import { AppSettings } from '../types';
import { DEFAULT_TAILSCALE_HOST, DEFAULT_BASE_PATH } from '../utils/config';
import { X, Save, RotateCcw, Server, Folder, Globe } from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
  settings: AppSettings;
  onClose: () => void;
  onSave: (newSettings: AppSettings) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  settings,
  onClose,
  onSave,
}) => {
  const [formData, setFormData] = useState<AppSettings>(settings);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(formData);
    onClose();
  };

  const handleReset = () => {
    setFormData({
      ...settings,
      serverHost: DEFAULT_TAILSCALE_HOST,
      serverPort: '8001',
      excalidrawPort: '3001',
      basePath: DEFAULT_BASE_PATH,
    });
  };

  const handleUseCurrentHost = () => {
    setFormData((prev) => ({
      ...prev,
      serverHost: window.location.hostname || DEFAULT_TAILSCALE_HOST,
    }));
  };

  return (
    <div className="quick-modal-backdrop" onClick={onClose}>
      <div className="quick-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="quick-modal-header">
          <div className="quick-modal-title">
            <Server size={20} />
            <span>アプリ・接続設定</span>
          </div>
          <button className="quick-btn-icon" onClick={onClose} aria-label="閉じる">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="quick-modal-form">
          <div className="quick-form-group">
            <label className="quick-form-label">
              <Globe size={16} />
              <span>サーバーホスト名 / Tailscaleドメイン</span>
            </label>
            <input
              type="text"
              className="quick-form-input"
              value={formData.serverHost}
              onChange={(e) => setFormData({ ...formData, serverHost: e.target.value.trim() })}
              placeholder="例: mineomacbook-air.taild3cb7c.ts.net"
              required
            />
            <div className="quick-form-presets">
              <button
                type="button"
                className="quick-btn-preset"
                onClick={() => setFormData({ ...formData, serverHost: DEFAULT_TAILSCALE_HOST })}
              >
                Tailscale標準
              </button>
              <button
                type="button"
                className="quick-btn-preset"
                onClick={handleUseCurrentHost}
              >
                現在のホスト
              </button>
            </div>
            <span className="quick-form-help">
              ※スマホから接続する場合、TailscaleドメインまたはPCのローカルIPアドレスを指定します。
            </span>
          </div>

          <div className="quick-form-row">
            <div className="quick-form-group flex-1">
              <label className="quick-form-label">API ポート</label>
              <input
                type="text"
                className="quick-form-input"
                value={formData.serverPort}
                onChange={(e) => setFormData({ ...formData, serverPort: e.target.value.trim() })}
                placeholder="8001"
                required
              />
            </div>
            <div className="quick-form-group flex-1">
              <label className="quick-form-label">Excalidraw ポート</label>
              <input
                type="text"
                className="quick-form-input"
                value={formData.excalidrawPort}
                onChange={(e) => setFormData({ ...formData, excalidrawPort: e.target.value.trim() })}
                placeholder="3001"
                required
              />
            </div>
          </div>

          <div className="quick-form-group">
            <label className="quick-form-label">
              <Folder size={16} />
              <span>検索対象ルートパス</span>
            </label>
            <input
              type="text"
              className="quick-form-input"
              value={formData.basePath}
              onChange={(e) => setFormData({ ...formData, basePath: e.target.value.trim() })}
              placeholder="/Users/mine/000_work"
              required
            />
          </div>

          <div className="quick-modal-actions">
            <button
              type="button"
              className="quick-btn-secondary"
              onClick={handleReset}
              title="初期値に戻す"
            >
              <RotateCcw size={16} />
              <span>初期値</span>
            </button>
            <button type="submit" className="quick-btn-primary">
              <Save size={16} />
              <span>設定を保存</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
