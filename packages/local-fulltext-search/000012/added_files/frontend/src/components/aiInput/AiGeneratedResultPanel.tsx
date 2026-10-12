/**
 * ステップ 3: 生成結果の表示。
 * 生成した HTML のプレビューとソースをタブで切り替え、ダウンロード・コピー・保存・全画面プレビューを行う。
 */
import type { UseAiDocumentBuilderResult } from "../../hooks/useAiDocumentBuilder";
import type { UseAiCandidatesResult } from "../../hooks/useAiCandidates";
import type { UseAiExportFolderResult } from "../../hooks/useAiExportFolder";

type AiGeneratedResultPanelProps = {
  builder: UseAiDocumentBuilderResult;
  candidateList: UseAiCandidatesResult;
  exportFolderSettings: UseAiExportFolderResult;
};

export function AiGeneratedResultPanel({ builder, candidateList, exportFolderSettings }: AiGeneratedResultPanelProps) {
  const {
    copiedHtml,
    copyHtmlCode,
    generatedData,
    handleDownload,
    handleSaveBundle,
    handleSaveHtmlAndCopyPath,
    isSaving,
    isSavingBundle,
    previewTab,
    savedPathFeedback,
    setIsModalOpen,
    setPreviewTab,
    setSavedPathFeedback,
  } = builder;
  const { estimatedTokens } = candidateList;
  const { exportFolder, handleOpenFolder, isOpeningFolder, setExportFolder } = exportFolderSettings;

  // 生成結果があるときだけ表示する画面（呼び出し側でも判定しているが、型の上でも保証する）
  if (!generatedData) {
    return null;
  }

  return (
    <div
      className="panel glass-panel"
      style={{
        marginTop: "20px",
        padding: "18px 22px",
        borderRadius: "14px",
        border: "1px solid rgba(16, 185, 129, 0.4)",
      }}
    >
      {/* 結果ヘッダー */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "12px",
          borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
          paddingBottom: "14px",
          marginBottom: "14px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={{ fontSize: "20px" }}>✅</span>
          <div>
            <strong style={{ fontSize: "15px", color: "#f8fafc" }}>
              自己完結型 HTML ファイルの生成が完了しました！
            </strong>
            <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "2px" }}>
              ドキュメント: {generatedData.total_documents} 件
              {typeof generatedData.total_linked_emails === "number" && generatedData.total_linked_emails > 0 && ` | メール: ${generatedData.total_linked_emails} 件`}
              {typeof generatedData.total_images_embedded === "number" && generatedData.total_images_embedded > 0 && ` | 埋め込み画像: ${generatedData.total_images_embedded} 枚`}
              {" "}| サイズ: {(generatedData.size_bytes / 1024).toFixed(1)} KB | 概算トークン: 約 {estimatedTokens.toLocaleString()}
            </div>
          </div>
        </div>

        {savedPathFeedback && (
          <div
            style={{
              width: "100%",
              marginBottom: "12px",
              padding: "8px 14px",
              borderRadius: "8px",
              background: "rgba(16, 185, 129, 0.15)",
              border: "1px solid rgba(16, 185, 129, 0.4)",
              color: "#10b981",
              fontSize: "13px",
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              wordBreak: "break-all",
            }}
          >
            <span>{savedPathFeedback}</span>
            <button
              className="btn btn-sm btn-secondary"
              style={{ marginLeft: "10px", fontSize: "11px", padding: "2px 8px" }}
              onClick={() => setSavedPathFeedback(null)}
            >
              ✕
            </button>
          </div>
        )}

        {/* アクションボタン群 */}
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
          <button
            className="btn btn-primary"
            style={{ padding: "8px 18px", fontSize: "13.5px", background: "linear-gradient(135deg, #6366f1, #a855f7)", border: "none", fontWeight: 600 }}
            onClick={() => setIsModalOpen(true)}
          >
            <span>👁️</span>
            特大モーダルでプレビュー & 選択調整
          </button>

          {/* 出力先フォルダ入力 */}
          <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "12px", color: "#94a3b8" }}>📁 保存先:</span>
            <input
              type="text"
              className="input-text"
              value={exportFolder}
              onChange={(e) => setExportFolder(e.target.value)}
              style={{
                fontSize: "12px",
                padding: "4px 8px",
                width: "160px",
                borderRadius: "6px",
                backgroundColor: "rgba(0, 0, 0, 0.3)",
                border: "1px solid rgba(255, 255, 255, 0.15)",
                color: "#f8fafc",
              }}
              title="2ファイルの出力先フォルダパス"
            />
          </div>

          {/* 2ファイルを保存ボタン */}
          <button
            className="btn btn-primary"
            style={{
              padding: "8px 18px",
              fontSize: "13.5px",
              background: "linear-gradient(135deg, #10b981, #059669)",
              border: "none",
              fontWeight: 600,
              borderRadius: "8px",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
            }}
            onClick={() => void handleSaveBundle()}
            disabled={isSavingBundle}
            title="マークダウン(.md)と全図面を縦連結した結合画像(<=4.5MB)の2ファイルを保存します"
          >
            {isSavingBundle ? (
              <>
                <span className="spin">🔄</span>
                保存中...
              </>
            ) : (
              <>
                <span>📦</span>
                💾 2ファイルを保存
              </>
            )}
          </button>

          {/* フォルダを開くボタン */}
          <button
            className="btn btn-secondary"
            style={{
              fontSize: "13px",
              padding: "6px 14px",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
            }}
            onClick={() => void handleOpenFolder()}
            disabled={isOpeningFolder}
            title="保存先フォルダをFinder / Explorerで開き、チャットへのドラッグ＆ドロップを容易にします"
          >
            {isOpeningFolder ? <span className="spin">🔄</span> : <span>📂</span>}
            フォルダを開く
          </button>

          {/* HTML 保存＆パスコピーボタン */}
          <button
            className="btn btn-secondary"
            style={{ padding: "8px 18px", fontSize: "13.5px", fontWeight: 600 }}
            onClick={() => void handleSaveHtmlAndCopyPath()}
            disabled={isSaving}
            title="HTMLをローカル保存してパスをコピー"
          >
            <span>💾</span>
            HTML保存
          </button>

          <button
            className="btn btn-secondary"
            style={{ fontSize: "13px", padding: "6px 14px" }}
            onClick={handleDownload}
            title="HTMLダウンロード"
          >
            <span>📥</span>
            HTML DL
          </button>

          <button
            className="btn btn-secondary"
            style={{ fontSize: "13px", padding: "6px 14px" }}
            onClick={copyHtmlCode}
          >
            {copiedHtml ? "✅ コードをコピー完了！" : "📋 HTMLコピー"}
          </button>
        </div>
      </div>

      {/* ビュー切り替えタブ */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
        <button
          className={`btn btn-sm ${previewTab === "preview" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setPreviewTab("preview")}
        >
          <span>👁️</span>
          プレビュー表示
        </button>
        <button
          className={`btn btn-sm ${previewTab === "code" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setPreviewTab("code")}
        >
          <span>📄</span>
          HTMLソース
        </button>
      </div>

      {/* プレビューコンテナ */}
      {previewTab === "preview" ? (
        <div
          className="html-preview-frame-container"
          style={{
            width: "100%",
            height: "560px",
            borderRadius: "8px",
            overflow: "hidden",
            border: "1px solid rgba(255, 255, 255, 0.12)",
            backgroundColor: "#ffffff",
          }}
        >
          <iframe
            title="AI Context HTML Preview"
            srcDoc={generatedData.html_content}
            style={{ width: "100%", height: "100%", border: "none" }}
          />
        </div>
      ) : (
        <pre
          className="rag-code-block"
          style={{
            maxHeight: "500px",
            overflowY: "auto",
            padding: "14px",
            borderRadius: "8px",
            backgroundColor: "rgba(0, 0, 0, 0.4)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            fontSize: "12px",
            color: "#94a3b8",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {generatedData.html_content}
        </pre>
      )}
    </div>
  );
}
