"""
AIインプット用HTMLのスタイルシート。
仕様:
- 外部依存のないライトテーマの CSS を 1 つの文字列として返す。
- 印刷時（@media print）は A4 縦、背景色・境界線の保持、記事や図面の改ページ制御を適用する。
"""



def get_ai_export_css() -> str:
    """AI読み取りおよび人間表示に適したクリーンなCSSスタイルを返す"""
    return """
/* === AI Context Export Reset & Clean Theme === */
:root {
    --text-primary: #1e293b;

    --text-secondary: #475569;
    --text-muted: #64748b;
    --bg-main: #ffffff;
    --bg-card: #f8fafc;
    --border-color: #e2e8f0;
    --accent-blue: #2563eb;
    --accent-indigo: #4f46e5;
    --accent-green: #059669;
    --code-bg: #f1f5f9;
}

html, body {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: var(--text-primary);
    background-color: var(--bg-main);
    line-height: 1.6;
    font-size: 15px;
}

.ai-document-container {
    max-width: 960px;
    margin: 0 auto;
    padding: 32px 24px;
}

/* ヘッダー */
.ai-header {
    border-bottom: 2px solid var(--accent-indigo);
    padding-bottom: 16px;
    margin-bottom: 24px;
}

.ai-header h1 {
    font-size: 24px;
    margin: 0 0 8px 0;
    color: var(--accent-indigo);
}

.ai-meta-info {
    font-size: 13px;
    color: var(--text-muted);
}

/* AI プロンプトセクション */
.ai-prompt-section {
    background: #eff6ff;
    border: 1px solid #bfdbfe;
    border-left: 5px solid var(--accent-blue);
    border-radius: 6px;
    padding: 16px 20px;
    margin-bottom: 28px;
}

.ai-prompt-section h2 {
    font-size: 16px;
    margin: 0 0 10px 0;
    color: #1e40af;
}

.ai-prompt-content {
    font-size: 14.5px;
    color: #1e3a8a;
    white-space: pre-wrap;
    font-weight: 500;
}

/* 目次 */
.document-toc {
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 16px 20px;
    margin-bottom: 32px;
}

.document-toc h2 {
    font-size: 15px;
    margin: 0 0 10px 0;
    color: var(--text-secondary);
}

.document-toc ul {
    margin: 0;
    padding-left: 20px;
}

.document-toc li {
    margin-bottom: 4px;
    font-size: 13.5px;
}

/* 階層リンク先表示スタイル */
.depth-badge {
    display: inline-block;
    font-size: 11px;
    font-weight: 600;
    color: #4338ca;
    background: #e0e7ff;
    padding: 1px 7px;
    border-radius: 4px;
    margin-right: 6px;
    vertical-align: middle;
}

.depth-parent-info {
    font-size: 12px;
    color: #64748b;
    font-style: normal;
}

.document-article.is-child {
    border-left: 4px solid #818cf8;
    background-color: #fafbfd;
}

.toc-child {
    list-style-type: none;
}

.document-toc a {
    color: var(--accent-blue);
    text-decoration: none;
}

.document-toc a:hover {
    text-decoration: underline;
}

/* ドキュメント記事 */
.document-article {
    background: #ffffff;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 24px 28px;
    margin-bottom: 36px;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
}

.document-article-header {
    border-bottom: 1px solid var(--border-color);
    padding-bottom: 12px;
    margin-bottom: 18px;
}

.document-article-header h2 {
    font-size: 20px;
    margin: 0 0 6px 0;
    color: var(--text-primary);
}

.document-path-badge {
    display: inline-block;
    font-size: 12px;
    font-family: monospace;
    background: #f1f5f9;
    padding: 2px 8px;
    border-radius: 4px;
    color: var(--text-muted);
}

/* 本文タイポグラフィ */
.document-body h1, .document-body h2, .document-body h3, .document-body h4 {
    color: var(--text-primary);
    margin-top: 1.4em;
    margin-bottom: 0.6em;
}

.document-body p {
    margin: 0.8em 0;
}

.document-body table {
    border-collapse: collapse;
    width: 100%;
    margin: 1.2em 0;
}

.document-body th, .document-body td {
    border: 1px solid var(--border-color);
    padding: 8px 12px;
    text-align: left;
}

.document-body th {
    background-color: var(--bg-card);
    font-weight: 600;
}

.document-body pre {
    background: var(--code-bg);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 12px 16px;
    overflow-x: auto;
    font-size: 13px;
    line-height: 1.5;
}

.document-body code {
    background: var(--code-bg);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.9em;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.document-body pre code {
    background: transparent;
    padding: 0;
}

.document-body blockquote {
    border-left: 4px solid var(--accent-indigo);
    margin: 1em 0;
    padding-left: 14px;
    color: var(--text-secondary);
}

.document-body img {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 16px auto;
}

/* マークダウン元データセクション */
.doc-raw-markdown {
    margin-top: 24px;
    border-top: 1px dashed var(--border-color);
    padding-top: 14px;
}

.doc-raw-markdown summary {
    font-size: 12.5px;
    color: var(--text-muted);
    cursor: pointer;
    font-weight: 500;
}

.doc-raw-markdown pre {
    background: #fafafa;
    border: 1px solid #e5e5e5;
    border-radius: 4px;
    padding: 10px 14px;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-all;
}

/* APPENDIX 呼び出されたメールセクション */
.ai-linked-emails-section {
    margin-top: 48px;
    border-top: 2px solid var(--accent-blue);
    padding-top: 24px;
}

.ai-linked-emails-section > h2 {
    font-size: 20px;
    color: var(--accent-blue);
    margin-bottom: 20px;
    display: flex;
    align-items: center;
    gap: 8px;
}

.linked-email-article {
    border-left: 4px solid var(--accent-blue) !important;
}

.linked-email-meta {
    background: #f8fafc;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 10px 14px;
    margin-bottom: 16px;
    font-size: 12.5px;
    line-height: 1.6;
}

.linked-email-meta dt {
    font-weight: 600;
    color: var(--text-secondary);
    display: inline;
}

.linked-email-meta dd {
    display: inline;
    margin-left: 4px;
    margin-right: 16px;
    color: var(--text-primary);
}

.email-plain-body pre {
    font-family: inherit;
    font-size: 14px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
}

/* === 印刷・高精度PDF出力用スタイル === */
@media print {
    @page {
        size: A4 portrait;
        margin: 12mm 15mm;
    }

    body {
        background-color: #ffffff !important;
        color: #000000 !important;
        font-size: 12pt;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
    }

    .ai-document-container {
        max-width: 100% !important;
        padding: 0 !important;
        margin: 0 !important;
    }

    .ai-prompt-section,
    .document-toc,
    .document-article,
    .linked-email-article,
    .email-appendix-item {
        break-inside: avoid;
        page-break-inside: avoid;
        margin-bottom: 20px;
    }

    h1, h2, h3, h4, h5, h6 {
        break-after: avoid;
        page-break-after: avoid;
    }

    img, svg, figure, .embedded-image-container {
        break-inside: avoid;
        page-break-inside: avoid;
        max-width: 100% !important;
        height: auto !important;
    }

    .doc-raw-markdown details {
        display: none !important;
    }
}
"""
