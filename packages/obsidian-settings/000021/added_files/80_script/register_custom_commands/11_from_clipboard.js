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

// Excel のセルなどから URL を1つだけコピーしたかを判定する（結合セルは全セルが同じ値になる）。
// HTML のセルは長い値が途中で折り返されていることがあるため、URL かどうかはプレーンテキストで見る。
const isSingleUrlCell = (matrix, text) => {
    const trimmedText = text.trim();
    const values = new Set(matrix.flat().map((cell) => String(cell ?? "").trim()).filter(Boolean));
    return values.size === 1 && !/[\t\r\n]/.test(trimmedText) && /https?:\/\//i.test(trimmedText);
};

// クリップボードに表（HTMLの table、またはタブ区切りの複数行）があれば、Markdownの表にして返す。
const extractClipboardTable = (clipboard) => {
    if (clipboard.html) {
        const doc = new DOMParser().parseFromString(clipboard.html, "text/html");
        const table = doc.querySelector("table");
        if (table) {
            const matrix = htmlTableToMatrix(table);
            return isSingleUrlCell(matrix, clipboard.text) ? "" : matrixToMarkdownTable(matrix);
        }
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

// %XX の並びごとにデコードする。デコードできない部分（名前の % など）だけを残すので、隣の日本語はデコードされる
const decodeUriSafely = (value) => value.replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => {
    try {
        return decodeURIComponent(encoded);
    } catch (e) {
        return encoded;
    }
});

// 多重にエンコードされた値（%252F や %25E8）を、変わらなくなるまでデコードする
const decodeUriRepeatedly = (value) => {
    let decoded = value;
    for (let i = 0; i < 4; i++) {
        const next = decodeUriSafely(decoded);
        if (next === decoded) break;
        decoded = next;
    }
    return decoded;
};

// SharePoint（ホスト名が ghi で始まる http/https の URL）を UNC パスに変換する。変換できなければ null。
// SharePoint は同じ場所でも、コピーの仕方で形の違う URL を発行する。パスは次の順に探す。
//   0. SharePoint 2013 以降の _layouts/15/start.aspx#/<ページ>?<クエリ> 形式は、# 以降が実際のページなので、それを URL として読み直す
//   1. 一覧画面でフォルダを移動した後のハッシュ #InplviewHash…=…RootFolder…（クエリは移動前の値のままなので、これを優先する）
//   2. クエリ id → RootFolder → sourcedoc → parent（名前の大文字小文字は区別しない。値が / で始まるか、http(s):// の URL のものだけ採用）
//   3. 短縮リンク https://host/:f:/r/<パス> の <パス>（/:f:/s/ など token 形式は解決できないので null）
//   4. URL の pathname（ファイルへの直リンク）
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
//   .../site/Forms/AllItems.aspx#InplviewHash…=FolderCTID%3D0x01-RootFolder%3D%252Fsite%252Ffolder       → \site\folder
// 各パターンの確認は scratch/test_from_clipboard.js にある。
const convertSharePointUrlToUnc = (urlString) => {
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
        // 多重エンコード（%252F）は、さらにデコードして救う。sourcedoc=http://host/site/a.docx のような
        // 完全な URL は、パス部分だけを使う。それ以外の / で始まらない値（DispForm.aspx?ID=123 の項目番号や
        // sourcedoc={GUID} の文書 ID）はパスではないため使わない。
        const toServerPath = (rawValue) => {
            let value = /^%(?:25)*2F/i.test(rawValue) ? decodeUriRepeatedly(rawValue) : rawValue;
            if (/^https?:\/\//i.test(value)) {
                try {
                    value = decodeUriSafely(new URL(value).pathname);
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

        // 一覧画面でフォルダを移動すると、ページを読み直さずハッシュだけが変わり、クエリは移動前の値のまま残る。
        // ハッシュは全体が1回、RootFolder の値がさらに1回エンコードされている（日本語は %25E8… になる）。
        // 名前の - は値の中でもエンコードされないため、「-名前=」が続く位置までを値とする
        const pickPathFromHash = () => {
            if (!/^#InplviewHash/i.test(urlObj.hash)) return null;
            const match = decodeUriSafely(urlObj.hash).match(/[-=]RootFolder=(.+?)(?=-[A-Za-z_]\w*=|$)/is);
            return match ? toServerPath(decodeUriRepeatedly(match[1])) : null;
        };

        let pathValue = pickPathFromHash() ?? pickPathFromQuery();
        if (pathValue === null) {
            // クエリにパスが無ければ pathname を使う（pathname は URL エンコードされたままなのでデコードする）
            pathValue = decodeUriSafely(urlObj.pathname);

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

// 文章や記号の中の URL を探す。日本語の閉じ括弧や句読点の手前までを URL とする
const URL_IN_TEXT_PATTERN = /https?:\/\/[^\s<>"'`「」『』【】〈〉《》＜＞、。]+/gi;

// URL の後ろに続く文章を切り離す。対応の取れない閉じ括弧より後ろと、末尾の句読点は URL に含めない
const cutUrlAtSentenceEnd = (url) => {
    let depth = 0;
    let end = url.length;
    for (let i = 0; i < url.length; i++) {
        if ("(（".includes(url[i])) depth++;
        else if (")）".includes(url[i]) && --depth < 0) {
            end = i;
            break;
        }
    }
    return url.slice(0, end).replace(/[.,;:!?，．；：！？]+$/, "");
};

// 1行のテキストから URL を取り出す。URL が無ければテキストをそのまま返し、複数あって1つに決められなければ null を返す。
// http で始まる行は、URL に空白が混ざった場合に備えて行全体を URL として扱う（第1回　資料 のような名前を途中で切らない）。
// ただし空白より前がエンコード済みの URL で、後ろが日本語の文章（パスの続きではない）なら、空白の手前までを URL とする。
const findUrlInText = (text) => {
    const urls = text.match(URL_IN_TEXT_PATTERN) || [];
    if (urls.length > 1) return null;
    const urlBeforeSentence = text.match(/^(https?:\/\/[\x21-\x7e]+)\s+[^\x00-\x7f][^/\\]*$/i);
    if (urlBeforeSentence) return cutUrlAtSentenceEnd(urlBeforeSentence[1]);
    if (urls.length === 0 || /^https?:/i.test(text)) return text;
    return cutUrlAtSentenceEnd(urls[0]);
};

// リンク先の空白と半角括弧をエンコードする（Markdown のリンクがそこで切れるため）。日本語はそのまま残す
const escapeMarkdownLinkUrl = (url) => url.replace(/[\s()]/g, (char) => (
    char === "(" ? "%28" : char === ")" ? "%29" : encodeURIComponent(char)
));

// 表示テキストの半角の角括弧をエスケープする（[[…]] の内部リンクに化けないように）
const escapeMarkdownLinkText = (text) => text.replace(/(?<!\\)[[\]]/g, "\\$&");

// 通知を10秒表示する
const showFromClipboardNotice = (message) => {
    const NoticeClass = tp?.obsidian?.Notice || (typeof Notice !== "undefined" ? Notice : null);
    if (NoticeClass) new NoticeClass(message, 10000);
};

// 折り返された URL の続きの行かどうかを判定する。空白や \ を含む行と、別の URL は続きとみなさない。
// %XX・/・=・& を含む行か拡張子で終わる行、または前の行が %XX の途中で切れている行だけを続きとする（文章やタグを繋がないように）
const isUrlContinuation = (line, previousLine) => !/\s|\\|^https?:/i.test(line)
    && (/%[0-9a-f]?$/i.test(previousLine) || /%[0-9a-f]{2}|[/=&]|\.[a-z0-9]{1,5}>?$/i.test(line));

// メールなどで途中で改行された URL を1行に繋ぐ。URL でなければテキストをそのまま返す
const joinWrappedUrl = (text) => {
    const lines = text.trim().split(/\r\n|\r|\n/).map((line) => line.trim());
    if (lines.length < 2 || !/^<?https?:\/\/\S+$/i.test(lines[0])) return text;
    return lines.slice(1).every((line, index) => isUrlContinuation(line, lines[index])) ? lines.join("") : text;
};

// Outlook の Safe Links で包まれた URL を、元の URL に戻す
const unwrapSafeLink = (url) => {
    try {
        const urlObj = new URL(url);
        if (!/(^|\.)safelinks\.protection\.(outlook\.com|office365\.us)$/i.test(urlObj.hostname)) return url;
        const originalUrl = urlObj.searchParams.get("url");
        return originalUrl && /^https?:\/\//i.test(originalUrl) ? originalUrl : url;
    } catch (e) {
        return url;
    }
};

const SHARE_LINK_KINDS = { f: "フォルダ", x: "Excel", w: "Word", p: "PowerPoint", b: "PDF", o: "OneNote" };

// 共有 token のリンク（/:f:/s/サイト/token など）の表示名を作る。パスを含むリンク（/:f:/r/…）は null
const describeShareLink = (urlObj) => {
    const match = decodeUriSafely(urlObj.pathname).match(/^\/:([a-z]{1,2}):\/(?!r\/)\w\/(?:(?:.*\/)?([^/]+)\/)?[^/]+\/?$/i);
    if (!match) return null;
    const kind = SHARE_LINK_KINDS[match[1].toLowerCase()] || "ファイル";
    return `${match[2] ? `${match[2]}の` : ""}共有${kind}`;
};

// 表示名だけがテキストになるリンクのコピーから、リンク先と表示名を取り出す。
// コピーした内容全体が1つのリンクのときだけ返す。リンクの前後に文章があるときや、テキストが URL のときは null
const pickHtmlLink = (html) => {
    if (!html) return null;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const anchors = Array.from(doc.querySelectorAll("a[href]"));
    const urls = new Set(anchors.map((anchor) => (anchor.getAttribute("href") || "").trim()));
    const [url] = urls;
    if (urls.size !== 1 || !/^https?:\/\//i.test(url)) return null;

    const toText = (element) => (element.textContent || "").replace(/\s+/g, " ").trim();
    const text = toText(doc.body);
    const linkText = anchors.map(toText).filter(Boolean).join(" ");
    if (!text || text !== linkText || /^https?:/i.test(text)) return null;
    return { url, text };
};

// URLまたはファイルパスを Markdown リンクにする（表示テキストは入力ダイアログで編集できる）。
// preferredLinkText があれば、それを表示テキストの初期値にする。複数行のテキストはリンクにせず、そのまま返す。
const buildMarkdownLink = async (rawClipboardContent, preferredLinkText = null) => {
    let clipboardContent = joinWrappedUrl(rawClipboardContent).trim();
    if (clipboardContent.includes("\n") || clipboardContent.includes("\r")) {
        return clipboardContent;
    }

    clipboardContent = clipboardContent.replace(/^["']|["']$/g, "");
    // 文章や記号に囲まれていれば URL だけを取り出す
    const urlInText = findUrlInText(clipboardContent);
    if (urlInText === null) return clipboardContent;
    // 末尾の %0d・%0a（URLに混入した改行）と空白を取り除く
    clipboardContent = unwrapSafeLink(urlInText).replace(/(?:%0d|%0a|\s)+$/i, "").trim();
    const uncPath = /^https?:/i.test(clipboardContent) ? convertSharePointUrlToUnc(clipboardContent) : null;
    if (uncPath) {
        clipboardContent = uncPath;
        // 変換結果を読める形（デコード済み）で通知する。%5F などのコードではなく実際のパスを確認できる
        showFromClipboardNotice(`SharePoint の URL を UNC パスに変換しました:\n${uncPath}`);
        console.log("[From Clipboard] SharePoint URL → UNC", { input: rawClipboardContent, unc: uncPath });
    }
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
                ? getLastPathSegment(decodeUriSafely(openPathParam))
                : filepathParam
                    ? getLastPathSegment(decodeUriSafely(filepathParam))
                    : getLastPathSegment(urlObj.pathname);

            if (lastSegment) {
                linkText = decodeUriSafely(lastSegment);
            } else {
                linkText = urlObj.hostname;
            }

            const shareLinkText = describeShareLink(urlObj);
            if (shareLinkText) {
                linkText = shareLinkText;
                showFromClipboardNotice("共有リンクはパスを含まないため UNC パスに変換できません。URL のまま貼り付けます。");
            }

            if (openPathParam && urlObj.pathname === "/api/open-path") {
                localPathForEmbed = decodeUriSafely(openPathParam);
                shouldBuildOpenPathLink = false;
            } else if (filepathParam && urlObj.pathname === "/") {
                localPathForEmbed = decodeUriSafely(filepathParam);
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

    if (preferredLinkText) linkText = preferredLinkText;

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

    let markdown = `[${escapeMarkdownLinkText(linkText)}](${escapeMarkdownLinkUrl(linkUrl)})`;
    const vaultEmbedSourcePath = localPathForEmbed || (!isUrl ? originalClipboardContent : null);
    const vaultEmbed = vaultEmbedSourcePath ? getVaultExcalidrawEmbed(vaultEmbedSourcePath) : null;
    if (vaultEmbed) {
        markdown += `\n\n${vaultEmbed}`;
    }

    return markdown;
};

// クリップボードの内容を、HTML のリンク → 表 → コードブロック → リンク の順に判定して Markdown にする。
// 途中で改行された URL は、表やコードと判定される前に1行に繋ぐ。
const convertClipboardToMarkdown = async (clipboard) => {
    const htmlLink = clipboard.source === "vscode" ? null : pickHtmlLink(clipboard.html);
    if (htmlLink) return await buildMarkdownLink(htmlLink.url, htmlLink.text);

    const text = joinWrappedUrl(clipboard.text);
    const tableMarkdown = extractClipboardTable({ ...clipboard, text });
    if (tableMarkdown) return tableMarkdown;

    if (clipboard.source === "vscode" || isProbablyCode(text)) {
        const codeText = normalizeClipboardCodeText(clipboardHtmlToCodeText(clipboard));
        const language = guessCodeLanguage(codeText);
        return `\`\`\`${language}\n${codeText}\n\`\`\``;
    }

    return await buildMarkdownLink(text);
};

const fromClipboard = async () => await convertClipboardToMarkdown(await readClipboardForMarkdown());

// =============================================================================
// iframe (from clipboard)（クリップボードの URL から iframe の埋め込みを作る）
// =============================================================================

// クリップボードの文字列から埋め込み先の URL を取り出す。
// URL だけ、または <iframe src="…"> のコピーを受け付け、http / https 以外（javascript: など）は埋め込まない。
const extractIframeUrl = (text) => {
    const source = joinWrappedUrl(String(text ?? "")).trim();
    const srcMatch = source.match(/<iframe\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/i);
    const candidate = (srcMatch ? srcMatch[1] : source).replace(/^<|>$/g, "").trim();
    if (!/^https?:\/\/\S+$/i.test(candidate)) return "";
    try {
        new URL(candidate);
    } catch (e) {
        return "";
    }
    return candidate.replace(/&amp;/g, "&");
};

// iframe の HTML を作る。src に使えない文字（" < >）は URL エンコードして属性を壊さない。
const buildIframeHtml = (url) => {
    const safeUrl = url.replace(/["<>]/g, (char) => encodeURIComponent(char));
    return [
        "<iframe",
        `  src="${safeUrl}"`,
        '  width="100%"',
        '  height="600"',
        '  style="border:0">',
        "</iframe>",
    ].join("\n");
};

// クリップボードの URL から iframe を作る。URL でなければ通知して、何も挿入しない（null）。
const iframeFromClipboard = async () => {
    const clipboard = await readClipboardForMarkdown();
    const url = extractIframeUrl(clipboard.text);
    if (!url) {
        showFromClipboardNotice("クリップボードに http(s) の URL がありません。iframe を作れませんでした。");
        return null;
    }
    return buildIframeHtml(url);
};
