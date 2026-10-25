/**
 * ブラウザに保存する設定（localStorage）の読み書き。値は読み込み時に正規化し、壊れていても既定値で動く。
 */
import { clamp } from "./util.js";

export const DEFAULT_TEXT_EXTENSIONS = [".md", ".txt", ".csv", ".json", ".yaml", ".yml"];

export const GIT_EXTENSION_STORAGE_KEY = "visual-diff-git-text-extensions";

export const GIT_TEXT_MEMO_STORAGE_KEY = "visual-diff-git-text-memos";

export const GIT_FOLDER_HISTORY_STORAGE_KEY = "visual-diff-git-folder-history";

// v2: 以前は未保存時に50%が保存されてしまう不具合があったため、キーを変えて全員を100%へ戻す
export const DISPLAY_SCALE_STORAGE_KEY = "visual-diff-display-scale-v2";

export const MEMO_SIDEBAR_WIDTH_STORAGE_KEY = "visual-diff-memo-sidebar-width";

export const MEMO_SIDEBAR_VISIBLE_STORAGE_KEY = "visual-diff-memo-sidebar-visible";

export function loadTextExtensions() {
  try {
    return normalizeTextExtensions(JSON.parse(localStorage.getItem(GIT_EXTENSION_STORAGE_KEY) || "null") ?? DEFAULT_TEXT_EXTENSIONS);
  } catch {
    return [...DEFAULT_TEXT_EXTENSIONS];
  }
}

export function normalizeTextExtensions(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(/[,\s]+/);
  return [...new Set(items.map((item) => String(item).trim().toLowerCase()).filter(Boolean).map((item) => item.startsWith(".") ? item : `.${item}`)
    .filter((item) => /^\.[a-z0-9][a-z0-9._+-]{0,15}$/.test(item)))].slice(0, 50);
}

export function loadGitTextMemos() {
  try {
    const value = JSON.parse(localStorage.getItem(GIT_TEXT_MEMO_STORAGE_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

// 未保存のキーは null。Number(null) は 0 になり最小値へ丸められてしまうため、数値として読めない値は既定値にする。
function readStoredNumber(key) {
  const raw = localStorage.getItem(key);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function loadDisplayScale() {
  try {
    const value = readStoredNumber(DISPLAY_SCALE_STORAGE_KEY);
    return value === null ? 1 : Math.min(2, Math.max(0.5, value));
  } catch {
    return 1;
  }
}

export function loadMemoSidebarWidth() {
  try {
    const value = readStoredNumber(MEMO_SIDEBAR_WIDTH_STORAGE_KEY);
    return value === null ? 230 : clamp(Math.round(value), 160, 420);
  } catch {
    return 230;
  }
}

export function loadMemoSidebarVisible() {
  try {
    const value = localStorage.getItem(MEMO_SIDEBAR_VISIBLE_STORAGE_KEY);
    return value === null ? true : value !== "false";
  } catch {
    return true;
  }
}

export function loadGitFolderHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(GIT_FOLDER_HISTORY_STORAGE_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].slice(0, 12);
  } catch {
    return [];
  }
}

export function loadLastGitFolder() {
  return loadGitFolderHistory()[0] ?? "";
}

export function persistLocalStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
