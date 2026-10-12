// =============================================================================
// ファイルマネージャー連携（リンク生成、コピーして同一フォルダーに保存）と、エディタメニュー（editor-menu）
// =============================================================================

/**
 * ファイルマネージャーからのドラッグ＆ドロップテキストを解析する
 * @param {string} text - ドロップされたテキスト
 * @returns {Array<Object>|null} 解析されたアイテム配列、または非該当の場合null
 **/
const parseFileManagerData = (text) => {
    if (!text || typeof text !== "string") return null;
    const trimmed = text.trim();
    if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
            if (parsed.length > 0 && parsed.every(item => item && typeof item === "object" && typeof item.path === "string")) {
                return parsed;
            }
        } else if (parsed && typeof parsed === "object" && typeof parsed.path === "string") {
            return [parsed];
        }
    } catch (e) {
        // JSONでなければnull
    }
    return null;
};

/**
 * ファイルマネージャーのアイテム配列からMarkdownリンク文字列を生成する
 * @param {Array<Object>} items - アイテム配列
 * @returns {string} Markdownリンク文字列
 **/
const generateFileManagerMarkdown = (items) => {
    if (!Array.isArray(items) || items.length === 0) return "";
    const formatItem = (item) => {
        const filePath = item.path || "";
        const name = item.name || filePath.split("/").filter(Boolean).pop() || "link";
        const encodedUrl = `http://localhost:8001/api/open-path?path=${encodeURIComponent(filePath)}`;
        return `[${name}](${encodedUrl})`;
    };

    if (items.length === 1) {
        return formatItem(items[0]);
    }

    return items.map(item => `- ${formatItem(item)}`).join("\n");
};

/**
 * MarkdownリンクまたはURL文字列から open-path の対象ファイルパスを抽出する
 * @param {string} linkTextOrUrl - リンク文字列またはURL
 * @returns {string|null} デコードされたファイルパス、またはnull
 **/
const extractOpenPathFromLink = (linkTextOrUrl) => {
    if (!linkTextOrUrl || typeof linkTextOrUrl !== "string") return null;

    // Markdownリンク [name](url) からurlを抽出
    const mdMatch = linkTextOrUrl.match(/\[.*?\]\((https?:\/\/[^)]+)\)/);
    const urlStr = mdMatch ? mdMatch[1] : linkTextOrUrl;

    try {
        const url = new URL(urlStr);
        if (url.pathname === "/api/open-path" && url.searchParams.has("path")) {
            return decodeURIComponent(url.searchParams.get("path"));
        }
    } catch (e) {
        // URLパース失敗時の正規表現フォールバック
    }

    const paramMatch = urlStr.match(/[?&]path=([^&\s)]+)/);
    if (paramMatch) {
        return decodeURIComponent(paramMatch[1]);
    }

    return null;
};

/**
 * ファイル名から適切なObsidianリンク（画像は埋め込み形式、その他は拡張子付きリンク）を生成する
 * @param {string} fileName - ファイル名
 * @returns {string} Obsidianリンク文字列
 **/
const buildObsidianLink = (fileName) => {
    if (!fileName || typeof fileName !== "string") return "";
    const imageExtensions = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".webp", ".avif"];
    const extMatch = fileName.match(/\.[^.]+$/);
    const ext = extMatch ? extMatch[0].toLowerCase() : "";
    if (imageExtensions.includes(ext)) {
        return `![[${fileName}]]`;
    }
    return `[[${fileName}]]`;
};

/**
 * Markdown本文からローカルで参照されている実在ファイル（画像、PDF、添付ファイル等）を抽出する
 * @param {string} markdownContent - Markdownテキスト
 * @param {string} sourceDir - コピー元Markdownファイルが存在するディレクトリ
 * @param {Object} [options] - オプション（fsなど）
 * @returns {Array<{ absolutePath: string, relativePath: string }>} 抽出された関連ファイル一覧
 **/
