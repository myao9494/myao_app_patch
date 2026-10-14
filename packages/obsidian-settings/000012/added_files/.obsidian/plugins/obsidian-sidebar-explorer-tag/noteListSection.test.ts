/**
 * 仕様: 「# note一覧」セクションの置換のテスト
 * 1. 目印で囲まれた範囲だけを置き換え、後に続く本文を残すこと
 * 2. 目印の無い旧形式は、見出し直下の表または箇条書きだけを置き換えること
 * 3. セクションが無い場合は null を返すこと
 * 4. 一覧の内容に置換パターン（$& など）と解釈される文字があっても、そのまま書き込むこと
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { NOTE_LIST_MARKER_START, NOTE_LIST_MARKER_END, replaceNoteListSection } from "./noteListSection";

const newList = `# note一覧\n${NOTE_LIST_MARKER_START}\n| 名称 |\n| --- |\n| 新 |\n${NOTE_LIST_MARKER_END}\n`;

describe("replaceNoteListSection", () => {
    it("1. 目印で囲まれた範囲だけを置き換え、後に続く本文を残すこと", () => {
        const content = `前文\n\n# note一覧\n${NOTE_LIST_MARKER_START}\n| 名称 |\n| --- |\n| 旧 |\n${NOTE_LIST_MARKER_END}\n見出しの後の本文\n\n# 次の章\n本文`;
        const result = replaceNoteListSection(content, newList);
        assert.equal(result, `前文\n\n${newList}見出しの後の本文\n\n# 次の章\n本文`);
    });

    it("2. 目印の無い旧形式は、見出し直下の表または箇条書きだけを置き換えること", () => {
        const table = `# note一覧\n| 名称 |\n| --- |\n| 旧 |\n\n通常の本文\n`;
        // 表の直後の空行までが置き換え範囲になる
        assert.equal(replaceNoteListSection(table, newList), `${newList}通常の本文\n`);

        const bullets = `# note一覧\n\n- [[a]]\n- [[b]]\n続きの本文`;
        assert.equal(replaceNoteListSection(bullets, newList), `${newList}続きの本文`);
    });

    it("3. セクションが無い場合は null を返すこと", () => {
        assert.equal(replaceNoteListSection("# 別の見出し\n本文", newList), null);
    });

    it("4. 一覧の内容に $& や $1 が含まれても、そのまま書き込むこと", () => {
        const content = `# note一覧\n${NOTE_LIST_MARKER_START}\n旧\n${NOTE_LIST_MARKER_END}\n`;
        const list = `# note一覧\n${NOTE_LIST_MARKER_START}\n| 価格は $1 と $& |\n${NOTE_LIST_MARKER_END}\n`;
        assert.equal(replaceNoteListSection(content, list), list);
    });
});
