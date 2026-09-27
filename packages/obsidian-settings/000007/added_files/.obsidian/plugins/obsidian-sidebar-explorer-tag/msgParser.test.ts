/**
 * Outlook MSGファイル解析およびHTMLテーブル変換の単体テスト
 * 
 * 仕様:
 * 1. 文字化けスコア（mojibakeScore）が自然な日本語文字列を正しく評価し、
 *    latin1誤認や置換文字（\ufffd）による文字化けを検知できること。
 * 2. ベストエフォートデコード（decodeBestEffortText）により、
 *    CP932/Shift_JISおよびUTF-8のバイト列が正確にデコードされること。
 * 3. HTMLテーブルのMarkdown変換（convertHtmlTablesToMarkdown）において、
 *    ネストされたテーブル、セル内の複数行ブロック要素（<p>, <br>等）、
 *    パイプ文字のエスケープ、およびレイアウト用テーブルの展開が正しく処理され、
 *    Markdownテーブル構造が破壊されないこと。
 * 4. MSGバイナリ解析（parseMsgBinaryWithLibrary）において、
 *    ANSIエンコーディング（CP932/Windows-31J）のMSGファイルが文字化けせず読み込まれ、
 *    HTML本文内の表構造が崩れずにMarkdown本文へ反映されること。
 **/

import { test, describe } from "node:test";
import * as assert from "node:assert";
import {
    mojibakeScore,
    decodeBestEffortText,
    convertHtmlTablesToMarkdown,
    parseMsgBinaryWithLibrary
} from "./msgParser";

