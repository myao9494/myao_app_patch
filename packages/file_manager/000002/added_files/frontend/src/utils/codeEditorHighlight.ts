/**
 * VS Code風ファイルエディタ向けの軽量シンタックスハイライト処理
 * 依存追加なしで主要なテキスト/コード拡張子を色分け表示する
 */
import { findTextMatches, type TextMatch } from "./markdownSearch";


export type EditorLanguage =
  | "plaintext"
  | "markdown"
  | "javascript"
  | "jsx"
  | "typescript"
  | "tsx"
  | "python"
  | "json"
  | "shell"
  | "batch"
  | "powershell"
  | "css"
  | "html"
  | "xml"
  | "yaml"
  | "toml"
  | "ini"
  | "sql"
  | "dotenv";

type TokenType =
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "property"
  | "tag"
  | "decorator"
  | "function"
  | "class"
  | "builtin"
  | "variable";

type TokenRule = {
  pattern: RegExp;
  type: TokenType;
};


const LANGUAGE_BY_EXTENSION: Record<string, EditorLanguage> = {
  ".md": "markdown",
  ".txt": "plaintext",
  ".log": "plaintext",
  ".text": "plaintext",
  ".json": "json",
  ".jsonc": "json",
  ".js": "javascript",
  ".jsx": "jsx",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
  ".pyw": "python",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".command": "shell",
  ".bat": "batch",
  ".cmd": "batch",
  ".ps1": "powershell",
  ".css": "css",
  ".scss": "css",
  ".html": "html",
  ".htm": "html",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".ini": "ini",
  ".cfg": "ini",
  ".conf": "ini",
  ".sql": "sql",
  ".csv": "plaintext",
};

const LANGUAGE_BY_FILENAME: Record<string, EditorLanguage> = {
  dockerfile: "plaintext",
  makefile: "plaintext",
};

function resolveKnownEditorLanguage(fileName: string): EditorLanguage | null {
  const lowerName = fileName.toLowerCase();
  if (lowerName in LANGUAGE_BY_FILENAME) {
    return LANGUAGE_BY_FILENAME[lowerName];
  }
  if (lowerName.startsWith(".env")) {
    return "dotenv";
  }

  const dotIndex = lowerName.lastIndexOf(".");
  if (dotIndex < 0) {
    return null;
  }

  return LANGUAGE_BY_EXTENSION[lowerName.slice(dotIndex)] ?? null;
}

