/**
 * AIインプット用ドキュメントの保存先フォルダを設定するダイアログ。
 */
import type { UseAiExportFolderResult } from "../../hooks/useAiExportFolder";

type AiExportFolderModalProps = {
  exportFolderSettings: UseAiExportFolderResult;
};

export function AiExportFolderModal({ exportFolderSettings }: AiExportFolderModalProps) {
  const {
    handleSaveExportFolderConfig,
    isSavingConfig,
    setIsFolderConfigOpen,
    setTempExportFolder,
    tempExportFolder,
  } = exportFolderSettings;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        backgroundColor: "rgba(0, 0, 0, 0.75)",
        backdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10000,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) setIsFolderConfigOpen(false);
      }}
    >
      <div
        className="glass-panel ai-folder-config-modal"
        role="dialog"
        aria-modal="true"
        aria-label="AIインプットの保存先フォルダ設定"
        style={{
          backgroundColor: "rgba(15, 23, 42, 0.96)",
          border: "1px solid rgba(255, 255, 255, 0.16)",
          borderRadius: "14px",
          padding: "24px 26px",
          width: "520px",
          maxWidth: "92vw",
          boxShadow: "0 24px 48px rgba(0, 0, 0, 0.7)",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        {/* モーダルヘッダー */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600, color: "#f8fafc", display: "flex", alignItems: "center", gap: "8px" }}>
            <span>📁</span> 保存先フォルダの設定
          </h3>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ padding: "4px 8px", fontSize: "12px", borderRadius: "6px" }}
            onClick={() => setIsFolderConfigOpen(false)}
          >
            ✕
          </button>
        </div>

        <div style={{ fontSize: "12.5px", color: "#94a3b8", lineHeight: "1.6" }}>
          AIインプット用の統合マークダウン（<code>.md</code>）および図面PDF（<code>.pdf</code>、1ページ1図）を保存するローカルフォルダを指定します。
          <br />
          設定したフォルダは<strong>サーバー側に永続保存</strong>され、次回アプリ起動時や画面再読み込み時にも自動的に初期指定されます。
        </div>

        {/* パス入力欄 */}
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <label style={{ fontSize: "12.5px", color: "#cbd5e1", fontWeight: 500 }}>
            保存先フォルダパス:
          </label>
          <input
            type="text"
            className="input-field"
            style={{
              fontSize: "13.5px",
              padding: "10px 14px",
              borderRadius: "8px",
              width: "100%",
              boxSizing: "border-box",
              backgroundColor: "rgba(0, 0, 0, 0.35)",
              border: "1px solid rgba(255, 255, 255, 0.2)",
              color: "#f8fafc",
            }}
            value={tempExportFolder}
            onChange={(e) => setTempExportFolder(e.target.value)}
            placeholder="例: ~/Desktop/AI_Inputs または C:\Users\user\AI_Inputs"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void handleSaveExportFolderConfig();
              } else if (e.key === "Escape") {
                setIsFolderConfigOpen(false);
              }
            }}
          />
          <span style={{ fontSize: "11px", color: "#64748b" }}>
            ※「~」から始まるパスはユーザーのホームディレクトリに自動展開されます。
          </span>
        </div>

        {/* ボタン群 */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "8px" }}>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ fontSize: "12px", padding: "6px 12px", display: "inline-flex", alignItems: "center", gap: "5px" }}
            onClick={() => setTempExportFolder("~/Desktop/AI_Inputs")}
            title="初期値 ~/Desktop/AI_Inputs にリセットします"
          >
            <span>🔄</span> 既定値に戻す
          </button>

          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ fontSize: "12.5px", padding: "6px 14px" }}
              onClick={() => setIsFolderConfigOpen(false)}
            >
              キャンセル
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{
                fontSize: "12.5px",
                padding: "6px 18px",
                fontWeight: 600,
                background: "linear-gradient(135deg, #3b82f6, #1d4ed8)",
                border: "none",
                borderRadius: "8px",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
              onClick={() => void handleSaveExportFolderConfig()}
              disabled={isSavingConfig}
            >
              {isSavingConfig ? (
                <>
                  <span className="spin">🔄</span>
                  保存中...
                </>
              ) : (
                <>
                  <span>💾</span>
                  設定を保存
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
