/**
 * メイン画面のヘッダー（アプリ名・モード切替・ヘルプ・設定メニュー）。
 */
import React from "react";
import { Boxes, FolderGit2, HelpCircle, ImageUp } from "lucide-react";
import { SettingsMenu } from "./SettingsMenu.jsx";

const MODES = [
  { id: "files", label: "ファイル差分", icon: ImageUp },
  { id: "git", label: "Git差分", icon: FolderGit2 },
  { id: "3d", label: "3D差分", icon: Boxes },
];

export function AppHeader({ activeTab, onChangeTab, settings, onExtensionsApplied, onSaveObsidianSettings, onOpenHelp }) {
  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <span />
          <span />
        </span>
        <span className="brand-name">Visual Diff</span>
      </div>
      <nav className="segmented mode-tabs" aria-label="比較モード">
        {MODES.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={activeTab === id ? "active" : ""} onClick={() => onChangeTab(id)}>
            <Icon size={16} />
            {label}
          </button>
        ))}
      </nav>
      <div className="header-actions">
        <button type="button" className="btn btn-ghost btn-icon" title="ショートカットと操作（H）" aria-label="ショートカットと操作" onClick={onOpenHelp}>
          <HelpCircle size={18} />
        </button>
        <SettingsMenu
          settings={settings}
          onExtensionsApplied={onExtensionsApplied}
          onSaveObsidianSettings={onSaveObsidianSettings}
          onOpenHelp={onOpenHelp}
        />
      </div>
    </header>
  );
}
