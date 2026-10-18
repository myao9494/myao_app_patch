// =============================================================================
// コマンドの定義と登録（custom:…）
// =============================================================================

// リネーム時に一つの拡張子として扱う複合拡張子。
// 先に長い拡張子を判定して、`.excalidraw` や `.drawio` が入力欄に残らないようにする。
const splitFileNameForRename = (fileName) => {
    const compoundExtensions = [".excalidraw.md", ".excalidraw", ".drawio.svg", ".dio.svg", ".drawio"];
    const lowerFileName = String(fileName || "").toLowerCase();
    const compoundExtension = compoundExtensions.find((extension) => lowerFileName.endsWith(extension));

    if (compoundExtension) {
        return {
            extension: String(fileName).slice(-compoundExtension.length),
            baseName: String(fileName).slice(0, -compoundExtension.length),
        };
    }

    const dotIndex = String(fileName || "").lastIndexOf(".");
    if (dotIndex > 0) {
        return {
            extension: String(fileName).slice(dotIndex),
            baseName: String(fileName).slice(0, dotIndex),
        };
    }

    return { extension: "", baseName: String(fileName || "") };
};

// コールアウトを挿入し、本文（Contents）を選択した状態にする。
const insertCallout = (editor, calloutType) => {
    const cursor = editor.getCursor("from");
    editor.replaceSelection(`> [!${calloutType}] \n> Contents`);
    editor.setSelection(
        { line: cursor.line + 1, ch: 2 },
        { line: cursor.line + 1, ch: 10 }
    );
};

// 作業領域にあるタブグループ（ペイン）の数を数える。
const countWorkspaceTabGroups = () => {
    let count = 0;
    const traverse = (node) => {
        if (node.type === 'tabs') {
            count++;
        } else if (node.children) {
            node.children.forEach(traverse);
        }
    };
    traverse(app.workspace.rootSplit);
    return count;
};

// ペインが1つだけなら左右に分割し、複数あれば指定した方向（"left" / "right"）のペインへ移動する。
const smartFocus = (direction) => {
    if (countWorkspaceTabGroups() <= 1) {
        app.commands.executeCommandById("workspace:split-vertical");
    } else {
        app.commands.executeCommandById(`editor:focus-${direction}`);
    }
};

const openActiveFolderInBrowser = () => {
    // 現在のアクティブファイルを取得
    const activeFile = app.workspace.getActiveFile();
    if (!activeFile) {
        new Notice("No active file");
        return;
    }

    // 親フォルダパスを取得
    const folderPath = activeFile.parent ? activeFile.parent.path : "";

    // URLを構築して開く
    const url = `http://localhost:5001/view/obsidian-dagnetz/${folderPath}`;
    window.open(url, "_blank");
};

// アクティブなファイルを引数にして処理を実行する。ファイルが無ければ通知だけを出す。
const runWithActiveFile = (action) => {
    const activeFile = app.workspace?.getActiveFile?.();
    if (!activeFile) {
        new Notice("アクティブなファイルがありません");
        return;
    }
    action(activeFile);
};

// 現在のノートのタグ（frontmatter とインライン）を、topを除いて重複なく集める
const collectTagsForNewNote = (file) => {
    const cache = app.metadataCache.getFileCache(file);
    const tags = [];
    if (cache?.frontmatter?.tags) tags.push(...splitFrontmatterTags(cache.frontmatter.tags));
    for (const item of cache?.tags ?? []) tags.push(normalizeTagName(item.tag));
    return uniqueTagNamesPreservingFirst(tags).filter((tag) => tag.toLowerCase() !== "top");
};

// 現在のノートと同じタグ（topを除く）を付けた新しいノートを、今日のフォルダに作り右の分割に開く
const createNoteWithCurrentTags = async () => {
    const activeFile = app.workspace?.getActiveFile?.();
    if (!activeFile) {
        new Notice("アクティブなファイルがありません");
        return;
    }
    const tags = collectTagsForNewNote(activeFile);
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const folderPath = `01_data/${yyyy}/${mm}/${dd}`;
    if (!await app.vault.adapter.exists(folderPath)) {
        await app.vault.createFolder(folderPath);
    }
    let notePath = `${folderPath}/無題のファイル.md`;
    for (let i = 1; await app.vault.adapter.exists(notePath); i++) {
        notePath = `${folderPath}/無題のファイル ${i}.md`;
    }
    const frontmatter = tags.length > 0
        ? `---\ntags:\n${tags.map((tag) => `  - ${tag}`).join("\n")}\n---\n`
        : "";
    const newFile = await app.vault.create(notePath, frontmatter);
    const leaf = app.workspace.getLeaf("split", "vertical");
    await leaf.openFile(newFile);
};

