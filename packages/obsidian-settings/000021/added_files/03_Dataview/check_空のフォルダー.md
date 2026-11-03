<!--
仕様:
1. 01_data ディレクトリ配下において、ファイルが一切含まれていない空のフォルダーを一覧表示する。
2. 各行に「開く」ボタンと「削除」ボタンを設ける。
3. 「削除」ボタンをクリックすると確認ダイアログを経てゴミ箱へ移動され、300msの遅延後にスキャンを再実行してテーブル全体を更新（再描画）する。
4. これにより、サブフォルダーが削除された結果として親フォルダーが空になった場合も、即座に最新の空フォルダーとして検出・表示される。
-->

# 空のフォルダー一覧 (01_data 配下)

```dataviewjs
/**
 * 01_data配下の空のフォルダー一覧を表示する。
 * 削除実行時に自動的に全体を再読み込み（再スキャン・再描画）し、常に最新の状態を維持する。
 **/
const rootEl = this.container.createEl("div");

async function render() {
    rootEl.empty();
    
    // 01_data配下のすべてのファイル
    const allFiles = app.vault.getFiles().filter(f => f.path.startsWith("01_data/"));

    // 01_data配下のすべてのフォルダーを取得 (TFolderはchildrenプロパティを持つ)
    const allLoaded = app.vault.getAllLoadedFiles();
    const folders = allLoaded.filter(f => {
        return f.children && f.path.startsWith("01_data/") && f.path !== "01_data";
    });

    // ファイルが1つも含まれていないフォルダーを特定
    const emptyFolders = folders.filter(folder => {
        const prefix = folder.path + "/";
        return !allFiles.some(file => file.path.startsWith(prefix));
    }).sort((a, b) => a.path.localeCompare(b.path));

    if (emptyFolders.length === 0) {
        rootEl.createEl("p", { text: "空のフォルダーは見つかりませんでした。" });
        return;
    }
    
    rootEl.createEl("p", { text: `空のフォルダーが ${emptyFolders.length} 件見つかりました。` });
    
    // テーブルDOMを構築
    const table = rootEl.createEl("table", { cls: "dataview table-view-table" });
    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");
    headerRow.createEl("th", { text: "空のフォルダーパス" });
    headerRow.createEl("th", { text: "操作", style: "width: 150px; text-align: center;" });
    
    const tbody = table.createEl("tbody");
    
    for (const folder of emptyFolders) {
        const row = tbody.createEl("tr");
        row.createEl("td", { text: folder.path });
        
        const actionCell = row.createEl("td", { style: "text-align: center;" });
        
        // 1. 開くボタン
        const openBtn = actionCell.createEl("button", {
            text: "開く",
            style: "margin-right: 5px; background-color: var(--interactive-accent); color: #111111 !important; -webkit-text-fill-color: #111111 !important; border-color: var(--interactive-accent);"
        });
        openBtn.style.setProperty("color", "#111111", "important");
        openBtn.style.setProperty("-webkit-text-fill-color", "#111111", "important");
        openBtn.addEventListener("click", () => {
            try {
                const basePath = app.vault.adapter.basePath;
                const fullPath = `${basePath}/${folder.path}`;
                const { shell } = require("electron");
                shell.openPath(fullPath);
            } catch (err) {
                new Notice(`フォルダーを開けませんでした: ${err.message}`);
            }
        });
        
        // 2. 削除ボタン
        const deleteBtn = actionCell.createEl("button", {
            text: "削除",
            style: "background-color: var(--interactive-accent); color: #111111 !important; -webkit-text-fill-color: #111111 !important; border-color: var(--interactive-accent);"
        });
        deleteBtn.style.setProperty("color", "#111111", "important");
        deleteBtn.style.setProperty("-webkit-text-fill-color", "#111111", "important");
        deleteBtn.addEventListener("click", async () => {
            if (confirm(`本当にフォルダー "${folder.path}" を削除（ゴミ箱へ移動）しますか？`)) {
                try {
                    const abstractFolder = app.vault.getAbstractFileByPath(folder.path);
                    if (abstractFolder) {
                        // システムゴミ箱へ移動
                        await app.vault.trash(abstractFolder, true);
                        new Notice(`フォルダー "${folder.path}" を削除しました。`);
                        
                        // ファイルシステムの変更が反映されるのを少し待ってから全体を再描画
                        setTimeout(() => {
                            render();
                        }, 300);
                    } else {
                        new Notice(`フォルダーが見つかりませんでした。`);
                    }
                } catch (err) {
                    new Notice(`削除に失敗しました: ${err.message}`);
                }
            }
        });
    }
}

// 初回レンダリング
render();
```
