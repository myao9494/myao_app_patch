<!--
仕様:
1. Vault 内で、ファイル名に「無題のファイル」を含むファイルを一覧表示する（拡張子は問わない。`.base`、`.excalidraw.md` なども対象）。ただし `03_Dataview/` 配下のファイルは対象外。
2. 画面上部の入力欄で検索語を変更できる（初期値: 無題のファイル）。入力値は localStorage に保存され、次回も復元される。
3. 更新日時の新しい順に並べ、各行に「ファイル名」「パス」「更新日時」と、「開く」「削除」ボタンを設ける。
4. 「削除」ボタンは確認ダイアログを経てゴミ箱へ移動し、300ms 後に再スキャンして表全体を更新する。
-->

# 「無題のファイル」を含むファイル一覧

```dataviewjs
/**
 * ファイル名に検索語（初期値: 無題のファイル）を含むファイルを一覧表示する。
 * 削除実行時は自動的に再スキャン・再描画する。
 **/
const KEYWORD_STORAGE_KEY = "obsidian_untitled_file_keyword";
let keyword = "無題のファイル";
try {
    const saved = localStorage.getItem(KEYWORD_STORAGE_KEY);
    if (saved !== null) keyword = saved;
} catch (e) {
    console.error("Failed to load keyword:", e);
}

const rootEl = this.container.createEl("div");

// 検索語の入力欄
const inputWrap = rootEl.createEl("div", { attr: { style: "margin-bottom: 10px;" } });
inputWrap.createEl("span", { text: "ファイル名に含む文字列: " });
const keywordInput = inputWrap.createEl("input", {
    type: "text",
    attr: { style: "width: 260px;" }
});
keywordInput.value = keyword;

const resultEl = rootEl.createEl("div");

function formatDate(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function styleButton(btn) {
    btn.style.setProperty("background-color", "var(--interactive-accent)");
    btn.style.setProperty("border-color", "var(--interactive-accent)");
    btn.style.setProperty("color", "#111111", "important");
    btn.style.setProperty("-webkit-text-fill-color", "#111111", "important");
}

function render() {
    resultEl.empty();

    const kw = keyword.trim();
    if (!kw) {
        resultEl.createEl("p", { text: "検索語を入力してください。" });
        return;
    }

    const files = app.vault.getFiles()
        .filter(f => !f.path.startsWith("03_Dataview/") && f.name.includes(kw))
        .sort((a, b) => b.stat.mtime - a.stat.mtime);

    if (files.length === 0) {
        resultEl.createEl("p", { text: `「${kw}」を含むファイルは見つかりませんでした。` });
        return;
    }

    resultEl.createEl("p", { text: `「${kw}」を含むファイルが ${files.length} 件見つかりました。` });

    const table = resultEl.createEl("table", { cls: "dataview table-view-table" });
    const headerRow = table.createEl("thead").createEl("tr");
    headerRow.createEl("th", { text: "ファイル名" });
    headerRow.createEl("th", { text: "操作", attr: { style: "width: 150px; text-align: center;" } });
    headerRow.createEl("th", { text: "パス" });
    headerRow.createEl("th", { text: "更新日時" });

    const tbody = table.createEl("tbody");

    for (const file of files) {
        const row = tbody.createEl("tr");

        // ファイル名（クリックで開く内部リンク）
        const nameCell = row.createEl("td");
        const link = nameCell.createEl("a", { text: file.name, cls: "internal-link", href: file.path });
        link.setAttr("data-href", file.path);
        link.addEventListener("click", (ev) => {
            ev.preventDefault();
            app.workspace.getLeaf(ev.ctrlKey || ev.metaKey ? "tab" : false).openFile(file);
        });

        const actionCell = row.createEl("td", { attr: { style: "text-align: center;" } });

        const openBtn = actionCell.createEl("button", { text: "開く", attr: { style: "margin-right: 5px;" } });
        styleButton(openBtn);
        openBtn.addEventListener("click", () => {
            app.workspace.getLeaf("tab").openFile(file);
        });

        const deleteBtn = actionCell.createEl("button", { text: "削除" });
        styleButton(deleteBtn);
        deleteBtn.addEventListener("click", async () => {
            if (!confirm(`本当にファイル "${file.path}" を削除（ゴミ箱へ移動）しますか？`)) return;
            try {
                await app.vault.trash(file, true);
                new Notice(`ファイル "${file.path}" を削除しました。`);
                setTimeout(render, 300);
            } catch (err) {
                new Notice(`削除に失敗しました: ${err.message}`);
            }
        });

        row.createEl("td", { text: file.parent ? file.parent.path : "" });
        row.createEl("td", { text: formatDate(file.stat.mtime) });
    }
}

keywordInput.addEventListener("input", () => {
    keyword = keywordInput.value;
    try { localStorage.setItem(KEYWORD_STORAGE_KEY, keyword); } catch (e) {}
    render();
});

render();
```
