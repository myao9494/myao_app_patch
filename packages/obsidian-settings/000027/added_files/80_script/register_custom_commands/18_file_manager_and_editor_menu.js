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
        const name = item.name || filePath.split(/[\\/]/).filter(Boolean).pop() || "link";
        // リンク先はパスそのもの（file:///）。クリックするとファイルマネージャーで開く（下の installFileUrlOpenPatch）
        const linkUrl = localPathToFileUrl(filePath) || buildOpenPathUrl(filePath);
        return `[${escapeMarkdownLinkText(name)}](${escapeMarkdownLinkUrl(linkUrl)})`;
    };

    if (items.length === 1) {
        return formatItem(items[0]);
    }

    return items.map(item => `- ${formatItem(item)}`).join("\n");
};

// open-path のリンクの URL 部分。古いリンクには半角括弧がエンコードされずに残っているので、対応の取れた括弧は URL に含める
const OPEN_PATH_URL_BODY = String.raw`(?:[^()\s]|\([^()\s]*\))+`;
// Markdown リンクの表示名。エスケープした角括弧（\[ \]）を含められる
const MARKDOWN_LINK_TEXT = String.raw`\[(?:\\.|[^\]\\])*\]`;

/**
 * 1行のテキストから、ファイルのリンク（file:/// と、以前の形のファイルマネージャーのリンク open-path）を探す
 * @param {string} lineText - 行のテキスト
 * @returns {RegExpMatchArray[]} 見つかったリンク
 **/
const findOpenPathLinks = (lineText) => Array.from(lineText.matchAll(
    new RegExp(`!?${MARKDOWN_LINK_TEXT}\\((?:http://localhost:8001/api/open-path\\?path=|file:)${OPEN_PATH_URL_BODY}\\)`, "gi")
));

/**
 * MarkdownリンクまたはURL文字列から、リンク先のファイルパスを抽出する（file:/// と open-path）
 * @param {string} linkTextOrUrl - リンク文字列またはURL
 * @returns {string|null} デコードされたファイルパス、またはnull
 **/
