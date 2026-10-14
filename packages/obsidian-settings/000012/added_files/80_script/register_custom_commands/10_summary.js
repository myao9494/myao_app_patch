// =============================================================================
// サマリー作成（ノート・メール・画像の収集と統合）
// =============================================================================

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
            } else if ((linkedFile.extension.toLowerCase() === "msg" || linkedFile.extension.toLowerCase() === "dat" || linkedFile.name.toLowerCase() === "winmail.dat") && collectedMsgFiles) {
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
        } else if (linkedFile && (linkedFile.extension.toLowerCase() === "msg" || linkedFile.extension.toLowerCase() === "dat" || linkedFile.name.toLowerCase() === "winmail.dat") && collectedMsgFiles) {
            collectedMsgFiles.add(linkedFile);
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

    const plainBody = String(parsed.Body || "").trim() || (parsed.RtfBody ? extractPlainTextFromRtf(parsed.RtfBody) : "");

    const hasTable = /<table\b/i.test(html);

    // 画像がなく、かつプレーンテキスト本文が存在し、HTML内に表も含まれない場合は、タグ混入のないクリーンな Body を最優先
    if (renderableImages.length === 0 && !hasTable && plainBody) {
        return { body: plainBody, unplaced: [] };
    }

    if (!html) return { body: plainBody, unplaced: renderableImages };

    let sanitized = sanitizeOutlookHtml(html);
    sanitized = convertHtmlTablesToMarkdown(sanitized);

    // Markdownテーブル（| ... | で始まるブロック）を検出して保護
    const tablePlaceholders = [];
    sanitized = sanitized.replace(/(?:^|\n)(\|[^\n]+\|\r?\n\|[ \t]*[-:]+[-| :]*\|\r?\n(?:\|[^\n]+\|(?:\r?\n|$))+)/g, (_m, tableBlock) => {
        const id = `__MD_TABLE_HOLDER_${tablePlaceholders.length}__`;
        tablePlaceholders.push(`\n\n${tableBlock.trim()}\n\n`);
        return `\n\n${id}\n\n`;
    });

    let markdown = sanitized
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
        .replace(/<\/(p|div|section|article|header|footer|h[1-6])\s*>/gi, "\n\n")
        .replace(/<\/(li)\s*>/gi, "\n")
        .replace(/<li\b[^>]*>/gi, "- ")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
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

    // テーブルプレースホルダーを復元
    for (let i = 0; i < tablePlaceholders.length; i++) {
        markdown = markdown.replace(`__MD_TABLE_HOLDER_${i}__`, tablePlaceholders[i]);
    }

    if (!markdown) markdown = plainBody;
    return { body: markdown.replace(/\n{3,}/g, "\n\n").trim(), unplaced: renderableImages.filter(image => !used.has(image.path)) };
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
                let renderedBody = parsed.Body || (parsed.RtfBody ? extractPlainTextFromRtf(parsed.RtfBody) : "");
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
