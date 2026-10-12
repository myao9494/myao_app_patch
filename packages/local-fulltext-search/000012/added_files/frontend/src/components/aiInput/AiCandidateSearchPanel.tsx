/**
 * ステップ 1: 質問・キーワードから候補ノートを抽出する入力欄。
 * 検索語・拡張子フィルター・保存先フォルダの表示と、候補の抽出ボタンを持つ。
 */
import type { UseAiCandidatesResult } from "../../hooks/useAiCandidates";
import type { UseAiExportFolderResult } from "../../hooks/useAiExportFolder";

type AiCandidateSearchPanelProps = {
  candidateList: UseAiCandidatesResult;
  exportFolderSettings: UseAiExportFolderResult;
};

export function AiCandidateSearchPanel({ candidateList, exportFolderSettings }: AiCandidateSearchPanelProps) {
  const {
    extensionFilterText,
    handleKeyDown,
    handleSearchCandidates,
    isSearching,
    query,
    setExtensionFilterText,
    setQuery,
  } = candidateList;
  const {
    configToast,
    exportFolder,
    handleOpenFolder,
    isOpeningFolder,
    setIsFolderConfigOpen,
    setTempExportFolder,
  } = exportFolderSettings;

  return (
    <div className="panel glass-panel" style={{ marginBottom: "16px", padding: "18px 22px", borderRadius: "14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
        <h2 style={{ fontSize: "15px", fontWeight: 600, margin: 0, display: "flex", alignItems: "center", gap: "8px", color: "#f8fafc" }}>
          <span>🔍</span>
          ステップ 1: 質問・キーワードで関連候補ノートを抽出
        </h2>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          {/* 保存先フォルダのミニバッジ */}
          <div
            style={{
              fontSize: "11.5px",
              color: "#cbd5e1",
              background: "rgba(255, 255, 255, 0.06)",
              padding: "3px 8px",
              borderRadius: "6px",
              border: "1px solid rgba(255, 255, 255, 0.1)",
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              maxWidth: "240px",
            }}
            title={`現在の保存先フォルダ: ${exportFolder}`}
          >
            <span>📁</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {exportFolder}
            </span>
          </div>

          {/* 保存先フォルダ設定ボタン */}
          <button
            type="button"
            className="btn btn-secondary"
            style={{
              fontSize: "12px",
              padding: "4px 10px",
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              borderRadius: "6px",
              borderColor: "rgba(59, 130, 246, 0.4)",
            }}
            onClick={() => {
              setTempExportFolder(exportFolder);
              setIsFolderConfigOpen(true);
            }}
            title="AIインプット保存先フォルダを設定・サーバーに永続保存します"
          >
            <span>⚙️</span>
            保存先設定
          </button>

          {/* Explorerで開くボタン */}
          <button
            type="button"
            className="btn btn-secondary"
            style={{
              fontSize: "12px",
              padding: "4px 10px",
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              borderRadius: "6px",
            }}
            onClick={() => void handleOpenFolder()}
            disabled={isOpeningFolder}
            title="保存先フォルダをOSのファイルマネージャー（Explorer / Finder）で開きます"
          >
            {isOpeningFolder ? <span className="spin">🔄</span> : <span>📂</span>}
            Explorerで開く
          </button>

          <div style={{ fontSize: "11.5px", color: "#94a3b8", background: "rgba(255, 255, 255, 0.05)", padding: "3px 10px", borderRadius: "6px", border: "1px solid rgba(255, 255, 255, 0.08)" }}>
            ⚡ <strong>ハイブリッド検索（Vector × FTS5）</strong>
          </div>
        </div>
      </div>

      {/* 設定変更時のトースト通知 */}
      {configToast && (
        <div
          style={{
            marginTop: "8px",
            padding: "6px 12px",
            backgroundColor: "rgba(16, 185, 129, 0.15)",
            border: "1px solid rgba(16, 185, 129, 0.4)",
            color: "#34d399",
            borderRadius: "6px",
            fontSize: "12px",
            display: "flex",
            alignItems: "center",
            gap: "6px",
          }}
        >
          <span>{configToast}</span>
        </div>
      )}

      <div style={{ display: "flex", gap: "10px", marginTop: "14px", alignItems: "center" }}>
        <input
          type="text"
          className="input-field"
          style={{ flex: 1, fontSize: "15px", padding: "10px 14px", borderRadius: "8px" }}
          placeholder="AIに回答させたい質問やテーマを入力（例: 次期システム刷新の決定事項、PJ-Xの仕様と課題）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isSearching}
        />
        <input
          className="small-input extension-filter-input"
          style={{
            minWidth: "160px",
            maxWidth: "240px",
            fontSize: "14px",
            padding: "10px 14px",
            borderRadius: "8px",
          }}
          value={extensionFilterText}
          onChange={(e) => setExtensionFilterText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="md excalidraw"
          title="拡張子フィルタ (例: md, -png, -.jpg)"
          aria-label="検索拡張子フィルタ"
          disabled={isSearching}
        />
        <button
          className="btn btn-primary"
          style={{ padding: "0 22px", fontSize: "14px", minWidth: "170px", borderRadius: "8px", fontWeight: 600, height: "42px" }}
          onClick={() => void handleSearchCandidates()}
          disabled={isSearching}
        >
          {isSearching ? (
            <>
              <span className="spin">🔄</span>
              検索中...
            </>
          ) : (
            <>
              <span>✨</span>
              候補ノートを抽出
            </>
          )}
        </button>
      </div>
    </div>
  );
}
