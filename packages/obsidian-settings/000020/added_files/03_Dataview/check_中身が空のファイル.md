<!--
仕様:
1. 01_data ディレクトリ配下で、中身が空のファイルを一覧表示する。
   - 0バイトのファイル（拡張子を問わない）
   - Markdown（`.md`）で、本文が空白・改行だけのもの
   - Markdown（`.md`）で、フロントマター（`---` で囲まれた部分）だけで本文が無いもの
2. 各行の「理由」で、どの種類の空かを示す。
3. ファイル名の右に「開く」「削除」ボタンを置く（開いて確認した後、マウス移動を最小にして削除できるように）。
4. 「削除」ボタンは確認ダイアログを経てゴミ箱へ移動し、300ms 後に再スキャンして表全体を更新する。
5. 画面上部のチェックボックスで「フロントマターのみ」を一覧に含めるかを切り替える（localStorage に保存）。
6. 更新日時の新しい順に並べる。03_Dataview 配下は対象外。
-->

# 中身が空のファイル一覧 (01_data 配下)

```dataviewjs
/**
 * 01_data配下で、中身が空のファイルを一覧表示する。
 * 削除実行時は自動的に再スキャン・再描画する。
 **/
const FM_STORAGE_KEY = "obsidian_empty_file_include_frontmatter_only";
let includeFrontmatterOnly = true;
try {
    const saved = localStorage.getItem(FM_STORAGE_KEY);
    if (saved !== null) includeFrontmatterOnly = saved === "true";
} catch (e) {
    console.error("Failed to load option:", e);
}

const rootEl = this.container.createEl("div");

// オプション: フロントマターのみのファイルを含めるか
const optionWrap = rootEl.createEl("div", { attr: { style: "margin-bottom: 10px;" } });
const fmLabel = optionWrap.createEl("label");
const fmCheckbox = fmLabel.createEl("input", { type: "checkbox" });
fmCheckbox.checked = includeFrontmatterOnly;
fmLabel.createEl("span", { text: " フロントマターのみのMarkdownも含める" });

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

// 空の理由を返す。空でなければ null
async function getEmptyReason(file) {
    if (file.stat.size === 0) return "0バイト";
    if (file.extension !== "md") return null;
    const text = (await app.vault.cachedRead(file)).replace(/^﻿/, "");
    if (text.trim() === "") return "空白のみ";
    if (includeFrontmatterOnly) {
        const m = text.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
        if (m && text.slice(m[0].length).trim() === "") return "フロントマターのみ";
    }
    return null;
}

let renderToken = 0;

async function render() {
    const token = ++renderToken;
    resultEl.empty();
    resultEl.createEl("p", { text: "スキャン中..." });

    const candidates = app.vault.getFiles()
        .filter(f => f.path.startsWith("01_data/") && !f.path.startsWith("03_Dataview/"));

    const checked = await Promise.all(candidates.map(async (file) => {
        try {
            return { file, reason: await getEmptyReason(file) };
        } catch (e) {
            return { file, reason: null };
        }
    }));
    if (token !== renderToken) return; // 後続の再描画が走った場合は破棄

    const items = checked
        .filter(x => x.reason)
        .sort((a, b) => b.file.stat.mtime - a.file.stat.mtime);

    resultEl.empty();

    if (items.length === 0) {
        resultEl.createEl("p", { text: "中身が空のファイルは見つかりませんでした。" });
        return;
    }

    resultEl.createEl("p", { text: `中身が空のファイルが ${items.length} 件見つかりました。` });

    const table = resultEl.createEl("table", { cls: "dataview table-view-table" });
    const headerRow = table.createEl("thead").createEl("tr");
    headerRow.createEl("th", { text: "ファイル名" });
    headerRow.createEl("th", { text: "操作", attr: { style: "width: 150px; text-align: center;" } });
    headerRow.createEl("th", { text: "理由" });
    headerRow.createEl("th", { text: "パス" });
    headerRow.createEl("th", { text: "更新日時" });

    const tbody = table.createEl("tbody");

    for (const { file, reason } of items) {
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

        row.createEl("td", { text: reason });
        row.createEl("td", { text: file.parent ? file.parent.path : "" });
        row.createEl("td", { text: formatDate(file.stat.mtime) });
    }
}

fmCheckbox.addEventListener("change", () => {
    includeFrontmatterOnly = fmCheckbox.checked;
    try { localStorage.setItem(FM_STORAGE_KEY, String(includeFrontmatterOnly)); } catch (e) {}
    render();
});

render();
```
