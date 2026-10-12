/**
 * 検索ルール・設定値の正規化。
 * 画面で編集した除外キーワード・非表示キーワード・類似語リスト・gantt parent ID を、
 * 保存形式（改行区切り・重複なし）へ安定化する。バックエンドの正規化と同じ規則に合わせている。
 **/

/**
 * 除外キーワードは空行除去・前後空白除去・重複排除を行い、保存形式を安定化する。
 */
export function normalizeExcludeKeywords(value: string): string {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))].join("\n");
}

/**
 * 一覧から隠したい確認済みキーワードも改行区切りで正規化し、再起動後も同じ順序で扱えるようにする。
 */
export function normalizeHiddenIndexedTargets(value: string): string {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))].join("\n");
}

/**
 * 類似語・専門用語リストは 1 行を 1 エントリとして扱い、
 * コロン前の類似語の重複を除去し、コロン後の意味・解説を保持する。
 */
export function normalizeSynonymGroups(value: string | null | undefined): string {
  return (value ?? "")
    .split(/\r?\n/)
    .map((line) => {
      const lineStr = line.trim();
      if (!lineStr) return "";
      let termsPart = lineStr;
      let descPart = "";
      if (lineStr.includes(":")) {
        const idx = lineStr.indexOf(":");
        termsPart = lineStr.slice(0, idx);
        descPart = lineStr.slice(idx + 1).trim();
      } else if (lineStr.includes("：")) {
        const idx = lineStr.indexOf("：");
        termsPart = lineStr.slice(0, idx);
        descPart = lineStr.slice(idx + 1).trim();
      }

      const rawTokens = termsPart.split(/[，,]/).map((item) => item.trim()).filter(Boolean);
      const normalizedTokens = [...new Set(rawTokens.map((item) => item.toLowerCase()))];
      const originalTokens: string[] = [];
      for (const token of rawTokens) {
        if (!normalizedTokens.includes(token.toLowerCase())) {
          continue;
        }
        if (originalTokens.some((item) => item.toLowerCase() === token.toLowerCase())) {
          continue;
        }
        originalTokens.push(token);
      }
      const termsStr = originalTokens.join(",");
      if (!termsStr) return "";
      return descPart ? `${termsStr}:${descPart}` : termsStr;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * gantt parent ID は 0 以上の整数だけを保存対象にする。
 */
export function normalizeGanttParent(value: string | number | null | undefined): number {
  const rawValue = String(value ?? "").trim();
  if (!/^\d+$/.test(rawValue)) {
    return 0;
  }
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
