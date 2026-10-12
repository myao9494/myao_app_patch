/**
 * Embedding モデルの選択と読み込み。
 * 軽量モデル・標準モデル・任意のパスから選び、モデルごとのインデックス状況を表示する。
 * FAISS が使えない環境では、導入方法の案内を表示する。
 */
import { ModelStatsBadge } from "./ModelStatsBadge";
import type { UseVectorManagementResult } from "../../hooks/useVectorManagement";

type VectorModelPanelProps = {
  vector: UseVectorManagementResult;
};

export function VectorModelPanel({ vector }: VectorModelPanelProps) {
  const {
    handleLoadModel,
    hasUserManuallySelectedRef,
    indexProgress,
    indexStats,
    isModelActive,
    loadingModel,
    modelMessage,
    modelStatus,
    selectedModelType,
    setSelectedModelType,
  } = vector;

  return (
    <div className="panel glass-panel" style={{ marginBottom: "16px", padding: "18px 22px", borderRadius: "14px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
        <h3 style={{ fontSize: "14.5px", fontWeight: 600, margin: 0, display: "flex", alignItems: "center", gap: "8px", color: "#f8fafc" }}>
          <span style={{ fontSize: "16px" }}>⚙️</span>
          Embedding モデル選択
        </h3>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          {modelStatus?.loaded && (
            <>
              {/* 稼働デバイスバッジ */}
              <span
                className="badge"
                style={{
                  backgroundColor: modelStatus.device === "mps"
                    ? "rgba(6, 182, 212, 0.2)"
                    : modelStatus.device?.startsWith("cuda")
                    ? "rgba(16, 185, 129, 0.2)"
                    : "rgba(148, 163, 184, 0.15)",
                  color: modelStatus.device === "mps"
                    ? "#38bdf8"
                    : modelStatus.device?.startsWith("cuda")
                    ? "#34d399"
                    : "#94a3b8",
                  border: `1px solid ${
                    modelStatus.device === "mps"
                      ? "rgba(56, 189, 248, 0.4)"
                      : modelStatus.device?.startsWith("cuda")
                      ? "rgba(52, 211, 153, 0.4)"
                      : "rgba(148, 163, 184, 0.3)"
                  }`,
                  fontSize: "11.5px",
                  padding: "3px 10px",
                  borderRadius: "6px",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                }}
                title={modelStatus.device_name || modelStatus.device}
              >
                <span style={{ fontSize: "12px" }}>
                  {modelStatus.device === "mps" || modelStatus.device?.startsWith("cuda") ? "⚡" : "💻"}
                </span>
                <span>
                  {modelStatus.device === "mps"
                    ? "GPU加速 (Apple Silicon MPS)"
                    : modelStatus.device?.startsWith("cuda")
                    ? `GPU加速 (${modelStatus.device_name || "CUDA"})`
                    : "CPU (フォールバック)"}
                </span>
              </span>

              {/* ベクトルエンジンバッジ */}
              <span
                className="badge"
                style={{
                  backgroundColor: modelStatus.has_faiss !== false
                    ? "rgba(16, 185, 129, 0.2)"
                    : "rgba(245, 158, 11, 0.2)",
                  color: modelStatus.has_faiss !== false ? "#34d399" : "#fbbf24",
                  border: `1px solid ${
                    modelStatus.has_faiss !== false
                      ? "rgba(52, 211, 153, 0.4)"
                      : "rgba(245, 158, 11, 0.55)"
                  }`,
                  fontSize: "11.5px",
                  padding: "3px 10px",
                  borderRadius: "6px",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  fontWeight: modelStatus.has_faiss === false ? 600 : 400,
                }}
                title={
                  modelStatus.has_faiss !== false
                    ? "FAISS IndexFlatIP による高速内積検索"
                    : "faiss-cpu 未導入のため NumPy 内積フォールバック中"
                }
              >
                <span style={{ fontSize: "12px" }}>{modelStatus.has_faiss !== false ? "⚡" : "⚠️"}</span>
                <span>{modelStatus.has_faiss !== false ? "FAISS" : "NumPy (フォールバック)"}</span>
              </span>

              <span className="badge" style={{ backgroundColor: "rgba(16, 185, 129, 0.2)", color: "#34d399", border: "1px solid rgba(16, 185, 129, 0.4)", fontSize: "11.5px", padding: "3px 10px", borderRadius: "6px", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <span style={{ fontSize: "12px" }}>✅</span>
                ロード済 ({modelStatus.dim}次元 / {modelStatus.current_model})
              </span>
            </>
          )}
        </div>
      </div>

      {/* FAISS 未検出時のガイダンスバナー */}
      {modelStatus && modelStatus.has_faiss === false && (
        <div
          style={{
            backgroundColor: "rgba(245, 158, 11, 0.12)",
            border: "1px solid rgba(245, 158, 11, 0.45)",
            borderRadius: "8px",
            padding: "10px 14px",
            marginTop: "10px",
            marginBottom: "8px",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            fontSize: "12.5px",
            color: "#fef3c7",
            lineHeight: 1.5,
          }}
        >
          <span style={{ fontSize: "18px", flexShrink: 0 }}>⚠️</span>
          <div>
            <strong>FAISS（<code>faiss-cpu</code>）が未検出です:</strong>{" "}
            現在 NumPy による内積検索フォールバックで動作しています。検索機能自体は問題なくご利用いただけますが、より高速なインデックス検索を行うには、ターミナルで <code>pip install -r backend/requirements.txt</code> または <code>pip install faiss-cpu</code> を実行してください。
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "14px", marginTop: "12px" }}>
        {/* 超軽量モデル */}
        {(() => {
          const isLightActive = isModelActive("light");
          const isSelected = selectedModelType === "light";
          return (
            <div
              className="vector-model-card"
              data-model="light"
              role="radio"
              aria-checked={isSelected}
              onClick={() => {
                hasUserManuallySelectedRef.current = true;
                setSelectedModelType("light");
              }}
              style={{
                padding: "15px 18px",
                borderRadius: "12px",
                border: isLightActive
                  ? "2px solid #10b981"
                  : isSelected
                  ? "1.5px dashed rgba(245, 158, 11, 0.7)"
                  : "1px solid rgba(255, 255, 255, 0.08)",
                backgroundColor: isLightActive
                  ? "rgba(16, 185, 129, 0.14)"
                  : isSelected
                  ? "rgba(245, 158, 11, 0.05)"
                  : "rgba(255, 255, 255, 0.02)",
                boxShadow: isLightActive
                  ? "0 0 20px rgba(16, 185, 129, 0.25), inset 0 0 10px rgba(16, 185, 129, 0.05)"
                  : "none",
                cursor: "pointer",
                transition: "all 0.2s ease-in-out",
                position: "relative",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px", flexWrap: "wrap", gap: "6px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <strong style={{ fontSize: "14px", color: "#f8fafc" }}>⚡ 超軽量モデル (ruri-v3-30m)</strong>
                  {isLightActive ? (
                    <span
                      className="badge"
                      style={{
                        backgroundColor: "rgba(16, 185, 129, 0.25)",
                        color: "#34d399",
                        border: "1px solid rgba(16, 185, 129, 0.5)",
                        fontSize: "11px",
                        padding: "2px 8px",
                        borderRadius: "6px",
                        fontWeight: 600,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                        boxShadow: "0 0 8px rgba(16, 185, 129, 0.3)",
                      }}
                    >
                      <span>🟢</span>
                      <span>稼働中 (アクティブ)</span>
                      {indexProgress?.is_indexing && (
                        <span className="spin" style={{ display: "inline-block", fontSize: "10px", marginLeft: "2px" }}>🔄</span>
                      )}
                    </span>
                  ) : isSelected ? (
                    <span
                      className="badge"
                      style={{
                        backgroundColor: "rgba(245, 158, 11, 0.15)",
                        color: "#fbbf24",
                        border: "1px solid rgba(245, 158, 11, 0.4)",
                        fontSize: "11px",
                        padding: "2px 8px",
                        borderRadius: "6px",
                      }}
                    >
                      <span>👉 選択中 (未ロード)</span>
                    </span>
                  ) : (
                    <span
                      className="badge"
                      style={{
                        backgroundColor: "rgba(148, 163, 184, 0.1)",
                        color: "#94a3b8",
                        border: "1px solid rgba(148, 163, 184, 0.2)",
                        fontSize: "11px",
                        padding: "2px 8px",
                        borderRadius: "6px",
                      }}
                    >
                      <span>待機中</span>
                    </span>
                  )}
                </div>
                <ModelStatsBadge modelType="light" indexStats={indexStats} />
              </div>
              <div style={{ fontSize: "12px", color: isLightActive ? "#cbd5e1" : "#94a3b8" }}>
                256次元 | 超高速ベクトル化 (CPU環境推奨・軽量)
              </div>
            </div>
          );
        })()}

        {/* 標準モデル */}
        {(() => {
          const isStandardActive = isModelActive("standard");
          const isSelected = selectedModelType === "standard";
          return (
            <div
              className="vector-model-card"
              data-model="standard"
              role="radio"
              aria-checked={isSelected}
              onClick={() => {
                hasUserManuallySelectedRef.current = true;
                setSelectedModelType("standard");
              }}
              style={{
                padding: "15px 18px",
                borderRadius: "12px",
                border: isStandardActive
                  ? "2px solid #38bdf8"
                  : isSelected
                  ? "1.5px dashed rgba(245, 158, 11, 0.7)"
                  : "1px solid rgba(255, 255, 255, 0.08)",
                backgroundColor: isStandardActive
                  ? "rgba(56, 189, 248, 0.14)"
                  : isSelected
                  ? "rgba(245, 158, 11, 0.05)"
                  : "rgba(255, 255, 255, 0.02)",
                boxShadow: isStandardActive
                  ? "0 0 20px rgba(56, 189, 248, 0.25), inset 0 0 10px rgba(56, 189, 248, 0.05)"
                  : "none",
                cursor: "pointer",
                transition: "all 0.2s ease-in-out",
                position: "relative",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px", flexWrap: "wrap", gap: "6px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <strong style={{ fontSize: "14px", color: "#f8fafc" }}>👑 標準モデル (ruri-v3-310m)</strong>
                  {isStandardActive ? (
                    <span
                      className="badge"
                      style={{
                        backgroundColor: "rgba(56, 189, 248, 0.25)",
                        color: "#38bdf8",
                        border: "1px solid rgba(56, 189, 248, 0.5)",
                        fontSize: "11px",
                        padding: "2px 8px",
                        borderRadius: "6px",
                        fontWeight: 600,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                        boxShadow: "0 0 8px rgba(56, 189, 248, 0.3)",
                      }}
                    >
                      <span>🟢</span>
                      <span>稼働中 (アクティブ)</span>
                      {indexProgress?.is_indexing && (
                        <span className="spin" style={{ display: "inline-block", fontSize: "10px", marginLeft: "2px" }}>🔄</span>
                      )}
                    </span>
                  ) : isSelected ? (
                    <span
                      className="badge"
                      style={{
                        backgroundColor: "rgba(245, 158, 11, 0.15)",
                        color: "#fbbf24",
                        border: "1px solid rgba(245, 158, 11, 0.4)",
                        fontSize: "11px",
                        padding: "2px 8px",
                        borderRadius: "6px",
                      }}
                    >
                      <span>👉 選択中 (未ロード)</span>
                    </span>
                  ) : (
                    <span
                      className="badge"
                      style={{
                        backgroundColor: "rgba(148, 163, 184, 0.1)",
                        color: "#94a3b8",
                        border: "1px solid rgba(148, 163, 184, 0.2)",
                        fontSize: "11px",
                        padding: "2px 8px",
                        borderRadius: "6px",
                      }}
                    >
                      <span>待機中</span>
                    </span>
                  )}
                </div>
                <ModelStatsBadge modelType="standard" indexStats={indexStats} />
              </div>
              <div style={{ fontSize: "12px", color: isStandardActive ? "#cbd5e1" : "#94a3b8" }}>
                768次元 | 最高峰の日本語意味理解精度 (高精度セマンティック検索)
              </div>
            </div>
          );
        })()}
      </div>

      <div style={{ display: "flex", gap: "12px", marginTop: "16px", alignItems: "center", flexWrap: "wrap" }}>
        {(() => {
          const isSelectedActive = isModelActive(selectedModelType);
          return (
            <button
              className={isSelectedActive ? "btn btn-secondary" : "btn btn-primary"}
              style={{
                padding: "8px 22px",
                fontSize: "13.5px",
                fontWeight: 600,
                borderRadius: "8px",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                backgroundColor: !isSelectedActive ? "#0284c7" : undefined,
                borderColor: !isSelectedActive ? "#38bdf8" : undefined,
              }}
              onClick={() => void handleLoadModel()}
              disabled={loadingModel}
            >
              {loadingModel ? (
                "ロード中..."
              ) : isSelectedActive ? (
                <>
                  <span>✅</span>
                  <span>現在稼働中 (再ロード)</span>
                </>
              ) : (
                <>
                  <span>🚀</span>
                  <span>選択したモデルをロードして切替</span>
                </>
              )}
            </button>
          );
        })()}
        {modelMessage && (
          <span style={{ fontSize: "12px", color: modelMessage.includes("失敗") ? "#f87171" : "#34d399" }}>
            {modelMessage}
          </span>
        )}
      </div>
      <div style={{ marginTop: "10px", fontSize: "11.5px", color: "#94a3b8", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "6px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span>💾</span>
          <span>
            選択・稼働したモデルは <code>config.json</code> に自動記憶され、次回サーバー再起動時も自動的に復元・即時検索可能になります。
            {modelStatus?.saved_model_path && (
              <span style={{ color: "#38bdf8", marginLeft: "4px" }}>
                (記憶中: {modelStatus.saved_model_path.split(/[\\/]/).pop()})
              </span>
            )}
          </span>
        </div>
        {modelStatus?.device_name && (
          <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "#cbd5e1" }}>
            <span>🚀 実行デバイス:</span>
            <strong style={{ color: modelStatus.device === "mps" ? "#38bdf8" : modelStatus.device?.startsWith("cuda") ? "#34d399" : "#e2e8f0" }}>
              {modelStatus.device_name}
            </strong>
          </div>
        )}
      </div>
    </div>
  );
}