const insertCurrentDateTime = (editor) => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const dateString = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    editor.replaceSelection(dateString);
};

/**
 * アクティブなファイルのリネーム用モーダル（custom:rename-active-file）
 * 拡張子（複合拡張子を含む）は入力欄に出さず、保存時に付け直す。
 **/
class ActiveFileRenameModal extends Modal {
    constructor(app, file) {
        super(app);
        this.file = file;
        this.extension = "";
        this.baseName = "";
        this.parseFileName(file.name);
    }

    parseFileName(fileName) {
        const parts = splitFileNameForRename(fileName);
        this.extension = parts.extension;
        this.baseName = parts.baseName;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("rename-modal");

        contentEl.createEl("h2", { text: "ファイル名を変更" });

        let newName = this.baseName;

        new Setting(contentEl)
            .setName("新しいファイル名")
            .setDesc(`拡張子: ${this.extension}`)
            .addText((text) =>
                text
                    .setValue(this.baseName)
                    .onChange((value) => {
                        newName = value;
                    })
            );

        const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });

        const saveButton = buttonContainer.createEl("button", { text: "保存", cls: "mod-cta" });
        saveButton.addEventListener("click", async () => {
            await this.renameFile(newName);
        });

        const cancelButton = buttonContainer.createEl("button", { text: "キャンセル" });
        cancelButton.style.setProperty("color", "#111111", "important");
        cancelButton.style.setProperty("-webkit-text-fill-color", "#111111", "important");
        cancelButton.addEventListener("click", () => {
            this.close();
        });

        // Enterキーで保存
        contentEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                if (e.isComposing) return; // IME変換中のリターンキーを無視
                e.preventDefault();
                this.renameFile(newName);
            }
        });
        // Inputにフォーカス
        setTimeout(() => {
            const input = contentEl.querySelector("input[type='text']");
            if (input) {
                input.focus();
                input.select();
            }
        }, 50);
    }

    async renameFile(newName) {
        if (!newName) {
            new Notice("ファイル名を入力してください");
            return;
        }

        const newPath = (this.file.parent ? this.file.parent.path + "/" : "") + newName + this.extension;

        try {
            await app.fileManager.renameFile(this.file, newPath);
            new Notice(`Renamed to ${newName}${this.extension}`);
            this.close();
        } catch (error) {
            new Notice(`Error: ${error.message}`);
            console.error(error);
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

const renameActiveFile = async () => {
    const activeFile = app.workspace.getActiveFile();
    if (!activeFile) {
        new Notice("No active file");
        return;
    }

    if (!getObsidianModule()) {
        console.error("Obsidian module not found");
        new Notice("Error: Obsidian module not found");
        return;
    }

    new ActiveFileRenameModal(app, activeFile).open();
};

/**
 * ノートと一緒に削除できる添付ファイルを集める。
 * 対象は、そのノートだけが参照している Markdown 以外のファイル（.msg / .pptx などを含む）。
 **/
const getExclusivelyReferencedAttachments = (file) => {
    // Support both .md and .excalidraw.md
    if (file.extension !== "md") return [];

    const cache = app.metadataCache.getFileCache(file);
    if (!cache) return [];

    const related = [];

    // common_image は共有資産なので、削除候補には含めない。
    const isInCommonImage = (target) => {
        const normalizedPath = target.path.replace(/\\/g, "/");
        return normalizedPath === "01_data/common_image" ||
            normalizedPath.startsWith("01_data/common_image/");
    };

    // 削除元以外の Markdown ノートから参照されている添付は残す。
    // embeds/links の両方をリンク解決するため、通常リンクの msg/pptx 等も対象になる。
    const isReferencedByAnotherNote = (target) => {
        return app.vault.getMarkdownFiles().some(sourceFile => {
            if (sourceFile.path === file.path) return false;

            const sourceCache = app.metadataCache.getFileCache(sourceFile);
            if (!sourceCache) return false;

            const sourceReferences = [
                ...(sourceCache.embeds || []),
                ...(sourceCache.links || [])
            ];

            return sourceReferences.some(ref => {
                const resolved = app.metadataCache.getFirstLinkpathDest(ref.link, sourceFile.path);
                return resolved?.path === target.path;
            });
        });
    };

    const uniquePaths = new Set();

    // embedsとlinks両方を処理（通常のリンク[[file.msg]]も添付ファイルとして扱う）
    const references = [...(cache.embeds || []), ...(cache.links || [])];

    for (const ref of references) {
        const linkPath = ref.link;
        const linkedFile = app.metadataCache.getFirstLinkpathDest(linkPath, file.path);

        // .msg/.pptx を含む、Markdown 以外のあらゆる添付ファイルを対象にする。
        if (linkedFile &&
            linkedFile.extension.toLowerCase() !== "md" &&
            !isInCommonImage(linkedFile) &&
            !isReferencedByAnotherNote(linkedFile)) {
            if (!uniquePaths.has(linkedFile.path)) {
                uniquePaths.add(linkedFile.path);
                related.push(linkedFile);
            }
        }
    }
    return related;
};

// 削除ダイアログの下部に「キャンセル」と赤い実行ボタンを並べる（キャンセルを目立つ色にする）。
const createDeleteDialogButtons = (contentEl, dangerText, onCancel, onDanger) => {
    const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
    buttonContainer.style.display = "flex";
    buttonContainer.style.justifyContent = "flex-end";
    buttonContainer.style.gap = "10px";
    buttonContainer.style.marginTop = "20px";

    const cancelBtn = new obsidianLib.ButtonComponent(buttonContainer)
        .setButtonText("キャンセル")
        .onClick(onCancel);
    cancelBtn.buttonEl.style.backgroundColor = "var(--interactive-accent)";
    cancelBtn.buttonEl.style.color = "#111111";
    cancelBtn.buttonEl.style.webkitTextFillColor = "#111111";

    const dangerBtn = new obsidianLib.ButtonComponent(buttonContainer)
        .setButtonText(dangerText)
        .setWarning()
        .onClick(onDanger);
    dangerBtn.buttonEl.style.backgroundColor = "#e93f33";
    dangerBtn.buttonEl.style.color = "white";
    cancelBtn.buttonEl.tabIndex = 0;
    dangerBtn.buttonEl.tabIndex = 0;

    return { cancelBtn, dangerBtn };
};

// 削除ダイアログのキー操作: Tab で2つのボタンを行き来し、Escape で閉じ、Enter でフォーカス中のボタンを押す。
const handleDeleteDialogKeydown = (e, cancelBtn, dangerBtn, onEscape) => {
    const active = document.activeElement;
    if (e.key === "Tab" && (active === cancelBtn.buttonEl || active === dangerBtn.buttonEl)) {
        e.preventDefault();
        const next = active === cancelBtn.buttonEl ? dangerBtn.buttonEl : cancelBtn.buttonEl;
        next.focus();
    }
    if (e.key === "Escape") {
        e.preventDefault();
        onEscape();
    }
    if (e.key === "Enter") {
        if (active === cancelBtn.buttonEl || active === dangerBtn.buttonEl) {
            e.preventDefault();
            active.click();
        }
    }
};

// 削除の最終確認ダイアログ。openAndWait() は、実行なら true、キャンセル・閉じた場合は false を返す。
class ConfirmDeleteModal extends Modal {
    constructor(app, title, message, confirmText = "削除") {
        super(app);
        this.title = title;
        this.message = message;
        this.confirmText = confirmText;
        this.resolve = null;
        this.resolved = false;
    }

    openAndWait() {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }

    finish(result) {
        if (this.resolved) return;
        this.resolved = true;
        if (this.resolve) this.resolve(result);
        this.close();
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: this.title });
        for (const line of this.message.split("\n")) {
            contentEl.createEl("p", { text: line });
        }

        const { cancelBtn, dangerBtn } = createDeleteDialogButtons(
            contentEl, this.confirmText, () => this.finish(false), () => this.finish(true),
        );

        contentEl.addEventListener("keydown", (e) => {
            handleDeleteDialogKeydown(e, cancelBtn, dangerBtn, () => this.finish(false));
        });

        setTimeout(() => cancelBtn.buttonEl.focus(), 50);
    }

    onClose() {
        if (!this.resolved) {
            this.resolved = true;
            if (this.resolve) this.resolve(false);
        }
        this.contentEl.empty();
    }
}

