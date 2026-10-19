/**
 * ノートの「# note一覧」の追加・更新
 *
 * 仕様:
 * - 検索条件（Search Query）に合うノートを、設定「タグの対象フォルダ」（既定: 01_data, 02_MOC）の中から集める。
 *   10_summary のサマリーなど、対象フォルダ外のノートは一覧に載せない。
 * - タグの判定は tag_key の検索と同じ（設定「本文のタグを有効にする」に従う）。topタグ付きノートは除外条件（-tag）を免除する。
 * - 一覧を書き込むノート自身は一覧に載せない。並び順は更新日時の降順。
 * - タグの右クリックメニューから渡る「#todo」のような先頭の # は、判定のときだけ取り除く（Search Query には渡された値を保存する）。
 * - ノートの Search Query プロパティを検索条件に合わせ、既存の「# note一覧」を置き換える（無ければフロントマターの直後へ挿入）。
 * - 差分が無いときは書き込まない（他プラグインの再処理を起こさない）。
 * - shouldContinue が false を返したら、書き込む前に中断する（タブを移動した後の自動更新など）。
 * - サイドバーの「ノート一覧を追加」と、ノートを開いたときの自動更新（RegisterCustomCommands.md）の両方がこれを使う。
 **/
import type { App, TFile } from "obsidian";
import { filterFilesByTagQuery, extractTagsFromMetadata } from "./utils";
import {
    buildNoteListContent,
    extractNoteExcerpt,
    formatNoteListDate,
    insertNoteListAfterFrontmatter,
    isTagTargetPath,
    replaceNoteListSection,
    uniqueNoteListTags,
    type NoteListRow,
} from "./noteListSection";

export interface NoteListScope {
    tagTargetFolders: string[];
    enableBodyTags: boolean;
}

export interface NoteListUpdateOptions {
    shouldContinue?: () => boolean;
}

export type NoteListUpdateResult =
    | { status: "updated"; matchCount: number }
    | { status: "empty-query" | "not-markdown" | "cancelled" }
    | { status: "error"; error: unknown };

export function isNoteListTargetFile(file: TFile | null | undefined): file is TFile {
    return !!file && file.extension === "md" && !file.name.endsWith(".excalidraw.md");
}

/** 検索条件の各キーワードから先頭の # を取り除く（「-#tag」は「-tag」にする）。 */
export function stripTagHashes(query: string): string {
    return query.split(/[\s\u3000]+/)
        .map(keyword => keyword.replace(/^(-?)#+/, "$1"))
        .filter(keyword => keyword.length > 0)
        .join(" ");
}

/** 一覧に載せるノート（書き込み先のノート自身を除く。更新日時の降順） */
export function findNoteListFiles(app: App, scope: NoteListScope, query: string, targetFile: TFile): TFile[] {
    const files = app.vault.getMarkdownFiles()
        .filter(file => isTagTargetPath(file.path, scope.tagTargetFolders));
    return filterFilesByTagQuery(files, stripTagHashes(query), (file) => {
        const cache = app.metadataCache.getFileCache(file);
        return extractTagsFromMetadata(cache, scope.enableBodyTags);
    }, {
        // MOC用のtopノートは、除外タグを持っていても一覧に残す。
        includeTopTaggedExcluded: true,
    }).filter(file => file.path !== targetFile.path);
}

async function buildNoteListRow(app: App, file: TFile): Promise<NoteListRow> {
    const cache = app.metadataCache.getFileCache(file);
    const content = await app.vault.cachedRead(file);
    return {
        path: file.path,
        name: file.basename,
        // note一覧のタグ列は、ノート上部のプロパティに設定したタグだけを表示する。
        // 文字列にまとめず配列のまま渡し、DataviewJS 側で Obsidian のタグ要素として描画する。
        tags: uniqueNoteListTags(extractTagsFromMetadata(cache, false)),
        excerpt: extractNoteExcerpt(content),
        ctime: formatNoteListDate(file.stat.ctime),
        mtime: formatNoteListDate(file.stat.mtime),
    };
}

export async function updateNoteListForFile(
    app: App,
    scope: NoteListScope,
    file: TFile | null | undefined,
    rawQuery: unknown,
    options: NoteListUpdateOptions = {},
): Promise<NoteListUpdateResult> {
    const shouldContinue = options.shouldContinue ?? (() => true);
    const query = String(rawQuery ?? "").trim();
    if (!query) return { status: "empty-query" };
    if (!isNoteListTargetFile(file)) return { status: "not-markdown" };
    if (!shouldContinue()) return { status: "cancelled" };

    const matches = findNoteListFiles(app, scope, query, file);
    const rows = await Promise.all(matches.map(match => buildNoteListRow(app, match)));
    if (!shouldContinue()) return { status: "cancelled" };
    const noteListContent = buildNoteListContent(rows);

    try {
        const cachedFrontmatter = app.metadataCache.getFileCache(file)?.frontmatter || {};
        const existingSearchKey = Object.keys(cachedFrontmatter).find(key =>
            key.toLowerCase().replace(/\s+/g, "") === "searchquery"
        );
        // 同じ値を毎回書き戻すと他プラグインの再処理を起こすため、差分があるときだけ更新する。
        if (!existingSearchKey || String(cachedFrontmatter[existingSearchKey] ?? "") !== query) {
            if (!shouldContinue()) return { status: "cancelled" };
            await app.fileManager.processFrontMatter(file, (frontmatter) => {
                const frontmatterKey = Object.keys(frontmatter).find(key =>
                    key.toLowerCase().replace(/\s+/g, "") === "searchquery"
                );
                frontmatter[frontmatterKey || "Search Query"] = query;
            });
        }

        if (!shouldContinue()) return { status: "cancelled" };
        const originalFileContent = await app.vault.read(file);
        const fileContent = replaceNoteListSection(originalFileContent, noteListContent)
            ?? insertNoteListAfterFrontmatter(originalFileContent, noteListContent);

        if (fileContent !== originalFileContent) {
            if (!shouldContinue()) return { status: "cancelled" };
            // vault.modify による標準のファイル更新通知へ任せる。previewMode.rerender(true) を
            // 併用すると Windows では Dataview の既存 DOM が残り、一覧が重複することがある。
            await app.vault.modify(file, fileContent);
        }
        return { status: "updated", matchCount: matches.length };
    } catch (error) {
        return { status: "error", error };
    }
}
