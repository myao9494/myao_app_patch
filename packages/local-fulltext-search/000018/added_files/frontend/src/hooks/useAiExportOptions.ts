/**
 * AIインプット用ドキュメントの出力オプション（タイトル、Markdown 原文・画像・リンクされたメールを含めるか、
 * トークン節約のための整形を行うか、メールの宛先（To・CC・BCC）を含めるか）。
 * メールの宛先は長くなりやすいので既定では含めない。
 */
import { useState } from "react";

export function useAiExportOptions() {
  // Markdown 原文・画像・リンクされたメールを含めるかは、現在の画面では切り替えられない固定値
  const [docTitle, setDocTitle] = useState("AI_Context_Document");
  const [includeRawMarkdown] = useState(false);
  const [includeImages] = useState(true);
  const [includeLinkedEmails] = useState(true);
  const [optimizeTokens, setOptimizeTokens] = useState(true);
  const [includeEmailRecipients, setIncludeEmailRecipients] = useState(false);

  return {
    docTitle,
    includeEmailRecipients,
    includeImages,
    includeLinkedEmails,
    includeRawMarkdown,
    optimizeTokens,
    setDocTitle,
    setIncludeEmailRecipients,
    setOptimizeTokens,
  } as const;
}

export type UseAiExportOptionsResult = ReturnType<typeof useAiExportOptions>;
