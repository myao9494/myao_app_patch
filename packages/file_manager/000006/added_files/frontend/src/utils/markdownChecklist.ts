/**
 * ファイル/フォルダ一覧をMarkdown形式（チェックボックス／箇条書き／リンク付き）へ変換するユーティリティ
 */
import type { FileItem } from "../types/file";
import { formatPathAsFileUri } from "./pathUtils";

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

/**
 * ファイル/フォルダ一覧をフルパス付きMarkdownリンク形式（- [{name}]({fileUri})）へ変換
 * - Obsidian貼り付け用に file:/// URI 形式のリンクを生成
 * - パスにスペースや丸括弧を含む場合は CommonMark 準拠の <file:///...> で囲む
 * - ファイル名に含まれる角括弧（[ ]）は Markdown 構文破壊を防ぐためエスケープ
 */
export function formatItemsAsMarkdownLinkList(items: Pick<FileItem, "name" | "path">[]): string {
  return items
    .map((item) => {
      const uri = formatPathAsFileUri(item.path);
      const target = uri.includes(" ") || uri.includes("(") || uri.includes(")") ? `<${uri}>` : uri;
      const safeName = item.name.replace(/([[\]])/g, "\\$1");
      return `- [${safeName}](${target})`;
    })
    .join("\n");
}

