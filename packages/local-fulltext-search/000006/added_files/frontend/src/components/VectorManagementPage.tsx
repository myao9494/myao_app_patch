/**
 * ベクトル検索設定およびインデックスメンテナンス用ページコンポーネント (Vector Management)。
 * 仕様:
 * - Embedding モデル選択（超軽量 ruri-v3-30m 256d vs 標準 ruri-v3-310m 768d、カスタムパス、モデルロード）。
 * - 現在アクティブ（稼働中）なモデルの視覚的強調ハイライト（発光・ボーダー・🟢稼働中バッジ）およびステータス自動同期。
 * - 各モデルごとの個別インデックス状態（登録ノート件数・DBサイズMB / 未インデックス）の視覚的バッジ表示。
 * - ⚡ 差分インデックス更新（差分学習: force=false）および 🔄 全件再インデックス（クリーン再作成: force=true）。
 * - リアルタイム進捗バー（処理ファイル数/全件数、百分率、現在ファイル、経過秒、推定残り秒）。
 * - インデックス完了サマリー（新規、更新、スキップ、削除、総ノート数、総チャンク数、所要秒数、DBサイズ）。
 * - 専門用語辞書（Glossary）モーダルエディタ（サンプル一括挿入 PJ-X/ポチッと君/SLA/DB、インライン編集、Excel保存）。
 * - 単一ファイル差分更新ベンチマークパネル（意地悪プリセット: 超長文/特殊記号/空ファイル/見出し乱舞、ミリ秒プロファイリング、履歴）。
 **/

import React, { useEffect, useState, useRef } from "react";
import {
  fetchAppSettings,
  fetchVectorModelStatus,
  loadVectorModel,
  startVectorIndex,
  fetchVectorIndexProgress,
  fetchVectorIndexStats,
  fetchVectorPendingDeletions,
  updateVectorSingleFile,
} from "../api/client";
import type { VectorModelStatus, VectorIndexProgress, VectorIndexStats } from "../types";

// 意地悪テストプリセット定義
export const EVIL_PRESETS = {
  LONG: {
    name: "🔥 超長文 (10,000文字)",
    generate: (title: string) => {
      let body = `# ${title || "超長文負荷テスト"}\n\n`;
      for (let i = 1; i <= 25; i++) {
        body += `## 第${i}セクション 高負荷検証用テキストブロック ${i}\n`;
        body += `これは社内検索システムのベクトル更新性能を極限まで検証するためのテストデータです。\n`;
        body += `自然言語処理モデルの推論スループットおよびチャンク分割の耐久性を確認します。\n\n`;
      }
      return body;
    },
  },
  SPECIAL: {
    name: "💣 特殊記号 & XSS",
    generate: (title: string) => {
      return (
        `# ${title || "特殊記号テスト"} <script>alert('test')</script>\n\n` +
        `## 記号乱舞 !@#$%^&*()_+{}[]|:;"'<>?,./~\\\n\n` +
        `- [[ノート名|別名エイリアス]]\n` +
        `- [タグ: #AI #検証_2026 #テスト/階層/タグ]\n` +
        `- 数式: $E=mc^2$ および $$\\sum_{i=1}^n x_i$$\n` +
        `\`\`\`python\ndef evil_code():\n    return "特殊エスケープ \\n \\t \\r"\n\`\`\`\n`
      );
    },
  },
  EMPTY: {
    name: "📄 空ファイル",
    generate: () => "",
  },
  HEADINGS: {
    name: "📑 見出し乱舞 (30階層)",
    generate: (title: string) => {
      let body = `# ${title || "見出し構造テスト"}\n\n`;
      for (let i = 1; i <= 15; i++) {
        body += `## レベル2 見出し ${i}\n本文1行目\n### レベル3 見出し ${i}-A\n本文2行目\n#### レベル4 見出し ${i}-B\n本文3行目\n\n`;
      }
      return body;
    },
  },
};

