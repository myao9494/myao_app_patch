// =============================================================================
// ノート内の画像・埋め込みのクリック操作（選択、ダブルクリック編集、右クリックメニュー）
// =============================================================================

// Setup Markdown image rename shortcut
const isTypingTarget = (el) => {
    return el && (
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.isContentEditable
    );
};

const getVaultRelativePath = (path) => {
    if (!path) return null;
    const normalizedPath = decodeURIComponent(path).replace(/\\/g, "/");
    const basePath = (app.vault.adapter.basePath || "").replace(/\\/g, "/").replace(/\/+$/g, "");

    if (basePath && normalizedPath.startsWith(`${basePath}/`)) {
        return normalizedPath.slice(basePath.length + 1);
    }
    return normalizedPath.replace(/^\/+/, "");
};

const getFileFromImageElement = (imgEl) => {
    const activeFile = app.workspace.getActiveFile();
    const embedEl = imgEl.closest(".internal-embed, .media-embed, .image-embed, span[src], div[src]");
    const candidates = [
        embedEl?.getAttribute("src"),
        embedEl?.getAttribute("alt"),
        imgEl.getAttribute("alt"),
        imgEl.getAttribute("aria-label"),
        imgEl.getAttribute("src"),
        imgEl.currentSrc,
    ].filter(Boolean);

    for (const candidate of candidates) {
        let value = candidate.trim();
        if (!value) continue;

        // クエリパラメータ（?17...等）を除去
        value = value.split("?")[0];

        if (value.startsWith("app://")) {
            try {
                value = decodeURIComponent(new URL(value).pathname);
            } catch (e) {
                value = decodeURIComponent(value.replace(/^app:\/\/[^/]+\/?/, ""));
            }
        }

        value = value
            .replace(/^!?\[\[/, "")
            .replace(/\]\]$/, "")
            .split("|")[0]
            .split("#")[0]
            .split("?")[0]
            .trim();

        const relativePath = getVaultRelativePath(value);
        const directFile = relativePath ? app.vault.getAbstractFileByPath(relativePath) : null;
        if (directFile?.path) return directFile;

        if (activeFile) {
            const linkedFile = app.metadataCache.getFirstLinkpathDest(value, activeFile.path);
            if (linkedFile?.path) return linkedFile;
        }
    }

    return null;
};

const getFileFromEmbedSource = (source, sourcePath) => {
    if (!source) return null;
    const linkpath = source
        .split("|")[0]
        .split("#")[0]
        .split("?")[0]
        .trim();
    if (!linkpath) return null;

    const relativePath = getVaultRelativePath(linkpath);
    const directFile = relativePath ? app.vault.getAbstractFileByPath(relativePath) : null;
    if (directFile?.path) return directFile;

    return app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath || "");
};

const getFileFromImageClickEvent = (e) => {
    const activeFile = app.workspace.getActiveFile();
    const captionEl = e.target?.closest?.(".custom-figure-caption");
    const figureTarget = captionEl?.closest?.("[data-figure-name]");
    const imgEl = e.target?.closest?.("img") || figureTarget?.querySelector?.("img");
    if (imgEl) {
        const imageFile = getFileFromImageElement(imgEl);
        if (imageFile?.path) return { file: imageFile, imgEl };
    }

    const embedEl = e.target?.closest?.(".internal-embed, .media-embed, .image-embed, span[src], div[src], .excalidraw-svg, .excalidraw-embedded-img, [filesource], [fileSource]");
    const embedSource = (typeof getFigureEmbedSource === "function" ? getFigureEmbedSource(embedEl, activeFile?.path || "") : null) || embedEl?.getAttribute?.("src") || "";
    const embedFile = getFileFromEmbedSource(embedSource, activeFile?.path || "");
    if (embedFile?.path) {
        return { file: embedFile, imgEl: imgEl || embedEl.querySelector?.("img") || null };
    }

    const imageViewEl = e.target?.closest?.(".image-view, .image-container, .workspace-leaf-content[data-type='image']");
    if (imageViewEl && activeFile?.path) {
        return { file: activeFile, imgEl: imgEl || imageViewEl.querySelector?.("img") || null };
    }

    return { file: null, imgEl: null };
};

