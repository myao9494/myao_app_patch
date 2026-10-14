// =============================================================================
// 引用ショートカット（Cmd+. / Ctrl+.）
// =============================================================================

// 複数行のテキストの引用（> ）を切り替える。
// 全行が引用済み（空行は除く）なら引用を外し、そうでなければ全行の先頭に "> " を付ける。
const toggleBlockquoteLines = (text) => {
    const lines = text.split("\n");
    const allQuoted = lines.every(line => line.startsWith(">") || line === "");

    if (allQuoted) {
        return lines.map(line => {
            if (line.startsWith("> ")) {
                return line.substring(2);
            } else if (line.startsWith(">")) {
                return line.substring(1);
            }
            return line;
        }).join("\n");
    }
    return lines.map(line => "> " + line).join("\n");
};

// Setup Global Key Listener for Blockquote Toggle (Cmd+. on Mac, Ctrl+. on others)
const handleQuoteShortcutKey = (e) => {
    if (e.key !== ".") return;
    
    const isMac = navigator.userAgent.indexOf("Mac") !== -1 || (navigator.platform && navigator.platform.indexOf("Mac") !== -1);
    const hasModifier = isMac ? e.metaKey : e.ctrlKey;
    const noOtherModifiers = !e.shiftKey && !e.altKey && (isMac ? !e.ctrlKey : !e.metaKey);
    
    if (!hasModifier || !noOtherModifiers) return;

    const activeEl = document.activeElement;
    if (!activeEl) return;
    const isMarkdownEditor = activeEl.classList.contains("cm-content") || activeEl.tagName === "TEXTAREA";
    if (!isMarkdownEditor) return;
    
    if (activeEl.closest(".modal, .prompt")) return;

    const obsidianLib = getObsidianModule();
    if (!obsidianLib) return;

    const activeView = app.workspace.getActiveViewOfType(obsidianLib.MarkdownView);
    if (!activeView) return;

    const editor = activeView.editor;
    e.preventDefault();
    e.stopPropagation();

    const selection = editor.getSelection();
    if (selection) {
        editor.replaceSelection(toggleBlockquoteLines(selection));
    } else {
        const cursor = editor.getCursor();
        const lineText = editor.getLine(cursor.line);
        if (lineText.startsWith(">")) {
            if (lineText.startsWith("> ")) {
                editor.setLine(cursor.line, lineText.substring(2));
                editor.setCursor({ line: cursor.line, ch: Math.max(0, cursor.ch - 2) });
            } else {
                editor.setLine(cursor.line, lineText.substring(1));
                editor.setCursor({ line: cursor.line, ch: Math.max(0, cursor.ch - 1) });
            }
        } else {
            editor.setLine(cursor.line, "> " + lineText);
            editor.setCursor({ line: cursor.line, ch: cursor.ch + 2 });
        }
    }
};

registerDocumentListener("_customQuoteShortcutListener", "keydown", handleQuoteShortcutKey);
console.log("Global Blockquote shortcut registered (Cmd+. on Mac, Ctrl+. on others)");
