<%*
/**
 * クリップボードの内容を用途に応じてMarkdownへ変換する
 * - Excel/HTML表: Markdown tableに変換
 * - VS Code由来のコード: 余計な空行を除いてコードブロック化
 * - URL/パス: ユーザーに入力を求めた上でMarkdownリンクを生成
 */

const readClipboard = async () => {
    const fallbackText = async () => {
        try {
            return await tp.system.clipboard();
        } catch (e) {
            return "";
        }
    };

    const result = {
        text: await fallbackText(),
        html: "",
        source: "",
    };

    if (!navigator.clipboard?.read) {
        return result;
    }

    try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
            if (item.types.includes("text/html")) {
                result.html = await (await item.getType("text/html")).text();
            }
            if (item.types.includes("text/plain")) {
                result.text = await (await item.getType("text/plain")).text();
            }
        }
    } catch (e) {
        // Obsidian/OSの権限でHTMLクリップボードを読めない場合はプレーンテキストで続行する
    }

    const sourceMatch = result.html.match(/StartFragment[\s\S]*?(?:data-vscode|vscode-editor-data|--vscode|monaco-editor|font-family:\s*[^;]*(?:Consolas|Menlo|Monaco|monospace))/i);
    if (sourceMatch) {
        result.source = "vscode";
    }

    return result;
};

const escapeTableCell = (value) => {
    return String(value ?? "")
        .replace(/\r?\n+/g, "<br>")
        .replace(/\|/g, "\\|")
        .trim();
};

const getCellText = (cell) => {
    return (cell.innerText || cell.textContent || "")
        .replace(/\u00a0/g, " ")
        .replace(/\r?\n/g, " ")
        .trim();
};

