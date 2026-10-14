// =============================================================================
// ノート一覧のリンクを右ペインで開く
// =============================================================================

// ノート一覧からのリンク先を右ペインで開く。右側の編集ペインがあれば再利用し、
// なければ最初のクリック時だけ縦分割して作成する。
const openNoteListLinkInRightPane = async (file, sourcePath) => {
    if (!file?.path) return;

    // 生成済みDataview一覧からは { path } だけが渡る場合があるため、
    // 必ずVault内の実際のTFileへ解決してからWorkspaceLeaf.openFileへ渡す。
    const targetFile = app.vault.getAbstractFileByPath(file.path);
    if (!targetFile || typeof targetFile.extension !== "string") {
        new Notice(`ノートが見つかりません: ${file.path}`);
        return;
    }

    const workspace = app.workspace;
    let sourceLeaf = workspace.activeLeaf;
    if (sourceLeaf?.view?.file?.path !== sourcePath) {
        sourceLeaf = null;
        workspace.iterateAllLeaves?.((leaf) => {
            if (!sourceLeaf && leaf?.view?.file?.path === sourcePath) sourceLeaf = leaf;
        });
    }
    if (!sourceLeaf) {
        await workspace.getLeaf(false)?.openFile(targetFile);
        return;
    }

    const sourceRect = sourceLeaf.containerEl?.getBoundingClientRect?.();
    const rightLeaves = [];
    workspace.iterateAllLeaves?.((leaf) => {
        if (leaf === sourceLeaf || !leaf?.containerEl) return;
        const viewType = leaf.view?.getViewType?.();
        // サイドバーではなく、ノートを表示できる中央ペインだけを候補にする。
        if (viewType && viewType !== "markdown" && viewType !== "empty") return;
        const rect = leaf.containerEl.getBoundingClientRect();
        if (sourceRect && rect.left >= sourceRect.right - 2 && rect.width > 0) {
            rightLeaves.push({ leaf, distance: rect.left - sourceRect.right });
        }
    });

    rightLeaves.sort((a, b) => a.distance - b.distance);
    let targetLeaf = rightLeaves[0]?.leaf;
    if (!targetLeaf) {
        workspace.setActiveLeaf?.(sourceLeaf, { focus: false });
        targetLeaf = workspace.getLeaf("split", "vertical");
    }
    if (!targetLeaf) return;

    await targetLeaf.openFile(targetFile, { active: true });
    // 開いたノートをすぐ操作できるよう、右ペインへフォーカスを移す。
    workspace.setActiveLeaf?.(targetLeaf, { focus: true });
};
window._openNoteListLinkInRightPane = openNoteListLinkInRightPane;

// ノートの内部リンクを Cmd（Windows/Linux は Ctrl）+ クリックしたとき、隣のペインで開く。
const isNewPaneLinkModifier = (e) => {
    const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || "");
    const hasMod = isMac ? e.metaKey : e.ctrlKey;
    const otherMod = e.shiftKey || e.altKey || (isMac ? e.ctrlKey : e.metaKey);
    return e.button === 0 && hasMod && !otherMod;
};

// クリックされた内部リンクが指すファイルを返す。リンクでなければ null。
const resolveClickedInternalLinkFile = (e) => {
    const target = e.target;
    if (!target?.closest || target.closest(".internal-embed, .media-embed, .image-embed")) return null;
    const markdownEl = target.closest(".markdown-preview-view, .markdown-source-view");
    if (!markdownEl) return null;
    const view = findMarkdownViewForElement(markdownEl);
    const sourceFile = view?.file;
    if (!sourceFile) return null;

    let linkpath = "";
    const readingLink = target.closest("a.internal-link");
    if (readingLink) {
        linkpath = readingLink.getAttribute("data-href") || readingLink.getAttribute("href") || "";
    } else if (target.closest(".cm-hmd-internal-link, .cm-link")) {
        const linkEl = target.closest(".cm-hmd-internal-link, .cm-link");
        // 表示名付きのリンクでも解決できるよう、カーソル位置からメタデータ上のリンクを探す。
        try {
            const cm = view.editor?.cm;
            const offset = cm?.posAtDOM?.(linkEl);
            const links = app.metadataCache.getFileCache(sourceFile)?.links || [];
            const hit = typeof offset === "number"
                ? links.find((l) => offset >= l.position.start.offset - 1 && offset <= l.position.end.offset)
                : null;
            linkpath = hit?.link || "";
        } catch {
            linkpath = "";
        }
        if (!linkpath && linkEl.classList.contains("cm-hmd-internal-link")) linkpath = linkEl.textContent || "";
    }
    linkpath = String(linkpath).split("|")[0].split("#")[0].trim();
    if (!linkpath || /^[a-z][a-z0-9+.-]*:\/\//i.test(linkpath)) return null;
    let decoded = linkpath;
    try { decoded = decodeURIComponent(linkpath); } catch { /* そのまま使う */ }
    const file = app.metadataCache.getFirstLinkpathDest(decoded, sourceFile.path);
    return file ? { file, sourcePath: sourceFile.path } : null;
};

const handleLinkModifierClick = (e) => {
    if (!isNewPaneLinkModifier(e)) return;
    const resolved = resolveClickedInternalLinkFile(e);
    if (!resolved) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    // mousedown では標準の動作を止めるだけにし、開く処理は click で1回だけ行う。
    if (e.type !== "click") return;
    void openNoteListLinkInRightPane(resolved.file, resolved.sourcePath);
};
