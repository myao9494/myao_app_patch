/**
 * Markdownプレビュー変換ユーティリティ（quickアプリ用）
 * - 見出し、リスト、タスクチェックボックス、引用、コードブロック、テーブルのHTML変換
 * - GFMテーブル（ヘッダー、区切り行、アライメント、セル内インライン装飾、レスポンシブ横スクロール）
 * - URL自動リンク化（平文URL、Forms等の長いURL、山括弧URLのaタグ変換）
 * - 画像（標準構文、Obsidian構文 ![[image.png]]）のURL解決とインライン表示
 * - コールアウト（[!NOTE] など）の装飾表示
 * - Tailscaleなどの動的ホスト対応
 */
import { AppSettings } from '../types';
import { getImageViewUrl } from '../api/client';
import { isAbsolutePath, resolvePath } from './pathUtils';

export interface MarkdownPreviewOptions {
  baseDir?: string;
  settings?: AppSettings;
}

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
  'avif',
  'excalidraw',
]);

export function isImageFile(fileNameOrPath: string): boolean {
  if (!fileNameOrPath) return false;
  if (
    fileNameOrPath.endsWith('.excalidraw.md') ||
    fileNameOrPath.endsWith('.excalidraw.svg') ||
    fileNameOrPath.endsWith('.drawio.svg')
  ) {
    return true;
  }
  const lastDot = fileNameOrPath.lastIndexOf('.');
  if (lastDot < 0 || lastDot === fileNameOrPath.length - 1) {
    return false;
  }
  const ext = fileNameOrPath.slice(lastDot + 1).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

export function resolveMarkdownImageUrl(
  src: string,
  baseDir?: string,
  settings?: AppSettings
): string {
  if (!src) return '';
  const trimmed = src.trim();

  // 外部URLまたはData URIはそのまま
  if (/^(https?:\/\/|data:image\/)/i.test(trimmed)) {
    return trimmed;
  }

  // <url> 形式の解除
  const cleanSrc = trimmed.replace(/^<([^>]+)>$/, '$1');

  // ローカルパスの解決
  let fullPath = cleanSrc;
  if (baseDir && !isAbsolutePath(cleanSrc)) {
    fullPath = resolvePath(baseDir, cleanSrc);
  }

  // settings が渡されていれば動的ホスト対応の getImageViewUrl を使用
  if (settings) {
    return getImageViewUrl(fullPath, settings, baseDir);
  }

  // フォールバック
  let fallback = `/api/view-image?path=${encodeURIComponent(fullPath)}`;
  if (baseDir) {
    fallback += `&baseDir=${encodeURIComponent(baseDir)}`;
  }
  return fallback;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderInline(text: string, baseDir?: string, settings?: AppSettings): string {
  let escaped = escapeHtml(text);

  // 1. インラインコードのプレースホルダー退避（コード内のURLや記号を保護）
  const codePlaceholders: string[] = [];
  escaped = escaped.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = codePlaceholders.length;
    codePlaceholders.push(`<code>${code}</code>`);
    return `\u0000CODE_${idx}\u0000`;
  });

  // 2. 標準Markdown画像構文: ![alt](url) または ![alt](url "title")
  escaped = escaped.replace(
    /!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(?:\s+(?:&quot;|")([^"&]*)(?:&quot;|"))?\)/g,
    (_match, alt, rawUrl, title) => {
      const unescapedUrl = rawUrl.replace(/^<([^>]+)>$/, '$1').replaceAll('&amp;', '&');
      const resolvedUrl = resolveMarkdownImageUrl(unescapedUrl, baseDir, settings);
      const titleAttr = title ? ` title="${title}"` : '';
      return `<img src="${resolvedUrl}" alt="${alt}"${titleAttr} class="markdown-preview-image" loading="lazy" />`;
    }
  );

  // 3. Obsidian埋め込み画像構文: ![[filename|opt]] または ![[filename]]
  escaped = escaped.replace(
    /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_match, target, option) => {
      const trimmedTarget = target.trim();
      const isImg = isImageFile(trimmedTarget);
      if (isImg) {
        const resolvedUrl = resolveMarkdownImageUrl(trimmedTarget, baseDir, settings);
        let sizeAttrs = '';
        let alt = trimmedTarget;

        if (option) {
          const trimmedOpt = option.trim();
          const dimensionMatch = trimmedOpt.match(/^(\d+)(?:x(\d+))?$/);
          if (dimensionMatch) {
            const width = dimensionMatch[1];
            const height = dimensionMatch[2];
            sizeAttrs = height ? ` width="${width}" height="${height}"` : ` width="${width}"`;
          } else {
            alt = trimmedOpt;
          }
        }

        return `<img src="${resolvedUrl}" alt="${alt}" class="markdown-preview-image" loading="lazy"${sizeAttrs} />`;
      }

      // 画像以外の埋め込み
      return `<div class="markdown-embed-card" data-target="${trimmedTarget}">📄 ${option || trimmedTarget}</div>`;
    }
  );

  // 4. 強調・ハイライト
  escaped = escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/==([^=]+)==/g, '<mark>$1</mark>');

  // 5. リンク構文: [label](url) を解析してプレースホルダー退避
  const linkPlaceholders: string[] = [];
  escaped = escaped.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_match, label, rawUrl) => {
      let url = rawUrl.replace(/^<([^>]+)>$/, '$1').replaceAll('&amp;', '&');

      // localhost や 127.0.0.1 のURLを設定ホスト名に置換
      if (settings?.serverHost && (url.includes('localhost') || url.includes('127.0.0.1'))) {
        url = url.replace(/localhost|127\.0\.0\.1/g, settings.serverHost);
      }

      const idx = linkPlaceholders.length;
      linkPlaceholders.push(`<a href="${url}">${label}</a>`);
      return `\u0000LINK_${idx}\u0000`;
    }
  );

  // 6. Wikilink構文: [[target|label]] または [[target]]
  escaped = escaped
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '<span class="markdown-wikilink" data-target="$1">$2</span>')
    .replace(/\[\[([^\]]+)\]\]/g, '<span class="markdown-wikilink" data-target="$1">$1</span>');

  // 7. 山括弧URL構文: <https://...>
  escaped = escaped.replace(
    /&lt;(https?:\/\/[^\s<>"'`]+)&gt;/g,
    (_match, rawUrl) => {
      let url = rawUrl.replaceAll('&amp;', '&');
      if (settings?.serverHost && (url.includes('localhost') || url.includes('127.0.0.1'))) {
        url = url.replace(/localhost|127\.0\.0\.1/g, settings.serverHost);
      }
      return `<a href="${url}">${rawUrl}</a>`;
    }
  );

  // 8. 生のURL自動リンク化 (Autolink)
  // HTMLタグ以外のテキスト内に出現する https?:// を検出
  escaped = escaped.replace(
    /(<[^>]+>)|(https?:\/\/[^\s<>"'`]+)/g,
    (match, tag, rawUrl) => {
      if (tag) return tag;
      if (rawUrl) {
        // 末尾の句読点・閉じ括弧（)や]、。、.など）を分離
        const puncMatch = rawUrl.match(/([)\]}.,;:!?。、！？）］｝]+)$/);
        let cleanUrl = rawUrl;
        let trailing = '';
        if (puncMatch) {
          trailing = puncMatch[1];
          cleanUrl = rawUrl.slice(0, -trailing.length);
        }

        let hrefUrl = cleanUrl.replaceAll('&amp;', '&');
        if (settings?.serverHost && (hrefUrl.includes('localhost') || hrefUrl.includes('127.0.0.1'))) {
          hrefUrl = hrefUrl.replace(/localhost|127\.0\.0\.1/g, settings.serverHost);
        }

        return `<a href="${hrefUrl}">${cleanUrl}</a>${trailing}`;
      }
      return match;
    }
  );

  // 9. プレースホルダーの復元
  escaped = escaped.replace(/\u0000LINK_(\d+)\u0000/g, (_m, idx) => linkPlaceholders[Number(idx)]);
  escaped = escaped.replace(/\u0000CODE_(\d+)\u0000/g, (_m, idx) => codePlaceholders[Number(idx)]);

  return escaped;
}

