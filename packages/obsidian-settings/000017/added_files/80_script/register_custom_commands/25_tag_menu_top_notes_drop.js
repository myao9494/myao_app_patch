// =============================================================================
// タグメニュー、topタグ付きノートの自動更新、ファイルマネージャーからのドロップ
// =============================================================================

/**
 * tag-menu イベントハンドラ
 **/
const handleTagMenu = (menu, tag, source) => {
    menu.addItem((item) => {
        item
            .setTitle("MOCを作成")
            .setIcon("document")
            .onClick(() => createMocFromTag(tag));
    });
    
    menu.addItem((item) => {
        item
            .setTitle("ノート一覧を追加")
            .setIcon("bullet-list")
            .onClick(() => addNoteListFromTag(tag));
    });
    
    menu.addItem((item) => {
        item
            .setTitle("一括変換")
            .setIcon("pencil")
            .onClick(() => bulkRenameTag(tag));
    });
    
    // 最上部に移動する
    reorderMenuItemsLater(menu, 50, { prepend: [
        "MOCを作成",
        "ノート一覧を追加",
        "一括変換",
    ] });
};

/**
 * file-open イベントハンドラ (topタグ付きノートの自動更新)
 **/
const topNoteUpdateToken = Symbol("custom-top-note-update");
window._customTopNoteUpdateToken = topNoteUpdateToken;

const isCurrentTopNoteUpdate = (file) =>
    window._customTopNoteUpdateToken === topNoteUpdateToken &&
    app.workspace.getActiveFile()?.path === file?.path;

const handleFileOpen = async (file, attempt = 0) => {
    try {
        if (!file || file.extension !== "md" || file.name.endsWith(".excalidraw.md")) {
            return;
        }
        // タブを移動した後のリトライや更新は実行しない。
        if (!isCurrentTopNoteUpdate(file)) return;

        const scheduleRetry = () => {
            if (attempt >= 5) return;
            setTimeout(() => {
                if (isCurrentTopNoteUpdate(file)) {
                    void handleFileOpen(file, attempt + 1);
                }
            }, 300 * (attempt + 1));
        };

        const cache = app.metadataCache.getFileCache(file);
        if (!cache) {
            scheduleRetry();
            return;
        }

        // タグを収集
        const tags = [];
        if (cache.tags) {
            for (const entry of cache.tags) {
                tags.push(normalizeTagName(entry.tag));
            }
        }
        const frontmatterTags = cache.frontmatter?.tags;
        if (frontmatterTags) {
            for (const tg of splitFrontmatterTags(frontmatterTags)) {
                tags.push(normalizeTagName(String(tg)));
            }
        }

        // topタグがあるかチェック
        if (!tags.some(t => t.toLowerCase() === "top")) {
            // topタグではない通常ノートにはリトライを登録しない。
            return;
        }

        // Search Queryプロパティがあるかチェック
        const frontmatter = cache.frontmatter;
        if (!frontmatter) {
            scheduleRetry();
            return;
        }

        const searchKey = Object.keys(frontmatter).find(key =>
            key.toLowerCase().replace(/\s+/g, "") === "searchquery"
        );
        if (!searchKey) return;

        const queryVal = frontmatter[searchKey];
        if (!queryVal) return;

        // file-open直後は、履歴から復元されたビューとリンク元ノートのmetadata更新が
        // まだ完了していないことがある。topノートだけ短く待って最新キャッシュで再判定する。
        if (attempt === 0) {
            await new Promise(resolve => setTimeout(resolve, 250));
            if (!isCurrentTopNoteUpdate(file)) return;
            return await handleFileOpen(file, 1);
        }

        // ノート一覧をサイレントで自動更新。移動済みのタブには書き込まない。
        await updateNoteListForFile(file, queryVal, true, () => isCurrentTopNoteUpdate(file));
    } catch (error) {
        console.error("handleFileOpen error:", error);
    }
};

registerWorkspaceEvent("_customFileOpenListener", "file-open", handleFileOpen);
console.log("File open listener registered for auto-updating top notes");

registerWorkspaceEvent("_customTagMenuListener", "tag-menu", withNativeMenuReorder(handleTagMenu));
console.log("Tag menu listener registered for MOC creation");

// 旧版で登録した新規Excalidraw移動リスナーが残っていれば解除する。
if (window._customNewExcalidrawFileListener) {
    app.vault.off("create", window._customNewExcalidrawFileListener);
    delete window._customNewExcalidrawFileListener;
}

