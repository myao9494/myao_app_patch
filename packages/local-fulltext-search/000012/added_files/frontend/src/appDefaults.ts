/**
 * 設定を読み込む前に画面へ表示する既定値。
 * 保存済みの設定を読み込めたら、その値で置き換える。
 */
export const DEFAULT_EXCLUDE_KEYWORDS = [
  "node_modules",
  ".git",
  "old",
  "旧",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "venv",
  "env",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".parcel-cache",
].join("\n");
export const DEFAULT_SYNONYM_GROUPS = "";
export const DEFAULT_SEARCH_FILTER_TEXT = "";
