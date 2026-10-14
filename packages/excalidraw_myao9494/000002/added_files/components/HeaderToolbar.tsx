/**
 * 画面右上のヘッダーボタン群
 *
 * 新規作成 / マーカー・アンダーライン設定 / ショートカット一覧 /
 * フォルダを開く / VS Codeで開く / 手動保存 / SVGで保存
 */
import React from 'react';

export interface HeaderToolbarProps {
  onNewFile: () => void;
  onToggleAnnotationSettings: () => void;
  onToggleShortcutHelp: () => void;
  onOpenFolder: () => void;
  onOpenInCode: () => void;
  onSave: () => void;
  onExportSvg: () => void;
}

export const HeaderToolbar: React.FC<HeaderToolbarProps> = ({
  onNewFile,
  onToggleAnnotationSettings,
  onToggleShortcutHelp,
  onOpenFolder,
  onOpenInCode,
  onSave,
  onExportSvg,
}) => (
  <div className="custom-header">
    <div className="header-actions">
      <button className="header-btn new-file-btn" onClick={onNewFile} title="新規作成">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
      </button>
      <button
        className="header-btn annotation-settings-btn"
        onClick={onToggleAnnotationSettings}
        title="マーカーとアンダーラインの設定 (,)"
        aria-label="マーカーとアンダーラインの設定"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
      </button>
      <button
        className="header-btn shortcut-help-btn"
        onClick={onToggleShortcutHelp}
        title="ショートカット一覧 (.)"
        aria-label="ショートカット一覧"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="M6 8h.001" />
          <path d="M10 8h.001" />
          <path d="M14 8h.001" />
          <path d="M18 8h.001" />
          <path d="M6 12h.001" />
          <path d="M10 12h.001" />
          <path d="M14 12h.001" />
          <path d="M18 12h.001" />
          <path d="M7 16h10" />
        </svg>
      </button>
      <button className="header-btn open-explorer-btn" onClick={onOpenFolder} title="フォルダを開く">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 7h5l2 3h11a1 1 0 0 1 1 1v7a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z" />
          <polyline points="13 12 16 15 21 10" />
        </svg>
      </button>
      <button className="header-btn open-code-btn" onClick={onOpenInCode} title="codeで開く">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="16,18 22,12 16,6"></polyline>
          <polyline points="8,6 2,12 8,18"></polyline>
        </svg>
      </button>
      <button className="header-btn manual-save-btn" onClick={onSave} title="手動保存（強制バックアップ）">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
          <polyline points="17,21 17,13 7,13 7,21"></polyline>
          <polyline points="7,3 7,8 15,8"></polyline>
        </svg>
      </button>
      <button className="header-btn export-svg-btn" onClick={onExportSvg} title="SVGで保存">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
          <polyline points="7,18 12,23 17,18"></polyline>
          <line x1="12" y1="23" x2="12" y2="12"></line>
          <text x="12" y="9" textAnchor="middle" fontSize="15" fill="currentColor">svg</text>
        </svg>
      </button>
    </div>
  </div>
);
