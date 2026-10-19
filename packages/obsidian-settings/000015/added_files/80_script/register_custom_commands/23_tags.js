// =============================================================================
// タグ（MOC作成、一括変換、ノート一覧）
// =============================================================================

/**
 * タグ名から「#」を除去する
 **/
const normalizeTagName = (tag) => {
    if (!tag) return "";
    return tag.startsWith("#") ? tag.substring(1) : tag;
};

const splitFrontmatterTags = (tagsValue) => {
    const values = Array.isArray(tagsValue) ? tagsValue : [tagsValue];
    return values
        .flatMap((value) => String(value ?? "").split(","))
        .map((value) => normalizeTagName(value.trim()))
        .filter((value) => value.length > 0);
};

const uniqueTagNamesPreservingFirst = (tags) => {
    const seen = new Set();
    const unique = [];
    for (const tag of tags) {
        const key = tag.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(tag);
        }
    }
    return unique;
};

const sanitizeMocFileName = (tag) => {
    const rawTag = normalizeTagName(tag);
    return rawTag
        .replace(/[\\/:*?"<>|#\[\]]+/g, "_")
        .replace(/\s+/g, " ")
        .replace(/^_+|_+$/g, "")
        .trim() || "untitled";
};

/**
 * 指定されたタグを持つファイルを正しく抽出し、Excalidrawを除外する
 **/
const getFilesWithTag = (tag) => {
    if (!tag) return [];
    const normalizedTag = normalizeTagName(tag).toLowerCase();
    
    // 全てのMarkdownファイルを取得
    const files = app.vault.getMarkdownFiles();
    
    // 指定タグを含み、非Excalidrawであるファイルを抽出
    return files.filter(file => {
        // Excalidrawファイルは除外
        if (file.name.endsWith(".excalidraw.md")) return false;
        
        const cache = app.metadataCache.getFileCache(file);
        if (!cache) return false;
        
        // tagsおよびfrontmatter.tagsからタグをチェック
        let fileTags = [];
        if (cache.tags) {
            fileTags = fileTags.concat(cache.tags.map(t => normalizeTagName(t.tag).toLowerCase()));
        }
        if (cache.frontmatter && cache.frontmatter.tags) {
            fileTags = fileTags.concat(splitFrontmatterTags(cache.frontmatter.tags).map(t => t.toLowerCase()));
        }
        
        return fileTags.includes(normalizedTag);
    });
};

/**
 * 抽出されたファイルリストからMOCマークダウンコンテンツを生成する
 **/
const generateMocContent = (tag, files = []) => {
    const rawTag = normalizeTagName(tag);
    const links = [...files]
        .sort((a, b) => String(a.path).localeCompare(String(b.path), "ja"))
        .map((file) => `- [[${file.path}|${file.basename}]]`)
        .join("\n");
    return `# MOC: #${rawTag}\n\n${links}${links ? "\n" : ""}`;
};

/**
 * タグからMOCを作成または更新し、新規タブで開く
 **/
const createMocFromTag = async (tag) => {
    const rawTag = normalizeTagName(tag);
    if (!rawTag) return;
    
    const matchedFiles = getFilesWithTag(rawTag);
    if (matchedFiles.length === 0) {
        new Notice(`タグ #${rawTag} を含むファイルが見つかりませんでした。`);
        return;
    }
    
    const mocContent = generateMocContent(rawTag, matchedFiles);
    const safeTagName = sanitizeMocFileName(rawTag);
    const mocPath = `MOC-${safeTagName}.md`;
    
    try {
        let mocFile = app.vault.getAbstractFileByPath(mocPath);
        if (mocFile) {
            // 上書き
            await app.vault.modify(mocFile, mocContent);
            new Notice(`MOC: #${rawTag} を更新しました。`);
        } else {
            // 新規作成
            mocFile = await app.vault.create(mocPath, mocContent);
            new Notice(`MOC: #${rawTag} を作成しました。`);
        }
        
        // 新しいタブで開く
        const leaf = app.workspace.getLeaf(true);
        if (leaf) {
            await leaf.openFile(mocFile);
        }
    } catch (error) {
        new Notice(`MOC作成エラー: ${error.message}`);
        console.error(error);
    }
};

/**
 * 単一ファイル内のインラインタグおよびフロントマター内のタグを置換する
 **/
const renameTagInFile = async (file, oldTag, newTag) => {
    const rawOld = normalizeTagName(oldTag);
    const rawNew = normalizeTagName(newTag);
    if (!rawOld || !rawNew || rawOld.toLowerCase() === rawNew.toLowerCase()) return;

    // 1. 本文（インラインタグ）の置換
    let content = await app.vault.read(file);
    const cache = app.metadataCache.getFileCache(file);
    if (cache && cache.tags) {
        // 大文字小文字を区別せず一致するタグを抽出
        const matchedTags = cache.tags
            .filter(t => normalizeTagName(t.tag).toLowerCase() === rawOld.toLowerCase())
            .sort((a, b) => b.position.start.offset - a.position.start.offset);
        
        let hasInlineChanges = false;
        for (const t of matchedTags) {
            const startOffset = t.position.start.offset;
            const endOffset = t.position.end.offset;
            
            // フロントマターの範囲内にある場合はスキップ
            if (cache.frontmatterPosition && startOffset < cache.frontmatterPosition.end.offset) {
                continue;
            }
            
            const originalTagStr = content.substring(startOffset, endOffset);
            if (originalTagStr.startsWith("#")) {
                const newTagStr = "#" + rawNew;
                content = content.substring(0, startOffset) + newTagStr + content.substring(endOffset);
                hasInlineChanges = true;
            }
        }
        if (hasInlineChanges) {
            await app.vault.modify(file, content);
        }
    }
    
    // 2. フロントマター（YAML）の置換
    // 本文タグだけのノートで processFrontMatter を呼ぶと、空のYAMLブロックを
    // 新設することがあるため、tags プロパティが実在する場合だけ処理する。
    const hasFrontmatterTags = cache?.frontmatter &&
        Object.prototype.hasOwnProperty.call(cache.frontmatter, "tags");
    if (!hasFrontmatterTags) return;

    await app.fileManager.processFrontMatter(file, (frontmatter) => {
        if (!frontmatter || !frontmatter.tags) return;
        
        const replaceTag = (t) => {
            const raw = normalizeTagName(t);
            if (raw.toLowerCase() === rawOld.toLowerCase()) {
                return rawNew;
            }
            return raw;
        };

        if (Array.isArray(frontmatter.tags)) {
            const newTags = frontmatter.tags
                .map((value) => replaceTag(value))
                .filter((value) => value.length > 0);
            frontmatter.tags = uniqueTagNamesPreservingFirst(newTags);
        } else if (typeof frontmatter.tags === 'string') {
            const originalParts = splitFrontmatterTags(frontmatter.tags);
            const replacedParts = originalParts.map(replaceTag).filter((value) => value.length > 0);
            const uniqueParts = uniqueTagNamesPreservingFirst(replacedParts);
            if (uniqueParts.join(",") !== originalParts.join(",")) {
                frontmatter.tags = uniqueParts.join(", ");
            }
        }
    });
};

/**
 * 指定されたタグを他のタグ名に一括置換（結合・リネーム）する
 **/
const bulkRenameTag = async (oldTag) => {
    const rawOld = normalizeTagName(oldTag);
    if (!rawOld) return;

    let promptVal;
    if (SummaryModal) {
        promptVal = await new Promise((resolve) => {
            new TagRenameModal(app, rawOld, resolve).open();
        });
    } else if (typeof tp !== "undefined" && tp.system?.prompt) {
        promptVal = await tp.system.prompt("置換後のタグ名を入力してください（結合またはリネーム）", rawOld);
    } else {
        new Notice("タグ入力ダイアログを表示できません。TemplaterまたはObsidianを再読み込みしてください。");
        return;
    }

    if (promptVal === null) return;
    const rawNew = normalizeTagName(promptVal.trim());
    if (!rawNew || rawOld.toLowerCase() === rawNew.toLowerCase()) {
        new Notice("無効なタグ名、または同じタグ名が指定されたため、処理を中断しました。");
        return;
    }

    const matchedFiles = getFilesWithTag(rawOld);
    if (matchedFiles.length === 0) {
        new Notice(`タグ #${rawOld} を含むファイルが見つかりませんでした。`);
        return;
    }

    if (!window.confirm(`本当に #${rawOld} を #${rawNew} に一括変換しますか？\n対象ファイル数: ${matchedFiles.length} 件`)) {
        return;
    }

    new Notice("タグの一括変換を開始します...");
    let successCount = 0;
    for (const file of matchedFiles) {
        try {
            await renameTagInFile(file, rawOld, rawNew);
            successCount++;
        } catch (error) {
            console.error(`Failed to rename tag in file ${file.path}:`, error);
        }
    }
    
    new Notice(`タグの一括変換が完了しました。\n成功: ${successCount}/${matchedFiles.length} 件`);
};

/**
 * ノートの「# note一覧」を検索条件（Search Query）で追加・更新する。
 * 一覧の対象ノートの選び方（タグの対象フォルダ内だけ。10_summary のサマリーなどは載せない）と
 * 一覧の内容は obsidian-sidebar-explorer-tag と同じにするため、プラグインが公開する
 * window._sidebarExplorerTagUpdateNoteList へ委ねる（テンプレートは一覧の生成処理を持たない）。
 **/
const updateNoteListForFile = async (file, tag, silent = false, shouldContinue = () => true) => {
    const updateNoteList = window._sidebarExplorerTagUpdateNoteList;
    if (typeof updateNoteList !== "function") {
        if (!silent) new Notice("ノート一覧の更新には Sidebar Explorer Tag プラグインを有効にしてください。");
        return false;
    }
    return await updateNoteList(file, tag, { silent, shouldContinue });
};

const addNoteListFromTag = async (tag) => {
    const activeFile = app.workspace.getActiveFile();
    await updateNoteListForFile(activeFile, tag, false);
};
