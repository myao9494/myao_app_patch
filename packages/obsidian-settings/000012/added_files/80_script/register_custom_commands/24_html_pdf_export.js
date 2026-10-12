// =============================================================================
// HTML / PDF 出力（画像のインライン化、ExcalidrawのPNG化、出力用HTMLの生成）
// =============================================================================

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

// Markdownソースから、数値でサイズ指定された埋め込み（![[名前|幅]]）の幅を集める。
// キーは、フォルダを除いたファイル名（小文字）。
const readMarkdownEmbedSizes = async (sourceFile) => {
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
    return markdownEmbedSizes;
};

// 不要なUI要素の削除 (例: copy-code-button)
const removeCopyCodeButtons = (tempDiv) => {
    const copyButtons = tempDiv.querySelectorAll(".copy-code-button");
    copyButtons.forEach(btn => {
        if (btn.parentNode) {
            btn.parentNode.removeChild(btn);
        }
    });
};

// 埋め込み（span.internal-embed）のサイズ指定を、置き換え先の img へ引き継ぐ。
const copyEmbedSizeAttributes = (span, img) => {
    const widthAttr = span.getAttribute("width") || span.getAttribute("w");
    const heightAttr = span.getAttribute("height") || span.getAttribute("h");
    if (widthAttr) img.setAttribute("width", widthAttr);
    if (heightAttr) img.setAttribute("height", heightAttr);
};

// SVGをPNG化した結果を img に設定する。PNG化できていなければ何もせず false を返す。
const applyRasterizedSvgToImg = (img, result) => {
    if (!result || !result.pngDataUrl) return false;
    img.setAttribute("src", result.pngDataUrl);
    if (result.width) {
        img.setAttribute("data-native-width", String(result.width));
    }
    if (result.height) {
        img.setAttribute("data-native-height", String(result.height));
    }
    return true;
};

