<%*
/**
 * カスタムコマンドおよびグローバルイベントハンドラーを登録するスクリプト
 * - From Clipboard: クリップボードの内容をMarkdownへ変換（表変換、コードブロック化、リンク貼り付け）
 *   ※URL/パスの貼り付け時には、tp.system.promptにより表示テキストの編集を促します。
 * - Bases画像カードの右クリックカスタマイズ: data_cards.base ビュー内の画像カード右クリック時に、「Obsidian URLをコピー」のみを表示してコピーできるようにします。
 * - 画像の右クリックメニューに「削除」を追加: 画像ファイルを右クリックした際に、確認ダイアログを経てシステムゴミ箱へ移動できるようにします。
 * - 画像の右クリックメニューに「drawioで編集」を追加: drawio関連の画像ファイル名の場合に、コンテキストメニューから直接編集ビューを開けるようにします。
 * - Excalidraw埋め込みダブルクリックでビュー切り替え: ノート自身と同名のExcalidraw埋め込み（excalidraw-plugin: parsed）をダブルクリックした際に、Excalidrawビューへ切り替えます。
 * - MarkMindアクティブ時のDeleteキー制御: マインドマップ操作中にDeleteキーを押してもノート削除を実行せず、MarkMind内部のノード削除処理へ渡します。
 * - MarkMind表示時のExcalidrawセクション除外と保護: Excalidrawデータを持つノートをマインドマップ表示する際、描画時にExcalidrawの内部データを除外し、保存時には元のExcalidrawデータを安全に維持・復元します。
 * - 左右両サイドバーの表示非表示トグル (Option + B): 左右両方のサイドバーをOption+B (Win/Linux: Alt+B) で一括開閉し、エディタやサイドバーなどアクティブな状態を問わず確実に画面を最大化・復元します。
 * - ファイルマネージャー連携（ドラッグ＆ドロップと同一フォルダ保存）: ファイルマネージャーWebアプリからのドロップを検知し、localhost:8001 の open-path リンクを自動生成します。また、リンク右クリックから「コピーして同一フォルダーに保存」を実行すると、リンク先のファイルを現在開いているノートと同じフォルダーにコピーし、リンクをObsidianリンクへ自動変換します。
 * - サマリー作成時のOutlookメール（MSG）クリーン展開: Outlook特有のOfficeメタデータや条件付きコメント（<!--[if ...]>、<xml>、<o:p>等）を完全除去し、文字化けや「< >」タグの露出を防ぎます。また、画像なしメールでは整ったプレーンテキスト本文を優先します。
 */
const getEncodedExcalidrawUrl = (file) => {
    const basePath = app.vault.adapter.basePath || "";
    const fullPath = `${basePath}/${file.path}`.replace(/\\/g, "/");
    const encodedPath = fullPath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
    return `http://localhost:3001/?filepath=${encodedPath}`;
};

// 通常の .md ファイルでも、Excalidraw の裏面データを持つファイルを判定する。
// Excalidraw プラグインの判定を優先し、メタデータキャッシュがまだ更新されていない場合は
// フロントマターを直接確認する。
const isExcalidrawBackedMarkdown = (file) => {
    if (!file || file.extension !== "md") return false;

    if (file.name.toLowerCase().endsWith(".excalidraw.md")) return true;

    const excalidrawPlugin = app.plugins?.plugins?.["obsidian-excalidraw-plugin"];
    try {
        if (typeof excalidrawPlugin?.isExcalidrawFile === "function" && excalidrawPlugin.isExcalidrawFile(file)) {
            return true;
        }
    } catch (error) {
        console.warn("Failed to detect Excalidraw-backed Markdown:", error);
    }

    const frontmatter = app.metadataCache?.getFileCache?.(file)?.frontmatter;
    return Boolean(frontmatter && Object.prototype.hasOwnProperty.call(frontmatter, "excalidraw-plugin"));
};

const toFileUrl = (absolutePath) => {
    let normalized = absolutePath.replace(/\\/g, "/");
    if (!normalized.startsWith("/")) {
        normalized = "/" + normalized;
    }
    return `file://${normalized}`;
};

const IMAGE_DIFF_API_BASE_URL = "http://127.0.0.1:8078/api";
const IMAGE_DIFF_APP_BASE_URL = "http://127.0.0.1:8078/";
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "tif", "tiff"]);

const getAbsoluteVaultPath = (file) => {
    const basePath = app.vault.adapter.basePath || "";
    return `${basePath}/${file.path}`.replace(/\\/g, "/").replace(/\/+/g, "/");
};

const openMarkdownDiff = async (file) => {
    if (!file?.path || file.extension !== "md" || file.name.endsWith(".excalidraw.md")) return;
    try {
        const markdownPath = getAbsoluteVaultPath(file);
        let response = await fetch(`${IMAGE_DIFF_API_BASE_URL}/git/markdown`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ markdown_path: markdownPath }),
        });
        // 旧BackendがGET版だけを公開している場合も、ノートから起動できるようにする。
        if (response.status === 405) {
            response = await fetch(`${IMAGE_DIFF_API_BASE_URL}/git/markdown?path=${encodeURIComponent(markdownPath)}`);
        }
        if (!response.ok) {
            throw new Error(await getApiErrorMessage(response));
        }
        const body = await response.json();
        const diffUrl = body.diff_url || `${IMAGE_DIFF_APP_BASE_URL}?markdown_path=${encodeURIComponent(markdownPath)}`;
        window.open(diffUrl, "_blank");
    } catch (error) {
        console.error("Failed to open Markdown diff:", error);
        new Notice(`差分表示を開けませんでした: ${error.message}`);
    }
};

const isImageFile = (file) => file?.extension && IMAGE_EXTENSIONS.has(file.extension.toLowerCase());
const isDrawioEditableFile = (file) => {
    const name = file?.name?.toLowerCase() || "";
    return name.endsWith(".drawio.svg") || name.endsWith(".dio.svg") || name.endsWith(".drawio");
};

const FIGURE_EMBED_EXTENSIONS = /\.(?:png|jpe?g|gif|bmp|svg|webp|avif|tiff?|ico|excalidraw(?:\.md)?|drawio(?:\.svg)?|dio(?:\.svg)?)(?:[|#].*)?$/i;

const cleanFigureEmbedSource = (source) => String(source || "").split("|")[0].split("#")[0].trim();

const getExcalidrawBackedFileFromSource = (source, sourcePath = "") => {
    const cleanSource = cleanFigureEmbedSource(source);
    if (!cleanSource) return null;

    const linkCandidates = Array.from(new Set([
        cleanSource,
        cleanSource.replace(/\.md$/i, ""),
    ].filter(Boolean)));
    for (const candidate of linkCandidates) {
        try {
            const file = app.metadataCache?.getFirstLinkpathDest?.(candidate, sourcePath || "");
            if (file && isExcalidrawBackedMarkdown(file)) return file;
        } catch {
            // 解決できないリンクは、通常の画像・リンクとして扱う。
        }
    }
    return null;
};

const isFigureEmbedSource = (source, sourcePath = "") => {
    const cleanSource = cleanFigureEmbedSource(source);
    return FIGURE_EMBED_EXTENSIONS.test(cleanSource)
        || Boolean(getExcalidrawBackedFileFromSource(cleanSource, sourcePath));
};

const isExcalidrawEmbedSource = (source, sourcePath = "") => {
    const cleanSource = cleanFigureEmbedSource(source);
    return /\.excalidraw(?:\.md)?$/i.test(cleanSource)
        || Boolean(getExcalidrawBackedFileFromSource(cleanSource, sourcePath));
};

const getFigureEmbedDisplayName = (source, sourcePath = "") => {
    const resolvedFile = getExcalidrawBackedFileFromSource(source, sourcePath);
    let value = cleanFigureEmbedSource(source);
    if (resolvedFile?.name) {
        value = resolvedFile.name;
    }
    try {
        value = decodeURIComponent(value);
    } catch {
        // URIエンコードされていないVaultパスは、そのまま扱う。
    }

    const fileName = value.replace(/\\/g, "/").split("/").pop() || value;
    return fileName.replace(
        /\.(?:excalidraw\.md|excalidraw|drawio\.svg|dio\.svg|drawio|dio|png|jpe?g|gif|bmp|svg|webp|avif|tiff?|ico|md)$/i,
        "",
    );
};

const getFigureEmbedSourcePath = (element) => {
    const markdownLeaves = app.workspace.getLeavesOfType?.("markdown") || [];
    const ownerView = markdownLeaves
        .map((leaf) => leaf?.view)
        .find((view) => view?.containerEl?.contains?.(element));
    return ownerView?.file?.path || app.workspace.getActiveFile?.()?.path || "";
};

const getFigureEmbedSource = (element, sourcePath = getFigureEmbedSourcePath(element)) => {
    if (!element) return "";
    for (const attribute of ["src", "fileSource", "data-excalidraw-source", "data-src", "data-path"]) {
        const value = element.getAttribute?.(attribute);
        if (value && isFigureEmbedSource(value, sourcePath)) return value;
    }
    // Reading viewのExcalidrawは外枠からsrcが消えるため、生成画像のfileSourceを参照する。
    const sourceElement = element.querySelector?.("[filesource], [fileSource]");
    if (sourceElement && sourceElement !== element) {
        for (const attribute of ["fileSource", "src", "data-src", "data-path"]) {
            const value = sourceElement.getAttribute?.(attribute);
            if (value && isFigureEmbedSource(value, sourcePath)) return value;
        }
    }
    return "";
};

const getFigureEmbedLabelTarget = (element) => {
    if (!element) return null;
    if (element.matches?.(".excalidraw-embedded-img, [fileSource]")) {
        // Excalidrawは画像本体と外枠の両方に `.excalidraw-svg` を付ける。
        // 画像本体ではなく、必ず一段外側をキャプションの親にする。
        return element.parentElement?.closest?.(
            ".excalidraw-svg, .media-embed, .internal-embed, .markdown-embed",
        )
            || element.parentElement
            || element;
    }
    return element;
};

const updateFigureEmbedWidth = (target) => {
    if (!target?.isConnected) return;
    const visual = target.matches?.("img, svg, canvas")
        ? target
        : target.querySelector?.("img, svg, canvas, .excalidraw-embedded-img");
    const width = visual?.getBoundingClientRect?.().width || 0;
    if (width > 0) target.style.setProperty("--figure-width", `${Math.ceil(width)}px`);
};

const ensureFigureEmbedCaption = (target, displayName) => {
    if (!target || !displayName) return;
    let caption = Array.from(target.children || []).find((child) =>
        child.classList?.contains("custom-figure-caption"),
    );
    // Excalidraw自身が内側の描画コンテナへキャプションを付けた場合は、
    // 外側へもう1つ作らず、そのキャプションを利用する。
    if (!caption) {
        const nestedCaption = target.querySelector?.(".custom-figure-caption");
        if (nestedCaption) {
            if (nestedCaption.textContent !== displayName) nestedCaption.textContent = displayName;
            return;
        }
    }
    if (!caption) {
        caption = target.ownerDocument.createElement("div");
        caption.className = "custom-figure-caption";
        target.appendChild(caption);
    }
    if (caption.textContent !== displayName) caption.textContent = displayName;
    // Excalidrawは画像を非同期で追加・差し替えるため、毎回キャプションを最後尾へ戻す。
    if (target.lastElementChild !== caption) target.appendChild(caption);
};

const removeDuplicateFigureCaptions = (root = document) => {
    const captions = Array.from(root.querySelectorAll?.(".custom-figure-caption") || []);
    const kept = new Map();
    captions.forEach((caption) => {
        const text = caption.textContent?.trim();
        if (!text) return;
        const target = caption.closest?.("[data-figure-name]");
        const previous = kept.get(text);
        if (!previous) {
            kept.set(text, { caption, target });
            return;
        }
        if (previous.target === target) {
            caption.remove();
            return;
        }
        const previousVisual = previous.target?.querySelector?.("img, svg, canvas, .excalidraw-embedded-img");
        const currentVisual = target?.querySelector?.("img, svg, canvas, .excalidraw-embedded-img");
        const a = previousVisual?.getBoundingClientRect?.();
        const b = currentVisual?.getBoundingClientRect?.();
        if (a && b && a.width > 0 && b.width > 0) {
            const intersectionWidth = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
            const intersectionHeight = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
            const intersection = intersectionWidth * intersectionHeight;
            const smaller = Math.min(a.width * a.height, b.width * b.height);
            if (intersection / smaller > 0.8) {
                caption.remove();
                return;
            }
        }
        kept.set(text, { caption, target });
    });
};

const applyExcalidrawFallbackCaptions = async () => {
    const markdownLeaves = app.workspace.getLeavesOfType?.("markdown") || [];
    for (const leaf of markdownLeaves) {
        const view = leaf?.view;
        const container = view?.containerEl;
        let markdownText = view?.getViewData?.() || view?.editor?.getValue?.() || "";
        if (!markdownText && view?.file) {
            try {
                markdownText = await app.vault.cachedRead(view.file);
            } catch (error) {
                console.warn("Failed to read Markdown for Excalidraw captions.", error);
            }
        }
        if (!container || !markdownText) continue;

        const sources = Array.from(markdownText.matchAll(
            /!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/gi,
        )).map((match) => match[1])
            .filter((source) => isExcalidrawEmbedSource(source, view?.file?.path || ""));
        if (!sources.length) continue;

        // 表示方式により外枠クラスが変わるため、必ず付与される画像本体から親を取得する。
        const embeddedTargets = Array.from(container.querySelectorAll(".excalidraw-embedded-img"))
            .map((element) => element.parentElement || element);
        const outerSvgTargets = Array.from(container.querySelectorAll(".excalidraw-svg")).filter((element) =>
            !element.parentElement?.closest?.(".excalidraw-svg"),
        );
        const unlabeledImageTargets = Array.from(container.querySelectorAll(
            ".markdown-preview-section img, .markdown-preview-section svg, " +
            ".markdown-preview-section [role='img'], " +
            ".markdown-source-view img, .markdown-source-view svg, " +
            ".markdown-source-view [role='img']",
        )).filter((image) => {
            if (image.closest?.("[data-figure-name]")) return false;
            const rect = image.getBoundingClientRect?.();
            if (!rect || rect.width < 50 || rect.height < 50) return false;
            const alt = image.getAttribute("alt") || "";
            const isExcalidrawVisual = Boolean(image.closest?.(
                ".excalidraw, .excalidraw-svg, .excalidraw-embedded-img, [data-excalidraw-source]",
            )) || sources.some((source) => getFigureEmbedDisplayName(source, view?.file?.path || "") === alt);
            return image.tagName === "svg" ||
                isExcalidrawVisual ||
                !image.getAttribute("alt") ||
                image.getAttribute("src")?.startsWith("blob:");
        }).map((image) => image.parentElement || image);
        const targets = Array.from(new Set([
            ...embeddedTargets,
            ...outerSvgTargets,
            ...unlabeledImageTargets,
        ]));
        targets.slice(0, sources.length).forEach((target, index) => {
            const source = sources[index];
            const displayName = getFigureEmbedDisplayName(source, view?.file?.path || "");
            if (!displayName) return;
            // 通常処理が既に同じ図へ名前を付けている場合は、フォールバック側で別名ラベルを増やさない。
            if (target.matches?.("[data-figure-name]") ||
                target.closest?.("[data-figure-name]") ||
                target.querySelector?.("[data-figure-name]")) return;
            target.setAttribute("data-figure-name", displayName);
            target.setAttribute("data-figure-kind", "excalidraw");
            ensureFigureEmbedCaption(target, displayName);
            updateFigureEmbedWidth(target);
            const visual = target.querySelector?.("img, svg, canvas, .excalidraw-embedded-img");
            if (visual && window._customFigureEmbedResizeObserver) {
                window._customFigureEmbedResizeObserver.observe(visual);
            }
        });
        removeDuplicateFigureCaptions(container);
    }
};

const applyFigureEmbedSpacing = async () => {
    const markdownLeaves = app.workspace.getLeavesOfType?.("markdown") || [];
    for (const leaf of markdownLeaves) {
        const view = leaf?.view;
        const container = view?.containerEl;
        let markdownText = view?.getViewData?.() || view?.editor?.getValue?.() || "";
        if (!markdownText && view?.file) {
            try {
                markdownText = await app.vault.cachedRead(view.file);
            } catch {
                continue;
            }
        }
        if (!container || !markdownText) continue;

        const sourcePath = view?.file?.path || "";
        const figures = Array.from(markdownText.matchAll(/!\[\[([^\]]+)\]\]/g))
            .filter((match) => isFigureEmbedSource(match[1], sourcePath))
            .map((match) => {
                const whitespace = markdownText.slice(match.index + match[0].length)
                    .match(/^(?:[ \t]*\r?\n)+/)?.[0] || "";
                const lineBreaks = Math.max(1, Math.min(8, (whitespace.match(/\n/g) || []).length));
                return {
                    displayName: getFigureEmbedDisplayName(match[1], sourcePath),
                    gap: `${lineBreaks * 1.15}em`,
                };
            });

        const usedTargets = new Set();
        figures.forEach(({ displayName, gap }) => {
            const candidates = Array.from(container.querySelectorAll("[data-figure-name]"))
                .filter((target) => target.getAttribute("data-figure-name") === displayName)
                .filter((target) => !usedTargets.has(target))
                .filter((target) => Array.from(target.children || []).some((child) =>
                    child.classList?.contains("custom-figure-caption"),
                ));
            // 入れ子の場合は、実際の図とキャプションを直接保持する一番内側を選ぶ。
            const target = candidates.find((candidate) =>
                !candidates.some((other) => other !== candidate && candidate.contains(other)),
            ) || candidates[0];
            if (!target) return;
            usedTargets.add(target);
            target.style.setProperty("--figure-after-gap", gap);
        });
    }
};

const applyFigureEmbedDisplayNames = (root = document) => {
    const selector = [
        ".media-embed[src]",
        ".internal-embed[src]",
        ".markdown-embed[src]",
        ".excalidraw-svg[data-excalidraw-source]",
        ".excalidraw-svg",
        ".excalidraw-embedded-img[filesource]",
        "[filesource]",
    ].join(", ");
    const elements = [];
    if (root.matches?.(selector)) elements.push(root);
    root.querySelectorAll?.(selector).forEach((element) => elements.push(element));

    const targets = new Set();
    elements.forEach((element) => {
        const sourcePath = getFigureEmbedSourcePath(element);
        const source = getFigureEmbedSource(element, sourcePath);
        if (!source) return;
        const target = getFigureEmbedLabelTarget(element);
        const displayName = getFigureEmbedDisplayName(source, sourcePath);
        if (!target || !displayName) return;
        target.setAttribute("data-figure-name", displayName);
        target.setAttribute("data-figure-kind", isExcalidrawEmbedSource(source, sourcePath) ? "excalidraw" : "image");
        ensureFigureEmbedCaption(target, displayName);
        targets.add(target);
        updateFigureEmbedWidth(target);
    });

    if (window._customFigureEmbedResizeObserver) {
        targets.forEach((target) => {
            const visual = target.querySelector?.("img, svg, canvas, .excalidraw-embedded-img") || target;
            if (visual) window._customFigureEmbedResizeObserver.observe(visual);
        });
    }
    removeDuplicateFigureCaptions(root);
    void (async () => {
        await applyExcalidrawFallbackCaptions();
        await applyFigureEmbedSpacing();
    })();
};

const getClipboardImageBlob = async () => {
    if (!navigator.clipboard?.read) {
        new Notice("Clipboard image read is not available.");
        return null;
    }

    try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
            const imageType = item.types.find((type) => type.startsWith("image/"));
            if (imageType) return await item.getType(imageType);
        }
    } catch (error) {
        console.error("Failed to read clipboard image:", error);
        new Notice("Failed to read clipboard image.");
        return null;
    }

    new Notice("Clipboard does not contain an image.");
    return null;
};

const assertImageDiffApiReady = async () => {
    try {
        const response = await fetch(`${IMAGE_DIFF_API_BASE_URL}/health`);
        if (response.ok) return true;
        new Notice(`Image diff API is not ready (${response.status}).`);
    } catch (error) {
        console.error("Image diff API health check failed:", error);
        new Notice("Image diff API is not running.");
    }
    return false;
};

const getClipboardFilename = (blob) => {
    const extensionByMime = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
        "image/bmp": "bmp",
        "image/svg+xml": "svg",
        "image/tiff": "tiff",
    };
    return `clipboard.${extensionByMime[blob.type] || "png"}`;
};

const getMimeTypeForFile = (file) => {
    const mimeByExtension = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        gif: "image/gif",
        bmp: "image/bmp",
        svg: "image/svg+xml",
        tif: "image/tiff",
        tiff: "image/tiff",
    };
    return mimeByExtension[file.extension.toLowerCase()] || "application/octet-stream";
};

const getApiErrorMessage = async (response) => {
    try {
        const body = await response.json();
        return `${response.status} ${body.detail || response.statusText}`;
    } catch {
        return `${response.status} ${response.statusText}`;
    }
};

const canvasConvertibleMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

const convertClipboardBlobForFile = async (blob, file) => {
    const targetMimeType = getMimeTypeForFile(file);
    if (!canvasConvertibleMimeTypes.has(targetMimeType)) {
        return blob;
    }
    if (blob.type === targetMimeType) {
        return blob;
    }

    const imageUrl = URL.createObjectURL(blob);
    try {
        const image = new Image();
        image.decoding = "async";
        const loaded = new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = reject;
        });
        image.src = imageUrl;
        await loaded;

        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;
        const context = canvas.getContext("2d");
        if (!context) return blob;

        if (targetMimeType === "image/jpeg") {
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, canvas.width, canvas.height);
        }
        context.drawImage(image, 0, 0);

        const convertedBlob = await new Promise((resolve) => canvas.toBlob(resolve, targetMimeType, 0.95));
        return convertedBlob || blob;
    } catch (error) {
        console.warn("Failed to convert clipboard image. Using original blob.", error);
        return blob;
    } finally {
        URL.revokeObjectURL(imageUrl);
    }
};

const getImageElementFile = (imgEl) => {
    try {
        return getFileFromImageElement(imgEl);
    } catch {
        return null;
    }
};

const refreshImageElement = (imgEl) => {
    const src = imgEl.getAttribute("src") || imgEl.currentSrc;
    if (!src) return;

    try {
        const url = new URL(src, window.location.href);
        url.searchParams.set("_customImageReload", Date.now().toString());
        imgEl.setAttribute("src", url.toString());
    } catch {
        const separator = src.includes("?") ? "&" : "?";
        imgEl.setAttribute("src", `${src}${separator}_customImageReload=${Date.now()}`);
    }
};

const refreshImageDisplays = async (file) => {
    document.querySelectorAll("img").forEach((imgEl) => {
        const imageFile = getImageElementFile(imgEl);
        if (imageFile?.path === file.path) {
            refreshImageElement(imgEl);
        }
    });

    const leavesToReload = [];
    app.workspace.iterateAllLeaves?.((leaf) => {
        if (leaf?.view?.file?.path === file.path) {
            leavesToReload.push(leaf);
        }
    });

    for (const leaf of leavesToReload) {
        try {
            await leaf.openFile(file);
        } catch (error) {
            console.warn("Failed to reload image leaf.", error);
        }
    }
};

const compareWithClipboardImage = async (file) => {
    const clipboardBlob = await getClipboardImageBlob();
    if (!clipboardBlob) return;
    if (!(await assertImageDiffApiReady())) return;

    try {
        const selectedBytes = await app.vault.readBinary(file);
        const selectedBlob = new Blob([selectedBytes], { type: getMimeTypeForFile(file) });
        const formData = new FormData();
        formData.append("file_a", selectedBlob, file.name);
        formData.append("file_b", clipboardBlob, getClipboardFilename(clipboardBlob));
        formData.append("category", "汎用");
        formData.append("diff_threshold", "0.1");

        const response = await fetch(`${IMAGE_DIFF_API_BASE_URL}/diff`, { method: "POST", body: formData });
        if (!response.ok) {
            new Notice(`Image diff failed: ${await getApiErrorMessage(response)}`);
            return;
        }

        const result = await response.json();
        const resultUrl = new URL(IMAGE_DIFF_APP_BASE_URL);
        if (result.result_id) resultUrl.searchParams.set("result_id", result.result_id);
        window.open(resultUrl.toString(), "_blank");
        new Notice("Opened image diff.");
    } catch (error) {
        console.error("Failed to compare clipboard image:", error);
        new Notice("Failed to compare clipboard image.");
    }
};

const replaceWithClipboardImage = async (file) => {
    const clipboardBlob = await getClipboardImageBlob();
    if (!clipboardBlob) return;

    if (!window.confirm(`本当に "${file.name}" をクリップボードの画像で差し替えますか?`)) return;

    try {
        const replacementBlob = await convertClipboardBlobForFile(clipboardBlob, file);
        await app.vault.modifyBinary(file, await replacementBlob.arrayBuffer());
        await refreshImageDisplays(file);
        new Notice(`Replaced "${file.name}" with clipboard image.`);
    } catch (error) {
        console.error("Failed to replace image with clipboard image:", error);
        new Notice("Failed to replace image.");
    }
};

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

// ノート内の ![[添付ファイル]] を、実際に同じファイルへ解決されるものだけ削除する。
// パスの省略・別名・サイズ指定（|）にも対応する。
const removeEmbeddedAttachmentLinks = async (sourceFile, attachmentFile) => {
    const originalContent = await app.vault.read(sourceFile);
    const embedPattern = /!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
    const updatedContent = originalContent.replace(embedPattern, (embed, linkpath) => {
        const normalizedLinkpath = linkpath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
        const sourceFolder = sourceFile.parent?.path || "";
        const relativePath = sourceFolder ? `${sourceFolder}/${normalizedLinkpath}` : normalizedLinkpath;
        const linkedFile = app.metadataCache.getFirstLinkpathDest(normalizedLinkpath, sourceFile.path);

        // 添付ファイルをゴミ箱へ移動する前でも、非Markdownファイルは
        // metadataCache で解決できないことがある。その場合も、ファイル名・
        // 保管庫からのパス・相対パスを比較して元の埋め込みだけ確実に消す。
        const isTarget = linkedFile?.path === attachmentFile.path ||
            normalizedLinkpath === attachmentFile.path ||
            relativePath === attachmentFile.path ||
            normalizedLinkpath === attachmentFile.name;
        return isTarget ? "" : embed;
    });
    return { originalContent, updatedContent, changed: updatedContent !== originalContent };
};

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

// 画像・PDF・Office文書など、Markdown 以外の添付ファイルを削除する。
// ノート内の右クリックから実行した場合は、先にそのノートの埋め込みリンクも除去する。
const deleteAttachmentFile = async (file, sourceFile = null) => {
    const backlinks = getBacklinks(file);
    let message = `本当に添付ファイル「${file.name}」を削除しますか？\nシステムのゴミ箱に移動します。`;
    if (sourceFile?.extension === "md") {
        message = `添付ファイル「${file.name}」を削除しますか？\nこのノート内の ![[${file.name}]] も同時に削除し、システムのゴミ箱へ移動します。`;
    } else if (backlinks.length > 0) {
        message = `警告: この添付ファイルは以下のノートで参照されています:\n\n` +
            backlinks.map(path => `- ${path}`).join("\n") +
            `\n\n${message}`;
    }

    if (!window.confirm(message)) return;
    let linkRemoval = null;
    try {
        if (sourceFile?.extension === "md") {
            linkRemoval = await removeEmbeddedAttachmentLinks(sourceFile, file);
            if (linkRemoval.changed) {
                await app.vault.modify(sourceFile, linkRemoval.updatedContent);
            }
        }
        await app.vault.trash(file, true);
        if (linkRemoval?.changed) await refreshAttachmentSourceFile(sourceFile);
        new Notice(`添付ファイル「${file.name}」を削除しました`);
    } catch (error) {
        // リンクだけが消えて添付ファイルが残る状態を避けるため、削除失敗時は復元する。
        if (linkRemoval?.changed && app.vault.getAbstractFileByPath(file.path)) {
            await app.vault.modify(sourceFile, linkRemoval.originalContent);
        }
        console.error("Failed to delete attachment file:", error);
        new Notice("添付ファイルの削除に失敗しました");
    }
};

const deleteImageFile = async (file, sourceFile = null) => deleteAttachmentFile(file, sourceFile);

const isNonMarkdownAttachmentFile = (file) => {
    return !!file?.name && typeof file.extension === "string" && file.extension.toLowerCase() !== "md";
};

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

const dataUrlToBlob = async (dataUrl) => {
    const response = await fetch(dataUrl);
    return await response.blob();
};

const rasterImageFileToPngBlob = async (file) => {
    if (file.name.toLowerCase().endsWith(".excalidraw.md")) {
        const imageData = await renderExcalidrawFileToPngDataUrl(file);
        if (!imageData?.src) throw new Error("ExcalidrawのPNG生成結果が空です。");
        return await dataUrlToBlob(imageData.src);
    }

    if (file.extension.toLowerCase() === "svg") {
        const result = await rasterizeSvgFileToPngDataUrl(file.path);
        if (!result?.pngDataUrl) throw new Error("SVGのPNG変換に失敗しました。");
        return await dataUrlToBlob(result.pngDataUrl);
    }

    const bytes = await app.vault.readBinary(file);
    const sourceBlob = new Blob([bytes], { type: getMimeTypeForFile(file) });
    const imageUrl = URL.createObjectURL(sourceBlob);
    try {
        const image = new Image();
        image.decoding = "async";
        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = reject;
            image.src = imageUrl;
        });
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvasを初期化できません。");
        context.drawImage(image, 0, 0);
        const pngBlob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
        if (!pngBlob) throw new Error("PNG Blobを生成できません。");
        return pngBlob;
    } finally {
        URL.revokeObjectURL(imageUrl);
    }
};

const copyImageAsPngToClipboard = async (file) => {
    try {
        if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
            throw new Error("画像のクリップボード書き込みに対応していません。");
        }
        const pngBlob = await rasterImageFileToPngBlob(file);
        await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
        new Notice("画像をPNGとしてクリップボードにコピーしました");
    } catch (error) {
        console.error("Failed to copy image as PNG:", error);
        new Notice(`画像のコピーに失敗しました: ${error?.message || error}`);
    }
};

const addCopyImageAsPngMenuItem = (menu, file) => {
    menu.addItem((item) => {
        item
            .setTitle("画像をクリップボードにコピー")
            .setIcon("copy")
            .onClick(() => copyImageAsPngToClipboard(file));
    });
};

const addClipboardImageMenuItems = (menu, file, sourceFile = null) => {
    addCopyImageAsPngMenuItem(menu, file);
    if (file.name.toLowerCase().endsWith(".excalidraw.md")) return;
    menu.addItem((item) => {
        item
            .setTitle("削除")
            .setIcon("trash")
            .setWarning(true)
            .onClick(() => deleteImageFile(file, sourceFile));
    });
    menu.addItem((item) => {
        item
            .setTitle("共通画像フォルダへ移動")
            .setIcon("folder")
            .onClick(() => moveToCommonImage(file));
    });
    menu.addItem((item) => {
        item
            .setTitle("クリップボードの画像との比較")
            .setIcon("image")
            .onClick(() => compareWithClipboardImage(file));
    });
    menu.addItem((item) => {
        item
            .setTitle("クリップボードの画像と差し替え")
            .setIcon("replace")
            .setWarning(true)
            .onClick(() => replaceWithClipboardImage(file));
    });
    if (isDrawioEditableFile(file)) {
        menu.addItem((item) => {
            item
                .setTitle("drawioで編集")
                .setIcon("shapes")
                .onClick(() => {
                    app.workspace.trigger("drawio:edit-diagram", file);
                });
        });
    }
};

let obsidianLibForSummary;
try {
    obsidianLibForSummary = require("obsidian");
} catch(e) {
    obsidianLibForSummary = app.plugins.plugins["templater-obsidian"]?.obsidian || (typeof tp !== 'undefined' ? tp.obsidian : null) || (typeof window !== 'undefined' ? window.obsidian : null);
}
const SummaryModal = obsidianLibForSummary?.Modal;
const SummarySetting = obsidianLibForSummary?.Setting;

const getCommonPromptFiles = (vault) => {
    if (!vault?.getMarkdownFiles) return [];
    const promptFiles = vault.getMarkdownFiles().filter(file =>
        file.path.startsWith("11_common_prompt/") && !file.name.endsWith(".excalidraw.md")
    );
    promptFiles.sort((a, b) => {
        if (a.name === "common_prompt.md") return -1;
        if (b.name === "common_prompt.md") return 1;
        return a.name.localeCompare(b.name);
    });
    return promptFiles;
};

const addCommonPromptToggles = (contentEl, selectedPrompts, vault = app.vault) => {
    const promptFiles = getCommonPromptFiles(vault);
    promptFiles.forEach((file) => {
        const isDefaultOn = file.name === "common_prompt.md";
        selectedPrompts[file.path] = isDefaultOn;

        new SummarySetting(contentEl)
            .setName(file.name)
            .setDesc(file.path)
            .addToggle((toggle) => {
                toggle
                    .setValue(isDefaultOn)
                    .onChange((value) => {
                        selectedPrompts[file.path] = value;
                    });
            });
    });
};

