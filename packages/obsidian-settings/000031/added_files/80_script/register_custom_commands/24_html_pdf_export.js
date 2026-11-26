// =============================================================================
// HTML / PDF 出力（画像のインライン化、ExcalidrawとCADコードブロックのPNG化、出力用HTMLの生成）
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
 * 図を PNG にするときの倍率。ブラウザのキャンバスには大きさの上限があり（超えると空の画像になる）、
 * 縦長・横長の大きな図では、辺の長さ 16000px・面積 1億px に収まるまで倍率を下げる。
 **/
const getSafeCanvasScale = (width, height, scale) => {
    const w = Math.max(1, Number(width) || 1);
    const h = Math.max(1, Number(height) || 1);
    return Math.min(scale, 16000 / w, 16000 / h, Math.sqrt(100000000 / (w * h)));
};

/**
 * SVG文字列をPNGのData URL(Base64)にラスタライズする
 **/
const rasterizeSvgContentToPngDataUrl = async (svgContent, scale = 3) => {
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

        // 3. 日本語の文字は、図のフォント（Cascadia など）に無いため端末のフォントで描かれる。
        //    言語の指定が無いと、漢字に使うフォントを端末の言語設定から選ぶ（中国語のフォントになることがある）ため、
        //    日本語として描かせる。すでに言語の指定がある SVG はそのまま。
        if (!/<svg\b[^>]*\s(?:xml:)?lang=/i.test(svgContent)) {
            svgContent = svgContent.replace(/<svg\b/i, '<svg xml:lang="ja" lang="ja"');
        }

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

                    // 解像度を上げてカクカク感を解消(高精細化。既定は3倍)。
                    // ただし、ブラウザが作れるキャンバスの大きさを超えると空の画像になるため、大きな図は倍率を下げる。
                    const drawScale = getSafeCanvasScale(width, height, scale);
                    canvas.width = Math.max(1, Math.round(width * drawScale));
                    canvas.height = Math.max(1, Math.round(height * drawScale));

                    const ctx = canvas.getContext("2d");
                    if (ctx) {
                        ctx.fillStyle = "#ffffff";
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                        ctx.scale(drawScale, drawScale);
                        ctx.drawImage(img, 0, 0, width, height);
                        const pngDataUrl = canvas.toDataURL("image/png");
                        // キャンバスを作れなかったときは "data:," になる（画像として使えない）
                        if (/^data:image\/png;base64,./.test(pngDataUrl)) {
                            resolve({ pngDataUrl, width, height });
                            return;
                        }
                        console.error("Canvas could not be exported for SVG:", width, height, drawScale);
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

        // 図を開いていなければ、待っても保存されない
        if (saveTasks.length === 0) return;
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

    // 索引に載っていないキャッシュ（画像一覧の `<hash>_<更新日時>_preview.png` など）を探す。
    // 図の今の版（更新日時が同じ）のものだけを使う。古い版の画像を使うと、編集前の図が出力されるため。
    const hashHex = getStringHashForExcalidrawCache(file.path);
    const mtime = Number(file.stat?.mtime || 0);
    try {
        const listed = await app.vault.adapter.list(".excalidraw-cache");
        const files = (listed?.files || [])
            .filter((cacheFile) => {
                const name = normalizeVaultPath(cacheFile).split("/").pop() || "";
                const match = name.match(/^([^_]+)_(\d+)(?:_preview)?\.(png|svg)$/);
                return !!match && match[1] === hashHex && Number(match[2]) === mtime;
            })
            // PNG をそのまま使える方を先にする
            .sort((a, b) => Number(b.toLowerCase().endsWith(".png")) - Number(a.toLowerCase().endsWith(".png")));
        return files[0] || null;
    } catch (e) {
        return null;
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

        // 画像一覧（obsidian-excalidraw-cards）と同じく、フォントを埋め込んだ SVG を描かせてから PNG にする。
        // createPNG（Obsidian の画面のフォントでキャンバスへ直接描く）は、会社の Windows で
        // 日本語が化けた。画像一覧の SVG を経由する方法は、同じ端末でも正しく描けている。
        if (typeof ea.createSVG === "function") {
            try {
                if (typeof ea.reset === "function") ea.reset();
                const svgElement = await ea.createSVG(targetFile.path, true, exportSettings, loader, "light", 10);
                const svgContent = svgElement?.outerHTML || "";
                const rasterized = svgContent ? await rasterizeSvgContentToPngDataUrl(svgContent, scale) : null;
                if (rasterized?.pngDataUrl) {
                    const imageData = { src: rasterized.pngDataUrl, width: null, height: null };
                    window._htmlExportExcalidrawRenderCache.set(renderCacheKey, imageData);
                    return imageData;
                }
                exportAttempts.push(`createSVG: ${svgContent ? "PNG化に失敗" : "SVGが空"}`);
            } catch (svgError) {
                exportAttempts.push(`createSVG: ${svgError?.message || svgError}`);
            }
        }

        // SVG を作れなかったときだけ、Excalidraw に PNG を直接描かせる
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
                    // この方法は会社の Windows で日本語が化けたため、使ったことを知らせて確かめてもらう
                    console.warn("Excalidraw の図を予備の方法（createPNG）で描きました:", targetFile.path, exportAttempts.join(" | "));
                    if (typeof Notice === "function") {
                        new Notice(`図「${targetFile.basename || targetFile.name}」は予備の方法で描きました。文字が化けていないか確かめてください。`, 10000);
                    }
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
        const cachePath = (await findExcalidrawCachePath(targetFile)) || getExcalidrawCachePath(targetFile);
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
    // 図を1枚出力できなくても出力全体は止めず、その位置に案内を残す
    const replaceWithUnavailableNotice = (matchIndex, length, name) => {
        replaced += `${content.slice(lastIndex, matchIndex)}\n\n*（図を出力できませんでした: ${name}）*\n\n`;
        lastIndex = matchIndex + length;
        new Notice(`図を出力できませんでした: ${name}`);
    };
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
            if (isExcalidrawPath(linkpath)) replaceWithUnavailableNotice(matchIndex, fullMatch.length, linkpath);
            continue;
        }

        let imageData = null;
        try {
            imageData = await getExcalidrawPreviewImageData(targetFile);
        } catch (error) {
            console.warn("Failed to render Excalidraw for export:", targetFile.path, error);
        }
        if (!imageData?.src) {
            replaceWithUnavailableNotice(matchIndex, fullMatch.length, targetFile.basename || targetFile.name);
            continue;
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

// ```step / ```cad コードブロックの位置と中身を返す。
// 別のコードブロックの中に書かれた見本（```` で囲んだ仕様の例など）は対象にしない。
const findCadCodeBlocks = (content) => {
    const blocks = [];
    let offset = 0;
    let open = null;
    for (const line of String(content || "").split(/(?<=\n)/)) {
        const text = line.replace(/\r?\n$/, "");
        const fence = text.match(/^(\s*)(`{3,}|~{3,})\s*(.*)$/);
        if (!open) {
            if (fence) {
                open = { start: offset, indent: fence[1].length, marker: fence[2], language: fence[3].trim().split(/\s+/)[0], lines: [] };
            }
        } else if (fence && !fence[3].trim() && fence[2][0] === open.marker[0] && fence[2].length >= open.marker.length) {
            if (["step", "cad"].includes(open.language.toLowerCase())) {
                blocks.push({ start: open.start, end: offset + text.length, source: open.lines.join("\n") });
            }
            open = null;
        } else {
            open.lines.push(text.slice(Math.min(open.indent, text.length - text.trimStart().length)));
        }
        offset += line.length;
    }
    return blocks;
};

// CAD Viewer のコードブロックの埋め込みの名前（トップレベルの name:。引用符は外す）
const readCadEmbedName = (source) => {
    const value = source.match(/^name[ \t]*:[ \t]*(.*?)[ \t]*$/m)?.[1] || "";
    const quoted = value.match(/^(["'])(.*)\1$/);
    return (quoted ? quoted[2] : value).trim();
};

// WebGL の 3D 表示は HTML へ持ち出せないため、CAD Viewer に画像を作らせて差し込む
const replaceCadCodeBlocksForHtmlExport = async (content, sourceFile) => {
    const blocks = findCadCodeBlocks(content);
    if (blocks.length === 0) return content;

    const cadViewer = app.plugins?.plugins?.["dagnetz-cad-viewer"];
    let replaced = "";
    let lastIndex = 0;
    for (const block of blocks) {
        // 埋め込みの名前（name。ノートでは埋め込みの下に表示している）は、画像の下のキャプションにする
        const embedName = readCadEmbedName(block.source);
        const name = embedName || block.source.match(/^\s*path:\s*(.+?)\s*$/m)?.[1] || "CAD";
        let html = null;
        try {
            const image = await cadViewer.renderEmbedImage(block.source, sourceFile?.path || "");
            html = `<img src="${escapeHtmlAttribute(image.dataUrl)}" alt="${escapeHtmlAttribute(name)}" width="${image.width}" height="${image.height}" style="max-width: 100%; height: auto;">`;
        } catch (error) {
            console.warn("Failed to render CAD model for export:", name, error);
            new Notice(`3Dモデルを出力できませんでした: ${name}`);
        }
        replaced += content.slice(lastIndex, block.start);
        if (html && embedName) {
            replaced += `\n\n<figure class="cad-export-embed" style="display: inline-block; max-width: 100%;">${html}<figcaption>${escapeHtmlText(embedName)}</figcaption></figure>\n\n`;
        } else {
            replaced += html
                ? `\n\n<p class="cad-export-embed">${html}</p>\n\n`
                : `\n\n*（3Dモデルを出力できませんでした: ${name}）*\n\n`;
        }
        lastIndex = block.end;
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
        // 関数で渡す（文字列で渡すと、コードの $& などが置換の特殊文字になる）
        cleaned = cleaned.replace(`__HTML_EXPORT_PRE_BLOCK_${index}__`, () => block);
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
    padding: 0;
    background: var(--background-primary);
    color: var(--text-normal);
    font-family: "M PLUS 1", "Hiragino Sans", "Yu Gothic UI", "Yu Gothic", Meiryo, sans-serif;
    font-size: 17px;
    line-height: 1.72;
    overflow-wrap: anywhere;
    -webkit-font-smoothing: antialiased;
}
.markdown-preview-view, .markdown-rendered { overflow: visible; contain: none; }
/* 上の帯（題名と検索窓）・左の目次・本文 */
.html-export-header {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    gap: 16px;
    align-items: center;
    justify-content: space-between;
    height: 52px;
    padding: 0 clamp(16px, 3vw, 40px);
    border-bottom: 1px solid rgba(210, 185, 0, .48);
    background: rgba(255, 255, 255, .96);
}
.html-export-header-title {
    min-width: 0;
    overflow: hidden;
    color: #202020;
    font-weight: 700;
    white-space: nowrap;
    text-overflow: ellipsis;
}
.html-export-search { position: relative; flex: 0 1 340px; min-width: 180px; }
html:not(.html-export-js) .html-export-search { display: none; }
.html-export-search-input {
    width: 100%;
    padding: .38em .8em;
    border: 1px solid var(--background-modifier-border);
    border-radius: 6px;
    background: var(--background-secondary);
    color: var(--text-normal);
    font: inherit;
    font-size: .9em;
}
.html-export-search-input:focus { outline: 2px solid rgba(210, 185, 0, .6); outline-offset: 0; background: #fff; }
.html-export-search-results {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    width: min(560px, calc(100vw - 32px));
    max-height: min(70vh, 640px);
    overflow-y: auto;
    border: 1px solid var(--background-modifier-border);
    border-radius: 8px;
    background: #fff;
    box-shadow: 0 8px 28px rgba(0, 0, 0, .14);
    font-size: .88em;
    line-height: 1.5;
}
.html-export-search-results[hidden] { display: none; }
.html-export-search-count { padding: .5em .9em; color: var(--text-muted); border-bottom: 1px solid var(--background-modifier-border); }
.html-export-search-result { display: block; padding: .55em .9em; color: inherit; text-decoration: none; border-bottom: 1px solid #efefea; }
.html-export-search-result:hover, .html-export-search-result.is-active { background: #fffbd6; color: inherit; }
.html-export-search-result-title { font-weight: 700; color: #202020; }
.html-export-search-result-snippet { margin-top: .15em; color: #555; }
.html-export-search-results mark { padding: 0 .1em; background: #fff176; color: inherit; }
::highlight(html-export-search) { background-color: #fff176; color: inherit; }
.html-export-search-target { animation: html-export-search-flash 1.6s ease-out; }
@keyframes html-export-search-flash { from { background-color: #fff7b0; } to { background-color: transparent; } }
.html-export-layout { display: grid; grid-template-columns: 270px minmax(0, 1fr); align-items: start; }
.html-export-layout-no-toc { grid-template-columns: minmax(0, 1fr); }
.html-export-toc {
    position: sticky;
    top: 52px;
    max-height: calc(100vh - 52px);
    overflow-y: auto;
    padding: 24px 12px 40px 20px;
    border-right: 1px solid #ecebe4;
    font-size: .84em;
    line-height: 1.45;
}
.html-export-toc-title { margin: 0 0 .6em; color: var(--text-muted); font-weight: 700; letter-spacing: .04em; }
.html-export-toc-list { margin: 0; padding: 0; list-style: none; }
.html-export-toc-item { margin: 0; }
.html-export-toc-item a {
    display: block;
    padding: .28em .5em;
    border-left: 2px solid transparent;
    border-radius: 0 4px 4px 0;
    color: #4a4a4a;
    text-decoration: none;
}
.html-export-toc-item a:hover { background: #fffbd6; color: #202020; }
.html-export-toc-item a.is-active { border-left-color: #d2b900; background: #fffbd6; color: #302900; font-weight: 700; }
.html-export-toc-depth-1 > a { font-weight: 700; color: #303030; }
.html-export-toc-depth-2 > a { padding-left: 1.1em; }
.html-export-toc-depth-3 > a { padding-left: 2.1em; font-size: .95em; }
.html-export-main { min-width: 0; padding: 32px clamp(24px, 4vw, 80px) 64px; }
h1, h2, h3, h4, h5, h6 { scroll-margin-top: 68px; }
@media (max-width: 900px) {
    .html-export-layout { grid-template-columns: minmax(0, 1fr); }
    .html-export-toc { display: none; }
}
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
a.html-export-unlinked, a:not([href]) { color: inherit; text-decoration: none; }
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
/* 図の名前（ノートの画面で画像の下に出しているキャプション）は、図の幅に合わせて図の真ん中に置く */
[data-figure-name] { display: inline-flex; flex-direction: column; align-items: center; max-width: 100%; vertical-align: top; }
/* 名前が図より長くても図の幅を広げない（幅 0 で並べてから、図の幅いっぱいに伸ばす） */
.custom-figure-caption { display: block; width: 0; min-width: 100%; box-sizing: border-box; margin-top: .45em; color: var(--text-muted); font-size: .88em; line-height: 1.3; text-align: center; overflow-wrap: anywhere; }
.custom-image-resizer-handle { display: none; }
hr { margin: 2em 0; border: 0; border-top: 1px solid var(--background-modifier-border); }
mark { padding: .05em .18em; background: #fff59a; }
/* コールアウトは種類ごとに色を分ける（MkDocs Material と同じ配色。種類は Obsidian の data-callout と別名） */
.callout {
    --callout-rgb: 68, 138, 255;
    margin: 1.2em 0;
    padding: 0;
    overflow: hidden;
    border: 1px solid rgba(var(--callout-rgb), .4);
    border-left: 4px solid rgb(var(--callout-rgb));
    border-radius: 6px;
    background: rgba(var(--callout-rgb), .05);
}
.callout[data-callout="abstract"], .callout[data-callout="summary"], .callout[data-callout="tldr"] { --callout-rgb: 0, 176, 255; }
.callout[data-callout="info"], .callout[data-callout="todo"] { --callout-rgb: 0, 184, 212; }
.callout[data-callout="tip"], .callout[data-callout="hint"], .callout[data-callout="important"] { --callout-rgb: 0, 191, 165; }
.callout[data-callout="success"], .callout[data-callout="check"], .callout[data-callout="done"] { --callout-rgb: 0, 200, 83; }
.callout[data-callout="question"], .callout[data-callout="help"], .callout[data-callout="faq"] { --callout-rgb: 100, 221, 23; }
.callout[data-callout="warning"], .callout[data-callout="caution"], .callout[data-callout="attention"] { --callout-rgb: 255, 145, 0; }
.callout[data-callout="failure"], .callout[data-callout="fail"], .callout[data-callout="missing"] { --callout-rgb: 255, 82, 82; }
.callout[data-callout="danger"], .callout[data-callout="error"] { --callout-rgb: 255, 23, 68; }
.callout[data-callout="bug"] { --callout-rgb: 245, 0, 87; }
.callout[data-callout="example"] { --callout-rgb: 124, 77, 255; }
.callout[data-callout="quote"], .callout[data-callout="cite"] { --callout-rgb: 158, 158, 158; }
.callout-title {
    display: flex;
    gap: .45em;
    align-items: center;
    padding: .45em 1em;
    background: rgba(var(--callout-rgb), .13);
    color: #1f1f1f;
    font-weight: 700;
}
.callout-icon { display: flex; color: rgb(var(--callout-rgb)); }
.callout-icon svg { width: 1.1em; height: 1.1em; margin: 0; }
.callout-content { padding: .55em 1em .7em; }
.callout-content > :first-child { margin-top: 0; }
.callout-content > :last-child { margin-bottom: 0; }
.internal-embed, .markdown-embed { margin: 1em 0; }
.markdown-embed-title, .file-embed-title { color: var(--text-muted); font-size: .88em; }
.heading-collapse-indicator, .collapse-indicator, .copy-code-button, .markdown-embed-link, button { display: none !important; }
@media (max-width: 640px) {
    body { font-size: 16px; }
    .html-export-main { padding: 24px 20px 40px; }
    .html-export-header-title { display: none; }
    .html-export-search { flex: 1 1 auto; }
    table { display: block; overflow-x: auto; }
}
@page {
    size: A4;
    margin: 15mm;
}
@media print {
    body { max-width: none; padding: 0; font-size: 11pt; }
    /* PDF と印刷では、上の帯・目次・検索の色付けを出さない（今までと同じ見た目にする） */
    .html-export-header, .html-export-toc { display: none !important; }
    .html-export-layout { display: block; }
    .html-export-main { padding: 0; }
    ::highlight(html-export-search) { background-color: transparent; }
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
    // allowSeparateImages: 「画像を分けて保存」を出すか（HTMLとして保存するときだけ。PDF と印刷では出さない）
    constructor(app, callback, { allowSeparateImages = false } = {}) {
        super(app);
        this.callback = callback;
        this.numberHeadings = false;
        this.allowSeparateImages = allowSeparateImages;
        this.separateImages = false;
    }

    getResult() {
        return this.allowSeparateImages
            ? { numberHeadings: this.numberHeadings, separateImages: this.separateImages }
            : { numberHeadings: this.numberHeadings };
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

        if (this.allowSeparateImages) {
            new SummarySetting(contentEl)
                .setName("画像を分けて保存")
                .setDesc("画像をHTMLの中に入れず、HTMLと同じ場所の images フォルダへPNGなどのファイルとして保存し、HTMLからそのファイルを読み込みます。画像だけを差し替えたいときに使います（既定：オフ）")
                .addToggle((toggle) => toggle
                    .setValue(this.separateImages)
                    .onChange((value) => {
                        this.separateImages = value;
                    }));
        }

        new SummarySetting(contentEl)
            .addButton((btn) => btn
                .setButtonText("出力")
                .setCta()
                .onClick(() => {
                    const callback = this.callback;
                    this.callback = null;
                    this.close();
                    callback?.(this.getResult());
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

const askHtmlExportOptions = async ({ allowSeparateImages = false } = {}) => {
    if (SummaryModal && SummarySetting) {
        return new Promise((resolve) => {
            new HtmlExportOptionsModal(app, (result) => resolve(result), { allowSeparateImages }).open();
        });
    }

    // Modal APIが使えない環境では、従来どおり番号なしで出力する。
    return { numberHeadings: false };
};

// HTML のタグの中だけを書き換える。本文やコードの文字列（class="a" などの記述）には触れない
const replaceInsideHtmlTags = (html, replacer) => html.replace(/<[a-z][^<>]*>/gi, replacer);

const sanitizeHtmlExportForHuman = (html) => {
    if (!html) return html;
    const withoutScripts = String(html)
        .replace(/^\uFEFF/, "")
        .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
        .replace(/<!--[\s\S]*?-->/g, "");
    return replaceInsideHtmlTags(withoutScripts, (tag) => tag.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, ""))
        .replace(/\r\n?/g, "\n")
        .trim() + "\n";
};

const postProcessSavedHtmlExport = async (savePath) => {
    const fs = require("fs");
    let html = fs.readFileSync(savePath, "utf8");
    html = sanitizeHtmlExportForContextAndPandoc(html);

    html = html
        .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, "")
        .replace(/<\/?span\b[^>]*>/gi, "")
        .replace(/<div\b[^>]*>\s*<\/div>/gi, "")
        .replace(/<\/?div\b[^>]*>/gi, "");
    html = replaceInsideHtmlTags(html, (tag) => tag
        .replace(/\s(?:src|href)=["'][^"']*_assets\/[^"']+["']/gi, "")
        .replace(/\s(?:class|style|data-[\w:-]+|aria-[\w:-]+|referrerpolicy|loading|decoding|draggable|contenteditable|spellcheck)=(".*?"|'.*?')/gi, "")
        .replace(/\s(?:tabindex|role|translate|dir|rel|target)=(".*?"|'.*?')/gi, ""));
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

// WebP の Data URL を PNG にする。読めない画像はそのまま返す
const convertWebpDataUrlToPng = (dataUrl) => new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
        try {
            const canvas = document.createElement("canvas");
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            canvas.getContext("2d").drawImage(image, 0, 0);
            resolve(canvas.toDataURL("image/png"));
        } catch (error) {
            console.warn("Failed to convert WebP image for export:", error);
            resolve(dataUrl);
        }
    };
    image.onerror = () => resolve(dataUrl);
    image.src = dataUrl;
});

// AI用の出力は pandoc で Word へ変換することがあり、Word などは WebP を表示できない場合があるため PNG にする
const convertWebpImagesToPng = async (root) => {
    for (const img of Array.from(root.querySelectorAll('img[src^="data:image/webp"]'))) {
        img.setAttribute("src", await convertWebpDataUrlToPng(img.getAttribute("src")));
    }
};

/**
 * 対象のマークダウンファイルからエクスポート用HTML文字列を生成する
 * - Excalidraw埋め込みとCADコードブロックのPNG置換、画像Base64化、Pandoc/印刷向けスタイルの適用
 **/
// 見出しへのリンク（[[#見出し]]）と見出しの文字を同じ形にそろえて比べる。
// Obsidian はリンクを作るときに # | ^ : % [ ] \ を除くため、両方から除いて空白をまとめる。
const normalizeHeadingLinkText = (value) => String(value ?? "")
    .replace(/[#|^:%[\]\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const safeDecodeLinkTarget = (value) => {
    const text = String(value ?? "");
    try {
        return decodeURIComponent(text);
    } catch (e) {
        return text;
    }
};

// 出力した HTML を開く人の端末では開けないリンク（ファイル、Obsidian の中、ファイルマネージャー）
const isLocalOnlyLinkHref = (href) => {
    const text = String(href ?? "").trim();
    if (/^(?:file|app|obsidian|capacitor):/i.test(text)) return true;
    return /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/api\/open-path(?:[?#/]|$)/i.test(text);
};

const unlinkHtmlExportAnchor = (anchor) => {
    ["href", "data-href", "target", "rel", "aria-label", "data-tooltip-position"]
        .forEach((name) => anchor.removeAttribute(name));
    anchor.classList.add("html-export-unlinked");
};

// 人間用の出力のリンクを、出力した HTML の中で意味のある形にする。
// - 同じノートの見出しへのリンク: 見出しに id を付け、そこへ飛ぶリンクにする
// - 他のノート・ファイル・タグへのリンク、飛び先の見出しが無いリンク: リンクを外して文字だけ残す
// - URL（https:// など）と、ページ内の飛び先（脚注など）: そのまま
// 図の名前（ノートの画面で画像の下に出す .custom-figure-caption）は <div> だが、出力では段落 <p> の中の
// 図の箱（<span data-figure-name>）に入っている。ブラウザは <p> の中の <div> の手前で段落を閉じるため、
// そのままでは名前が図の箱の外へ出て、段落の幅で左に寄る。<span> にして図の箱の中に残す。
// リサイズのつまみ（.custom-image-resizer-handle）は出力では使わないので取り除く。
const normalizeHtmlExportFigureCaptions = (root, createElement = (tagName) => document.createElement(tagName)) => {
    for (const handle of Array.from(root.querySelectorAll(".custom-image-resizer-handle"))) handle.remove();
    for (const caption of Array.from(root.querySelectorAll(".custom-figure-caption"))) {
        if (String(caption.tagName).toUpperCase() === "SPAN") continue;
        const span = createElement("span");
        span.className = caption.className;
        span.textContent = caption.textContent;
        caption.replaceWith(span);
    }
};

const adjustHtmlExportLinks = (root, options = {}) => {
    if (!root || typeof root.querySelectorAll !== "function") return;
    const isSamePageLinkpath = typeof options.isSamePageLinkpath === "function"
        ? options.isSamePageLinkpath
        : (linkpath) => !String(linkpath ?? "").trim();

    const headingIds = new Map();
    let headingCount = 0;
    Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6")).forEach((heading) => {
        const key = normalizeHeadingLinkText(heading.getAttribute("data-heading") ?? heading.textContent);
        let id = heading.getAttribute("id");
        if (!id) {
            headingCount += 1;
            id = `html-export-heading-${headingCount}`;
            heading.setAttribute("id", id);
        }
        // 同じ名前の見出しが複数あるときは、Obsidian と同じく最初の見出しへ飛ぶ。
        if (key && !headingIds.has(key)) headingIds.set(key, id);
    });

    Array.from(root.querySelectorAll("a")).forEach((anchor) => {
        const dataHref = anchor.getAttribute("data-href");
        const href = anchor.getAttribute("href") || "";

        if (anchor.classList.contains("internal-link") || dataHref !== null) {
            const target = safeDecodeLinkTarget(dataHref ?? href);
            const hashIndex = target.indexOf("#");
            const linkpath = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
            const subpath = hashIndex >= 0 ? target.slice(hashIndex + 1) : "";
            if (subpath && isSamePageLinkpath(linkpath)) {
                // [[#親#子]] は最後の見出しを指す。ブロック（#^id）は飛び先を作れないため外す。
                const headingText = subpath.split("#").filter(Boolean).pop() || "";
                const id = headingText.startsWith("^")
                    ? null
                    : headingIds.get(normalizeHeadingLinkText(headingText));
                if (id) {
                    anchor.setAttribute("href", `#${id}`);
                    ["data-href", "target", "rel", "aria-label", "data-tooltip-position"]
                        .forEach((name) => anchor.removeAttribute(name));
                    return;
                }
            }
            unlinkHtmlExportAnchor(anchor);
            return;
        }

        if (anchor.classList.contains("tag") || isLocalOnlyLinkHref(href)) {
            unlinkHtmlExportAnchor(anchor);
        }
    });
};

// 人間用の出力の左側に置く目次。見出しの id（adjustHtmlExportLinks で付けたもの）へ飛ぶ。
// 埋め込んだ別のノートの見出しは入れない。最上位の見出しから3階層までを並べる。
const buildHtmlExportTocHtml = (root) => {
    if (!root || typeof root.querySelectorAll !== "function") return "";
    const items = Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"))
        .filter((heading) => heading.getAttribute("id")
            && !(typeof heading.closest === "function" && heading.closest(".markdown-embed, .internal-embed")))
        .map((heading) => ({
            level: Number(String(heading.tagName).slice(1)),
            id: heading.getAttribute("id"),
            text: String(heading.textContent ?? "").replace(/\s+/g, " ").trim(),
        }))
        .filter((item) => item.level >= 1 && item.text);
    if (items.length === 0) return "";
    const topLevel = Math.min(...items.map((item) => item.level));
    const listItems = items
        .map((item) => ({ ...item, depth: item.level - topLevel + 1 }))
        .filter((item) => item.depth <= 3)
        .map((item) => `<li class="html-export-toc-item html-export-toc-depth-${item.depth}"><a href="#${escapeHtmlAttribute(item.id)}">${escapeHtmlText(item.text)}</a></li>`)
        .join("\n");
    return `<nav class="html-export-toc" aria-label="目次">
<div class="html-export-toc-title">目次</div>
<ul class="html-export-toc-list">
${listItems}
</ul>
</nav>`;
};

// ---- ここから、出力した HTML の中で動く処理（検索と目次の強調） ----
// buildHtmlExportPageScript が関数のソースをそのまま <script> へ書き出すため、
// この区間の関数は外側の変数を使わず、互いの名前と標準の機能だけで書く。

// 検索のために文字をそろえる（全角と半角、大文字と小文字、ひらがなとカタカナ、続く空白は1つに）。
// 1文字ずつそろえ、そろえた後の各文字が元の文字列のどこから来たか（starts / ends）を記録する。
const htmlExportSearchNormalizeWithMap = (text) => {
    const source = String(text ?? "");
    let normalized = "";
    const starts = [];
    const ends = [];
    let index = 0;
    for (const char of source) {
        let folded = char.normalize("NFKC").toLowerCase()
            .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
        if (/^\s+$/.test(folded)) folded = normalized.endsWith(" ") ? "" : " ";
        for (let i = 0; i < folded.length; i += 1) {
            starts.push(index);
            ends.push(index + char.length);
        }
        normalized += folded;
        index += char.length;
    }
    return { normalized, starts, ends };
};

// 検索語を空白（全角の空白も）で分ける。同じ語は1つにする。
const htmlExportSearchSplitTerms = (query) => Array.from(new Set(
    htmlExportSearchNormalizeWithMap(query).normalized.split(" ").filter(Boolean)
));

// 文字列の中の検索語の位置を印付きの断片に分ける。radius を渡すと、最初に見つかった位置の前後だけを切り出す。
const htmlExportSearchMarkParts = (text, terms, radius) => {
    const source = String(text ?? "");
    const { normalized, starts, ends } = htmlExportSearchNormalizeWithMap(source);
    const ranges = [];
    (terms || []).forEach((term) => {
        if (!term) return;
        let from = 0;
        let at = normalized.indexOf(term, from);
        while (at !== -1) {
            ranges.push([at, at + term.length]);
            from = at + term.length;
            at = normalized.indexOf(term, from);
        }
    });
    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged = [];
    ranges.forEach((range) => {
        const last = merged[merged.length - 1];
        if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
        else merged.push([range[0], range[1]]);
    });

    let windowStart = 0;
    let windowEnd = normalized.length;
    if (typeof radius === "number" && normalized.length > radius * 2) {
        const center = merged.length ? merged[0][0] : 0;
        windowEnd = Math.min(normalized.length, Math.max(0, center - radius) + radius * 2);
        windowStart = Math.max(0, windowEnd - radius * 2);
    }

    const parts = [];
    const push = (from, to, match) => {
        if (to <= from) return;
        const piece = source.slice(starts[from], ends[to - 1]);
        if (piece) parts.push({ text: piece, match });
    };
    let cursor = windowStart;
    merged.forEach(([start, end]) => {
        if (end <= windowStart || start >= windowEnd) return;
        const clippedStart = Math.max(start, windowStart);
        const clippedEnd = Math.min(end, windowEnd);
        push(cursor, clippedStart, false);
        push(clippedStart, clippedEnd, true);
        cursor = clippedEnd;
    });
    push(cursor, windowEnd, false);
    return {
        parts,
        truncatedStart: windowStart > 0,
        truncatedEnd: windowEnd < normalized.length,
    };
};

// 章（{ id, title, text }）の一覧から、すべての検索語を含む章を探す。
// 見出しに検索語が多く入っている章を先に、同じなら本文の順に並べる。
const htmlExportSearchSections = (sections, query) => {
    const terms = htmlExportSearchSplitTerms(query);
    if (terms.length === 0) return [];
    const results = [];
    (sections || []).forEach((section, order) => {
        const title = String(section.title ?? "");
        const text = String(section.text ?? "");
        const normalizedTitle = htmlExportSearchNormalizeWithMap(title).normalized;
        const normalizedText = htmlExportSearchNormalizeWithMap(text).normalized;
        const found = terms.every((term) => normalizedTitle.includes(term) || normalizedText.includes(term));
        if (!found) return;
        const titleHits = terms.filter((term) => normalizedTitle.includes(term)).length;
        const bodyHasTerm = terms.some((term) => normalizedText.includes(term));
        results.push({
            id: section.id || "",
            title,
            titleParts: htmlExportSearchMarkParts(title, terms).parts,
            snippet: bodyHasTerm ? htmlExportSearchMarkParts(text, terms, 40) : null,
            titleHits,
            order,
        });
    });
    results.sort((a, b) => b.titleHits - a.titleHits || a.order - b.order);
    return results;
};

// 右上の検索窓を動かす。章は <main> の直下の section（applyHtmlHeadingSections が作る）。
const setupHtmlExportSearch = (doc, win) => {
    const input = doc.querySelector(".html-export-search-input");
    const panel = doc.querySelector(".html-export-search-results");
    const main = doc.querySelector(".html-export-main");
    if (!input || !panel || !main) return;
    doc.documentElement.classList.add("html-export-js");

    let sections = null;
    const collectSections = () => {
        const list = [];
        let leading = null;
        Array.from(main.children).forEach((node) => {
            if (node.classList.contains("html-export-section")) {
                const heading = node.querySelector("h1, h2, h3, h4, h5, h6");
                list.push({
                    id: heading ? heading.id : "",
                    title: heading ? heading.textContent.replace(/\s+/g, " ").trim() : doc.title,
                    text: Array.from(node.childNodes).filter((child) => child !== heading)
                        .map((child) => child.textContent).join(" "),
                });
                return;
            }
            // 最初の見出しより前の本文は「冒頭」としてまとめる。
            if (!leading) {
                leading = { id: "", title: `${doc.title}（冒頭）`, text: "" };
                list.push(leading);
            }
            leading.text += ` ${node.textContent}`;
        });
        return list;
    };

    const highlightName = "html-export-search";
    const canHighlight = typeof win.CSS !== "undefined" && win.CSS.highlights && typeof win.Highlight === "function";
    const clearHighlight = () => {
        if (canHighlight) win.CSS.highlights.delete(highlightName);
    };
    // 本文の中の一致した箇所を、DOM を変えずに色付けする（CSS Custom Highlight API）。
    const highlightTerms = (terms) => {
        if (!canHighlight) return;
        clearHighlight();
        if (terms.length === 0) return;
        const ranges = [];
        const walker = doc.createTreeWalker(main, win.NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node && ranges.length < 3000; node = walker.nextNode()) {
            const { normalized, starts, ends } = htmlExportSearchNormalizeWithMap(node.nodeValue);
            terms.forEach((term) => {
                let at = normalized.indexOf(term);
                while (at !== -1 && ranges.length < 3000) {
                    const range = doc.createRange();
                    range.setStart(node, starts[at]);
                    range.setEnd(node, ends[at + term.length - 1]);
                    ranges.push(range);
                    at = normalized.indexOf(term, at + term.length);
                }
            });
        }
        if (ranges.length) win.CSS.highlights.set(highlightName, new win.Highlight(...ranges));
    };

    const appendParts = (parent, parts) => {
        parts.forEach((part) => {
            if (part.match) {
                const mark = doc.createElement("mark");
                mark.textContent = part.text;
                parent.appendChild(mark);
            } else {
                parent.appendChild(doc.createTextNode(part.text));
            }
        });
    };

    let results = [];
    let activeIndex = -1;
    const resultLinks = () => Array.from(panel.querySelectorAll(".html-export-search-result"));
    const setActive = (index) => {
        const links = resultLinks();
        if (links.length === 0) return;
        activeIndex = (index + links.length) % links.length;
        links.forEach((link, i) => link.classList.toggle("is-active", i === activeIndex));
        links[activeIndex].scrollIntoView({ block: "nearest" });
    };
    const closePanel = () => { panel.hidden = true; };

    const jumpTo = (result) => {
        if (!result) return;
        const target = result.id ? doc.getElementById(result.id) : main;
        if (!target) return;
        closePanel();
        target.scrollIntoView({ block: "start" });
        if (result.id) win.history.replaceState(null, "", `#${result.id}`);
        const section = target.closest(".html-export-section") || target;
        section.classList.remove("html-export-search-target");
        void section.offsetWidth;
        section.classList.add("html-export-search-target");
        win.setTimeout(() => section.classList.remove("html-export-search-target"), 1600);
    };

    const render = () => {
        const query = input.value;
        panel.textContent = "";
        activeIndex = -1;
        const terms = htmlExportSearchSplitTerms(query);
        if (terms.length === 0) {
            results = [];
            closePanel();
            clearHighlight();
            return;
        }
        if (!sections) sections = collectSections();
        results = htmlExportSearchSections(sections, query);
        const limit = 50;
        const count = doc.createElement("div");
        count.className = "html-export-search-count";
        count.textContent = results.length === 0
            ? "見つかりませんでした"
            : `${results.length}件${results.length > limit ? `（先頭の${limit}件を表示）` : ""}`;
        panel.appendChild(count);
        results.slice(0, limit).forEach((result) => {
            const link = doc.createElement("a");
            link.className = "html-export-search-result";
            link.href = result.id ? `#${result.id}` : "#";
            const title = doc.createElement("div");
            title.className = "html-export-search-result-title";
            appendParts(title, result.titleParts);
            link.appendChild(title);
            if (result.snippet) {
                const snippet = doc.createElement("div");
                snippet.className = "html-export-search-result-snippet";
                if (result.snippet.truncatedStart) snippet.appendChild(doc.createTextNode("…"));
                appendParts(snippet, result.snippet.parts);
                if (result.snippet.truncatedEnd) snippet.appendChild(doc.createTextNode("…"));
                link.appendChild(snippet);
            }
            link.addEventListener("click", (event) => {
                event.preventDefault();
                jumpTo(result);
            });
            panel.appendChild(link);
        });
        panel.hidden = false;
        highlightTerms(terms);
    };

    input.addEventListener("input", render);
    input.addEventListener("focus", () => {
        if (results.length || input.value.trim()) panel.hidden = false;
    });
    input.addEventListener("keydown", (event) => {
        if (event.isComposing) return;
        if (event.key === "ArrowDown") {
            event.preventDefault();
            panel.hidden = false;
            setActive(activeIndex + 1);
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            panel.hidden = false;
            setActive(activeIndex - 1);
        } else if (event.key === "Enter") {
            event.preventDefault();
            jumpTo(results[Math.max(activeIndex, 0)]);
        } else if (event.key === "Escape") {
            event.preventDefault();
            if (!panel.hidden) closePanel();
            else {
                input.value = "";
                render();
                input.blur();
            }
        }
    });
    doc.addEventListener("keydown", (event) => {
        const typing = event.target && (/^(input|textarea|select)$/i.test(event.target.tagName) || event.target.isContentEditable);
        const isSlash = event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey;
        const isFindKey = (event.ctrlKey || event.metaKey) && !event.altKey && String(event.key).toLowerCase() === "k";
        if ((isSlash && !typing) || isFindKey) {
            event.preventDefault();
            input.focus();
            input.select();
        }
    });
    doc.addEventListener("click", (event) => {
        if (!event.target.closest(".html-export-search")) closePanel();
    });
};

// 左の目次で、いま読んでいる章を強調する。
const setupHtmlExportTocHighlight = (doc, win) => {
    const nav = doc.querySelector(".html-export-toc");
    if (!nav) return;
    const entries = Array.from(nav.querySelectorAll("a[href^='#']"))
        .map((link) => ({ link, target: doc.getElementById(decodeURIComponent(link.getAttribute("href").slice(1))) }))
        .filter((entry) => entry.target);
    if (entries.length === 0) return;
    let active = null;
    let scheduled = false;
    const update = () => {
        scheduled = false;
        const header = doc.querySelector(".html-export-header");
        const offset = (header ? header.offsetHeight : 0) + 24;
        let current = entries[0];
        for (const entry of entries) {
            if (entry.target.getBoundingClientRect().top - offset <= 0) current = entry;
            else break;
        }
        if (current === active) return;
        if (active) active.link.classList.remove("is-active");
        current.link.classList.add("is-active");
        active = current;
        // 強調した項目が目次の表示範囲から外れたら、目次だけをスクロールする。
        const linkRect = current.link.getBoundingClientRect();
        const navRect = nav.getBoundingClientRect();
        if (linkRect.top < navRect.top || linkRect.bottom > navRect.bottom) {
            nav.scrollTop += linkRect.top - navRect.top - navRect.height / 2;
        }
    };
    win.addEventListener("scroll", () => {
        if (scheduled) return;
        scheduled = true;
        win.requestAnimationFrame(update);
    }, { passive: true });
    update();
};

// ---- 出力した HTML の中で動く処理はここまで ----

const buildHtmlExportPageScript = () => {
    const functions = {
        htmlExportSearchNormalizeWithMap,
        htmlExportSearchSplitTerms,
        htmlExportSearchMarkParts,
        htmlExportSearchSections,
        setupHtmlExportSearch,
        setupHtmlExportTocHighlight,
    };
    const declarations = Object.entries(functions)
        .map(([name, fn]) => `const ${name} = ${fn.toString()};`)
        .join("\n");
    return `(function () {
"use strict";
${declarations}
const start = () => {
    setupHtmlExportSearch(document, window);
    setupHtmlExportTocHighlight(document, window);
};
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
})();`;
};

// 人間用の本文を、上の帯（題名と検索窓）・左の目次・本文の3つに分けて並べる。
const buildHumanHtmlExportBody = (title, contentHtml, tocHtml) => `<header class="html-export-header">
<div class="html-export-header-title">${escapeHtmlText(title)}</div>
<div class="html-export-search" role="search">
<input class="html-export-search-input" type="search" placeholder="検索（/ キー）" aria-label="このページを検索" autocomplete="off" spellcheck="false">
<div class="html-export-search-results" hidden></div>
</div>
</header>
<div class="html-export-layout${tocHtml ? "" : " html-export-layout-no-toc"}">
${tocHtml || ""}
<main class="html-export-main">
${contentHtml}
</main>
</div>`;

// サニタイズ（ノートに書かれた <script> を取り除く）の後に、出力の仕組みが用意した処理だけを入れる。
const appendHtmlExportPageScript = (html) => {
    const script = `<script>\n${buildHtmlExportPageScript()}\n</script>\n`;
    const text = String(html ?? "");
    const closingIndex = text.toLowerCase().lastIndexOf("</body>");
    if (closingIndex === -1) return `${text}${script}`;
    return `${text.slice(0, closingIndex)}${script}${text.slice(closingIndex)}`;
};

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
        const renderedMarkdown = await replaceCadCodeBlocksForHtmlExport(
            await replaceExcalidrawEmbedsForHtmlExport(exportMarkdown, file),
            file
        );
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
        if (!isHumanExport) await convertWebpImagesToPng(tempDiv);

        // 現在のbodyのクラス名を取得して引き継ぐ (テーマ、フォント、モードの反映のため)
        let bodyClass = toLightThemeBodyClass(document.body ? document.body.className : "");
        if (isHumanExport) {
            // 図の名前は普段、DOM の変更を見張る処理（03_figure_embeds.js）が少し遅れて付ける。
            // その処理は変更が続くあいだ先送りされるため、待たずにここで付ける（名前の無いまま書き出さない）。
            // ここから書き出しまでは await が無く、見張る処理が割り込んで作り直すことはない。
            if (typeof applyFigureEmbedDisplayNames === "function") applyFigureEmbedDisplayNames(tempDiv);
            normalizeHtmlExportFigureCaptions(tempDiv);
            // 見出し番号を足す前に行う（番号を足すと見出しの文字がリンクと合わなくなるため）。
            adjustHtmlExportLinks(tempDiv, {
                isSamePageLinkpath: (linkpath) => {
                    const path = String(linkpath ?? "").trim();
                    if (!path) return true;
                    const dest = app.metadataCache?.getFirstLinkpathDest?.(path, file.path);
                    return dest?.path === file.path;
                },
            });
        }
        if (isHumanExport && humanExportOptions.numberHeadings) {
            bodyClass += " html-export-numbered";
            applyHtmlHeadingNumbers(tempDiv);
        }
        let tocHtml = "";
        if (isHumanExport) {
            applyHtmlHeadingSections(tempDiv);
            tocHtml = buildHtmlExportTocHtml(tempDiv);
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
        const htmlBody = isHumanExport
            ? buildHumanHtmlExportBody(title, tempDiv.innerHTML, tocHtml)
            : `${tempDiv.innerHTML}${rawMarkdownSection}`;
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
            ? appendHtmlExportPageScript(sanitizeHtmlExportForHuman(htmlDocument))
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
    const localAppData = (typeof process !== "undefined" && process.env?.LOCALAPPDATA) || "";
    // ヘッドレスのブラウザが応答しないときに打ち切るまでの時間
    const browserTimeoutMs = 120000;

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
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ...(localAppData ? [path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe")] : []),
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
        // 一時ファイルへ出力する。保存先へ直接出力すると、ブラウザが何も出力しなくても前回の PDF を成功と誤認する
        const tempPdfPath = `${tempHtmlPath}.pdf`;
        // 同じプロファイルを同時に使うと、既存のプロセスへ処理が渡って PDF が出力されない（起動中のブラウザ、同時の出力）。
        // 出力ごとに専用のプロファイルを使い、終わったら消す
        const userDataDir = path.join(req("os").tmpdir(), `obsidian-html-pdf-export-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        try {
            await new Promise((resolve, reject) => {
                execFile(foundChrome, [
                    "--headless",
                    "--disable-gpu",
                    "--no-pdf-header-footer",
                    `--user-data-dir=${userDataDir}`,
                    `--print-to-pdf=${tempPdfPath}`,
                    tempHtmlPath
                ], { timeout: browserTimeoutMs }, (error) => {
                    try { if (fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath); } catch (e) {}
                    if (error) {
                        reject(error);
                    } else {
                        resolve(true);
                    }
                });
            });

            // 生成されたPDFが白紙（空）でないか検証 (1000 bytes以上)
            if (fs.existsSync(tempPdfPath)) {
                const stat = fs.statSync(tempPdfPath);
                if (stat.size > 1000) {
                    fs.renameSync(tempPdfPath, savePath);
                    return true;
                }
                console.warn(`Generated PDF via Chrome is too small (${stat.size} bytes), trying fallback...`);
            }
        } catch (chromeErr) {
            console.warn("Chrome headless PDF export failed, trying Electron fallback:", chromeErr);
            try { if (fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath); } catch (e) {}
        } finally {
            try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 }); } catch (e) {}
        }
        try { if (fs.existsSync(tempPdfPath)) fs.unlinkSync(tempPdfPath); } catch (e) {}
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

// 「画像を分けて保存」で画像を書き出すフォルダ（HTML と同じ場所）
const HTML_EXPORT_IMAGE_DIR = "images";

const HTML_EXPORT_IMAGE_EXTENSIONS = {
    png: "png", jpeg: "jpg", jpg: "jpg", gif: "gif", webp: "webp", bmp: "bmp", "svg+xml": "svg", avif: "avif",
};

const decodeHtmlAttributeValue = (value) => String(value ?? "")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/**
 * 「画像を分けて保存」: HTML に埋め込んだ画像（<img src="data:image/...;base64,...">）を取り出し、
 * src を images フォルダのファイル（images/<名前>.png など）に書き換える。
 * - 名前は、Excalidraw の図なら図の名前（data-excalidraw-source）、ほかは alt（画像のファイル名）から付ける。
 *   名前の無い画像は image_01 など。同じ名前が続いたら _2, _3 … を付ける。
 * - 中身が同じ画像（同じ画像を何度も埋め込んだもの）は、1つのファイルにまとめる（差し替えが1か所で済む）。
 * - ファイル名に使えない文字は _ にする。拡張子は画像の種類から決める（元の拡張子は外す）。
 * - 戻り値: { html, images: [{ fileName, base64, mimeType }] }（ファイルへは書かない）
 **/
const splitHtmlExportImages = (html) => {
    const images = [];
    const usedNames = new Set();
    const fileNameByData = new Map();
    let unnamedCount = 0;
    const readAttr = (tag, name) => {
        const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
        return match ? decodeHtmlAttributeValue(match[1] ?? match[2]) : "";
    };
    const output = String(html ?? "").replace(/<img\b[^>]*>/gi, (tag) => {
        const srcMatch = tag.match(/(\ssrc\s*=\s*)(["'])data:image\/([a-z0-9.+-]+);base64,([^"']+)\2/i);
        if (!srcMatch) return tag;
        const mimeSubtype = srcMatch[3].toLowerCase();
        const relativeSrcOf = (name) => `${HTML_EXPORT_IMAGE_DIR}/${encodeURIComponent(name)}`;
        const dataKey = `${mimeSubtype};${srcMatch[4]}`;
        if (fileNameByData.has(dataKey)) {
            return tag.replace(srcMatch[0], `${srcMatch[1]}"${relativeSrcOf(fileNameByData.get(dataKey))}"`);
        }
        const extension = HTML_EXPORT_IMAGE_EXTENSIONS[mimeSubtype] || "png";

        const excalidrawSource = readAttr(tag, "data-excalidraw-source");
        let baseName = excalidrawSource
            ? excalidrawSource.split("/").pop().replace(/\.md$/i, "").replace(/\.excalidraw$/i, "")
            : readAttr(tag, "alt").split("/").pop().replace(/\.(?:png|jpe?g|gif|webp|bmp|svg|avif|tiff?)$/i, "");
        baseName = baseName.replace(/[\\/:*?"<>|#%\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 100);
        if (!baseName || /^_+$/.test(baseName)) {
            unnamedCount += 1;
            baseName = `image_${String(unnamedCount).padStart(2, "0")}`;
        }
        let fileName = `${baseName}.${extension}`;
        for (let n = 2; usedNames.has(fileName.toLowerCase()); n++) fileName = `${baseName}_${n}.${extension}`;
        usedNames.add(fileName.toLowerCase());
        fileNameByData.set(dataKey, fileName);

        images.push({ fileName, base64: srcMatch[4], mimeType: `image/${mimeSubtype}` });
        return tag.replace(srcMatch[0], `${srcMatch[1]}"${relativeSrcOf(fileName)}"`);
    });
    return { html: output, images };
};

/**
 * 対象のマークダウンファイルをHTMLとして出力する
 * - 一時的な要素にレンダリング後、Pandoc向けにHTMLを変換
 * - 通常は保存ダイアログを表示してファイルを保存
 * - 人間用は、保存ダイアログで保存したら既定のブラウザで開く
 * - exportOptions.savePath が指定された場合は、指定先へ自動保存（ブラウザでは開かない）
 * - 人間用で exportOptions.skipPromptSelection が true の場合は、設定モーダルを出さず、見出し番号なしで出力
 * - 人間用で「画像を分けて保存」（separateImages）をオンにすると、画像を HTML の隣の images フォルダへ書き出す
 *   （コマンド custom:export-html-human から、API など無人の実行をするため）
 **/
const exportHtml = async (file, exportTarget = "ai", exportOptions = {}) => {
    if (!file) return;

    const isHumanExport = exportTarget === "human";
    let selectedPrompts = Array.isArray(exportOptions?.selectedPrompts)
        ? exportOptions.selectedPrompts
        : null;
    let humanExportOptions = { numberHeadings: false };
    if (isHumanExport) {
        humanExportOptions = exportOptions?.skipPromptSelection
            ? { numberHeadings: false }
            : await askHtmlExportOptions({ allowSeparateImages: true });
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
            const separateImages = isHumanExport
                && (humanExportOptions?.separateImages === true || exportOptions?.separateImages === true);
            if (separateImages) {
                // 画像を HTML の隣の images フォルダへファイルとして書き出し、HTML からはそのファイルを読む
                const { html, images } = splitHtmlExportImages(fullHtml);
                const imageDir = path.join(path.dirname(savePath), HTML_EXPORT_IMAGE_DIR);
                if (images.length > 0) fs.mkdirSync(imageDir, { recursive: true });
                for (const image of images) {
                    fs.writeFileSync(path.join(imageDir, image.fileName), Buffer.from(image.base64, "base64"));
                }
                fs.writeFileSync(savePath, html, "utf8");
                new NoticeClass(`画像 ${images.length} 枚を ${imageDir} に保存しました`);
            } else {
                fs.writeFileSync(savePath, fullHtml, "utf8");
            }
            if (!isHumanExport) {
                await postProcessSavedHtmlExport(savePath);
            }
            if (automaticSavePath) {
                new NoticeClass((isHumanExport ? "人間用HTML" : "サマリーHTML") + "を保存しました: " + savePath);
            } else {
                const copied = await copyTextToClipboard(savePath);
                if (copied) {
                    new NoticeClass((isHumanExport ? "人間用HTML" : "AIコンテキスト用HTML") + "を保存しました。フルパスをクリップボードにコピーしました: " + savePath);
                } else {
                    new NoticeClass((isHumanExport ? "人間用HTML" : "AIコンテキスト用HTML") + "を保存しました。クリップボードへのコピーに失敗しました: " + savePath);
                }
            }
            // 人がメニューから出力した人間用HTMLは、保存したらそのまま既定のブラウザで開く。
            // 保存先を指定した無人の実行（custom:export-html-human など）では開かない。
            if (isHumanExport && !automaticSavePath) {
                const opened = await openHtmlFileInDefaultBrowser(savePath);
                if (!opened) new NoticeClass("HTMLをブラウザで開けませんでした: " + savePath);
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
 * 保存済みのHTMLファイルを、既定のブラウザで開く
 * - Electron の shell.openExternal（file URL）→ shell.openPath → OSのコマンドの順に試す
 * - 開けたら true、どれも失敗したら false
 **/
const openHtmlFileInDefaultBrowser = async (htmlPath) => {
    if (!htmlPath) return false;

    let electron;
    try { electron = require("electron"); } catch (e) {
        try { electron = window.require ? window.require("electron") : null; } catch (err) {}
    }

    if (electron?.shell?.openExternal) {
        try {
            const { pathToFileURL } = require("url");
            await electron.shell.openExternal(pathToFileURL(htmlPath).href);
            return true;
        } catch (e) {
            console.warn("shell.openExternal failed. Falling back to shell.openPath.", e);
        }
    }
    if (electron?.shell?.openPath) {
        const err = await electron.shell.openPath(htmlPath);
        if (!err) return true;
    }

    try {
        const { execFile } = require("child_process");
        const platform = typeof process !== "undefined" ? process.platform : "";
        if (platform === "darwin") {
            execFile("open", [htmlPath]);
            return true;
        }
        if (platform === "win32") {
            execFile("cmd", ["/c", "start", "", htmlPath]);
            return true;
        }
        if (platform === "linux") {
            execFile("xdg-open", [htmlPath]);
            return true;
        }
    } catch (e) {}
    return false;
};

/**
 * 対象のマークダウンファイルを人間用HTMLにして temp フォルダへ保存し、既定のブラウザで開く
 * - 印刷はブラウザの印刷画面（Cmd/Ctrl+P）からユーザーが行う
 * - 保存ダイアログは出さず、temp/[タイトル].html へ上書き保存する
 **/
const printHtml = async (file, exportOptions = {}) => {
    if (!file) return null;

    let humanExportOptions = { numberHeadings: false };
    if (!exportOptions?.skipPromptSelection) {
        humanExportOptions = await askHtmlExportOptions();
        if (!humanExportOptions) return null;
    }

    const obsidianLib = getObsidianModule();
    const NoticeClass = obsidianLib?.Notice || (typeof window !== "undefined" && window.Notice) || (typeof global !== "undefined" && global.Notice) || class {};

    new NoticeClass("印刷用HTMLを生成中...");

    try {
        const fullHtml = await generateExportHtml(file, "human", { ...humanExportOptions, ...exportOptions });
        if (!fullHtml) {
            throw new Error("HTMLの生成に失敗しました。");
        }

        const path = require("path");
        const fs = require("fs");
        const tempDirPath = exportOptions?.tempDirPath || ensureTempDirExists();
        if (!tempDirPath) {
            throw new Error("temp フォルダを作成できませんでした。");
        }
        const savePath = path.join(tempDirPath, file.basename + ".html");
        fs.mkdirSync(path.dirname(savePath), { recursive: true });
        fs.writeFileSync(savePath, fullHtml, "utf8");

        const opened = await openHtmlFileInDefaultBrowser(savePath);
        if (opened) {
            new NoticeClass("ブラウザで開きました。印刷はブラウザの印刷画面（Cmd/Ctrl+P）から行ってください。");
        } else {
            new NoticeClass("HTMLを保存しましたが、ブラウザを開けませんでした: " + savePath);
        }
        return savePath;
    } catch (error) {
        new NoticeClass("印刷用HTMLの出力に失敗しました: " + error.message);
        console.error("Print HTML error:", error);
        return null;
    }
};
