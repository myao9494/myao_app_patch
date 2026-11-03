/**
 * 走査でたどらなかったフォルダのリンク（ジャンクション・シンボリックリンク）の案内の取得と確認。
 * 案内は補足の情報なので、取得に失敗しても画面の操作は止めない。
 */
import type * as React from "react";
import { useState } from "react";
import { acknowledgeSkippedLinks, fetchSkippedLinks } from "../api/client";
import type { SkippedFolderLink } from "../types";

type UseSkippedLinksDeps = {
  setErrorMessage: React.Dispatch<React.SetStateAction<string>>;
};

export function useSkippedLinks({ setErrorMessage }: UseSkippedLinksDeps) {
  const [skippedLinks, setSkippedLinks] = useState<SkippedFolderLink[]>([]);

  /** 未確認のリンクを読み直す。 */
  async function refreshSkippedLinks(): Promise<void> {
    try {
      const response = await fetchSkippedLinks();
      setSkippedLinks(response.items);
    } catch {
      // 次のインデックスのあとに読み直す
    }
  }

  /** 表示中のリンクを確認済みにして閉じる。送れなければ開いたままにする。 */
  async function handleAcknowledgeSkippedLinks(): Promise<void> {
    try {
      await acknowledgeSkippedLinks(skippedLinks.map((link) => link.link_path));
      setSkippedLinks([]);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "案内の確認を保存できませんでした。");
    }
  }

  return {
    handleAcknowledgeSkippedLinks,
    refreshSkippedLinks,
    skippedLinks,
  } as const;
}

export type UseSkippedLinksResult = ReturnType<typeof useSkippedLinks>;
