/**
 * ベクトル管理画面の見出しと稼働状況。
 * 推論に使う装置（GPU / CPU）、ベクトル検索エンジン（FAISS / NumPy）、読み込み中のモデルを表示する。
 */
import type { UseVectorManagementResult } from "../../hooks/useVectorManagement";

type VectorStatusHeaderProps = {
  vector: UseVectorManagementResult;
};

export function VectorStatusHeader({ vector }: VectorStatusHeaderProps) {
  const { currentProg, indexProgress, modelStatus } = vector;

  return (
    <div className="panel glass-panel" style={{ marginBottom: "16px", padding: "16px 22px", borderRadius: "14px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
          <div>
            <h2 style={{ fontSize: "17px", fontWeight: 700, margin: 0, display: "flex", alignItems: "center", gap: "8px", color: "#f8fafc" }}>
              <span style={{ fontSize: "18px" }}>🔮</span>
              ベクトル検索設定 & インデックスメンテナンス
            </h2>
            <div style={{ fontSize: "12.5px", color: "#94a3b8", marginTop: "3px" }}>
              Embedding モデルの選択・ロード、差分学習 ⚡、全件再作成 🔄、専門用語辞書 📖、およびリアルタイムベンチマークを管理します。
            </div>
          </div>

          {indexProgress?.is_indexing && (
            <div
              className="badge"
              style={{
                backgroundColor: "rgba(16, 185, 129, 0.2)",
                color: "#34d399",
                border: "1.5px solid rgba(16, 185, 129, 0.5)",
                fontSize: "12.5px",
                padding: "6px 14px",
                borderRadius: "20px",
                display: "inline-flex",
                alignItems: "center",
                gap: "7px",
                fontWeight: 600,
                boxShadow: "0 0 16px rgba(16, 185, 129, 0.35)",
              }}
            >
              <span className="spin" style={{ display: "inline-block", fontSize: "13px" }}>🔄</span>
              <span>
                ベクトルインデックス作成中...
                {currentProg?.progress_pct ? ` (${currentProg.progress_pct}%)` : ""}
              </span>
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          {/* 稼働デバイスバッジ（最上部常時表示） */}
          {modelStatus && (
            <div
              style={{
                fontSize: "12px",
                padding: "6px 13px",
                display: "inline-flex",
                alignItems: "center",
                gap: "7px",
                backgroundColor: modelStatus.device === "mps"
                  ? "rgba(6, 182, 212, 0.2)"
                  : modelStatus.device?.startsWith("cuda")
                  ? "rgba(16, 185, 129, 0.2)"
                  : "rgba(148, 163, 184, 0.15)",
                borderRadius: "8px",
                border: `1.5px solid ${
                  modelStatus.device === "mps"
                    ? "rgba(56, 189, 248, 0.55)"
                    : modelStatus.device?.startsWith("cuda")
                    ? "rgba(52, 211, 153, 0.55)"
                    : "rgba(148, 163, 184, 0.35)"
                }`,
                color: modelStatus.device === "mps"
                  ? "#38bdf8"
                  : modelStatus.device?.startsWith("cuda")
                  ? "#34d399"
                  : "#cbd5e1",
                boxShadow: modelStatus.device === "mps" || modelStatus.device?.startsWith("cuda")
                  ? "0 0 14px rgba(56, 189, 248, 0.3)"
                  : undefined,
                fontWeight: 600,
              }}
              title={modelStatus.device_name || modelStatus.device}
            >
              <span style={{ fontSize: "14px" }}>
                {modelStatus.device === "mps" || modelStatus.device?.startsWith("cuda") ? "⚡" : "💻"}
              </span>
              <span>
                {modelStatus.device === "mps"
                  ? "GPU稼働中: Apple Silicon (Metal)"
                  : modelStatus.device?.startsWith("cuda")
                  ? `GPU稼働中: ${modelStatus.device_name || "CUDA"}`
                  : "CPU稼働中 (フォールバック)"}
              </span>
            </div>
          )}

          {/* ベクトルエンジン状態バッジ（FAISS高速 vs NumPyフォールバック） */}
          {modelStatus && (
            <div
              style={{
                fontSize: "12px",
                padding: "6px 13px",
                display: "inline-flex",
                alignItems: "center",
                gap: "7px",
                backgroundColor: modelStatus.has_faiss !== false
                  ? "rgba(16, 185, 129, 0.2)"
                  : "rgba(245, 158, 11, 0.2)",
                borderRadius: "8px",
                border: `1.5px solid ${
                  modelStatus.has_faiss !== false
                    ? "rgba(52, 211, 153, 0.55)"
                    : "rgba(245, 158, 11, 0.6)"
                }`,
                color: modelStatus.has_faiss !== false ? "#34d399" : "#fbbf24",
                boxShadow: modelStatus.has_faiss === false
                  ? "0 0 14px rgba(245, 158, 11, 0.35)"
                  : undefined,
                fontWeight: 600,
              }}
              title={
                modelStatus.has_faiss !== false
                  ? "FAISS IndexFlatIP による高速内積検索が有効です"
                  : "faiss-cpu が未検出のため NumPy による内積検索フォールバックで動作しています。pip install faiss-cpu で高速化できます。"
              }
            >
              <span style={{ fontSize: "14px" }}>
                {modelStatus.has_faiss !== false ? "⚡" : "⚠️"}
              </span>
              <span>
                {modelStatus.has_faiss !== false
                  ? "エンジン: FAISS (高速)"
                  : "エンジン: NumPy (フォールバック / faiss未導入)"}
              </span>
            </div>
          )}

          <div
            style={{
              fontSize: "12px",
              padding: "6px 14px",
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              backgroundColor: "rgba(30, 41, 59, 0.7)",
              borderRadius: "8px",
              border: "1px solid rgba(255, 255, 255, 0.1)",
              color: "#cbd5e1",
            }}
          >
            <span style={{ fontSize: "14px" }}>💡</span>
            <span>類似語・専門用語は<strong>「検索ルール管理」</strong>で一元管理されています</span>
          </div>
        </div>
      </div>
    </div>
  );
}
