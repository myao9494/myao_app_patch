/**
 * AIインプット用ドキュメントの出力オプション（タイトル、Markdown 原文・画像・リンクされたメールを含めるか、
 * トークン節約のための整形を行うか）。
 */
import { useState } from "react";

export function useAiExportOptions() {
  // Markdown 原文・画像・リンクされたメールを含めるかは、現在の画面では切り替えられない固定値
  const [docTitle, setDocTitle] = useState("AI_Context_Document");
  const [includeRawMarkdown] = useState(false);
  const [includeImages] = useState(true);
  const [includeLinkedEmails] = useState(true);
  const [optimizeTokens, setOptimizeTokens] = useState(true);

  return {
    docTitle,
    includeImages,
    includeLinkedEmails,
    includeRawMarkdown,
    optimizeTokens,
    setDocTitle,
    setOptimizeTokens,
  } as const;
}

export type UseAiExportOptionsResult = ReturnType<typeof useAiExportOptions>;
