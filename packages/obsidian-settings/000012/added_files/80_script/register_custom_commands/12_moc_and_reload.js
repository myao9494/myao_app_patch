// =============================================================================
// MOCファイルの移動、表示中のMarkdownとサイドバーの再読み込み
// =============================================================================

const shouldMoveToMoc = (file, fileCache) => {
    if (!file || !fileCache) return false;
    const ext = file.extension?.toLowerCase();
    if (ext !== 'md') return false;
    if (file.name?.endsWith('.excalidraw.md')) return false;
    if (file.path?.startsWith('00_templates/')) return false;
    if (file.path?.startsWith('02_MOC/')) return false;

    const tags = [];
    if (fileCache.tags) {
        for (const t of fileCache.tags) {
            if (t && typeof t.tag === 'string') {
                tags.push(t.tag.toLowerCase());
            }
        }
    }
    if (fileCache.frontmatter && fileCache.frontmatter.tags) {
        const fmTags = fileCache.frontmatter.tags;
        if (Array.isArray(fmTags)) {
            for (const t of fmTags) {
                if (typeof t === 'string') {
                    tags.push(t.toLowerCase());
                }
            }
        } else if (typeof fmTags === 'string') {
            const splitTags = fmTags.split(/,\s*/);
            for (const t of splitTags) {
                tags.push(t.trim().toLowerCase());
            }
        }
    }
    return tags.some((t) => t === 'moc' || t === '#moc');
};

const moveMocFiles = async () => {
    const targetFolder = "02_MOC";
    try {
        if (!(await app.vault.exists(targetFolder))) {
            await app.vault.createFolder(targetFolder);
            console.log(`Created target folder: ${targetFolder}`);
        }

        const files = app.vault.getMarkdownFiles();
        let moveCount = 0;

        for (const file of files) {
            const fileCache = app.metadataCache.getFileCache(file);
            if (shouldMoveToMoc(file, fileCache)) {
                const newPath = `${targetFolder}/${file.name}`;
                console.log(`Moving MOC file: ${file.path} -> ${newPath}`);
                await app.fileManager.renameFile(file, newPath);
                moveCount++;
            }
        }

        if (moveCount > 0) {
            new Notice(`MOCファイルを ${moveCount} 件移動しました。`);
        } else {
            console.log("No MOC files to move.");
        }
        return moveCount;
    } catch (err) {
        console.error("Failed to move MOC files:", err);
        new Notice(`MOCファイルの移動中にエラーが発生しました: ${err.message}`);
        return 0;
    }
};

// 表示中のMarkdownと、サイドバーのカスタムビューを明示的に再読み込みする。
// 外部変更の自動追従を有効に戻さず、人手で最新状態へ更新したい場合に使う。
const reloadDisplayedMarkdownAndSidebars = async () => {
    const workspace = app.workspace;
    const activeLeaf = workspace.activeLeaf;
    const activeFile = workspace.getActiveFile?.();
    const markdownLeaves = [];

    if (activeFile?.extension?.toLowerCase() === "md") {
        workspace.iterateAllLeaves?.((leaf) => {
            if (leaf?.view?.file?.path !== activeFile.path) return;
            markdownLeaves.push(leaf);
        });

        // 同じMarkdownを複数ペインで表示している場合も、表示内容を揃える。
        for (const leaf of markdownLeaves) {
            try {
                await leaf.openFile(activeFile, { active: leaf === activeLeaf });
            } catch (error) {
                console.warn("Failed to reload displayed Markdown leaf.", error);
            }
        }
    }

    const sidebarExplorerPlugin = app.plugins?.plugins?.["obsidian-sidebar-explorer"];
    try {
        // 重要度・画像パスのインデックスも、この操作を契機に最新化する。
        await sidebarExplorerPlugin?.refreshFileImportanceData?.();
        await sidebarExplorerPlugin?.exportImagePathsJson?.();
    } catch (error) {
        console.warn("Failed to refresh Sidebar Explorer indexes.", error);
    }

    workspace.iterateAllLeaves?.((leaf) => {
        const view = leaf?.view;
        const viewType = view?.getViewType?.();

        if (viewType === "sidebar-explorer-view") {
            // refreshRelatedFiles は同じ revision だと描画を省略するため、
            // 手動更新時だけ revision とキャッシュキーを進める。
            if (typeof view.relatedFilesRevision === "number") {
                view.relatedFilesRevision += 1;
            }
            view.lastRenderedRelatedKey = null;
            view.refreshTodaysFolder?.();
            view.refreshDataviewFiles?.();
            view.refreshCommonPromptFiles?.();
            view.refreshRecentFiles?.();
            view.refreshTopAccessFiles?.();
            view.refreshRelatedFiles?.();
            return;
        }

        if (viewType === "sidebar-explorer-tag-view") {
            // Sidebar Explorer Tag は検索条件・対象フォルダなどを保持したまま再集計する。
            view.refreshConfiguredScope?.();
        }
    });

    new Notice("表示中のMarkdownとサイドバーを再読み込みしました");
};
