<!--
仕様:
1. AI が作った・編集したノートのうち、人がまだレビューしていないもの（プロパティ `ai_reviewed` が true でないもの）を一覧表示する。
2. 対象は、プロパティに `ai_generated` / `ai_edited` / `ai_reviewed` のいずれかを持つ Markdown（`*.excalidraw.md` を含む）。AI に関係ないノートは出さない。
   - `ai_reviewed: false`、`ai_reviewed:` が空、`ai_reviewed` が無い（`ai_generated` / `ai_edited` だけがある）ものは未レビューとして扱う。
   - `ai_reviewed: true`（文字列 "true" も可）だけをレビュー済みとして除外する。
3. 03_Dataview 配下は対象外。
4. 更新日時の新しい順に並べる。ノート名で絞り込める。
5. ファイル名のクリックで開く（Ctrl/Cmd+クリックで新しいタブ）。
-->

# AI 未レビューのノート一覧

```dataviewjs
/**
 * ai_reviewed が true でない AI 関連ノートを一覧表示する。
 * プロパティ（YAML フロントマター）は metadataCache から読む。
 **/

// プロパティ値が「チェック済み」かどうか（真偽値 true、または文字列 "true"）
function isChecked(value) {
    if (value === true) return true;
    return typeof value === "string" && value.trim().toLowerCase() === "true";
}

// 表示用に、プロパティ値を短い文字列へ変換する（空・未設定は空文字）
function propText(value) {
    if (value == null || value === false) return "";
    if (Array.isArray(value)) return value.map(String).join(", ");
    return String(value);
}

function hasKey(frontmatter, key) {
    return Object.prototype.hasOwnProperty.call(frontmatter, key);
}

const files = app.vault.getMarkdownFiles()
    .filter(file => !file.path.startsWith("03_Dataview/"))
    .map(file => ({ file, fm: app.metadataCache.getFileCache(file)?.frontmatter }))
    .filter(({ fm }) => fm && (hasKey(fm, "ai_generated") || hasKey(fm, "ai_edited") || hasKey(fm, "ai_reviewed")))
    .filter(({ fm }) => !isChecked(fm.ai_reviewed))
    .sort((a, b) => b.file.stat.mtime - a.file.stat.mtime);

const rootEl = this.container.createEl("div");

const searchInput = rootEl.createEl("input", {
    type: "search",
    attr: { placeholder: "ノート名で検索…", "aria-label": "ノート名で検索" },
});
searchInput.style.marginBottom = "0.75em";
searchInput.style.width = "min(100%, 28em)";

const countEl = rootEl.createEl("div", { attr: { style: "margin-bottom: 0.5em; color: var(--text-muted);" } });

if (files.length === 0) {
    countEl.setText("未レビューのノートはありません。");
} else {
    const table = rootEl.createEl("table");
    const headRow = table.createEl("thead").createEl("tr");
    ["ファイル名", "フォルダ", "ai_generated", "ai_edited", "作成日時", "更新日時"]
        .forEach(text => headRow.createEl("th", { text }));
    const tbody = table.createEl("tbody");

    const rows = files.map(({ file, fm }) => {
        const tr = tbody.createEl("tr");
        tr.dataset.fileName = file.basename;

        // クリックは自前で処理する（Ctrl/Cmd+クリックで新しいタブ）
        const nameCell = tr.createEl("td");
        const link = nameCell.createEl("a", { text: file.basename, cls: "internal-link" });
        link.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            app.workspace.getLeaf(ev.ctrlKey || ev.metaKey ? "tab" : false).openFile(file);
        });

        tr.createEl("td", { text: file.parent?.path ?? "" });
        tr.createEl("td", { text: propText(fm.ai_generated) });
        tr.createEl("td", { text: propText(fm.ai_edited) });
        tr.createEl("td", { text: moment(file.stat.ctime).format("YYYY-MM-DD HH:mm") });
        tr.createEl("td", { text: moment(file.stat.mtime).format("YYYY-MM-DD HH:mm") });
        return tr;
    });

    const updateCount = () => {
        const shown = rows.filter(row => row.style.display !== "none").length;
        countEl.setText(`未レビュー: ${shown} 件（全 ${rows.length} 件）`);
    };
    updateCount();

    searchInput.addEventListener("input", () => {
        const query = searchInput.value.trim().toLocaleLowerCase();
        rows.forEach(row => {
            row.style.display = row.dataset.fileName.toLocaleLowerCase().includes(query) ? "" : "none";
        });
        updateCount();
    });
}
```
