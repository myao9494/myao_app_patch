/**
 * ノート本文の「# note一覧」セクションの置換
 *
 * 仕様:
 * - タグからノート一覧を追加・更新するとき、既存の「# note一覧」セクションを新しい内容で置き換える。
 * - 目印（<!-- custom-note-list:start --> 〜 <!-- custom-note-list:end -->）で囲まれた範囲があれば、
 *   その範囲だけを置き換える（見出しの後に続く通常の本文を消さない）。
 * - 目印が無い旧形式は、見出し直下の表または箇条書きだけを置き換える。
 * - 「# note一覧」が無い場合は null を返す（呼び出し側がフロントマターの直後へ挿入する）。
 * - 一覧に載せるのは、設定「タグの対象フォルダ」内のノートだけ（10_summary のサマリーなどは載せない）。
 *   ノートを開いたときの自動更新（RegisterCustomCommands.md）も window._sidebarExplorerTagUpdateNoteList
 *   経由でこのプラグインの実装を使うため、手動の「ノート一覧を追加」と同じ内容になる。
 **/

export const NOTE_LIST_MARKER_START = "<!-- custom-note-list:start -->";
export const NOTE_LIST_MARKER_END = "<!-- custom-note-list:end -->";

export function replaceNoteListSection(fileContent: string, noteListContent: string): string | null {
    // 一覧の内容に「$&」などが含まれても置換パターンとして解釈されないよう、関数で置き換える。
    const markedListRegex = /# note一覧[^\n]*\n\s*<!-- custom-note-list:start -->[\s\S]*?<!-- custom-note-list:end -->\n?/;
    if (markedListRegex.test(fileContent)) {
        return fileContent.replace(markedListRegex, () => noteListContent);
    }

    const legacyListRegex = /# note一覧[^\n]*\n(?:\s*\n)?(?:(?:\|.*\|\s*\n)|(?:- .*(?:\n|$)))*/;
    if (legacyListRegex.test(fileContent)) {
        return fileContent.replace(legacyListRegex, () => noteListContent);
    }

    return null;
}

/** ノート一覧の1行分のデータ */
export interface NoteListRow {
    path: string;
    name: string;
    tags: string[];
    excerpt: string;
    ctime: string;
    mtime: string;
}

/** タグ検索・ノート一覧の対象パスか。対象フォルダが空なら Vault 全体（node_modules 配下は除く）。 */
export function isTagTargetPath(path: string, targetFolders: string[]): boolean {
    if (path.includes("/node_modules/") || path.startsWith("node_modules/")) return false;
    return targetFolders.length === 0 || targetFolders.some(folder => path === folder || path.startsWith(`${folder}/`));
}

/** 「冒頭」列に出す本文の抜粋（先頭100文字）。フロントマター・一覧自身・埋め込み・リンク記法を除く。 */
export function extractNoteExcerpt(content: string): string {
    let clean = content;
    // YAMLフロントマターを除去
    clean = clean.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    // # note一覧 セクションを除去 (次の大見出し # まで、またはファイルの終わりまで)
    clean = clean.replace(/#\s+note一覧[\s\S]*?(?=\n#\s|$)/i, "");

    return clean
        .replace(/!\[\[[^\]]*\]\]/g, "")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/<img\b[^>]*>/gi, "")
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
        .replace(/\[\[([^\]]+)\]\]/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 100)
        .replace(/#/g, "\\#");
}

/** タグを「#タグ」の形にそろえ、大文字小文字の違いだけの重複を1つにまとめる（最初の表記を残す）。 */
export function uniqueNoteListTags(rawTags: string[]): string[] {
    const seen = new Set<string>();
    const uniqueTags: string[] = [];
    for (const t of rawTags) {
        const clean = t.startsWith("#") ? t.substring(1) : t;
        const normalized = "#" + clean.trim();
        const lower = normalized.toLowerCase();
        if (!seen.has(lower)) {
            seen.add(lower);
            uniqueTags.push(normalized);
        }
    }
    return uniqueTags;
}