const extractMarkdownLinkedFiles = (markdownContent, sourceDir, options = {}) => {
    if (!markdownContent || typeof markdownContent !== "string" || !sourceDir) return [];
    const fsLib = options.fs || (typeof require === "function" ? require("fs") : (typeof fs !== "undefined" ? fs : null));
    const pathLib = options.path || (typeof require === "function" ? require("path") : (typeof path !== "undefined" ? path : null)) || {
        join: (...args) => args.filter(Boolean).join("/").replace(/\/+/g, "/"),
        resolve: (dir, p) => (p.startsWith("/") ? p : `${dir}/${p}`.replace(/\/+/g, "/")),
        relative: (from, to) => {
            const f = from.replace(/\/+$/, "") + "/";
            return to.startsWith(f) ? to.slice(f.length) : to.split("/").pop();
        }
    };

    if (!fsLib) return [];

    const candidates = new Set();

    // 1. Wikilink形式: ![[target]] または [[target]]
    const wikilinkRegex = /!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
    let match;
    while ((match = wikilinkRegex.exec(markdownContent)) !== null) {
        const target = match[1].trim();
        if (target) candidates.add(target);
    }

    // 2. 標準Markdownリンク形式: ![alt](target) または [text](target)
    const mdLinkRegex = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
    while ((match = mdLinkRegex.exec(markdownContent)) !== null) {
        const rawTarget = match[1].trim();
        if (/^(https?:\/\/|ftp:\/\/|mailto:|obsidian:\/\/|#)/i.test(rawTarget)) {
            continue;
        }
        const cleaned = rawTarget.split("#")[0].split("?")[0].trim();
        if (cleaned) {
            try {
                candidates.add(decodeURIComponent(cleaned));
            } catch (e) {
                candidates.add(cleaned);
            }
        }
    }

    const linkedFiles = [];
    const seenPaths = new Set();

    for (const relTarget of candidates) {
        let resolvedPath = pathLib.resolve(sourceDir, relTarget);
        if (!fsLib.existsSync(resolvedPath)) {
            if (!/\.[a-zA-Z0-9]+$/.test(relTarget)) {
                const mdCandidate = pathLib.resolve(sourceDir, `${relTarget}.md`);
                if (fsLib.existsSync(mdCandidate)) {
                    resolvedPath = mdCandidate;
                }
            }
        }

        if (fsLib.existsSync(resolvedPath)) {
            try {
                const stat = fsLib.statSync ? fsLib.statSync(resolvedPath) : null;
                if (stat && stat.isDirectory()) continue;
            } catch (e) { }

            if (!seenPaths.has(resolvedPath)) {
                seenPaths.add(resolvedPath);
                let relativePath = pathLib.relative ? pathLib.relative(sourceDir, resolvedPath) : relTarget;
                if (relativePath.startsWith("/")) relativePath = relativePath.slice(1);
                linkedFiles.push({
                    absolutePath: resolvedPath,
                    relativePath
                });
            }
        }
    }

    return linkedFiles;
};

/**
 * ファイルをアクティブノートと同じフォルダーにコピーし、Obsidianリンクへ変換する処理を実行する
 * @param {Object} params
 * @param {string} params.sourceFilePath - コピー元ファイルの絶対パス
 * @param {string} params.originalLinkText - 元のリンク文字列（例: [aaa.md](http://...)）
 * @param {Object} [params.context] - 実行コンテキスト（モック・依存注入対応）
 * @returns {Promise<Object>} 実行結果
 **/
const executeCopyAndConvertLink = async ({ sourceFilePath, originalLinkText, context }) => {
    const fsLib = context?.fs || (typeof require === "function" ? require("fs") : (typeof fs !== "undefined" ? fs : null));
    const pathLib = context?.path || (typeof require === "function" ? require("path") : (typeof path !== "undefined" ? path : null)) || {
        join: (...args) => args.filter(Boolean).join("/").replace(/\/+/g, "/"),
        dirname: (p) => (p || "").split("/").slice(0, -1).join("/") || "/",
        basename: (p) => (p || "").split("/").filter(Boolean).pop() || "",
        resolve: (dir, p) => (p.startsWith("/") ? p : `${dir}/${p}`.replace(/\/+/g, "/")),
        relative: (from, to) => {
            const f = from.replace(/\/+$/, "") + "/";
            return to.startsWith(f) ? to.slice(f.length) : to.split("/").pop();
        }
    };
    const confirmFn = context?.confirm || (typeof window !== "undefined" && window.confirm ? window.confirm.bind(window) : () => true);
    const noticeFn = context?.notice || (typeof Notice !== "undefined" ? (msg) => new Notice(msg) : (msg) => console.log(msg));

    // コピー元ファイルの存在確認
    if (!fsLib.existsSync(sourceFilePath)) {
        noticeFn(`コピー元のファイルが見つかりません: ${sourceFilePath}`);
        return { success: false, reason: "source_not_found" };
    }

    const activeFile = context?.activeFile || (typeof app !== "undefined" ? app.workspace.getActiveFile() : null);
    if (!activeFile) {
        noticeFn("アクティブなノートファイルが見つかりません。");
        return { success: false, reason: "active_file_not_found" };
    }

    const basePath = context?.basePath || (typeof app !== "undefined" && app.vault?.adapter?.basePath ? app.vault.adapter.basePath : "");
    const parentFolder = activeFile.parent ? (typeof activeFile.parent === "string" ? activeFile.parent : activeFile.parent.path) : "";
    const targetDir = parentFolder ? pathLib.join(basePath, parentFolder) : basePath;
    const fileName = pathLib.basename(sourceFilePath);
    const destFilePath = pathLib.join(targetDir, fileName);

    // コピー対象がMarkdownの場合、内部の参照ファイル（画像、PDF、添付ファイル等）も抽出
    const sourceDir = pathLib.dirname(sourceFilePath);
    let relatedFiles = [];
    if (fileName.toLowerCase().endsWith(".md") && typeof fsLib.readFileSync === "function") {
        try {
            const content = fsLib.readFileSync(sourceFilePath, "utf8");
            relatedFiles = extractMarkdownLinkedFiles(content, sourceDir, { fs: fsLib, path: pathLib });
        } catch (readErr) {
            console.warn("Failed to read markdown for linked files extraction:", readErr);
        }
    }

    // 既存ファイルの上書きチェック（メインファイル + 関連ファイル）
    const existingConflicts = [];
    if (fsLib.existsSync(destFilePath)) {
        existingConflicts.push(fileName);
    }
    for (const relItem of relatedFiles) {
        const destRelPath = pathLib.join(targetDir, relItem.relativePath);
        if (fsLib.existsSync(destRelPath)) {
            existingConflicts.push(relItem.relativePath);
        }
    }

    if (existingConflicts.length > 0) {
        const conflictList = existingConflicts.slice(0, 5).join("\n- ");
        const extraMsg = existingConflicts.length > 5 ? `\n...他 ${existingConflicts.length - 5} 件` : "";
        const confirmed = confirmFn(`以下のファイル（${existingConflicts.length}件）が既に現在のフォルダーに存在します。上書きしますか？\n- ${conflictList}${extraMsg}`);
        if (!confirmed) {
            return { success: false, cancelled: true, fileName };
        }
    }

    try {
        // メインファイルのコピー
        fsLib.copyFileSync(sourceFilePath, destFilePath);

        // 関連ファイルのコピー
        const copiedRelated = [];
        for (const relItem of relatedFiles) {
            const destRelPath = pathLib.join(targetDir, relItem.relativePath);
            const destRelDir = pathLib.dirname(destRelPath);
            if (!fsLib.existsSync(destRelDir) && typeof fsLib.mkdirSync === "function") {
                fsLib.mkdirSync(destRelDir, { recursive: true });
            }
            fsLib.copyFileSync(relItem.absolutePath, destRelPath);
            copiedRelated.push(destRelPath);
        }

        if (relatedFiles.length > 0) {
            noticeFn(`「${fileName}」と関連ファイル（${relatedFiles.length}件）を保存しました`);
        } else {
            noticeFn(`ファイルをコピーして保存しました: ${fileName}`);
        }
    } catch (err) {
        noticeFn(`ファイルのコピーに失敗しました: ${err.message}`);
        return { success: false, error: err };
    }

    const newLink = buildObsidianLink(fileName);
    return {
        success: true,
        fileName,
        destFilePath,
        newLink,
        relatedFilesCount: relatedFiles.length
    };
};

const handleEditorMenu = (menu, editor, view) => {
    const file = view?.file || (typeof app !== "undefined" ? app.workspace.getActiveFile() : null);
    if (!file) return;

    // ファイルマネージャーのリンクに対する「コピーして同一フォルダーに保存」メニュー項目
    if (editor) {
        try {
            const cursor = editor.getCursor();
            const lineText = editor.getLine(cursor.line);
            const linkRegex = /(?:!\[([^\]]*)\]|\[([^\]]*)\])\(http:\/\/localhost:8001\/api\/open-path\?path=([^)\s]+)\)/g;
            let match;
            let targetLink = null;
            let matchStart = -1;
            let matchEnd = -1;

            while ((match = linkRegex.exec(lineText)) !== null) {
                const startCh = match.index;
                const endCh = match.index + match[0].length;
                if (cursor.ch >= startCh && cursor.ch <= endCh) {
                    targetLink = match[0];
                    matchStart = startCh;
                    matchEnd = endCh;
                    break;
                }
            }

            if (!targetLink) {
                const allMatches = Array.from(lineText.matchAll(linkRegex));
                if (allMatches.length === 1) {
                    targetLink = allMatches[0][0];
                    matchStart = allMatches[0].index;
                    matchEnd = allMatches[0].index + allMatches[0][0].length;
                }
            }

            if (targetLink) {
                const sourcePath = extractOpenPathFromLink(targetLink);
                if (sourcePath) {
                    menu.addItem((item) => {
                        item
                            .setTitle("コピーして同一フォルダーに保存")
                            .setIcon("folder-input")
                            .onClick(async () => {
                                const res = await executeCopyAndConvertLink({
                                    sourceFilePath: sourcePath,
                                    originalLinkText: targetLink
                                });
                                if (res?.success && res.newLink) {
                                    editor.replaceRange(res.newLink, { line: cursor.line, ch: matchStart }, { line: cursor.line, ch: matchEnd });
                                }
                            });
                    });
                }
            }
            // カーソル位置の内部リンク（[[...]] や ![[...]]）を検知し、「添付ファイルを削除」メニューを追加
            const internalLinkRegex = /!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
            let internalMatch;
            let targetInternalFile = null;
            while ((internalMatch = internalLinkRegex.exec(lineText)) !== null) {
                const startCh = internalMatch.index;
                const endCh = internalMatch.index + internalMatch[0].length;
                if (cursor.ch >= startCh && cursor.ch <= endCh) {
                    const linkpath = internalMatch[1].trim().split("#")[0].split("|")[0];
                    let resolved = app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
                    if (!resolved && app.vault.adapter?.basePath) {
                        const sourceFolder = file.parent?.path || "";
                        const candidate = sourceFolder ? `${sourceFolder}/${linkpath}` : linkpath;
                        resolved = app.vault.getAbstractFileByPath(candidate);
                    }
                    if (resolved && resolved.path !== file.path && !isImageFile(resolved) && !isDrawioEditableFile(resolved) && !resolved.name.endsWith(".excalidraw.md")) {
                        targetInternalFile = resolved;
                    }
                    break;
                }
            }
            if (targetInternalFile) {
                menu.addItem((item) => {
                    item
                        .setTitle("添付ファイルを削除")
                        .setIcon("trash")
                        .setWarning(true)
                        .onClick(() => deleteAttachmentFile(targetInternalFile, file));
                });
            }
        } catch (e) {
            console.error("Failed to check open-path link in editor-menu:", e);
        }
    }

    if (file.extension === "md" && !file.name.endsWith(".excalidraw.md")) {
        menu.addItem((item) => {
            item
                .setTitle("フォルダを開く")
                .setIcon("folder")
                .onClick(() => openContainingFolder(file));
        });

        menu.addItem((item) => {
            item
                .setTitle("VS Codeで開く")
                .setIcon("code")
                .onClick(() => openInVsCode(file));
        });

        menu.addItem((item) => {
            item
                .setTitle("HTMLで出力(AIコンテキスト用)")
                .setIcon("html")
                .onClick(() => exportHtml(file, "ai"));
        });

        menu.addItem((item) => {
            item
                .setTitle("HTMLで出力(人間用)")
                .setIcon("layout-template")
                .onClick(() => exportHtml(file, "human"));
        });

        menu.addItem((item) => {
            item
                .setTitle("PDFで出力(人間用)")
                .setIcon("file-text")
                .onClick(() => exportPdf(file));
        });

        menu.addItem((item) => {
            item
                .setTitle("サマリーを作成")
                .setIcon("document")
                .onClick(() => createSummary(file));
        });

        reorderMenuItemsLater(menu, 50, { prepend: [
            "HTMLで出力(人間用)",
            "HTMLで出力(AIコンテキスト用)",
            "PDFで出力(人間用)",
            "サマリーを作成",
            "VS Codeで開く",
            "フォルダを開く",
            "コピーして同一フォルダーに保存",
            "添付ファイルを削除",
        ] });
    }
};

registerWorkspaceEvent("_customEditorMenuListener", "editor-menu", withNativeMenuReorder(handleEditorMenu));
console.log("Editor menu listener registered for Summary");
