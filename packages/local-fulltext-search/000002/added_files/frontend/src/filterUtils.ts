/**
 * 検索結果やファイルリストに対する除外キーワード判定ユーティリティ。
 * ファイル名またはパスに除外キーワードが含まれるか判定する。
 **/

/**
 * 対象のファイル名またはパスが除外キーワードに一致するか判定する。
 * 1. キーワードがファイル名またはパスに含まれるか（部分一致）判定。
 * 2. 4文字以下の英数字のみの短いASCIIキーワード（例: old, env, git 等）は
 *    older, environment 等の通常単語への過剰除外を防ぐため、記号/単語境界で一致を確認する。
 */
export function isExcludedByKeywords(path: string, fileName?: string, excludeKeywords?: string): boolean {
  if (!excludeKeywords) return false;
  const keywords = excludeKeywords
    .split(/[\r\n,]+/)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  if (keywords.length === 0) return false;
  const lowerPath = (path || "").toLowerCase();
  const lowerName = (fileName || "").toLowerCase();

  return keywords.some((kw) => {
    if (!lowerPath.includes(kw) && !lowerName.includes(kw)) {
      return false;
    }
    // 4文字以下の英数字のみのキーワード（old, env, bin 等）は誤除外防止のため記号/単語境界チェック
    if (kw.length <= 4 && /^[a-z0-9]+$/i.test(kw)) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(^|[^a-zA-Z0-9])${escaped}([^a-zA-Z0-9]|$)`, "i");
      return re.test(lowerName) || re.test(lowerPath);
    }
    return true;
  });
}