/** 作成日・編集日の表示（ローカル時刻の YYYY-MM-DD HH:mm） */
export function formatNoteListDate(timestamp: number): string {
    const date = new Date(timestamp);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * ノートへ書き込む「# note一覧」セクション（検索ボックス付きの DataviewJS ブロック）を組み立てる。
 * ※ 出力はノートに保存される。1文字でも変えると、一覧を持つ全ノートが次回の自動更新で書き換わる。
 */
export function buildNoteListContent(rows: NoteListRow[]): string {
    const noteListData = JSON.stringify(rows);
    return `# note一覧
${NOTE_LIST_MARKER_START}

\`\`\`dataviewjs
// Sidebar Explorer Tagの更新後も、検索ボックスを含む表を再生成する。
const noteListRows = ${noteListData};
const sourcePath = dv.current().file.path;
const searchInput = dv.el("input", "", {
    attr: {
        type: "search",
        placeholder: "ノート名で検索…",
        "aria-label": "ノート名で検索"
    }
});
searchInput.style.marginBottom = "0.75em";
searchInput.style.width = "min(100%, 28em)";

const tableContainer = dv.el("div", "");
const renderNoteList = () => {
    const keywords = searchInput.value.trim().toLocaleLowerCase()
        .split(/[\\s\\u3000]+/).filter(Boolean);
    const filteredRows = noteListRows.filter(row => {
        const name = row.name.toLocaleLowerCase();
        return keywords.every(keyword => name.includes(keyword));
    });

    tableContainer.empty();
    const table = tableContainer.createEl("table", { cls: "dataview table-view-table" });
    const headerRow = table.createEl("thead").createEl("tr");
    ["名称", "タグ", "冒頭", "作成日", "編集日"].forEach(title => headerRow.createEl("th", { text: title }));
    const body = table.createEl("tbody");

    if (filteredRows.length === 0) {
        const row = body.createEl("tr");
        row.createEl("td", { text: "該当するノートがありません", attr: { colspan: "5" } });
        return;
    }

    filteredRows.forEach(rowData => {
        const row = body.createEl("tr");
        const nameCell = row.createEl("td");
        const linkButton = nameCell.createEl("button", { text: rowData.name });
        linkButton.type = "button";
        linkButton.style.cssText = "padding:0;border:0;background:transparent;color:var(--link-color);cursor:pointer;text-decoration:var(--link-decoration);font:inherit;text-align:left;";
        linkButton.addEventListener("click", event => {
            event.preventDefault();
            event.stopImmediatePropagation();
            const targetFile = app.vault.getAbstractFileByPath(rowData.path);
            if (targetFile && typeof window._openNoteListLinkInRightPane === "function") {
                void window._openNoteListLinkInRightPane(targetFile, sourcePath);
            } else if (targetFile) {
                const targetLeaf = app.workspace.getLeaf("split", "vertical");
                if (targetLeaf) void targetLeaf.openFile(targetFile, { active: true });
            }
        });
        const tagCell = row.createEl("td");
        (Array.isArray(rowData.tags) ? rowData.tags : String(rowData.tags || "").split(/\\s+/))
            .filter(Boolean)
            .forEach(tag => {
                const tagName = String(tag).replace(/^#/, "");
                const tagLink = tagCell.createEl("a", {
                    cls: "tag",
                    text: "#" + tagName,
                    attr: { href: "#" + tagName, "data-href": tagName }
                });
                tagLink.style.marginRight = "0.35em";
            });
        row.createEl("td", { text: rowData.excerpt });
        row.createEl("td", { text: rowData.ctime });
        row.createEl("td", { text: rowData.mtime });
    });
};

searchInput.addEventListener("input", renderNoteList);
renderNoteList();
\`\`\`

${NOTE_LIST_MARKER_END}
`;
}

/** 一覧がまだ無いノートへ、フロントマターの直後（無ければ先頭）に一覧を挿入する。 */
export function insertNoteListAfterFrontmatter(fileContent: string, noteListContent: string): string {
    const hasFrontmatter = fileContent.startsWith("---\n") || fileContent.startsWith("---\r\n");
    let insertIndex = 0;
    if (hasFrontmatter) {
        const secondTripleDash = fileContent.indexOf("\n---", 3);
        if (secondTripleDash !== -1) {
            const endOfLine = fileContent.indexOf("\n", secondTripleDash + 4);
            if (endOfLine !== -1) {
                insertIndex = endOfLine + 1;
            } else {
                insertIndex = secondTripleDash + 4;
            }
        }
    }
    return fileContent.slice(0, insertIndex) + noteListContent + "\n" + fileContent.slice(insertIndex);
}