function renderInlineWithBreaks(text: string, baseDir?: string, settings?: AppSettings): string {
  return text
    .split('\n')
    .map((line) => renderInline(line, baseDir, settings))
    .join('<br />');
}

function renderCodeBlock(code: string, language = ''): string {
  const normalizedLang = language.trim().toLowerCase();
  if (normalizedLang === 'mermaid') {
    return `<div class="mermaid-container"><pre class="mermaid">${escapeHtml(code)}</pre></div>`;
  }
  const escapedLang = language ? escapeHtml(language) : '';
  const className = escapedLang ? ` language-${escapedLang}` : '';
  const dataAttr = escapedLang ? ` data-language="${escapedLang}"` : '';
  return `<pre class="markdown-code-block${className}"${dataAttr}><code>${escapeHtml(code)}</code></pre>`;
}

function renderList(
  lines: string[],
  baseDir?: string,
  settings?: AppSettings
): string {
  const getIndentLevel = (line: string) => {
    const match = line.match(/^(\s*)/);
    if (!match) return 0;
    return match[1].replace(/\t/g, '    ').length;
  };

  let html = '';
  const indentStack: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const rawIndent = getIndentLevel(line);

    let currentLevel = 0;
    if (indentStack.length > 0) {
      if (rawIndent > indentStack[indentStack.length - 1]) {
        currentLevel = indentStack.length;
      } else {
        while (indentStack.length > 0 && rawIndent < indentStack[indentStack.length - 1]) {
          indentStack.pop();
          html += '</ul></li>';
        }
        currentLevel = indentStack.length > 0 ? indentStack.length - 1 : 0;
      }
    }

    if (currentLevel > indentStack.length - 1) {
      indentStack.push(rawIndent);
      if (i === 0) {
        const hasTaskList = lines.some((l) => /^\s*[-*+]\s+\[( |x|X)\]\s+/.test(l));
        html += `<ul${hasTaskList ? ' class="contains-task-list"' : ''}>`;
      } else {
        html += '<ul>';
      }
    } else if (i === 0) {
      indentStack.push(rawIndent);
      const hasTaskList = lines.some((l) => /^\s*[-*+]\s+\[( |x|X)\]\s+/.test(l));
      html += `<ul${hasTaskList ? ' class="contains-task-list"' : ''}>`;
    }

    const taskMatch = line.match(/^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/);
    if (taskMatch) {
      const checked = taskMatch[1].toLowerCase() === 'x';
      html += `<li class="task-list-item"><label><input type="checkbox"${checked ? ' checked' : ''} disabled /><span>${renderInline(taskMatch[2], baseDir, settings)}</span></label>`;
    } else {
      const plainMatch = line.match(/^\s*[-*+]\s+(.*)$/);
      html += `<li>${renderInline(plainMatch ? plainMatch[1] : line.replace(/^\s*[-*+]\s+/, ''), baseDir, settings)}`;
    }

    const nextLine = i + 1 < lines.length ? lines[i + 1] : null;
    const nextIndent = nextLine !== null ? getIndentLevel(nextLine) : -1;
    if (nextIndent <= rawIndent) {
      html += '</li>';
    }
  }

  while (indentStack.length > 0) {
    indentStack.pop();
    html += '</ul>';
    if (indentStack.length > 0) html += '</li>';
  }

  return html;
}

