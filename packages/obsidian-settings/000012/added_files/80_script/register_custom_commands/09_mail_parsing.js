// =============================================================================
// メール解析（MSG / TNEF）
// 解析と本文の変換は obsidian-sidebar-explorer-tag プラグインの実装を使う（msgParser.ts / tnefParser.ts）。
// プラグインが window へ公開する関数（mailGlobals.ts）を呼び出すだけで、このファイルには解析処理を持たない。
// =============================================================================

/**
 * プラグインが公開するメール本文の変換ヘルパー（表のMarkdown変換、RTF抽出）を返す。
 * プラグインが動いていない場合は null。
 **/
const getMailHelpers = () => (typeof window !== "undefined" ? window._sidebarExplorerMailHelpers : null) || null;

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

/**
 * HTML文字列内の <table>...</table> をMarkdownテーブル形式へ変換する（プラグインの実装へ委譲）。
 **/
const convertHtmlTablesToMarkdown = (html) => {
    const helpers = getMailHelpers();
    return typeof helpers?.convertHtmlTablesToMarkdown === "function" ? helpers.convertHtmlTablesToMarkdown(html) : html;
};

/**
 * RTFドキュメントからプレーンテキストを抽出する（プラグインの実装へ委譲）。
 * MSG の RtfBody はプラグインが抽出済みのプレーンテキスト、TNEF の RtfBody は生のRTFで渡されるため、
 * RTFではない文字列はそのまま返す。
 **/
const extractPlainTextFromRtf = (rtfInput) => {
    if (typeof rtfInput !== "string") return "";
    if (!rtfInput.startsWith("{\\rtf")) return rtfInput;
    const helpers = getMailHelpers();
    return typeof helpers?.extractPlainTextFromRtf === "function" ? helpers.extractPlainTextFromRtf(rtfInput) : "";
};

// プラグイン未起動の通知を、1回のサマリー作成で繰り返し表示しないための時刻
let lastMailParserUnavailableNoticeAt = 0;

/**
 * .msg および .dat（TNEF / winmail.dat）ファイルを解析する。
 * obsidian-sidebar-explorer-tag プラグインが公開するパーサーを使う。プラグインが動いていない場合は
 * 解析できないため、通知を表示して null を返す。
 **/
const parseMsgFile = async (file) => {
    const tnefParser = typeof window !== "undefined" ? window._sidebarExplorerParseTnefFile : null;
    const msgParser = typeof window !== "undefined" ? window._sidebarExplorerParseMsgFile : null;
    const isDat = file.extension?.toLowerCase() === "dat" || file.name?.toLowerCase() === "winmail.dat";

    // winmail.dat は TNEF パーサーを優先し、結果が得られない場合だけ MSG パーサーで試す。
    const parsers = [
        ...(isDat && typeof tnefParser === "function" ? [{ label: "TNEF parser", parse: tnefParser }] : []),
        ...(typeof msgParser === "function" ? [{ label: "Bundled MSG parser", parse: msgParser }] : []),
    ];

    if (parsers.length === 0) {
        console.error(`Mail parser is not available for ${file.path}. Enable the Sidebar Explorer Tag plugin.`);
        if (Date.now() - lastMailParserUnavailableNoticeAt > 5000) {
            lastMailParserUnavailableNoticeAt = Date.now();
            new Notice("メールの展開には Sidebar Explorer Tag プラグインが必要です。プラグインを有効にして再実行してください。");
        }
        return null;
    }

    for (const { label, parse } of parsers) {
        try {
            const res = await parse(file);
            if (res) {
                if (!res.Body && res.RtfBody) {
                    res.Body = extractPlainTextFromRtf(res.RtfBody);
                }
                return res;
            }
        } catch (error) {
            console.error(`${label} failed for ${file.path}:`, error);
            return null;
        }
    }
    return null;
};