let lastExcalidrawToggleTime = 0;

/**
 * 開いているMarkdownファイル自身と同名のExcalidraw埋め込み（excalidraw-plugin: parsed）であるかを判定する
 **/
const isSelfExcalidrawParsedEmbed = (file, activeFile) => {
    if (!file || !activeFile) return false;
    if (file.extension !== "md" || activeFile.extension !== "md") return false;
    if (file.path !== activeFile.path && file.basename !== activeFile.basename) return false;
    const frontmatter = app.metadataCache?.getFileCache?.(file)?.frontmatter;
    return Boolean(frontmatter && frontmatter["excalidraw-plugin"] === "parsed");
};

/**
 * Excalidrawビューへの切り替えを実行する
 * - すでにExcalidrawビューになっている場合は何もしない（Markdownに戻る誤作動を防止）
 * - Markdownビューの場合のみ、Excalidrawビューに確実に切り替える
 **/
const toggleExcalidrawView = (file, event) => {
    const activeFile = app.workspace.getActiveFile();
    if (!isSelfExcalidrawParsedEmbed(file, activeFile)) return false;

    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();

    const now = Date.now();
    if (now - lastExcalidrawToggleTime < 800) {
        return true;
    }
    lastExcalidrawToggleTime = now;

    if (document.activeElement && typeof document.activeElement.blur === "function") {
        document.activeElement.blur();
    }

    setTimeout(async () => {
        try {
            const activeLeaf = app.workspace.activeLeaf || (typeof app.workspace.getLeaf === "function" ? app.workspace.getLeaf(false) : null);
            const viewType = activeLeaf?.view?.getViewType?.() || "";
            
            // すでに Excalidraw ビューになっている場合はトグル（戻り）させない
            if (viewType === "excalidraw") {
                return;
            }

            const excalidrawPlugin = app.plugins?.plugins?.["obsidian-excalidraw-plugin"];
            if (activeLeaf && excalidrawPlugin && typeof activeLeaf.setViewState === "function") {
                if (typeof activeLeaf.view?.save === "function") {
                    await activeLeaf.view.save();
                }
                if (excalidrawPlugin.excalidrawFileModes) {
                    excalidrawPlugin.excalidrawFileModes[activeLeaf.id || file.path] = "excalidraw";
                    excalidrawPlugin.excalidrawFileModes[file.path] = "excalidraw";
                }
                await activeLeaf.setViewState({
                    type: "excalidraw",
                    state: activeLeaf.view?.getState?.() || { file: file.path },
                    popstate: true
                });
            } else {
                if (!viewType || viewType === "markdown") {
                    app.commands?.executeCommandById?.("obsidian-excalidraw-plugin:toggle-excalidraw-view");
                }
            }
        } catch (error) {
            console.error("Failed to switch to Excalidraw view:", error);
            app.commands?.executeCommandById?.("obsidian-excalidraw-plugin:toggle-excalidraw-view");
        }
    }, 50);

    return true;
};

const editDrawioFile = (file, event) => {
    if (!isDrawioEditableFile(file)) return false;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();
    
    // 現在のフォーカスを解除して、イベントの干渉を防ぐ
    if (document.activeElement && typeof document.activeElement.blur === "function") {
        document.activeElement.blur();
    }

    // 非同期でエディタを起動し、イベントループ完了後にフォーカスが新しいタブに正しく移るようにする
    setTimeout(() => {
        app.workspace.trigger("drawio:edit-diagram", file);
    }, 50);

    return true;
};