// インラインSVG（Excalidraw、Drawio等）を含む span.internal-embed を、画像要素に置き換える。
const replaceEmbedSpansWithImagesForPandoc = async (tempDiv, sourceFile) => {
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
            copyEmbedSizeAttributes(span, img);

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
                copyEmbedSizeAttributes(span, img);

                // SVGはPNGのData URLに変換する
                const result = await rasterizeSvgFileToPngDataUrl(targetFile.path);
                if (!applyRasterizedSvgToImg(img, result)) {
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
};

// file:// 形式のURLを、保管庫からの相対パスにする（保管庫の外のファイルは、ローカルの絶対パスのまま）。
const fileUrlToVaultRelativePath = (fileUrl) => {
    const fileProtocolPrefix = "file://";
    let absolutePath = fileUrl.startsWith(fileProtocolPrefix) ? fileUrl.slice(fileProtocolPrefix.length) : fileUrl;
    absolutePath = normalizeLocalFilePath(absolutePath);

    const normalizedBasePath = normalizeLocalFilePath(app.vault.adapter.basePath);
    if (absolutePath.startsWith(normalizedBasePath)) {
        return absolutePath.slice(normalizedBasePath.length).replace(/^\//, "");
    }
    return absolutePath;
};

// app:// 形式の画像URL（ハッシュ付き、app://local/ 両対応）を、Data URL に置き換える。
// SVG は PNG 化を優先し、できなければ他の画像と同じく Base64 化する。どちらも失敗したら file:// のURLにする。
const inlineAppUrlImageForPandoc = async (img, src) => {
    const cleanSrc = src.replace(/^app:\/\/[^\/]+\//, "file:///");
    const cleanPathForCheck = cleanSrc.split("?")[0].toLowerCase();
    const relativePath = fileUrlToVaultRelativePath(cleanSrc);

    if (cleanPathForCheck.endsWith(".svg")) {
        const result = await rasterizeSvgFileToPngDataUrl(relativePath);
        if (applyRasterizedSvgToImg(img, result)) return;
    }

    const dataUrl = await readFileAsBase64DataUrl(relativePath);
    img.setAttribute("src", dataUrl || cleanSrc);
};

// 相対パスまたはVault内リンクの画像を、ファイルを特定して Data URL に置き換える。
// SVG は PNG 化を優先し、できなければ Base64 化する。どちらも失敗したら絶対パスの file:// URL にする。
const inlineVaultLinkedImageForPandoc = async (img, src, sourceFile) => {
    const targetFile = app.metadataCache.getFirstLinkpathDest(src, sourceFile.path);
    if (!targetFile) return;

    if (targetFile.extension && targetFile.extension.toLowerCase() === "svg") {
        const result = await rasterizeSvgFileToPngDataUrl(targetFile.path);
        if (applyRasterizedSvgToImg(img, result)) return;
    }

    const dataUrl = await readFileAsBase64DataUrl(targetFile.path);
    if (dataUrl) {
        img.setAttribute("src", dataUrl);
    } else {
        const basePath = app.vault.adapter.basePath;
        const absPath = toFileUrl(`${basePath}/${targetFile.path}`);
        img.setAttribute("src", absPath);
    }
};

// 画像の参照先を、Pandoc が読める形（PNG / Base64 の Data URL、または絶対パス）へ置き換える。
const inlineImagesForPandoc = async (tempDiv, sourceFile) => {
    const imgs = tempDiv.querySelectorAll("img");
    for (const img of Array.from(imgs)) {
        const filesource = img.getAttribute("filesource");
        const src = img.getAttribute("src");
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

        if (src && src.startsWith("app://")) {
            await inlineAppUrlImageForPandoc(img, src);
        } else if (src && !src.startsWith("http://") && !src.startsWith("https://") && !src.startsWith("file://") && !src.startsWith("data:") && !src.startsWith("blob:")) {
            await inlineVaultLinkedImageForPandoc(img, src, sourceFile);
        }
    }
};

// 画像を包んでいる span.internal-embed のサイズ指定を探す。
const findEmbedSpanSizeForImg = (img, tempDiv) => {
    let parent = img.parentNode;
    while (parent && parent !== tempDiv) {
        const className = (typeof parent.getAttribute === "function" ? parent.getAttribute("class") : "") || parent.className || "";
        const classes = className.split(/\s+/);
        if (parent.tagName === "SPAN" && classes.includes("internal-embed")) {
            return {
                width: parent.getAttribute("width") || parent.getAttribute("w"),
                height: parent.getAttribute("height") || parent.getAttribute("h"),
            };
        }
        parent = parent.parentNode;
    }
    return { width: null, height: null };
};

// Markdownに記述された埋め込みサイズ（![[名前|幅]]）のうち、この画像に当たるものを探す。
const findMarkdownEmbedWidthForImg = (img, markdownEmbedSizes) => {
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
    if (!embedKey) return null;

    const mdWidth = markdownEmbedSizes.get(embedKey.toLowerCase());
    if (mdWidth) return mdWidth;
    const baseKey = embedKey.replace(/\.[^/.]+$/, "").toLowerCase();
    return markdownEmbedSizes.get(baseKey);
};

// 指定サイズと元の画像サイズから、出力する幅と高さを決める（片方だけの指定は縦横比を保つ）。
const resolvePandocImageSize = ({ explicitWidth, explicitHeight, natWidth, natHeight }) => {
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

    return { finalWidth, finalHeight };
};

// 画像の巨大化防止とサイズ指定の上書き強制 (スタイル埋め込み時の表示崩れ対策)
const applyImageSizeForPandoc = (img, tempDiv, markdownEmbedSizes) => {
    // 親の span.internal-embed などからサイズ属性を引き継ぐ
    const parentSize = findEmbedSpanSizeForImg(img, tempDiv);

    // Markdownに記述された埋め込みサイズがあれば取得
    const mdWidth = findMarkdownEmbedWidthForImg(img, markdownEmbedSizes);

    const nativeWidth = typeof img.getAttribute === "function" ? img.getAttribute("data-native-width") : null;
    const nativeHeight = typeof img.getAttribute === "function" ? img.getAttribute("data-native-height") : null;

    // 明示的な指定サイズと元の画像サイズの抽出
    const { finalWidth, finalHeight } = resolvePandocImageSize({
        explicitWidth: img.getAttribute("width") || img.getAttribute("w") || parentSize.width || (mdWidth ? String(mdWidth) : null),
        explicitHeight: img.getAttribute("height") || img.getAttribute("h") || parentSize.height,
        natWidth: nativeWidth ? Number(nativeWidth) : (img.naturalWidth || null),
        natHeight: nativeHeight ? Number(nativeHeight) : (img.naturalHeight || null),
    });

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
};

// MathJaxの数式（mjx-container）を、TeX記法（\(...\) / $$...$$）のテキストへ戻す。
const restoreMathJaxAsTex = (tempDiv) => {
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

/**
 * プレビューHTMLのDOM要素をPandoc(Word)向けにクリーンアップ・変換する
 * - 画像のsrc属性をローカル絶対パス(file://)またはPNGのData URL(SVG画像の場合)に変換
 * - MathJax数式(mjx-container)をTeX記号(\(...\), $$...$$)に書き戻す
 * - 不要なUI要素を削除
 **/
const convertPreviewHtmlForPandoc = async (tempDiv, sourceFile) => {
    // 0. Markdownソースファイルから埋め込み画像のサイズ指定（例：![[図|300]]）を抽出
    const markdownEmbedSizes = await readMarkdownEmbedSizes(sourceFile);

    // 1. 不要なUI要素の削除
    removeCopyCodeButtons(tempDiv);

    // 2. 画像パスの絶対パス化とインラインSVG (Drawio等) の置換
    await replaceEmbedSpansWithImagesForPandoc(tempDiv, sourceFile);
    await inlineImagesForPandoc(tempDiv, sourceFile);
    tempDiv.querySelectorAll("img").forEach((img) => applyImageSizeForPandoc(img, tempDiv, markdownEmbedSizes));

    // 3. MathJaxの数式復元
    restoreMathJaxAsTex(tempDiv);
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

// AIコンテキスト用HTMLに埋め込むCSS（スクロールの解除、白背景、リスト・チェックボックスの黒色化）。
// 文字色は上書きしない（ノートの表示に合わせる）。
const getContextHtmlExportCss = () => `
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

// 出力HTMLの body クラス。現在の表示のクラスを引き継ぎつつ、ダークテーマはライトテーマへ置き換える。
const toLightThemeBodyClass = (currentBodyClass) => {
    let bodyClass = currentBodyClass.replace(/\btheme-dark\b/g, "theme-light");
    if (!bodyClass.includes("theme-light")) {
        bodyClass += " theme-light";
    }
    return bodyClass;
};

// 変換後も file:// のまま残っている画像を、Base64 の Data URL に置き換える。
const inlineRemainingFileUrlImages = async (tempDiv) => {
    const remainingFileImgs = tempDiv.querySelectorAll('img[src^="file://"]');
    for (const img of Array.from(remainingFileImgs)) {
        try {
            const fileSrc = img.getAttribute("src");
            const dataUrl = await readFileAsBase64DataUrl(fileUrlToVaultRelativePath(fileSrc));
            if (dataUrl) {
                img.setAttribute("src", dataUrl);
            }
        } catch (e) {
            console.error("Safety net base64 conversion failed:", e);
        }
    }
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

    const obsidianLib = getObsidianModule();

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
        await inlineRemainingFileUrlImages(tempDiv);

        // 現在のbodyのクラス名を取得して引き継ぐ (テーマ、フォント、モードの反映のため)
        let bodyClass = toLightThemeBodyClass(document.body ? document.body.className : "");
        if (isHumanExport && humanExportOptions.numberHeadings) {
            bodyClass += " html-export-numbered";
            applyHtmlHeadingNumbers(tempDiv);
        }
        if (isHumanExport) {
            applyHtmlHeadingSections(tempDiv);
        }

        // AIコンテキスト用は従来どおり後処理でCSSを除去する。
        // 人間用は依存のない軽量な専用CSSだけを埋め込む。
        const exportCss = isHumanExport ? getHumanHtmlExportCss() : getContextHtmlExportCss();

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

    const obsidianLib = getObsidianModule();
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

    const obsidianLib = getObsidianModule();
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
