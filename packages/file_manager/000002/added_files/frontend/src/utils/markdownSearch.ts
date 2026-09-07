/**
 * Markdownエディタ・プレビュー用検索ユーティリティ
 * - 本文テキスト内のマッチ位置検出 (findTextMatches)
 * - 次へ/前へインデックス移動 (getNextMatchIndex)
 * - HTML構造を維持した安全なテキストハイライト置換 (highlightHtmlText)
 */

export interface TextMatch {
  start: number;
  end: number;
  text: string;
}

/**
 * 正規表現特殊文字をエスケープする
 */
export function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * テキストから指定した検索クエリにマッチする全箇所を検出する
 * @param text 対象の本文テキスト
 * @param query 検索クエリ
 * @param isRegex 正規表現モードかどうか
 */
export function findTextMatches(
  text: string,
  query: string,
  isRegex: boolean
): TextMatch[] {
  const trimmed = query.trim();
  if (!trimmed || !text) {
    return [];
  }

  let regex: RegExp;
  if (isRegex) {
    try {
      regex = new RegExp(trimmed, "gi");
    } catch {
      regex = new RegExp(escapeRegExp(trimmed), "gi");
    }
  } else {
    regex = new RegExp(escapeRegExp(trimmed), "gi");
  }

  const matches: TextMatch[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
    });

    // 0幅マッチ時の無限ループ防止
    if (match[0].length === 0) {
      regex.lastIndex++;
    }
  }

  return matches;
}

/**
 * 次または前の検索マッチインデックスを計算する（循環ラップアラウンド対応）
 * @param currentIndex 現在のインデックス
 * @param totalMatches 総マッチ数
 * @param direction "next" または "prev"
 */
export function getNextMatchIndex(
  currentIndex: number,
  totalMatches: number,
  direction: "next" | "prev"
): number {
  if (totalMatches <= 0) {
    return 0;
  }

  if (direction === "next") {
    if (currentIndex < 0 || currentIndex >= totalMatches) {
      return 0;
    }
    return (currentIndex + 1) % totalMatches;
  } else {
    if (currentIndex < 0 || currentIndex >= totalMatches) {
      return totalMatches - 1;
    }
    return (currentIndex - 1 + totalMatches) % totalMatches;
  }
}

/**
 * HTML文字列のタグ外のテキスト部分に対してのみ検索ヒットをハイライトする
 * @param html レンダリング済みのHTML文字列
 * @param query 検索クエリ
 * @param activeIndex 現在フォーカス中のマッチインデックス
 * @param isRegex 正規表現モードかどうか
 */
export function highlightHtmlText(
  html: string,
  query: string,
  activeIndex: number,
  isRegex: boolean
): { highlightedHtml: string; totalMatches: number } {
  const trimmed = query.trim();
  if (!trimmed || !html) {
    return { highlightedHtml: html, totalMatches: 0 };
  }

  let regex: RegExp;
  if (isRegex) {
    try {
      regex = new RegExp(trimmed, "gi");
    } catch {
      regex = new RegExp(escapeRegExp(trimmed), "gi");
    }
  } else {
    regex = new RegExp(escapeRegExp(trimmed), "gi");
  }

  // HTMLタグ (<...>) とテキストを分離
  const parts = html.split(/(<[^>]+>)/g);
  let totalMatches = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    // HTMLタグ（<で始まる部分）はそのままスキップ
    if (part.startsWith("<")) {
      continue;
    }

    // テキスト部分に対してマッチ置換を実行
    regex.lastIndex = 0;
    parts[i] = part.replace(regex, (matched) => {
      const matchIndex = totalMatches;
      totalMatches++;
      const isActive = matchIndex === activeIndex;
      const activeClass = isActive ? " active" : "";
      return `<mark class="md-search-highlight${activeClass}" data-match-index="${matchIndex}">${matched}</mark>`;
    });
  }

  return {
    highlightedHtml: parts.join(""),
    totalMatches,
  };
}
