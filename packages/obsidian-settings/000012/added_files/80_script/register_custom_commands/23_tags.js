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
 * ノート一覧用のタグ検索。通常の含める条件はすべて満たし、topタグ付きノートだけは
 * -tag の除外条件を免除する（MOCを一覧に残すため）。
 */
const getFilesForNoteListQuery = (query) => {
    const keywords = String(query ?? "")
        .trim()
        .split(/[\s\u3000]+/)
        .filter(Boolean)
        .map(keyword => keyword.toLowerCase());
    if (keywords.length === 0) return [];

    const includeKeywords = [];
    const excludeKeywords = [];
    for (const keyword of keywords) {
        const normalized = normalizeTagName(keyword.replace(/^-/, "")).trim();
        if (!normalized) continue;
        if (keyword.startsWith("-") && keyword.length > 1) {
            excludeKeywords.push(normalized);
        } else {
            includeKeywords.push(normalized);
        }
    }

    return app.vault.getMarkdownFiles().filter(file => {
        if (file.name.endsWith(".excalidraw.md")) return false;

        const cache = app.metadataCache.getFileCache(file);
        if (!cache) return false;

        let fileTags = [];
        if (cache.tags) {
            fileTags.push(...cache.tags.map(entry => normalizeTagName(entry.tag).toLowerCase()));
        }
        if (cache.frontmatter?.tags) {
            fileTags.push(...splitFrontmatterTags(cache.frontmatter.tags).map(tag => tag.toLowerCase()));
        }

        const matchesAllInclude = includeKeywords.every(keyword =>
            fileTags.some(tag => tag.includes(keyword))
        );
        if (!matchesAllInclude) return false;

        const isTopTagged = fileTags.some(tag => tag === "top");
        return isTopTagged || excludeKeywords.every(keyword =>
            !fileTags.some(tag => tag.includes(keyword))
        );
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
 * タグから該当するノート一覧を取得し、現在開いているノートの先頭（または既存の「# note一覧」）に挿入・上書きし、
 * プロパティに「Search Query」を追加する
 **/
const NOTE_LIST_MARKER_START = "<!-- custom-note-list:start -->";
const NOTE_LIST_MARKER_END = "<!-- custom-note-list:end -->";
const replaceNoteListSection = (fileContent, noteListContent) => {
    // 一覧の内容に「$&」などが含まれても置換パターンとして解釈されないよう、関数で置き換える。
    // ※ 同じ処理が obsidian-sidebar-explorer-tag（noteListSection.ts）にもある。変更するときは両方を直すこと。
    const markedListRegex = /# note一覧[^\n]*\n\s*<!-- custom-note-list:start -->[\s\S]*?<!-- custom-note-list:end -->\n?/;
    if (markedListRegex.test(fileContent)) {
        return fileContent.replace(markedListRegex, () => noteListContent);
    }

    const legacyListRegex = /# note一覧[^\n]*\n(?:\s*\n)?(?:(?:\|.*\|\s*\n)|(?:- .*(?:\n|$)))*/;
    if (legacyListRegex.test(fileContent)) {
        return fileContent.replace(legacyListRegex, () => noteListContent);
    }

    return null;
};

// ノート一覧の「冒頭」列に出す本文の抜粋（先頭100文字）。フロントマター・一覧自身・埋め込み・タグ記号を除く。
const extractNoteExcerpt = (content) => {
    let clean = content;
    // YAMLフロントマターを除去
    clean = clean.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    // # note一覧 セクションを除去 (次の大見出し # まで、またはファイルの終わりまで)
    clean = clean.replace(/#\s+note一覧[\s\S]*?(?=\n#\s|$)/i, "");

    return clean
        .replace(/!\[\[[^\]]*\]\]/g, "")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/<img\b[^>]*>/gi, "")
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
        .replace(/\[\[([^\]]+)\]\]/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 100)
        .replace(/#/g, "\\#");
};

const formatNoteListDate = (timestamp) => {
    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

// ノート一覧の1行分のデータ（名称、プロパティのタグ、冒頭、作成日、編集日）を作る。
const buildNoteListRow = async (f) => {
    const cache = app.metadataCache.getFileCache(f);
    // テーブルのタグ列は、ノート本文のインラインタグではなく、
    // 上部プロパティ(tags / tag)に設定されたタグだけを表示する。
    const tags = [];
    const frontmatter = cache?.frontmatter;
    const frontmatterValue = frontmatter?.tags ?? frontmatter?.tag;
    for (const tagName of (frontmatterValue !== undefined ? splitFrontmatterTags(frontmatterValue) : [])) {
        const normalized = normalizeTagName(String(tagName)).trim();
        if (normalized) tags.push("#" + normalized);
    }

    const seen = new Set();
    const uniqueTags = [];
    for (const t of tags) {
        const lower = t.toLowerCase();
        if (!seen.has(lower)) {
            seen.add(lower);
            uniqueTags.push(t);
        }
    }

    const content = await app.vault.cachedRead(f);
    const excerpt = extractNoteExcerpt(content);
    return {
        path: f.path,
        name: f.basename,
        // 文字列ではなくタグ配列を保存し、DataviewJS 側で Obsidian ネイティブのタグ要素として描画する。
        tags: uniqueTags,
        excerpt,
        ctime: formatNoteListDate(f.stat.ctime),
        mtime: formatNoteListDate(f.stat.mtime)
    };
};

// ノートへ書き込む「# note一覧」セクション（検索ボックス付きの DataviewJS ブロック）を組み立てる。
// ※ 出力はノートに保存される。1文字でも変えると、一覧を持つ全ノートが次回の自動更新で書き換わる。
const buildNoteListContent = (noteRows) => {
    const noteListData = JSON.stringify(noteRows);
    return `# note一覧
${NOTE_LIST_MARKER_START}

\`\`\`dataviewjs
// 自動更新で一覧を書き換えても、検索ボックスも常に一緒に再生成する。
const noteListRows = ${noteListData};
const sourcePath = dv.current().file.path;
const searchInput = dv.el("input", "", {
    attr: {
        type: "search",
        placeholder: "ノート名で検索…",
        "aria-label": "ノート名で検索"
    }
});
searchInput.style.marginBottom = "0.75em";
searchInput.style.width = "min(100%, 28em)";

const tableContainer = dv.el("div", "");
const renderNoteList = () => {
    const keywords = searchInput.value.trim().toLocaleLowerCase()
        .split(/[\\s\\u3000]+/).filter(Boolean);
    const rows = noteListRows.filter(row => {
        const name = row.name.toLocaleLowerCase();
        return keywords.every(keyword => name.includes(keyword));
    });

    tableContainer.empty();
    const table = tableContainer.createEl("table", { cls: "dataview table-view-table" });
    const headerRow = table.createEl("thead").createEl("tr");
    ["名称", "タグ", "冒頭", "作成日", "編集日"].forEach(title => headerRow.createEl("th", { text: title }));
    const body = table.createEl("tbody");

    if (rows.length === 0) {
        const row = body.createEl("tr");
        row.createEl("td", { text: "該当するノートがありません", attr: { colspan: "5" } });
        return;
    }

    rows.forEach(rowData => {
        const row = body.createEl("tr");
        const nameCell = row.createEl("td");
        const linkButton = nameCell.createEl("button", { text: rowData.name });
        linkButton.type = "button";
        linkButton.style.cssText = "padding:0;border:0;background:transparent;color:var(--link-color);cursor:pointer;text-decoration:var(--link-decoration);font:inherit;text-align:left;";
        linkButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            const targetFile = app.vault.getAbstractFileByPath(rowData.path);
            if (targetFile) void window._openNoteListLinkInRightPane(targetFile, sourcePath);
        });
        const tagCell = row.createEl("td");
        (Array.isArray(rowData.tags) ? rowData.tags : String(rowData.tags || "").split(/\\s+/))
            .filter(Boolean)
            .forEach(tag => {
                const tagName = String(tag).replace(/^#/, "");
                const tagLink = tagCell.createEl("a", {
                    cls: "tag",
                    text: "#" + tagName,
                    attr: { href: "#" + tagName, "data-href": tagName }
                });
                tagLink.style.marginRight = "0.35em";
            });
        row.createEl("td", { text: rowData.excerpt });
        row.createEl("td", { text: rowData.ctime });
        row.createEl("td", { text: rowData.mtime });
    });
};

searchInput.addEventListener("input", renderNoteList);
renderNoteList();
\`\`\`

${NOTE_LIST_MARKER_END}
`;
};

// ノートの「Search Query」プロパティを検索条件に合わせる。中断された場合は false を返す。
const syncNoteListSearchQuery = async (file, desiredQuery, shouldContinue) => {
    const cachedFrontmatter = app.metadataCache.getFileCache(file)?.frontmatter || {};
    // プロパティが存在する場合は、キーをそれに合わせる（"Search Query" または "SearchQuery"）
    const existingKey = Object.keys(cachedFrontmatter).find(key =>
        key.toLowerCase().replace(/\s+/g, "") === "searchquery"
    );
    const needsQueryUpdate = !existingKey || cachedFrontmatter[existingKey] !== desiredQuery;

    // 同じ値を毎回 processFrontMatter で書き戻すと、他プラグインのインデックス・表示更新も
    // 起こしてしまうため、実際に差分があるときだけ更新する。
    if (needsQueryUpdate) {
        if (!shouldContinue()) return false;
        await app.fileManager.processFrontMatter(file, (frontmatter) => {
            const frontmatterKey = Object.keys(frontmatter).find(key =>
                key.toLowerCase().replace(/\s+/g, "") === "searchquery"
            );
            frontmatter[frontmatterKey || "Search Query"] = desiredQuery;
        });
    }
    return true;
};

// 一覧がまだ無いノートへ、フロントマターの直後（無ければ先頭）に一覧を挿入する。
const insertNoteListAfterFrontmatter = (fileContent, noteListContent) => {
    const hasFrontmatter = fileContent.startsWith("---\n") || fileContent.startsWith("---\r\n");
    let insertIndex = 0;
    if (hasFrontmatter) {
        const secondTripleDash = fileContent.indexOf("\n---", 3);
        if (secondTripleDash !== -1) {
            const endOfLine = fileContent.indexOf("\n", secondTripleDash + 4);
            if (endOfLine !== -1) {
                insertIndex = endOfLine + 1;
            } else {
                insertIndex = secondTripleDash + 4;
            }
        }
    }
    return fileContent.slice(0, insertIndex) + noteListContent + "\n" + fileContent.slice(insertIndex);
};

const updateNoteListForFile = async (file, tag, silent = false, shouldContinue = () => true) => {
    const query = String(tag ?? "").trim();
    if (!query) return;

    if (!file || file.extension !== "md" || file.name.endsWith(".excalidraw.md")) {
        if (!silent) new Notice("開いているマークダウンノートがありません。");
        return;
    }
    if (!shouldContinue()) return;

    const matchedFiles = getFilesForNoteListQuery(query).filter(f => f.path !== file.path);
    const noteRows = await Promise.all(matchedFiles.map(buildNoteListRow));
    if (!shouldContinue()) return;

    const noteListContent = buildNoteListContent(noteRows);

    try {
        if (!await syncNoteListSearchQuery(file, query, shouldContinue)) return;

        if (!shouldContinue()) return;
        const originalFileContent = await app.vault.read(file);
        const fileContent = replaceNoteListSection(originalFileContent, noteListContent)
            ?? insertNoteListAfterFrontmatter(originalFileContent, noteListContent);

        // テーブルに差分がなければ書き込まない。無駄な vault modify を避けることで、
        // Grimoire を含むファイル変更監視プラグインの再処理を発生させない。
        if (fileContent !== originalFileContent) {
            if (!shouldContinue()) return;
            await app.vault.modify(file, fileContent);
        }
        // vault.modify による標準のファイル更新通知へ任せる。previewMode.rerender(true) を
        // 併用すると Windows では Dataview の既存 DOM が残り、一覧が重複することがある。
        if (!silent) new Notice(`ノート一覧を追加・更新しました。`);
    } catch (error) {
        if (!silent) new Notice(`ノート一覧の追加に失敗しました: ${error.message}`);
        console.error(error);
    }
};

const addNoteListFromTag = async (tag) => {
    const activeFile = app.workspace.getActiveFile();
    await updateNoteListForFile(activeFile, tag, false);
};