class SummaryDepthModal extends (SummaryModal || class {}) {
    constructor(app, callback) {
        super(app);
        this.callback = callback;
        this.depth = "2";
        this.selectedPrompts = {};
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "サマリー作成の設定" });

        let inputEl = null;

        new SummarySetting(contentEl)
            .setName("最大深さ")
            .setDesc("再帰的に探索するリンクの最大深さを入力してください")
            .addText((text) => {
                inputEl = text.inputEl;
                text
                    .setValue(this.depth)
                    .onChange((value) => {
                        this.depth = value;
                    });
                if (inputEl) {
                    inputEl.type = "number";
                    inputEl.min = "0";
                }
            });

        contentEl.createEl("h3", { text: "共通プロンプトの選択" });

        // サマリーとHTML出力で同じ common prompt の選択肢を使う。
        addCommonPromptToggles(contentEl, this.selectedPrompts, this.app.vault);

        new SummarySetting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText("作成")
                    .setCta()
                    .onClick(() => {
                        this.close();
                        const selectedPaths = Object.keys(this.selectedPrompts).filter(
                            (path) => this.selectedPrompts[path]
                        );
                        this.callback({ depth: this.depth, selectedPrompts: selectedPaths });
                    })
            )
            .addButton((btn) =>
                btn
                    .setButtonText("キャンセル")
                    .onClick(() => {
                        this.close();
                        this.callback(null);
                    })
            );

        // 自動フォーカス ＋ 全選択（onOpenのタイミングで確実に実行する）
        if (inputEl) {
            setTimeout(() => {
                inputEl.focus();
                inputEl.select();
            }, 50);
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class AiHtmlExportOptionsModal extends (SummaryModal || class {}) {
    constructor(app, callback) {
        super(app);
        this.callback = callback;
        this.selectedPrompts = {};
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "AIコンテキスト用HTMLの設定" });
        contentEl.createEl("p", { text: "HTMLに含める共通プロンプトを選択してください。" });
        contentEl.createEl("h3", { text: "共通プロンプトの選択" });

        addCommonPromptToggles(contentEl, this.selectedPrompts, this.app.vault);

        new SummarySetting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText("出力")
                    .setCta()
                    .onClick(() => {
                        const callback = this.callback;
                        this.callback = null;
                        this.close();
                        callback?.({
                            selectedPrompts: Object.keys(this.selectedPrompts).filter(
                                (path) => this.selectedPrompts[path]
                            )
                        });
                    })
            )
            .addButton((btn) =>
                btn
                    .setButtonText("キャンセル")
                    .onClick(() => {
                        const callback = this.callback;
                        this.callback = null;
                        this.close();
                        callback?.(null);
                    })
            );
    }

    onClose() {
        if (this.callback) {
            const callback = this.callback;
            this.callback = null;
            callback(null);
        }
    }
}

class TagRenameModal extends (SummaryModal || class {}) {
    constructor(app, defaultVal, callback) {
        super(app);
        this.defaultVal = defaultVal;
        this.callback = callback;
        this.value = defaultVal;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "タグの一括変換" });

        new SummarySetting(contentEl)
            .setName("新しいタグ名")
            .setDesc("置換後のタグ名を入力してください（結合またはリネーム）")
            .addText((text) => {
                text
                    .setValue(this.value)
                    .onChange((value) => {
                        this.value = value;
                    });
            });

        new SummarySetting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText("変換")
                    .setCta()
                    .onClick(() => {
                        this.close();
                        this.callback(this.value);
                    })
            )
            .addButton((btn) =>
                btn
                    .setButtonText("キャンセル")
                    .onClick(() => {
                        this.close();
                        this.callback(null);
                    })
            );

        // Enterキーで変換を実行できるようにする
        contentEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                if (e.isComposing) return; // IME変換中のEnterを無視
                e.preventDefault();
                this.close();
                this.callback(this.value);
            }
        });

        // 確実にフォーカスと全選択を行うための遅延処理
        setTimeout(() => {
            const input = contentEl.querySelector("input[type='text']");
            if (input) {
                input.focus();
                input.select();
            }
        }, 150);
    }

    onClose() {
        this.contentEl.empty();
    }
}

// CFB (OLE2 Compound File) parser implementation in pure JS
const parseCFB = (buffer) => {
    const magic = buffer.toString('hex', 0, 8);
    if (magic !== 'd0cf11e0a1b11ae1') {
        throw new Error('Not a valid OLE2/CFB file');
    }

    const sectorShift = buffer.readUInt16LE(0x1E);
    const sectorSize = 1 << sectorShift;

    const miniSectorShift = buffer.readUInt16LE(0x20);
    const miniSectorSize = 1 << miniSectorShift;

    const dirStartSector = buffer.readUInt32LE(0x30);
    const miniFatStartSector = buffer.readUInt32LE(0x3C);

    const fatSectors = [];
    for (let i = 0; i < 109; i++) {
        const sec = buffer.readUInt32LE(0x4C + i * 4);
        if (sec === 0xFFFFFFFE || sec === 0xFFFFFFFF) break;
        fatSectors.push(sec);
    }

    const fat = [];
    for (const sec of fatSectors) {
        const offset = (sec + 1) * sectorSize;
        if (offset + sectorSize > buffer.length) break;
        for (let i = 0; i < sectorSize / 4; i++) {
            fat.push(buffer.readUInt32LE(offset + i * 4));
        }
    }

    const getSectorChain = (startSector) => {
        const chain = [];
        let current = startSector;
        const visited = new Set();
        while (current !== 0xFFFFFFFE && current !== 0xFFFFFFFC && current < fat.length) {
            if (visited.has(current)) break; // Loop detection
            visited.add(current);
            chain.push(current);
            current = fat[current];
        }
        return chain;
    };

    const readChainData = (chain) => {
        const chunks = [];
        for (const sec of chain) {
            const offset = (sec + 1) * sectorSize;
            if (offset + sectorSize <= buffer.length) {
                chunks.push(buffer.subarray(offset, offset + sectorSize));
            }
        }
        return Buffer.concat(chunks);
    };

    const dirChain = getSectorChain(dirStartSector);
    const dirData = readChainData(dirChain);

    const entries = [];
    const entriesById = [];
    for (let i = 0; i < dirData.length; i += 128) {
        if (i + 128 > dirData.length) break;
        const id = i / 128;
        const nameLen = dirData.readUInt16LE(i + 0x40);
        if (nameLen <= 2 || nameLen > 64) {
            entriesById[id] = null;
            continue;
        }
        const name = dirData.toString('utf16le', i, i + nameLen - 2);
        const type = dirData.readUInt8(i + 0x42);
        const leftId = dirData.readUInt32LE(i + 0x44);
        const rightId = dirData.readUInt32LE(i + 0x48);
        const childId = dirData.readUInt32LE(i + 0x4C);
        const startSector = dirData.readUInt32LE(i + 0x74);
        const size = dirData.readUInt32LE(i + 0x78);

        const entry = { id, name, type, leftId, rightId, childId, startSector, size };
        entries.push(entry);
        entriesById[id] = entry;
    }

    const rootEntry = entries.find(e => e.type === 5);
    let miniStreamData = Buffer.alloc(0);
    if (rootEntry && rootEntry.startSector !== 0xFFFFFFFE) {
        const rootChain = getSectorChain(rootEntry.startSector);
        miniStreamData = readChainData(rootChain);
    }

    const miniFatChain = getSectorChain(miniFatStartSector);
    const miniFatData = readChainData(miniFatChain);
    const miniFat = [];
    for (let i = 0; i < miniFatData.length; i += 4) {
        miniFat.push(miniFatData.readUInt32LE(i));
    }

    const getMiniSectorChain = (startSector) => {
        const chain = [];
        let current = startSector;
        const visited = new Set();
        while (current !== 0xFFFFFFFE && current < miniFat.length) {
            if (visited.has(current)) break;
            visited.add(current);
            chain.push(current);
            current = miniFat[current];
        }
        return chain;
    };

    const readStream = (entry) => {
        if (entry.size === 0) return Buffer.alloc(0);
        
        if (entry.size < 4096) {
            const chain = getMiniSectorChain(entry.startSector);
            const chunks = [];
            for (const sec of chain) {
                const offset = sec * miniSectorSize;
                if (offset + miniSectorSize <= miniStreamData.length) {
                    chunks.push(miniStreamData.subarray(offset, offset + miniSectorSize));
                }
            }
            return Buffer.concat(chunks).subarray(0, entry.size);
        } else {
            const chain = getSectorChain(entry.startSector);
            return readChainData(chain).subarray(0, entry.size);
        }
    };

    // CFBのDirectoryは、各Storageの子を赤黒木（left/right）で保持する。
    // MSG添付ファイルでは同名プロパティが複数存在するため、Storage単位で
    // 子Streamを特定できるようにしておく。
    const getStorageChildren = (storageEntry) => {
        if (!storageEntry || storageEntry.childId === 0xFFFFFFFF || storageEntry.childId === storageEntry.id) {
            return [];
        }
        const result = [];
        const visited = new Set();
        const walkSiblingTree = (id) => {
            if (id === 0xFFFFFFFF || visited.has(id)) return;
            const entry = entriesById[id];
            if (!entry) return;
            visited.add(id);
            walkSiblingTree(entry.leftId);
            result.push(entry);
            walkSiblingTree(entry.rightId);
        };
        walkSiblingTree(storageEntry.childId);
        return result;
    };

    return { entries, readStream, getStorageChildren };
};

// Helper to decode text streams (supports UTF-16LE and Shift-JIS)
const decodeBytesWithCharset = (data, charset) => {
    try {
        const decoder = new TextDecoder(charset);
        return decoder.decode(data);
    } catch (e) {
        return null;
    }
};

const mojibakeScore = (text) => {
    if (!text) return Number.MAX_SAFE_INTEGER;
    const badChars = (text.match(/[�]/g) || []).length * 20;
    const mojibake = (text.match(/[ÃÂã¢縺繧譁]/g) || []).length * 5;
    const japanese = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
    return badChars + mojibake - japanese;
};

const decodeBestEffortText = (data, preferredCharsets = []) => {
    const candidates = [];
    const add = (charset, text) => {
        if (text !== null && text !== undefined) candidates.push({ charset, text, score: mojibakeScore(text) });
    };
    for (const charset of preferredCharsets) {
        add(charset, decodeBytesWithCharset(data, charset));
    }
    for (const charset of ["utf-8", "shift-jis", "windows-31j", "iso-2022-jp", "euc-jp"]) {
        if (!preferredCharsets.includes(charset)) {
            add(charset, decodeBytesWithCharset(data, charset));
        }
    }
    add("buffer-utf8", data.toString("utf8"));
    candidates.sort((a, b) => a.score - b.score);
    let str = candidates.length ? candidates[0].text : data.toString("utf8");
    const nullIdx = str.indexOf('\0');
    if (nullIdx !== -1) str = str.substring(0, nullIdx);
    return str;
};

const decodeStream = (entry, readStream) => {
    const data = readStream(entry);
    if (entry.name.endsWith('001F')) {
        let str = data.toString('utf16le');
        const nullIdx = str.indexOf('\0');
        if (nullIdx !== -1) str = str.substring(0, nullIdx);
        return str;
    } else if (entry.name.endsWith('001E')) {
        return decodeBestEffortText(data, ["shift-jis", "windows-31j"]);
    } else if (entry.name.endsWith('0102')) {
        // PT_BINARY タイプのエントリ。HTML（1013）などの場合、テキスト表現としてデコードを試みる
        if (entry.name.startsWith('__substg1.0_1013')) {
            try {
                const asciiPreview = data.toString("latin1");
                const match = asciiPreview.match(/charset=["']?([a-zA-Z0-9_-]+)/i);
                const preferred = match ? [match[1].toLowerCase()] : [];
                return decodeBestEffortText(data, preferred);
            } catch (e) {
                // デコード失敗
            }
        }
    }
    return null;
};

// Helper to parse FILETIME format into ISO date string
const parseFileTime = (buffer) => {
    if (buffer.length < 8) return null;
    try {
        const low = buffer.readUInt32LE(0);
        const high = buffer.readUInt32LE(4);
        const fileTime = BigInt(high) * 4294967296n + BigInt(low);
        const milliseconds = Number(fileTime / 10000n) - 11644473600000;
        return new Date(milliseconds).toISOString().replace('T', ' ').substring(0, 19);
    } catch (e) {
        return null;
    }
};

/**
 * Outlook特有のHTMLタグやコメント、Officeメタデータを除去して安全なテキスト・Markdown構造へ変換する
 **/
const sanitizeOutlookHtml = (html) => {
    if (!html) return "";
    let clean = String(html);
    // 1. コメント（条件付きコメント <!--[if ...]>...<![endif]--> を含む）を一括完全除去
    clean = clean.replace(/<!--[\s\S]*?-->/g, "");
    // 2. <head>...</head>, <style>...</style>, <script>...</script>, <xml>...</xml>, <title>...</title> の完全除去
    clean = clean.replace(/<(head|style|script|xml|title)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
    // 3. 独立したDOCTYPEやXMLタグ、名前空間タグの除去
    clean = clean.replace(/<!DOCTYPE\b[^>]*>/gi, "");
    clean = clean.replace(/<\/?xml\b[^>]*>/gi, "");
    clean = clean.replace(/<\/?\w+:[^>]*>/gi, "");
    return clean;
};

// High-level parser for .msg files
const parseMsgFile = async (file) => {
    // Sidebar Explorer Tagに同梱した実績あるMSGライブラリを優先する。
    // プラグイン未起動時だけ、下記の互換パーサーへフォールバックする。
    const bundledParser = typeof window !== "undefined" ? window._sidebarExplorerParseMsgFile : null;
    if (typeof bundledParser === "function") {
        try {
            return await bundledParser(file);
        } catch (error) {
            console.error(`Bundled MSG parser failed for ${file.path}:`, error);
            return null;
        }
    }
    try {
        const binary = await app.vault.readBinary(file);
        const { entries, readStream, getStorageChildren } = parseCFB(Buffer.from(binary));
        
        let subject = "";
        let senderName = "";
        let body = "";
        let htmlBody = "";
        let sentOn = "";

        const subjectEntry = entries.find(e => e.name.startsWith('__substg1.0_0037'));
        if (subjectEntry) {
            subject = decodeStream(subjectEntry, readStream) || "";
        }

        const senderEntry = entries.find(e => e.name.startsWith('__substg1.0_0C1A'));
        if (senderEntry) {
            senderName = decodeStream(senderEntry, readStream) || "";
        }

        const bodyEntry = entries.find(e => e.name.startsWith('__substg1.0_1000'));
        if (bodyEntry) {
            body = decodeStream(bodyEntry, readStream) || "";
        }

        // HTML本文 (1013) は、本文中の cid: 画像の配置情報にも使うため常に取得する。
        const htmlEntry = entries.find(e => e.name.startsWith('__substg1.0_1013'));
        if (htmlEntry) {
            htmlBody = decodeStream(htmlEntry, readStream) || "";
        }

        // フォールバック: HTML本文のタグを除去してプレーンテキスト化
        if (!body && htmlBody) {
            let text = sanitizeOutlookHtml(htmlBody)
                .replace(/<br\s*\/?>/gi, "\n")
                .replace(/<\/(p|div|section|article|header|footer|table|tr|h[1-6])\s*>/gi, "\n\n")
                .replace(/<\/(li)\s*>/gi, "\n")
                .replace(/<li\b[^>]*>/gi, "- ")
                .replace(/<[^>]+>/g, "")
                .replace(/&nbsp;/gi, " ")
                .replace(/&lt;/gi, "<")
                .replace(/&gt;/gi, ">")
                .replace(/&amp;/gi, "&")
                .replace(/&quot;/gi, '"')
                .replace(/&#39;/gi, "'");
            body = text.replace(/\r/g, "").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
        }

        // MSGの添付Storage配下から、Outlook本文に貼り付けられた画像を取得する。
        // PR_ATTACH_DATA_BIN(3701), LONG_FILENAME(3707), MIME_TAG(370E),
        // CONTENT_ID(3712) をStorageごとに関連付ける。
        const attachments = [];
        const attachmentStorages = entries.filter(e => e.type === 1 && e.name.startsWith('__attach_version1.0_'));
        const readAttachmentText = (children, propertyId) => {
            const entry = children.find(e => e.name.startsWith(`__substg1.0_${propertyId}`));
            return entry ? (decodeStream(entry, readStream) || "") : "";
        };
        for (let index = 0; index < attachmentStorages.length; index++) {
            const storage = attachmentStorages[index];
            const children = getStorageChildren(storage);
            const dataEntry = children.find(e => e.name.startsWith('__substg1.0_37010102'));
            if (!dataEntry) continue;
            const data = readStream(dataEntry);
            if (!data || data.length === 0) continue;

            attachments.push({
                FileName: readAttachmentText(children, "3707") || readAttachmentText(children, "3704") || `image-${index + 1}`,
                MimeType: readAttachmentText(children, "370E"),
                ContentId: readAttachmentText(children, "3712").replace(/^<|>$/g, ""),
                ContentLocation: readAttachmentText(children, "3713"),
                Data: Buffer.from(data)
            });
        }

        // 送信日時 (0039) または 受信日時 (0E06) の取得
        // 実際の MSG ファイルでは、日付プロパティ（8バイト値）は個別のストリームファイルではなく、
        // `__properties_version1.0` ストリームの中にインライン格納されている。
        const propEntries = entries.filter(e => e.name === '__properties_version1.0');
        let propEntry = null;
        if (propEntries.length > 0) {
            propEntry = propEntries.reduce((max, cur) => (cur.size > max.size ? cur : max), propEntries[0]);
        }
        if (propEntry) {
            const propData = readStream(propEntry);
            const headerSize = 32;
            const entrySize = 16;
            let clientSubmitTime = "";
            let messageDeliveryTime = "";
            
            for (let offset = headerSize; offset + entrySize <= propData.length; offset += entrySize) {
                const type = propData.readUInt16LE(offset);
                const id = propData.readUInt16LE(offset + 2);
                if (type === 0x0040) { // PT_SYSTIME
                    const dateVal = parseFileTime(propData.subarray(offset + 8, offset + 16));
                    if (id === 0x0039) {
                        clientSubmitTime = dateVal || "";
                    } else if (id === 0x0E06) {
                        messageDeliveryTime = dateVal || "";
                    }
                }
            }
            sentOn = clientSubmitTime || messageDeliveryTime || "";
        }
        
        // フォールバック: もし properties ストリームがなければ、従来の個別ファイル探索も行う
        if (!sentOn) {
            const dateEntry = entries.find(e => e.name.startsWith('__substg1.0_0039')) || entries.find(e => e.name.startsWith('__substg1.0_0E06'));
            if (dateEntry) {
                const dateData = readStream(dateEntry);
                sentOn = parseFileTime(dateData) || "";
            }
        }

        return {
            Subject: subject,
            SenderName: senderName,
            Body: body,
            HtmlBody: htmlBody,
            SentOn: sentOn,
            Attachments: attachments,
            Parser: "legacy-cfb-fallback",
            Warnings: ["Sidebar Explorer TagのMSGライブラリが未起動のため、互換パーサーを使用しました。大容量MSGはプラグインを有効にして再実行してください。"]
        };
    } catch (error) {
        console.error(`Failed to parse MSG file ${file.path}:`, error);
        return null;
    }
};

const stripNoteListSectionForSummary = (content) => {
    if (!content) return content;
    let cleaned = String(content).replace(/\r\n?/g, "\n");

    const markedListRegex = /^#\s+note一覧[^\n]*\n\s*<!-- custom-note-list:start -->[\s\S]*?<!-- custom-note-list:end -->\n?/im;
    cleaned = cleaned.replace(markedListRegex, "");

    const tableListRegex = /^#\s+note一覧[^\n]*\n(?:[ \t]*\n)?(?:[ \t]*\|.*\|[ \t]*\n)+(?:[ \t]*\n)?/im;
    cleaned = cleaned.replace(tableListRegex, "");

    const bulletListRegex = /^#\s+note一覧[^\n]*\n(?:[ \t]*\n)?(?:[ \t]*[-*+] .*(?:\n|$))+(?:[ \t]*\n)?/im;
    cleaned = cleaned.replace(bulletListRegex, "");

    return cleaned.replace(/\n{3,}/g, "\n\n").trim();
};

// Sidebar Explorerが生成する # note一覧 のDataviewJSを、サマリー用の
// 読み取り可能なMarkdown表へ展開する。元ノートは変更せず、サマリー内だけを変換する。
const extractNoteListRowsForSummary = (content) => {
    const source = String(content || "");
    const rowsMatch = source.match(/const\s+noteListRows\s*=\s*(\[[\s\S]*?\]);\s*const\s+sourcePath\b/);
    if (!rowsMatch) return [];
    try {
        const rows = JSON.parse(rowsMatch[1]);
        return Array.isArray(rows) ? rows.filter(row => row && row.path) : [];
    } catch (error) {
        console.warn("Failed to parse noteListRows for summary:", error);
        return [];
    }
};

const expandNoteListForSummary = (content) => {
    const rows = extractNoteListRowsForSummary(content);
    if (rows.length === 0) return { content, rows };

    const table = [
        "| 名称 | タグ | 冒頭 | 作成日 | 編集日 |",
        "| --- | --- | --- | --- | --- |",
        ...rows.map(row => {
            const name = String(row.name || row.path).replace(/\|/g, "\\|");
            const path = String(row.path).replace(/\|/g, "\\|");
            const tags = (Array.isArray(row.tags) ? row.tags : [row.tags])
                .filter(Boolean).join(" ").replace(/\|/g, "\\|");
            const excerpt = String(row.excerpt || "").replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");
            return `| [[${path}|${name}]] | ${tags} | ${excerpt} | ${row.ctime || ""} | ${row.mtime || ""} |`;
        })
    ].join("\n");

    // note一覧のDataviewJSブロックだけを表へ置換する。コード内のJSONを
    // 残すと、AIが表のデータではなくUI実装として解釈しやすいためである。
    const blockPattern = /(<!--\s*custom-note-list:start\s*-->\s*)```dataviewjs[\s\S]*?```/i;
    const expanded = blockPattern.test(content)
        ? String(content).replace(blockPattern, (_match, prefix) => `${prefix}${table}`)
        : content;
    return { content: expanded, rows };
};

const encodeSummaryVaultPath = (path) => String(path || "")
    .split("/")
    .map(segment => encodeURIComponent(segment))
    .join("/");

const replaceAsync = async (source, regex, replacer) => {
    const matches = Array.from(source.matchAll(regex));
    if (matches.length === 0) return source;
    let result = "";
    let lastIndex = 0;
    for (const match of matches) {
        result += source.slice(lastIndex, match.index);
        result += await replacer(...match);
        lastIndex = match.index + match[0].length;
    }
    return result + source.slice(lastIndex);
};

const getSummaryExcalidrawPreview = async (targetFile) => {
    const hash = stableMsgAssetHash(targetFile.path);
    const mtime = targetFile.stat?.mtime || 0;
    const candidates = [
        `.excalidraw-cache/${hash}_${mtime}.png`,
        `.excalidraw-cache/${hash}_${mtime}.svg`
    ];
    let sourcePath = null;
    for (const candidate of candidates) {
        if (await app.vault.adapter.exists(candidate)) {
            sourcePath = candidate;
            break;
        }
    }
    if (!sourcePath && typeof app.vault.adapter.list === "function") {
        try {
            const listed = await app.vault.adapter.list(".excalidraw-cache");
            sourcePath = (listed?.files || []).find(path => {
                const name = String(path).split("/").pop() || "";
                return name.startsWith(`${hash}_`) && /\.(?:png|svg)$/i.test(name);
            }) || null;
        } catch {}
    }
    const destinationFolder = "10_summary/excalidraw-cache";
    if (!(await app.vault.exists(destinationFolder))) {
        if (typeof app.vault.createFolder === "function") await app.vault.createFolder(destinationFolder);
        else await app.vault.adapter.mkdir(destinationFolder);
    }

    // キャッシュがまだ作られていない新しいMarkdown形式の図は、EAから直接PNGを
    // 生成してサマリー用フォルダへ保存する。これでAI用のサマリーでも生データではなく図を参照できる。
    if (!sourcePath && typeof renderExcalidrawFileToPngDataUrl === "function") {
        try {
            const imageData = await renderExcalidrawFileToPngDataUrl(targetFile);
            const match = String(imageData?.src || "").match(/^data:image\/png;base64,(.+)$/i);
            if (match) {
                const fileName = `${hash}_${mtime || Date.now()}.png`;
                const destinationPath = `${destinationFolder}/${fileName}`;
                if (!(await app.vault.adapter.exists(destinationPath))) {
                    const binary = Buffer.from(match[1], "base64");
                    await app.vault.adapter.writeBinary(destinationPath, binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength));
                }
                return `excalidraw-cache/${encodeURIComponent(fileName)}`;
            }
        } catch (error) {
            console.warn("Failed to create summary Excalidraw preview:", targetFile.path, error);
        }
    }

    if (!sourcePath) return null;
    const fileName = sourcePath.split("/").pop();
    const destinationPath = `${destinationFolder}/${fileName}`;
    if (!(await app.vault.adapter.exists(destinationPath))) await app.vault.adapter.copy(sourcePath, destinationPath);
    return `excalidraw-cache/${encodeURIComponent(fileName)}`;
};

const transformSummaryMediaLinks = async (content, sourceFile) => {
    let transformed = await replaceAsync(String(content), /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, async (match, linkpathRaw, sizeRaw) => {
        const linkpath = String(linkpathRaw).trim();
        const size = String(sizeRaw || "").trim().match(/^(\d+)(?:x\d+)?$/)?.[1] || "";
        const target = app.metadataCache.getFirstLinkpathDest(linkpath, sourceFile.path);
        if (!target) return match;
        let url = "";
        if (target.name.endsWith(".excalidraw.md") || isExcalidrawBackedMarkdown(target)) {
            url = await getSummaryExcalidrawPreview(target) || "";
        } else if (["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"].includes(String(target.extension || "").toLowerCase())) {
            url = `../${encodeSummaryVaultPath(target.path)}`;
        }
        if (!url) return match;
        return size ? `<img src="${url}" width="${size}">` : `![](${url})`;
    });

    transformed = await replaceAsync(transformed, /(?<!!)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, async (match, linkpathRaw, aliasRaw) => {
        const linkpath = String(linkpathRaw).trim();
        const target = app.metadataCache.getFirstLinkpathDest(linkpath, sourceFile.path);
        if (!target || !(target.name?.endsWith(".excalidraw.md") || isExcalidrawBackedMarkdown(target))) return match;
        const url = await getSummaryExcalidrawPreview(target);
        if (!url) return match;
        const label = String(aliasRaw || linkpath).replace(/\]/g, "_");
        return `[${label}](${url})`;
    });
    return transformed;
};

const collectMarkdownContents = async (file, depth, maxDepth, collectedContent, processedFiles, collectedMsgFiles) => {
    if (depth > maxDepth || processedFiles.has(file.path)) return;
    processedFiles.add(file.path);

    try {
        let content = await app.vault.read(file);
        content = stripExcalidrawDataSectionForExport(content, file);
        const expandedNoteList = expandNoteListForSummary(content);
        content = expandedNoteList.content;
        // 「# note一覧」もノートの構造・関連情報を含む正式なソースとして扱う。
        // 以前は自動生成テーブルを除去していたため、タブからのサマリー作成で
        // ノート一覧が欠落していた。本文をそのまま収集し、同テーブル内の
        // Wikilink は metadataCache 経由で従来どおり再帰収集する。
        content = await transformSummaryMediaLinks(content, file);

        collectedContent.add(`\n# Source: ${file.path}\n${content}\n`);
    } catch (error) {
        console.error(`Failed to read file ${file.path}:`, error);
        return;
    }

    const fileCache = app.metadataCache.getFileCache(file);
    const links = (fileCache?.links || []).concat(fileCache?.embeds || []);
    
    for (const link of links) {
        const linkedFile = app.metadataCache.getFirstLinkpathDest(link.link, file.path);
        if (linkedFile) {
            // 通常のマークダウンファイルのみ収集（.excalidraw.md を除く .md 拡張子のファイル）
            if (linkedFile.extension === "md" && !linkedFile.name.endsWith(".excalidraw.md")) {
                await collectMarkdownContents(linkedFile, depth + 1, maxDepth, collectedContent, processedFiles, collectedMsgFiles);
            } else if (linkedFile.extension.toLowerCase() === "msg" && collectedMsgFiles) {
                collectedMsgFiles.add(linkedFile);
            }
        }
    }

    // DataviewJS内の行データはmetadataCache上のリンクとして登録されないため、
    // 展開元JSONのpathも明示的に辿る。
    const noteListRows = extractNoteListRowsForSummary(await app.vault.read(file));
    for (const row of noteListRows) {
        const linkedFile = app.vault.getAbstractFileByPath(row.path)
            || app.metadataCache.getFirstLinkpathDest(row.path, file.path);
        if (linkedFile && linkedFile.extension === "md" && !linkedFile.name.endsWith(".excalidraw.md")) {
            await collectMarkdownContents(linkedFile, depth + 1, maxDepth, collectedContent, processedFiles, collectedMsgFiles);
        }
    }
};

const getMsgImageExtension = (attachment) => {
    const mime = String(attachment.MimeType || "").trim().toLowerCase().split(";")[0];
    const mimeExtensions = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/gif": "gif",
        "image/svg+xml": "svg",
        "image/webp": "webp",
        "image/bmp": "bmp"
    };
    if (mimeExtensions[mime]) return mimeExtensions[mime];

    const fileName = String(attachment.FileName || attachment.ContentLocation || "");
    const extensionMatch = fileName.match(/\.([a-zA-Z0-9]+)$/);
    const extension = extensionMatch ? extensionMatch[1].toLowerCase() : "";
    if (["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"].includes(extension)) {
        return extension === "jpeg" ? "jpg" : extension;
    }

    const data = attachment.Data;
    if (!data || data.length < 4) return "";
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) return "png";
    if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) return "jpg";
    if (data.subarray(0, 3).toString("ascii") === "GIF") return "gif";
    if (data.subarray(0, 2).toString("ascii") === "BM") return "bmp";
    if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
    if (data.subarray(0, Math.min(data.length, 512)).toString("utf8").match(/<svg\b/i)) return "svg";
    return "";
};

const stableMsgAssetHash = (value) => {
    let hash = 2166136261;
    for (const char of String(value || "")) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
};

const saveMsgImagesForSummary = async (msgFile, parsed) => {
    const imageAttachments = (parsed.Attachments || [])
        .map((attachment) => {
            const renderableExtension = getMsgImageExtension(attachment);
            const rawExtension = String(attachment.FileName || "").match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase() || "";
            const isKnownRawImage = /^(?:emf|wmf|tif|tiff)$/i.test(rawExtension)
                || String(attachment.MimeType || "").toLowerCase().startsWith("image/");
            return {
                attachment,
                extension: renderableExtension || (isKnownRawImage ? rawExtension || "bin" : ""),
                renderable: Boolean(renderableExtension)
            };
        })
        .filter(({ extension }) => extension);
    if (imageAttachments.length === 0) return [];

    const assetFolder = "10_summary/msg-assets";
    if (!(await app.vault.exists(assetFolder))) {
        await app.vault.createFolder(assetFolder);
    }

    const msgHash = stableMsgAssetHash(msgFile.path);
    const savedImages = [];
    for (let index = 0; index < imageAttachments.length; index++) {
        const { attachment, extension, renderable } = imageAttachments[index];
        const rawName = String(attachment.FileName || attachment.ContentLocation || `image-${index + 1}`)
            .split(/[\\/]/).pop()
            .replace(/[\x00-\x1f:*?"<>|#[\]]/g, "_")
            .replace(/\.[a-zA-Z0-9]+$/, "")
            .trim()
            .slice(0, 100) || `image-${index + 1}`;
        const assetName = `${msgHash}_${String(index + 1).padStart(2, "0")}_${rawName}.${extension}`;
        const assetPath = `${assetFolder}/${assetName}`;
        const data = attachment.Data;
        const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        const existing = app.vault.getAbstractFileByPath(assetPath);
        if (existing) {
            await app.vault.modifyBinary(existing, arrayBuffer);
        } else {
            await app.vault.createBinary(assetPath, arrayBuffer);
        }

        savedImages.push({
            path: assetPath,
            relativeUrl: `msg-assets/${encodeURIComponent(assetName)}`,
            contentId: String(attachment.ContentId || "").replace(/^<|>$/g, "").toLowerCase(),
            contentLocation: String(attachment.ContentLocation || "").toLowerCase(),
            alt: rawName.replace(/\]/g, "_"),
            renderable
        });
    }
    return savedImages;
};

const renderMsgBodyWithImages = (parsed, savedImages) => {
    const byCid = new Map();
    const byLocation = new Map();
    for (const image of savedImages) {
        if (image.renderable === false) continue;
        if (image.contentId) byCid.set(image.contentId, image);
        if (image.contentLocation) byLocation.set(image.contentLocation, image);
    }
    const used = new Set();
    const html = String(parsed.HtmlBody || "");
    const renderableImages = savedImages.filter(image => image.renderable !== false);

    // 画像がなく、かつプレーンテキスト本文が存在する場合は、タグ混入のないクリーンな Body を最優先
    if (renderableImages.length === 0 && String(parsed.Body || "").trim()) {
        return { body: String(parsed.Body || ""), unplaced: [] };
    }

    if (!html) return { body: String(parsed.Body || ""), unplaced: renderableImages };

    let markdown = sanitizeOutlookHtml(html)
        .replace(/<img\b[^>]*>/gi, (tag) => {
            const srcMatch = tag.match(/\bsrc\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i);
            const altMatch = tag.match(/\balt\s*=\s*(?:["']([^"']*)["']|([^\s>]+))/i);
            const src = srcMatch?.[1] || srcMatch?.[2] || "";
            const alt = altMatch?.[1] || altMatch?.[2] || "メール内画像";
            let key = src.trim().toLowerCase();
            if (key.startsWith("cid:")) key = key.slice(4).replace(/^<|>$/g, "");
            let image = byCid.get(key) || byLocation.get(key);
            if (!image && !src) image = renderableImages.find(candidate => !used.has(candidate.path));
            if (!image) return "\n\n*（未対応のメール内画像）*\n\n";
            used.add(image.path);
            return `\n\n![${String(alt).replace(/\]/g, "_")}](${image.relativeUrl})\n\n`;
        })
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|section|article|header|footer|table|tr|h[1-6])\s*>/gi, "\n\n")
        .replace(/<\/(li)\s*>/gi, "\n")
        .replace(/<li\b[^>]*>/gi, "- ")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        // メール本文中の残存山括弧をObsidianでHTML実行させない
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\r/g, "")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    if (!markdown) markdown = String(parsed.Body || "");
    return { body: markdown, unplaced: renderableImages.filter(image => !used.has(image.path)) };
};

