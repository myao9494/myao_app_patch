// =============================================================================
// 添付ファイルの削除と、ノート内リンクの自動クリーンアップ
// =============================================================================

const getBacklinks = (file) => {
    const backlinks = [];
    const resolvedLinks = app.metadataCache.resolvedLinks;
    if (resolvedLinks) {
        for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
            if (links[file.path]) {
                backlinks.push(sourcePath);
            }
        }
    }
    return backlinks;
};

// リンク先パスが削除対象ファイル（attachmentFile）と一致するか判定する
const isTargetAttachmentLink = (rawLinkpath, attachmentFile, sourceFile = null) => {
    if (!rawLinkpath || !attachmentFile) return false;
    let linkpath = String(rawLinkpath).trim().replace(/\\/g, "/").replace(/^\.\//, "");
    linkpath = linkpath.split("#")[0].split("?")[0].trim();
    try {
        linkpath = decodeURIComponent(linkpath);
    } catch (_) {}

    const sourcePath = typeof sourceFile === "string" ? sourceFile : (sourceFile?.path || "");
    const sourceFolder = typeof sourceFile === "object" && sourceFile?.parent?.path
        ? sourceFile.parent.path
        : (sourcePath.includes("/") ? sourcePath.split("/").slice(0, -1).join("/") : "");

    const linkedFile = app.metadataCache?.getFirstLinkpathDest?.(linkpath, sourcePath);
    const relativePath = sourceFolder ? `${sourceFolder}/${linkpath}`.replace(/\/+/g, "/") : linkpath;

    return linkedFile?.path === attachmentFile.path ||
        linkpath === attachmentFile.path ||
        relativePath === attachmentFile.path ||
        linkpath === attachmentFile.name ||
        (attachmentFile.basename && linkpath === attachmentFile.basename);
};

// ノートテキスト内の attachmentFile へのリンク（Wikilink/Markdownリンク/埋め込み）をクリーンに削除する。
// 単独行や箇条書きリスト項目は行ごと（改行含め）削除し、インラインリンクは該当リンクのみ削除する。
const cleanAttachmentLinksInText = (content, attachmentFile, sourceFile = null) => {
    if (typeof content !== "string") return content;

    const wikilinkRegex = /(!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\])/g;
    const mdlinkRegex = /(!?\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\))/g;

    const lines = content.split("\n");
    const updatedLines = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let hasTargetLink = false;

        const wikilinks = Array.from(line.matchAll(wikilinkRegex));
        for (const match of wikilinks) {
            if (isTargetAttachmentLink(match[2], attachmentFile, sourceFile)) {
                hasTargetLink = true;
                break;
            }
        }

        if (!hasTargetLink) {
            const mdlinks = Array.from(line.matchAll(mdlinkRegex));
            for (const match of mdlinks) {
                if (isTargetAttachmentLink(match[3], attachmentFile, sourceFile)) {
                    hasTargetLink = true;
                    break;
                }
            }
        }

        if (!hasTargetLink) {
            updatedLines.push(line);
            continue;
        }

        // ターゲットリンクを置換
        let cleanedLine = line.replace(wikilinkRegex, (fullMatch, _p1, rawPath) => {
            return isTargetAttachmentLink(rawPath, attachmentFile, sourceFile) ? "" : fullMatch;
        });
        cleanedLine = cleanedLine.replace(mdlinkRegex, (fullMatch, _p1, _text, rawPath) => {
            return isTargetAttachmentLink(rawPath, attachmentFile, sourceFile) ? "" : fullMatch;
        });

        const isOnlyListMarker = /^[ \t]*(?:[-*+]|\d+\.)[ \t]*$/.test(cleanedLine);
        const isBlank = /^[ \t]*$/.test(cleanedLine);

        // リスト記号だけになった場合、または単独行リンクだった場合は行ごと削除
        if (isOnlyListMarker || isBlank) {
            continue;
        }

        updatedLines.push(cleanedLine);
    }

    let result = updatedLines.join("\n");
    // 連続する空行（3行以上）を最大2行（段落間空行1つ）に正規化
    result = result.replace(/\n{3,}/g, "\n\n");
    return result;
};

