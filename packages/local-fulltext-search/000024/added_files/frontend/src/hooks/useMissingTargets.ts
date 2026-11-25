/**
 * 見つからない検索対象フォルダ（移動・削除・未接続のドライブ・権限不足）の案内の取得と確認。
 * 案内は補足の情報なので、取得に失敗しても画面の操作は止めない。
 */
import type * as React from "react";
import { useState } from "react";
import { acknowledgeMissingTargets, fetchMissingTargets } from "../api/client";
import type { MissingTargetFolder } from "../types";

type UseMissingTargetsDeps = {
  setErrorMessage: React.Dispatch<React.SetStateAction<string>>;
};

export function useMissingTargets({ setErrorMessage }: UseMissingTargetsDeps) {
  const [missingTargets, setMissingTargets] = useState<MissingTargetFolder[]>([]);

  /** 未確認の見つからないフォルダを読み直す。 */
  async function refreshMissingTargets(): Promise<void> {
    try {
      const response = await fetchMissingTargets();
      setMissingTargets(response.items);
    } catch {
      // 次のインデックスのあとに読み直す
    }
  }

  /** 表示中のフォルダを確認済みにして閉じる。送れなければ開いたままにする。 */
  async function handleAcknowledgeMissingTargets(): Promise<void> {
    try {
      await acknowledgeMissingTargets(missingTargets.map((target) => target.full_path));
      setMissingTargets([]);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "案内の確認を保存できませんでした。");
    }
  }

  return {
    handleAcknowledgeMissingTargets,
    missingTargets,
    refreshMissingTargets,
  } as const;
}

export type UseMissingTargetsResult = ReturnType<typeof useMissingTargets>;
