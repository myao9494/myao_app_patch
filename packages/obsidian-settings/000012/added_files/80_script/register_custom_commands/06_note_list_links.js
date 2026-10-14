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