const createSummary = async (file) => {
    const askDepth = async () => {
        // 1. カスタムモーダル（SummaryDepthModal）が利用可能な場合
        if (SummaryModal && SummarySetting) {
            return new Promise((resolve) => {
                const modal = new SummaryDepthModal(app, (val) => {
                    resolve(val);
                });
                modal.open();
            });
        }
        
        // 2. カスタムモーダルが利用不可で、tp.system.prompt が利用可能な場合（フォールバック）
        if (typeof tp !== "undefined" && tp.system?.prompt) {
            const depth = await tp.system.prompt("再帰的に探索するリンクの最大深さを入力してください", "2");
            return depth !== null ? { depth, selectedPrompts: ["11_common_prompt/common_prompt.md"] } : null;
        }
        
        // 3. どちらも利用不可の場合、デフォルト値 2 を返す
        const NoticeClass = obsidianLibForSummary?.Notice || (typeof window !== "undefined" && window.Notice) || (typeof global !== "undefined" && global.Notice) || class {};
        new NoticeClass("ダイアログを表示できません。デフォルトの深さ 2 を使用します。");
        return { depth: "2", selectedPrompts: ["11_common_prompt/common_prompt.md"] };
    };

    const modalResult = await askDepth();
    if (modalResult === null) {
        // キャンセルされた場合
        return;
    }
    
    let maxDepth = parseInt(modalResult.depth, 10);
    if (isNaN(maxDepth) || maxDepth < 0) {
        new Notice("無効な深さが指定されました。デフォルトの2を使用します。");
        maxDepth = 2;
    }

    // サマリー保存先フォルダの作成
    const folderPath = "10_summary";
    try {
        if (!(await app.vault.exists(folderPath))) {
            await app.vault.createFolder(folderPath);
        }
    } catch (err) {
        console.error("Failed to create summary folders:", err);
    }

    const collectedContent = new Set();
    const processedFiles = new Set();
    const collectedMsgFiles = new Set();

    new Notice("サマリーを作成中...");
    
    await collectMarkdownContents(file, 0, maxDepth, collectedContent, processedFiles, collectedMsgFiles);

    // 選択された共通プロンプトファイルの読み込みと最上部への # Source 形式での統合（メンションタグは出力しない）
    let commonPromptsHeader = "";
    let selectedPrompts = modalResult.selectedPrompts || [];
    
    // common_prompt.md が選択されている場合、常に最上部（先頭）に配置する
    const mainPromptPath = "11_common_prompt/common_prompt.md";
    if (selectedPrompts.includes(mainPromptPath)) {
        selectedPrompts = [mainPromptPath, ...selectedPrompts.filter(path => path !== mainPromptPath)];
    }

    for (const promptPath of selectedPrompts) {
        try {
            const promptFile = app.vault.getAbstractFileByPath(promptPath);
            if (promptFile) {
                const promptContent = await app.vault.read(promptFile);
                commonPromptsHeader += `# Source: ${promptPath}\n` +
                                       `${promptContent}\n\n` +
                                       `---\n`;
            } else {
                console.warn(`Prompt file not found: ${promptPath}`);
            }
        } catch (e) {
            console.error(`Failed to read prompt file ${promptPath}:`, e);
        }
    }

    let merged = commonPromptsHeader + Array.from(collectedContent).join("\n---\n");

    // msg添付ファイルが存在する場合は APPENDIX を追加
    if (collectedMsgFiles.size > 0) {
        const appendixSections = [];
        for (const msgFile of collectedMsgFiles) {
            const parsed = await parseMsgFile(msgFile);
            if (parsed) {
                let imageMarkdown = "";
                let renderedBody = parsed.Body || "";
                const parserWarnings = Array.isArray(parsed.Warnings) ? parsed.Warnings.filter(Boolean) : [];
                if (parserWarnings.length > 0) {
                    console.warn(`MSG warnings for ${msgFile.path}:`, parserWarnings);
                    new Notice(`${msgFile.name}: MSG処理に${parserWarnings.length}件の警告があります。サマリーとコンソールを確認してください。`, 10000);
                }
                try {
                    const savedImages = await saveMsgImagesForSummary(msgFile, parsed);
                    const rendered = renderMsgBodyWithImages(parsed, savedImages);
                    renderedBody = rendered.body;
                    if (rendered.unplaced.length > 0) {
                        imageMarkdown = `\n#### メール内の画像\n\n${rendered.unplaced
                            .map(image => `![${image.alt}](${image.relativeUrl})`)
                            .join("\n\n")}\n`;
                    }
                    const rawImages = savedImages.filter(image => image.renderable === false);
                    if (rawImages.length > 0) {
                        imageMarkdown += `\n#### PNG変換できなかった画像（原本保存済み）\n\n${rawImages
                            .map(image => `- [[${image.path}|${image.alt}]]`)
                            .join("\n")}\n`;
                    }
                } catch (imageError) {
                    console.error(`Failed to extract MSG images ${msgFile.path}:`, imageError);
                    imageMarkdown = "\n*（メール内画像の抽出に失敗しました）*\n";
                }
                appendixSections.push(
                    `### ${msgFile.name} (${msgFile.path})\n` +
                    `- **件名**: ${parsed.Subject || "(件名なし)"}\n` +
                    `- **送信者**: ${parsed.SenderName || "(送信者不明)"}\n` +
                    `- **送信日時**: ${parsed.SentOn || "(不明)"}\n\n` +
                    (parserWarnings.length ? `> [!warning] MSG処理の警告\n${parserWarnings.map(warning => `> - ${warning}`).join("\n")}\n\n` : "") +
                    `#### メール本文\n\n${renderedBody}\n`
                    + imageMarkdown
                );
            } else {
                appendixSections.push(
                    `### ${msgFile.name} (${msgFile.path})\n` +
                    `- *（ファイルの解析に失敗したか、動作環境が非対応です）*\n`
                );
            }
        }
        merged += "\n\n---\n## APPENDIX: メール添付ファイル\n\n" + appendixSections.join("\n---\n");
    }

    const summaryPath = `${folderPath}/${file.basename}_summary.md`;

    try {

        let summaryFile = app.vault.getAbstractFileByPath(summaryPath);
        if (summaryFile) {
            await app.vault.modify(summaryFile, merged);
        } else {
            summaryFile = await app.vault.create(summaryPath, merged);
        }

        new Notice(`サマリーを作成しました: ${summaryPath}`);
        
        // 作成されたファイルを開く
        const createdFile = app.vault.getAbstractFileByPath(summaryPath);
        if (createdFile) {
            const leaf = app.workspace.getLeaf();
            await leaf.openFile(createdFile);
            app.workspace.setActiveLeaf?.(leaf, { focus: true });
            
            // HTMLエクスポートを自動実行
            setTimeout(async () => {
                try {
                    app.workspace.setActiveLeaf?.(leaf, { focus: true });
                    if (typeof exportHtml === "function" && typeof document !== "undefined" && typeof document.createElement === "function") {
                        const path = require("path");
                        const htmlPath = path.join(
                            app.vault.adapter.basePath,
                            summaryPath.replace(/\.md$/i, ".html")
                        );
                        // サマリー本文には選択済みの共通プロンプトが既に含まれているため、
                        // 自動HTML出力では同じ選択ダイアログを再表示しない。
                        await exportHtml(createdFile, "ai", { savePath: htmlPath, selectedPrompts: [] });
                    }
                } catch (cmdErr) {
                    console.error("Failed to trigger HTML export:", cmdErr);
                }
            }, 1000);
        }
    } catch (error) {
        console.error("Failed to create summary file:", error);
        new Notice(`サマリー作成に失敗しました: ${error.message}`);
    }
};