const tableToMatrix = (table) => {
    const rows = Array.from(table.querySelectorAll("tr"));
    const matrix = [];

    rows.forEach((row, rowIndex) => {
        if (!matrix[rowIndex]) matrix[rowIndex] = [];

        let colIndex = 0;
        const cells = Array.from(row.querySelectorAll("th, td"));
        cells.forEach((cell) => {
            while (matrix[rowIndex][colIndex] !== undefined) {
                colIndex++;
            }

            const text = getCellText(cell);
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

const matrixToMarkdownTable = (matrix) => {
    const rows = matrix.filter((row) => row.some((cell) => String(cell ?? "").trim() !== ""));
    if (rows.length === 0) return "";

    const width = Math.max(1, ...rows.map((row) => row.length));
    const normalized = rows.map((row) => Array.from({ length: width }, (_, index) => escapeTableCell(row[index])));
    const header = normalized[0];
    const separator = Array.from({ length: width }, () => "---");
    const body = normalized.slice(1);

    return [
        `| ${header.join(" | ")} |`,
        `| ${separator.join(" | ")} |`,
        ...body.map((row) => `| ${row.join(" | ")} |`),
    ].join("\n");
};

const extractExcelTable = (html, text) => {
    if (html) {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const table = doc.querySelector("table");
        if (table) {
            return matrixToMarkdownTable(tableToMatrix(table));
        }
    }

    const trimmedText = text.trim();
    if (trimmedText.includes("\t") && trimmedText.includes("\n")) {
        return matrixToMarkdownTable(tsvToMatrix(trimmedText));
    }

    return "";
};

const isDuplicateIgnoringWhitespace = (candidate, fallback) => {
    const compactCandidate = candidate.replace(/\s+/g, "");
    const compactFallback = fallback.replace(/\s+/g, "");
    return compactFallback
        && compactCandidate === `${compactFallback}${compactFallback}`;
};

const htmlToCodeText = (html, fallbackText) => {
    if (!html) return fallbackText;

    const doc = new DOMParser().parseFromString(html, "text/html");
    const container = doc.querySelector("div[data-vscode-editor-data]") || doc.body;
    const lines = Array.from(container.querySelectorAll("div"))
        .filter((line) => !line.querySelector("div"))
        .map((line) => line.innerText || line.textContent || "")
        .filter((line) => line !== "");

    if (lines.length > 0) {
        const htmlText = lines.join("\n");
        return isDuplicateIgnoringWhitespace(htmlText, fallbackText) ? fallbackText : htmlText;
    }

    const htmlText = container.innerText || fallbackText;
    return isDuplicateIgnoringWhitespace(htmlText, fallbackText) ? fallbackText : htmlText;
};

const normalizeCodeText = (text) => {
    return text
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
};

const guessCodeLanguage = (text) => {
    const firstLine = text.trimStart().split("\n")[0] || "";
    if (/^\s*(import|export)\s/.test(text) || /=>|const |let |function /.test(text)) return "javascript";
    if (/^\s*(def|class|from |import )/.test(text) && /:\s*$/.test(firstLine)) return "python";
    if (/^\s*</.test(firstLine)) return "html";
    if (/^\s*[{[]/.test(firstLine)) return "json";
    return "";
};

const isProbablyCode = (text) => {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (!normalized.includes("\n")) return false;
    if (/^\s*[-*+]\s+/m.test(normalized)) return false;
    if (/^#{1,6}\s+/m.test(normalized)) return false;
    if (/^\s*(async\s+)?def\s+\w+\s*\([^)]*\)\s*:/m.test(normalized)) return true;
    if (/^\s*(class|if|for|while|try|except|with)\b.*:\s*$/m.test(normalized) && /^\s{2,}\S/m.test(normalized)) return true;
    return /(^|\n)\s*(import|export|const|let|var|function|class|def|from|if|for|while|try|catch|return)\b/.test(normalized)
        || /[{};]\s*\n/.test(normalized)
        || /^\s{2,}\S/m.test(normalized);
};

// SharePoint（ホスト名が ghi で始まる http/https の URL）を UNC パスに変換する。変換できなければ null。
// 例: http://ghi1.example/Forms/AllItems.aspx?id=%2FDoc%2FA → \\ghi1.example@80\Doc\A（id が無ければ pathname）
const convertSharePointUrlToUnc = (urlString) => {
    try {
        const urlObj = new URL(urlString);
        if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") return null;
        if (!urlObj.hostname.toLowerCase().startsWith("ghi")) return null;

        const isHttps = urlObj.protocol === "https:";
        const connection = urlObj.port
            ? (isHttps ? `SSL@${urlObj.port}` : urlObj.port)
            : (isHttps ? "SSL" : "80");

        let pathValue = urlObj.searchParams.get("id") || decodeURIComponent(urlObj.pathname);
        if (!pathValue.startsWith("/")) pathValue = `/${pathValue}`;
        pathValue = pathValue.replace(/\//g, "\\").replace(/\\+$/g, "");
        // 末尾が .aspx のページ（AllItems.aspx など）なら、そのファイル分を除いて親フォルダにする
        pathValue = pathValue.replace(/\\[^\\]*\.aspx$/i, "");
        if (!pathValue) return null;

        return `\\\\${urlObj.hostname}@${connection}${pathValue}`;
    } catch (e) {
        return null;
    }
};

const buildMarkdownLink = async (rawClipboardContent) => {
    let clipboardContent = rawClipboardContent.trim();
    if (clipboardContent.includes("\n") || clipboardContent.includes("\r")) {
        return clipboardContent;
    }

    clipboardContent = clipboardContent.replace(/^["']|["']$/g, "");
    // 末尾の %0d（URLに混入した改行）と空白を取り除く
    clipboardContent = clipboardContent.replace(/(?:%0d|\s)+$/i, "").trim();
    const uncPath = /^https?:/i.test(clipboardContent) ? convertSharePointUrlToUnc(clipboardContent) : null;
    if (uncPath) clipboardContent = uncPath;
    const originalClipboardContent = clipboardContent;
    const normalizedClipboardContent = uncPath || clipboardContent.replace(/\\/g, "/");

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

const clipboard = await readClipboard();
const tableMarkdown = extractExcelTable(clipboard.html, clipboard.text);

if (tableMarkdown) {
    tR += tableMarkdown;
} else if (clipboard.source === "vscode" || isProbablyCode(clipboard.text)) {
    const codeText = normalizeCodeText(htmlToCodeText(clipboard.html, clipboard.text));
    const language = guessCodeLanguage(codeText);
    tR += `\`\`\`${language}\n${codeText}\n\`\`\``;
} else {
    tR += await buildMarkdownLink(clipboard.text);
}
%>