const handleMarkdownImageClick = (e) => {
    const markdownEl = e.target?.closest?.(".markdown-preview-view, .markdown-source-view, .cm-content");
    const imageViewEl = e.target?.closest?.(".image-view, .image-container, .workspace-leaf-content[data-type='image']");
    if (!markdownEl && !imageViewEl) return;

    const { file, imgEl } = getFileFromImageClickEvent(e);
    const activeFile = app.workspace.getActiveFile();

    // ダブルクリック時（e.detail >= 2）の Obsidian リンクオープンをブロック
    if (e.detail >= 2 && file && isSelfExcalidrawParsedEmbed(file, activeFile)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
    }

    if (!imgEl) {
        if (window._selectedMarkdownImageEl) {
            window._selectedMarkdownImageEl.classList.remove("custom-selected-markdown-image");
        }
        window._selectedMarkdownImageEl = null;
        window._selectedMarkdownImageFilePath = null;
        return;
    }

    if (!file) return;

    if (window._selectedMarkdownImageEl) {
        window._selectedMarkdownImageEl.classList.remove("custom-selected-markdown-image");
    }
    window._selectedMarkdownImageEl = imgEl;
    window._selectedMarkdownImageFilePath = file.path;
    imgEl.classList.add("custom-selected-markdown-image");
    imgEl.setAttribute("tabindex", "-1");
    try {
        imgEl.focus();
    } catch {}
};

/**
 * 画像・埋め込みダブルクリックハンドラー
 * - Markdown内の自身と同名のExcalidraw埋め込み（parsed）であればExcalidrawビューへ切り替える
 * - Markdown内の画像をダブルクリックした際に、Draw.ioファイルであればエディタを開く
 **/
const handleMarkdownImageDblClick = (e) => {
    const markdownEl = e.target?.closest?.(".markdown-preview-view, .markdown-source-view, .cm-content");
    const imageViewEl = e.target?.closest?.(".image-view, .image-container, .workspace-leaf-content[data-type='image']");
    if (!markdownEl && !imageViewEl) return;

    const { file } = getFileFromImageClickEvent(e);
    if (toggleExcalidrawView(file, e)) return;
    if (editDrawioFile(file, e)) return;
};

/**
 * 画像・埋め込みマウスダウンハンドラー (ダブルクリック挙動の制御用)
 * - Markdown内のDraw.io画像やExcalidraw埋め込みがダブルクリック（e.detail >= 2）された際、
 *   Obsidianデフォルトの「ファイルを新しいタブで開く」等の動作を防ぐため、イベントをブロックする。
 **/
const handleMarkdownImageMouseDown = (e) => {
    const markdownEl = e.target?.closest?.(".markdown-preview-view, .markdown-source-view, .cm-content");
    const imageViewEl = e.target?.closest?.(".image-view, .image-container, .workspace-leaf-content[data-type='image']");
    if (e.detail < 2) return;
    if (!markdownEl && !imageViewEl) return;

    const { file } = getFileFromImageClickEvent(e);
    const activeFile = app.workspace.getActiveFile();
    if (file && (isDrawioEditableFile(file) || isSelfExcalidrawParsedEmbed(file, activeFile))) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
    }
};

/**
 * 画像コンテキストメニューハンドラー
 * - マークダウンプレビュー中の画像右クリックに対応
 * - 画像ファイルそのものを開いているプレビュー画面（ImageView）の右クリックにも対応
 * - 独自の「共通画像フォルダへ移動」等のカスタムメニューを表示
 **/
