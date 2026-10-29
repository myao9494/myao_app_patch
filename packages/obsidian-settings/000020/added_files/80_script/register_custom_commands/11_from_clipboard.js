// =============================================================================
// From Clipboard（クリップボードの内容をMarkdownへ変換）
// =============================================================================

// クリップボードのテキストとHTMLを読み取る。HTMLが読めない環境ではテキストだけを返す。
const readClipboardForMarkdown = async () => {
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

    return clipboard;
};

const escapeClipboardTableCell = (value) => String(value ?? "")
    .replace(/\r?\n+/g, "<br>")
    .replace(/\|/g, "\\|")
    .trim();

const matrixToMarkdownTable = (matrix) => {
    const rows = matrix.filter((row) => row.some((cell) => String(cell ?? "").trim() !== ""));
    if (rows.length === 0) return "";

    const width = Math.max(1, ...rows.map((row) => row.length));
    const normalized = rows.map((row) => Array.from({ length: width }, (_, index) => escapeClipboardTableCell(row[index])));
    const separator = Array.from({ length: width }, () => "---");
    return [
        `| ${normalized[0].join(" | ")} |`,
        `| ${separator.join(" | ")} |`,
        ...normalized.slice(1).map((row) => `| ${row.join(" | ")} |`),
    ].join("\n");
};

