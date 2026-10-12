/**
 * ベクトル管理画面の状態と操作。
 * - Embedding モデルの選択と読み込み、モデルごとのインデックス状況の表示。
 * - ベクトルインデックスの差分更新・全件再作成の開始と中止、進捗の定期取得。
 * - ベンチマーク: サーバー上のファイル 1 件の差分更新、または画面で作った検証用の本文の測定（何も保存しない）。
 */
import { useEffect, useRef, useState } from "react";
import {
  cancelVectorIndex,
  fetchAppSettings,
  fetchVectorIndexProgress,
  fetchVectorIndexStats,
  fetchVectorModelStatus,
  fetchVectorPendingDeletions,
  loadVectorModel,
  measureVectorText,
  startVectorIndex,
  updateVectorSingleFile,
} from "../api/client";
import type { VectorBenchmarkResult, VectorIndexProgress, VectorIndexStats, VectorModelStatus } from "../types";
import { EVIL_PRESETS } from "../vectorBenchmarkPresets";

type UseVectorManagementDeps = {
  confirmIndexDeletion: boolean | undefined;
};

/** ベンチマークの履歴 1 件 */
export type VectorBenchmarkHistoryEntry = {
  id: number;
  timestamp: string;
  file: string;
  status: string;
  chunks: number;
  total_ms: number;
  embedding_ms: number;
};

export function useVectorManagement({
  confirmIndexDeletion,
}: UseVectorManagementDeps) {
  const [modelStatus, setModelStatus] = useState<VectorModelStatus | null>(null);
  const [selectedModelType, setSelectedModelType] = useState<"light" | "standard">("light");
  const [loadingModel, setLoadingModel] = useState(false);
  const [modelMessage, setModelMessage] = useState<string | null>(null);
  const hasUserManuallySelectedRef = useRef(false);

  // インデックス実行ステータス
  const [indexProgress, setIndexProgress] = useState<VectorIndexProgress | null>(null);
  const [indexStats, setIndexStats] = useState<VectorIndexStats | null>(null);
  const [isStartingIndex, setIsStartingIndex] = useState(false);
  const [isCancellingIndex, setIsCancellingIndex] = useState(false);
  const [indexMode, setIndexMode] = useState<"incremental" | "full">("incremental");

  // 単一ファイルベンチマーク
  const [benchmarkPath, setBenchmarkPath] = useState("sample_benchmark.md");
  const [benchmarkResult, setBenchmarkResult] = useState<VectorBenchmarkResult | null>(null);
  const [benchmarking, setBenchmarking] = useState(false);
  const [benchmarkHistory, setBenchmarkHistory] = useState<VectorBenchmarkHistoryEntry[]>([]);

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
          setIsStartingIndex(false);
          setIsCancellingIndex(false);
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
    }
    return modelStatus?.default_standard_path || "models/ruri-v3-310m";
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
    if (
      force &&
      !window.confirm(
        "現在のモデルのベクトルインデックスを、全ファイルについて作り直します。\n" +
          "既存のインデックスは置き換わるまで残ります（途中で中止しても検索できます）。\n" +
          "最後まで終わると、存在しなくなったファイルのインデックスは削除されます。続行しますか？",
      )
    ) {
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
      // 全件再作成は、最後まで終わったときに存在しなくなったファイルのインデックスを削除する
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

  // 実行中のインデックス作成を中止する（処理中のファイルが終わった時点で止まる）
  const handleCancelIndex = async () => {
    setIsCancellingIndex(true);
    try {
      const res = await cancelVectorIndex();
      if (!res.cancel_requested) {
        setIsCancellingIndex(false);
      }
    } catch (e: any) {
      setIsCancellingIndex(false);
      alert(`インデックス中止エラー: ${e.message}`);
    }
  };

  // 測定を実行し、直近の結果と履歴へ反映する
  const runBenchmark = async (measure: () => Promise<VectorBenchmarkResult>) => {
    setBenchmarking(true);
    try {
      const res = await measure();
      setBenchmarkResult(res);
      setBenchmarkHistory((prev) => [
        {
          id: Date.now(),
          timestamp: new Date().toLocaleTimeString(),
          file: res.relative_path,
          status: res.status,
          chunks: res.chunk_count,
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

  // サーバー上のファイル 1 件の差分更新を実行して測る（そのファイルのインデックスを更新する）
  const handleRunBenchmark = async () => {
    const filePath = benchmarkPath.trim();
    if (!filePath) {
      alert("検証対象のファイルパスを入力してください");
      return;
    }
    await runBenchmark(() => updateVectorSingleFile(filePath));
  };

  // 検証用プリセットの本文を作って測る（ファイルもインデックスも変更しない）
  const applyEvilPreset = async (key: keyof typeof EVIL_PRESETS) => {
    const preset = EVIL_PRESETS[key];
    const name = benchmarkPath.trim() || "benchmark.md";
    const generated = preset.generate(name.replace(/\.[^/.]+$/, ""));
    await runBenchmark(() => measureVectorText(name, generated));
  };

  const currentProg = indexProgress?.progress;
  const lastResult = indexProgress?.last_result;

  return {
    applyEvilPreset,
    benchmarkHistory,
    benchmarkPath,
    benchmarkResult,
    benchmarking,
    currentProg,
    handleCancelIndex,
    handleLoadModel,
    handleRunBenchmark,
    handleStartIndex,
    hasUserManuallySelectedRef,
    indexMode,
    indexProgress,
    indexStats,
    isCancellingIndex,
    isModelActive,
    isStartingIndex,
    lastResult,
    loadingModel,
    modelMessage,
    modelStatus,
    selectedModelType,
    setBenchmarkPath,
    setSelectedModelType,
  } as const;
}

export type UseVectorManagementResult = ReturnType<typeof useVectorManagement>;
