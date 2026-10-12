/**
 * 設定ドロワー（画面右側に開く設定メニュー）。
 * 検索の既定値（更新間隔・正規表現・表示倍率）、各種設定の保存、管理画面への移動、
 * インデックスの状態表示・中止・失敗ファイル一覧・DB 初期化をまとめる。
 */
import type * as React from "react";
import type { PageView } from "../appTypes";
import type { UseFailedFilesResult } from "../hooks/useFailedFiles";
import type { UseGeneralSettingsResult } from "../hooks/useGeneralSettings";
import type { UseIndexStatusResult } from "../hooks/useIndexStatus";
import type { UseSearchResult } from "../hooks/useSearch";

type SettingsDrawerProps = {
  failedFilesPanel: UseFailedFilesResult;
  generalSettings: UseGeneralSettingsResult;
  indexing: UseIndexStatusResult;
  search: UseSearchResult;
  onChangePage: (nextView: PageView) => Promise<void>;
  onOpenSchedulerPage: () => void;
  onResetDatabase: () => Promise<void>;
  isMenuOpen: boolean;
  isResettingDatabase: boolean;
  onCloseMenu: () => void;
  setUiZoom: React.Dispatch<React.SetStateAction<number>>;
  uiZoom: number;
};

export function SettingsDrawer({
  failedFilesPanel,
  generalSettings,
  indexing,
  search,
  onChangePage,
  onOpenSchedulerPage,
  onResetDatabase,
  isMenuOpen,
  isResettingDatabase,
  onCloseMenu,
  setUiZoom,
  uiZoom,
}: SettingsDrawerProps) {
  const { failedFiles, handleToggleFailedFiles, isFailedFilesOpen } = failedFilesPanel;
  const {
    confirmIndexDeletion,
    ganttParentDraft,
    handleChangeConfirmIndexDeletion,
    handleChangeWebFetchMode,
    handleSaveGanttParent,
    handleSaveObsidianSidebarExplorerDataPath,
    handleSaveWebExcludeKeywords,
    hasUnsavedGanttParent,
    hasUnsavedObsidianSidebarExplorerDataPath,
    hasUnsavedWebExcludeKeywords,
    isSavingConfirmIndexDeletion,
    isSavingGanttParent,
    isSavingObsidianSidebarExplorerDataPath,
    isSavingWebExcludeKeywords,
    isSavingWebFetchMode,
    obsidianSidebarExplorerDataPathDraft,
    setGanttParentDraft,
    setObsidianSidebarExplorerDataPathDraft,
    setWebExcludeKeywordsDraft,
    webExcludeKeywordsDraft,
    webFetchMode,
  } = generalSettings;
  const { indexStatus, indexStatusLabel } = indexing;
  const { refreshWindowMinutes, setRefreshWindowMinutes } = search;

  return (
    <aside className={`settings-drawer ${isMenuOpen ? "open" : ""}`} aria-hidden={!isMenuOpen}>
      <div className="settings-panel">
        <div className="settings-header">
          <h2>設定</h2>
          <button className="secondary-button" onClick={onCloseMenu} type="button">
            閉じる
          </button>
        </div>

        <div className="settings-action-row">
          <button className="secondary-button" onClick={onOpenSchedulerPage} type="button">
            スケジューラー
          </button>
          <div className="form-help">複数フォルダと開始日時を指定し、別プロセスで順次インデックスできます。</div>
        </div>

        <div className="settings-action-row">
          <button className="secondary-button" onClick={() => void onChangePage("vector-management")} type="button">
            ベクトル管理
          </button>
          <div className="form-help">埋め込みモデルの選択・読み込み、ベクトルインデックスの手動更新、専門用語辞書を確認できます。</div>
        </div>

        <div className="settings-action-row">
          <button className="secondary-button" onClick={() => void onChangePage("ai-input")} type="button">
            AIインプット
          </button>
          <div className="form-help">検索結果からコンテキストを選択し、画像・図表をインライン統合した自己完結HTMLを生成します。</div>
        </div>

        <div className="settings-action-row">
          <button className="secondary-button" onClick={() => void onChangePage("launcher")} type="button">
            ランチャー
          </button>
          <div className="form-help">デスクトップランチャーの起動・停止・再起動とログ確認を行います。</div>
        </div>

        <div className="zoom-settings">
          <label className="form-help" htmlFor="ui-zoom">表示倍率 <strong>{uiZoom}%</strong></label>
          <div className="zoom-settings-controls">
            <input id="ui-zoom" type="range" min="75" max="125" step="5" value={uiZoom} onChange={(event) => setUiZoom(Number(event.target.value))} />
            <button className="secondary-button" onClick={() => setUiZoom(100)} type="button">100%に戻す</button>
          </div>
          <div className="form-help">このアプリの表示だけを変更します。ブラウザーのズーム設定には影響しません。</div>
        </div>

        <div className="folder-form">
          <label className="form-help" htmlFor="refresh-window">
            インデックス更新間隔(分)
          </label>
          <input
            id="refresh-window"
            value={refreshWindowMinutes}
            onChange={(event) => setRefreshWindowMinutes(event.target.value)}
            type="number"
            min={0}
          />
          <div className="form-help">
            同じフルパスと階層数の組み合わせで、この分数以内に更新済みなら再走査しません。0 を指定すると検索のたびに差分を更新します。既定は 0 分です。
          </div>

          <div className="extension-panel">
            <button className="secondary-button" onClick={() => void handleToggleFailedFiles()} type="button">
              失敗したファイル
            </button>
            {isFailedFilesOpen ? (
              <div className="extension-menu">
                {failedFiles.length === 0 ? (
                  <div className="form-help">現在、記録されている失敗ファイルはありません。</div>
                ) : (
                  failedFiles.map((item) => (
                    <div className="failed-file-item" key={item.normalized_path}>
                      <div className="failed-file-name">{item.file_name}</div>
                      <div className="failed-file-path">{item.normalized_path}</div>
                      <div className="failed-file-error">{item.error_message}</div>
                      <div className="form-help">{new Date(item.last_failed_at).toLocaleString()}</div>
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </div>

          <label className="form-help" htmlFor="web-exclude-keywords">
            Web除外キーワード
          </label>
          <label className="form-help" htmlFor="web-fetch-mode">
            Webページ取得方式
          </label>
          <select
            id="web-fetch-mode"
            className="settings-select"
            value={webFetchMode}
            disabled={isSavingWebFetchMode}
            onChange={(event) => void handleChangeWebFetchMode(event.target.value as "http" | "edge" | "chrome")}
          >
            <option value="http">通常HTTP（高速・認証なし）</option>
            <option value="edge">Microsoft Edge（会社環境向け）</option>
            <option value="chrome">Google Chrome</option>
          </select>
          <div className="form-help">
            Edge/Chromeはインストール済みの正式版ブラウザを画面ありで起動し、専用プロファイルへ認証状態を保持します。拡張機能やブラウザ本体の追加ダウンロードは不要です。
          </div>
          <textarea
            id="web-exclude-keywords"
            className="settings-textarea"
            value={webExcludeKeywordsDraft}
            onChange={(event) => setWebExcludeKeywordsDraft(event.target.value)}
            placeholder="/tag/&#10;?replytocom=&#10;/login"
            rows={8}
          />
          <div className="settings-action-row">
            <button
              className="secondary-button settings-save-button"
              onClick={() => void handleSaveWebExcludeKeywords()}
              type="button"
              disabled={!hasUnsavedWebExcludeKeywords || isSavingWebExcludeKeywords}
            >
              {isSavingWebExcludeKeywords ? "保存中..." : "保存"}
            </button>
            <div className={`settings-save-status ${hasUnsavedWebExcludeKeywords ? "dirty" : "saved"}`}>
              {hasUnsavedWebExcludeKeywords ? "未保存の変更があります" : "保存済み"}
            </div>
          </div>
          <div className="form-help">
            WebページのURLに含まれる文字列を1行1キーワードで指定します。ローカルフォルダ用の除外キーワードとは独立しています。
          </div>

          <label className="form-help" htmlFor="obsidian-sidebar-explorer-data-path">
            Obsidian sidebar-explorer data.json パス
          </label>
          <textarea
            id="obsidian-sidebar-explorer-data-path"
            className="settings-textarea"
            value={obsidianSidebarExplorerDataPathDraft}
            onChange={(event) => setObsidianSidebarExplorerDataPathDraft(event.target.value)}
            placeholder="/Users/name/Vault/.obsidian/plugins/obsidian-sidebar-explorer/data.json"
            rows={3}
          />
          <div className="settings-action-row">
            <button
              className="secondary-button settings-save-button"
              onClick={() => void handleSaveObsidianSidebarExplorerDataPath()}
              type="button"
              disabled={!hasUnsavedObsidianSidebarExplorerDataPath || isSavingObsidianSidebarExplorerDataPath}
            >
              {isSavingObsidianSidebarExplorerDataPath ? "保存中..." : "保存"}
            </button>
            <div className={`settings-save-status ${hasUnsavedObsidianSidebarExplorerDataPath ? "dirty" : "saved"}`}>
              {hasUnsavedObsidianSidebarExplorerDataPath ? "未保存の変更があります" : "保存済み"}
            </div>
          </div>
          <div className="form-help">
            環境ごとに異なる Obsidian Vault の sidebar-explorer `data.json` を指定します。未設定なら既定パスを使います。
          </div>

          <label className="form-help" htmlFor="gantt-parent">
            gantt parent
          </label>
          <input
            id="gantt-parent"
            value={ganttParentDraft}
            onChange={(event) => setGanttParentDraft(event.target.value)}
            type="number"
            min={0}
          />
          <div className="settings-action-row">
            <button
              className="secondary-button settings-save-button"
              onClick={() => void handleSaveGanttParent()}
              type="button"
              disabled={!hasUnsavedGanttParent || isSavingGanttParent}
            >
              {isSavingGanttParent ? "保存中..." : "保存"}
            </button>
            <div className={`settings-save-status ${hasUnsavedGanttParent ? "dirty" : "saved"}`}>
              {hasUnsavedGanttParent ? "未保存の変更があります" : "保存済み"}
            </div>
          </div>
          <div className="form-help">
            ランチャーのメモ画面から gantt タスクを追加するときの親タスク ID です。
          </div>

          <div className="extension-panel">
            <label className="checkbox-label" htmlFor="confirm-index-deletion">
              <input
                id="confirm-index-deletion"
                type="checkbox"
                checked={confirmIndexDeletion}
                disabled={isSavingConfirmIndexDeletion}
                onChange={(event) => void handleChangeConfirmIndexDeletion(event.target.checked)}
              />
              <span>インデックス削除時に確認する（削除通知）</span>
            </label>
            <div className="form-help">
              検索対象から拡張子を外した時やインデックス削除を行う際に、既存データの削除可否を確認します。
            </div>
          </div>

          <div className="extension-panel">
            <button
              className="secondary-button danger"
              onClick={() => void onResetDatabase()}
              type="button"
              disabled={isResettingDatabase}
            >
              {isResettingDatabase ? "初期化中..." : "データベースを初期化"}
            </button>
            <div className="form-help">
              検索インデックス、対象キャッシュ、失敗履歴を空に戻します。次回検索時に必要な範囲だけ再作成します。
            </div>
          </div>

          <hr className="divider" />

          <div className="status-card">
            <div>最終完了: {indexStatus?.last_finished_at ? new Date(indexStatus.last_finished_at).toLocaleString() : "-"}</div>
            <div>総ファイル数: {indexStatus?.total_files ?? 0}</div>
            <div>エラー件数: {indexStatus?.error_count ?? 0}</div>
            <div>状態: {indexStatusLabel}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
