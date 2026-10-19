/**
 * 仕様: ノートの「# note一覧」の追加・更新（noteListUpdater.ts）のテスト
 * 1. 対象フォルダ外のノート（10_summary のサマリーなど）は、タグが合っても一覧に載せないこと
 * 2. 本文タグは設定「本文のタグを有効にする」がオフなら判定に使わないこと
 * 3. topタグ付きノートは除外条件を免除し、書き込み先のノート自身は載せないこと
 * 4. Search Query を設定し、一覧が無ければフロントマターの直後へ挿入すること
 * 5. 内容に差分が無ければ書き込まないこと
 * 6. shouldContinue が false なら書き込まずに中断すること
 * 7. 検索条件が空・Markdown 以外は何もしないこと
 * 8. 検索条件の先頭の # は判定のときだけ取り除くこと
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { findNoteListFiles, stripTagHashes, updateNoteListForFile } from "./noteListUpdater";

type FakeFile = { path: string; name: string; basename: string; extension: string; stat: { ctime: number; mtime: number } };

const makeFile = (path: string, mtime = 0): FakeFile => {
    const name = path.split("/").pop()!;
    return { path, name, basename: name.replace(/\.md$/, ""), extension: "md", stat: { ctime: 0, mtime } };
};

const makeApp = (entries: { file: FakeFile; frontmatter?: Record<string, unknown>; bodyTags?: string[]; content?: string }[]) => {
    const contents = new Map(entries.map(e => [e.file.path, e.content ?? ""]));
    const frontmatters = new Map(entries.map(e => [e.file.path, e.frontmatter]));
    const writes: string[] = [];
    const app = {
        vault: {
            getMarkdownFiles: () => entries.map(e => e.file),
            cachedRead: async (file: FakeFile) => contents.get(file.path) ?? "",
            read: async (file: FakeFile) => contents.get(file.path) ?? "",
            modify: async (file: FakeFile, data: string) => { writes.push(file.path); contents.set(file.path, data); },
        },
        metadataCache: {
            getFileCache: (file: FakeFile) => {
                const entry = entries.find(e => e.file.path === file.path);
                return {
                    frontmatter: frontmatters.get(file.path),
                    tags: (entry?.bodyTags ?? []).map(tag => ({ tag })),
                };
            },
        },
        fileManager: {
            processFrontMatter: async (file: FakeFile, fn: (fm: Record<string, unknown>) => void) => {
                const fm = { ...(frontmatters.get(file.path) ?? {}) };
                fn(fm);
                frontmatters.set(file.path, fm);
            },
        },
    };
    return { app: app as any, contents, frontmatters, writes };
};

const scope = { tagTargetFolders: ["01_data", "02_MOC"], enableBodyTags: false };

describe("findNoteListFiles", () => {
    const top = makeFile("02_MOC/project_top.md");
    const note = makeFile("01_data/2026/10/a.md", 2);
    const older = makeFile("01_data/2026/09/b.md", 1);
    const summary = makeFile("10_summary/project_summary.md", 3);
    const bodyOnly = makeFile("01_data/2026/10/c.md");
    const otherTop = makeFile("02_MOC/other_top.md");
    const { app } = makeApp([
        { file: top, frontmatter: { tags: ["project", "top"] } },
        { file: note, frontmatter: { tags: ["project"] } },
        { file: older, frontmatter: { tags: ["project"] } },
        { file: summary, frontmatter: { tags: ["project"] } },
        { file: bodyOnly, bodyTags: ["#project"] },
        { file: otherTop, frontmatter: { tags: ["project", "top", "done"] } },
    ]);

    it("1. 対象フォルダ外のサマリーは載せず、更新日時の降順に並べること", () => {
        const paths = findNoteListFiles(app, scope, "project -done", top as any).map(f => f.path);
        assert.ok(!paths.includes(summary.path), "10_summary のサマリーは載せない");
        assert.deepEqual(paths.slice(0, 2), [note.path, older.path]);
    });

    it("2. 本文タグは設定がオフなら使わず、オンなら使うこと", () => {
        assert.ok(!findNoteListFiles(app, scope, "project", top as any).some(f => f.path === bodyOnly.path));
        assert.ok(findNoteListFiles(app, { ...scope, enableBodyTags: true }, "project", top as any).some(f => f.path === bodyOnly.path));
    });

    it("3. topタグ付きノートは除外条件を免除し、書き込み先自身は載せないこと", () => {
        const paths = findNoteListFiles(app, scope, "project -done", top as any).map(f => f.path);
        assert.ok(paths.includes(otherTop.path));
        assert.ok(!paths.includes(top.path));
    });
});

describe("updateNoteListForFile", () => {
    it("4. Search Query を設定し、フロントマターの直後へ一覧を挿入すること", async () => {
        const top = makeFile("02_MOC/project_top.md");
        const note = makeFile("01_data/a.md");
        const summary = makeFile("10_summary/project_summary.md");
        const { app, contents, frontmatters } = makeApp([
            { file: top, frontmatter: { tags: ["top"] }, content: "---\ntags: [top]\n---\n本文\n" },
            { file: note, frontmatter: { tags: ["project"] }, content: "ノートA" },
            { file: summary, frontmatter: { tags: ["project"] }, content: "サマリー" },
        ]);

        const result = await updateNoteListForFile(app, scope, top as any, " project ");
        assert.deepEqual(result, { status: "updated", matchCount: 1 });
        assert.equal(frontmatters.get(top.path)?.["Search Query"], "project");
        const written = contents.get(top.path)!;
        assert.ok(written.startsWith("---\ntags: [top]\n---\n# note一覧\n"));
        assert.ok(written.includes('"path":"01_data/a.md"'));
        assert.ok(!written.includes("project_summary"), "サマリーは一覧に入らない");
        assert.ok(written.endsWith("本文\n"));
    });

    it("5. 内容に差分が無ければ書き込まないこと", async () => {
        const top = makeFile("02_MOC/project_top.md");
        const note = makeFile("01_data/a.md");
        const { app, writes } = makeApp([
            { file: top, frontmatter: { tags: ["top"], "Search Query": "project" }, content: "本文\n" },
            { file: note, frontmatter: { tags: ["project"] }, content: "ノートA" },
        ]);
        await updateNoteListForFile(app, scope, top as any, "project");
        await updateNoteListForFile(app, scope, top as any, "project");
        assert.deepEqual(writes, [top.path]);
    });

    it("6. shouldContinue が false なら書き込まずに中断すること", async () => {
        const top = makeFile("02_MOC/project_top.md");
        const { app, writes, frontmatters } = makeApp([{ file: top, frontmatter: { tags: ["top"] }, content: "本文\n" }]);
        const result = await updateNoteListForFile(app, scope, top as any, "project", { shouldContinue: () => false });
        assert.deepEqual(result, { status: "cancelled" });
        assert.deepEqual(writes, []);
        assert.equal(frontmatters.get(top.path)?.["Search Query"], undefined);
    });

    it("7. 検索条件が空・Markdown 以外は何もしないこと", async () => {
        const top = makeFile("02_MOC/project_top.md");
        const drawing = makeFile("02_MOC/図.excalidraw.md");
        const { app, writes } = makeApp([{ file: top }, { file: drawing }]);
        assert.deepEqual(await updateNoteListForFile(app, scope, top as any, "  "), { status: "empty-query" });
        assert.deepEqual(await updateNoteListForFile(app, scope, drawing as any, "project"), { status: "not-markdown" });
        assert.deepEqual(await updateNoteListForFile(app, scope, null, "project"), { status: "not-markdown" });
        assert.deepEqual(writes, []);
    });
});

describe("stripTagHashes", () => {
    it("8. 検索条件の先頭の # は判定のときだけ取り除くこと", async () => {
        assert.equal(stripTagHashes("#todo  -#done　#a#b"), "todo -done a#b");
        const top = makeFile("02_MOC/todo_top.md");
        const note = makeFile("01_data/a.md");
        const { app, frontmatters } = makeApp([
            { file: top, content: "本文\n" },
            { file: note, frontmatter: { tags: ["todo"] } },
        ]);
        assert.deepEqual(await updateNoteListForFile(app, scope, top as any, "#todo"), { status: "updated", matchCount: 1 });
        assert.equal(frontmatters.get(top.path)?.["Search Query"], "#todo");
    });
});
