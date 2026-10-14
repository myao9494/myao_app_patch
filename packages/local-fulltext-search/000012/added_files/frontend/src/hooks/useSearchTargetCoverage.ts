/**
 * 検索欄に入力されたフォルダが、有効な検索対象に含まれているかの判定と、検索対象への追加。
 * 含まれていないフォルダが入力されているときだけ、「検索対象に追加」の操作を表示できるようにする。
 */
import type * as React from "react";
import { useEffect, useState } from "react";
import { fetchSearchTargetCoverage } from "../api/client";
import { isPathCoveredByTarget } from "../searchTargetCoverage";
import type { SearchTargetFolder } from "../types";
import type { SearchSource } from "../appTypes";

type UseSearchTargetCoverageDeps = {
  /** フォルダを検索対象へ追加する（階層が null なら無制限）。 */
  addSearchTarget: (folderPath: string, indexDepth: number | null) => Promise<void>;
  /** 全データベース検索を解除する。 */
  disableSearchAll: () => void;
  fullPath: string;
  indexDepth: string;
  searchSource: SearchSource;
  searchTargets: SearchTargetFolder[];
  setErrorMessage: React.Dispatch<React.SetStateAction<string>>;
  setNoticeMessage: React.Dispatch<React.SetStateAction<string>>;
};

/**
 * 階層の入力欄の値を、検索対象へ登録する階層数へ変換する。
 * 空欄は検索欄の表示どおり「無制限」（null）。数値として読めない値と負の数は、既定の 3 階層にする。
 */
export function resolveTargetIndexDepth(indexDepthText: string): number | null {
  const trimmed = indexDepthText.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 3;
}

export function useSearchTargetCoverage({
  addSearchTarget,
  disableSearchAll,
  fullPath,
  indexDepth,
  searchSource,
  searchTargets,
  setErrorMessage,
  setNoticeMessage,
}: UseSearchTargetCoverageDeps) {
  const [isCurrentPathCovered, setIsCurrentPathCovered] = useState(false);
  const [isAddingLaunchPath, setIsAddingLaunchPath] = useState(false);
  const candidateSearchTargetPath = fullPath.trim();
  const fallbackCoveredByLocalTargets = isPathCoveredByTarget(candidateSearchTargetPath, searchTargets);
  const isLaunchPathAddable = Boolean(
    candidateSearchTargetPath &&
    !(isCurrentPathCovered || fallbackCoveredByLocalTargets),
  );

  /**
   * 検索欄のパスが有効な検索対象フォルダに内包されるかをバックエンド基準で確認する。
   */
  useEffect(() => {
    const targetPath = fullPath.trim();
    if (!targetPath) {
      setIsCurrentPathCovered(false);
      return;
    }
    let isActive = true;
    setIsCurrentPathCovered(isPathCoveredByTarget(targetPath, searchTargets));
    const timerId = window.setTimeout(() => {
      void (async () => {
        try {
          const coverage = await fetchSearchTargetCoverage(targetPath);
          if (isActive) {
            setIsCurrentPathCovered(coverage.is_covered);
          }
        } catch {
          // 通信失敗時はローカル判定のまま継続する。
        }
      })();
    }, 200);

    return () => {
      isActive = false;
      window.clearTimeout(timerId);
    };
  }, [fullPath, searchTargets, searchSource]);

  async function handleAddCurrentPathToSearchTarget(): Promise<void> {
    const targetPath = fullPath.trim();
    if (!targetPath || isAddingLaunchPath) {
      return;
    }
    try {
      setIsAddingLaunchPath(true);
      setErrorMessage("");
      setNoticeMessage("");
      const coverage = await fetchSearchTargetCoverage(targetPath);
      if (coverage.is_covered) {
        setNoticeMessage(`このフォルダはすでに検索対象です（親フォルダ: ${coverage.covering_path}）。`);
        return;
      }
      await addSearchTarget(targetPath, resolveTargetIndexDepth(indexDepth));
      setIsCurrentPathCovered(true);
      disableSearchAll();
      setNoticeMessage(
        searchSource === "web"
          ? "指定したWebページを検索対象に追加し、配下ページをインデックスしました。"
          : "指定したフォルダを検索対象に追加しました。全データベース検索を解除し、このフォルダを対象に検索します。",
      );
    } catch (error) {
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "検索対象フォルダの追加に失敗しました。");
    } finally {
      setIsAddingLaunchPath(false);
    }
  }

  return {
    handleAddCurrentPathToSearchTarget,
    isAddingLaunchPath,
    isLaunchPathAddable,
  } as const;
}

export type UseSearchTargetCoverageResult = ReturnType<typeof useSearchTargetCoverage>;
