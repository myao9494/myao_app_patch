/**
 * メイン画面と差分メモ画面で共通のハンバーガーメニューと設定状態。
 * - Git対象拡張子・表示倍率: このブラウザの localStorage に保存し、別タブの変更も storage イベントで反映する
 * - Obsidianフォルダー・レポート保存先: Backend の設定ファイルへ保存する（/api/settings/obsidian）
 */
import React, { useEffect, useRef, useState } from "react";
import { BookOpenText, ExternalLink, HelpCircle, Menu } from "lucide-react";
import { API_BASE, getJson } from "../lib/api.js";
import {
  DEFAULT_TEXT_EXTENSIONS,
  DISPLAY_SCALE_STORAGE_KEY,
  GIT_EXTENSION_STORAGE_KEY,
  loadDisplayScale,
  loadTextExtensions,
  normalizeTextExtensions,
  persistLocalStorage,
} from "../lib/storage.js";

export function useAppSettings() {
  const [textExtensions, setTextExtensions] = useState(loadTextExtensions);
  const [extensionDraft, setExtensionDraft] = useState(() => loadTextExtensions().join(", "));
  const [obsidianFolder, setObsidianFolder] = useState("");
  const [obsidianFolderDraft, setObsidianFolderDraft] = useState("");
  const [obsidianReportFolder, setObsidianReportFolder] = useState("");
  const [obsidianReportFolderDraft, setObsidianReportFolderDraft] = useState("");
  const [obsidianSettingsBusy, setObsidianSettingsBusy] = useState(false);
  const [displayScale, setDisplayScale] = useState(loadDisplayScale);

  function applyServerSettings(settings) {
    const folder = String(settings.obsidian_folder || "");
    const reportFolder = String(settings.obsidian_report_folder || "");
    setObsidianFolder(folder);
    setObsidianFolderDraft(folder);
    setObsidianReportFolder(reportFolder);
    setObsidianReportFolderDraft(reportFolder);
  }

  useEffect(() => {
    getJson("/settings/obsidian").then(applyServerSettings).catch(() => {
      // 設定APIのない古いサーバーでも、設定以外の機能はそのまま使える。
    });
  }, []);

  useEffect(() => {
    persistLocalStorage(GIT_EXTENSION_STORAGE_KEY, textExtensions);
  }, [textExtensions]);

  useEffect(() => {
    persistLocalStorage(DISPLAY_SCALE_STORAGE_KEY, displayScale);
  }, [displayScale]);

  useEffect(() => {
    function syncSharedSettings(event) {
      if (event.key === DISPLAY_SCALE_STORAGE_KEY) setDisplayScale(loadDisplayScale());
      if (event.key === GIT_EXTENSION_STORAGE_KEY) {
        const next = loadTextExtensions();
        setTextExtensions(next);
        setExtensionDraft(next.join(", "));
      }
    }
    window.addEventListener("storage", syncSharedSettings);
    return () => window.removeEventListener("storage", syncSharedSettings);
  }, []);

  /** 入力中のObsidian設定をサーバーへ保存する。失敗時は例外を投げる（表示方法は呼び出し側が決める）。 */
  async function saveObsidianSettings() {
    setObsidianSettingsBusy(true);
    try {
      const response = await fetch(`${API_BASE}/settings/obsidian`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          obsidian_folder: obsidianFolderDraft.trim(),
          obsidian_report_folder: obsidianReportFolderDraft.trim(),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || `設定保存に失敗しました（${response.status}）`);
      applyServerSettings(body);
    } finally {
      setObsidianSettingsBusy(false);
    }
  }

  return {
    textExtensions,
    setTextExtensions,
    extensionDraft,
    setExtensionDraft,
    obsidianFolder,
    obsidianFolderDraft,
    setObsidianFolderDraft,
    obsidianReportFolder,
    obsidianReportFolderDraft,
    setObsidianReportFolderDraft,
    obsidianSettingsBusy,
    saveObsidianSettings,
    displayScale,
    setDisplayScale,
  };
}

