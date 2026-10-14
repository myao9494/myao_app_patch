/**
 * ベクトルインデックスの管理。
 * 差分更新と全件再作成を開始し、実行中の進捗と、完了した処理の結果（件数・所要時間）を表示する。
 * 実行中は中止でき、中止した結果は「完了」ではなく「中止」として表示する。
 */
import type { UseVectorManagementResult } from "../../hooks/useVectorManagement";

type VectorIndexPanelProps = {
  vector: UseVectorManagementResult;
};

export function VectorIndexPanel({ vector }: VectorIndexPanelProps) {
  const {
    currentProg,
    handleCancelIndex,
    handleStartIndex,
    indexMode,
    indexProgress,
    isCancellingIndex,
    isStartingIndex,
    lastResult,
    modelStatus,
  } = vector;
  const wasCancelled = Boolean(lastResult?.cancelled);

  return (
    <div
      className="panel glass-panel"
      style={{
        marginBottom: "16px",
        padding: "18px 22px",
        borderRadius: "14px",
        border: indexProgress?.is_indexing ? "1.5px solid rgba(16, 185, 129, 0.45)" : undefined,
        boxShadow: indexProgress?.is_indexing ? "0 0 24px rgba(16, 185, 129, 0.18)" : undefined,
        transition: "all 0.3s ease",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px", marginBottom: "14px" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <h3 style={{ fontSize: "14.5px", fontWeight: 600, margin: 0, display: "flex", alignItems: "center", gap: "8px", color: "#f8fafc" }}>
              <span style={{ fontSize: "16px" }}>💾</span>
              インデックス管理 & 差分学習
            </h3>
            {indexProgress?.is_indexing && (
              <span
                className="badge"
                style={{
                  backgroundColor: "rgba(56, 189, 248, 0.2)",
                  color: "#38bdf8",
                  border: "1px solid rgba(56, 189, 248, 0.4)",
                  fontSize: "11px",
                  padding: "3px 9px",
                  borderRadius: "6px",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  fontWeight: 600,
                }}
              >
                <span className="spin" style={{ display: "inline-block", fontSize: "11px" }}>🔄</span>
                <span>インデックス同期中</span>
              </span>
            )}
          </div>
          <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "2px" }}>
            全件再作成と、変更ファイルのみを高速に更新する差分更新を明示的に切り替えられます。
            {modelStatus?.device_name && (
              <span style={{ marginLeft: "8px", color: modelStatus.device === "mps" ? "#38bdf8" : modelStatus.device?.startsWith("cuda") ? "#34d399" : "#cbd5e1", fontWeight: 500 }}>
                (実行デバイス: {modelStatus.device === "mps" ? "⚡ Apple Silicon GPU" : modelStatus.device?.startsWith("cuda") ? `⚡ ${modelStatus.device_name}` : "💻 CPU"})
              </span>
            )}
          </div>
        </div>

        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          {/* ⚡ 差分インデックス更新 */}
          <button
            className="btn btn-primary"
            style={{
              background: "linear-gradient(135deg, #10b981 0%, #06b6d4 100%)",
              border: "none",
              fontSize: "13.5px",
              fontWeight: 600,
              padding: "8px 18px",
              borderRadius: "8px",
              boxShadow: "0 2px 10px rgba(16, 185, 129, 0.25)",
            }}
            onClick={() => void handleStartIndex(false)}
            disabled={isStartingIndex || indexProgress?.is_indexing}
          >
            <span style={{ fontSize: "14px" }}>⚡</span>
            <span>{indexProgress?.is_indexing && indexMode === "incremental" ? "差分更新中..." : "差分インデックス更新"}</span>
          </button>

          {/* 🔄 全件再インデックス */}
          <button
            className="btn btn-secondary"
            style={{ fontSize: "13px", padding: "8px 16px", borderRadius: "8px" }}
            onClick={() => void handleStartIndex(true)}
            disabled={isStartingIndex || indexProgress?.is_indexing}
          >
            <span className={indexProgress?.is_indexing && indexMode === "full" ? "spin" : ""} style={{ display: "inline-block", fontSize: "14px" }}>🔄</span>
            <span>{indexProgress?.is_indexing && indexMode === "full" ? "全件再作成中..." : "全件再インデックス"}</span>
          </button>

          {/* 実行中だけ表示する中止ボタン */}
          {indexProgress?.is_indexing && (
            <button
              className="btn btn-secondary"
              style={{ fontSize: "13px", padding: "8px 16px", borderRadius: "8px", color: "#fca5a5", borderColor: "rgba(248, 113, 113, 0.5)" }}
              onClick={() => void handleCancelIndex()}
              disabled={isCancellingIndex}
            >
              {isCancellingIndex ? "中止を要求しました..." : "中止"}
            </button>
          )}
        </div>
      </div>

      {/* 実行中プログレスバー */}
      {indexProgress?.is_indexing && (
        <div style={{ padding: "12px 16px", backgroundColor: "rgba(0, 0, 0, 0.3)", borderRadius: "10px", border: "1px solid rgba(255, 255, 255, 0.08)", marginBottom: "14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "8px" }}>
            <span style={{ color: "#cbd5e1" }}>
              <strong style={{ color: indexMode === "incremental" ? "#34d399" : "#38bdf8", marginRight: "6px" }}>
                [{indexMode === "incremental" ? "⚡ 差分更新" : "🔄 全件再作成"}]
              </strong>
              {currentProg?.current_file || "処理中..."}
            </span>
            <span style={{ fontWeight: 600, color: "#38bdf8" }}>
              {currentProg?.processed_files || 0} / {currentProg?.total_files || 0} ファイル ({currentProg?.progress_pct || 0}%)
            </span>
          </div>
          <div style={{ width: "100%", height: "8px", backgroundColor: "rgba(255, 255, 255, 0.08)", borderRadius: "4px", overflow: "hidden" }}>
            <div
              style={{
                width: `${currentProg?.progress_pct || 0}%`,
                height: "100%",
                backgroundColor: indexMode === "incremental" ? "#10b981" : "#38bdf8",
                transition: "width 0.2s ease",
              }}
            />
          </div>
          {currentProg && currentProg.estimated_remaining_sec > 0 && (
            <div style={{ fontSize: "11px", color: "#94a3b8", marginTop: "4px", textAlign: "right" }}>
              推定残り時間: 約 {currentProg.estimated_remaining_sec} 秒 (経過: {currentProg.elapsed_sec}秒)
            </div>
          )}
        </div>
      )}

      {/* インデックス完了サマリー */}
      {lastResult && (
        <div
          style={{
            padding: "14px 18px",
            backgroundColor: wasCancelled ? "rgba(251, 191, 36, 0.08)" : "rgba(16, 185, 129, 0.08)",
            border: wasCancelled ? "1px solid rgba(251, 191, 36, 0.35)" : "1px solid rgba(16, 185, 129, 0.3)",
            borderRadius: "10px",
            fontSize: "12.5px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px", color: wasCancelled ? "#fbbf24" : "#34d399", fontWeight: 600, marginBottom: "8px" }}>
            <span style={{ fontSize: "15px" }}>{wasCancelled ? "⏹" : "✅"}</span>
            <span>
              {wasCancelled
                ? "インデックス作成を中止しました（ここまでに処理した分は保存済みです）"
                : indexMode === "incremental"
                  ? "⚡ 差分インデックス更新完了"
                  : "🔄 全件再インデックス完了"}
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "10px", color: "#94a3b8" }}>
            <div>新規追加: <strong style={{ color: "#34d399" }}>{lastResult.new_count ?? 0}</strong></div>
            <div>更新: <strong style={{ color: "#38bdf8" }}>{lastResult.updated_count ?? 0}</strong></div>
            <div>変更なし(スキップ): <strong style={{ color: "#f8fafc" }}>{lastResult.skipped_count ?? 0}</strong></div>
            <div>削除: <strong style={{ color: "#f87171" }}>{lastResult.deleted_count ?? 0}</strong></div>
            <div>総ノート数: <strong style={{ color: "#f8fafc" }}>{lastResult.document_count ?? 0}</strong></div>
            <div>総チャンク数: <strong style={{ color: "#f8fafc" }}>{lastResult.chunk_count ?? 0}</strong></div>
            <div>所要時間: <strong style={{ color: "#f8fafc" }}>{lastResult.indexing_time_sec != null ? Number(lastResult.indexing_time_sec).toFixed(2) : "0.00"}s</strong></div>
            <div>DBサイズ: <strong style={{ color: "#f8fafc" }}>{lastResult.db_size_mb ?? 0} MB</strong></div>
          </div>
        </div>
      )}
    </div>
  );
}