const handleMarkdownImageContextMenu = (e) => {
    const activeFile = app.workspace.getActiveFile();
    const isActiveImage = activeFile && isImageFile(activeFile);
    
    // 画像ビュー（画像プレビュー画面）での右クリックか判定
    const imageViewEl = e.target?.closest?.(".image-view, .image-container, .workspace-leaf-content[data-type='image']");

    let file = null;
    let imgEl = e.target?.closest?.("img");
    const embedEl = e.target?.closest?.(".internal-embed, span[src], div[src]");
    const embedSource = embedEl?.getAttribute?.("src") || "";
    const isExcalidrawEmbed = /\.excalidraw(?:\.md)?(?:[#|].*)?$/i.test(embedSource);

    if (imageViewEl || (isActiveImage && (e.target?.tagName === "IMG" || e.target?.closest?.(".image-view") || e.target?.closest?.(".workspace-leaf-content")))) {
        // 画像ビュー内での右クリックの場合はアクティブファイルを使用
        file = activeFile;
        if (!imgEl) {
            imgEl = imageViewEl?.querySelector("img") || document.querySelector(".workspace-leaf.mod-active img");
        }
    } else {
        // マークダウン表示中などの処理
        if (!imgEl && !isExcalidrawEmbed) return;
        const markdownEl = e.target?.closest?.(".markdown-preview-view, .markdown-source-view, .cm-content");
        if (!markdownEl) return;
        if (imgEl) {
            file = getFileFromImageElement(imgEl);
        }
        if (!file && isExcalidrawEmbed) {
            file = app.metadataCache.getFirstLinkpathDest(embedSource.split("|")[0].split("#")[0], activeFile?.path || "");
        }
    }

    if (!isImageFile(file) && !isDrawioEditableFile(file) && !isExcalidrawBackedMarkdown(file)) return;

    if (imgEl) {
        if (window._selectedMarkdownImageEl) {
            window._selectedMarkdownImageEl.classList.remove("custom-selected-markdown-image");
        }
        window._selectedMarkdownImageEl = imgEl;
        window._selectedMarkdownImageFilePath = file.path;
        imgEl.classList.add("custom-selected-markdown-image");
    }

    const MenuClass = tp?.obsidian?.Menu || window?.obsidian?.Menu || (typeof Menu !== "undefined" ? Menu : null);
    if (!MenuClass) return;

    e.preventDefault();
    e.stopPropagation();
    // Excalidrawプラグイン側の右クリック編集ハンドラーを実行させない。
    // 編集操作はプラグイン標準のダブルクリックに任せる。
    if (isExcalidrawBackedMarkdown(file)) {
        e.stopImmediatePropagation();
    }

    const menu = new MenuClass();
    // ノート内からの操作では、添付ファイル削除時にこのノートの埋め込み記法も消す。
    const sourceFile = activeFile?.extension === "md" ? activeFile : null;
    addClipboardImageMenuItems(menu, file, sourceFile);

    // メニュー項目を最上部へ prepend して並び替え
    reorderMenuItemsLater(menu, 50, { prepend: [
        "クリップボードの画像と差し替え",
        "クリップボードの画像との比較",
        "共通画像フォルダへ移動",
        "画像の容量を縮小",
        "drawioで編集",
        "Excalidrawに変換",
        "Webアプリで編集",
        "画像をクリップボードにコピー",
    ] });

    flushNativeMenuReorders(menu);
    menu.showAtMouseEvent(e);
};

// 画像以外（PDF、Office文書、音声、あるいは同一フォルダ保存された別Markdown等）のノート内埋め込み・通常リンクにも削除メニューを追加する。
const handleMarkdownAttachmentContextMenu = (e) => {
    // 画像は上の専用メニューで処理する。
    if (e.target?.closest?.("img")) return;

    const markdownEl = e.target?.closest?.(".markdown-preview-view, .markdown-source-view, .cm-content");
    // Reading view と Live Preview の両方で埋め込み要素および内部リンク要素を拾う。
    const targetEl = e.target?.closest?.(".internal-embed, .cm-embed-block, [data-path], a.internal-link, .cm-hmd-internal-link, [data-href]");
    const sourceFile = app.workspace.getActiveFile();
    if (!markdownEl || !targetEl || sourceFile?.extension !== "md") return;

    const linkSource = targetEl.getAttribute("src") ||
        targetEl.dataset?.src ||
        targetEl.dataset?.path ||
        targetEl.getAttribute("data-href") ||
        targetEl.dataset?.href ||
        targetEl.getAttribute("href") ||
        targetEl.textContent || "";

    const linkpath = String(linkSource).split("|")[0].split("#")[0].trim().replace(/^\.\//, "");
    if (!linkpath) return;

    let file = app.metadataCache.getFirstLinkpathDest(linkpath, sourceFile.path);
    if (!file && app.vault.adapter?.basePath) {
        const sourceFolder = sourceFile.parent?.path || "";
        const candidate = sourceFolder ? `${sourceFolder}/${linkpath}` : linkpath;
        file = app.vault.getAbstractFileByPath(candidate);
    }
    if (!file || file.path === sourceFile.path) return;
    if (isImageFile(file) || isDrawioEditableFile(file)) return;
    if (file.name.toLowerCase().endsWith(".excalidraw.md")) return;

    const MenuClass = tp?.obsidian?.Menu || window?.obsidian?.Menu || (typeof Menu !== "undefined" ? Menu : null);
    if (!MenuClass) return;

    e.preventDefault();
    e.stopPropagation();
    const menu = new MenuClass();
    menu.addItem((item) => {
        item
            .setTitle("添付ファイルを削除")
            .setIcon("trash")
            .setWarning(true)
            .onClick(() => deleteAttachmentFile(file, sourceFile));
    });
    flushNativeMenuReorders(menu);
    menu.showAtMouseEvent(e);
};

const MARKDOWN_VIEW_SELECTOR = ".markdown-preview-view, .markdown-source-view";
const EXCALIDRAW_VIEW_SELECTOR = ".workspace-leaf-content[data-type='excalidraw']";
const FIGURE_EMBED_CONTAINER_SELECTOR = ".internal-embed, .media-embed, .image-embed, .markdown-embed, .excalidraw-svg";

// 押された図の埋め込みを、Markdownの本文の中だけで探す。
// 本文より外側（body など）や本文全体で子要素を探すと、別のタブや同じノートの別の場所にある
// 埋め込みまで拾ってしまい、Excalidraw の描画画面で図形を描くためのクリックまで止めてしまう。
const getExcalidrawFileFromPointerEvent = (e) => {
    const activeFile = app.workspace.getActiveFile();
    const path = (typeof e.composedPath === "function" ? e.composedPath() : [e.target])
        .filter(node => node && node.nodeType === Node.ELEMENT_NODE);
    if (path.some(element => element.matches?.(EXCALIDRAW_VIEW_SELECTOR))) return null;
    const markdownViewIndex = path.findIndex(element => element.matches?.(MARKDOWN_VIEW_SELECTOR));
    if (markdownViewIndex < 0) return null;
    const elements = path.slice(0, markdownViewIndex);

    for (const element of elements) {
        if (element.matches?.("img")) {
            const imageFile = getFileFromImageElement(element);
            if (imageFile && (imageFile.name?.toLowerCase().endsWith(".excalidraw.md") || isExcalidrawBackedMarkdown(imageFile))) {
                return imageFile;
            }
        }

        const source = element.getAttribute?.("src")
            || element.dataset?.src
            || (typeof getFigureEmbedSource === "function" && element.matches?.(FIGURE_EMBED_CONTAINER_SELECTOR)
                ? getFigureEmbedSource(element, activeFile?.path || "")
                : "");
        if (!source) continue;
        const linkpath = String(source).split("|")[0].split("#")[0];
        const file = app.metadataCache.getFirstLinkpathDest(linkpath, activeFile?.path || "");
        if (file && (file.name?.toLowerCase().endsWith(".excalidraw.md") || isExcalidrawBackedMarkdown(file))) {
            return file;
        }
    }
    return null;
};

// Excalidraw埋め込みに対するpointerdownイベントのインターセプト
// - 右ボタン（e.button === 2）: 編集開始を防ぎコンテキストメニューを正常表示
// - 左ボタン（e.button === 0）: 自身と同名の埋め込みの場合、Excalidrawプラグイン内部の
//   ロングプレス/ダブルクリックタイマー（openDrawing）が動いてMarkdownで開き直されるのを防ぐ
const blockExcalidrawPointerDown = (e) => {
    // リサイズハンドル上の操作は一切遮断しない
    if (e.target?.closest?.(".custom-image-resizer-handle")) return;

    const file = getExcalidrawFileFromPointerEvent(e);
    if (!file) return;

    if (e.button === 2) {
        e.stopImmediatePropagation();
        return;
    }

    const activeFile = app.workspace.getActiveFile();
    if (e.button === 0 && isSelfExcalidrawParsedEmbed(file, activeFile)) {
        e.stopPropagation();
        e.stopImmediatePropagation();
    }
};

const blockExcalidrawRightButtonEdit = (e) => {
    if (e.button !== 2 || !getExcalidrawFileFromPointerEvent(e)) return;
    e.stopImmediatePropagation();
};
