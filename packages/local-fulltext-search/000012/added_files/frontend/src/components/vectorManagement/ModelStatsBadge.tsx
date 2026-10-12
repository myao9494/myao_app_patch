/**
 * Embedding モデルごとのインデックス状況を示すバッジ。
 * そのモデルで作成済みのベクトルインデックスがあれば件数と容量を、無ければ「未インデックス」を表示する。
 */
import type { VectorIndexStats } from "../../types";

type ModelStatsBadgeProps = {
  modelType: "light" | "standard";
  indexStats: VectorIndexStats | null;
};

export function ModelStatsBadge({ modelType, indexStats }: ModelStatsBadgeProps) {
  const modelKey = modelType === "light" ? "ruri-v3-30m" : "ruri-v3-310m";
  const stat = indexStats?.models?.[modelKey];

  if (stat && stat.document_count > 0) {
    return (
      <span
        className="badge"
        style={{
          backgroundColor: "rgba(16, 185, 129, 0.15)",
          color: "#34d399",
          border: "1px solid rgba(16, 185, 129, 0.3)",
          fontSize: "11px",
          padding: "2px 8px",
          borderRadius: "4px",
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
        }}
        title={`インデックス保存場所: ${stat.db_path || ""}`}
      >
        <span style={{ fontSize: "11px" }}>💾</span>
        <span>インデックス済: {stat.document_count}件 ({stat.db_size_mb}MB)</span>
      </span>
    );
  }

  return (
    <span
      className="badge"
      style={{
        backgroundColor: "rgba(148, 163, 184, 0.1)",
        color: "#94a3b8",
        border: "1px solid rgba(148, 163, 184, 0.2)",
        fontSize: "11px",
        padding: "2px 8px",
        borderRadius: "4px",
      }}
    >
      <span>未インデックス</span>
    </span>
  );
}