/**
 * アクティブなファイルの削除用モーダル（custom:delete-active-file）
 * そのノートだけが参照している添付ファイルを一覧表示し、チェックしたものも一緒にゴミ箱へ移動する。
 **/
class DeleteFileModal extends Modal {
    constructor(app, file, relatedFiles) {
        super(app);
        this.file = file;
        this.relatedFiles = relatedFiles;
        // 選択された関連ファイルのパスを格納（デフォルトは空=未選択）
        this.selectedFiles = new Set();
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("delete-file-modal");

        // Title
        contentEl.createEl("h2", { text: "ファイルの削除" });

        // Message
        const msgDiv = contentEl.createDiv();
        msgDiv.createEl("p", { text: `"${this.file.name}" を削除しても良いですか？` });
        msgDiv.createEl("p", { text: "システムのゴミ箱に移動します。" });

        // 関連ファイルのチェックボックスリスト
        if (this.relatedFiles.length > 0) {
            this.renderRelatedFileList(contentEl);
        }

        // Buttons
        const { cancelBtn, dangerBtn: deleteBtn } = createDeleteDialogButtons(
            contentEl,
            "削除",
            () => {
                this.close();
            },
            async () => {
                await this.deleteFile();
            },
        );

        contentEl.addEventListener("keydown", (e) => {
            handleDeleteDialogKeydown(e, cancelBtn, deleteBtn, () => this.close());
        });

        // キーボード操作時に Enter が誤って削除にならないよう、キャンセルを初期フォーカスにする。
        setTimeout(() => {
            cancelBtn.buttonEl.focus();
        }, 100);
    }

