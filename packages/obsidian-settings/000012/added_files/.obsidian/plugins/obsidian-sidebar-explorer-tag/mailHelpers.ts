/**
 * メール本文の変換ヘルパー
 *
 * 仕様:
 * - HTMLの表をMarkdownテーブルへ変換する処理（msgParser.ts）と、RTFからプレーンテキストを抽出する処理
 *   （tnefParser.ts）をまとめて返す。
 * - main.ts がこれを window._sidebarExplorerMailHelpers として公開し、
 *   00_templates/RegisterCustomCommands.md（サマリー作成）が利用する。
 **/
import { convertHtmlTablesToMarkdown } from "./msgParser";
import { extractPlainTextFromRtf } from "./tnefParser";
import type { MailTextHelpers } from "./mailGlobals";

export function createMailHelpers(): MailTextHelpers {
    return { convertHtmlTablesToMarkdown, extractPlainTextFromRtf };
}
