/**
 * 仕様: メール解析関数のグローバル公開（window 経由の連携）のテスト
 *
 * 00_templates/RegisterCustomCommands.md の「サマリーを作る」は、このプラグインが window へ公開する
 * 解析関数を使って MSG / TNEF（winmail.dat）を展開する。
 * 1. MSG 用（_sidebarExplorerParseMsgFile, parseMsgFile）と TNEF 用（_sidebarExplorerParseTnefFile）を公開すること
 * 2. 本文の変換ヘルパー（_sidebarExplorerMailHelpers: 表のMarkdown変換、RTF抽出）を公開すること
 *    （テンプレートは同じ処理を自前で持たず、この実装を使う）
 * 3. 解除時は自分が公開した関数だけを取り除き、他の処理が差し替えた関数は残すこと
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { installMailParserGlobals } from "./mailGlobals";
import { createMailHelpers } from "./mailHelpers";

const createParsers = () => ({
    parseMsgFile: async () => ({ kind: "msg" }),
    parseTnefFile: async () => ({ kind: "tnef" }),
    helpers: {
        convertHtmlTablesToMarkdown: (html: string) => `md:${html}`,
        extractPlainTextFromRtf: (rtf: string | Uint8Array) => `text:${String(rtf)}`,
    },
});

test("MSG用とTNEF用の解析関数を公開すること", async () => {
    const target: Record<string, any> = {};
    const parsers = createParsers();

    installMailParserGlobals(target, parsers);

    assert.equal(target._sidebarExplorerParseMsgFile, parsers.parseMsgFile);
    assert.equal(target.parseMsgFile, parsers.parseMsgFile);
    assert.equal(target._sidebarExplorerParseTnefFile, parsers.parseTnefFile);
    assert.deepEqual(await target._sidebarExplorerParseTnefFile(), { kind: "tnef" });
});

test("本文の変換ヘルパーを公開すること", () => {
    const target: Record<string, any> = {};
    const parsers = createParsers();

    installMailParserGlobals(target, parsers);

    assert.equal(target._sidebarExplorerMailHelpers, parsers.helpers);
    assert.equal(target._sidebarExplorerMailHelpers.convertHtmlTablesToMarkdown("<table>"), "md:<table>");
    assert.equal(target._sidebarExplorerMailHelpers.extractPlainTextFromRtf("{\\rtf1}"), "text:{\\rtf1}");
});

test("createMailHelpers: プラグインの表変換・RTF抽出の実装を返すこと", () => {
    const helpers = createMailHelpers();

    assert.equal(
        helpers.convertHtmlTablesToMarkdown("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>").trim(),
        "| A | B |\n| --- | --- |\n| 1 | 2 |",
    );
    assert.equal(helpers.extractPlainTextFromRtf("{\\rtf1\\ansi first\\par second\\par}"), "first\nsecond");
});

test("解除すると、公開した関数をすべて取り除くこと", () => {
    const target: Record<string, any> = { unrelated: 1 };
    const uninstall = installMailParserGlobals(target, createParsers());

    uninstall();

    assert.deepEqual(Object.keys(target), ["unrelated"]);
});

test("解除時、他の処理が差し替えた関数は残すこと", () => {
    const target: Record<string, any> = {};
    const uninstall = installMailParserGlobals(target, createParsers());
    // テンプレート側が window.parseMsgFile を自前の関数へ差し替えた場合
    const replaced = async () => null;
    target.parseMsgFile = replaced;

    uninstall();

    assert.equal(target.parseMsgFile, replaced);
    assert.equal("_sidebarExplorerParseMsgFile" in target, false);
    assert.equal("_sidebarExplorerParseTnefFile" in target, false);
    assert.equal("_sidebarExplorerMailHelpers" in target, false);
});