describe("MSGパーサーおよびテーブル変換のテスト", () => {
    describe("1. 文字化けスコア判定 (mojibakeScore)", () => {
        test("自然な日本語文字列は文字化け文字列よりもスコアが低いこと", () => {
            const cleanJa = "【重要】来週の打ち合わせ（連絡）について";
            // CP932バイト列をLatin1としてデコードした典型的な文字化け
            const latin1Garbled = Buffer.from(cleanJa, "utf8").toString("latin1");
            const sjisBuffer = Buffer.from([0x81, 0x5b, 0x8f, 0x64, 0x97, 0x76, 0x81, 0x5d]); // 【重要】 in CP932
            const cp1252Garbled = sjisBuffer.toString("latin1");

            assert.ok(mojibakeScore(cleanJa) < mojibakeScore(latin1Garbled));
            assert.ok(mojibakeScore(cleanJa) < mojibakeScore(cp1252Garbled));
        });

        test("置換文字（\\ufffd）が含まれる場合にペナルティが付与されること", () => {
            const clean = "正常なテキスト";
            const withBadChars = "正\ufffdなテ\ufffdスト";
            assert.ok(mojibakeScore(clean) < mojibakeScore(withBadChars));
        });
    });

    describe("2. ベストエフォートデコード (decodeBestEffortText)", () => {
        test("CP932（Windows-31J）のバイト列が正しく日本語としてデコードされること", () => {
            const text = "打ち合わせ（連絡）の件";
            // Node.js の TextEncoder/iconv 等で CP932 バイト列を生成
            // 打ち合わせ: 0x91, 0xc5, 0x82, 0xbf, 0x8d, 0x87, 0x82, 0xed, 0x82, 0xb9
            // （: 0x81, 0x69
            // 連絡: 0x98, 0x41, 0x8d, 0x8d
            // ）: 0x81, 0x6a
            // の: 0x82, 0xcc
            // 件: 0x8c, 0x8f
            const cp932Bytes = new Uint8Array([
                0x91, 0xc5, 0x82, 0xbf, 0x8d, 0x87, 0x82, 0xed, 0x82, 0xb9,
                0x81, 0x69,
                0x98, 0x41, 0x97, 0x8d,
                0x81, 0x6a,
                0x82, 0xcc,
                0x8c, 0x8f
            ]);

            const decoded = decodeBestEffortText(cp932Bytes);
            assert.strictEqual(decoded, text);
        });

        test("UTF-8バイト列が正しくデコードされること", () => {
            const text = "UTF-8で記述された本文テキスト";
            const utf8Bytes = new TextEncoder().encode(text);
            const decoded = decodeBestEffortText(utf8Bytes);
            assert.strictEqual(decoded, text);
        });
    });

    describe("3. HTMLテーブルのMarkdown変換 (convertHtmlTablesToMarkdown)", () => {
        test("基本的なHTMLテーブルがMarkdownテーブルに正しく変換されること", () => {
            const html = `<table>
                <tr><th>項目</th><th>金額</th></tr>
                <tr><td>交通費</td><td>1,000円</td></tr>
                <tr><td>宿泊費</td><td>8,000円</td></tr>
            </table>`;
            const result = convertHtmlTablesToMarkdown(html);
            assert.ok(result.includes("| 項目 | 金額 |"), "ヘッダーが含まれていません");
            assert.ok(result.includes("| --- | --- |"), "区切り線が含まれていません");
            assert.ok(result.includes("| 交通費 | 1,000円 |"), "行1が含まれていません");
            assert.ok(result.includes("| 宿泊費 | 8,000円 |"), "行2が含まれていません");
        });

        test("セル内に <p> や <br> などの複数行要素が含まれても、Markdownテーブル行が分断されないこと", () => {
            const html = `<table>
                <tr><th>担当者</th><th>備考</th></tr>
                <tr>
                    <td>田中<br>太郎</td>
                    <td><p>第1連絡先: 090-xxx</p><p>第2連絡先: 080-xxx</p></td>
                </tr>
            </table>`;
            const result = convertHtmlTablesToMarkdown(html);

            // テーブルブロック内の各行に生の改行 (\n) でセルが切断されていないこと
            const lines = result.trim().split("\n").filter(l => l.trim().startsWith("|"));
            assert.strictEqual(lines.length, 3, `テーブル行数はヘッダー、区切り線、データ行の3行であるべきですが ${lines.length} 行あります: \n${result}`);
            assert.ok(lines[0].includes("| 担当者 | 備考 |"));
            assert.ok(lines[2].includes("田中"));
            assert.ok(lines[2].includes("第1連絡先"));
        });

        test("セル内のパイプ文字 | がエスケープされること", () => {
            const html = `<table>
                <tr><th>条件</th><th>結果</th></tr>
                <tr><td>A | B</td><td>OK</td></tr>
            </table>`;
            const result = convertHtmlTablesToMarkdown(html);
            assert.ok(result.includes("A \\| B"), "パイプ文字がエスケープされていません");
        });

        test("ネストされたテーブル（Outlookレイアウト枠内テーブル）が壊れずに内側のデータテーブルとして抽出されること", () => {
            const html = `<table class="outer-layout" width="100%">
                <tr>
                    <td>
                        <p>お知らせ一覧</p>
                        <table class="inner-data">
                            <tr><th>日付</th><th>タイトル</th></tr>
                            <tr><td>2026-09-26</td><td>システム更新</td></tr>
                        </table>
                    </td>
                </tr>
            </table>`;
            const result = convertHtmlTablesToMarkdown(html);
            assert.ok(result.includes("| 日付 | タイトル |"), "内側テーブルのヘッダーがありません: " + result);
            assert.ok(result.includes("| 2026-09-26 | システム更新 |"), "内側テーブルのデータ行がありません: " + result);
            assert.ok(result.includes("お知らせ一覧"), "外側のテキストが消失していません: " + result);
        });

        test("単なる外枠（1行1セル）のレイアウト用テーブルは無意味な表化をせず中身を展開すること", () => {
            const html = `<table border="0" style="width:100%">
                <tr>
                    <td>
                        <p>これは単なる枠線で囲まれた段落です。</p>
                    </td>
                </tr>
            </table>`;
            const result = convertHtmlTablesToMarkdown(html);
            // 1行1セルの無意味な | これは単なる... | --- | にならず、テキストとして抽出されていること
            assert.ok(!result.includes("| --- |"), "1行1セルのレイアウト枠が表になっています: " + result);
            assert.ok(result.includes("これは単なる枠線で囲まれた段落です。"));
        });
    });
});
