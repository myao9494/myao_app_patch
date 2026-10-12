/**
 * AIインプットの候補ノートの抽出と選択。
 * - 質問・キーワードでハイブリッド検索し、文書として扱えるファイルだけを候補にする。
 * - 拡張子フィルターで候補を絞り込み、上位 N 件を自動で選択する。
 * - 一覧はドラッグでまとめて選択でき、Shift を押しながらのドラッグでまとめて解除できる。
 */
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { isAiInputDocumentCandidate } from "../aiInputCandidate";
import { saveAiExportConfig, search } from "../api/client";
import { filterSearchResultsByExtensions } from "../extensionFilter";
import { isExcludedByKeywords } from "../filterUtils";
import type { SearchResult } from "../types";

type UseAiCandidatesDeps = {
  excludeKeywords: string | undefined;
  initialExtensionFilter: string;
  initialQuery: string;
  results: SearchResult[] | undefined;
  setDocTitle: React.Dispatch<React.SetStateAction<string>>;
};

export function useAiCandidates({
  excludeKeywords,
  initialExtensionFilter,
  initialQuery,
  results,
  setDocTitle,
}: UseAiCandidatesDeps) {
  const [query, setQuery] = useState(initialQuery);
  const [extensionFilterText, setExtensionFilterText] = useState(initialExtensionFilter.trim() || "md");
  const [isSearching, setIsSearching] = useState(false);
  const [rawCandidates, setRawCandidates] = useState<SearchResult[]>(() => {
    if (results && results.length > 0) {
      return results.filter(
        (r) => !isExcludedByKeywords(r.full_path, r.file_name, excludeKeywords) && isAiInputDocumentCandidate(r)
      );
    }
    return [];
  });

  // initialExtensionFilter が親から渡されたときに同期（空文字・未指定時は "md" にフォールバック）
  useEffect(() => {
    if (initialExtensionFilter !== undefined) {
      setExtensionFilterText(initialExtensionFilter.trim() || "md");
    }
  }, [initialExtensionFilter]);

  // results や excludeKeywords が渡された・更新されたときに rawCandidates を同期
  useEffect(() => {
    if (results && results.length > 0) {
      setRawCandidates(
        results.filter(
          (r) => !isExcludedByKeywords(r.full_path, r.file_name, excludeKeywords) && isAiInputDocumentCandidate(r)
        )
      );
    }
  }, [results, excludeKeywords]);

  // 拡張子フィルタ（包含・除外）を適用した表示候補
  const candidates = filterSearchResultsByExtensions(rawCandidates, extensionFilterText);

  // デフォルト選択数（初期値: 10、サーバーに保存して次回自動復元）
  const [defaultSelectCount, setDefaultSelectCount] = useState<number>(10);

  // 上位N件を自動選択する関数
  const applyAutoSelectTopN = (targetCandidates: SearchResult[], count: number) => {
    const targetCount = Math.max(0, count);
    const topPaths = targetCandidates.slice(0, targetCount).map((c) => c.full_path);
    setSelectedPaths(new Set(topPaths));
  };

  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => {
    if (results && results.length > 0) {
      const initialFiltered = results.filter(
        (r) => !isExcludedByKeywords(r.full_path, r.file_name, excludeKeywords) && isAiInputDocumentCandidate(r)
      );
      const initialExt = filterSearchResultsByExtensions(initialFiltered, initialExtensionFilter.trim() || "md");
      return new Set(initialExt.slice(0, 10).map((r) => r.full_path));
    }
    return new Set();
  });

  // ドラッグ連続選択の状態管理
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const dragModeRef = useRef(true);
 // true: 選択 (ON), false: 解除 (OFF)

  // グローバルマウスアップ監視（ドラッグ終了）
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        setIsDragging(false);
      }
    };
    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => {
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, []);

  // 候補検索実行
  const handleSearchCandidates = async (overrideQuery?: string) => {
    const q = overrideQuery !== undefined ? overrideQuery : query;
    if (!q || !q.trim()) {
      alert("質問や探したいキーワードを入力してください");
      return;
    }

    setIsSearching(true);
    try {
      const res = await search({
        q: q.trim(),
        full_path: "",
        search_all_enabled: true,
        refresh_window_minutes: 0,
        search_type: "hybrid",
        exclude_keywords: excludeKeywords,
        types: extensionFilterText.trim() || undefined,
        limit: 40,
      });

      const filteredItems = res.items.filter(
        (it) => !isExcludedByKeywords(it.full_path, it.file_name, excludeKeywords) && isAiInputDocumentCandidate(it)
      );
      setRawCandidates(filteredItems);
      const extFiltered = filterSearchResultsByExtensions(filteredItems, extensionFilterText);
      applyAutoSelectTopN(extFiltered, defaultSelectCount);

      // クエリから安全なタイトルを自動設定
      const safeQ = q.trim().replace(/[\\/*?:"<>| ]+/g, "_").slice(0, 30);
      setDocTitle(`AI_Context_${safeQ || "Export"}`);
    } catch (err: any) {
      alert(`候補ドキュメントの検索に失敗しました: ${err.message}`);
    } finally {
      setIsSearching(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (e.nativeEvent.isComposing || (e as any).keyCode === 229) {
        return;
      }
      void handleSearchCandidates();
    }
  };

  // チェックボックスでのマウスダウン（ドラッグ選択開始）
  const handleCheckboxMouseDown = (e: React.MouseEvent, path: string) => {
    if (e.button !== 0) return; // 左クリックのみ
    e.preventDefault();

    const isDeselect = e.shiftKey;
    const targetMode = !isDeselect;
    dragModeRef.current = targetMode;
    isDraggingRef.current = true;
    setIsDragging(true);

    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (targetMode) {
        next.add(path);
      } else {
        next.delete(path);
      }
      return next;
    });
  };

  // 行 / チェックボックス上をマウスが通過した時（ドラッグ継続中）
  const handleRowMouseEnter = (e: React.MouseEvent, path: string) => {
    if (!isDraggingRef.current) return;

    const targetMode = e.shiftKey ? false : dragModeRef.current;
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (targetMode) {
        next.add(path);
      } else {
        next.delete(path);
      }
      return next;
    });
  };

  // 通常クリックでの単一トグル
  const toggleSelect = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedPaths(new Set(candidates.map((c) => c.full_path)));
  };

  const deselectAll = () => {
    setSelectedPaths(new Set());
  };

  // デフォルト選択数の変更とサーバー永続化
  const handleDefaultSelectCountChange = async (valStr: string) => {
    const parsed = parseInt(valStr, 10);
    const newCount = isNaN(parsed) ? 0 : Math.max(0, parsed);
    setDefaultSelectCount(newCount);
    applyAutoSelectTopN(candidates, newCount);
    try {
      await saveAiExportConfig({ default_select_count: newCount });
    } catch (e) {
      console.warn("デフォルト選択数の保存に失敗しました:", e);
    }
  };

  // 推定トークン数の計算（選択された候補の概算）
  const estimatedChars = candidates
    .filter((c) => selectedPaths.has(c.full_path))
    .reduce((acc, c) => acc + (c.snippet?.length || 500) + 1500, 0);
 // 1ファイル平均約1.5k〜3k文字
  const estimatedTokens = Math.round(estimatedChars * 1.1);

  return {
    applyAutoSelectTopN,
    candidates,
    defaultSelectCount,
    deselectAll,
    dragModeRef,
    estimatedTokens,
    extensionFilterText,
    handleCheckboxMouseDown,
    handleDefaultSelectCountChange,
    handleKeyDown,
    handleRowMouseEnter,
    handleSearchCandidates,
    isDragging,
    isSearching,
    query,
    rawCandidates,
    selectAll,
    selectedPaths,
    setDefaultSelectCount,
    setExtensionFilterText,
    setQuery,
    toggleSelect,
  } as const;
}

export type UseAiCandidatesResult = ReturnType<typeof useAiCandidates>;