// ノート内の添付ファイルへのリンク（埋め込み・通常リンク・Markdownリンク）をすべてクリーンに削除する。
const removeEmbeddedAttachmentLinks = async (sourceFile, attachmentFile) => {
    const originalContent = await app.vault.read(sourceFile);
    const updatedContent = cleanAttachmentLinksInText(originalContent, attachmentFile, sourceFile);
    return { originalContent, updatedContent, changed: updatedContent !== originalContent };
};
const removeAttachmentLinksFromContent = removeEmbeddedAttachmentLinks;

// 削除後に開いているノートを再読込し、リンク切れの埋め込み表示を残さない。
const refreshAttachmentSourceFile = async (sourceFile) => {
    const leaves = [];
    app.workspace.iterateAllLeaves?.((leaf) => {
        if (leaf?.view?.file?.path === sourceFile.path) leaves.push(leaf);
    });
    for (const leaf of leaves) {
        try {
            await leaf.openFile(sourceFile, { active: leaf === app.workspace.activeLeaf });
        } catch (error) {
            console.warn("Failed to refresh attachment source file:", error);
        }
    }
};

// 画像・PDF・Office文書など、添付ファイルを削除する。
// 削除時に、指定されたノートおよびアクティブノート・参照元ノート内の該当リンクをすべて自動削除する。
const deleteAttachmentFile = async (file, sourceFile = null) => {
    // 削除対象リンクを含む可能性のあるノートを収集
    const targetNotes = new Map(); // path -> TFile

    if (sourceFile && (sourceFile.extension === "md" || sourceFile.path?.endsWith(".md"))) {
        targetNotes.set(sourceFile.path, sourceFile);
    } else {
        // sourceFile が指定されていない場合（ファイルエクスプローラー等からの削除）、
        // アクティブなノートおよびバックリンク元の全ノートを対象とする
        const activeFile = typeof app !== "undefined" ? app.workspace?.getActiveFile?.() : null;
        if (activeFile && (activeFile.extension === "md" || activeFile.path?.endsWith(".md"))) {
            targetNotes.set(activeFile.path, activeFile);
        }
        const backlinks = getBacklinks(file);
        for (const backlinkPath of backlinks) {
            const noteFile = app.vault?.getAbstractFileByPath?.(backlinkPath);
            if (noteFile) {
                targetNotes.set(noteFile.path, noteFile);
            }
        }
    }

    const backlinks = getBacklinks(file);
    let message = `本当に添付ファイル「${file.name}」を削除しますか？\nシステムのゴミ箱に移動します。`;
    if (targetNotes.size > 0) {
        const noteNames = Array.from(targetNotes.values()).map(f => f.name || f.path).join(", ");
        message = `添付ファイル「${file.name}」を削除しますか？\nノート（${noteNames}）内のリンクも同時に削除し、システムのゴミ箱へ移動します。`;
    } else if (backlinks.length > 0) {
        message = `警告: この添付ファイルは以下のノートで参照されています:\n\n` +
            backlinks.map(path => `- ${path}`).join("\n") +
            `\n\n${message}`;
    }

    if (!window.confirm(message)) return;
    const modifiedNotes = [];
    try {
        for (const noteFile of targetNotes.values()) {
            const linkRemoval = await removeEmbeddedAttachmentLinks(noteFile, file);
            if (linkRemoval.changed) {
                modifiedNotes.push({ file: noteFile, originalContent: linkRemoval.originalContent });
                await app.vault.modify(noteFile, linkRemoval.updatedContent);
            }
        }
        await app.vault.trash(file, true);
        for (const item of modifiedNotes) {
            await refreshAttachmentSourceFile(item.file);
        }
        new Notice(`添付ファイル「${file.name}」を削除しました`);
    } catch (error) {
        // リンクだけが消えて添付ファイルが残る状態を避けるため、削除失敗時は復元する。
        for (const item of modifiedNotes) {
            try {
                if (app.vault?.getAbstractFileByPath?.(file.path)) {
                    await app.vault.modify(item.file, item.originalContent);
                }
            } catch (rbErr) {
                console.error("Rollback failed for", item.file.path, rbErr);
            }
        }
        console.error("Failed to delete attachment file:", error);
        new Notice("添付ファイルの削除に失敗しました");
    }
};

const deleteImageFile = async (file, sourceFile = null) => deleteAttachmentFile(file, sourceFile);

const isNonMarkdownAttachmentFile = (file) => {
    return !!file?.name && typeof file.extension === "string" && file.extension.toLowerCase() !== "md";
};