    renderRelatedFileList(contentEl) {
        contentEl.createEl("h3", { text: "関連するファイルも削除する" });

        const listContainer = contentEl.createDiv({ cls: "delete-attachment-list" });
        listContainer.style.maxHeight = "250px";
        listContainer.style.overflowY = "auto";
        listContainer.style.border = "1px solid var(--background-modifier-border)";
        listContainer.style.padding = "10px";
        listContainer.style.borderRadius = "4px";
        listContainer.style.marginBottom = "15px";

        // すべて選択チェックボックス
        const selectAllContainer = listContainer.createDiv({ cls: "attachment-item" });
        selectAllContainer.style.display = "flex";
        selectAllContainer.style.alignItems = "center";
        selectAllContainer.style.marginBottom = "8px";
        selectAllContainer.style.borderBottom = "1px solid var(--background-modifier-border)";
        selectAllContainer.style.paddingBottom = "8px";

        const selectAllCb = selectAllContainer.createEl("input", { type: "checkbox" });
        selectAllCb.type = "checkbox";
        selectAllCb.checked = false;
        const selectAllLabel = selectAllContainer.createSpan({ text: "すべて選択" });
        selectAllLabel.style.marginLeft = "8px";
        selectAllLabel.style.fontWeight = "bold";

        const checkBoxes = [];

        // すべて選択の動作
        selectAllCb.onchange = () => {
            const checked = selectAllCb.checked;
            checkBoxes.forEach(cb => {
                cb.checked = checked;
                const path = cb.getAttribute("data-path");
                if (path) {
                    if (checked) this.selectedFiles.add(path);
                    else this.selectedFiles.delete(path);
                }
            });
        };

        // 各ファイルのチェックボックス
        this.relatedFiles.forEach(f => {
            const item = listContainer.createDiv({ cls: "attachment-item" });
            item.style.display = "flex";
            item.style.alignItems = "center";
            item.style.padding = "4px 0";

            const cb = item.createEl("input", { type: "checkbox" });
            cb.type = "checkbox";
            cb.checked = false;
            cb.setAttribute("data-path", f.path);
            checkBoxes.push(cb);

            cb.onchange = () => {
                if (cb.checked) this.selectedFiles.add(f.path);
                else this.selectedFiles.delete(f.path);

                // すべて選択の状態を更新
                selectAllCb.checked = checkBoxes.every(c => c.checked);
                selectAllCb.indeterminate = checkBoxes.some(c => c.checked) && !checkBoxes.every(c => c.checked);
            };

            const label = item.createSpan({ text: f.name });
            label.style.marginLeft = "8px";
            label.style.flexGrow = "1";
            label.style.overflow = "hidden";
            label.style.textOverflow = "ellipsis";
            label.style.whiteSpace = "nowrap";
        });
    }