const extractOpenPathFromLink = (linkTextOrUrl) => {
    if (!linkTextOrUrl || typeof linkTextOrUrl !== "string") return null;

    // Markdownリンク [name](url) からurlを抽出
    const mdMatch = linkTextOrUrl.match(new RegExp(`${MARKDOWN_LINK_TEXT}\\(((?:https?://|file:)${OPEN_PATH_URL_BODY})\\)`, "i"));
    const urlStr = mdMatch ? mdMatch[1] : linkTextOrUrl;
    if (/^file:/i.test(urlStr.trim())) return fileUrlToLocalPath(urlStr);

    try {
        const url = new URL(urlStr);
        if (url.pathname === "/api/open-path" && url.searchParams.has("path")) {
            // searchParams がデコード済みなので、もう一度デコードしない（名前の % が壊れる）
            return url.searchParams.get("path");
        }
    } catch (e) {
        // URLパース失敗時の正規表現フォールバック
    }

    const paramMatch = urlStr.match(/[?&]path=([^&\s)]+)/);
    if (paramMatch) {
        return decodeUriSafely(paramMatch[1]);
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
            const allMatches = findOpenPathLinks(lineText);
            let targetLink = null;
            let matchStart = -1;
            let matchEnd = -1;

            for (const match of allMatches) {
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

/**
 * 外部リンク（http / https）の右クリックメニューに「chrome で開く」を追加する。
 * url-menu は閲覧モードと編集モード（ライブプレビュー）のどちらの外部リンクでも発火する。
 * ファイルマネージャーのリンク（open-path）は、開くとファイルを開く操作になるので対象外。
 **/
const handleUrlMenu = (menu, url) => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) return;
    if (/^https?:\/\/localhost:8001\/api\/open-path(?:[?#]|$)/i.test(url.trim())) return;

    menu.addItem((item) => {
        item
            .setTitle("chrome で開く")
            .setIcon("globe")
            .onClick(() => openUrlInChrome(url));
    });
};

registerWorkspaceEvent("_customUrlMenuListener", "url-menu", handleUrlMenu);

/**
 * file: の URL を、このパソコンで開くパスにする。file: でなければ null。
 * Mac では、別の Mac で作ったリンク（/Users/<別のユーザー>/…）も開けるよう、ユーザー名を今のユーザーに置き換える。
 **/
const fileUrlToPathForThisComputer = (url, { platform, username } = {}) => {
    const localPath = fileUrlToLocalPath(url);
    if (!localPath) return null;
    const currentPlatform = platform ?? (typeof process !== "undefined" ? process.platform : "");
    let currentUsername = username;
    if (currentUsername === undefined && currentPlatform === "darwin") {
        try {
            currentUsername = require("os").userInfo().username;
        } catch (e) {
            currentUsername = "";
        }
    }
    return currentPlatform === "darwin" && currentUsername
        ? localPath.replace(/^\/Users\/(?!Shared(?:\/|$))[^/]+(?=\/|$)/, `/Users/${currentUsername}`)
        : localPath;
};

/**
 * file: の URL を、ファイルマネージャー（localhost:8001）でそのパスを開く URL にする。file: でなければ null。
 **/
const fileUrlToOpenPathUrl = (url, options = {}) => {
    const localPath = fileUrlToPathForThisComputer(url, options);
    return localPath ? buildOpenPathUrl(localPath) : null;
};

/**
 * ファイルマネージャー（localhost:8001）に、パスがファイルかフォルダか見つからないかを聞く（GET /api/path-info）。
 * "file" / "directory" / "not_found" を返す。聞けなければ（起動していない、応答しない、エラー）null。
 * ブラウザの fetch はファイルマネージャーの CORS で止まるため、Obsidian の requestUrl を使う。
 * 応答が遅いネットワークのパスは、ファイルマネージャーの設定（apiTimeout。既定10秒）で 504 になり、null になる。
 **/
const askFileManagerPathType = async (localPath, requestUrlFn = getObsidianModule()?.requestUrl) => {
    if (typeof requestUrlFn !== "function") return null;
    try {
        const response = await requestUrlFn({
            url: `http://localhost:8001/api/path-info?path=${encodeURIComponent(localPath)}`,
            throw: false,
        });
        if (response?.status !== 200) return null;
        const type = response.json?.type;
        return ["file", "directory", "not_found"].includes(type) ? type : null;
    } catch (e) {
        return null;
    }
};

/**
 * パスを既定の方法で開く（ファイルは関連付けられたアプリ、フォルダは Explorer / Finder。Electron の shell.openPath）。
 * 開けたら空文字、開けなければ理由を返す。
 **/
const openPathWithSystemDefault = async (localPath) => {
    let electron = null;
    try { electron = require("electron"); } catch (e) {
        try { electron = window.require ? window.require("electron") : null; } catch (err) {}
    }
    if (!electron?.shell?.openPath) return "Electron の shell.openPath を使えません";
    try {
        return await electron.shell.openPath(localPath);
    } catch (e) {
        return e?.message || String(e);
    }
};

/**
 * file: のリンクのパスを開く。
 * 1. ファイルマネージャーがそのパスをファイルかフォルダとして見つけられれば、今までどおりファイルマネージャーで開く。
 * 2. 見つけられない、ファイルマネージャーが動いていない・応答しないときは、既定の方法で開く
 *    （Windows のネットワークのパス、SharePoint の \\host@80\… など、ファイルマネージャーから見えないパスのため）。
 * 3. どちらでも開けなければ、パスと理由を通知する。
 * 返り値（どの方法で開いたか）: "file-manager" / "system-default" / "failed"
 **/
const openFileLinkPath = async (localPath, {
    openUrl,
    askPathType = askFileManagerPathType,
    openDefault = openPathWithSystemDefault,
    notify = (message) => new Notice(message, 10000),
} = {}) => {
    const type = await askPathType(localPath);
    if (type === "file" || type === "directory") {
        openUrl(buildOpenPathUrl(localPath));
        return "file-manager";
    }
    const error = await openDefault(localPath);
    if (!error) return "system-default";
    console.warn("[file link] 開けませんでした", { path: localPath, fileManager: type, error });
    notify(`開けませんでした:\n${localPath}\n${error}`);
    return "failed";
};

/**
 * ノートの file:/// のリンクをクリックしたら、openFileLinkPath で開く。
 * Obsidian は外部リンクのクリック（閲覧モード、ライブプレビュー）を window.open に渡し、file: なら自分でファイルを開く。
 * その手前で受け取る。テンプレートを読み直したときは、前回の差し替えを外してから付け直す。
 **/
const installFileUrlOpenPatch = () => {
    if (typeof window === "undefined") return;
    const previous = window._customFileUrlOpenPatch;
    if (previous && window.open === previous.patched) window.open = previous.original;
    const original = window.open;
    const patched = function (url, ...rest) {
        const href = typeof URL !== "undefined" && url instanceof URL ? url.href : url;
        const localPath = typeof href === "string" ? fileUrlToPathForThisComputer(href) : null;
        if (!localPath) return original.call(this, url, ...rest);
        void openFileLinkPath(localPath, { openUrl: (openPathUrl) => original.call(window, openPathUrl, ...rest) });
        return null;
    };
    window.open = patched;
    window._customFileUrlOpenPatch = { original, patched };
};

installFileUrlOpenPatch();

/**
 * 1行のテキストの中で、ch（行頭からの文字数）の位置にある file: のリンク（[名前](file:…)）の URL を返す。無ければ null。
 **/
const findFileLinkUrlAt = (lineText, ch) => {
    const pattern = new RegExp(`!?${MARKDOWN_LINK_TEXT}\\((file:${OPEN_PATH_URL_BODY})\\)`, "gi");
    for (const match of lineText.matchAll(pattern)) {
        if (ch >= match.index && ch <= match.index + match[0].length) return match[1];
    }
    return null;
};

/**
 * 編集画面（ライブプレビュー、ソースモード）でクリックした file: のリンクの URL を返す。リンクでなければ null。
 * Obsidian と同じく、ソースモードは Ctrl / Cmd を押したときだけ、ライブプレビューは Alt / Shift だけを押したときは開かない。
 **/
const findClickedEditorFileLinkUrl = (e) => {
    const target = e.target;
    if (!target?.closest?.(".cm-content") || !target.closest(".cm-underline, .cm-link, .cm-url")) return null;
    const view = app.workspace.getLeavesOfType("markdown")
        .map((leaf) => leaf.view)
        .find((markdownView) => markdownView?.contentEl?.contains(target));
    const cm = view?.editor?.cm;
    if (!cm?.posAtCoords) return null;

    const withMod = e.metaKey || e.ctrlKey;
    const isSourceMode = view.getState?.()?.source === true;
    if (isSourceMode && !withMod) return null;
    if (!isSourceMode && !withMod && (e.altKey || e.shiftKey)) return null;
    const selection = window.getSelection?.();
    if (selection && !selection.isCollapsed) return null;

    const offset = cm.posAtCoords({ x: e.clientX, y: e.clientY });
    if (offset === null || offset === undefined) return null;
    const line = cm.state.doc.lineAt(offset);
    return findFileLinkUrlAt(line.text, offset - line.from);
};

/**
 * file: のリンクのクリックを、Obsidian が処理する前に受け取って openFileLinkPath で開く。
 * Obsidian は開く前に new URL() でリンクを確かめ、URL として読めなければ「開けません」と通知して window.open を呼ばない。
 * Windows の Chromium は file:////host/… のホスト名を確かめるため、SharePoint の \\host@80\… のように @ を含むホスト名は
 * そこで止まり、window.open の差し替え（installFileUrlOpenPatch）まで届かない。そのため、クリックをキャプチャで先に受け取る。
 * 閲覧モード（a.external-link）と編集画面（ライブプレビュー、ソースモード）の左クリックが対象。
 * 中クリックや「リンクを開く」コマンドは、従来どおり window.open の差し替えで受け取る。
 **/
const handleFileLinkClick = (e) => {
    if (e.button !== 0 || e.defaultPrevented) return;
    const anchor = e.target?.closest?.("a.external-link[href]");
    const anchorHref = anchor?.getAttribute("href") || "";
    const url = /^file:/i.test(anchorHref) ? anchorHref : (anchor ? null : findClickedEditorFileLinkUrl(e));
    const localPath = url ? fileUrlToPathForThisComputer(url) : null;
    if (!localPath) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    void openFileLinkPath(localPath, { openUrl: (openPathUrl) => window.open(openPathUrl, "") });
};

registerDocumentListener("_customFileLinkClickListener", "click", handleFileLinkClick);
console.log("Editor menu listener registered for Summary");