function renderBlockquote(
  lines: string[],
  baseDir?: string,
  settings?: AppSettings
): string {
  const strippedLines = lines.map((line) => line.replace(/^>\s?/, ''));
  const calloutMatch = strippedLines[0]?.match(/^\[!([a-zA-Z0-9_-]+)\]\s*(.*)$/);

  if (calloutMatch) {
    const [, type, title] = calloutMatch;
    const bodyLines = strippedLines.slice(1);
    const bodyHtml =
      bodyLines.length > 0
        ? `<div class="markdown-callout-body">${bodyLines.map((line) => `<p>${renderInline(line, baseDir, settings)}</p>`).join('')}</div>`
        : '';
    return `<div class="markdown-callout markdown-callout-${escapeHtml(type.toLowerCase())}"><div class="markdown-callout-title">${renderInline(title || type, baseDir, settings)}</div>${bodyHtml}</div>`;
  }

  return `<blockquote>${strippedLines.map((line) => `<p>${renderInline(line, baseDir, settings)}</p>`).join('')}</blockquote>`;
}

/**
 * テーブルの1行をセルに分割する
 * インラインコード内のパイプ記号やエスケープされたパイプ（\|）を保護する
 */
function splitTableRow(line: string): string[] {
  let content = line.trim();
  if (content.startsWith('|')) {
    content = content.slice(1);
  }
  if (content.endsWith('|') && !content.endsWith('\\|')) {
    content = content.slice(0, -1);
  }

  const cells: string[] = [];
  let current = '';
  let inCode = false;
  let escaped = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      current += char;
      continue;
    }

    if (char === '`') {
      inCode = !inCode;
      current += char;
      continue;
    }

    if (char === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }
  cells.push(current.trim());
  return cells;
}

/**
 * 区切り行（例: | :--- | :---: | ---: |）を解析し、各列のアライメントを返す
 */
function parseTableDelimiter(line: string): Array<'left' | 'center' | 'right'> | null {
  const trimmed = line.trim();
  if (!trimmed.includes('-')) return null;
  const cells = splitTableRow(trimmed);
  if (cells.length === 0) return null;

  const alignments: Array<'left' | 'center' | 'right'> = [];

  for (const cell of cells) {
    const cleanCell = cell.replace(/\s+/g, '');
    if (!/^:?-+:?$/.test(cleanCell)) {
      return null;
    }
    const hasStartColon = cleanCell.startsWith(':');
    const hasEndColon = cleanCell.endsWith(':');

    if (hasStartColon && hasEndColon) {
      alignments.push('center');
    } else if (hasEndColon) {
      alignments.push('right');
    } else {
      alignments.push('left');
    }
  }

  return alignments;
}