export function VectorManagementPage({ confirmIndexDeletion }: { confirmIndexDeletion?: boolean } = {}) {
  const [modelStatus, setModelStatus] = useState<VectorModelStatus | null>(null);
  const [selectedModelType, setSelectedModelType] = useState<"light" | "standard" | "custom">("light");
  const [customPath, setCustomPath] = useState("");
  const [loadingModel, setLoadingModel] = useState(false);
  const [modelMessage, setModelMessage] = useState<string | null>(null);
  const hasUserManuallySelectedRef = useRef(false);

  // インデックス実行ステータス
  const [indexProgress, setIndexProgress] = useState<VectorIndexProgress | null>(null);
  const [indexStats, setIndexStats] = useState<VectorIndexStats | null>(null);
  const [isStartingIndex, setIsStartingIndex] = useState(false);
  const [indexMode, setIndexMode] = useState<"incremental" | "full">("incremental");

  // 専門用語辞書モーダル
  const [isGlossaryOpen, setIsGlossaryOpen] = useState(false);

  // 単一ファイルベンチマーク
  const [benchmarkPath, setBenchmarkPath] = useState("sample_benchmark.md");
  const [benchmarkContent, setBenchmarkContent] = useState(
    "# 差分更新テストノート\n\n## 概要\nこのノートを編集して、モデルの差分更新時間をリアルタイムに検証します。\n"
  );
  const [benchmarkResult, setBenchmarkResult] = useState<any>(null);
  const [benchmarking, setBenchmarking] = useState(false);
  const [benchmarkHistory, setBenchmarkHistory] = useState<any[]>([]);

  const progressIntervalRef = useRef<number | null>(null);

  // 初期ロード & 状態取得
  const refreshData = async () => {
    try {
      const [st, stats, prog] = await Promise.all([
        fetchVectorModelStatus(),
        fetchVectorIndexStats(),
        fetchVectorIndexProgress(),
      ]);
      setModelStatus(st);
      setIndexStats(stats);
      setIndexProgress(prog);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    void refreshData();
  }, []);

  // インデックス処理中のポーリング監視
  useEffect(() => {
    const checkProgress = async () => {
      try {
        const prog = await fetchVectorIndexProgress();
        setIndexProgress(prog);
        if (!prog.is_indexing) {
          if (progressIntervalRef.current) {
            clearInterval(progressIntervalRef.current);
            progressIntervalRef.current = null;
          }
          void refreshData();
        }
      } catch (e) {
        console.error(e);
      }
    };

    if (isStartingIndex || indexProgress?.is_indexing) {
      if (!progressIntervalRef.current) {
        progressIntervalRef.current = window.setInterval(checkProgress, 800);
      }
    }
    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
    };
  }, [isStartingIndex, indexProgress?.is_indexing]);

  // モデル別インデックス状態バッジの算出
  const getModelStatsBadge = (type: "light" | "standard") => {
    const modelKey = type === "light" ? "ruri-v3-30m" : "ruri-v3-310m";
    const stat = (indexStats as any)?.models?.[modelKey];

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
  };

  // 現在バックエンドでロードされ稼働中（アクティブ）のモデルかを判定
  const isModelActive = (type: "light" | "standard") => {
    if (!modelStatus?.loaded) return false;
    const targetKey = type === "light" ? "ruri-v3-30m" : "ruri-v3-310m";
    return Boolean(
      (modelStatus.current_model && modelStatus.current_model.includes(targetKey)) ||
      (modelStatus.model_path && modelStatus.model_path.includes(targetKey))
    );
  };

  // 選択中のモデルパスを取得
  const getSelectedModelPath = () => {
    if (selectedModelType === "light") {
      return modelStatus?.default_light_path || "models/ruri-v3-30m";
    } else if (selectedModelType === "standard") {
      return modelStatus?.default_standard_path || "models/ruri-v3-310m";
    } else {
      return customPath.trim();
    }
  };

  // モデルのロード実行
  const handleLoadModel = async () => {
    setLoadingModel(true);
    setModelMessage(null);
    try {
      const path = getSelectedModelPath();
      const res = await loadVectorModel(path);
      setModelMessage(`モデルをロードしました (${res.dim}次元)`);
      hasUserManuallySelectedRef.current = false;
      await refreshData();
    } catch (e: any) {
      setModelMessage(`ロード失敗: ${e.message}`);
    } finally {
      setLoadingModel(false);
    }
  };

  // インデックス開始（差分更新 vs 全件再作成）
  const handleStartIndex = async (force: boolean) => {
    if (force && !window.confirm("現在のモデルのベクトルインデックスを完全に初期化し、全ファイルを再構築しますか？")) {
      return;
    }
    const targetModelPath = getSelectedModelPath();

    let cleanDeletedFiles = false;
    if (!force) {
      // 差分更新時: 削除通知設定を確認し、削除対象があれば事前に確認ダイアログを表示
      let effectiveConfirm = confirmIndexDeletion;
      if (effectiveConfirm === undefined) {
        const settings = await fetchAppSettings().catch(() => null);
        effectiveConfirm = settings?.confirm_index_deletion ?? true;
      }

      if (effectiveConfirm) {
        try {
          const pendingRes = await fetchVectorPendingDeletions(undefined, targetModelPath);
          if (pendingRes.count > 0) {
            const sample = pendingRes.pending_deletions.slice(0, 5).map((p) => `・${p}`).join("\n");
            const more = pendingRes.count > 5 ? `\n...他 ${pendingRes.count - 5} 件` : "";
            const ok = window.confirm(
              `前回のインデックスに登録されていた以下の ${pendingRes.count} 件のファイルが、今回のフォルダ走査で見つかりませんでした（移動・削除・除外等の可能性があります）:\n\n${sample}${more}\n\nこれら ${pendingRes.count} 件のインデックスデータを削除しますか？\n（「キャンセル」を選択した場合、インデックスを削除せず保持したまま新規・更新ファイルのみ安全に同期します【推奨】）`,
            );
            cleanDeletedFiles = ok;
          }
        } catch (e) {
          console.warn("Could not check pending deletions:", e);
        }
      }
    } else {
      // 全件再作成時はクリーン再作成のため削除フラグも有効
      cleanDeletedFiles = true;
    }

    setIndexMode(force ? "full" : "incremental");
    setIsStartingIndex(true);
    try {
      // 選択中のモデルが未ロード、または現在ロード中のモデルと異なる場合は事前にロード
      const isAlreadyLoaded = modelStatus?.loaded && (
        modelStatus.model_path === targetModelPath ||
        (targetModelPath && modelStatus.model_path?.endsWith(targetModelPath)) ||
        (modelStatus.current_model && targetModelPath.includes(modelStatus.current_model))
      );
      if (!isAlreadyLoaded && targetModelPath) {
        setModelMessage("選択されたモデルをロード中...");
        await loadVectorModel(targetModelPath);
        await refreshData();
      }
      await startVectorIndex(force, undefined, targetModelPath, cleanDeletedFiles);
      setIndexProgress({ is_indexing: true, progress: null, last_result: null });
      setModelMessage(null);
    } catch (e: any) {
      alert(`インデックス開始エラー: ${e.message}`);
      setIsStartingIndex(false);
    }
  };


  // 単一ファイルベンチマーク実行
  const handleRunBenchmark = async (overrideContent?: string) => {
    if (!benchmarkPath.trim()) {
      alert("検証対象のファイルパスを入力してください");
      return;
    }
    setBenchmarking(true);
    try {
      const res = await updateVectorSingleFile(benchmarkPath.trim());
      setBenchmarkResult(res);
      setBenchmarkHistory((prev) => [
        {
          id: Date.now(),
          timestamp: new Date().toLocaleTimeString(),
          file: res.file_path,
          status: res.status,
          chunks: res.chunks,
          total_ms: res.total_time_ms,
          embedding_ms: res.embedding_time_ms,
        },
        ...prev.slice(0, 7),
      ]);
      await refreshData();
    } catch (e: any) {
      alert(`ベンチマークエラー: ${e.message}`);
    } finally {
      setBenchmarking(false);
    }
  };

  // 意地悪テストプリセットの適用
  const applyEvilPreset = (key: keyof typeof EVIL_PRESETS) => {
    const preset = EVIL_PRESETS[key];
    if (!preset) return;
    const generated = preset.generate(benchmarkPath.replace(/\.[^/.]+$/, ""));
    setBenchmarkContent(generated);
    void handleRunBenchmark(generated);
  };

  const currentProg = indexProgress?.progress;
  const lastResult = indexProgress?.last_result;

  return (
    <div className="vector-management-container" style={{ padding: "16px 20px" }}>
      {/* ヘッダー */}
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

      {/* 1. Embedding モデル設定 & 個別インデックス状況 */}
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
                  {getModelStatsBadge("light")}
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
                  {getModelStatsBadge("standard")}
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
            const isSelectedActive = isModelActive(selectedModelType as "light" | "standard");
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

      {/* 2. インデックス管理 & 進捗サマリー */}
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
              backgroundColor: "rgba(16, 185, 129, 0.08)",
              border: "1px solid rgba(16, 185, 129, 0.3)",
              borderRadius: "10px",
              fontSize: "12.5px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#34d399", fontWeight: 600, marginBottom: "8px" }}>
              <span style={{ fontSize: "15px" }}>✅</span>
              <span>
                {indexMode === "incremental" ? "⚡ 差分インデックス更新完了" : "🔄 全件再インデックス完了"}
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

      {/* 3. 単一ファイル差分更新ベンチマークパネル */}
      <div className="panel glass-panel" style={{ marginBottom: "16px", padding: "18px 22px", borderRadius: "14px" }}>
        <h3 style={{ fontSize: "14.5px", fontWeight: 600, margin: "0 0 8px 0", display: "flex", alignItems: "center", gap: "8px", color: "#f8fafc" }}>
          <span style={{ fontSize: "16px" }}>⏱️</span>
          単一ファイル差分更新ベンチマーク検証
        </h3>
        <div style={{ fontSize: "12px", color: "#94a3b8", marginBottom: "14px" }}>
          指定したファイルの差分更新にかかる各工程（ハッシュ照合、チャンキング、推論、DB保存）の所要時間をミリ秒単位で測定します。
        </div>

        {/* 意地悪テストプリセット */}
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "12px" }}>
          <button className="btn btn-secondary btn-sm" style={{ fontSize: "11.5px" }} onClick={() => applyEvilPreset("LONG")}>
            {EVIL_PRESETS.LONG.name}
          </button>
          <button className="btn btn-secondary btn-sm" style={{ fontSize: "11.5px" }} onClick={() => applyEvilPreset("SPECIAL")}>
            {EVIL_PRESETS.SPECIAL.name}
          </button>
          <button className="btn btn-secondary btn-sm" style={{ fontSize: "11.5px" }} onClick={() => applyEvilPreset("EMPTY")}>
            {EVIL_PRESETS.EMPTY.name}
          </button>
          <button className="btn btn-secondary btn-sm" style={{ fontSize: "11.5px" }} onClick={() => applyEvilPreset("HEADINGS")}>
            {EVIL_PRESETS.HEADINGS.name}
          </button>
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
              <div>ハッシュI/O: <strong style={{ color: "#cbd5e1" }}>{benchmarkResult.hash_time_ms?.toFixed(1)} ms</strong></div>
              <div>チャンキング: <strong style={{ color: "#cbd5e1" }}>{benchmarkResult.chunk_time_ms?.toFixed(1)} ms</strong></div>
              <div>推論: <strong style={{ color: "#a855f7" }}>{benchmarkResult.embedding_time_ms?.toFixed(1)} ms</strong></div>
              <div>DB書込: <strong style={{ color: "#cbd5e1" }}>{benchmarkResult.db_time_ms?.toFixed(1)} ms</strong></div>
              <div>チャンク数: <strong style={{ color: "#f8fafc" }}>{benchmarkResult.chunks}</strong></div>
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

    </div>
  );
}