// topタグ付きノート一覧のDataview標準リンクも、右ペインで開く。
const handleTopNoteListLinkClick = (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;

    const link = event.target?.closest?.("a.internal-link");
    const sourceFile = app.workspace.getActiveFile();
    if (!link || sourceFile?.path !== "03_Dataview/topタグ付きノート一覧.md") return;

    const linkpath = link.dataset?.href || link.getAttribute("data-href") || link.getAttribute("href");
    if (!linkpath) return;
    const targetFile = app.metadataCache.getFirstLinkpathDest(linkpath, sourceFile.path);
    if (!targetFile) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    void window._openNoteListLinkInRightPane(targetFile, sourceFile.path);
};

registerDocumentListener("_customTopNoteListLinkClickListener", "click", handleTopNoteListLinkClick);

/**
 * ファイルマネージャーからのドラッグ＆ドロップを検知し、localhost:8001リンクを挿入する
 **/
const handleFileManagerDrop = (e) => {
    if (!e.dataTransfer) return;
    const text = e.dataTransfer.getData("text/plain");
    const items = parseFileManagerData(text);
    if (!items || items.length === 0) return;

    // ドロップ対象がエディタ内か、またはアクティブなエディタがあるか確認
    const MarkdownViewClass = tp?.obsidian?.MarkdownView || window?.obsidian?.MarkdownView;
    const activeView = (typeof app !== "undefined" && app.workspace.getActiveViewOfType)
        ? app.workspace.getActiveViewOfType(MarkdownViewClass)
        : null;
    const editor = activeView?.editor;
    if (!editor) return;
    // 開いているノートの外（Excalidraw の画面、サイドバーなど）へのドロップは、その画面の処理に任せる。
    if (activeView.containerEl?.contains && !activeView.containerEl.contains(e.target)) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const linkMarkdown = generateFileManagerMarkdown(items);

    let insertPos = null;
    const cm = editor.cm;
    if (cm && typeof cm.posAtCoords === "function") {
        const offset = cm.posAtCoords({ x: e.clientX, y: e.clientY });
        if (offset !== null) {
            insertPos = editor.offsetToPos(offset);
        }
    }
    if (!insertPos && typeof editor.posAtCoords === "function") {
        insertPos = editor.posAtCoords({ x: e.clientX, y: e.clientY });
    }
    if (!insertPos) {
        insertPos = editor.getCursor();
    }

    editor.replaceRange(linkMarkdown, insertPos);
};

registerDocumentListener("_customFileManagerDropListener", "drop", handleFileManagerDrop);

/**
 * 閲覧モード（Reading View）等で open-path リンクを右クリックした際のコンテキストメニュー
 **/
const handleFileManagerLinkContextMenu = (e) => {
    const linkEl = e.target?.closest?.("a[href*='localhost:8001/api/open-path']");
    if (!linkEl) return;

    const href = linkEl.getAttribute("href") || linkEl.href;
    const sourcePath = extractOpenPathFromLink(href);
    if (!sourcePath) return;

    const MenuClass = tp?.obsidian?.Menu || window?.obsidian?.Menu || (typeof Menu !== "undefined" ? Menu : null);
    if (!MenuClass) return;

    const activeFile = typeof app !== "undefined" ? app.workspace.getActiveFile() : null;
    if (!activeFile) return;

    e.preventDefault();
    e.stopPropagation();

    const menu = new MenuClass();
    menu.addItem((item) => {
        item
            .setTitle("コピーして同一フォルダーに保存")
            .setIcon("folder-input")
            .onClick(async () => {
                const res = await executeCopyAndConvertLink({
                    sourceFilePath: sourcePath,
                    originalLinkText: href
                });
                if (res?.success && res.newLink) {
                    const fileContent = await app.vault.read(activeFile);
                    const escapedHref = href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                    const linkRegex = new RegExp(`(?:\\[[^\\]]*\\]\\(${escapedHref}\\)|${escapedHref})`);
                    const updatedContent = fileContent.replace(linkRegex, res.newLink);
                    if (updatedContent !== fileContent) {
                        await app.vault.modify(activeFile, updatedContent);
                    }
                }
            });
    });
    flushNativeMenuReorders(menu);
    menu.showAtMouseEvent(e);
};

registerDocumentListener("_customFileManagerLinkContextMenuListener", "contextmenu", handleFileManagerLinkContextMenu);