    async deleteFile() {
        const confirmed = await new ConfirmDeleteModal(
            app,
            "最終確認",
            `本当に "${this.file.name}" を消しますか？\nシステムのゴミ箱に移動します。`,
            "本当に消す"
        ).openAndWait();
        if (!confirmed) {
            this.close();
            return;
        }

        try {
            // 選択された関連ファイルを削除
            if (this.selectedFiles.size > 0) {
                let deletedCount = 0;
                for (const f of this.relatedFiles) {
                    if (this.selectedFiles.has(f.path)) {
                        await app.vault.trash(f, true);
                        deletedCount++;
                    }
                }
                if (deletedCount > 0) {
                    new Notice(`${deletedCount}個の関連ファイルを削除しました`);
                }
            }

            // Delete main file
            await app.vault.trash(this.file, true);
            new Notice(`${this.file.name} を削除しました`);
            this.close();
        } catch (error) {
            new Notice(`Error: ${error.message}`);
            console.error(error);
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

const deleteActiveFile = async () => {
    const activeFile = app.workspace.getActiveFile();
    if (!activeFile) {
        new Notice("No active file");
        return;
    }

    if (!getObsidianModule()) {
        new Notice("Error: Obsidian module not found");
        return;
    }

    const relatedFiles = getExclusivelyReferencedAttachments(activeFile);
    new DeleteFileModal(app, activeFile, relatedFiles).open();
};

// 最小限の Draw.io 用空SVGデータ
const EMPTY_DRAWIO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="1px" height="1px" viewBox="-0.5 -0.5 1 1" content="&lt;mxfile host=&quot;Obsidian&quot;&gt;&lt;diagram id=&quot;0&quot; name=&quot;Page-1&quot;&gt;&lt;mxGraphModel&gt;&lt;root&gt;&lt;mxCell id=&quot;0&quot;/&gt;&lt;mxCell id=&quot;1&quot; parent=&quot;0&quot;/&gt;&lt;/root&gt;&lt;/mxGraphModel&gt;&lt;/diagram&gt;&lt;/mxfile&gt;"><defs/><g/></svg>`;

// 今日のフォルダに空の Draw.io 図（.drawio.svg）を作り、カーソル位置へ埋め込みリンクを挿入する。
const addDrawioDiagram = async (editor) => {
    const activeFile = app.workspace.getActiveFile();
    if (!activeFile) {
        new Notice("No active file");
        return;
    }

    // 今日の日付からフォルダパスを構築
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const folderPath = `01_data/${yyyy}/${mm}/${dd}`;

    // フォルダが存在しない場合は作成
    if (!await app.vault.adapter.exists(folderPath)) {
        await app.vault.createFolder(folderPath);
    }

    // アクティブファイル名を初期値として、作成する図の名前を入力
    const defaultBaseName = activeFile.basename || activeFile.name.substring(0, activeFile.name.lastIndexOf("."));
    // ダイアログ表示後、初期値を全選択してすぐ上書きできるようにする
    if (typeof document !== "undefined") {
        setTimeout(() => {
            const activeInput = document.activeElement;
            if (activeInput && (activeInput.tagName === "INPUT" || activeInput.tagName === "TEXTAREA")) {
                activeInput.select();
            }
        }, 50);
    }
    const inputName = await tp.system.prompt("Draw.ioの図の名前", defaultBaseName);
    if (inputName === null) {
        return;
    }

    // 拡張子の二重付与と、ファイルパスとして使用できない文字を避ける
    let baseName = inputName.trim() || defaultBaseName;
    baseName = baseName
        .replace(/\.(?:drawio|dio)(?:\.svg)?$/i, "")
        .replace(/[\\/:*?"<>|#[\]]/g, "_")
        .trim();
    if (!baseName) {
        new Notice("有効な図の名前を入力してください");
        return;
    }

    // ファイルの重複確認と連番付与
    let filePath = `${folderPath}/${baseName}.drawio.svg`;
    let counter = 1;
    while (await app.vault.adapter.exists(filePath)) {
        filePath = `${folderPath}/${baseName}_${counter}.drawio.svg`;
        counter++;
    }

    // 作成するファイル名（拡張子付き、連番反映後）
    const createdFileName = filePath.split("/").pop();

    try {
        // ファイルを作成
        await app.vault.create(filePath, EMPTY_DRAWIO_SVG);
        new Notice(`Draw.ioの図を作成しました: ${createdFileName}`);

        // エディタに埋め込みリンクを挿入
        editor.replaceSelection(`![[${createdFileName}]]`);
    } catch (error) {
        new Notice(`図の作成エラー: ${error.message}`);
        console.error(error);
    }
};

// Define the commands to register
const commands = [
    {
        id: "custom:toggle-mindmap-basic",
        name: "Toggle Mindmap (Basic)",
        callback: async () => {
            await toggleMindmapBasic();
        }
    },
    {
        id: "custom:reload-displayed-markdown-and-sidebars",
        name: "表示中のMarkdownとサイドバーを再読み込み",
        callback: reloadDisplayedMarkdownAndSidebars,
    },
    {
        id: "custom:move-moc-files",
        name: "MOCファイルを移動 (Move MOC Files)",
        callback: async () => {
            await moveMocFiles();
        }
    },
    {
        id: "custom:callout-important",
        name: "Callout Important",
        editorCallback: (editor) => insertCallout(editor, "important"),
    },
    {
        id: "custom:callout-warning",
        name: "Callout Warning",
        editorCallback: (editor) => insertCallout(editor, "warning"),
    },
    {
        id: "custom:callout-danger",
        name: "Callout Danger",
        editorCallback: (editor) => insertCallout(editor, "Danger"),
    },
    {
        id: "custom:callout-note",
        name: "Callout Note",
        editorCallback: (editor) => insertCallout(editor, "note"),
    },
    {
        id: "custom:from-clipboard",
        name: "From Clipboard",
        editorCallback: async (editor) => {
            editor.replaceSelection(await fromClipboard());
        }
    },
    {
        id: "custom:smart-focus-right",
        name: "Smart Focus Right",
        callback: () => smartFocus("right"),
    },
    {
        id: "custom:smart-focus-left",
        name: "Smart Focus Left",
        callback: () => smartFocus("left"),
    },
    {
        id: "custom:open-folder-in-browser",
        name: "Open Folder in Browser",
        callback: openActiveFolderInBrowser,
    },
    {
        id: "custom:open-containing-folder",
        name: "フォルダを開く (Finder/Explorer)",
        callback: () => runWithActiveFile(openContainingFolder),
    },
    {
        id: "custom:open-in-vscode",
        name: "VS Codeで開く",
        callback: () => runWithActiveFile(openInVsCode),
    },
    {
        id: "custom:new-note-with-current-tags",
        name: "現在のタグで新しいノートを追加",
        callback: createNoteWithCurrentTags,
    },
    {
        id: "custom:insert-datetime",
        name: "Insert Date and Time",
        editorCallback: insertCurrentDateTime,
    },
    {
        id: "custom:rename-active-file",
        name: "Rename Active File",
        callback: renameActiveFile,
    },
    {
        id: "custom:delete-active-file",
        name: "Delete Active File",
        callback: deleteActiveFile,
    },
    {
        id: "custom:add-drawio-diagram",
        name: "drawioの図の追加 (Add Draw.io Diagram)",
        editorCallback: addDrawioDiagram,
    }
];

// Register commands if they don't exist, or update them if they do
if (app.commands && typeof app.commands.addCommand === "function") {
    commands.forEach(cmd => {
        const existing = typeof app.commands.findCommand === "function" ? app.commands.findCommand(cmd.id) : null;
        if (!existing) {
            app.commands.addCommand(cmd);
            console.log(`Registered command: ${cmd.id}`);
        } else {
            existing.callback = cmd.callback;
            existing.editorCallback = cmd.editorCallback;
            console.log(`Updated command callback: ${cmd.id}`);
        }
    });
}