/**
 * テーブルブロックをHTMLテーブルにレンダリングする
 */
function renderTable(
  tableLines: string[],
  baseDir?: string,
  settings?: AppSettings
): string {
  if (tableLines.length < 2) return '';

  const headerRow = splitTableRow(tableLines[0]);
  const alignments = parseTableDelimiter(tableLines[1]) || [];
  const colCount = Math.max(headerRow.length, alignments.length);

  let theadHtml = '<thead><tr>';
  for (let i = 0; i < colCount; i++) {
    const headerText = headerRow[i] ?? '';
    const align = alignments[i] || 'left';
    theadHtml += `<th style="text-align: ${align};">${renderInline(headerText, baseDir, settings)}</th>`;
  }
  theadHtml += '</tr></thead>';

  let tbodyHtml = '<tbody>';
  for (let r = 2; r < tableLines.length; r++) {
    const rowLine = tableLines[r].trim();
    if (!rowLine) continue;
    const cells = splitTableRow(rowLine);
    tbodyHtml += '<tr>';
    for (let c = 0; c < colCount; c++) {
      const cellText = cells[c] ?? '';
      const align = alignments[c] || 'left';
      tbodyHtml += `<td style="text-align: ${align};">${renderInline(cellText, baseDir, settings)}</td>`;
    }
    tbodyHtml += '</tr>';
  }
  tbodyHtml += '</tbody>';

  return `<div class="markdown-table-wrapper"><table class="markdown-table">${theadHtml}${tbodyHtml}</table></div>`;
}

/**
 * Markdown文字列をHTML文字列へレンダリングする
 */
export function renderMarkdownToHtml(
  markdown: string,
  options?: MarkdownPreviewOptions
): string {
  const baseDir = options?.baseDir;
  const settings = options?.settings;
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let index = 0;

  // Frontmatter（--- で囲まれたYAMLメタデータ）のスキップまたは表示
  if (lines[0]?.trim() === '---') {
    index += 1;
    const fmLines: string[] = [];
    while (index < lines.length && lines[index].trim() !== '---') {
      fmLines.push(lines[index]);
      index += 1;
    }
    if (index < lines.length) index += 1; // 閉じる --- をスキップ

    if (fmLines.length > 0) {
      html.push(
        `<div class="markdown-frontmatter"><details><summary>メタデータ (${fmLines.length}行)</summary><pre><code>${escapeHtml(fmLines.join('\n'))}</code></pre></details></div>`
      );
    }
  }

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    // コードブロック
    const codeFenceMatch = line.match(/^```([\w-]*)\s*$/);
    if (codeFenceMatch) {
      const language = codeFenceMatch[1] ?? '';
      const codeLines: string[] = [];
      index += 1;

      while (index < lines.length && !/^```/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }

      if (index < lines.length) {
        index += 1;
      }

      html.push(renderCodeBlock(codeLines.join('\n'), language));
      continue;
    }

    // 見出し
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      html.push(`<h${level}>${renderInline(headingMatch[2], baseDir, settings)}</h${level}>`);
      index += 1;
      continue;
    }

    // 水平線
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      html.push('<hr />');
      index += 1;
      continue;
    }

    // リスト
    if (/^\s*[-*+]\s+/.test(line)) {
      const listLines: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        listLines.push(lines[index]);
        index += 1;
      }
      html.push(renderList(listLines, baseDir, settings));
      continue;
    }

    // 引用・コールアウト
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index]);
        index += 1;
      }
      html.push(renderBlockquote(quoteLines, baseDir, settings));
      continue;
    }

    // テーブル
    if (
      index + 1 < lines.length &&
      line.includes('|') &&
      parseTableDelimiter(lines[index + 1]) !== null
    ) {
      const tableLines: string[] = [line, lines[index + 1]];
      index += 2;
      while (
        index < lines.length &&
        lines[index].trim() !== '' &&
        lines[index].includes('|') &&
        !/^```/.test(lines[index]) &&
        !/^(#{1,6})\s+/.test(lines[index])
      ) {
        tableLines.push(lines[index]);
        index += 1;
      }
      html.push(renderTable(tableLines, baseDir, settings));
      continue;
    }

    // 通常の段落
    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() !== '' &&
      !/^```/.test(lines[index]) &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !/^\s*[-*+]\s+/.test(lines[index]) &&
      !/^>\s?/.test(lines[index]) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[index].trim()) &&
      !(
        index + 1 < lines.length &&
        lines[index].includes('|') &&
        parseTableDelimiter(lines[index + 1]) !== null
      )
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }

    html.push(`<p>${renderInlineWithBreaks(paragraphLines.join('\n'), baseDir, settings)}</p>`);
  }

  return html.join('\n');
}