const KEYWORD_RULES: Record<string, TokenRule[]> = {
  javascript: [
    { pattern: /\/\*[\s\S]*?\*\//g, type: "comment" },
    { pattern: /\/\/.*/g, type: "comment" },
    { pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, type: "string" },
    { pattern: /(?<=\bclass\s+)[A-Za-z_]\w*/g, type: "class" },
    { pattern: /(?<=\bfunction\s+)[A-Za-z_]\w*/g, type: "function" },
    { pattern: /\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|new|class|extends|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|this|super|true|false|null|undefined)\b/g, type: "keyword" },
    { pattern: /\b(?:console|Math|JSON|Promise|Array|Object|String|Number|Boolean|Date|RegExp|Map|Set|Error)\b/g, type: "builtin" },
    { pattern: /\b[A-Za-z_]\w*(?=\s*\()/g, type: "function" },
    { pattern: /\b\d+(?:\.\d+)?\b/g, type: "number" },
  ],
  jsx: [
    { pattern: /\/\*[\s\S]*?\*\//g, type: "comment" },
    { pattern: /\/\/.*/g, type: "comment" },
    { pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, type: "string" },
    { pattern: /<\/?[A-Za-z][^>]*>/g, type: "tag" },
    { pattern: /(?<=\bclass\s+)[A-Za-z_]\w*/g, type: "class" },
    { pattern: /(?<=\bfunction\s+)[A-Za-z_]\w*/g, type: "function" },
    { pattern: /\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|new|class|extends|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|this|super|true|false|null|undefined)\b/g, type: "keyword" },
    { pattern: /\b(?:console|Math|JSON|Promise|Array|Object|String|Number|Boolean|Date|RegExp|Map|Set|Error)\b/g, type: "builtin" },
    { pattern: /\b[A-Za-z_]\w*(?=\s*\()/g, type: "function" },
    { pattern: /\b\d+(?:\.\d+)?\b/g, type: "number" },
  ],
  typescript: [
    { pattern: /\/\*[\s\S]*?\*\//g, type: "comment" },
    { pattern: /\/\/.*/g, type: "comment" },
    { pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, type: "string" },
    { pattern: /(?<=\b(?:class|interface|type|enum)\s+)[A-Za-z_]\w*/g, type: "class" },
    { pattern: /(?<=\bfunction\s+)[A-Za-z_]\w*/g, type: "function" },
    { pattern: /\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|new|class|extends|implements|interface|type|enum|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|this|super|public|private|protected|readonly|as|satisfies|true|false|null|undefined)\b/g, type: "keyword" },
    { pattern: /\b(?:console|Math|JSON|Promise|Array|Object|String|Number|Boolean|Date|RegExp|Map|Set|Error)\b/g, type: "builtin" },
    { pattern: /\b[A-Za-z_]\w*(?=\s*\()/g, type: "function" },
    { pattern: /\b\d+(?:\.\d+)?\b/g, type: "number" },
  ],
  tsx: [
    { pattern: /\/\*[\s\S]*?\*\//g, type: "comment" },
    { pattern: /\/\/.*/g, type: "comment" },
    { pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, type: "string" },
    { pattern: /<\/?[A-Za-z][^>]*>/g, type: "tag" },
    { pattern: /(?<=\b(?:class|interface|type|enum)\s+)[A-Za-z_]\w*/g, type: "class" },
    { pattern: /(?<=\bfunction\s+)[A-Za-z_]\w*/g, type: "function" },
    { pattern: /\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|new|class|extends|implements|interface|type|enum|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|this|super|public|private|protected|readonly|as|satisfies|true|false|null|undefined)\b/g, type: "keyword" },
    { pattern: /\b(?:console|Math|JSON|Promise|Array|Object|String|Number|Boolean|Date|RegExp|Map|Set|Error)\b/g, type: "builtin" },
    { pattern: /\b[A-Za-z_]\w*(?=\s*\()/g, type: "function" },
    { pattern: /\b\d+(?:\.\d+)?\b/g, type: "number" },
  ],
  python: [
    { pattern: /(?:[frbFRB]{0,2})("""[\s\S]*?"""|'''[\s\S]*?''')/g, type: "string" },
    { pattern: /#.*/g, type: "comment" },
    { pattern: /(?:[frbFRB]{1,2})?(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g, type: "string" },
    { pattern: /@[\w.]+/g, type: "decorator" },
    { pattern: /(?<=\bclass\s+)[A-Za-z_]\w*/g, type: "class" },
    { pattern: /(?<=\bdef\s+)[A-Za-z_]\w*/g, type: "function" },
    { pattern: /\b(?:def|class|return|if|elif|else|for|while|break|continue|import|from|as|try|except|finally|raise|with|lambda|yield|async|await|pass|global|nonlocal|True|False|None|and|or|not|in|is)\b/g, type: "keyword" },
    { pattern: /\b(?:self|cls)\b/g, type: "variable" },
    { pattern: /\b(?:print|len|range|enumerate|zip|map|filter|sum|min|max|abs|round|all|any|isinstance|issubclass|type|id|hash|repr|ascii|bin|oct|hex|chr|ord|dir|vars|hasattr|getattr|setattr|delattr|callable|iter|next|open|super|int|float|str|bool|list|dict|set|tuple|bytes|bytearray|memoryview|complex|slice|object)\b/g, type: "builtin" },
    { pattern: /\b[A-Za-z_]\w*(?=\s*\()/g, type: "function" },
    { pattern: /\b0[xX][0-9a-fA-F]+\b|\b0[bB][01]+\b|\b0[oO][0-7]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, type: "number" },
  ],

  json: [
    { pattern: /"(?:\\.|[^"\\])*"(?=\s*:)/g, type: "property" },
    { pattern: /"(?:\\.|[^"\\])*"/g, type: "string" },
    { pattern: /\b(?:true|false|null)\b/g, type: "keyword" },
    { pattern: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, type: "number" },
  ],
  shell: [
    { pattern: /#.*/g, type: "comment" },
    { pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, type: "string" },
    { pattern: /\b(?:if|then|else|fi|for|do|done|case|esac|function|in|export|local|readonly|return|break|continue)\b/g, type: "keyword" },
    { pattern: /\b\d+(?:\.\d+)?\b/g, type: "number" },
  ],
  batch: [
    { pattern: /\b(?:REM|rem).*/g, type: "comment" },
    { pattern: /"(?:\\.|[^"\\])*"/g, type: "string" },
    { pattern: /\b(?:echo|set|if|else|for|in|do|goto|call|exit|pause)\b/g, type: "keyword" },
    { pattern: /\b\d+(?:\.\d+)?\b/g, type: "number" },
  ],
  powershell: [
    { pattern: /#.*/g, type: "comment" },
    { pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, type: "string" },
    { pattern: /\b(?:param|function|if|else|foreach|for|while|switch|return|try|catch|finally|throw|class)\b/g, type: "keyword" },
    { pattern: /\b\d+(?:\.\d+)?\b/g, type: "number" },
  ],
  css: [
    { pattern: /\/\*.*?\*\//g, type: "comment" },
    { pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, type: "string" },
    { pattern: /(?<=^|\s|{|;)(?:color|background|display|position|grid|flex|padding|margin|border|font|line-height|width|height|overflow|transform|transition|animation)(?=\s*:)/g, type: "property" },
    { pattern: /-?\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms)?\b/g, type: "number" },
  ],
  html: [
    { pattern: /<!--.*?-->/g, type: "comment" },
    { pattern: /<\/?[A-Za-z][^>]*>/g, type: "tag" },
    { pattern: /"(?:\\.|[^"\\])*"/g, type: "string" },
  ],
  xml: [
    { pattern: /<!--.*?-->/g, type: "comment" },
    { pattern: /<\/?[A-Za-z][^>]*>/g, type: "tag" },
    { pattern: /"(?:\\.|[^"\\])*"/g, type: "string" },
  ],
  yaml: [
    { pattern: /#.*/g, type: "comment" },
    { pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, type: "string" },
    { pattern: /^[\w.-]+(?=\s*:)/gm, type: "property" },
    { pattern: /\b(?:true|false|null|yes|no|on|off)\b/g, type: "keyword" },
    { pattern: /-?\b\d+(?:\.\d+)?\b/g, type: "number" },
  ],
  toml: [
    { pattern: /#.*/g, type: "comment" },
    { pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, type: "string" },
    { pattern: /^[\w.-]+(?=\s*=)/gm, type: "property" },
    { pattern: /\b(?:true|false)\b/g, type: "keyword" },
    { pattern: /-?\b\d+(?:\.\d+)?\b/g, type: "number" },
  ],
  ini: [
    { pattern: /[;#].*/g, type: "comment" },
    { pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, type: "string" },
    { pattern: /^[\w.-]+(?=\s*=)/gm, type: "property" },
    { pattern: /\b(?:true|false|on|off|yes|no)\b/g, type: "keyword" },
    { pattern: /-?\b\d+(?:\.\d+)?\b/g, type: "number" },
  ],
  sql: [
    { pattern: /--.*/g, type: "comment" },
    { pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, type: "string" },
    { pattern: /\b(?:SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|AS|AND|OR|NOT|NULL|VALUES|INTO|SET)\b/gi, type: "keyword" },
    { pattern: /-?\b\d+(?:\.\d+)?\b/g, type: "number" },
  ],
  dotenv: [
    { pattern: /#.*/g, type: "comment" },
    { pattern: /^[A-Z0-9_]+(?==)/gm, type: "property" },
    { pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, type: "string" },
  ],
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function detectEditorLanguage(fileName: string): EditorLanguage {
  return resolveKnownEditorLanguage(fileName) ?? "plaintext";
}

export function isWebFileEditorTarget(fileName: string): boolean {
  const language = resolveKnownEditorLanguage(fileName);
  return language !== null && language !== "markdown";
}

function tokenizeText(code: string, rules: TokenRule[]): Array<{ text: string; type?: TokenType }> {
  const tokens: Array<{ text: string; type?: TokenType }> = [];
  let cursor = 0;

  while (cursor < code.length) {
    let nextMatch: { index: number; text: string; type: TokenType } | null = null;

    for (const rule of rules) {
      rule.pattern.lastIndex = cursor;
      const match = rule.pattern.exec(code);
      if (!match || match.index < cursor) {
        continue;
      }

      const candidate = { index: match.index, text: match[0], type: rule.type };
      if (
        !nextMatch
        || candidate.index < nextMatch.index
        || (candidate.index === nextMatch.index && candidate.text.length > nextMatch.text.length)
      ) {
        nextMatch = candidate;
      }
    }

    if (!nextMatch) {
      tokens.push({ text: code.slice(cursor) });
      break;
    }

    if (nextMatch.index > cursor) {
      tokens.push({ text: code.slice(cursor, nextMatch.index) });
    }

    tokens.push({ text: nextMatch.text, type: nextMatch.type });
    cursor = nextMatch.index + nextMatch.text.length;
  }

  return tokens;
}

export interface CodeSearchOptions {
  query?: string;
  activeIndex?: number;
  isRegex?: boolean;
}

function renderTokenHtml(text: string, type?: TokenType): string {
  const escaped = escapeHtml(text);
  if (!type) {
    return escaped;
  }
  return `<span class="code-editor-token ${type}">${escaped}</span>`;
}

function renderTokenWithSearchHighlights(
  tokenText: string,
  tokenStart: number,
  tokenType: TokenType | undefined,
  matches: TextMatch[],
  activeIndex: number
): string {
  const tokenEnd = tokenStart + tokenText.length;
  const overlappingMatches: Array<{ start: number; end: number; isActive: boolean }> = [];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (m.end <= tokenStart || m.start >= tokenEnd) {
      continue;
    }
    overlappingMatches.push({
      start: Math.max(tokenStart, m.start) - tokenStart,
      end: Math.min(tokenEnd, m.end) - tokenStart,
      isActive: i === activeIndex,
    });
  }

  if (overlappingMatches.length === 0) {
    return renderTokenHtml(tokenText, tokenType);
  }

  let html = "";
  let lastPos = 0;

  for (const m of overlappingMatches) {
    if (m.start > lastPos) {
      const part = tokenText.slice(lastPos, m.start);
      html += renderTokenHtml(part, tokenType);
    }
    const matchedPart = tokenText.slice(m.start, m.end);
    const escaped = escapeHtml(matchedPart);
    const activeClass = m.isActive ? " active" : "";
    const inner = tokenType ? `<span class="code-editor-token ${tokenType}">${escaped}</span>` : escaped;
    html += `<mark class="md-search-highlight${activeClass}">${inner}</mark>`;
    lastPos = m.end;
  }

  if (lastPos < tokenText.length) {
    const rest = tokenText.slice(lastPos);
    html += renderTokenHtml(rest, tokenType);
  }

  return html;
}

export function renderCodeToHighlightedHtml(
  code: string,
  language: EditorLanguage,
  searchOptions?: CodeSearchOptions
): string {
  const rules = KEYWORD_RULES[language] ?? [];
  const query = searchOptions?.query?.trim() || "";
  const matches = query ? findTextMatches(code, query, searchOptions?.isRegex ?? false) : [];
  const activeIndex = searchOptions?.activeIndex ?? 0;

  if (rules.length === 0) {
    if (matches.length === 0) {
      return escapeHtml(code);
    }
    return renderTokenWithSearchHighlights(code, 0, undefined, matches, activeIndex);
  }

  const tokens = tokenizeText(code, rules);

  if (matches.length === 0) {
    return tokens
      .map((token) => renderTokenHtml(token.text, token.type))
      .join("");
  }

  let cursor = 0;
  let resultHtml = "";
  for (const token of tokens) {
    resultHtml += renderTokenWithSearchHighlights(
      token.text,
      cursor,
      token.type,
      matches,
      activeIndex
    );
    cursor += token.text.length;
  }

  return resultHtml;
}


