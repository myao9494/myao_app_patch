/**
 * ベクトルインデックス更新のベンチマーク。
 * - 検証用プリセット: 画面で作った本文（長文・特殊文字・空・見出しだらけ）のチャンク化と推論の時間を測る。何も保存しない。
 * - ファイルパス指定: サーバー上のファイル 1 件の差分更新を実行して測る（そのファイルのインデックスを更新する）。
 * 直近の結果と履歴を表示する。
 */
import { EVIL_PRESETS } from "../../vectorBenchmarkPresets";
import type { UseVectorManagementResult } from "../../hooks/useVectorManagement";

const PRESET_KEYS = ["LONG", "SPECIAL", "EMPTY", "HEADINGS"] as const;

type VectorBenchmarkPanelProps = {
  vector: UseVectorManagementResult;
};

export function VectorBenchmarkPanel({ vector }: VectorBenchmarkPanelProps) {
  const {
    applyEvilPreset,
    benchmarkHistory,
    benchmarkPath,
    benchmarkResult,
    benchmarking,
    handleRunBenchmark,
    setBenchmarkPath,
  } = vector;

  return (
    <div className="panel glass-panel" style={{ marginBottom: "16px", padding: "18px 22px", borderRadius: "14px" }}>
      <h3 style={{ fontSize: "14.5px", fontWeight: 600, margin: "0 0 8px 0", display: "flex", alignItems: "center", gap: "8px", color: "#f8fafc" }}>
        <span style={{ fontSize: "16px" }}>⏱️</span>
        単一ファイル差分更新ベンチマーク検証
      </h3>
      <div style={{ fontSize: "12px", color: "#94a3b8", marginBottom: "14px" }}>
        指定したファイルの差分更新にかかる各工程（ハッシュ照合、チャンキング、推論、DB保存）の所要時間をミリ秒単位で測定します。
      </div>

      {/* 検証用プリセット（本文だけを測る。ファイルもインデックスも変更しない） */}
      <div style={{ fontSize: "11.5px", color: "#94a3b8", marginBottom: "6px" }}>
        検証用の本文で測る（チャンキングと推論のみ。保存はしません）:
      </div>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "12px" }}>
        {PRESET_KEYS.map((key) => (
          <button
            key={key}
            className="btn btn-secondary btn-sm"
            style={{ fontSize: "11.5px" }}
            onClick={() => void applyEvilPreset(key)}
            disabled={benchmarking}
          >
            {EVIL_PRESETS[key].name}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: "10px", marginBottom: "12px" }}>
        <input
          type="text"
          className="input-field"
          style={{ flex: 1, fontSize: "13px", padding: "8px 12px" }}
          placeholder="検証対象ファイルパス (例: docs/spec.md)"
          value={benchmarkPath}
          onChange={(e) => setBenchmarkPath(e.target.value)}
        />
        <button
          className="btn btn-primary"
          style={{ padding: "0 18px", fontSize: "13px", borderRadius: "8px" }}
          onClick={() => void handleRunBenchmark()}
          disabled={benchmarking}
        >
          {benchmarking ? "測定中..." : "差分更新を実行"}
        </button>
      </div>

      {/* 直近の測定結果 */}
      {benchmarkResult && (
        <div style={{ padding: "12px 16px", backgroundColor: "rgba(0, 0, 0, 0.3)", borderRadius: "8px", border: "1px solid rgba(255, 255, 255, 0.08)", marginBottom: "12px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: "8px", fontSize: "12px" }}>
            <div>総時間: <strong style={{ color: "#38bdf8" }}>{benchmarkResult.total_time_ms?.toFixed(1)} ms</strong></div>
            <div>ハッシュI/O: <strong style={{ color: "#cbd5e1" }}>{benchmarkResult.io_hash_time_ms?.toFixed(1)} ms</strong></div>
            <div>チャンキング: <strong style={{ color: "#cbd5e1" }}>{benchmarkResult.chunking_time_ms?.toFixed(1)} ms</strong></div>
            <div>推論: <strong style={{ color: "#a855f7" }}>{benchmarkResult.embedding_time_ms?.toFixed(1)} ms</strong></div>
            <div>DB書込: <strong style={{ color: "#cbd5e1" }}>{benchmarkResult.db_time_ms?.toFixed(1)} ms</strong></div>
            <div>チャンク数: <strong style={{ color: "#f8fafc" }}>{benchmarkResult.chunk_count}</strong></div>
          </div>
        </div>
      )}

      {/* 測定履歴 */}
      {benchmarkHistory.length > 0 && (
        <div>
          <div style={{ fontSize: "11.5px", color: "#94a3b8", marginBottom: "6px" }}>直近の測定履歴:</div>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            {benchmarkHistory.map((h) => (
              <div key={h.id} style={{ fontSize: "11px", padding: "3px 8px", background: "rgba(255, 255, 255, 0.04)", borderRadius: "4px", border: "1px solid rgba(255, 255, 255, 0.06)" }}>
                {h.timestamp} - <strong>{h.total_ms?.toFixed(1)} ms</strong> ({h.chunks} chunks)
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
