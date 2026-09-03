/**
 * ファイル/フォルダ一覧をMarkdown形式（チェックボックス／箇条書き）へ変換するユーティリティ
 */
import type { FileItem } from "../types/file";

/**
 * ファイル/フォルダ一覧をMarkdownチェックボックス形式（- [ ] {name}）へ変換
 */
export function formatItemsAsMarkdownChecklist(items: Pick<FileItem, "name" | "type">[]): string {
  return items
    .map((item) => `- [ ] ${item.name}`)
    .join("\n");
}

/**
 * ファイル/フォルダ一覧をMarkdown箇条書き形式（- {name}）へ変換
 */
export function formatItemsAsMarkdownBulletList(items: Pick<FileItem, "name" | "type">[]): string {
  return items
    .map((item) => `- ${item.name}`)
    .join("\n");
}