// HTMLの表を2次元配列にする。結合セル（rowspan / colspan）は、同じ文字を各セルへ展開する。
const htmlTableToMatrix = (table) => {
    const rows = Array.from(table.querySelectorAll("tr"));
    const matrix = [];
    rows.forEach((row, rowIndex) => {
        if (!matrix[rowIndex]) matrix[rowIndex] = [];
        let colIndex = 0;
        Array.from(row.querySelectorAll("th, td")).forEach((cell) => {
            while (matrix[rowIndex][colIndex] !== undefined) colIndex++;
            const text = (cell.innerText || cell.textContent || "").replace(/ /g, " ").replace(/\r?\n/g, " ").trim();
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

// タブ区切りテキストを2次元配列にする。結合セルの貼り付けで空になったセルは、左または上の値で補う。
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

// クリップボードに表（HTMLの table、またはタブ区切りの複数行）があれば、Markdownの表にして返す。
const extractClipboardTable = (clipboard) => {
    if (clipboard.html) {
        const doc = new DOMParser().parseFromString(clipboard.html, "text/html");
        const table = doc.querySelector("table");
        if (table) return matrixToMarkdownTable(htmlTableToMatrix(table));
    }
    const trimmedText = clipboard.text.trim();
    if (trimmedText.includes("\t") && trimmedText.includes("\n")) {
        return matrixToMarkdownTable(tsvToMatrix(trimmedText));
    }
    return "";
};

const normalizeClipboardCodeText = (text) => text
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

// エディタ（VS Code など）からコピーしたHTMLを、行ごとのコード文字列に戻す。
const clipboardHtmlToCodeText = (clipboard) => {
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

const getLastPathSegment = (pathValue) => {
    const normalizedPath = pathValue.replace(/\\/g, "/").replace(/\/+$/g, "");
    const segments = normalizedPath.split("/").filter((s) => s.length > 0);
    return segments.length > 0 ? segments[segments.length - 1] : null;
};

const normalizePathSeparators = (pathValue) => pathValue.replace(/\\/g, "/").replace(/\/+$/g, "");

// 保管庫内の Excalidraw ファイル（.excalidraw.md）の絶対パスなら、その埋め込み記法を返す。
const getVaultExcalidrawEmbed = (absolutePath) => {
    const vaultBasePath = normalizePathSeparators(app.vault.adapter.basePath || "");
    const normalizedAbsolutePath = normalizePathSeparators(absolutePath);

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

// SharePoint（ホスト名が ghi で始まる http/https の URL）を UNC パスに変換する。変換できなければ null。
// SharePoint は同じ場所でも、コピーの仕方で形の違う URL を発行する。パスは次の順に探す。
//   0. SharePoint 2013 以降の _layouts/15/start.aspx#/<ページ>?<クエリ> 形式は、# 以降が実際のページなので、それを URL として読み直す
//   1. クエリ id → RootFolder → sourcedoc → parent（名前の大文字小文字は区別しない。値が / で始まるか、http(s):// の URL のものだけ採用）
//   2. 短縮リンク https://host/:f:/r/<パス> の <パス>（/:f:/s/ など token 形式は解決できないので null）
//   3. URL の pathname（ファイルへの直リンク）
// FolderCTID / viewpath / View などパスでないパラメータは見ない。
// パス末尾の .aspx のページ名（AllItems.aspx など）は除き、親フォルダにする。
// 例（http://ghi1.example.jp は http://ghi1.example.jp@80 になる。以下は \\ghi1.example.jp@80 以降を示す）:
//   .../site/Forms/AllItems.aspx?RootFolder=%2Fsite%2Ffolder&FolderCTID=0x01 → \site\folder
//   .../site/Forms/AllItems.aspx?id=%2Fsite%2Ffolder                         → \site\folder
//   .../site/Forms/DispForm.aspx?ID=123（項目番号だけ。ファイルは特定できない）→ \site（ライブラリ）
//   .../site/folder/filename.xlsx                                            → \site\folder\filename.xlsx
//   .../_layouts/15/Doc.aspx?sourcedoc=%2Fsite%2Ffolder%2Ffile.xlsx          → \site\folder\file.xlsx
//   https://.../:f:/r/site/folder                                            → \site\folder
//   .../site/_layouts/15/start.aspx#/Shared%20Documents/Forms/AllItems.aspx?RootFolder=%2Fsite%2Ffolder → \site\folder
// 各パターンの確認は scratch/test_from_clipboard.js にある。
const convertSharePointUrlToUnc = (urlString) => {
    // デコードに失敗する値（% を含むファイル名など）はそのまま使う
    const decodeSafely = (value) => {
        try {
            return decodeURIComponent(value);
        } catch (e) {
            return value;
        }
    };

    try {
        const urlObj = new URL(urlString);
        if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") return null;
        if (!urlObj.hostname.toLowerCase().startsWith("ghi")) return null;

        // start.aspx#/Shared%20Documents/Forms/AllItems.aspx?RootFolder=… は、# 以降が実際のページ（サイトからの相対）。
        // 実際のページの URL に組み直して、もう一度変換する
        const startPage = urlObj.pathname.match(/^(.*)\/_layouts\/\d+\/start\.aspx$/i);
        if (startPage && urlObj.hash.startsWith("#/")) {
            return convertSharePointUrlToUnc(`${urlObj.origin}${startPage[1]}${urlObj.hash.slice(1)}`);
        }

        const isHttps = urlObj.protocol === "https:";
        const connection = urlObj.port
            ? (isHttps ? `SSL@${urlObj.port}` : urlObj.port)
            : (isHttps ? "SSL" : "80");

        // クエリの値をパスにする。searchParams が値を一度デコードしてくれる（エンコードされていない値もそのまま）。
        // 二重エンコード（%252F）は、もう一度デコードして救う。sourcedoc=http://host/site/a.docx のような
        // 完全な URL は、パス部分だけを使う。それ以外の / で始まらない値（DispForm.aspx?ID=123 の項目番号や
        // sourcedoc={GUID} の文書 ID）はパスではないため使わない。
        const toServerPath = (rawValue) => {
            let value = /^%2F/i.test(rawValue) ? decodeSafely(rawValue) : rawValue;
            if (/^https?:\/\//i.test(value)) {
                try {
                    value = decodeSafely(new URL(value).pathname);
                } catch (e) {
                    return null;
                }
            }
            return value.startsWith("/") ? value : null;
        };

        const pickPathFromQuery = () => {
            for (const name of ["id", "rootfolder", "sourcedoc", "parent"]) {
                for (const [key, rawValue] of urlObj.searchParams) {
                    if (key.toLowerCase() !== name) continue;
                    const value = toServerPath(rawValue);
                    if (value !== null) return value;
                }
            }
            return null;
        };

        let pathValue = pickPathFromQuery();
        if (pathValue === null) {
            // クエリにパスが無ければ pathname を使う（pathname は URL エンコードされたままなのでデコードする）
            pathValue = decodeSafely(urlObj.pathname);

            // 短縮リンク /:f:/r/<パス>。r 以外（s など）は共有 token でパスにならない
            const shortLink = pathValue.match(/^\/:[a-z]{1,2}:\/(\w)(\/.*)?$/i);
            if (shortLink) {
                if (shortLink[1].toLowerCase() !== "r") return null;
                pathValue = shortLink[2] || "";
            }

            // /_layouts/15/Doc.aspx など、文書の場所を含まない SharePoint の内部ページ
            if (/\/_layouts\//i.test(pathValue)) return null;
        }

        // 区切りを揃える（連続した区切りは1つにまとめる）。値の途中に混ざった改行などの制御文字（%0d）は取り除く
        const segments = pathValue
            .split(/[\/\\]+/)
            .map((segment) => segment.replace(/[\u0000-\u001f]+/g, ""))
            .filter(Boolean);

        // 末尾が .aspx のページ名なら除く。Forms 配下のページ（AllItems.aspx / DispForm.aspx）なら、
        // ライブラリのフォルダではない Forms も除いて、ライブラリのフォルダまで戻る
        if (segments.length > 0 && /\.aspx$/i.test(segments[segments.length - 1])) {
            segments.pop();
            if (segments.length > 0 && segments[segments.length - 1].toLowerCase() === "forms") {
                segments.pop();
            }
        }
        if (segments.length === 0) return null;

        return `\\\\${urlObj.hostname}@${connection}\\${segments.join("\\")}`;
    } catch (e) {
        return null;
    }
};

// URLまたはファイルパスを Markdown リンクにする（表示テキストは入力ダイアログで編集できる）。
// 複数行のテキストはリンクにせず、そのまま返す。
const buildMarkdownLink = async (rawClipboardContent) => {
    let clipboardContent = rawClipboardContent.trim();
    if (clipboardContent.includes("\n") || clipboardContent.includes("\r")) {
        return clipboardContent;
    }

    clipboardContent = clipboardContent.replace(/^["']|["']$/g, "");
    // 末尾の %0d・%0a（URLに混入した改行）と空白を取り除く
    clipboardContent = clipboardContent.replace(/(?:%0d|%0a|\s)+$/i, "").trim();
    const uncPath = /^https?:/i.test(clipboardContent) ? convertSharePointUrlToUnc(clipboardContent) : null;
    if (uncPath) clipboardContent = uncPath;
    const originalClipboardContent = clipboardContent;
    const normalizedClipboardContent = uncPath || clipboardContent.replace(/\\/g, "/");

    let linkText = "Link";
    let linkUrl = clipboardContent;
    let localPathForEmbed = null;
    let shouldBuildOpenPathLink = true;

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
    const vaultEmbed = vaultEmbedSourcePath ? getVaultExcalidrawEmbed(vaultEmbedSourcePath) : null;
    if (vaultEmbed) {
        markdown += `\n\n${vaultEmbed}`;
    }

    return markdown;
};

// クリップボードの内容を、表 → コードブロック → リンク の順に判定して Markdown にする。
const fromClipboard = async () => {
    const clipboard = await readClipboardForMarkdown();

    const tableMarkdown = extractClipboardTable(clipboard);
    if (tableMarkdown) return tableMarkdown;

    if (clipboard.source === "vscode" || isProbablyCode(clipboard.text)) {
        const codeText = normalizeClipboardCodeText(clipboardHtmlToCodeText(clipboard));
        const language = guessCodeLanguage(codeText);
        return `\`\`\`${language}\n${codeText}\n\`\`\``;
    }

    return await buildMarkdownLink(clipboard.text);
};
