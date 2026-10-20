/**
 * 仕様: 「# note一覧」セクションの置換のテスト
 * 1. 目印で囲まれた範囲だけを置き換え、後に続く本文を残すこと
 * 2. 目印の無い旧形式は、見出し直下の表または箇条書きだけを置き換えること
 * 3. セクションが無い場合は null を返すこと
 * 4. 一覧の内容に置換パターン（$& など）と解釈される文字があっても、そのまま書き込むこと
 * 5. isTagTargetPath: 対象フォルダ内のパスだけを対象にし（10_summary などは対象外）、node_modules 配下は除く
 * 6. extractNoteExcerpt: フロントマター・一覧自身・埋め込みを除き、リンクは表示文字だけを残して100文字で切る
 * 7. uniqueNoteListTags: 大文字小文字の違いだけの重複を1つにまとめる
 * 8. insertNoteListAfterFrontmatter: フロントマターの直後（無ければ先頭）へ挿入する
 * 9. buildNoteListContent: 見出しと目印で囲んだ DataviewJS ブロックを出力する
 * 10. 一覧の検索ボックス: 名称・タグ・冒頭を対象に、すべてのキーワードを含む行だけを表示する
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
    NOTE_LIST_MARKER_START,
    NOTE_LIST_MARKER_END,
    replaceNoteListSection,
    isTagTargetPath,
    extractNoteExcerpt,
    uniqueNoteListTags,
    insertNoteListAfterFrontmatter,
    buildNoteListContent,
} from "./noteListSection";

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

describe("ノート一覧のヘルパー", () => {
    it("5. isTagTargetPath は対象フォルダ内だけを対象にし、node_modules 配下を除くこと", () => {
        const folders = ["01_data", "02_MOC"];
        assert.equal(isTagTargetPath("01_data/2026/a.md", folders), true);
        assert.equal(isTagTargetPath("02_MOC/b.md", folders), true);
        assert.equal(isTagTargetPath("10_summary/x_summary.md", folders), false);
        assert.equal(isTagTargetPath("01_data_old/a.md", folders), false);
        assert.equal(isTagTargetPath("01_data/node_modules/a.md", folders), false);
        assert.equal(isTagTargetPath("10_summary/x_summary.md", []), true, "対象フォルダが空なら Vault 全体");
    });

    it("6. extractNoteExcerpt はフロントマターと一覧自身を除き、リンクは表示文字だけを残すこと", () => {
        const content = "---\ntags:\n  - top\n---\n# note一覧\n| 名称 | タグ |\n|---|---|\n| test | #tag |\n\n# 挨拶\nこれから全力で技を伝授します。";
        const result = extractNoteExcerpt(content);
        assert.ok(!result.includes("note一覧"));
        assert.ok(!result.includes("tags:"));
        assert.ok(result.includes("これから全力で"));

        assert.equal(
            extractNoteExcerpt("![[図.png|200]] 本文 [[ノートA|別名]] と [[ノートB]] と [外部](https://example.com) #tag"),
            "本文 別名 と ノートB と 外部 \\#tag",
        );
        assert.equal(extractNoteExcerpt("あ".repeat(150)).length, 100);
    });

    it("7. uniqueNoteListTags は大文字小文字の違いだけの重複を1つにまとめること", () => {
        assert.deepEqual(uniqueNoteListTags(["Project", "#project", "memo"]), ["#Project", "#memo"]);
    });

    it("8. insertNoteListAfterFrontmatter はフロントマターの直後へ、無ければ先頭へ挿入すること", () => {
        assert.equal(insertNoteListAfterFrontmatter("---\ntags: [top]\n---\n本文\n", "LIST"), "---\ntags: [top]\n---\nLIST\n本文\n");
        assert.equal(insertNoteListAfterFrontmatter("本文\n", "LIST"), "LIST\n本文\n");
    });

    it("9. buildNoteListContent は見出しと目印で囲んだ DataviewJS ブロックを出力すること", () => {
        const rows = [{ path: "a.md", name: "a", tags: ["#x"], excerpt: "抜粋", ctime: "c", mtime: "m" }];
        const content = buildNoteListContent(rows);
        assert.ok(content.startsWith(`# note一覧\n${NOTE_LIST_MARKER_START}\n`));
        assert.ok(content.endsWith(`${NOTE_LIST_MARKER_END}\n`));
        assert.ok(content.includes("```dataviewjs"));
        assert.ok(content.includes(`const noteListRows = ${JSON.stringify(rows)};`));
        // 生成した一覧は、同じ関数で置き換えられる形になっていること
        assert.equal(replaceNoteListSection(`前\n${content}後`, "NEW\n"), "前\nNEW\n後");
    });
});

/** DataviewJS の実行に必要な分だけの擬似要素 */
class FakeEl {
    tag: string; text: string; value = ""; style: Record<string, string> = {};
    children: FakeEl[] = []; listeners: Record<string, (() => void)[]> = {};
    constructor(tag: string, text = "") { this.tag = tag; this.text = text; }
    createEl(tag: string, options: { text?: string } = {}) { const el = new FakeEl(tag, options.text ?? ""); this.children.push(el); return el; }
    empty() { this.children = []; }
    addEventListener(type: string, fn: () => void) { (this.listeners[type] ??= []).push(fn); }
    findAll(tag: string): FakeEl[] { return this.children.flatMap(c => [...(c.tag === tag ? [c] : []), ...c.findAll(tag)]); }
}

/** 生成した DataviewJS を実行し、検索語ごとに表示される「名称」を返す関数を作る */
const runNoteListScript = (rows: Parameters<typeof buildNoteListContent>[0]) => {
    const content = buildNoteListContent(rows);
    const code = content.slice(content.indexOf("```dataviewjs\n") + "```dataviewjs\n".length, content.lastIndexOf("```"));
    const els: FakeEl[] = [];
    const dv = { current: () => ({ file: { path: "top.md" } }), el: (tag: string) => { const el = new FakeEl(tag); els.push(el); return el; } };
    new Function("dv", "app", "window", code)(dv, {}, {});
    const [searchInput, tableContainer] = els;
    return (query: string) => {
        searchInput.value = query;
        searchInput.listeners.input.forEach(fn => fn());
        return tableContainer.findAll("button").map(button => button.text);
    };
};

describe("ノート一覧の検索ボックス", () => {
    it("10. 名称・タグ・冒頭を対象に、すべてのキーワードを含む行だけを表示すること", () => {
        const search = runNoteListScript([
            { path: "a.md", name: "会議メモ", tags: ["#Project"], excerpt: "予算の確認 \\#重要", ctime: "", mtime: "" },
            { path: "b.md", name: "日報", tags: ["#daily"], excerpt: "作業の記録", ctime: "", mtime: "" },
        ]);
        assert.deepEqual(search(""), ["会議メモ", "日報"]);
        assert.deepEqual(search("会議"), ["会議メモ"], "名称");
        assert.deepEqual(search("project"), ["会議メモ"], "タグ（大文字小文字を区別しない）");
        assert.deepEqual(search("#daily"), ["日報"], "# 付きのタグ");
        assert.deepEqual(search("記録"), ["日報"], "冒頭");
        assert.deepEqual(search("#重要"), ["会議メモ"], "冒頭のタグ記号はエスケープを外して探す");
        assert.deepEqual(search("日報　記録"), ["日報"], "全角スペース区切りの AND");
        assert.deepEqual(search("日報 予算"), [], "名称と別の行の冒頭にまたがる組み合わせは一致しない");
    });
});