const fromClipboard = async () => {
    const clipboard = { text: "", html: "", source: "" };

    try {
        clipboard.text = await navigator.clipboard.readText();
    } catch (e) {
        clipboard.text = await tp.system.clipboard();
    }

    if (navigator.clipboard?.read) {
        try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
                if (item.types.includes("text/html")) {
                    clipboard.html = await (await item.getType("text/html")).text();
                }
                if (item.types.includes("text/plain")) {
                    clipboard.text = await (await item.getType("text/plain")).text();
                }
            }
        } catch (e) {
            // HTMLクリップボードが読めない環境ではプレーンテキストで続行する
        }
    }

    if (/data-vscode|vscode-editor-data|--vscode|monaco-editor/i.test(clipboard.html)) {
        clipboard.source = "vscode";
    }

    const escapeTableCell = (value) => String(value ?? "")
        .replace(/\r?\n+/g, "<br>")
        .replace(/\|/g, "\\|")
        .trim();

    const matrixToMarkdownTable = (matrix) => {
        const rows = matrix.filter((row) => row.some((cell) => String(cell ?? "").trim() !== ""));
        if (rows.length === 0) return "";

        const width = Math.max(1, ...rows.map((row) => row.length));
        const normalized = rows.map((row) => Array.from({ length: width }, (_, index) => escapeTableCell(row[index])));
        const separator = Array.from({ length: width }, () => "---");
        return [
            `| ${normalized[0].join(" | ")} |`,
            `| ${separator.join(" | ")} |`,
            ...normalized.slice(1).map((row) => `| ${row.join(" | ")} |`),
        ].join("\n");
    };

    const tableToMatrix = (table) => {
        const rows = Array.from(table.querySelectorAll("tr"));
        const matrix = [];
        rows.forEach((row, rowIndex) => {
            if (!matrix[rowIndex]) matrix[rowIndex] = [];
            let colIndex = 0;
            Array.from(row.querySelectorAll("th, td")).forEach((cell) => {
                while (matrix[rowIndex][colIndex] !== undefined) colIndex++;
                const text = (cell.innerText || cell.textContent || "").replace(/\u00a0/g, " ").replace(/\r?\n/g, " ").trim();
                const rowSpan = Math.max(parseInt(cell.getAttribute("rowspan") || "1", 10), 1);
                const colSpan = Math.max(parseInt(cell.getAttribute("colspan") || "1", 10), 1);
                for (let r = 0; r < rowSpan; r++) {
                    const targetRow = rowIndex + r;
                    if (!matrix[targetRow]) matrix[targetRow] = [];
                    for (let c = 0; c < colSpan; c++) {
                        matrix[targetRow][colIndex + c] = text;
                    }
                }
                colIndex += colSpan;
            });
        });
        const width = Math.max(0, ...matrix.map((row) => row.length));
        return matrix.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ""));
    };

    const tsvToMatrix = (text) => {
        const rows = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        if (rows.at(-1) === "") rows.pop();
        const matrix = rows.map((row) => row.split("\t"));
        const width = Math.max(0, ...matrix.map((row) => row.length));
        const normalized = matrix.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ""));
        for (let r = 0; r < normalized.length; r++) {
            for (let c = 0; c < width; c++) {
                if (normalized[r][c] !== "") continue;
                const left = c > 0 ? normalized[r][c - 1] : "";
                const above = r > 0 ? normalized[r - 1][c] : "";
                if (left && above && left === above) normalized[r][c] = left;
                else if (left && !above) normalized[r][c] = left;
                else if (!left && above) normalized[r][c] = above;
            }
        }
        return normalized;
    };

    const extractTable = () => {
        if (clipboard.html) {
            const doc = new DOMParser().parseFromString(clipboard.html, "text/html");
            const table = doc.querySelector("table");
            if (table) return matrixToMarkdownTable(tableToMatrix(table));
        }
        const trimmedText = clipboard.text.trim();
        if (trimmedText.includes("\t") && trimmedText.includes("\n")) {
            return matrixToMarkdownTable(tsvToMatrix(trimmedText));
        }
        return "";
    };

    const normalizeCodeText = (text) => text
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .split("\n")
        .filter((line, index, lines) => {
            if (line.trim() !== "") return true;
            const previous = lines[index - 1] ?? "";
            const next = lines[index + 1] ?? "";
            return previous.trim() === "" || next.trim() === "";
        })
        .join("\n")
        .replace(/\n+$/g, "");

    const isDuplicateIgnoringWhitespace = (candidate, fallback) => {
        const compactCandidate = candidate.replace(/\s+/g, "");
        const compactFallback = fallback.replace(/\s+/g, "");
        return compactFallback
            && compactCandidate === `${compactFallback}${compactFallback}`;
    };

    const htmlToCodeText = () => {
        if (!clipboard.html) return clipboard.text;
        const doc = new DOMParser().parseFromString(clipboard.html, "text/html");
        const container = doc.querySelector("div[data-vscode-editor-data]") || doc.body;
        const lines = Array.from(container.querySelectorAll("div"))
            .filter((line) => !line.querySelector("div"))
            .map((line) => line.innerText || line.textContent || "")
            .filter((line) => line !== "");
        const htmlText = lines.length > 0 ? lines.join("\n") : (container.innerText || clipboard.text);
        return isDuplicateIgnoringWhitespace(htmlText, clipboard.text) ? clipboard.text : htmlText;
    };

    const isProbablyCode = (text) => {
        const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
        if (!normalized.includes("\n")) return false;
        if (/^\s*[-*+]\s+/m.test(normalized) || /^#{1,6}\s+/m.test(normalized)) return false;
        if (/^\s*(async\s+)?def\s+\w+\s*\([^)]*\)\s*:/m.test(normalized)) return true;
        if (/^\s*(class|if|for|while|try|except|with)\b.*:\s*$/m.test(normalized) && /^\s{2,}\S/m.test(normalized)) return true;
        return /(^|\n)\s*(import|export|const|let|var|function|class|def|from|if|for|while|try|catch|return)\b/.test(normalized)
            || /[{};]\s*\n/.test(normalized)
            || /^\s{2,}\S/m.test(normalized);
    };

    const guessCodeLanguage = (text) => {
        const firstLine = text.trimStart().split("\n")[0] || "";
        if (/^\s*(import|export)\s/.test(text) || /=>|const |let |function /.test(text)) return "javascript";
        if (/^\s*(def|class|from |import )/.test(text) && /:\s*$/.test(firstLine)) return "python";
        if (/^\s*</.test(firstLine)) return "html";
        if (/^\s*[{[]/.test(firstLine)) return "json";
        return "";
    };

    const buildMarkdownLink = async (rawClipboardContent) => {
        let clipboardContent = rawClipboardContent.trim();
        if (clipboardContent.includes("\n") || clipboardContent.includes("\r")) {
            return clipboardContent;
        }

        clipboardContent = clipboardContent.replace(/^["']|["']$/g, "");
        const originalClipboardContent = clipboardContent;
        const normalizedClipboardContent = clipboardContent.replace(/\\/g, "/");

        let linkText = "Link";
        let linkUrl = clipboardContent;
        let localPathForEmbed = null;
        let shouldBuildOpenPathLink = true;

        const getLastPathSegment = (pathValue) => {
            const normalizedPath = pathValue.replace(/\\/g, "/").replace(/\/+$/g, "");
            const segments = normalizedPath.split("/").filter((s) => s.length > 0);
            return segments.length > 0 ? segments[segments.length - 1] : null;
        };

        const normalizePath = (pathValue) => pathValue.replace(/\\/g, "/").replace(/\/+$/g, "");

        const getVaultEmbed = (absolutePath) => {
            const vaultBasePath = normalizePath(app.vault.adapter.basePath || "");
            const normalizedAbsolutePath = normalizePath(absolutePath);

            if (!vaultBasePath || !normalizedAbsolutePath.startsWith(`${vaultBasePath}/`)) {
                return null;
            }

            const relativePath = normalizedAbsolutePath.slice(vaultBasePath.length + 1);
            const vaultFile = app.vault.getAbstractFileByPath(relativePath);

            if (!vaultFile || !normalizedAbsolutePath.endsWith(".excalidraw.md")) {
                return null;
            }

            const embedTarget = vaultFile.name.replace(/\.md$/, "");
            return `![[${embedTarget}|1475]]`;
        };

        let isUrl = false;

        if (clipboardContent.match(/^http/i)) {
            try {
                const urlObj = new URL(clipboardContent);
                const openPathParam = urlObj.searchParams.get("path");
                const filepathParam = urlObj.searchParams.get("filepath");
                const lastSegment = openPathParam
                    ? getLastPathSegment(decodeURIComponent(openPathParam))
                    : filepathParam
                        ? getLastPathSegment(decodeURIComponent(filepathParam))
                        : getLastPathSegment(urlObj.pathname);

                if (lastSegment) {
                    linkText = decodeURIComponent(lastSegment);
                } else {
                    linkText = urlObj.hostname;
                }

                if (openPathParam && urlObj.pathname === "/api/open-path") {
                    localPathForEmbed = decodeURIComponent(openPathParam);
                    shouldBuildOpenPathLink = false;
                } else if (filepathParam && urlObj.pathname === "/") {
                    localPathForEmbed = decodeURIComponent(filepathParam);
                    shouldBuildOpenPathLink = false;
                } else {
                    isUrl = true;
                }
            } catch (e) {
                // パースエラーの場合はファイルパスとして扱う
            }
        }

        if (!isUrl && shouldBuildOpenPathLink) {
            const lastSegment = getLastPathSegment(normalizedClipboardContent);
            if (lastSegment) {
                linkText = lastSegment;
                linkUrl = `http://localhost:8001/api/open-path?path=${encodeURIComponent(originalClipboardContent)}`;
            }
        }

        // ユーザーに表示用テキストの入力を促す
        let userInputText = null;
        try {
            // ダイアログ表示後にテキストボックスの内容を全選択状態にする
            if (typeof document !== "undefined") {
                setTimeout(() => {
                    const activeInput = document.activeElement;
                    if (activeInput && (activeInput.tagName === "INPUT" || activeInput.tagName === "TEXTAREA")) {
                        activeInput.select();
                    }
                }, 50);
            }
            userInputText = await tp.system.prompt("リンクの表示テキストを入力してください:", linkText);
        } catch (e) {
            // キャンセルされた場合はフォールバック
        }

        if (userInputText !== null && userInputText !== undefined && userInputText.trim() !== "") {
            linkText = userInputText;
        }

        let markdown = `[${linkText}](${linkUrl})`;
        const vaultEmbedSourcePath = localPathForEmbed || (!isUrl ? originalClipboardContent : null);
        const vaultEmbed = vaultEmbedSourcePath ? getVaultEmbed(vaultEmbedSourcePath) : null;
        if (vaultEmbed) {
            markdown += `\n\n${vaultEmbed}`;
        }

        return markdown;
    };

    const tableMarkdown = extractTable();
    if (tableMarkdown) return tableMarkdown;

    if (clipboard.source === "vscode" || isProbablyCode(clipboard.text)) {
        const codeText = normalizeCodeText(htmlToCodeText());
        const language = guessCodeLanguage(codeText);
        return `\`\`\`${language}\n${codeText}\n\`\`\``;
    }

    return await buildMarkdownLink(clipboard.text);
};

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

// リネーム時に一つの拡張子として扱う複合拡張子。
// 先に長い拡張子を判定して、`.excalidraw` や `.drawio` が入力欄に残らないようにする。
const splitFileNameForRename = (fileName) => {
    const compoundExtensions = [".excalidraw.md", ".excalidraw", ".drawio.svg", ".dio.svg", ".drawio"];
    const lowerFileName = String(fileName || "").toLowerCase();
    const compoundExtension = compoundExtensions.find((extension) => lowerFileName.endsWith(extension));

    if (compoundExtension) {
        return {
            extension: String(fileName).slice(-compoundExtension.length),
            baseName: String(fileName).slice(0, -compoundExtension.length),
        };
    }

    const dotIndex = String(fileName || "").lastIndexOf(".");
    if (dotIndex > 0) {
        return {
            extension: String(fileName).slice(dotIndex),
            baseName: String(fileName).slice(0, dotIndex),
        };
    }

    return { extension: "", baseName: String(fileName || "") };
};

// Define the commands to register
const commands = [
    {
        id: "custom:toggle-mindmap-basic",
        name: "Toggle Mindmap (Basic)",
        callback: async () => {
            await toggleMindmapBasic();
        }
    },
    {
        id: "custom:reload-displayed-markdown-and-sidebars",
        name: "表示中のMarkdownとサイドバーを再読み込み",
        callback: reloadDisplayedMarkdownAndSidebars,
    },
    {
        id: "custom:move-moc-files",
        name: "MOCファイルを移動 (Move MOC Files)",
        callback: async () => {
            await moveMocFiles();
        }
    },
    {
        id: "custom:callout-important",
        name: "Callout Important",
        editorCallback: (editor) => {
            const cursor = editor.getCursor("from");
            editor.replaceSelection("> [!important] \n> Contents");
            editor.setSelection(
                { line: cursor.line + 1, ch: 2 },
                { line: cursor.line + 1, ch: 10 }
            );
        }
    },
    {
        id: "custom:callout-warning",
        name: "Callout Warning",
        editorCallback: (editor) => {
            const cursor = editor.getCursor("from");
            editor.replaceSelection("> [!warning] \n> Contents");
            editor.setSelection(
                { line: cursor.line + 1, ch: 2 },
                { line: cursor.line + 1, ch: 10 }
            );
        }
    },
    {
        id: "custom:callout-danger",
        name: "Callout Danger",
        editorCallback: (editor) => {
            const cursor = editor.getCursor("from");
            editor.replaceSelection("> [!Danger] \n> Contents");
            editor.setSelection(
                { line: cursor.line + 1, ch: 2 },
                { line: cursor.line + 1, ch: 10 }
            );
        }
    },
    {
        id: "custom:callout-note",
        name: "Callout Note",
        editorCallback: (editor) => {
            const cursor = editor.getCursor("from");
            editor.replaceSelection("> [!note] \n> Contents");
            editor.setSelection(
                { line: cursor.line + 1, ch: 2 },
                { line: cursor.line + 1, ch: 10 }
            );
        }
    },
    {
        id: "custom:from-clipboard",
        name: "From Clipboard",
        editorCallback: async (editor) => {
            editor.replaceSelection(await fromClipboard());
        }
    },
    {
        id: "custom:smart-focus-right",
        name: "Smart Focus Right",
        callback: () => {
            const getPaneCount = () => {
                let count = 0;
                const traverse = (node) => {
                    if (node.type === 'tabs') {
                        count++;
                    } else if (node.children) {
                        node.children.forEach(traverse);
                    }
                };
                traverse(app.workspace.rootSplit);
                return count;
            };

            if (getPaneCount() <= 1) {
                app.commands.executeCommandById("workspace:split-vertical");
            } else {
                app.commands.executeCommandById("editor:focus-right");
            }
        }
    },
    {
        id: "custom:smart-focus-left",
        name: "Smart Focus Left",
        callback: () => {
            const getPaneCount = () => {
                let count = 0;
                const traverse = (node) => {
                    if (node.type === 'tabs') {
                        count++;
                    } else if (node.children) {
                        node.children.forEach(traverse);
                    }
                };
                traverse(app.workspace.rootSplit);
                return count;
            };

            if (getPaneCount() <= 1) {
                app.commands.executeCommandById("workspace:split-vertical"); 
            } else {
                app.commands.executeCommandById("editor:focus-left");
            }
        }
    },
    {
        id: "custom:open-folder-in-browser",
        name: "Open Folder in Browser",
        callback: () => {
            // 現在のアクティブファイルを取得
            const activeFile = app.workspace.getActiveFile();
            if (!activeFile) {
                new Notice("No active file");
                return;
            }
            
            // 親フォルダパスを取得
            const folderPath = activeFile.parent ? activeFile.parent.path : "";
            
            // URLを構築して開く
            const url = `http://localhost:5001/view/obsidian-dagnetz/${folderPath}`;
            window.open(url, "_blank");
        }
    },
    {
        id: "custom:insert-datetime",
        name: "Insert Date and Time",
        editorCallback: (editor) => {
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');
            const seconds = String(now.getSeconds()).padStart(2, '0');
            const dateString = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
            editor.replaceSelection(dateString);
        }
    },
    {
        id: "custom:rename-active-file",
        name: "Rename Active File",
        callback: async () => {
            const activeFile = app.workspace.getActiveFile();
            if (!activeFile) {
                new Notice("No active file");
                return;
            }

            // Obsidianのモジュールを取得（Templater経由などでアクセス）
            // const { Modal, Setting, Notice } = ...
            // ランタイムでrequireが使えるか確認、使えない場合はプラグインから取得などを試みる
            let obsidianModule;
            try {
                obsidianModule = require("obsidian");
            } catch (e) {
                // Fallback for some environments
                obsidianModule = app.plugins.plugins["templater-obsidian"]?.obsidian;
            }
            
            if (!obsidianModule) {
                console.error("Obsidian module not found");
                new Notice("Error: Obsidian module not found");
                return;
            }
            const { Modal, Setting, Notice } = obsidianModule;

            class RenameModal extends Modal {
                constructor(app, file) {
                    super(app);
                    this.file = file;
                    this.extension = "";
                    this.baseName = "";
                    this.parseFileName(file.name);
                }

                parseFileName(fileName) {
                    const parts = splitFileNameForRename(fileName);
                    this.extension = parts.extension;
                    this.baseName = parts.baseName;
                }

                onOpen() {
                    const { contentEl } = this;
                    contentEl.empty();
                    contentEl.addClass("rename-modal");

                    contentEl.createEl("h2", { text: "ファイル名を変更" });

                    let newName = this.baseName;

                    new Setting(contentEl)
                        .setName("新しいファイル名")
                        .setDesc(`拡張子: ${this.extension}`)
                        .addText((text) =>
                            text
                                .setValue(this.baseName)
                                .onChange((value) => {
                                    newName = value;
                                })
                        );

                    const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
                    
                    const saveButton = buttonContainer.createEl("button", { text: "保存", cls: "mod-cta" });
                    saveButton.addEventListener("click", async () => {
                        await this.renameFile(newName);
                    });

                    const cancelButton = buttonContainer.createEl("button", { text: "キャンセル" });
                    cancelButton.style.setProperty("color", "#111111", "important");
                    cancelButton.style.setProperty("-webkit-text-fill-color", "#111111", "important");
                    cancelButton.addEventListener("click", () => {
                        this.close();
                    });

                    // Enterキーで保存
                    contentEl.addEventListener("keydown", (e) => {
                        if (e.key === "Enter") {
                            if (e.isComposing) return; // IME変換中のリターンキーを無視
                            e.preventDefault();
                            this.renameFile(newName);
                        }
                    });
                     // Inputにフォーカス
                    setTimeout(() => {
                        const input = contentEl.querySelector("input[type='text']");
                        if (input) {
                            input.focus();
                            input.select();
                        }
                    }, 50);
                }

                async renameFile(newName) {
                    if (!newName) {
                        new Notice("ファイル名を入力してください");
                        return;
                    }
                    
                    const newPath = (this.file.parent ? this.file.parent.path + "/" : "") + newName + this.extension;
                    
                    try {
                        await app.fileManager.renameFile(this.file, newPath);
                        new Notice(`Renamed to ${newName}${this.extension}`);
                        this.close();
                    } catch (error) {
                        new Notice(`Error: ${error.message}`);
                        console.error(error);
                    }
                }

                onClose() {
                    const { contentEl } = this;
                    contentEl.empty();
                }
            }

            new RenameModal(app, activeFile).open();
        }
    },
    {
        id: "custom:delete-active-file",
        name: "Delete Active File",
        callback: async () => {
            const activeFile = app.workspace.getActiveFile();
            if (!activeFile) {
                new Notice("No active file");
                return;
            }

            // Get Obsidian modules
            let obsidianModule;
            try {
                obsidianModule = require("obsidian");
            } catch (e) {
                obsidianModule = app.plugins.plugins["templater-obsidian"]?.obsidian;
            }
            if (!obsidianModule) {
                new Notice("Error: Obsidian module not found");
                return;
            }
            const { Modal, Setting, Notice, ButtonComponent, TFile } = obsidianModule;

            // Helper to get related files (all non-Markdown attachments which are
            // exclusively referenced by the file being deleted)
            const getRelatedFiles = (file) => {
                // Support both .md and .excalidraw.md
                if (file.extension !== "md") return [];
                
                const cache = app.metadataCache.getFileCache(file);
                if (!cache) return [];

                const related = [];

                // common_image は共有資産なので、削除候補には含めない。
                const isInCommonImage = (target) => {
                    const normalizedPath = target.path.replace(/\\/g, "/");
                    return normalizedPath === "01_data/common_image" ||
                        normalizedPath.startsWith("01_data/common_image/");
                };

                // 削除元以外の Markdown ノートから参照されている添付は残す。
                // embeds/links の両方をリンク解決するため、通常リンクの msg/pptx 等も対象になる。
                const isReferencedByAnotherNote = (target) => {
                    return app.vault.getMarkdownFiles().some(sourceFile => {
                        if (sourceFile.path === file.path) return false;

                        const sourceCache = app.metadataCache.getFileCache(sourceFile);
                        if (!sourceCache) return false;

                        const sourceReferences = [
                            ...(sourceCache.embeds || []),
                            ...(sourceCache.links || [])
                        ];

                        return sourceReferences.some(ref => {
                            const resolved = app.metadataCache.getFirstLinkpathDest(ref.link, sourceFile.path);
                            return resolved?.path === target.path;
                        });
                    });
                };

                const uniquePaths = new Set();

                // embedsとlinks両方を処理（通常のリンク[[file.msg]]も添付ファイルとして扱う）
                const references = [...(cache.embeds || []), ...(cache.links || [])];

                for (const ref of references) {
                    const linkPath = ref.link;
                    const linkedFile = app.metadataCache.getFirstLinkpathDest(linkPath, file.path);
                    
                    // .msg/.pptx を含む、Markdown 以外のあらゆる添付ファイルを対象にする。
                    if (linkedFile &&
                        linkedFile.extension.toLowerCase() !== "md" &&
                        !isInCommonImage(linkedFile) &&
                        !isReferencedByAnotherNote(linkedFile)) {
                        if (!uniquePaths.has(linkedFile.path)) {
                            uniquePaths.add(linkedFile.path);
                            related.push(linkedFile);
                        }
                    }
                }
                return related;
            };


            const relatedFiles = getRelatedFiles(activeFile);

            class ConfirmDeleteModal extends Modal {
                constructor(app, title, message, confirmText = "削除") {
                    super(app);
                    this.title = title;
                    this.message = message;
                    this.confirmText = confirmText;
                    this.resolve = null;
                    this.resolved = false;
                }

                openAndWait() {
                    return new Promise((resolve) => {
                        this.resolve = resolve;
                        this.open();
                    });
                }

                finish(result) {
                    if (this.resolved) return;
                    this.resolved = true;
                    if (this.resolve) this.resolve(result);
                    this.close();
                }

                onOpen() {
                    const { contentEl } = this;
                    contentEl.empty();
                    contentEl.createEl("h2", { text: this.title });
                    for (const line of this.message.split("\n")) {
                        contentEl.createEl("p", { text: line });
                    }

                    const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
                    buttonContainer.style.display = "flex";
                    buttonContainer.style.justifyContent = "flex-end";
                    buttonContainer.style.gap = "10px";
                    buttonContainer.style.marginTop = "20px";

                    const cancelBtn = new ButtonComponent(buttonContainer)
                        .setButtonText("キャンセル")
                        .onClick(() => this.finish(false));

                    const confirmBtn = new ButtonComponent(buttonContainer)
                        .setButtonText(this.confirmText)
                        .setWarning()
                        .onClick(() => this.finish(true));
                    cancelBtn.buttonEl.style.backgroundColor = "var(--interactive-accent)";
                    cancelBtn.buttonEl.style.color = "#111111";
                    cancelBtn.buttonEl.style.webkitTextFillColor = "#111111";
                    confirmBtn.buttonEl.style.backgroundColor = "#e93f33";
                    confirmBtn.buttonEl.style.color = "white";
                    cancelBtn.buttonEl.tabIndex = 0;
                    confirmBtn.buttonEl.tabIndex = 0;

                    contentEl.addEventListener("keydown", (e) => {
                        const active = document.activeElement;
                        if (e.key === "Tab" && (active === cancelBtn.buttonEl || active === confirmBtn.buttonEl)) {
                            e.preventDefault();
                            const next = active === cancelBtn.buttonEl ? confirmBtn.buttonEl : cancelBtn.buttonEl;
                            next.focus();
                        }
                        if (e.key === "Escape") {
                            e.preventDefault();
                            this.finish(false);
                        }
                        if (e.key === "Enter") {
                            if (active === cancelBtn.buttonEl || active === confirmBtn.buttonEl) {
                                e.preventDefault();
                                active.click();
                            }
                        }
                    });

                    setTimeout(() => cancelBtn.buttonEl.focus(), 50);
                }

                onClose() {
                    if (!this.resolved) {
                        this.resolved = true;
                        if (this.resolve) this.resolve(false);
                    }
                    this.contentEl.empty();
                }
            }

            class DeleteFileModal extends Modal {
                constructor(app, file, relatedFiles) {
                    super(app);
                    this.file = file;
                    this.relatedFiles = relatedFiles;
                    // 選択された関連ファイルのパスを格納（デフォルトは空=未選択）
                    this.selectedFiles = new Set();
                }

                onOpen() {
                    const { contentEl } = this;
                    contentEl.empty();
                    contentEl.addClass("delete-file-modal");

                    // Title
                    contentEl.createEl("h2", { text: "ファイルの削除" });

                    // Message
                    const msgDiv = contentEl.createDiv();
                    msgDiv.createEl("p", { text: `"${this.file.name}" を削除しても良いですか？` });
                    msgDiv.createEl("p", { text: "システムのゴミ箱に移動します。" });

                    // 関連ファイルのチェックボックスリスト
                    if (this.relatedFiles.length > 0) {
                        contentEl.createEl("h3", { text: "関連するファイルも削除する" });
                        
                        const listContainer = contentEl.createDiv({ cls: "delete-attachment-list" });
                        listContainer.style.maxHeight = "250px";
                        listContainer.style.overflowY = "auto";
                        listContainer.style.border = "1px solid var(--background-modifier-border)";
                        listContainer.style.padding = "10px";
                        listContainer.style.borderRadius = "4px";
                        listContainer.style.marginBottom = "15px";

                        // すべて選択チェックボックス
                        const selectAllContainer = listContainer.createDiv({ cls: "attachment-item" });
                        selectAllContainer.style.display = "flex";
                        selectAllContainer.style.alignItems = "center";
                        selectAllContainer.style.marginBottom = "8px";
                        selectAllContainer.style.borderBottom = "1px solid var(--background-modifier-border)";
                        selectAllContainer.style.paddingBottom = "8px";

                        const selectAllCb = selectAllContainer.createEl("input", { type: "checkbox" });
                        selectAllCb.type = "checkbox";
                        selectAllCb.checked = false;
                        const selectAllLabel = selectAllContainer.createSpan({ text: "すべて選択" });
                        selectAllLabel.style.marginLeft = "8px";
                        selectAllLabel.style.fontWeight = "bold";

                        const checkBoxes = [];

                        // すべて選択の動作
                        selectAllCb.onchange = () => {
                            const checked = selectAllCb.checked;
                            checkBoxes.forEach(cb => {
                                cb.checked = checked;
                                const path = cb.getAttribute("data-path");
                                if (path) {
                                    if (checked) this.selectedFiles.add(path);
                                    else this.selectedFiles.delete(path);
                                }
                            });
                        };

                        // 各ファイルのチェックボックス
                        this.relatedFiles.forEach(f => {
                            const item = listContainer.createDiv({ cls: "attachment-item" });
                            item.style.display = "flex";
                            item.style.alignItems = "center";
                            item.style.padding = "4px 0";

                            const cb = item.createEl("input", { type: "checkbox" });
                            cb.type = "checkbox";
                            cb.checked = false;
                            cb.setAttribute("data-path", f.path);
                            checkBoxes.push(cb);

                            cb.onchange = () => {
                                if (cb.checked) this.selectedFiles.add(f.path);
                                else this.selectedFiles.delete(f.path);
                                
                                // すべて選択の状態を更新
                                selectAllCb.checked = checkBoxes.every(c => c.checked);
                                selectAllCb.indeterminate = checkBoxes.some(c => c.checked) && !checkBoxes.every(c => c.checked);
                            };

                            const label = item.createSpan({ text: f.name });
                            label.style.marginLeft = "8px";
                            label.style.flexGrow = "1";
                            label.style.overflow = "hidden";
                            label.style.textOverflow = "ellipsis";
                            label.style.whiteSpace = "nowrap";
                        });
                    }

                    // Buttons
                    const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
                    buttonContainer.style.display = "flex";
                    buttonContainer.style.justifyContent = "flex-end";
                    buttonContainer.style.gap = "10px";
                    buttonContainer.style.marginTop = "20px";

                    const cancelBtn = new ButtonComponent(buttonContainer)
                        .setButtonText("キャンセル")
                        .onClick(() => {
                            this.close();
                        });
                    cancelBtn.buttonEl.style.backgroundColor = "var(--interactive-accent)";
                    cancelBtn.buttonEl.style.color = "#111111";
                    cancelBtn.buttonEl.style.webkitTextFillColor = "#111111";

                    const deleteBtn = new ButtonComponent(buttonContainer)
                        .setButtonText("削除")
                        .setWarning() // Red button
                        .onClick(async () => {
                            await this.deleteFile();
                        });
                    // Style the delete button to match screenshot (Red/Salmon)
                    deleteBtn.buttonEl.style.backgroundColor = "#e93f33";
                    deleteBtn.buttonEl.style.color = "white";
                    cancelBtn.buttonEl.tabIndex = 0;
                    deleteBtn.buttonEl.tabIndex = 0;

                    contentEl.addEventListener("keydown", (e) => {
                        const active = document.activeElement;
                        if (e.key === "Tab" && (active === cancelBtn.buttonEl || active === deleteBtn.buttonEl)) {
                            e.preventDefault();
                            const next = active === cancelBtn.buttonEl ? deleteBtn.buttonEl : cancelBtn.buttonEl;
                            next.focus();
                        }
                        if (e.key === "Escape") {
                            e.preventDefault();
                            this.close();
                        }
                        if (e.key === "Enter") {
                            if (active === cancelBtn.buttonEl || active === deleteBtn.buttonEl) {
                                e.preventDefault();
                                active.click();
                            }
                        }
                    });

                    // キーボード操作時に Enter が誤って削除にならないよう、キャンセルを初期フォーカスにする。
                    setTimeout(() => {
                        cancelBtn.buttonEl.focus();
                    }, 100);
                }

                async deleteFile() {
                    const confirmed = await new ConfirmDeleteModal(
                        app,
                        "最終確認",
                        `本当に "${this.file.name}" を消しますか？\nシステムのゴミ箱に移動します。`,
                        "本当に消す"
                    ).openAndWait();
                    if (!confirmed) {
                        this.close();
                        return;
                    }

                    try {
                        // 選択された関連ファイルを削除
                        if (this.selectedFiles.size > 0) {
                            let deletedCount = 0;
                            for (const f of this.relatedFiles) {
                                if (this.selectedFiles.has(f.path)) {
                                    await app.vault.trash(f, true);
                                    deletedCount++;
                                }
                            }
                            if (deletedCount > 0) {
                                new Notice(`${deletedCount}個の関連ファイルを削除しました`);
                            }
                        }

                        // Delete main file
                        await app.vault.trash(this.file, true);
                        new Notice(`${this.file.name} を削除しました`);
                        this.close();
                    } catch (error) {
                        new Notice(`Error: ${error.message}`);
                        console.error(error);
                    }
                }

                onClose() {
                    const { contentEl } = this;
                    contentEl.empty();
                }
            }


            new DeleteFileModal(app, activeFile, relatedFiles).open();
        }
    },
    {
        id: "custom:add-drawio-diagram",
        name: "drawioの図の追加 (Add Draw.io Diagram)",
        editorCallback: async (editor) => {
            const activeFile = app.workspace.getActiveFile();
            if (!activeFile) {
                new Notice("No active file");
                return;
            }

            // 今日の日付からフォルダパスを構築
            const now = new Date();
            const yyyy = now.getFullYear();
            const mm = String(now.getMonth() + 1).padStart(2, '0');
            const dd = String(now.getDate()).padStart(2, '0');
            const folderPath = `01_data/${yyyy}/${mm}/${dd}`;

            // フォルダが存在しない場合は作成
            if (!await app.vault.adapter.exists(folderPath)) {
                await app.vault.createFolder(folderPath);
            }

            // アクティブファイル名を初期値として、作成する図の名前を入力
            const defaultBaseName = activeFile.basename || activeFile.name.substring(0, activeFile.name.lastIndexOf("."));
            // ダイアログ表示後、初期値を全選択してすぐ上書きできるようにする
            if (typeof document !== "undefined") {
                setTimeout(() => {
                    const activeInput = document.activeElement;
                    if (activeInput && (activeInput.tagName === "INPUT" || activeInput.tagName === "TEXTAREA")) {
                        activeInput.select();
                    }
                }, 50);
            }
            const inputName = await tp.system.prompt("Draw.ioの図の名前", defaultBaseName);
            if (inputName === null) {
                return;
            }

            // 拡張子の二重付与と、ファイルパスとして使用できない文字を避ける
            let baseName = inputName.trim() || defaultBaseName;
            baseName = baseName
                .replace(/\.(?:drawio|dio)(?:\.svg)?$/i, "")
                .replace(/[\\/:*?"<>|#[\]]/g, "_")
                .trim();
            if (!baseName) {
                new Notice("有効な図の名前を入力してください");
                return;
            }
            
            // ファイルの重複確認と連番付与
            let filePath = `${folderPath}/${baseName}.drawio.svg`;
            let counter = 1;
            while (await app.vault.adapter.exists(filePath)) {
                filePath = `${folderPath}/${baseName}_${counter}.drawio.svg`;
                counter++;
            }

            // 作成するファイル名（拡張子付き、連番反映後）
            const createdFileName = filePath.split("/").pop();

            // 最小限の Draw.io 用空SVGデータ
            const drawioSvgTemplate = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="1px" height="1px" viewBox="-0.5 -0.5 1 1" content="&lt;mxfile host=&quot;Obsidian&quot;&gt;&lt;diagram id=&quot;0&quot; name=&quot;Page-1&quot;&gt;&lt;mxGraphModel&gt;&lt;root&gt;&lt;mxCell id=&quot;0&quot;/&gt;&lt;mxCell id=&quot;1&quot; parent=&quot;0&quot;/&gt;&lt;/root&gt;&lt;/mxGraphModel&gt;&lt;/diagram&gt;&lt;/mxfile&gt;"><defs/><g/></svg>`;

            try {
                // ファイルを作成
                await app.vault.create(filePath, drawioSvgTemplate);
                new Notice(`Draw.ioの図を作成しました: ${createdFileName}`);
                
                // エディタに埋め込みリンクを挿入
                editor.replaceSelection(`![[${createdFileName}]]`);
            } catch (error) {
                new Notice(`図の作成エラー: ${error.message}`);
                console.error(error);
            }
        }
    }
];

// Register commands if they don't exist, or update them if they do
if (app.commands && typeof app.commands.addCommand === "function") {
    commands.forEach(cmd => {
        const existing = typeof app.commands.findCommand === "function" ? app.commands.findCommand(cmd.id) : null;
        if (!existing) {
            app.commands.addCommand(cmd);
            console.log(`Registered command: ${cmd.id}`);
        } else {
            existing.callback = cmd.callback;
            existing.editorCallback = cmd.editorCallback;
            console.log(`Updated command callback: ${cmd.id}`);
        }
    });
}

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
    const embedEl = imgEl.closest(".internal-embed, span[src], div[src]");
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
    const imgEl = e.target?.closest?.("img");
    if (imgEl) {
        const imageFile = getFileFromImageElement(imgEl);
        if (imageFile?.path) return { file: imageFile, imgEl };
    }

    const embedEl = e.target?.closest?.(".internal-embed, span[src], div[src], .excalidraw-svg, .excalidraw-embedded-img, [filesource], [fileSource]");
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

    if (!isImageFile(file) && !isDrawioEditableFile(file) && !file?.name?.toLowerCase().endsWith(".excalidraw.md")) return;

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
    if (file.name.toLowerCase().endsWith(".excalidraw.md")) {
        e.stopImmediatePropagation();
    }

    const menu = new MenuClass();
    // ノート内からの操作では、添付ファイル削除時にこのノートの埋め込み記法も消す。
    const sourceFile = activeFile?.extension === "md" ? activeFile : null;
    addClipboardImageMenuItems(menu, file, sourceFile);

    // メニュー項目を最上部へ prepend して並び替え
    setTimeout(() => {
        if (menu.dom) {
            const items = Array.from(menu.dom.querySelectorAll(".menu-item"));
            const copyImageItem = items.find(el => el.textContent.includes("画像をクリップボードにコピー"));
            const moveItem = items.find(el => el.textContent.includes("共通画像フォルダへ移動"));
            const compareItem = items.find(el => el.textContent.includes("クリップボードの画像との比較"));
            const replaceItem = items.find(el => el.textContent.includes("クリップボードの画像と差し替え"));
            const drawioItem = items.find(el => el.textContent.includes("drawioで編集"));
            if (replaceItem) menu.dom.prepend(replaceItem);
            if (compareItem) menu.dom.prepend(compareItem);
            if (moveItem) menu.dom.prepend(moveItem);
            if (drawioItem) menu.dom.prepend(drawioItem);
            if (copyImageItem) menu.dom.prepend(copyImageItem);
        }
    }, 50);

    menu.showAtMouseEvent(e);
};

// 画像以外（PDF、Office文書、音声など）のノート内埋め込みにも削除メニューを追加する。
const handleMarkdownAttachmentContextMenu = (e) => {
    // 画像は上の専用メニューで処理する。
    if (e.target?.closest?.("img")) return;

    const markdownEl = e.target?.closest?.(".markdown-preview-view, .markdown-source-view, .cm-content");
    // Reading view と Live Preview の両方で埋め込み要素を拾う。
    const embedEl = e.target?.closest?.(".internal-embed, .cm-embed-block, [data-path]");
    const sourceFile = app.workspace.getActiveFile();
    if (!markdownEl || !embedEl || sourceFile?.extension !== "md") return;

    const embedSource = embedEl.getAttribute("src") || embedEl.dataset?.src || embedEl.dataset?.path || "";
    const linkpath = embedSource.split("|")[0].split("#")[0];
    const file = app.metadataCache.getFirstLinkpathDest(linkpath, sourceFile.path);
    if (!isNonMarkdownAttachmentFile(file) || isImageFile(file) || isDrawioEditableFile(file)) return;

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
    menu.showAtMouseEvent(e);
};

const getExcalidrawFileFromPointerEvent = (e) => {
    const activeFile = app.workspace.getActiveFile();
    const elements = (typeof e.composedPath === "function" ? e.composedPath() : [e.target])
        .filter(node => node && node.nodeType === Node.ELEMENT_NODE);

    for (const element of elements) {
        if (element.matches?.("img")) {
            const imageFile = getFileFromImageElement(element);
            if (imageFile && (imageFile.name?.toLowerCase().endsWith(".excalidraw.md") || isExcalidrawBackedMarkdown(imageFile))) {
                return imageFile;
            }
        }

        const source = element.getAttribute?.("src")
            || element.dataset?.src
            || (typeof getFigureEmbedSource === "function" ? getFigureEmbedSource(element, activeFile?.path || "") : "");
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



// Obsidianモジュールからグローバルに必要なクラスを取得
let obsidianLib;
try {
    obsidianLib = require("obsidian");
} catch (e) {
    obsidianLib = app.plugins.plugins["templater-obsidian"]?.obsidian;
}
const Modal = obsidianLib?.Modal || class {};
const Setting = obsidianLib?.Setting;
const Notice = obsidianLib?.Notice || (typeof window !== 'undefined' && window.Notice) || (typeof global !== 'undefined' && global.Notice) || class {};

/**
 * 画像リネーム用のモーダルダイアログ
 * - 拡張子は表示せず、ベース名のみを編集可能にする
 * - ダイアログ表示時、入力ボックスのテキストを全選択
 * - 保存時に元の拡張子を再結合してリネーム実行
 **/
class ImageRenameModal extends Modal {
    constructor(app, file, title = "画像のリネーム") {
        super(app);
        this.file = file;
        this.title = title;
        this.extension = "";
        this.baseName = "";
        this.parseFileName(file.name);
    }

    parseFileName(fileName) {
        const parts = splitFileNameForRename(fileName);
        this.extension = parts.extension;
        this.baseName = parts.baseName;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("rename-modal");

        contentEl.createEl("h2", { text: this.title });

        let newName = this.baseName;

        new Setting(contentEl)
            .setName("新しいファイル名")
            .addText((text) =>
                text
                    .setValue(this.baseName)
                    .onChange((value) => {
                        newName = value;
                    })
            );

        const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
        
        const saveButton = buttonContainer.createEl("button", { text: "保存", cls: "mod-cta" });
        saveButton.addEventListener("click", async () => {
            await this.renameFile(newName);
        });

        const cancelButton = buttonContainer.createEl("button", { text: "キャンセル" });
        cancelButton.style.setProperty("color", "#111111", "important");
        cancelButton.style.setProperty("-webkit-text-fill-color", "#111111", "important");
        cancelButton.addEventListener("click", () => {
            this.close();
        });

        // Enterキーで保存
        contentEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                if (e.isComposing) return; // IME変換中のリターンキーを無視
                e.preventDefault();
                this.renameFile(newName);
            }
        });

        // Inputにフォーカスし全選択
        setTimeout(() => {
            const input = contentEl.querySelector("input[type='text']");
            if (input) {
                input.focus();
                input.select();
            }
        }, 50);
    }

    async renameFile(newName) {
        if (!newName) {
            new Notice("ファイル名を入力してください");
            return;
        }
        
        const newPath = (this.file.parent ? this.file.parent.path + "/" : "") + newName + this.extension;
        
        try {
            const oldPath = this.file.path;

            // 共通画像フォルダ内で同名ファイルにリネームしようとしている場合、上書きマージする
            const isCommonImageDir = this.file.parent && this.file.parent.path === "01_data/common_image";
            if (isCommonImageDir) {
                const existingFile = app.vault.getAbstractFileByPath(newPath);
                if (existingFile && existingFile.path !== oldPath) {
                    const overwriteConfirmed = window.confirm(`既に共通画像フォルダに同名ファイル "${newName}${this.extension}" が存在します。\n上書きしてよろしいですか？（リンクはマージされます）`);
                    if (!overwriteConfirmed) {
                        return;
                    }
                    await app.vault.trash(existingFile, true);
                }
            }

            await app.fileManager.renameFile(this.file, newPath);
            
            // リネームに成功した場合、マークダウンプレビュー側の選択状態のパスも更新する
            if (window._selectedMarkdownImageFilePath === oldPath) {
                window._selectedMarkdownImageFilePath = newPath;
            }
            
            new Notice(`Renamed to ${newName}${this.extension}`);
            this.close();
        } catch (error) {
            new Notice(`Error: ${error.message}`);
            console.error(error);
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// Sidebar Explorer が呼ぶ Obsidian 標準の promptForFileRename を、
// 複合拡張子に対応したこのモーダルへ接続する。
window._customPromptForFileRename = (file) => {
    if (!file) return;
    new ImageRenameModal(app, file, "ファイル名").open();
};

// Sidebar Explorer以外（標準ファイルエクスプローラー等）からのRenameも同じ処理に統一する。
if (!window._customPromptForFileRenameOriginal && typeof app.fileManager?.promptForFileRename === "function") {
    window._customPromptForFileRenameOriginal = app.fileManager.promptForFileRename.bind(app.fileManager);
    app.fileManager.promptForFileRename = (file) => {
        if (typeof window._customPromptForFileRename === "function") {
            return window._customPromptForFileRename(file);
        }
        return window._customPromptForFileRenameOriginal(file);
    };
}

/**
 * 画像用リネームモーダルを開くヘルパー関数
 **/
const openImageRenameModal = (file) => {
    new ImageRenameModal(app, file).open();
};

/**
 * 画像ファイルを共通画像フォルダ（01_data/common_image）へ移動する
 * - ユーザーに最終確認を行う
 * - 移動先フォルダがない場合は自動作成
 * - app.fileManager.renameFile を使って移動（リンクも自動修正）
 **/
const moveToCommonImage = async (file) => {
    if (!file) return;

    const targetDir = "01_data/common_image";
    const newPath = `${targetDir}/${file.name}`;

    const confirmed = window.confirm(`本当に画像 "${file.name}" を共通画像フォルダへ移動しますか？\nこの画像を参照しているリンクも自動的に修正されます。`);
    if (!confirmed) return;

    try {
        // 移動先フォルダが存在しない場合は作成
        const folder = app.vault.getAbstractFileByPath(targetDir);
        if (!folder) {
            await app.vault.createFolder(targetDir);
        }

        const oldPath = file.path;

        // 同名ファイルが移動先にすでに存在するかチェックし、上書きマージする
        const existingFile = app.vault.getAbstractFileByPath(newPath);
        if (existingFile) {
            const overwriteConfirmed = window.confirm(`既に共通画像フォルダに同名ファイル "${file.name}" が存在します。\n上書きしてよろしいですか？（リンクはマージされます）`);
            if (!overwriteConfirmed) {
                return;
            }
            await app.vault.trash(existingFile, true);
        }

        await app.fileManager.renameFile(file, newPath);

        // プレビュー選択中画像パスの同期
        if (window._selectedMarkdownImageFilePath === oldPath) {
            window._selectedMarkdownImageFilePath = newPath;
        }

        new Notice(`"${file.name}" を共通画像フォルダへ移動しました（リンク自動更新）`);
    } catch (error) {
        new Notice(`移動エラー: ${error.message}`);
        console.error(error);
    }
};

/**
 * ファイルを今日のフォルダ（01_data/YYYY/MM/DD）へ移動する
 * - すでに同じ親フォルダにあるかチェック
 * - 移動先フォルダがない場合は自動作成
 * - 同名ファイルが移動先にすでに存在するかチェックし、上書きマージする
 * - app.fileManager.renameFile を使って移動（リンクも自動修正）
 **/
const moveToTodayFolder = async (file) => {
    if (!file) return;

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const targetDir = `01_data/${yyyy}/${mm}/${dd}`;
    const newPath = `${targetDir}/${file.name}`;

    if (file.parent && file.parent.path === targetDir) {
        new Notice("このファイルは既に今日のフォルダにあります");
        return;
    }

    try {
        // 移動先フォルダが存在しない場合は作成
        const folder = app.vault.getAbstractFileByPath(targetDir);
        if (!folder) {
            await app.vault.createFolder(targetDir);
        }

        const oldPath = file.path;

        // 同名ファイルが移動先にすでに存在するかチェックし、上書きマージする
        const existingFile = app.vault.getAbstractFileByPath(newPath);
        if (existingFile) {
            const overwriteConfirmed = window.confirm(`既に今日のフォルダに同名ファイル "${file.name}" が存在します。\n上書きしてよろしいですか？（リンクはマージされます）`);
            if (!overwriteConfirmed) {
                return;
            }
            await app.vault.trash(existingFile, true);
        }

        await app.fileManager.renameFile(file, newPath);

        // プレビュー選択中画像パスの同期
        if (window._selectedMarkdownImageFilePath === oldPath) {
            window._selectedMarkdownImageFilePath = newPath;
        }

        new Notice(`"${file.name}" を今日のフォルダへ移動しました（リンク自動更新）`);
    } catch (error) {
        new Notice(`移動エラー: ${error.message}`);
        console.error(error);
    }
};

/**
 * 指定されたメニュー項目を "Rename" (または "名前を変更") 項目の直後に移動する。
 * "Rename" 項目が存在しない場合は、最上部に配置 (prepend) する。
 **/
const insertAfterRenameOrPrepend = (menu, targetItemText) => {
    const menuEl = menu.menuEl || menu.dom || document.querySelector(".menu");
    if (!menuEl) {
        console.log(`Menu element not found for '${targetItemText}'`);
        return;
    }

    const items = Array.from(menuEl.querySelectorAll(".menu-item"));
    const myItem = items.find(el => el.textContent.includes(targetItemText));
    if (!myItem) {
        console.log(`Target item '${targetItemText}' not found in menu items`);
        return;
    }

    const renameItem = items.find(el => el.textContent.includes("Rename") || el.textContent.includes("名前を変更"));
    if (renameItem) {
        renameItem.parentNode.insertBefore(myItem, renameItem.nextSibling);
        console.log(`Moved '${targetItemText}' after Rename`);
    } else {
        menuEl.prepend(myItem);
        console.log(`Moved '${targetItemText}' to top (Rename not found)`);
    }
};




const handleMarkdownImageRenameKey = (e) => {
    if (e.key.toLowerCase() !== "r" || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;

    const activeEl = document.activeElement;
    if (isTypingTarget(activeEl)) return;
    if (activeEl?.closest?.(".modal, .prompt")) return;

    // Excalidraw編集中の場合はショートカットを無効化
    const activeFile = app.workspace.getActiveFile();
    if (activeFile && activeFile.name.endsWith(".excalidraw.md")) return;

    const activeView = app.workspace.getActiveViewOfType(obsidianLib?.View || window?.obsidian?.View);
    if (activeView && activeView.getViewType() === "excalidraw") return;

    let file = null;

    if (activeFile && isImageFile(activeFile)) {
        file = activeFile;
    } else {
        // 2. マークダウン上で画像が選択されているかチェック
        const selectedPath = window._selectedMarkdownImageFilePath;
        if (selectedPath) {
            file = app.vault.getAbstractFileByPath(selectedPath);
        }
    }

    if (!file?.path) return;

    e.preventDefault();
    e.stopPropagation();

    openImageRenameModal(file);
};

if (window._customMarkdownImageClickListener) {
    document.removeEventListener("click", window._customMarkdownImageClickListener, true);
}
if (window._customMarkdownImageDblClickListener) {
    document.removeEventListener("dblclick", window._customMarkdownImageDblClickListener, true);
}
if (window._customMarkdownImageMouseDownListener) {
    document.removeEventListener("mousedown", window._customMarkdownImageMouseDownListener, true);
}
if (window._customMarkdownImageContextMenuListener) {
    document.removeEventListener("contextmenu", window._customMarkdownImageContextMenuListener, true);
}
if (window._customMarkdownAttachmentContextMenuListener) {
    document.removeEventListener("contextmenu", window._customMarkdownAttachmentContextMenuListener, true);
}
if (window._customExcalidrawPointerDownListener) {
    document.removeEventListener("pointerdown", window._customExcalidrawPointerDownListener, true);
}
if (window._customExcalidrawMouseDownListener) {
    document.removeEventListener("mousedown", window._customExcalidrawMouseDownListener, true);
}
if (window._customExcalidrawRightButtonEndListener) {
    ["pointerup", "mouseup", "auxclick"].forEach(type =>
        document.removeEventListener(type, window._customExcalidrawRightButtonEndListener, true)
    );
}
if (window._customMarkdownImageRenameListener) {
    document.removeEventListener("keydown", window._customMarkdownImageRenameListener, true);
}
window._customMarkdownImageClickListener = handleMarkdownImageClick;
window._customMarkdownImageDblClickListener = handleMarkdownImageDblClick;
window._customMarkdownImageMouseDownListener = handleMarkdownImageMouseDown;
window._customMarkdownImageContextMenuListener = handleMarkdownImageContextMenu;
window._customMarkdownAttachmentContextMenuListener = handleMarkdownAttachmentContextMenu;
window._customMarkdownImageRenameListener = handleMarkdownImageRenameKey;
window._customExcalidrawPointerDownListener = blockExcalidrawPointerDown;
window._customExcalidrawMouseDownListener = blockExcalidrawRightButtonEdit;
window._customExcalidrawRightButtonEndListener = blockExcalidrawRightButtonEdit;
document.addEventListener("click", window._customMarkdownImageClickListener, true);
document.addEventListener("dblclick", window._customMarkdownImageDblClickListener, true);
document.addEventListener("mousedown", window._customMarkdownImageMouseDownListener, true);
document.addEventListener("pointerdown", window._customExcalidrawPointerDownListener, true);
document.addEventListener("mousedown", window._customExcalidrawMouseDownListener, true);
["pointerup", "mouseup", "auxclick"].forEach(type =>
    document.addEventListener(type, window._customExcalidrawRightButtonEndListener, true)
);
document.addEventListener("contextmenu", window._customMarkdownImageContextMenuListener, true);
document.addEventListener("contextmenu", window._customMarkdownAttachmentContextMenuListener, true);
document.addEventListener("keydown", window._customMarkdownImageRenameListener, true);
console.log("Markdown image rename shortcut registered");

// 図の埋め込みラベルは、拡張子を除いた図の名前だけを表示する。
if (window._customFigureEmbedLabelObserver) {
    window._customFigureEmbedLabelObserver.disconnect();
}
if (window._customFigureEmbedLabelTimer) {
    globalThis.clearTimeout(window._customFigureEmbedLabelTimer);
    window._customFigureEmbedLabelTimer = null;
}
if (window._customFigureEmbedResizeObserver) {
    window._customFigureEmbedResizeObserver.disconnect();
}
window._customFigureEmbedResizeObserver = null;
if (typeof ResizeObserver === "function") {
    window._customFigureEmbedResizeObserver = new ResizeObserver((entries) => {
        entries.forEach((entry) => {
            const target = entry.target.closest?.(
                ".excalidraw-svg[data-figure-name], .media-embed[data-figure-name], " +
                ".internal-embed[data-figure-name], .markdown-embed[data-figure-name]",
            );
            if (target) updateFigureEmbedWidth(target);
        });
    });
}
applyFigureEmbedDisplayNames();
if (typeof MutationObserver !== "undefined" && document.body) {
    window._customFigureEmbedLabelObserver = new MutationObserver(() => {
        if (window._customFigureEmbedLabelTimer) {
            globalThis.clearTimeout(window._customFigureEmbedLabelTimer);
        }
        window._customFigureEmbedLabelTimer = globalThis.setTimeout(() => {
            window._customFigureEmbedLabelTimer = null;
            applyFigureEmbedDisplayNames();
        }, 50);
    });
    window._customFigureEmbedLabelObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "filesource", "fileSource", "data-excalidraw-source", "data-src", "data-path"],
    });

    // Excalidrawが非同期で画像を生成するため、生成直後にも幅を再計測する。
    [0, 50, 250, 800].forEach((delay) => {
        globalThis.setTimeout(() => applyFigureEmbedDisplayNames(), delay);
    });
}

/**
 * Excalidraw編集中にObsidianのコマンドが優先実行されるのを防ぐ
 * 
 * 方針: DOMイベントの stopPropagation ではなく、Obsidianのコマンドコールバック自体を
 * モンキーパッチして Excalidraw 編集中は実行しないようにする。
 * こうすることでキーイベントは正常に Excalidraw まで伝播し、
 * Excalidraw のショートカットが確実に動作する。
 **/
const isExcalidrawActive = () => {
    const activeFile = app.workspace.getActiveFile();
    if (activeFile && activeFile.name.endsWith(".excalidraw.md")) return true;
    const activeLeaf = app.workspace.activeLeaf;
    if (activeLeaf?.view?.getViewType?.() === "excalidraw") return true;
    return false;
};

/**
 * MarkMind (マインドマップ) がアクティブかどうかを判定する
 **/
const isMarkMindActive = () => {
    const activeLeaf = app.workspace.activeLeaf;
    if (activeLeaf?.view?.getViewType?.() === "mindmapview") return true;
    const activeEl = document.activeElement;
    if (activeEl && (
        activeEl.closest(".mindmapview") ||
        activeEl.closest(".markmind-container") ||
        activeEl.closest(".cm-mindmap-container") ||
        activeEl.closest(".cm-mindmap") ||
        activeEl.closest("[data-type='mindmapview']")
    )) return true;
    return false;
};

const patchCommandForExcalidraw = (commandId) => {
    const cmd = app.commands.commands[commandId];
    if (!cmd || cmd._excalidrawPatched) return;

    const origCallback = cmd.callback;
    const origCheckCallback = cmd.checkCallback;
    const origEditorCallback = cmd.editorCallback;

    if (origCallback) {
        cmd.callback = () => {
            if (isExcalidrawActive() || isMarkMindActive()) return;
            return origCallback();
        };
    }
    if (origCheckCallback) {
        cmd.checkCallback = (checking) => {
            if (isExcalidrawActive() || isMarkMindActive()) return false;
            return origCheckCallback(checking);
        };
    }
    if (origEditorCallback) {
        cmd.editorCallback = (editor, view) => {
            if (isExcalidrawActive() || isMarkMindActive()) return;
            return origEditorCallback(editor, view);
        };
    }

    cmd._excalidrawPatched = true;
    console.log(`Patched command for Excalidraw: ${commandId}`);
};

// Excalidraw と競合する Obsidian コマンドをパッチする
const excalidrawConflictingCommands = [
    "workspace:previous-tab",       // Cmd+ArrowLeft
    "workspace:next-tab",           // Cmd+ArrowRight
    "file-explorer:delete-file",    // Delete
    "app:delete-file",              // Cmd+Delete
    "custom:delete-active-file",    // カスタム削除
    "custom:smart-focus-right",     // Cmd+Shift+ArrowRight
    "custom:smart-focus-left",      // Cmd+Shift+ArrowLeft
    "custom:rename-active-file",    // Cmd+R
];

// コマンドの登録完了を待ってからパッチを適用する
setTimeout(() => {
    excalidrawConflictingCommands.forEach(patchCommandForExcalidraw);
    console.log("Excalidraw command patches applied");
}, 500);




// Setup Global Key Listener for Delete
const handleDeleteKey = (e) => {
    // Intercept "Delete" (Fn+Backspace) ONLY. Removed "Backspace" support.
    if (e.key === "Delete") {
        // ExcalidrawまたはMarkMind編集中はDeleteキーをプラグイン側に渡す
        if (isExcalidrawActive() || isMarkMindActive()) return;
        // 1. Check if user is typing in an input
        const activeEl = document.activeElement;
        const isInput = activeEl.tagName === "INPUT" || 
                        activeEl.tagName === "TEXTAREA" || 
                        activeEl.isContentEditable;
        
        if (isInput) return; // Allow normal text deletion

        // Safety: Don't run in Modals (Settings, etc.) or Prompts
        if (activeEl.closest(".modal") || activeEl.closest(".prompt")) return;

        // Safety: Don't run in Tag Pane
        // Tag pane usually has data-type="tag" on the workspace leaf
        const leaf = activeEl.closest(".workspace-leaf");
        if (leaf && leaf.getAttribute("data-type") === "tag") return;

        // 2. Check if in File Explorer (Side panel)
        // Note: The previous logic said "if (activeEl.closest(...)) return;" which effectively prevents deletion when sidebar is focused.
        // It seems the user wants this hotkey to work when the *File* is active (e.g. focused in editor or canvas?), 
        // OR possibly when focused in file explorer?
        // Reading the original request: "activeFile = app.workspace.getActiveFile()".
        // Often activeFile is valid even when sidebar is focused.
        // But the previous code had: `if (activeEl.closest(".nav-files-container")) return;`
        // So we keep that existing safeguard unless told otherwise.
        if (activeEl.closest(".nav-files-container")) return;

        // 3. Ensure we have an active file
        const activeFile = app.workspace.getActiveFile();
        if (!activeFile) return;

        // 4. Perform the deletion command
        e.preventDefault();
        e.stopPropagation();
        app.commands.executeCommandById("custom:delete-active-file");
    }
};

// Remove existing listener to prevent duplicates (using a global property)
if (window._customDeleteListener) {
    document.removeEventListener("keydown", window._customDeleteListener, true);
}
// Save new listener
window._customDeleteListener = handleDeleteKey;

// Add listener with Capture=true to intercept before Excalidraw
document.addEventListener("keydown", window._customDeleteListener, true);
console.log("Global Delete key listener registered");

// Add File Menu Item for Excalidraw
const handleFileMenu = (menu, file, source, leaf) => {
    if (!file?.name) return;

    let obsidianLib;
    try {
        obsidianLib = require("obsidian");
    } catch (err) {
        obsidianLib = app.plugins.plugins["templater-obsidian"]?.obsidian;
    }

    if (file && obsidianLib && file instanceof obsidianLib.TFile) {
        menu.addItem((item) => {
            item
                .setTitle("今日のフォルダに移動")
                .setIcon("folder")
                .onClick(() => moveToTodayFolder(file));
        });

        setTimeout(() => {
            insertAfterRenameOrPrepend(menu, "今日のフォルダに移動");
        }, 120);
    }

    if (file.name.endsWith(".excalidraw.md")) {
        addCopyImageAsPngMenuItem(menu, file);
        menu.addItem((item) => {
            item
                .setTitle("Webアプリで開く")
                .setIcon("globe")
                .onClick(() => {
                    const url = getEncodedExcalidrawUrl(file);
                    window.open(url, "_blank");
                });
        });

        // Move the added item to the top
        // Finding the item by text content is more robust than lastElementChild
        setTimeout(() => {
           if (menu.dom) {
               const items = Array.from(menu.dom.querySelectorAll(".menu-item"));
               const myItem = items.find(el => el.textContent.includes("Webアプリで開く"));
               const copyImageItem = items.find(el => el.textContent.includes("画像をクリップボードにコピー"));
               if (myItem) {
                   menu.dom.prepend(myItem);
                   console.log("Moved 'Webアプリで開く' to top");
               }
               if (copyImageItem) menu.dom.prepend(copyImageItem);
           }
        }, 50); // 50ms delay to ensure DOM is rendered
    }

    if (isExcalidrawBackedMarkdown(file) && !file.name.toLowerCase().endsWith(".excalidraw.md")) {
        menu.addItem((item) => {
            item
                .setTitle("Webアプリで編集")
                .setIcon("globe")
                .onClick(() => {
                    const url = getEncodedExcalidrawUrl(file);
                    window.open(url, "_blank");
                });
        });

        setTimeout(() => {
            if (!menu.dom) return;
            const editItem = Array.from(menu.dom.querySelectorAll(".menu-item"))
                .find((el) => el.textContent.includes("Webアプリで編集"));
            if (editItem) menu.dom.prepend(editItem);
        }, 50);
    }

    if (file.extension === "md" && !file.name.endsWith(".excalidraw.md")) {
        menu.addItem((item) => {
            item
                .setTitle("差分を表示")
                .setIcon("git-compare")
                .onClick(() => openMarkdownDiff(file));
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

        setTimeout(() => {
            insertAfterRenameOrPrepend(menu, "差分を表示");
            insertAfterRenameOrPrepend(menu, "サマリーを作成");
            insertAfterRenameOrPrepend(menu, "PDFで出力(人間用)");
            insertAfterRenameOrPrepend(menu, "HTMLで出力(人間用)");
            insertAfterRenameOrPrepend(menu, "HTMLで出力(AIコンテキスト用)");

            // タブの右クリックメニューにあるObsidian標準のPDF項目は、
            // Excalidraw-backed Markdownでも同じ見た目で表示されるため、
            // クリック直前に対象タブをMarkdownビューへ戻せるよう紐付ける。
            if (menu.dom && isExcalidrawBackedMarkdown(file)) {
                const pdfItem = Array.from(menu.dom.querySelectorAll(".menu-item"))
                    .find((el) => /PDFにエクスポート/.test(el.textContent || ""));
                if (pdfItem) {
                    window._customPdfMenuContexts ||= new WeakMap();
                    window._customPdfMenuContexts.set(pdfItem, { file, leaf });
                }
            }
        }, 100);
    }

    // メール、Office 文書、PDF 等の添付ファイルを、ファイルエクスプローラー上で
    // 差し替え前に単体削除できるようにする。画像と drawio は下の専用メニューで
    // 同じ削除機能を提供しているため、ここでは重複して追加しない。
    if (isNonMarkdownAttachmentFile(file) && !isImageFile(file) && !isDrawioEditableFile(file)) {
        menu.addItem((item) => {
            item
                .setTitle("添付ファイルを削除")
                .setIcon("trash")
                .setWarning(true)
                .onClick(() => deleteAttachmentFile(file));
        });

        setTimeout(() => {
            if (!menu.dom) return;
            const attachmentDeleteItem = Array.from(menu.dom.querySelectorAll(".menu-item"))
                .find(el => el.textContent.includes("添付ファイルを削除"));
            if (attachmentDeleteItem) menu.dom.prepend(attachmentDeleteItem);
        }, 50);
    }

    if (isImageFile(file) || isDrawioEditableFile(file)) {
        // 「保管庫からのパスをコピー」メニュー項目を追加
        menu.addItem((item) => {
            item
                .setTitle("保管庫からのパスをコピー")
                .setIcon("link")
                .onClick(async () => {
                    await navigator.clipboard.writeText(file.path);
                    new Notice("保管庫からのパスをコピーしました");
                });
        });

        addClipboardImageMenuItems(menu, file);

        setTimeout(() => {
            if (menu.dom) {
                const items = Array.from(menu.dom.querySelectorAll(".menu-item"));
                const copyUrlItem = items.find(el => el.textContent.includes("保管庫からのパスをコピー"));
                const copyImageItem = items.find(el => el.textContent.includes("画像をクリップボードにコピー"));
                const moveItem = items.find(el => el.textContent.includes("共通画像フォルダへ移動"));
                const compareItem = items.find(el => el.textContent.includes("クリップボードの画像との比較"));
                const replaceItem = items.find(el => el.textContent.includes("クリップボードの画像と差し替え"));
                const deleteItem = items.find(el => el.textContent.includes("削除"));
                const drawioItem = items.find(el => el.textContent.includes("drawioで編集"));
                
                // 下のものから順に prepend することで、最終的に copyUrlItem が最上部になるようにする
                if (deleteItem) menu.dom.prepend(deleteItem);
                if (replaceItem) menu.dom.prepend(replaceItem);
                if (compareItem) menu.dom.prepend(compareItem);
                if (moveItem) menu.dom.prepend(moveItem);
                if (drawioItem) menu.dom.prepend(drawioItem);
                if (copyUrlItem) menu.dom.prepend(copyUrlItem);
                if (copyImageItem) menu.dom.prepend(copyImageItem);
            }
        }, 50);
    }
};

// Remove existing listener to prevent duplicates
if (window._customFileMenuListener) {
    app.workspace.off("file-menu", window._customFileMenuListener);
}
// Save new listener
window._customFileMenuListener = handleFileMenu;

// Register the event
app.workspace.on("file-menu", window._customFileMenuListener);
console.log("File menu listener registered for Excalidraw (Absolute Path)");

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
        } catch (e) {
            console.error("Failed to check open-path link in editor-menu:", e);
        }
    }

    if (file.extension === "md" && !file.name.endsWith(".excalidraw.md")) {
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

        setTimeout(() => {
            if (menu.dom) {
                const items = Array.from(menu.dom.querySelectorAll(".menu-item"));
                const copySaveItem = items.find(el => el.textContent.includes("コピーして同一フォルダーに保存"));
                const myItem = items.find(el => el.textContent.includes("サマリーを作成"));
                const pdfItem = items.find(el => el.textContent.includes("PDFで出力(人間用)"));
                const aiHtmlItem = items.find(el => el.textContent.includes("HTMLで出力(AIコンテキスト用)"));
                const humanHtmlItem = items.find(el => el.textContent.includes("HTMLで出力(人間用)"));
                if (copySaveItem) menu.dom.prepend(copySaveItem);
                if (pdfItem) menu.dom.prepend(pdfItem);
                if (humanHtmlItem) menu.dom.prepend(humanHtmlItem);
                if (aiHtmlItem) menu.dom.prepend(aiHtmlItem);
                if (myItem) {
                    menu.dom.prepend(myItem);
                }
            }
        }, 50);
    }
};

// Remove existing listener to prevent duplicates
if (window._customEditorMenuListener) {
    app.workspace.off("editor-menu", window._customEditorMenuListener);
}
// Save new listener
window._customEditorMenuListener = handleEditorMenu;

// Register the event
app.workspace.on("editor-menu", window._customEditorMenuListener);
console.log("Editor menu listener registered for Summary");

// Add PDF export option for code block background
const PDF_CODE_BLOCK_BG_KEY = "customPdfCodeBlockBackgroundEnabled";
const PDF_PATH_CLIPBOARD_KEY = "customPdfExportPathToClipboardEnabled";

const isPdfCodeBlockBackgroundEnabled = () => {
    const stored = localStorage.getItem(PDF_CODE_BLOCK_BG_KEY);
    return stored === null ? true : stored === "true";
};

const isPdfPathToClipboardEnabled = () => {
    const stored = localStorage.getItem(PDF_PATH_CLIPBOARD_KEY);
    return stored === null ? true : stored === "true";
};

const applyPdfCodeBlockBackgroundPreference = () => {
    document.body.classList.toggle("pdf-code-block-bg-disabled", !isPdfCodeBlockBackgroundEnabled());
};

/**
 * Obsidian直下の「temp」フォルダのパスを取得し、存在しない場合は作成する
 **/
const ensureTempDirExists = () => {
    try {
        const path = require("path");
        const fs = require("fs");
        const basePath = app.vault.adapter.basePath;
        const tempDirPath = path.join(basePath, "temp");
        if (!fs.existsSync(tempDirPath)) {
            fs.mkdirSync(tempDirPath, { recursive: true });
        }
        return tempDirPath;
    } catch (e) {
        console.error("Failed to create temp directory:", e);
        return null;
    }
};

/**
 * 保存ダイアログの引数(options)をチェックし、HTMLまたはPDFの出力パスを「temp」フォルダ配下に変更する
 **/
const rewriteDialogDefaultPath = (options) => {
    if (!options || typeof options !== "object") return;
    
    const path = require("path");
    const tempDirPath = ensureTempDirExists();
    if (!tempDirPath) return;

    if (typeof options.defaultPath === "string") {
        const fileName = path.basename(options.defaultPath);
        const ext = path.extname(fileName).toLowerCase();
        if (ext === ".pdf" || ext === ".html") {
            options.defaultPath = path.join(tempDirPath, fileName);
        }
    } else {
        const isPdfOrHtmlFilter = options.filters?.some(f => 
            f.extensions?.some(ext => {
                const lower = ext.toLowerCase();
                return lower === "pdf" || lower === "html";
            })
        );
        if (isPdfOrHtmlFilter) {
            options.defaultPath = path.join(tempDirPath, "Untitled");
        }
    }
};

// Hook Electron ipcRenderer to intercept PDF save dialog path
let ipcRenderer;
let remoteDialog;
try {
    const electron = require("electron");
    ipcRenderer = electron.ipcRenderer;
    if (electron.remote && electron.remote.dialog) {
        remoteDialog = electron.remote.dialog;
    }
} catch (e) {
    try {
        const electron = window.require("electron");
        ipcRenderer = electron.ipcRenderer;
        if (electron.remote && electron.remote.dialog) {
            remoteDialog = electron.remote.dialog;
        }
    } catch (err) {}
}

// Check for @electron/remote
if (!remoteDialog) {
    try {
        remoteDialog = require("@electron/remote").dialog;
    } catch (e) {
        try {
            remoteDialog = window.require("@electron/remote").dialog;
        } catch (err) {}
    }
}

const handleSaveDialogResult = (result) => {
    if (!result) return;
    let filePath = null;
    if (typeof result === "object") {
        if (result.canceled === false && typeof result.filePath === "string") {
            filePath = result.filePath;
        } else if (typeof result.filePath === "string" && !result.canceled) {
            filePath = result.filePath;
        }
    } else if (typeof result === "string") {
        filePath = result;
    }

    if (filePath && filePath.toLowerCase().endsWith(".pdf")) {
        if (isPdfPathToClipboardEnabled()) {
            navigator.clipboard.writeText(filePath)
                .then(() => {
                    new Notice("PDFの絶対パスをクリップボードにコピーしました: " + filePath);
                })
                .catch((err) => {
                    console.error("Failed to copy PDF path:", err);
                });
        }
    }
};

// Hook remote.dialog
if (remoteDialog) {
    if (!remoteDialog.originalShowSaveDialog) {
        remoteDialog.originalShowSaveDialog = remoteDialog.showSaveDialog;
        remoteDialog.showSaveDialog = async function(...args) {
            for (const arg of args) {
                if (arg && typeof arg === "object") {
                    rewriteDialogDefaultPath(arg);
                }
            }
            const result = await remoteDialog.originalShowSaveDialog.apply(this, args);
            try {
                handleSaveDialogResult(result);
            } catch (err) {
                console.error(err);
            }
            return result;
        };
    }
    if (!remoteDialog.originalShowSaveDialogSync) {
        remoteDialog.originalShowSaveDialogSync = remoteDialog.showSaveDialogSync;
        remoteDialog.showSaveDialogSync = function(...args) {
            for (const arg of args) {
                if (arg && typeof arg === "object") {
                    rewriteDialogDefaultPath(arg);
                }
            }
            const result = remoteDialog.originalShowSaveDialogSync.apply(this, args);
            try {
                handleSaveDialogResult(result);
            } catch (err) {
                console.error(err);
            }
            return result;
        };
    }
}

// Hook ipcRenderer
if (ipcRenderer) {
    if (!ipcRenderer.originalInvoke) {
        ipcRenderer.originalInvoke = ipcRenderer.invoke;
        ipcRenderer.invoke = async function(channel, ...args) {
            for (const arg of args) {
                if (arg && typeof arg === "object") {
                    rewriteDialogDefaultPath(arg);
                }
            }
            const result = await ipcRenderer.originalInvoke.apply(this, [channel, ...args]);
            try {
                handleSaveDialogResult(result);
            } catch (err) {
                console.error("Error in hookSaveDialog invoke handler:", err);
            }
            return result;
        };
    }
    if (!ipcRenderer.originalSendSync) {
        ipcRenderer.originalSendSync = ipcRenderer.sendSync;
        ipcRenderer.sendSync = function(channel, ...args) {
            for (const arg of args) {
                if (arg && typeof arg === "object") {
                    rewriteDialogDefaultPath(arg);
                }
            }
            const result = ipcRenderer.originalSendSync.apply(this, [channel, ...args]);
            try {
                handleSaveDialogResult(result);
            } catch (err) {
                console.error("Error in hookSaveDialog sendSync handler:", err);
            }
            return result;
        };
    }
    if (!ipcRenderer.originalSend) {
        ipcRenderer.originalSend = ipcRenderer.send;
        ipcRenderer.send = function(channel, ...args) {
            return ipcRenderer.originalSend.apply(this, [channel, ...args]);
        };
    }
    if (!ipcRenderer.originalOn) {
        ipcRenderer.originalOn = ipcRenderer.on;
        ipcRenderer.on = function(channel, listener) {
            const wrappedListener = function(event, ...args) {
                for (const arg of args) {
                    try {
                        handleSaveDialogResult(arg);
                    } catch (e) {}
                }
                return listener.apply(this, [event, ...args]);
            };
            wrappedListener.originalListener = listener;
            return ipcRenderer.originalOn.apply(this, [channel, wrappedListener]);
        };
    }
}

// Hook HTML5 showSaveFilePicker
if (window.showSaveFilePicker) {
    if (!window.originalShowSaveFilePicker) {
        window.originalShowSaveFilePicker = window.showSaveFilePicker;
        window.showSaveFilePicker = async function(options) {
            const handle = await window.originalShowSaveFilePicker.apply(this, [options]);
            try {
                if (handle && typeof handle.path === "string") {
                    handleSaveDialogResult(handle.path);
                } else if (handle && handle.getFile) {
                    const file = await handle.getFile();
                    if (file && typeof file.path === "string") {
                        handleSaveDialogResult(file.path);
                    }
                }
            } catch (err) {
                console.error("Error in showSaveFilePicker hook:", err);
            }
            return handle;
        };
    }
}

const createPdfCodeBlockBackgroundRow = (modalEl) => {
    if (modalEl.querySelector(".custom-pdf-code-block-bg-row")) return;

    const contentEl = modalEl.querySelector(".modal-content") || modalEl;
    const referenceRow = Array.from(contentEl.querySelectorAll(".setting-item"))
        .find((row) => row.textContent?.includes("倍率"));

    const row = document.createElement("div");
    row.className = "setting-item custom-pdf-code-block-bg-row";

    const info = document.createElement("div");
    info.className = "setting-item-info";
    const name = document.createElement("div");
    name.className = "setting-item-name";
    name.textContent = "コードブロックの薄いグレー背景";
    info.appendChild(name);

    const control = document.createElement("div");
    control.className = "setting-item-control";

    const toggle = document.createElement("div");
    toggle.className = "checkbox-container";
    toggle.setAttribute("role", "checkbox");
    toggle.setAttribute("tabindex", "0");

    const updateToggle = () => {
        const enabled = isPdfCodeBlockBackgroundEnabled();
        toggle.classList.toggle("is-enabled", enabled);
        toggle.setAttribute("aria-checked", String(enabled));
        applyPdfCodeBlockBackgroundPreference();
    };

    const toggleValue = () => {
        localStorage.setItem(PDF_CODE_BLOCK_BG_KEY, String(!isPdfCodeBlockBackgroundEnabled()));
        updateToggle();
    };

    toggle.addEventListener("click", toggleValue);
    toggle.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        toggleValue();
    });

    control.appendChild(toggle);
    row.appendChild(info);
    row.appendChild(control);

    if (referenceRow?.parentElement) {
        referenceRow.parentElement.insertBefore(row, referenceRow.nextSibling);
    } else {
        contentEl.appendChild(row);
    }

    updateToggle();
};

const createPdfExportPathToClipboardRow = (modalEl) => {
    if (modalEl.querySelector(".custom-pdf-export-path-to-clipboard-row")) return;

    const contentEl = modalEl.querySelector(".modal-content") || modalEl;
    const referenceRow = modalEl.querySelector(".custom-pdf-code-block-bg-row") || 
        Array.from(contentEl.querySelectorAll(".setting-item"))
            .find((row) => row.textContent?.includes("倍率"));

    const row = document.createElement("div");
    row.className = "setting-item custom-pdf-export-path-to-clipboard-row";

    const info = document.createElement("div");
    info.className = "setting-item-info";
    const name = document.createElement("div");
    name.className = "setting-item-name";
    name.textContent = "パスをクリップボードに入れる";
    info.appendChild(name);

    const control = document.createElement("div");
    control.className = "setting-item-control";

    const toggle = document.createElement("div");
    toggle.className = "checkbox-container";
    toggle.setAttribute("role", "checkbox");
    toggle.setAttribute("tabindex", "0");

    const updateToggle = () => {
        const enabled = isPdfPathToClipboardEnabled();
        toggle.classList.toggle("is-enabled", enabled);
        toggle.setAttribute("aria-checked", String(enabled));
    };

    const toggleValue = () => {
        localStorage.setItem(PDF_PATH_CLIPBOARD_KEY, String(!isPdfPathToClipboardEnabled()));
        updateToggle();
    };

    toggle.addEventListener("click", toggleValue);
    toggle.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        toggleValue();
    });

    control.appendChild(toggle);
    row.appendChild(info);
    row.appendChild(control);

    if (referenceRow?.parentElement) {
        referenceRow.parentElement.insertBefore(row, referenceRow.nextSibling);
    } else {
        contentEl.appendChild(row);
    }

    updateToggle();
};

const findPdfExportModal = () => Array.from(document.querySelectorAll(".modal"))
    .find((el) => el.textContent?.includes("PDFにエクスポート"));

let activePdfExportModal = null;
const enhancePdfExportModal = (modalEl = findPdfExportModal()) => {
    if (!modalEl) return;
    activePdfExportModal = modalEl;
    createPdfCodeBlockBackgroundRow(modalEl);
    createPdfExportPathToClipboardRow(modalEl);
};

let pdfExportModalEnhancementScheduled = false;
const schedulePdfExportModalEnhancement = (modalEl) => {
    if (pdfExportModalEnhancementScheduled) return;
    pdfExportModalEnhancementScheduled = true;
    requestAnimationFrame(() => {
        pdfExportModalEnhancementScheduled = false;
        const currentModal = modalEl?.isConnected && modalEl.textContent?.includes("PDFにエクスポート")
            ? modalEl
            : findPdfExportModal();
        if (currentModal) enhancePdfExportModal(currentModal);
    });
};

let pdfExportModalDiscoveryScheduled = false;
const schedulePdfExportModalDiscovery = (attempt = 0) => {
    if (pdfExportModalDiscoveryScheduled) return;
    pdfExportModalDiscoveryScheduled = true;
    requestAnimationFrame(() => {
        pdfExportModalDiscoveryScheduled = false;
        const modalEl = findPdfExportModal();
        if (modalEl) {
            schedulePdfExportModalEnhancement(modalEl);
        } else if (attempt < 2) {
            // モーダルの骨組みと本文が別フレームで追加される場合だけ、短く再確認する。
            setTimeout(() => schedulePdfExportModalDiscovery(attempt + 1), 50);
        }
    });
};

const isModalContainerNode = (node) => {
    if (!(node instanceof Element)) return false;
    return node.matches(".modal, .modal-container") || !!node.querySelector(".modal");
};

const handlePdfExportModalMutations = (mutations) => {
    // PDFモーダルが開いていない通常時は、Grimoire の入力に伴うDOM変更を祖先探索せずに無視する。
    if (activePdfExportModal?.isConnected) {
        for (const mutation of mutations) {
            if (activePdfExportModal.contains(mutation.target)) {
                schedulePdfExportModalEnhancement(activePdfExportModal);
                return;
            }
        }
        return;
    }

    activePdfExportModal = null;
    for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
            if (isModalContainerNode(node)) {
                schedulePdfExportModalDiscovery();
                return;
            }
        }
    }
};

if (typeof MutationObserver !== "undefined") {
    if (window._customPdfExportModalObserver) {
        window._customPdfExportModalObserver.disconnect();
    }
    applyPdfCodeBlockBackgroundPreference();
    window._customPdfExportModalObserver = new MutationObserver(handlePdfExportModalMutations);
    window._customPdfExportModalObserver.observe(document.body, { childList: true, subtree: true });
}
enhancePdfExportModal();

// Excalidraw-backed Markdownを表示中にObsidian標準のPDF出力を実行すると、
// Excalidrawビュー（キャンバス）を印刷して空白PDFになることがある。PDF出力直前だけ
// Markdownビューへ戻し、本文と図のプレビューを印刷対象にする。
const findLeafForPdfFile = (file, preferredLeaf = null) => {
    if (preferredLeaf?.view?.file?.path === file?.path) return preferredLeaf;
    if (app.workspace.activeLeaf?.view?.file?.path === file?.path) return app.workspace.activeLeaf;
    let found = null;
    app.workspace.iterateAllLeaves?.((candidate) => {
        if (!found && candidate?.view?.file?.path === file?.path) found = candidate;
    });
    return found;
};

const prepareExcalidrawBackedMarkdownForPdfExport = async (targetFile = null, targetLeaf = null) => {
    const file = targetFile || app.workspace.getActiveFile?.();
    const leaf = findLeafForPdfFile(file, targetLeaf);
    if (!file || !leaf || !isExcalidrawBackedMarkdown(file) || file.name.toLowerCase().endsWith(".excalidraw.md")) {
        return;
    }

    // Obsidian標準PDFは現在のDOMではなく、後段で vault.cachedRead(file) した
    // Markdownを別ウィンドウへ再描画する。対象を記録して、その読み込み時に
    // Excalidraw埋め込みをPNGへ置き換える。
    window._customExcalidrawPdfCachedReadTarget = {
        file,
        expiresAt: Date.now() + 120000,
    };

    if (leaf.view?.getViewType?.() === "excalidraw") {
        if (typeof leaf.view?.setMarkdownView === "function") {
            await leaf.view.setMarkdownView();
        } else {
            const excalidrawPlugin = app.plugins?.plugins?.["obsidian-excalidraw-plugin"];
            if (typeof excalidrawPlugin?.setMarkdownView === "function") {
                await excalidrawPlugin.setMarkdownView(leaf);
            }
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
};

const installExcalidrawPdfCachedReadBridge = () => {
    const vault = app.vault;
    if (!vault || typeof vault.cachedRead !== "function") return;

    const previous = window._customExcalidrawPdfCachedReadBridge;
    if (previous?.vault === vault && previous.wrapped && vault.cachedRead === previous.wrapped) {
        return;
    }
    if (previous?.vault === vault && previous.original) {
        vault.cachedRead = previous.original;
    }

    const original = vault.cachedRead;
    const wrapped = async function(file, ...args) {
        const target = window._customExcalidrawPdfCachedReadTarget;
        const shouldTransform = target
            && target.expiresAt > Date.now()
            && target.file?.path === file?.path
            && isExcalidrawBackedMarkdown(file)
            && !window._customExcalidrawPdfCachedReadTransforming;

        const content = await original.apply(this, [file, ...args]);
        if (!shouldTransform) return content;

        window._customExcalidrawPdfCachedReadTransforming = true;
        try {
            const withoutInternalData = stripExcalidrawDataSectionForExport(content, file);
            // 標準PDF側のMarkdownRendererが解釈できるよう、HTMLのimg要素を返す。
            // これにより ![[りんご|75]] が自己ノート埋め込みとして再帰せず、
            // ExcalidrawのPNGだけが印刷対象になる。
            return await replaceExcalidrawEmbedsForHtmlExport(withoutInternalData, file);
        } catch (error) {
            console.error("Failed to prepare Excalidraw content for native PDF:", error);
            return content;
        } finally {
            window._customExcalidrawPdfCachedReadTransforming = false;
        }
    };

    vault.cachedRead = wrapped;
    window._customExcalidrawPdfCachedReadBridge = { vault, original, wrapped };
};

// file-menu の標準項目は command.callback を経由せず、メニュー項目に保持した
// コールバックを直接呼ぶ場合がある。その経路では上の command ラッパーが届かない
// ため、対象ファイルを紐付けたPDF項目だけをキャプチャし、Markdownビューへ戻して
// から同じ項目を再クリックする。
const installExcalidrawPdfMenuGuard = () => {
    if (window._customExcalidrawPdfMenuGuard) {
        document.removeEventListener("click", window._customExcalidrawPdfMenuGuard, true);
    }

    const guard = (event) => {
        if (window._customPdfMenuBypassClick) return;
        const item = event.target?.closest?.(".menu-item");
        const button = event.target?.closest?.("button");
        const isPdfMenuItem = item && /PDFにエクスポート/.test(item.textContent || "");
        const isPdfDialogButton = button && /^PDFにエクスポート$/.test((button.textContent || "").trim());
        if (!isPdfMenuItem && !isPdfDialogButton) return;

        const context = isPdfMenuItem ? window._customPdfMenuContexts?.get(item) : null;
        const file = context?.file || app.workspace.getActiveFile?.();
        if (!file || !isExcalidrawBackedMarkdown(file)) return;

        installExcalidrawPdfCachedReadBridge();
        window._customExcalidrawPdfCachedReadTarget = { file, expiresAt: Date.now() + 120000 };

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        window._customPdfMenuBypassClick = true;
        Promise.resolve()
            .then(async () => {
                const targetLeaf = findLeafForPdfFile(file, context?.leaf);
                if (targetLeaf && app.workspace.activeLeaf !== targetLeaf) {
                    await app.workspace.setActiveLeaf?.(targetLeaf, true);
                    await new Promise(resolve => setTimeout(resolve, 80));
                }
                await prepareExcalidrawBackedMarkdownForPdfExport(file, targetLeaf);
                await new Promise(resolve => setTimeout(resolve, 180));
                (isPdfMenuItem ? item : button).click();
            })
            .catch((error) => {
                console.error("Excalidraw-backed Markdown PDF export failed:", error);
                new Notice(`PDF出力の準備に失敗しました: ${error?.message || error}`);
            })
            .finally(() => {
                setTimeout(() => { window._customPdfMenuBypassClick = false; }, 0);
            });
    };

    window._customExcalidrawPdfMenuGuard = guard;
    document.addEventListener("click", guard, true);
};

const ensureExcalidrawDataPrintStyle = () => {
    if (typeof document === "undefined" || typeof document.getElementById !== "function") return;
    if (document.getElementById("custom-excalidraw-data-print-style")) return;
    const style = document.createElement("style");
    style.id = "custom-excalidraw-data-print-style";
    style.textContent = `
@media print {
    .markdown-preview-view h1[data-heading="Excalidraw Data"] ~ *,
    .markdown-preview-view h1[data-heading="Excalidraw"] ~ *,
    .markdown-preview-view h1[data-heading="Excalidraw Data"],
    .markdown-preview-view h1[data-heading="Excalidraw"] {
        display: none !important;
    }
}`;
    document.head.appendChild(style);
};

const installExcalidrawPdfExportGuard = () => {
    const previous = window._customExcalidrawPdfExportGuard;
    if (previous?.command && previous.originalCallback) {
        previous.command.callback = previous.originalCallback;
    }
    delete window._customExcalidrawPdfExportGuard;

    const commands = app.commands?.commands || {};
    const entry = Object.entries(commands).find(([id, command]) =>
        /(?:^|:)export-pdf$/i.test(id) && typeof command?.callback === "function"
    );
    if (!entry) return;

    const [id, command] = entry;
    const originalCallback = command.callback;
    command.callback = async function(...args) {
        await prepareExcalidrawBackedMarkdownForPdfExport();
        return originalCallback.apply(this, args);
    };
    window._customExcalidrawPdfExportGuard = { id, command, originalCallback };
};

// UIや他プラグインが command.callback を直接参照せず、executeCommandById を
// 経由してPDF出力する場合にも、出力直前のMarkdownビュー切り替えを保証する。
const installExcalidrawExecuteCommandPdfGuard = () => {
    const commandsApi = app.commands;
    if (!commandsApi || typeof commandsApi.executeCommandById !== "function") return;

    const previous = window._customExcalidrawExecuteCommandPdfGuard;
    if (previous?.api === commandsApi && previous.wrapped && commandsApi.executeCommandById === previous.wrapped) {
        return;
    }

    const original = previous?.api === commandsApi && previous.original
        ? previous.original
        : commandsApi.executeCommandById;
    const wrapped = async function(commandId, ...args) {
        if (/(?:^|:)export-pdf$/i.test(String(commandId))) {
            await prepareExcalidrawBackedMarkdownForPdfExport();
        }
        return original.apply(this, [commandId, ...args]);
    };
    commandsApi.executeCommandById = wrapped;
    window._customExcalidrawExecuteCommandPdfGuard = { api: commandsApi, original, wrapped };
};

ensureExcalidrawDataPrintStyle();
installExcalidrawPdfCachedReadBridge();
installExcalidrawPdfMenuGuard();
installExcalidrawPdfExportGuard();
installExcalidrawExecuteCommandPdfGuard();
// Templaterの起動タイミングによってコマンド登録が後になる場合に備えて再確認する。
[500, 1500, 3000, 5000, 8000].forEach((delay) => {
    setTimeout(() => {
        installExcalidrawPdfExportGuard();
        installExcalidrawExecuteCommandPdfGuard();
    }, delay);
});
console.log("PDF export code block background & path clipboard option registered");

// Remove existing listener to prevent duplicates
if (window._customBaseFileSearchListener) {
    document.removeEventListener("keydown", window._customBaseFileSearchListener, true);
    window._customBaseFileSearchListener = null;
}

// Setup Global Key Listener for Blockquote Toggle (Cmd+. on Mac, Ctrl+. on others)
const handleQuoteShortcutKey = (e) => {
    if (e.key !== ".") return;
    
    const isMac = navigator.userAgent.indexOf("Mac") !== -1 || (navigator.platform && navigator.platform.indexOf("Mac") !== -1);
    const hasModifier = isMac ? e.metaKey : e.ctrlKey;
    const noOtherModifiers = !e.shiftKey && !e.altKey && (isMac ? !e.ctrlKey : !e.metaKey);
    
    if (!hasModifier || !noOtherModifiers) return;

    const activeEl = document.activeElement;
    if (!activeEl) return;
    const isMarkdownEditor = activeEl.classList.contains("cm-content") || activeEl.tagName === "TEXTAREA";
    if (!isMarkdownEditor) return;
    
    if (activeEl.closest(".modal, .prompt")) return;

    let obsidianLib;
    try {
        obsidianLib = require("obsidian");
    } catch (err) {
        obsidianLib = app.plugins.plugins["templater-obsidian"]?.obsidian;
    }
    if (!obsidianLib) return;

    const activeView = app.workspace.getActiveViewOfType(obsidianLib.MarkdownView);
    if (!activeView) return;

    const editor = activeView.editor;
    e.preventDefault();
    e.stopPropagation();

    const selection = editor.getSelection();
    if (selection) {
        const lines = selection.split("\n");
        const allQuoted = lines.every(line => line.startsWith(">") || line === "");
        
        if (allQuoted) {
            const unquoted = lines.map(line => {
                if (line.startsWith("> ")) {
                    return line.substring(2);
                } else if (line.startsWith(">")) {
                    return line.substring(1);
                }
                return line;
            }).join("\n");
            editor.replaceSelection(unquoted);
        } else {
            const quoted = lines.map(line => "> " + line).join("\n");
            editor.replaceSelection(quoted);
        }
    } else {
        const cursor = editor.getCursor();
        const lineText = editor.getLine(cursor.line);
        if (lineText.startsWith(">")) {
            if (lineText.startsWith("> ")) {
                editor.setLine(cursor.line, lineText.substring(2));
                editor.setCursor({ line: cursor.line, ch: Math.max(0, cursor.ch - 2) });
            } else {
                editor.setLine(cursor.line, lineText.substring(1));
                editor.setCursor({ line: cursor.line, ch: Math.max(0, cursor.ch - 1) });
            }
        } else {
            editor.setLine(cursor.line, "> " + lineText);
            editor.setCursor({ line: cursor.line, ch: cursor.ch + 2 });
        }
    }
};

if (window._customQuoteShortcutListener) {
    document.removeEventListener("keydown", window._customQuoteShortcutListener, true);
}
window._customQuoteShortcutListener = handleQuoteShortcutKey;
document.addEventListener("keydown", window._customQuoteShortcutListener, true);
console.log("Global Blockquote shortcut registered (Cmd+. on Mac, Ctrl+. on others)");

// =============================================================================
// 左右両サイドバーの表示・非表示一括切り替え（Option + B）
// =============================================================================

/**
 * 左右両サイドバーの表示・非表示を一括切り替え（トグル）する
 * 左右どちらか一方でも開いている場合は両方閉じ（全画面化）、両方閉じている場合は両方開く
 **/
const toggleBothSidebars = () => {
    const leftSplit = app.workspace?.leftSplit;
    const rightSplit = app.workspace?.rightSplit;

    // サイドバーが開いているかを判定（APIの collapsed プロパティおよび要素の表示幅に基づく正確な判定）
    const isSidebarOpen = (split, selector) => {
        if (split && typeof split.collapsed === "boolean") {
            return !split.collapsed;
        }
        if (split?.containerEl && typeof split.containerEl.offsetWidth === "number") {
            return split.containerEl.offsetWidth > 0;
        }
        if (selector) {
            const el = document.querySelector(selector);
            if (el && typeof el.offsetWidth === "number") {
                return el.offsetWidth > 0;
            }
        }
        return false;
    };

    const isLeftOpen = isSidebarOpen(leftSplit, ".workspace-split.mod-left-split");
    const isRightOpen = isSidebarOpen(rightSplit, ".workspace-split.mod-right-split");

    if (isLeftOpen || isRightOpen) {
        // どちらか一方でも開いているなら両方閉じる
        if (leftSplit && typeof leftSplit.collapse === "function") {
            leftSplit.collapse();
        } else if (isLeftOpen) {
            app.commands?.executeCommandById?.("app:toggle-left-sidebar");
        }

        if (rightSplit && typeof rightSplit.collapse === "function") {
            rightSplit.collapse();
        } else if (isRightOpen) {
            app.commands?.executeCommandById?.("app:toggle-right-sidebar");
        }
    } else {
        // 両方閉じているなら両方開く
        if (leftSplit && typeof leftSplit.expand === "function") {
            leftSplit.expand();
        } else {
            app.commands?.executeCommandById?.("app:toggle-left-sidebar");
        }

        if (rightSplit && typeof rightSplit.expand === "function") {
            rightSplit.expand();
        } else {
            app.commands?.executeCommandById?.("app:toggle-right-sidebar");
        }
    }
};

window.toggleBothSidebars = toggleBothSidebars;

// コマンド登録
if (app.commands && typeof app.commands.addCommand === "function") {
    app.commands.addCommand({
        id: "custom:toggle-both-sidebars",
        name: "左右両方のサイドバー表示/非表示を切り替え",
        callback: toggleBothSidebars,
        hotkeys: [
            {
                modifiers: ["Alt"],
                key: "b"
            }
        ]
    });
}

/**
 * Option + B (Win/Linux: Alt + B) のキーイベントハンドラー
 * どの要素（エディタ、サイドバー、マインドマップ、余白等）がアクティブであっても確実にフックする
 **/
const handleToggleSidebarsShortcut = (e) => {
    // Option (Mac) または Alt (Win/Linux) + B
    // metaKey (Cmd) や ctrlKey は押されていないこと（エディタの太字等の標準ショートカットを妨害しない）
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
        // MacのOption+B入力値 (∫ など) や e.code === "KeyB"、e.key === "b" / "B" に対応
        const isB = e.code === "KeyB" || (e.key && e.key.toLowerCase() === "b") || e.key === "∫";
        if (isB) {
            e.preventDefault();
            e.stopPropagation();
            if (typeof e.stopImmediatePropagation === "function") {
                e.stopImmediatePropagation();
            }
            toggleBothSidebars();
        }
    }
};

if (window._customToggleSidebarsShortcutListener) {
    document.removeEventListener("keydown", window._customToggleSidebarsShortcutListener, true);
}
window._customToggleSidebarsShortcutListener = handleToggleSidebarsShortcut;
document.addEventListener("keydown", window._customToggleSidebarsShortcutListener, true);
console.log("Global Toggle Both Sidebars shortcut registered (Option+B on Mac, Alt+B on others)");

// =============================================================================
// MarkMind プラグイン連携機能（非侵襲拡張）
// =============================================================================

/**
 * MarkdownテキストからExcalidrawの内部データセクションを除外する
 * @param {string} mdText
 * @returns {string}
 */
const stripExcalidrawSection = (mdText) => {
    if (!mdText || typeof mdText !== "string") return mdText;
    let result = mdText;
    // 1. '# Excalidraw Data' 以降を丸ごと除去
    const excalidrawHeaderRegex = /(?:^|\n)#{1,6}\s+Excalidraw\s+Data\b[\s\S]*$/i;
    result = result.replace(excalidrawHeaderRegex, "");
    // 2. 警告バナー等を除去
    result = result.replace(/==⚠[\s\S]*?⚠==[^\n]*/g, "");
    // 3. %% コメントブロック内の Drawing 等を除去
    result = result.replace(/%%[\s\S]*?## Drawing[\s\S]*?%%/gi, "");
    return result.trim();
};

/**
 * MarkMind の View クラス（またはプロトタイプ）に対してパッチを適用し、
 * Excalidrawデータがマインドマップに展開されるのを防ぎ、かつ保存時にExcalidrawデータを復元・保護する
 */
const patchMarkMindViewForExcalidraw = (targetProto) => {
    let viewProto = targetProto;
    if (!viewProto) {
        const leaves = app.workspace?.getLeavesOfType?.("mindmapview") || [];
        if (leaves.length > 0 && leaves[0].view) {
            viewProto = Object.getPrototypeOf(leaves[0].view);
        } else if (app.viewRegistry?.viewByType?.["mindmapview"]) {
            try {
                const creator = app.viewRegistry.viewByType["mindmapview"];
                const dummyLeaf = { id: "_patch_dummy", app };
                const dummyView = creator(dummyLeaf);
                if (dummyView) {
                    viewProto = Object.getPrototypeOf(dummyView);
                }
            } catch (e) {
                // 無視
            }
        }
    }

    if (viewProto && !viewProto._excalidrawPatched) {
        if (typeof viewProto.getMdText === "function") {
            const origGetMdText = viewProto.getMdText;
            viewProto.getMdText = function(t) {
                const raw = origGetMdText.apply(this, arguments);
                return stripExcalidrawSection(raw);
            };
        }

        if (typeof viewProto.setViewData === "function") {
            const origSetViewData = viewProto.setViewData;
            viewProto.setViewData = function(t) {
                if (typeof t === "string") {
                    const match = t.match(/(?:^|\n)(#{1,6}\s+Excalidraw\s+Data\b[\s\S]*)$/i);
                    this._excalidrawBackup = match ? match[1].trim() : null;
                }
                return origSetViewData.apply(this, arguments);
            };
        }

        if (typeof viewProto.mindMapChange === "function") {
            const origMindMapChange = viewProto.mindMapChange;
            viewProto.mindMapChange = function(t) {
                const res = origMindMapChange.apply(this, arguments);
                if (this._excalidrawBackup && typeof this.data === "string") {
                    if (!this.data.includes("Excalidraw Data")) {
                        this.data = this.data.trimEnd() + "\n\n" + this._excalidrawBackup + "\n";
                    }
                }
                return res;
            };
        }

        viewProto._excalidrawPatched = true;
        console.log("Patched MarkMind View for Excalidraw compatibility");
    }

    // すでに開いている mindmapview の leaf インスタンスがあれば、_excalidrawBackup を同期
    const openLeaves = app.workspace?.getLeavesOfType?.("mindmapview") || [];
    for (const leaf of openLeaves) {
        const view = leaf.view;
        if (view && view.data && !view._excalidrawBackup) {
            const match = view.data.match(/(?:^|\n)(#{1,6}\s+Excalidraw\s+Data\b[\s\S]*)$/i);
            if (match) {
                view._excalidrawBackup = match[1].trim();
            }
        }
    }
};

// グローバル・外部からも参照可能に公開
window.stripExcalidrawSection = stripExcalidrawSection;
window.patchMarkMindViewForExcalidraw = patchMarkMindViewForExcalidraw;

/**
 * Option (Alt) + M で MarkMind プラグインを有効化（mindmap-plugin: basic を付与）して
 * マインドマップ画面と Markdown 画面をトグル切り替えする
 **/
const toggleMindmapBasic = async () => {
    const activeLeaf = app.workspace.activeLeaf;
    if (!activeLeaf) return;
    const viewType = activeLeaf.view?.getViewType?.();

    if (viewType === "mindmapview") {
        // マインドマップ画面なら Markdown に戻す
        const markmind = app.plugins?.plugins?.["obsidian-markmind"];
        if (markmind?.mindmapFileModes) {
            markmind.mindmapFileModes[activeLeaf.id || activeLeaf.view.file?.path] = "markdown";
        }
        await activeLeaf.setViewState({
            type: "markdown",
            state: activeLeaf.view.getState(),
            popstate: true
        }, { focus: true });
    } else {
        // Markdown画面などの場合
        let activeFile = activeLeaf.view?.file;
        if (!activeFile && activeLeaf.view?.getState) {
            const st = activeLeaf.view.getState();
            if (st && st.file) activeFile = app.vault.getAbstractFileByPath(st.file);
        }
        if (!activeFile) activeFile = app.workspace.getActiveFile();
        if (!activeFile) return;

        // フロントマターに mindmap-plugin がなければ basic を追加
        const cache = app.metadataCache.getFileCache(activeFile);
        if (!cache?.frontmatter || !cache.frontmatter["mindmap-plugin"]) {
            try {
                await app.fileManager.processFrontMatter(activeFile, (fm) => {
                    if (!fm["mindmap-plugin"]) {
                        fm["mindmap-plugin"] = "basic";
                    }
                });
            } catch (err) {
                console.error("Failed to update frontmatter for mindmap:", err);
            }
        }

        const markmind = app.plugins?.plugins?.["obsidian-markmind"];
        if (markmind?.mindmapFileModes) {
            markmind.mindmapFileModes[activeLeaf.id || activeFile.path] = "mindmapview";
        }

        patchMarkMindViewForExcalidraw();

        await activeLeaf.setViewState({
            type: "mindmapview",
            state: activeLeaf.view.getState(),
            popstate: true
        });

        if (activeLeaf.view) {
            patchMarkMindViewForExcalidraw(Object.getPrototypeOf(activeLeaf.view));
        }
    }
};

// 外部からも呼び出せるよう公開
window.toggleMindmapBasic = toggleMindmapBasic;

/**
 * Option + M (Win/Linux: Alt + M) のキーイベントハンドラー
 **/
const handleMindmapShortcutKey = (e) => {
    // Option (Mac) または Alt (Win/Linux) + M
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
        // MacのOption+M入力値 (µ など) や e.code === "KeyM" に対応
        const isM = e.code === "KeyM" || (e.key && e.key.toLowerCase() === "m") || e.key === "µ";
        if (isM) {
            e.preventDefault();
            e.stopPropagation();
            toggleMindmapBasic();
        }
    }
};

if (window._customMindmapShortcutListener) {
    document.removeEventListener("keydown", window._customMindmapShortcutListener, true);
}
window._customMindmapShortcutListener = handleMindmapShortcutKey;
document.addEventListener("keydown", window._customMindmapShortcutListener, true);
console.log("Global Option+M (Alt+M) Mindmap shortcut registered");

/**
 * マウスホイール中ボタン (button === 1) 押し込みドラッグによるマインドマップの掴んで移動 (パン操作)
 **/
let isMiddleButtonPanning = false;
let panStartPageX = 0;
let panStartPageY = 0;
let activeMindmapEvent = null;
let activePanContainer = null;
let startContainerScrollLeft = 0;
let startContainerScrollTop = 0;

const handleMiddleMouseDown = (e) => {
    if (e.button !== 1) return; // ホイール中ボタン (中央ボタン)

    const target = e.target;
    if (!(target instanceof Element)) return;

    const mmContainer = target.closest(".mm-app-container") ||
                        target.closest(".markmind-container") ||
                        target.closest(".cm-mindmap-container") ||
                        target.closest(".cm-mindmap") ||
                        target.closest("[data-type='mindmapview']");
    if (!mmContainer) return;

    // ブラウザ標準のオートスクロールアイコン表示を完全抑止
    e.preventDefault();
    e.stopPropagation();

    isMiddleButtonPanning = true;
    panStartPageX = e.pageX;
    panStartPageY = e.pageY;

    const activeLeaf = app.workspace.activeLeaf;
    const mindmap = activeLeaf?.view?.mindmap;

    if (mindmap?.event && typeof mindmap.event.transform === "function") {
        // Basic モード (uc クラス)
        activeMindmapEvent = mindmap.event;
        activeMindmapEvent.pageX = e.pageX;
        activeMindmapEvent.pageY = e.pageY;
        activeMindmapEvent.sx = activeMindmapEvent.x;
        activeMindmapEvent.sy = activeMindmapEvent.y;
        activeMindmapEvent.drag = true;
    } else if (mindmap && mindmap.containerEL) {
        // Rich モード
        activePanContainer = mindmap.containerEL;
        startContainerScrollLeft = activePanContainer.scrollLeft;
        startContainerScrollTop = activePanContainer.scrollTop;
    } else {
        // フォールバック
        activePanContainer = mmContainer.querySelector(".mm-mindmap-container") || mmContainer;
        startContainerScrollLeft = activePanContainer.scrollLeft;
        startContainerScrollTop = activePanContainer.scrollTop;
    }

    const onMouseMove = (me) => {
        if (!isMiddleButtonPanning) return;
        me.preventDefault();
        me.stopPropagation();

        const dx = me.pageX - panStartPageX;
        const dy = me.pageY - panStartPageY;

        if (activeMindmapEvent) {
            activeMindmapEvent.dx = dx;
            activeMindmapEvent.dy = dy;
            activeMindmapEvent.x = activeMindmapEvent.sx + dx;
            activeMindmapEvent.y = activeMindmapEvent.sy + dy;
            activeMindmapEvent.transform();
        } else if (activePanContainer) {
            activePanContainer.scrollLeft = startContainerScrollLeft - dx;
            activePanContainer.scrollTop = startContainerScrollTop - dy;
        }
    };

    const onMouseUp = (ue) => {
        if (ue.button === 1) {
            ue.preventDefault();
            ue.stopPropagation();
        }
        isMiddleButtonPanning = false;
        if (activeMindmapEvent) {
            activeMindmapEvent.drag = false;
            activeMindmapEvent = null;
        }
        activePanContainer = null;
        document.removeEventListener("mousemove", onMouseMove, true);
        document.removeEventListener("mouseup", onMouseUp, true);
    };

    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("mouseup", onMouseUp, true);
};

if (window._customMiddleButtonPanListener) {
    document.removeEventListener("mousedown", window._customMiddleButtonPanListener, true);
}
window._customMiddleButtonPanListener = handleMiddleMouseDown;
document.addEventListener("mousedown", window._customMiddleButtonPanListener, true);
console.log("Global Middle-click Pan listener registered for Mindmap");

/**
 * Excalidraw埋め込み時にMarkMindが二重描画して競合するのを防止するパッチ
 **/
const patchMarkMindPostProcessor = () => {
    let obsidianLib;
    try {
        obsidianLib = require("obsidian");
    } catch (err) {
        obsidianLib = app.plugins?.plugins?.["templater-obsidian"]?.obsidian;
    }
    const postProcessors = obsidianLib?.MarkdownPreviewRenderer?.postProcessors;
    if (!Array.isArray(postProcessors)) return;

    for (let i = 0; i < postProcessors.length; i++) {
        const fn = postProcessors[i];
        if (!fn || fn._markmindExcalidrawPatched) continue;

        const fnStr = fn.toString();
        if (fnStr.includes("mindmap-plugin") && fnStr.includes("internal-embed")) {
            const originalFn = fn;
            const wrappedFn = async function(el, ctx) {
                if (ctx) {
                    if (ctx.frontmatter && ctx.frontmatter["excalidraw-plugin"]) return;
                    if (ctx.sourcePath && ctx.sourcePath.toLowerCase().endsWith(".excalidraw.md")) return;
                    if (ctx.sourcePath) {
                        const file = app.vault?.getAbstractFileByPath?.(ctx.sourcePath);
                        if (file) {
                            const cache = app.metadataCache?.getFileCache?.(file);
                            if (cache?.frontmatter && cache.frontmatter["excalidraw-plugin"]) return;
                        }
                    }
                }
                return originalFn.apply(this, arguments);
            };
            wrappedFn._markmindExcalidrawPatched = true;
            postProcessors[i] = wrappedFn;
            console.log("Patched MarkMind MarkdownPostProcessor for Excalidraw compatibility");
        }
    }
};

patchMarkMindPostProcessor();
setTimeout(patchMarkMindPostProcessor, 1000);
setTimeout(patchMarkMindPostProcessor, 3000);

patchMarkMindViewForExcalidraw();
setTimeout(patchMarkMindViewForExcalidraw, 1000);
setTimeout(patchMarkMindViewForExcalidraw, 3000);
if (app.workspace?.on) {
    app.workspace.on("layout-change", () => patchMarkMindViewForExcalidraw());
    app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view?.getViewType?.() === "mindmapview") {
            patchMarkMindViewForExcalidraw(Object.getPrototypeOf(leaf.view));
        }
    });
}


// 外部から利用できるようにグローバルに公開
window.createSummary = createSummary;
// Sidebar Explorer TagからMSG添付ファイルを再利用できるように公開する。
window.parseMsgFile = window._sidebarExplorerParseMsgFile || parseMsgFile;
window.SummaryDepthModal = SummaryDepthModal;

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
    const markedListRegex = /# note一覧[^\n]*\n\s*<!-- custom-note-list:start -->[\s\S]*?<!-- custom-note-list:end -->\n?/;
    if (markedListRegex.test(fileContent)) {
        return fileContent.replace(markedListRegex, noteListContent);
    }

    const legacyListRegex = /# note一覧[^\n]*\n(?:\s*\n)?(?:(?:\|.*\|\s*\n)|(?:- .*(?:\n|$)))*/;
    if (legacyListRegex.test(fileContent)) {
        return fileContent.replace(legacyListRegex, noteListContent);
    }

    return null;
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

    const extractPlainText = (content) => {
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
    const formatDate = (timestamp) => {
        const date = new Date(timestamp);
        const pad = (value) => String(value).padStart(2, "0");
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };
    const noteRows = await Promise.all(matchedFiles.map(async (f) => {
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
        const excerpt = extractPlainText(content);
        return {
            path: f.path,
            name: f.basename,
            // 文字列ではなくタグ配列を保存し、DataviewJS 側で Obsidian ネイティブのタグ要素として描画する。
            tags: uniqueTags,
            excerpt,
            ctime: formatDate(f.stat.ctime),
            mtime: formatDate(f.stat.mtime)
        };
    }));
    if (!shouldContinue()) return;

    const noteListData = JSON.stringify(noteRows);
    const noteListContent = `# note一覧
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

    try {
        const desiredQuery = query;
        const cachedFrontmatter = app.metadataCache.getFileCache(file)?.frontmatter || {};
        // プロパティが存在する場合は、キーをそれに合わせる（"Search Query" または "SearchQuery"）
        const existingKey = Object.keys(cachedFrontmatter).find(key =>
            key.toLowerCase().replace(/\s+/g, "") === "searchquery"
        );
        const needsQueryUpdate = !existingKey || cachedFrontmatter[existingKey] !== desiredQuery;

        // 同じ値を毎回 processFrontMatter で書き戻すと、他プラグインのインデックス・表示更新も
        // 起こしてしまうため、実際に差分があるときだけ更新する。
        if (needsQueryUpdate) {
            if (!shouldContinue()) return;
            await app.fileManager.processFrontMatter(file, (frontmatter) => {
                const frontmatterKey = Object.keys(frontmatter).find(key =>
                    key.toLowerCase().replace(/\s+/g, "") === "searchquery"
                );
                frontmatter[frontmatterKey || "Search Query"] = desiredQuery;
            });
        }

        if (!shouldContinue()) return;
        const originalFileContent = await app.vault.read(file);
        let fileContent = originalFileContent;
        const replacedContent = replaceNoteListSection(fileContent, noteListContent);
        if (replacedContent !== null) {
            fileContent = replacedContent;
        } else {
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
            fileContent = fileContent.slice(0, insertIndex) + noteListContent + "\n" + fileContent.slice(insertIndex);
        }

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

/**
 * バイナリ画像ファイル(PNG, JPG等)をBase64 Data URLに変換する
 * HTMLエクスポート時にfile:// URLの代わりにインラインBase64を使用するため
 **/
const readFileAsBase64DataUrl = async (vaultRelativePath) => {
    try {
        const fs = require("fs");
        const path = require("path");
        const basePath = app.vault.adapter.basePath;
        const normalizedPath = normalizeLocalFilePath(vaultRelativePath);
        const normalizedBasePath = normalizeLocalFilePath(basePath);
        const isAbsolutePath = path.isAbsolute(normalizedPath) || /^[A-Za-z]:[\\/]/.test(normalizedPath);
        const absolutePath = isAbsolutePath ? normalizedPath : path.join(normalizedBasePath, normalizedPath);
        
        // 拡張子からMIMEタイプを判定
        const ext = path.extname(normalizedPath).toLowerCase().replace(".", "");
        const mimeMap = {
            png: "image/png",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            gif: "image/gif",
            bmp: "image/bmp",
            webp: "image/webp",
            tif: "image/tiff",
            tiff: "image/tiff",
            svg: "image/svg+xml",
            ico: "image/x-icon",
        };
        const mimeType = mimeMap[ext] || "application/octet-stream";
        
        const buffer = fs.readFileSync(absolutePath);
        const base64 = buffer.toString("base64");
        return `data:${mimeType};base64,${base64}`;
    } catch (err) {
        console.error("readFileAsBase64DataUrl failed:", vaultRelativePath, err);
        return null;
    }
};

const normalizeLocalFilePath = (value) => {
    if (!value) return "";
    let normalized = String(value).trim();
    normalized = normalized.replace(/^file:\/\//i, "");
    normalized = normalized.split("?")[0].split("#")[0];
    try {
        normalized = decodeURIComponent(normalized);
    } catch (e) {}
    normalized = normalized.replace(/\\/g, "/");
    // Windows file URLs are often decoded as /C:/path. Node treats that as a
    // POSIX absolute path, so strip only the synthetic leading slash.
    normalized = normalized.replace(/^\/([A-Za-z]:\/)/, "$1");
    return normalized;
};

/**
 * SVGファイルを読み込み、HTML5 Canvasを使用してPNGのData URL(Base64)にラスタライズする
 **/
const rasterizeSvgFileToPngDataUrl = async (filePath) => {
    try {
        let svgContent = await app.vault.adapter.read(filePath);
        if (!svgContent) return null;

        return await rasterizeSvgContentToPngDataUrl(svgContent);
    } catch (err) {
        console.error("Failed to read SVG file from vault:", err);
        return { pngDataUrl: null };
    }
};

/**
 * SVG文字列をPNGのData URL(Base64)にラスタライズする
 **/
const rasterizeSvgContentToPngDataUrl = async (svgContent) => {
    try {
        // 1. color-scheme を light に強制設定して白黒反転を防ぐ
        if (svgContent.includes("color-scheme")) {
            svgContent = svgContent.replace(/color-scheme\s*:\s*[^;"]+/gi, "color-scheme: light;");
        } else {
            svgContent = svgContent.replace(/<svg\b/i, '<svg style="color-scheme: light !important;" ');
        }

        // 2. 「Text is not SVG - cannot display」の警告テキストを含むフォールバック要素（switch）を除去
        const fallbackTextRegex = /<switch>\s*<g[^>]*requiredFeatures="http:\/\/www\.w3\.org\/TR\/SVG11\/feature#Extensibility"[^>]*\/>\s*<a[^>]*>[\s\S]*?Text is not SVG - cannot display[\s\S]*?<\/a>\s*<\/switch>/gi;
        svgContent = svgContent.replace(fallbackTextRegex, "");

        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = "anonymous";

            img.onload = () => {
                try {
                    const canvas = document.createElement("canvas");
                    let width = img.naturalWidth || img.width;
                    let height = img.naturalHeight || img.height;

                    if (!width || !height) {
                        const widthMatch = svgContent.match(/<svg[^>]*\bwidth=["']?(\d+(?:\.\d+)?)(?:px)?["']/i);
                        const heightMatch = svgContent.match(/<svg[^>]*\bheight=["']?(\d+(?:\.\d+)?)(?:px)?["']/i);
                        const viewBoxMatch = svgContent.match(/<svg[^>]*\bviewBox=["']?(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/i);

                        if (widthMatch && heightMatch) {
                            width = parseFloat(widthMatch[1]);
                            height = parseFloat(heightMatch[1]);
                        } else if (viewBoxMatch) {
                            width = parseFloat(viewBoxMatch[3]);
                            height = parseFloat(viewBoxMatch[4]);
                        } else {
                            width = 800;
                            height = 600;
                        }
                    }

                    // 解像度を3倍に上げてカクカク感を解消(高精細化)
                    const scale = 3;
                    canvas.width = width * scale;
                    canvas.height = height * scale;

                    const ctx = canvas.getContext("2d");
                    if (ctx) {
                        ctx.fillStyle = "#ffffff";
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                        ctx.scale(scale, scale);
                        ctx.drawImage(img, 0, 0, width, height);
                        const pngDataUrl = canvas.toDataURL("image/png");
                        resolve({ pngDataUrl, width, height });
                        return;
                    }
                } catch (e) {
                    console.error("Canvas render error for SVG:", e);
                }
                resolve({ pngDataUrl: null });
            };

            img.onerror = (err) => {
                console.error("Failed to load SVG into Image:", err);
                resolve({ pngDataUrl: null });
            };

            let base64;
            try {
                base64 = Buffer.from(svgContent).toString("base64");
            } catch (e) {
                base64 = btoa(unescape(encodeURIComponent(svgContent)));
            }
            img.src = `data:image/svg+xml;base64,${base64}`;
        });
    } catch (err) {
        console.error("Failed to rasterize SVG content:", err);
        return { pngDataUrl: null };
    }
};

const normalizeVaultPath = (value) => {
    if (!value) return "";
    let normalized = String(value).trim();
    try {
        normalized = decodeURIComponent(normalized);
    } catch (e) {}
    return normalized.replace(/\\/g, "/").replace(/^\/+/, "");
};

const isExcalidrawPath = (value) => {
    const normalized = normalizeVaultPath(value).toLowerCase().split("#")[0].split("?")[0];
    return normalized.endsWith(".excalidraw.md") || normalized.endsWith(".excalidraw");
};

const isSampleExcalidrawPath = (value) => {
    const normalized = normalizeVaultPath(value).toLowerCase().split("#")[0].split("?")[0];
    return normalized === "図_xxx.excalidraw" || normalized === "図_xxx.excalidraw.md";
};

const resolveExcalidrawFile = (rawPath, sourceFile) => {
    const normalized = normalizeVaultPath(rawPath);
    if (!normalized) return null;

    const candidates = [normalized];
    if (normalized.endsWith(".excalidraw")) {
        candidates.push(`${normalized}.md`);
    }
    if (!normalized.endsWith(".md")) {
        candidates.push(`${normalized}.md`);
    }

    for (const candidate of candidates) {
        const direct = app.vault.getAbstractFileByPath(candidate);
        if (direct && direct.path && isExcalidrawPath(direct.path)) return direct;
    }

    for (const candidate of candidates) {
        const linked = app.metadataCache.getFirstLinkpathDest(candidate, sourceFile?.path || "");
        if (linked && linked.path && isExcalidrawPath(linked.path)) return linked;
    }

    const basename = normalized.split("/").pop();
    if (basename) {
        const linked = app.metadataCache.getFirstLinkpathDest(basename, sourceFile?.path || "");
        if (linked && linked.path && isExcalidrawPath(linked.path)) return linked;
    }

    return null;
};

const waitForExcalidrawFileSave = async (targetFile) => {
    if (!targetFile) return;

    try {
        const beforeMtime = Number(targetFile.stat?.mtime || 0);
        const saveTasks = [];
        const excalidrawPlugin = app.plugins?.plugins?.["obsidian-excalidraw-plugin"];
        const activeFile = app.workspace.getActiveFile?.();
        if (activeFile?.path === targetFile.path && typeof excalidrawPlugin?.forceSaveActiveView === "function") {
            saveTasks.push(Promise.resolve(excalidrawPlugin.forceSaveActiveView(false)));
        }

        app.workspace.iterateAllLeaves?.((leaf) => {
            const view = leaf?.view;
            if (view?.file?.path === targetFile.path && typeof view.forceSave === "function") {
                saveTasks.push(Promise.resolve(view.forceSave()));
            }
        });

        await Promise.allSettled(saveTasks);

        const started = Date.now();
        while (Date.now() - started < 2500) {
            await new Promise(resolve => setTimeout(resolve, 100));
            try {
                const stat = await app.vault.adapter.stat(targetFile.path);
                if (stat?.mtime && Number(stat.mtime) > beforeMtime) {
                    const refreshed = app.vault.getAbstractFileByPath(targetFile.path);
                    if (refreshed?.stat) {
                        targetFile.stat = refreshed.stat;
                    }
                    break;
                }
            } catch (e) {}
            if (saveTasks.length === 0) break;
        }

        await new Promise(resolve => setTimeout(resolve, 300));
    } catch (e) {
        console.warn("Failed to force-save Excalidraw before HTML export:", targetFile.path, e);
    }
};

const blobToDataUrl = (blob) => new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
});

const normalizePngExportResultToDataUrl = async (result) => {
    if (!result) return null;
    if (typeof result === "string") {
        return result.startsWith("data:image/")
            ? result
            : `data:image/png;base64,${result}`;
    }
    if (result instanceof Blob) {
        return await blobToDataUrl(result);
    }
    if (result instanceof ArrayBuffer) {
        const bytes = new Uint8Array(result);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return `data:image/png;base64,${btoa(binary)}`;
    }
    if (result?.arrayBuffer && typeof result.arrayBuffer === "function") {
        return await normalizePngExportResultToDataUrl(await result.arrayBuffer());
    }
    if (typeof result === "object") {
        if (result.dataURL) return await normalizePngExportResultToDataUrl(result.dataURL);
        if (result.dataUrl) return await normalizePngExportResultToDataUrl(result.dataUrl);
        if (result.base64) return await normalizePngExportResultToDataUrl(result.base64);
        if (result.blob) return await normalizePngExportResultToDataUrl(result.blob);
    }
    return null;
};

const describePngExportResult = (result) => {
    if (result === null) return "null";
    if (result === undefined) return "undefined";
    if (typeof result === "string") return `string(length=${result.length}, prefix=${result.slice(0, 32)})`;
    if (result instanceof Blob) return `Blob(type=${result.type}, size=${result.size})`;
    if (result instanceof ArrayBuffer) return `ArrayBuffer(byteLength=${result.byteLength})`;
    if (typeof result === "object") return `object(keys=${Object.keys(result).join(",")})`;
    return typeof result;
};

const createExcalidrawPngExportContext = (ea) => {
    const exportSettings = typeof ea.getExportSettings === "function"
        ? ea.getExportSettings(true, true)
        : { withBackground: true, withTheme: true, isMask: false };
    if (exportSettings && typeof exportSettings === "object") {
        exportSettings.withBackground = true;
        exportSettings.withTheme = true;
        exportSettings.isMask = false;
        exportSettings.skipInliningFonts = false;
    }
    const loader = typeof ea.getEmbeddedFilesLoader === "function"
        ? ea.getEmbeddedFilesLoader(false)
        : undefined;
    return { exportSettings, loader };
};

const getStringHashForExcalidrawCache = (value) => {
    let hash = 2166136261;
    const normalized = normalizeVaultPath(value);
    for (let i = 0; i < normalized.length; i++) {
        hash ^= normalized.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
};

const getExcalidrawCachePath = (file) => {
    if (!file) return null;
    const hashHex = getStringHashForExcalidrawCache(file.path);
    const mtime = file.stat?.mtime || 0;
    return `.excalidraw-cache/${hashHex}_${mtime}.png`;
};

const getExcalidrawCachePathFromIndex = async (file) => {
    if (!file) return null;
    try {
        const indexPath = ".excalidraw-cache/index.json";
        if (typeof app.vault.adapter.exists !== "function" || typeof app.vault.adapter.read !== "function") return null;
        if (!await app.vault.adapter.exists(indexPath)) return null;
        const index = JSON.parse(await app.vault.adapter.read(indexPath));
        const normalizedFilePath = normalizeVaultPath(file.path);
        const entry = index?.[normalizedFilePath] || index?.[file.path];
        
        const cacheFileNameRaw = entry?.cachefile || entry?.fallbackCachefile;
        if (!cacheFileNameRaw) return null;
        
        if (entry.mtime && file.stat?.mtime && Number(entry.mtime) !== Number(file.stat.mtime)) {
            return null;
        }
        const cacheFileName = normalizeVaultPath(cacheFileNameRaw).split("/").pop();
        if (!cacheFileName) return null;
        const cachePath = `.excalidraw-cache/${cacheFileName}`;
        if (await app.vault.adapter.exists(cachePath)) {
            return cachePath;
        }
    } catch (e) {
        console.warn("Failed to read Excalidraw cache index:", e);
    }
    return null;
};

const findExcalidrawCachePath = async (file) => {
    const indexedPath = await getExcalidrawCachePathFromIndex(file);
    if (indexedPath) return indexedPath;

    const exactPath = getExcalidrawCachePath(file);
    if (!exactPath) return null;

    try {
        if (await app.vault.adapter.exists(exactPath)) {
            return exactPath;
        }
    } catch (e) {}

    const hashHex = getStringHashForExcalidrawCache(file.path);
    try {
        const listed = await app.vault.adapter.list(".excalidraw-cache");
        const files = (listed?.files || [])
            .filter((cacheFile) => {
                const name = normalizeVaultPath(cacheFile).split("/").pop() || "";
                return name.startsWith(`${hashHex}_`) && (name.endsWith(".png") || name.endsWith(".svg"));
            })
            .sort((a, b) => {
                const getMtime = (cacheFile) => {
                    const name = normalizeVaultPath(cacheFile).split("/").pop() || "";
                    const match = name.match(/^[^_]+_(\d+)\.(?:png|svg)$/);
                    return match ? Number(match[1]) : 0;
                };
                return getMtime(b) - getMtime(a);
            });
        return files[0] || exactPath;
    } catch (e) {
        return exactPath;
    }
};

const renderExcalidrawFileToPngDataUrl = async (targetFile) => {
    if (!targetFile) {
        throw new Error("Excalidraw PNG生成失敗: 対象ファイルが見つかりません。");
    }

    // まずキャッシュファイルから解決できるか試みる
    const cachePath = await findExcalidrawCachePath(targetFile);
    if (cachePath) {
        if (cachePath.toLowerCase().endsWith(".png")) {
            const dataUrl = await readFileAsBase64DataUrl(cachePath);
            if (dataUrl) {
                return {
                    src: dataUrl,
                    width: null,
                    height: null,
                };
            }
        } else if (cachePath.toLowerCase().endsWith(".svg")) {
            const result = await rasterizeSvgFileToPngDataUrl(cachePath);
            if (result && result.pngDataUrl) {
                return {
                    src: result.pngDataUrl,
                    width: result.width || null,
                    height: result.height || null,
                };
            }
            // SVGフォールバック
            const dataUrl = await readFileAsBase64DataUrl(cachePath);
            if (dataUrl) {
                return {
                    src: dataUrl,
                    width: null,
                    height: null,
                };
            }
        }
    }

    const ea = typeof window !== "undefined" ? window.ExcalidrawAutomate : null;
    if (!ea) {
        throw new Error(`Excalidraw PNG生成失敗: ExcalidrawAutomate が利用できません (${targetFile.path})`);
    }

    try {
        await waitForExcalidrawFileSave(targetFile);
        if (!window._htmlExportExcalidrawRenderCache) {
            window._htmlExportExcalidrawRenderCache = new Map();
        }
        const renderCacheKey = `${targetFile.path}:${targetFile.stat?.mtime || 0}`;
        if (window._htmlExportExcalidrawRenderCache.has(renderCacheKey)) {
            return window._htmlExportExcalidrawRenderCache.get(renderCacheKey);
        }

        if (typeof ea.reset === "function") ea.reset();
        if (typeof ea.getSceneFromFile === "function") {
            const scene = await ea.getSceneFromFile(targetFile);
            if (!scene || !Array.isArray(scene.elements)) {
                throw new Error(`Excalidraw PNG生成失敗: getSceneFromFile がsceneを返しません (${targetFile.path})`);
            }
            if (scene.elements.length === 0) {
                throw new Error(`Excalidraw PNG生成失敗: getSceneFromFile の描画要素が0件です (${targetFile.path})`);
            }
        }

        const scale = 3;
        const { exportSettings, loader } = createExcalidrawPngExportContext(ea);
        const exportAttempts = [];
        const exportMethodNames = ["craetePNGBase64", "createPNGBase64", "createPNG"];

        for (const exportMethod of exportMethodNames) {
            if (typeof ea[exportMethod] !== "function") {
                exportAttempts.push(`${exportMethod}: unavailable`);
                continue;
            }
            try {
                const rawResult = await ea[exportMethod](targetFile.path, scale, exportSettings, loader, "light", 10);
                const dataUrl = await normalizePngExportResultToDataUrl(rawResult);
                if (dataUrl) {
                    const imageData = {
                        src: dataUrl,
                        width: null,
                        height: null,
                    };
                    window._htmlExportExcalidrawRenderCache.set(renderCacheKey, imageData);
                    return imageData;
                }
                exportAttempts.push(`${exportMethod}: result=${describePngExportResult(rawResult)}`);
            } catch (methodError) {
                exportAttempts.push(`${exportMethod}: ${methodError?.message || methodError}`);
            }
        }

        throw new Error(`Excalidraw PNG生成失敗: PNG Data URLを作成できません (${targetFile.path}; ${exportAttempts.join(" | ")})`);
    } catch (e) {
        console.error("Failed to render Excalidraw PNG directly for HTML export:", targetFile.path, e);
        throw e;
    }
};

const setImgSrcFromExcalidrawFile = async (img, targetFile) => {
    try {
        const imageData = await renderExcalidrawFileToPngDataUrl(targetFile);
        if (!imageData?.src) {
            throw new Error(`Excalidraw PNG生成失敗: PNG Data URL が空です (${targetFile?.path || "unknown"})`);
        }
        img.setAttribute("src", imageData.src);
        if (imageData.width) img.setAttribute("data-native-width", String(imageData.width));
        if (imageData.height) img.setAttribute("data-native-height", String(imageData.height));
        return true;
    } catch (error) {
        // フォールバック: キャッシュファイルのパスを探して file:// URLを設定する
        const cachePath = await findExcalidrawCachePath(targetFile);
        if (cachePath) {
            try {
                const path = require("path");
                const basePath = app.vault.adapter.basePath;
                img.setAttribute("src", toFileUrl(path.join(basePath, cachePath)));
                return true;
            } catch (e) {
                const basePath = app.vault.adapter.basePath;
                img.setAttribute("src", toFileUrl(`${basePath}/${cachePath}`));
                return true;
            }
        }
        throw error;
    }
};

const escapeHtmlAttribute = (value) => {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
};

const escapeHtmlText = (value) => {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
};

const getExcalidrawPreviewImageData = async (targetFile) => {
    return await renderExcalidrawFileToPngDataUrl(targetFile);
};

// ExcalidrawをMarkdown形式で保存したノートには、本文の後ろにプラグイン用の
// 圧縮データが続く。出力では図をPNGに置き換えるため、この内部データは本文から除く。
const stripExcalidrawDataSectionForExport = (content, sourceFile) => {
    const text = String(content || "");
    if (!isExcalidrawBackedMarkdown(sourceFile)) return text;
    return text.replace(/(?:^|\r?\n)#\s*Excalidraw(?:\s+Data)?\s*\r?\n[\s\S]*$/im, "\n");
};

const replaceExcalidrawEmbedsForHtmlExport = async (content, sourceFile) => {
    let replaced = "";
    let lastIndex = 0;
    const embedRegex = /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
    let match;
    const isProtectedSourceLink = (index) => {
        const lineStart = content.lastIndexOf("\n", index - 1) + 1;
        const lineEndRaw = content.indexOf("\n", index);
        const lineEnd = lineEndRaw === -1 ? content.length : lineEndRaw;
        const beforeInLine = content.slice(lineStart, index);
        const line = content.slice(lineStart, lineEnd);
        const backtickCount = (beforeInLine.match(/`/g) || []).length;
        return line.includes("元のリンク:") || backtickCount % 2 === 1;
    };

    while ((match = embedRegex.exec(content)) !== null) {
        const fullMatch = match[0];
        const linkpath = match[1]?.trim();
        const size = match[2]?.trim();
        const matchIndex = match.index;
        if (isProtectedSourceLink(matchIndex)) continue;
        if (isSampleExcalidrawPath(linkpath)) continue;

        // `.excalidraw.md`だけでなく、`![[りんご|75]]`のような拡張子省略リンクも
        // フロントマターを見てExcalidraw-backed Markdownとして扱う。
        const targetFile = resolveExcalidrawFile(linkpath, sourceFile)
            || getExcalidrawBackedFileFromSource(linkpath, sourceFile?.path || "");
        if (!targetFile) {
            if (isExcalidrawPath(linkpath)) {
                throw new Error(`Excalidraw PNG生成失敗: リンク先を解決できません (${linkpath})`);
            }
            continue;
        }

        const imageData = await getExcalidrawPreviewImageData(targetFile);
        if (!imageData?.src) {
            throw new Error(`Excalidraw PNG生成失敗: PNG Data URL が空です (${targetFile.path})`);
        }

        const widthMatch = size?.match(/^(\d+)(?:x\d+)?$/);
        const width = widthMatch?.[1] || imageData.width || null;
        const height = !width && imageData.height ? imageData.height : null;
        const attrs = [
            `src="${escapeHtmlAttribute(imageData.src)}"`,
            `alt="${escapeHtmlAttribute(targetFile.basename || targetFile.name)}"`,
            `data-excalidraw-source="${escapeHtmlAttribute(targetFile.path)}"`,
        ];
        if (width) attrs.push(`width="${escapeHtmlAttribute(width)}"`);
        if (height) attrs.push(`height="${escapeHtmlAttribute(height)}"`);

        // 生HTMLをMarkdown本文へ差し込むと、直後の見出しが同じHTMLブロックに
        // 吸収されて「# 見出し」のまま表示されることがある。画像を独立した
        // ブロックにし、前後に空行を確保してMarkdownの見出し・段落を再解釈させる。
        replaced += content.slice(lastIndex, matchIndex);
        replaced += `\n\n<p class="excalidraw-export-embed"><img ${attrs.join(" ")} style="max-width: 100%; height: auto;"></p>\n\n`;
        lastIndex = matchIndex + fullMatch.length;
    }
    return replaced + content.slice(lastIndex);
};

/**
 * プレビューHTMLのDOM要素をPandoc(Word)向けにクリーンアップ・変換する
 * - 画像のsrc属性をローカル絶対パス(file://)またはPNGのData URL(SVG画像の場合)に変換
 * - MathJax数式(mjx-container)をTeX記号(\(...\), $$...$$)に書き戻す
 * - 不要なUI要素を削除
 **/
const convertPreviewHtmlForPandoc = async (tempDiv, sourceFile) => {
    // 0. Markdownソースファイルから埋め込み画像のサイズ指定（例：![[image.png|275]]）を抽出
    const markdownEmbedSizes = new Map();
    if (sourceFile && typeof app !== "undefined" && app.vault) {
        try {
            const content = await app.vault.read(sourceFile);
            const embedRegex = /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
            let match;
            while ((match = embedRegex.exec(content)) !== null) {
                const linkpath = match[1].trim();
                const sizeStr = match[2] ? match[2].trim() : null;
                if (sizeStr && /^\d+$/.test(sizeStr)) {
                    const baseName = linkpath.split("/").pop();
                    markdownEmbedSizes.set(baseName.toLowerCase(), parseInt(sizeStr, 10));
                }
            }
        } catch (e) {
            // エラー時は何もしない
        }
    }

    // 1. 不要なUI要素の削除 (例: copy-code-button)
    const copyButtons = tempDiv.querySelectorAll(".copy-code-button");
    copyButtons.forEach(btn => {
        if (btn.parentNode) {
            btn.parentNode.removeChild(btn);
        }
    });

    // 2. 画像パスの絶対パス化とインラインSVG (Drawio等) の置換
    // インラインSVGを含むspan.internal-embedを画像要素に置換する処理
    const svgSpans = tempDiv.querySelectorAll("span.internal-embed");
    for (const span of Array.from(svgSpans)) {
        const src = span.getAttribute("src");
        if (src && isExcalidrawPath(src)) {
            if (isSampleExcalidrawPath(src)) continue;
            const targetFile = resolveExcalidrawFile(src, sourceFile);
            if (!targetFile) {
                throw new Error(`Excalidraw PNG生成失敗: リンク先を解決できません (${src})`);
            }

            const img = document.createElement("img");
            const alt = span.getAttribute("alt") || targetFile.name;
            if (alt) img.setAttribute("alt", alt);

            const widthAttr = span.getAttribute("width") || span.getAttribute("w");
            const heightAttr = span.getAttribute("height") || span.getAttribute("h");
            if (widthAttr) img.setAttribute("width", widthAttr);
            if (heightAttr) img.setAttribute("height", heightAttr);

            await setImgSrcFromExcalidrawFile(img, targetFile);
            if (span.parentNode) {
                span.parentNode.replaceChild(img, span);
            }
        } else if (src && (src.endsWith(".svg") || src.endsWith(".drawio.svg") || src.endsWith(".dio.svg"))) {
            const targetFile = app.metadataCache.getFirstLinkpathDest(src, sourceFile.path);
            if (targetFile) {
                const img = document.createElement("img");
                const alt = span.getAttribute("alt");
                if (alt) img.setAttribute("alt", alt);

                // Preserve size attributes from original span
                const widthAttr = span.getAttribute("width") || span.getAttribute("w");
                const heightAttr = span.getAttribute("height") || span.getAttribute("h");
                if (widthAttr) img.setAttribute("width", widthAttr);
                if (heightAttr) img.setAttribute("height", heightAttr);

                // SVGはPNGのData URLに変換する
                const result = await rasterizeSvgFileToPngDataUrl(targetFile.path);
                if (result && result.pngDataUrl) {
                    img.setAttribute("src", result.pngDataUrl);
                    if (result.width) {
                        img.setAttribute("data-native-width", String(result.width));
                    }
                    if (result.height) {
                        img.setAttribute("data-native-height", String(result.height));
                    }
                } else {
                    const basePath = app.vault.adapter.basePath;
                    const absPath = `file://${basePath}/${targetFile.path}`;
                    img.setAttribute("src", absPath);
                }
                
                if (span.parentNode) {
                    span.parentNode.replaceChild(img, span);
                }
            }
        }
    }

    const imgs = tempDiv.querySelectorAll("img");
    for (const img of Array.from(imgs)) {
        const filesource = img.getAttribute("filesource");
        let src = img.getAttribute("src");
        if (!src && !filesource) continue;

        // Excalidrawの処理 (SVG)
        let decodedFilesource = filesource;
        if (filesource) {
            try {
                decodedFilesource = decodeURIComponent(filesource);
            } catch (e) {
                // Decode failed, keep original
            }
        }

        const explicitExcalidrawSource = img.getAttribute("data-excalidraw-source");
        const possibleExcalidrawSource = decodedFilesource || explicitExcalidrawSource || img.getAttribute("alt") || src;
        if (possibleExcalidrawSource && isExcalidrawPath(possibleExcalidrawSource)) {
            if (isSampleExcalidrawPath(possibleExcalidrawSource)) continue;
            const targetFile = resolveExcalidrawFile(possibleExcalidrawSource, sourceFile);
            if (!targetFile) {
                throw new Error(`Excalidraw PNG生成失敗: リンク先を解決できません (${possibleExcalidrawSource})`);
            }
            await setImgSrcFromExcalidrawFile(img, targetFile);
            continue;
        }

        // app:// 形式の画像URLの置換 (ハッシュ付き、app://local/ 両対応)
        if (src && src.startsWith("app://")) {
            const cleanSrc = src.replace(/^app:\/\/[^\/]+\//, "file:///");
            const cleanPathForCheck = cleanSrc.split("?")[0].toLowerCase();
            if (cleanPathForCheck.endsWith(".svg")) {
                const basePath = app.vault.adapter.basePath;
                const fileProtocolPrefix = "file://";
                let absolutePath = cleanSrc.startsWith(fileProtocolPrefix) ? cleanSrc.slice(fileProtocolPrefix.length) : cleanSrc;
                absolutePath = normalizeLocalFilePath(absolutePath);
                
                let relativePath = absolutePath;
                const normalizedBasePath = normalizeLocalFilePath(basePath);
                if (absolutePath.startsWith(normalizedBasePath)) {
                    relativePath = absolutePath.slice(normalizedBasePath.length).replace(/^\//, "");
                }
                
                const result = await rasterizeSvgFileToPngDataUrl(relativePath);
                if (result && result.pngDataUrl) {
                    img.setAttribute("src", result.pngDataUrl);
                    if (result.width) {
                        img.setAttribute("data-native-width", String(result.width));
                    }
                    if (result.height) {
                        img.setAttribute("data-native-height", String(result.height));
                    }
                } else {
                    // SVGフォールバック: Base64化を試みる
                    const svgDataUrl = await readFileAsBase64DataUrl(relativePath);
                    if (svgDataUrl) {
                        img.setAttribute("src", svgDataUrl);
                    } else {
                        img.setAttribute("src", cleanSrc);
                    }
                }
            } else {
                // 非SVGのapp:// URL: ファイルパスを取得してBase64化
                const fileProtocolPrefix = "file://";
                let absolutePathForBase64 = cleanSrc.startsWith(fileProtocolPrefix) ? cleanSrc.slice(fileProtocolPrefix.length) : cleanSrc;
                absolutePathForBase64 = normalizeLocalFilePath(absolutePathForBase64);
                const basePath = app.vault.adapter.basePath;
                let relativePathForBase64 = absolutePathForBase64;
                const normalizedBasePath = normalizeLocalFilePath(basePath);
                if (absolutePathForBase64.startsWith(normalizedBasePath)) {
                    relativePathForBase64 = absolutePathForBase64.slice(normalizedBasePath.length).replace(/^\//, "");
                }
                const appDataUrl = await readFileAsBase64DataUrl(relativePathForBase64);
                if (appDataUrl) {
                    img.setAttribute("src", appDataUrl);
                } else {
                    img.setAttribute("src", cleanSrc);
                }
            }
        } else if (src && !src.startsWith("http://") && !src.startsWith("https://") && !src.startsWith("file://") && !src.startsWith("data:") && !src.startsWith("blob:")) {
            // 相対パスまたはVault内リンクの場合、ファイルを特定して絶対パスにする
            const targetFile = app.metadataCache.getFirstLinkpathDest(src, sourceFile.path);
            if (targetFile) {
                if (targetFile.extension && targetFile.extension.toLowerCase() === "svg") {
                    const result = await rasterizeSvgFileToPngDataUrl(targetFile.path);
                    if (result && result.pngDataUrl) {
                        img.setAttribute("src", result.pngDataUrl);
                        if (result.width) {
                            img.setAttribute("data-native-width", String(result.width));
                        }
                        if (result.height) {
                            img.setAttribute("data-native-height", String(result.height));
                        }
                    } else {
                        // SVGフォールバック: Base64化を試みる
                        const svgFallbackDataUrl = await readFileAsBase64DataUrl(targetFile.path);
                        if (svgFallbackDataUrl) {
                            img.setAttribute("src", svgFallbackDataUrl);
                        } else {
                            const basePath = app.vault.adapter.basePath;
                            const absPath = toFileUrl(`${basePath}/${targetFile.path}`);
                            img.setAttribute("src", absPath);
                        }
                    }
                } else {
                    // 非SVG画像: Base64 Data URLに変換
                    const imgDataUrl = await readFileAsBase64DataUrl(targetFile.path);
                    if (imgDataUrl) {
                        img.setAttribute("src", imgDataUrl);
                    } else {
                        const basePath = app.vault.adapter.basePath;
                        const absPath = toFileUrl(`${basePath}/${targetFile.path}`);
                        img.setAttribute("src", absPath);
                    }
                }
            }
        }
    }

    // 画像の巨大化防止とサイズ指定の上書き強制 (スタイル埋め込み時の表示崩れ対策)
    const imgsAfter = tempDiv.querySelectorAll("img");
    imgsAfter.forEach(img => {
        // 親の span.internal-embed などからサイズ属性を引き継ぐ
        let parent = img.parentNode;
        let parentWidth = null;
        let parentHeight = null;
        while (parent && parent !== tempDiv) {
            const className = (typeof parent.getAttribute === "function" ? parent.getAttribute("class") : "") || parent.className || "";
            const classes = className.split(/\s+/);
            if (parent.tagName === "SPAN" && classes.includes("internal-embed")) {
                parentWidth = parent.getAttribute("width") || parent.getAttribute("w");
                parentHeight = parent.getAttribute("height") || parent.getAttribute("h");
                break;
            }
            parent = parent.parentNode;
        }

        // Markdownに記述された埋め込みサイズがあれば取得
        let mdWidth = null;
        let embedKey = null;
        if (typeof img.getAttribute === "function") {
            const filesource = img.getAttribute("filesource");
            if (filesource) {
                try {
                    const decoded = decodeURIComponent(filesource);
                    embedKey = decoded.split("/").pop();
                } catch (e) {}
            }
            if (!embedKey) {
                const src = img.getAttribute("src");
                if (src && !src.startsWith("data:")) {
                    const cleanSrc = src.split("?")[0];
                    embedKey = cleanSrc.split("/").pop();
                }
            }
            if (!embedKey) {
                const alt = img.getAttribute("alt");
                if (alt) {
                    embedKey = alt.split("/").pop();
                }
            }
        }
        if (embedKey && typeof markdownEmbedSizes !== "undefined") {
            const keyLower = embedKey.toLowerCase();
            mdWidth = markdownEmbedSizes.get(keyLower);
            if (!mdWidth) {
                const baseKey = embedKey.replace(/\.[^/.]+$/, "").toLowerCase();
                mdWidth = markdownEmbedSizes.get(baseKey);
            }
        }

        const nativeWidth = typeof img.getAttribute === "function" ? img.getAttribute("data-native-width") : null;
        const nativeHeight = typeof img.getAttribute === "function" ? img.getAttribute("data-native-height") : null;

        // 明示的な指定サイズと元の画像サイズの抽出
        const explicitWidth = img.getAttribute("width") || img.getAttribute("w") || parentWidth || (mdWidth ? String(mdWidth) : null);
        const explicitHeight = img.getAttribute("height") || img.getAttribute("h") || parentHeight;

        const natWidth = nativeWidth ? Number(nativeWidth) : (img.naturalWidth || null);
        const natHeight = nativeHeight ? Number(nativeHeight) : (img.naturalHeight || null);

        let finalWidth = null;
        let finalHeight = null;

        if (explicitWidth && !explicitHeight) {
            // 幅のみ指定: アスペクト比を維持して高さを計算
            finalWidth = Number(explicitWidth);
            if (natWidth && natHeight && natWidth > 0) {
                finalHeight = Math.round(finalWidth * (natHeight / natWidth));
            }
        } else if (explicitHeight && !explicitWidth) {
            // 高さのみ指定: アスペクト比を維持して幅を計算
            finalHeight = Number(explicitHeight);
            if (natWidth && natHeight && natHeight > 0) {
                finalWidth = Math.round(finalHeight * (natWidth / natHeight));
            }
        } else if (explicitWidth && explicitHeight) {
            // 両方指定: 指定サイズを維持
            finalWidth = Number(explicitWidth);
            finalHeight = Number(explicitHeight);
        } else {
            // 指定なし: 元の画像サイズを適用
            if (natWidth) finalWidth = natWidth;
            if (natHeight) finalHeight = natHeight;
        }

        let extraStyle = "max-width: 100% !important; height: auto !important;";
        if (finalWidth) {
            extraStyle = `width: ${finalWidth}px !important; ${extraStyle}`;
            img.setAttribute("width", String(finalWidth)); // Ensure Pandoc recognizes the width attribute
        } else {
            extraStyle = `width: auto !important; ${extraStyle}`;
            img.removeAttribute("width");
        }

        if (finalHeight) {
            img.setAttribute("height", String(finalHeight)); // Ensure Pandoc recognizes the height attribute
        } else {
            img.removeAttribute("height");
        }
        
        const currentStyle = img.getAttribute("style") || "";
        const newStyle = currentStyle ? `${currentStyle.trim()}${currentStyle.endsWith(";") ? "" : ";"} ${extraStyle}` : extraStyle;
        img.setAttribute("style", newStyle);
    });

    // 3. MathJaxの数式復元
    const mjxContainers = tempDiv.querySelectorAll("mjx-container");
    mjxContainers.forEach(mjx => {
        const tex = mjx.getAttribute("data-tex");
        if (tex) {
            const isDisplay = mjx.getAttribute("display") === "true" || mjx.classList?.contains("math-block");
            const texWrapper = isDisplay ? `$$${tex}$$` : `\\(${tex}\\)`;
            
            if (typeof mjx.replaceWith === "function") {
                mjx.replaceWith(texWrapper);
            } else if (mjx.parentNode) {
                const textNode = document.createTextNode(texWrapper);
                mjx.parentNode.replaceChild(textNode, mjx);
            }
        }
    });
};

const sanitizeHtmlExportForContextAndPandoc = (html) => {
    if (!html) return html;
    let cleaned = String(html).replace(/^\uFEFF/, "");
    cleaned = cleaned.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
    cleaned = cleaned.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "");
    cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, "");
    cleaned = cleaned.replace(/^[^\n]*[「"]?["“]?\.?\/image\/[^「」"\n]*["”]?[^\n]*が見つかりませんでした。[^\n]*(?:\r?\n|$)/gm, "");
    // <pre> 内はコードや元Markdownの空白をそのまま保持する。
    // 後段の空行整理が元データを変えないよう、一時的に退避してから戻す。
    const preservedPreBlocks = [];
    cleaned = cleaned.replace(/<pre\b[^>]*>[\s\S]*?<\/pre\s*>/gi, (block) => {
        const token = `__HTML_EXPORT_PRE_BLOCK_${preservedPreBlocks.length}__`;
        preservedPreBlocks.push(block);
        return token;
    });
    cleaned = cleaned.replace(/\r\n?/g, "\n");
    cleaned = cleaned.replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n");
    cleaned = cleaned.trim() + "\n";
    preservedPreBlocks.forEach((block, index) => {
        cleaned = cleaned.replace(`__HTML_EXPORT_PRE_BLOCK_${index}__`, block);
    });
    return cleaned;
};

// 現在のObsidianの見た目（黄色のアクセント、見出しの下線、表の強調）を
// メール添付で読みやすいライトテーマに整理した、人間向けHTML専用の軽量CSS。
// Obsidian本体・テーマ・プラグインの全CSSは非常に大きいため埋め込まない。
const getHumanHtmlExportCss = () => `
:root {
    color-scheme: light;
    --background-primary: #ffffff;
    --background-secondary: #f7f7f5;
    --background-secondary-alt: #f0f0eb;
    --text-normal: #242424;
    --text-muted: #656565;
    --text-accent: #6b5d00;
    --interactive-accent: #d2b900;
    --background-modifier-border: #d8d8d2;
    --code-background: #f4f4f1;
}
* { box-sizing: border-box; }
html { background: var(--background-primary); }
body {
    margin: 0 auto;
    /* ブラウザの中央だけに固定せず、画面幅を有効活用する */
    width: 100%;
    max-width: none;
    padding: 40px clamp(24px, 4vw, 80px) 64px;
    background: var(--background-primary);
    color: var(--text-normal);
    font-family: "M PLUS 1", "Hiragino Sans", "Yu Gothic UI", "Yu Gothic", Meiryo, sans-serif;
    font-size: 17px;
    line-height: 1.72;
    overflow-wrap: anywhere;
    -webkit-font-smoothing: antialiased;
}
.markdown-preview-view, .markdown-rendered { overflow: visible; contain: none; }
p { margin: .65em 0; }
h1, h2, h3, h4, h5, h6 {
    color: #202020;
    line-height: 1.35;
    margin: 1.8em 0 .65em;
    padding-bottom: .22em;
    border-bottom: 1px solid rgba(210, 185, 0, .48);
    text-shadow: 0 0 18px rgba(253, 255, 128, .45);
}
h1 { margin-top: .25em; font-size: 2em; border-bottom-width: 2px; }
h2 { font-size: 1.55em; }
h3 { font-size: 1.28em; }
h4 { font-size: 1.1em; }
h5, h6 { font-size: 1em; color: #444; }
/* Obsidianの見出し階層に合わせて、見出しと直下の本文を同じ左端に揃える */
.html-export-section { margin-left: 0; }
.html-export-section-level-2 { margin-left: 1.0em; }
.html-export-section-level-3 { margin-left: 2.0em; }
.html-export-section-level-4 { margin-left: 3.0em; }
.html-export-section-level-5 { margin-left: 4.0em; }
.html-export-section-level-6 { margin-left: 5.0em; }
/* 見出しを基準に、直下のコンテンツだけをごくわずかに右へずらす */
.html-export-section > :not(h1):not(h2):not(h3):not(h4):not(h5):not(h6) {
    margin-left: .4em;
}
strong { font-weight: 750; color: #332e00; background: linear-gradient(transparent 68%, rgba(253,255,128,.7) 0); }
a { color: #675800; text-decoration-color: #c0a900; text-underline-offset: .15em; }
a:hover { color: #302900; }
ul, ol { padding-left: 1.65em; }
li { margin: .22em 0; }
li::marker { color: #8f7b00; }
.task-list-item { list-style: none; }
input[type="checkbox"] { accent-color: #b69f00; margin: 0 .5em 0 -1.35em; }
blockquote {
    margin: 1.1em 0;
    padding: .55em 1em;
    border-left: 4px solid #d2b900;
    background: #fffef1;
    color: #494949;
}
blockquote > :first-child { margin-top: 0; }
blockquote > :last-child { margin-bottom: 0; }
code, kbd {
    padding: .12em .35em;
    border: 1px solid #e2e2dc;
    border-radius: 4px;
    background: var(--code-background);
    font-family: "M PLUS 1 Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    font-size: .88em;
}
pre {
    margin: 1em 0;
    padding: 1em 1.15em;
    overflow-x: auto;
    border: 1px solid #deded8;
    border-radius: 7px;
    background: var(--code-background);
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
}
pre code { padding: 0; border: 0; background: transparent; font-size: .86em; }
table { width: auto; max-width: 100%; margin: 1.2em 0; border-collapse: collapse; table-layout: auto; line-height: 1.3; font-size: .94em; word-break: normal; }
th, td { padding: .55em .7em; border: 1px solid var(--background-modifier-border); text-align: left; vertical-align: top; min-width: 6ch; max-width: none; white-space: break-spaces; overflow: hidden; text-overflow: ellipsis; }
th { text-align: center; background: var(--background-secondary-alt); color: var(--text-accent); font-weight: 700; border-bottom-width: 2px; }
tbody tr:nth-child(even) { background: #fafaf8; }
/* Obsidianのmarkdown-rendered imgは中央寄せせず、埋め込み位置から左揃え */
img, video, svg { display: inline-block; max-width: 100%; height: auto; margin: 0; vertical-align: middle; }
figure { margin: 1.2em 0; }
figcaption { color: var(--text-muted); font-size: .88em; text-align: center; }
hr { margin: 2em 0; border: 0; border-top: 1px solid var(--background-modifier-border); }
mark { padding: .05em .18em; background: #fff59a; }
.callout {
    margin: 1.2em 0;
    padding: .8em 1em;
    border: 1px solid #ded9a8;
    border-left: 4px solid #d2b900;
    border-radius: 6px;
    background: #fffef4;
}
.callout-title { display: flex; gap: .45em; align-items: center; margin-bottom: .35em; font-weight: 700; }
.callout-icon svg { width: 1.1em; height: 1.1em; margin: 0; }
.callout-content > :first-child { margin-top: 0; }
.callout-content > :last-child { margin-bottom: 0; }
.internal-embed, .markdown-embed { margin: 1em 0; }
.markdown-embed-title, .file-embed-title { color: var(--text-muted); font-size: .88em; }
.heading-collapse-indicator, .collapse-indicator, .copy-code-button, .markdown-embed-link, button { display: none !important; }
@media (max-width: 640px) {
    body { padding: 24px 20px 40px; font-size: 16px; }
    table { display: block; overflow-x: auto; }
}
@page {
    size: A4;
    margin: 15mm;
}
@media print {
    body { max-width: none; padding: 0; font-size: 11pt; }
    a { color: inherit; text-decoration: none; }
    pre, blockquote, table, img, figure, .callout { break-inside: avoid; page-break-inside: avoid; }
    h1, h2, h3, h4, h5, h6 { break-after: avoid; page-break-after: avoid; }
}
`;

const applyHtmlHeadingSections = (root) => {
    if (!root) return;
    const nodes = Array.from(root.children);
    let currentSection = null;

    nodes.forEach((node) => {
        const tagName = String(node.tagName || "").toLowerCase();
        const headingMatch = tagName.match(/^h([1-6])$/);
        if (headingMatch) {
            const level = Number(headingMatch[1]);
            const section = document.createElement("section");
            section.className = `html-export-section html-export-section-level-${level}`;
            root.insertBefore(section, node);
            section.appendChild(node);
            currentSection = section;
        } else if (currentSection) {
            // 次の見出しが現れるまで、本文・表・画像・リストを同じ段にまとめる。
            currentSection.appendChild(node);
        }
    });
};

const applyHtmlHeadingNumbers = (root) => {
    if (!root) return;
    const counters = [0, 0, 0, 0, 0, 0];
    const headings = Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"));
    headings.forEach((heading) => {
        const level = Number(heading.tagName.substring(1));
        if (!level || level > 6) return;

        counters[level - 1] += 1;
        // 見出しレベルを飛ばした場合も、0.1. にはせず階層番号を補完する。
        for (let index = 0; index < level - 1; index += 1) {
            if (counters[index] === 0) counters[index] = 1;
        }
        counters.fill(0, level);

        const numberText = `${counters.slice(0, level).join(".")}. `;
        heading.insertBefore(document.createTextNode(numberText), heading.firstChild);
        heading.classList.add("html-export-numbered-heading");
    });
};

class HtmlExportOptionsModal extends (SummaryModal || class {}) {
    constructor(app, callback) {
        super(app);
        this.callback = callback;
        this.numberHeadings = false;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "人間用HTMLの設定" });

        new SummarySetting(contentEl)
            .setName("番号を付ける")
            .setDesc("見出しを階層に応じて 1. / 1.1. / 1.1.1. の形式で番号付けします（既定：オフ）")
            .addToggle((toggle) => toggle
                .setValue(this.numberHeadings)
                .onChange((value) => {
                    this.numberHeadings = value;
                }));

        new SummarySetting(contentEl)
            .addButton((btn) => btn
                .setButtonText("出力")
                .setCta()
                .onClick(() => {
                    const callback = this.callback;
                    this.callback = null;
                    this.close();
                    callback?.({ numberHeadings: this.numberHeadings });
                }))
            .addButton((btn) => btn
                .setButtonText("キャンセル")
                .onClick(() => {
                    const callback = this.callback;
                    this.callback = null;
                    this.close();
                    callback?.(null);
                }));
    }

    onClose() {
        // ×ボタンやEscで閉じた場合も、出力をキャンセルする。
        if (this.callback) {
            const callback = this.callback;
            this.callback = null;
            callback(null);
        }
    }
}

const orderCommonPromptPaths = (selectedPrompts) => {
    const paths = Array.from(new Set((selectedPrompts || []).filter(Boolean)));
    const mainPromptPath = "11_common_prompt/common_prompt.md";
    return paths.includes(mainPromptPath)
        ? [mainPromptPath, ...paths.filter(path => path !== mainPromptPath)]
        : paths;
};

const buildCommonPromptMarkdown = async (selectedPrompts) => {
    const sections = [];
    for (const promptPath of orderCommonPromptPaths(selectedPrompts)) {
        try {
            const promptFile = app.vault.getAbstractFileByPath(promptPath);
            if (!promptFile) {
                console.warn(`Prompt file not found: ${promptPath}`);
                continue;
            }
            const promptContent = await app.vault.read(promptFile);
            sections.push(`# Source: ${promptPath}\n${promptContent}`);
        } catch (error) {
            console.error(`Failed to read prompt file ${promptPath}:`, error);
        }
    }
    return sections.length > 0
        ? `# 共通プロンプト\n\n${sections.join("\n\n---\n\n")}`
        : "";
};

const askAiHtmlExportOptions = async () => {
    if (SummaryModal && SummarySetting) {
        return new Promise((resolve) => {
            new AiHtmlExportOptionsModal(app, (result) => resolve(result)).open();
        });
    }

    // Modal APIが使えない環境では、サマリーと同じ既定プロンプトを使用する。
    return { selectedPrompts: ["11_common_prompt/common_prompt.md"] };
};

const askHtmlExportOptions = async () => {
    if (SummaryModal && SummarySetting) {
        return new Promise((resolve) => {
            new HtmlExportOptionsModal(app, (result) => resolve(result)).open();
        });
    }

    // Modal APIが使えない環境では、従来どおり番号なしで出力する。
    return { numberHeadings: false };
};

const sanitizeHtmlExportForHuman = (html) => {
    if (!html) return html;
    return String(html)
        .replace(/^\uFEFF/, "")
        .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, "")
        .replace(/\r\n?/g, "\n")
        .trim() + "\n";
};

const postProcessSavedHtmlExport = async (savePath) => {
    const fs = require("fs");
    let html = fs.readFileSync(savePath, "utf8");
    html = sanitizeHtmlExportForContextAndPandoc(html);

    html = html.replace(/\s(?:src|href)=["'][^"']*_assets\/[^"']+["']/gi, "");

    html = html
        .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, "")
        .replace(/<\/?span\b[^>]*>/gi, "")
        .replace(/<div\b[^>]*>\s*<\/div>/gi, "")
        .replace(/<\/?div\b[^>]*>/gi, "")
        .replace(/\s(?:class|style|data-[\w:-]+|aria-[\w:-]+|referrerpolicy|loading|decoding|draggable|contenteditable|spellcheck)=(".*?"|'.*?')/gi, "")
        .replace(/\s(?:tabindex|role|translate|dir|rel|target)=(".*?"|'.*?')/gi, "");
    html = sanitizeHtmlExportForContextAndPandoc(html);
    fs.writeFileSync(savePath, html, "utf8");
    return savePath;
};

const copyTextToClipboard = async (text) => {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (e) {
            console.warn("navigator.clipboard.writeText failed. Falling back to Electron clipboard.", e);
        }
    }
    try {
        let electron;
        try {
            electron = require("electron");
        } catch (e) {
            electron = typeof window !== "undefined" && window.require ? window.require("electron") : null;
        }
        if (electron?.clipboard?.writeText) {
            electron.clipboard.writeText(text);
            return true;
        }
    } catch (e) {
        console.error("Failed to copy text to clipboard:", e);
    }
    return false;
};

/**
 * 対象のマークダウンファイルからエクスポート用HTML文字列を生成する
 * - Excalidraw埋め込みのPNG置換、画像Base64化、Pandoc/印刷向けスタイルの適用
 **/
const generateExportHtml = async (file, exportTarget = "ai", exportOptions = {}) => {
    if (!file) return null;

    const isHumanExport = exportTarget === "human";
    const selectedPrompts = Array.isArray(exportOptions?.selectedPrompts)
        ? exportOptions.selectedPrompts
        : [];
    const humanExportOptions = {
        numberHeadings: exportOptions?.numberHeadings === true
    };

    let obsidianLib;
    try {
        obsidianLib = require("obsidian");
    } catch (err) {
        obsidianLib = app.plugins.plugins["templater-obsidian"]?.obsidian || (typeof tp !== 'undefined' ? tp.obsidian : null) || (typeof window !== 'undefined' ? window.obsidian : null);
    }

    let tempDiv = null;
    let component = null;

    try {
        window._htmlExportExcalidrawRenderCache = new Map();
        const rawContent = await app.vault.read(file);
        const exportMarkdown = stripExcalidrawDataSectionForExport(rawContent, file);
        const renderedMarkdown = await replaceExcalidrawEmbedsForHtmlExport(exportMarkdown, file);
        const commonPromptMarkdown = isHumanExport
            ? ""
            : await buildCommonPromptMarkdown(selectedPrompts);
        const content = commonPromptMarkdown
            ? `${commonPromptMarkdown}\n\n---\n\n${renderedMarkdown}`
            : renderedMarkdown;
        tempDiv = document.createElement("div");

        if (!obsidianLib) {
            throw new Error("Obsidian library not found.");
        }

        // 一時的に body にアタッチ（非表示）して、プラグインによる非同期レンダリングを動作させる
        tempDiv.style.position = "absolute";
        tempDiv.style.left = "-9999px";
        tempDiv.style.top = "-9999px";
        tempDiv.style.width = "1024px";
        document.body.appendChild(tempDiv);

        // MarkdownRendererを使ってHTMLを一時的な要素に描画する
        component = new obsidianLib.Component();
        component.load();

        await obsidianLib.MarkdownRenderer.render(app, content, tempDiv, file.path, component);

        // Excalidraw等の非同期レンダリングの完了を待つ
        const hasPendingExcalidraw = () => {
            const imgs = tempDiv.querySelectorAll("img");
            for (const img of Array.from(imgs)) {
                const filesource = img.getAttribute("filesource");
                const src = img.getAttribute("src");
                if (filesource && (filesource.endsWith(".excalidraw.md") || filesource.endsWith(".excalidraw"))) {
                    if (src === "data:," || !src) {
                        return true;
                    }
                }
            }
            return false;
        };

        let waitTime = 0;
        const maxWaitTime = 2000; // 最大2秒
        while (hasPendingExcalidraw() && waitTime < maxWaitTime) {
            await new Promise(resolve => setTimeout(resolve, 100));
            waitTime += 100;
        }

        // 数式や画像のパス置換
        await convertPreviewHtmlForPandoc(tempDiv, file);

        // セーフティネット: 残存するfile:// URL画像をBase64に変換
        const remainingFileImgs = tempDiv.querySelectorAll('img[src^="file://"]');
        for (const img of Array.from(remainingFileImgs)) {
            try {
                const fileSrc = img.getAttribute("src");
                const cleanPath = normalizeLocalFilePath(fileSrc);
                const basePath = app.vault.adapter.basePath;
                let relativePath = cleanPath;
                const normalizedBasePath = normalizeLocalFilePath(basePath);
                if (cleanPath.startsWith(normalizedBasePath)) {
                    relativePath = cleanPath.slice(normalizedBasePath.length).replace(/^\//, "");
                }
                const dataUrl = await readFileAsBase64DataUrl(relativePath);
                if (dataUrl) {
                    img.setAttribute("src", dataUrl);
                }
            } catch (e) {
                console.error("Safety net base64 conversion failed:", e);
            }
        }

        // 現在のbodyのクラス名を取得して引き継ぐ (テーマ、フォント、モードの反映のため)
        let bodyClass = document.body ? document.body.className : "";
        // ダークモードクラスをライトモードに置換して、印刷用/ライトテーマの表示にする
        bodyClass = bodyClass.replace(/\btheme-dark\b/g, "theme-light");
        if (!bodyClass.includes("theme-light")) {
            bodyClass += " theme-light";
        }
        if (isHumanExport && humanExportOptions.numberHeadings) {
            bodyClass += " html-export-numbered";
            applyHtmlHeadingNumbers(tempDiv);
        }
        if (isHumanExport) {
            applyHtmlHeadingSections(tempDiv);
        }

        // AIコンテキスト用は従来どおり後処理でCSSを除去する。
        // 人間用は依存のない軽量な専用CSSだけを埋め込む。
        const exportCss = isHumanExport ? getHumanHtmlExportCss() : `
/* HTML Export Scroller & Style Overrides */
html, body {
    overflow: auto !important;
    height: auto !important;
    max-height: none !important;
    contain: none !important;
    overscroll-behavior: auto !important;
    position: relative !important;
    display: block !important;
    background-color: #ffffff !important;
    
    /* リスト・チェックボックスの黒色リセット（テーマカラーの黄色等を上書き） */
    --list-marker-color: #000000 !important;
    --checkbox-border-color: #000000 !important;
    --checkbox-border-color-hover: #000000 !important;
    --checkbox-color: #000000 !important;
}
.markdown-preview-view, .markdown-rendered {
    overflow: visible !important;
    height: auto !important;
    max-height: none !important;
    contain: none !important;
    background-color: #ffffff !important;
}
/* リストマーカー、チェックボックスの直接的な黒色リセット */
li::marker, ul li::before {
    color: #000000 !important;
}
input[type="checkbox"] {
    border-color: #000000 !important;
    color: #000000 !important;
}
/* 画像の基本制限 */
img {
    max-width: 100% !important;
    height: auto !important;
}
`;

        // 最終的なHTML構築 (スタイルとクラスを含める)
        const title = file.basename;
        const escapedTitle = escapeHtmlAttribute(title);
        const escapedBodyClass = escapeHtmlAttribute(bodyClass.trim());
        const rawMarkdownSection = isHumanExport ? "" : `
<section class="markdown-source">
<h2>マークダウンファイルの元データ</h2>
<pre><code>${escapeHtmlText(exportMarkdown)}</code></pre>
</section>`;
        const htmlBody = `${tempDiv.innerHTML}${rawMarkdownSection}`;
        component.unload();
        component = null;
        if (tempDiv.parentNode === document.body) {
            document.body.removeChild(tempDiv);
        }
        tempDiv = null;
        const htmlDocument = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapedTitle}</title>
<style>
${exportCss}
</style>
</head>
<body class="${escapedBodyClass}">
${htmlBody}
</body>
</html>`;
        return isHumanExport
            ? sanitizeHtmlExportForHuman(htmlDocument)
            : sanitizeHtmlExportForContextAndPandoc(htmlDocument);
    } finally {
        if (component) {
            try { component.unload(); } catch (e) {}
        }
        if (tempDiv?.parentNode === document.body) {
            try { document.body.removeChild(tempDiv); } catch (e) {}
        }
    }
};

/**
 * HTML文字列からPDFファイルを生成して保存する
 * 1. Google Chrome / Chromium / Edge ヘッドレス コマンド実行（最高品質・白紙化防止・最優先）
 * 2. Electron BrowserWindow.webContents.printToPDF（フォールバック）
 **/
const convertHtmlToPdf = async (fullHtml, savePath, options = {}) => {
    const req = typeof require !== "undefined" ? require : (typeof window !== "undefined" ? window.require : null);
    if (!req) {
        throw new Error("Node.js require environment is not available.");
    }
    const fs = req("fs");
    const path = req("path");
    const { execFile } = req("child_process");

    fs.mkdirSync(path.dirname(savePath), { recursive: true });

    // 1. Google Chrome / Chromium / Edge ヘッドレス コマンド実行を最優先
    const chromeCandidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser"
    ];

    let foundChrome = null;
    for (const cand of chromeCandidates) {
        if (cand.includes("/") || cand.includes("\\")) {
            if (fs.existsSync(cand)) {
                foundChrome = cand;
                break;
            }
        } else {
            try {
                const { execSync } = req("child_process");
                const whichCmd = process.platform === "win32" ? "where" : "which";
                const res = execSync(`${whichCmd} ${cand}`, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
                if (res) {
                    foundChrome = cand;
                    break;
                }
            } catch (e) {}
        }
    }

    if (foundChrome) {
        const tempHtmlPath = path.join(path.dirname(savePath), `.${path.basename(savePath)}.${Date.now()}.temp.html`);
        fs.writeFileSync(tempHtmlPath, fullHtml, "utf8");
        try {
            await new Promise((resolve, reject) => {
                execFile(foundChrome, [
                    "--headless",
                    "--disable-gpu",
                    "--no-pdf-header-footer",
                    `--print-to-pdf=${savePath}`,
                    tempHtmlPath
                ], (error) => {
                    try { if (fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath); } catch (e) {}
                    if (error) {
                        reject(error);
                    } else {
                        resolve(true);
                    }
                });
            });

            // 生成されたPDFが白紙（空）でないか検証 (1000 bytes以上)
            if (fs.existsSync(savePath)) {
                const stat = fs.statSync(savePath);
                if (stat.size > 1000) {
                    return true;
                }
                console.warn(`Generated PDF via Chrome is too small (${stat.size} bytes), trying fallback...`);
            }
        } catch (chromeErr) {
            console.warn("Chrome headless PDF export failed, trying Electron fallback:", chromeErr);
            try { if (fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath); } catch (e) {}
        }
    }

    // 2. Electron BrowserWindow によるフォールバック
    let electron;
    try {
        electron = req("electron");
    } catch (e) {
        try { electron = window.require("electron"); } catch (err) {}
    }
    let remote = null;
    if (electron?.remote) remote = electron.remote;
    else {
        try { remote = req("@electron/remote"); } catch (e) {
            try { remote = window.require("@electron/remote"); } catch (err) {}
        }
    }

    const BrowserWindow = remote?.BrowserWindow || electron?.BrowserWindow;
    if (BrowserWindow && typeof BrowserWindow === "function") {
        let win = null;
        const tempHtmlPath = path.join(path.dirname(savePath), `.${path.basename(savePath)}.${Date.now()}.temp.html`);
        try {
            fs.writeFileSync(tempHtmlPath, fullHtml, "utf8");
            win = new BrowserWindow({
                show: false,
                width: 1024,
                height: 768,
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true
                }
            });

            await win.loadFile(tempHtmlPath);
            await win.webContents.executeJavaScript(`
                Promise.all([
                    document.fonts ? document.fonts.ready : Promise.resolve(),
                    Promise.all(Array.from(document.images).filter(img => !img.complete).map(img => new Promise(res => { img.onload = img.onerror = res; })))
                ])
            `).catch(() => {});
            await new Promise(resolve => setTimeout(resolve, 500));

            const pdfData = await win.webContents.printToPDF({
                printBackground: true,
                pageSize: 'A4',
                margins: {
                    top: 0.4,
                    bottom: 0.4,
                    left: 0.4,
                    right: 0.4
                }
            });

            fs.writeFileSync(savePath, pdfData);
            try { if (fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath); } catch (e) {}
            if (win && !win.isDestroyed()) win.destroy();
            return true;
        } catch (winErr) {
            console.error("Electron BrowserWindow printToPDF failed:", winErr);
            if (win && !win.isDestroyed()) {
                try { win.destroy(); } catch (e) {}
            }
            try { if (fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath); } catch (e) {}
            throw winErr;
        }
    }

    throw new Error("PDF変換エンジン（Google Chrome/Chromium または Electron BrowserWindow）が利用できませんでした。");
};

/**
 * 対象のマークダウンファイルを人間用HTML経由でPDFとして出力する
 **/
const exportPdf = async (file, exportOptions = {}) => {
    if (!file) return;

    let humanExportOptions = { numberHeadings: false };
    if (!exportOptions?.skipPromptSelection) {
        humanExportOptions = await askHtmlExportOptions();
        if (!humanExportOptions) return null;
    }

    let obsidianLib;
    try {
        obsidianLib = require("obsidian");
    } catch (err) {
        obsidianLib = app.plugins.plugins["templater-obsidian"]?.obsidian || (typeof tp !== 'undefined' ? tp.obsidian : null) || (typeof window !== 'undefined' ? window.obsidian : null);
    }
    const NoticeClass = obsidianLib?.Notice || (typeof window !== "undefined" && window.Notice) || (typeof global !== "undefined" && global.Notice) || class {};

    new NoticeClass("人間用PDFを生成中...");

    try {
        const fullHtml = await generateExportHtml(file, "human", {
            ...humanExportOptions,
            ...exportOptions
        });
        if (!fullHtml) {
            throw new Error("HTMLの生成に失敗しました。");
        }

        // 保存ダイアログ表示
        let electron;
        let remoteDialog;
        try {
            electron = require("electron");
            if (electron.remote && electron.remote.dialog) {
                remoteDialog = electron.remote.dialog;
            }
        } catch (e) {
            try {
                electron = window.require("electron");
                if (electron.remote && electron.remote.dialog) {
                    remoteDialog = electron.remote.dialog;
                }
            } catch (err) {}
        }
        if (!remoteDialog) {
            try {
                remoteDialog = require("@electron/remote").dialog;
            } catch (e) {
                try {
                    remoteDialog = window.require("@electron/remote").dialog;
                } catch (err) {}
            }
        }

        const path = require("path");
        const title = file.basename;
        const basePath = app.vault.adapter.basePath;
        const automaticSavePath = exportOptions?.savePath;
        const tempDirPath = automaticSavePath ? null : ensureTempDirExists();
        const defaultSavePath = tempDirPath ? path.join(tempDirPath, title + ".pdf") : path.join(basePath, file.parent?.path || "", title + ".pdf");

        let savePath = automaticSavePath || null;
        if (!savePath && remoteDialog) {
            const options = {
                title: "PDFで出力(人間用)",
                defaultPath: defaultSavePath,
                filters: [
                    { name: "PDF Files", extensions: ["pdf"] }
                ]
            };
            const result = await remoteDialog.showSaveDialog(options);
            if (!result.canceled && result.filePath) {
                savePath = result.filePath;
            }
        } else if (!savePath) {
            savePath = defaultSavePath;
        }

        if (savePath) {
            await convertHtmlToPdf(fullHtml, savePath);
            if (automaticSavePath) {
                new NoticeClass("PDFを保存しました: " + savePath);
            } else {
                const copied = await copyTextToClipboard(savePath);
                if (copied) {
                    new NoticeClass("人間用PDFを保存しました。フルパスをクリップボードにコピーしました: " + savePath);
                } else {
                    new NoticeClass("人間用PDFを保存しました。クリップボードへのコピーに失敗しました: " + savePath);
                }
            }
            return savePath;
        }
        return null;
    } catch (error) {
        new NoticeClass("PDFの出力に失敗しました: " + error.message);
        console.error("PDF export error:", error);
        return null;
    }
};

/**
 * 対象のマークダウンファイルをHTMLとして出力する
 * - 一時的な要素にレンダリング後、Pandoc向けにHTMLを変換
 * - 通常は保存ダイアログを表示してファイルを保存
 * - exportOptions.savePath が指定された場合は、指定先へ自動保存
 **/
const exportHtml = async (file, exportTarget = "ai", exportOptions = {}) => {
    if (!file) return;

    const isHumanExport = exportTarget === "human";
    let selectedPrompts = Array.isArray(exportOptions?.selectedPrompts)
        ? exportOptions.selectedPrompts
        : null;
    let humanExportOptions = { numberHeadings: false };
    if (isHumanExport) {
        humanExportOptions = await askHtmlExportOptions();
        if (!humanExportOptions) return null;
    } else if (selectedPrompts === null && !exportOptions?.skipPromptSelection) {
        const aiExportOptions = await askAiHtmlExportOptions();
        if (!aiExportOptions) return null;
        selectedPrompts = aiExportOptions.selectedPrompts || [];
    }
    if (selectedPrompts === null) selectedPrompts = [];

    let obsidianLib;
    try {
        obsidianLib = require("obsidian");
    } catch (err) {
        obsidianLib = app.plugins.plugins["templater-obsidian"]?.obsidian || (typeof tp !== 'undefined' ? tp.obsidian : null) || (typeof window !== 'undefined' ? window.obsidian : null);
    }
    const NoticeClass = obsidianLib?.Notice || (typeof window !== "undefined" && window.Notice) || (typeof global !== "undefined" && global.Notice) || class {};

    new NoticeClass(isHumanExport ? "人間用HTMLを生成中..." : "AIコンテキスト用HTMLを生成中...");

    try {
        const fullHtml = await generateExportHtml(file, exportTarget, {
            ...humanExportOptions,
            ...exportOptions,
            selectedPrompts
        });
        if (!fullHtml) {
            throw new Error("HTMLの生成に失敗しました。");
        }

        // 保存ダイアログ表示
        let electron;
        let remoteDialog;
        try {
            electron = require("electron");
            if (electron.remote && electron.remote.dialog) {
                remoteDialog = electron.remote.dialog;
            }
        } catch (e) {
            try {
                electron = window.require("electron");
                if (electron.remote && electron.remote.dialog) {
                    remoteDialog = electron.remote.dialog;
                }
            } catch (err) {}
        }
        if (!remoteDialog) {
            try {
                remoteDialog = require("@electron/remote").dialog;
            } catch (e) {
                try {
                    remoteDialog = window.require("@electron/remote").dialog;
                } catch (err) {}
            }
        }

        const path = require("path");
        const fs = require("fs");
        const title = file.basename;
        const basePath = app.vault.adapter.basePath;
        const automaticSavePath = exportOptions?.savePath;
        const tempDirPath = automaticSavePath ? null : ensureTempDirExists();
        const defaultSavePath = tempDirPath ? path.join(tempDirPath, title + ".html") : path.join(basePath, file.parent?.path || "", title + ".html");

        let savePath = automaticSavePath || null;
        if (!savePath && remoteDialog) {
            const options = {
                title: isHumanExport ? "HTMLで出力(人間用)" : "HTMLで出力(AIコンテキスト用)",
                defaultPath: defaultSavePath,
                filters: [
                    { name: "HTML Files", extensions: ["html"] }
                ]
            };
            const result = await remoteDialog.showSaveDialog(options);
            if (!result.canceled && result.filePath) {
                savePath = result.filePath;
            }
        } else if (!savePath) {
            // モバイルや非Electron環境向けのフォールバック
            savePath = defaultSavePath;
        }

        if (savePath) {
            fs.mkdirSync(path.dirname(savePath), { recursive: true });
            fs.writeFileSync(savePath, fullHtml, "utf8");
            if (!isHumanExport) {
                await postProcessSavedHtmlExport(savePath);
            }
            if (automaticSavePath) {
                new NoticeClass("サマリーHTMLを保存しました: " + savePath);
            } else {
                const copied = await copyTextToClipboard(savePath);
                if (copied) {
                    new NoticeClass((isHumanExport ? "人間用HTML" : "AIコンテキスト用HTML") + "を保存しました。フルパスをクリップボードにコピーしました: " + savePath);
                } else {
                    new NoticeClass((isHumanExport ? "人間用HTML" : "AIコンテキスト用HTML") + "を保存しました。クリップボードへのコピーに失敗しました: " + savePath);
                }
            }
            return savePath;
        }
        return null;
    } catch (error) {
        new NoticeClass("HTMLの出力に失敗しました: " + error.message);
        console.error("HTML export error:", error);
        return null;
    }
};

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
    setTimeout(() => {
        if (menu.dom) {
            const items = Array.from(menu.dom.querySelectorAll(".menu-item"));
            const mocItem = items.find(el => el.textContent.includes("MOCを作成"));
            const noteListItem = items.find(el => el.textContent.includes("ノート一覧を追加"));
            const renameItem = items.find(el => el.textContent.includes("一括変換"));
            if (mocItem) {
                menu.dom.prepend(mocItem);
            }
            if (noteListItem) {
                menu.dom.prepend(noteListItem);
            }
            if (renameItem) {
                menu.dom.prepend(renameItem);
            }
        }
    }, 50);
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

// 重複登録の防止
if (window._customFileOpenListener) {
    app.workspace.off("file-open", window._customFileOpenListener);
}
window._customFileOpenListener = handleFileOpen;
app.workspace.on("file-open", window._customFileOpenListener);
console.log("File open listener registered for auto-updating top notes");

// 重複登録の防止
if (window._customTagMenuListener) {
    app.workspace.off("tag-menu", window._customTagMenuListener);
}
window._customTagMenuListener = handleTagMenu;
app.workspace.on("tag-menu", window._customTagMenuListener);
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

if (window._customTopNoteListLinkClickListener) {
    document.removeEventListener("click", window._customTopNoteListLinkClickListener, true);
}
window._customTopNoteListLinkClickListener = handleTopNoteListLinkClick;
document.addEventListener("click", window._customTopNoteListLinkClickListener, true);

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

if (window._customFileManagerDropListener) {
    document.removeEventListener("drop", window._customFileManagerDropListener, true);
}
window._customFileManagerDropListener = handleFileManagerDrop;
document.addEventListener("drop", window._customFileManagerDropListener, true);

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
    menu.showAtMouseEvent(e);
};

if (window._customFileManagerLinkContextMenuListener) {
    document.removeEventListener("contextmenu", window._customFileManagerLinkContextMenuListener, true);
}
window._customFileManagerLinkContextMenuListener = handleFileManagerLinkContextMenu;
document.addEventListener("contextmenu", window._customFileManagerLinkContextMenuListener, true);
%>