export function SettingsMenu({ settings, className = "", onExtensionsApplied, onSaveObsidianSettings, onOpenHelp }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useRef(null);

  // メニューの外をクリック、または Esc で閉じる
  useEffect(() => {
    if (!menuOpen) return undefined;
    function closeOnOutside(event) {
      if (!containerRef.current?.contains(event.target)) setMenuOpen(false);
    }
    function closeOnEscape(event) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);
  const {
    extensionDraft,
    setExtensionDraft,
    setTextExtensions,
    obsidianFolder,
    obsidianFolderDraft,
    setObsidianFolderDraft,
    obsidianReportFolder,
    obsidianReportFolderDraft,
    setObsidianReportFolderDraft,
    obsidianSettingsBusy,
    displayScale,
    setDisplayScale,
  } = settings;

  return (
    <div className="header-menu" ref={containerRef}>
      <button className="menu-button" type="button" aria-label="メニュー" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
        <Menu size={22} />
      </button>
      {menuOpen && (
        <div className={`hamburger-menu ${className}`.trim()} role="menu">
          <section className="settings-group">
            <h4>Git差分</h4>
            <label className="settings-field">
              <span>テキストとして比較する拡張子（カンマ区切り）</span>
              <textarea value={extensionDraft} rows={2} onChange={(event) => setExtensionDraft(event.target.value)} />
            </label>
            <small>画像・STEPは常に対象です。このブラウザに保存されます。</small>
            <div className="settings-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const next = normalizeTextExtensions(extensionDraft);
                  setTextExtensions(next);
                  setExtensionDraft(next.join(", "));
                  onExtensionsApplied?.(next);
                }}
              >
                適用
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setExtensionDraft(DEFAULT_TEXT_EXTENSIONS.join(", "));
                  setTextExtensions(DEFAULT_TEXT_EXTENSIONS);
                }}
              >
                初期値に戻す
              </button>
            </div>
          </section>
          <section className="settings-group">
            <h4>Obsidian連携 <span>サーバーに保存</span></h4>
            <label className="settings-field">
              <span>Obsidianフォルダー（Vault）</span>
              <input
                type="text"
                value={obsidianFolderDraft}
                placeholder="/path/to/obsidian-vault"
                onChange={(event) => setObsidianFolderDraft(event.target.value)}
              />
            </label>
            <small>Markdownを指定したときのリンク解決に使います。</small>
            <label className="settings-field">
              <span>HTMLレポートの保存先</span>
              <input
                type="text"
                value={obsidianReportFolderDraft}
                placeholder="/path/to/report-folder"
                onChange={(event) => setObsidianReportFolderDraft(event.target.value)}
              />
            </label>
            <small>Markdown起点のHTMLレポートをこのフォルダーへ保存します（未設定ならダウンロード）。</small>
            <div className="settings-actions">
              <button type="button" className="btn btn-primary" disabled={obsidianSettingsBusy} onClick={onSaveObsidianSettings}>
                {obsidianSettingsBusy ? "保存中…" : "サーバーへ保存"}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setObsidianFolderDraft(obsidianFolder);
                  setObsidianReportFolderDraft(obsidianReportFolder);
                }}
              >
                変更を戻す
              </button>
            </div>
          </section>
          <section className="settings-group">
            <h4>表示</h4>
            <label className="settings-field">
              <span className="settings-row"><span>アプリの表示倍率</span><output>{Math.round(displayScale * 100)}%</output></span>
              <input
                type="range"
                min="50"
                max="200"
                step="5"
                value={Math.round(displayScale * 100)}
                onChange={(event) => setDisplayScale(Number(event.target.value) / 100)}
              />
            </label>
            <div className="settings-actions">
              <button type="button" className="btn" disabled={displayScale === 1} onClick={() => setDisplayScale(1)}>100%に戻す</button>
            </div>
          </section>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              window.open("/api-guide", "_blank", "noopener,noreferrer");
            }}
          >
            <BookOpenText size={18} />
            APIエンドポイント説明
            <ExternalLink size={16} />
          </button>
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onOpenHelp(); }}>
            <HelpCircle size={18} />
            ショートカットと操作
          </button>
        </div>
      )}
    </div>
  );
}
