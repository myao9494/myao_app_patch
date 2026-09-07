/**
 * Markdownエディタモーダル
 * Obsidian風の編集体験を意識した自前実装のMarkdownエディタを提供する
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
    ChevronDown,
    ChevronUp,
    Search,
    X,
} from "lucide-react";
import { Modal } from "./Modal";
import { matchesCmdOrCtrlShortcut } from "../utils/globalShortcuts";
import {
    adjustHeadingLevel,
    insertMarkdownNewline,
    indentSelection,
    outdentSelection,
    setTaskListItemChecked,
    wrapSelection,
    type TextSelectionTransformResult,
} from "../utils/markdownEditorFormatting";
import { toggleBulletListSelection } from "../utils/markdownBulletShortcuts";
import { toggleChecklistSelection } from "../utils/markdownEditorShortcuts";
import { renderMarkdownToHtml } from "../utils/markdownPreview";
import { findTextMatches, getNextMatchIndex, highlightHtmlText, type TextMatch } from "../utils/markdownSearch";
import { getParentDirectory } from "../utils/pathUtils";
import "./MarkdownEditorModal.css";

interface MarkdownEditorModalProps {
    /** モーダルの表示/非表示 */
    isOpen: boolean;
    /** 閉じるコールバック */
    onClose: () => void;
    /** 保存コールバック（contentを渡す） */
    onSave: (content: string) => void;
    /** 初期内容 */
    initialContent?: string;
    /** ファイル名（タイトル表示用） */
    fileName: string;
    /** ファイルのフルパス（相対パス解決・画像プレビュー用） */
    filePath?: string | null;
    /** 現在のディレクトリパス（新規ファイル作成時等の相対パス解決用） */
    currentDirectory?: string | null;
    /** 保存中フラグ */
    isSaving?: boolean;
}

type EditorMode = "split" | "edit" | "preview";

export function MarkdownEditorModal({
    isOpen,
    onClose,
    onSave,
    initialContent = "",
    fileName,
    filePath,
    currentDirectory,
    isSaving = false,
}: MarkdownEditorModalProps) {
    const [content, setContent] = useState(initialContent);
    const [hasChanges, setHasChanges] = useState(false);
    const [mode, setMode] = useState<EditorMode>("split");
    const [searchQuery, setSearchQuery] = useState("");
    const [isRegex, setIsRegex] = useState(false);
    const [searchIndex, setSearchIndex] = useState(0);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    const effectiveBaseDir = useMemo(() => {
        if (filePath) {
            return getParentDirectory(filePath);
        }
        return currentDirectory || "";
    }, [filePath, currentDirectory]);

    const previewRef = useRef<HTMLDivElement | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const pendingSelectionRef = useRef<{ start: number; end: number } | null>(null);
    const deferredContent = useDeferredValue(content);

    const updateContent = useCallback((nextContent: string) => {
        setContent(nextContent);
        setHasChanges(nextContent !== initialContent);
    }, [initialContent]);

    useEffect(() => {
        if (!isOpen) {
            return;
        }

        setContent(initialContent);
        setHasChanges(false);
        setSearchQuery("");
        setSearchIndex(0);
        pendingSelectionRef.current = null;

        const timerId = window.setTimeout(() => {
            textareaRef.current?.focus();
        }, 60);

        return () => window.clearTimeout(timerId);
    }, [initialContent, isOpen]);

    useEffect(() => {
        if (!isOpen || !pendingSelectionRef.current) {
            return;
        }

        const selection = pendingSelectionRef.current;
        const frameId = window.requestAnimationFrame(() => {
            const textarea = textareaRef.current;
            if (!textarea) {
                return;
            }

            textarea.focus();
            textarea.setSelectionRange(selection.start, selection.end);
            pendingSelectionRef.current = null;
        });

        return () => window.cancelAnimationFrame(frameId);
    }, [content, isOpen]);

    useEffect(() => {
        if (!isOpen) {
            return;
        }

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key !== "Escape") {
                return;
            }

            // 検索入力欄にフォーカスがある場合は検索文字をクリアしてエディタに復帰し、モーダルは閉じない
            if (document.activeElement === searchInputRef.current) {
                e.preventDefault();
                e.stopPropagation();
                setSearchQuery("");
                textareaRef.current?.focus();
                return;
            }

            e.preventDefault();
            e.stopPropagation();

            if (hasChanges) {
                if (window.confirm("変更を破棄しますか？")) {
                    setHasChanges(false);
                    onClose();
                }
                return;
            }

            onClose();
        };

        document.addEventListener("keydown", handleKeyDown, true);
        return () => document.removeEventListener("keydown", handleKeyDown, true);
    }, [hasChanges, isOpen, onClose]);

    const applySelectionTransform = useCallback((
        transform: (text: string, selectionStart: number, selectionEnd: number) => TextSelectionTransformResult
    ) => {
        const textarea = textareaRef.current;
        if (!textarea) {
            return;
        }

        const result = transform(content, textarea.selectionStart, textarea.selectionEnd);
        pendingSelectionRef.current = {
            start: result.selectionStart,
            end: result.selectionEnd,
        };
        updateContent(result.text);
    }, [content, updateContent]);

    const stopNativeShortcut = useCallback((event: KeyboardEvent) => {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") {
            event.stopImmediatePropagation();
        }
    }, []);

    // Cmd/Ctrl + Shift + [ ] による見出しレベルの変更判定
    const isHeadingShortcut = useCallback((event: KeyboardEvent | React.KeyboardEvent<HTMLTextAreaElement>, direction: "up" | "down") => {
        const nativeEvent = "nativeEvent" in event ? event.nativeEvent : event;
        if ((!nativeEvent.metaKey && !nativeEvent.ctrlKey) || !nativeEvent.shiftKey || nativeEvent.altKey) {
            return false;
        }

        const key = nativeEvent.key.toLowerCase();
        
        // event.codeはUS配列の物理キー位置を返すため、JIS配列だと BracketRight が '[' キーになる等
        // 判定が混線する原因となります。そのため、入力された文字(event.key)のみで判定します。
        if (direction === "up") { // 見出しを下げる（#を増やす） / 右ブラケット系
            return key === "]" || key === "}" || key === "」" || key === "』";
        }
        
        // 見出しを上げる（#を減らす） / 左ブラケット系
        return key === "[" || key === "{" || key === "「" || key === "『";
    }, []);

    const isBulletShortcut = useCallback((event: KeyboardEvent | React.KeyboardEvent<HTMLTextAreaElement>) => {
        const nativeEvent = "nativeEvent" in event ? event.nativeEvent : event;
        if ((!nativeEvent.metaKey && !nativeEvent.ctrlKey) || nativeEvent.altKey) {
            return false;
        }

        return nativeEvent.key === ":" || (nativeEvent.shiftKey && (nativeEvent.key === ";" || nativeEvent.code === "Semicolon"));
    }, []);

    const handleSave = useCallback(() => {
        onSave(content);
    }, [content, onSave]);

    const handlePreviewCheckboxToggle = useCallback((target: HTMLInputElement) => {
        const lineNumber = Number(target.dataset.taskLine);
        if (Number.isNaN(lineNumber)) {
            return;
        }

        const result = setTaskListItemChecked(content, lineNumber, target.checked);
        updateContent(result.text);
    }, [content, updateContent]);

    const handleClose = useCallback(() => {
        if (!hasChanges) {
            onClose();
            return;
        }

        if (window.confirm("変更を破棄しますか？")) {
            setHasChanges(false);
            onClose();
        }
    }, [hasChanges, onClose]);

    useEffect(() => {
        if (!isOpen) {
            return;
        }

        // windowのキャプチャフェーズのみで処理する（textareaへの重複登録はしない）
        const handleDocumentKeyDown = (event: KeyboardEvent) => {
            // Cmd/Ctrl + F はフォーカス位置を問わず検索ボックスにフォーカス
            if (matchesCmdOrCtrlShortcut(event, "f")) {
                stopNativeShortcut(event);
                searchInputRef.current?.focus();
                searchInputRef.current?.select();
                return;
            }

            const textarea = textareaRef.current;
            if (!textarea) {
                return;
            }

            const activeElement = document.activeElement;
            if (activeElement !== textarea) {
                return;
            }

            if (matchesCmdOrCtrlShortcut(event, "l")) {
                stopNativeShortcut(event);
                applySelectionTransform(toggleChecklistSelection);
                return;
            }

            if (matchesCmdOrCtrlShortcut(event, "b")) {
                stopNativeShortcut(event);
                applySelectionTransform((text, start, end) => wrapSelection(text, start, end, "**", "**"));
                return;
            }

            if (matchesCmdOrCtrlShortcut(event, "i")) {
                stopNativeShortcut(event);
                applySelectionTransform((text, start, end) => wrapSelection(text, start, end, "*", "*"));
                return;
            }

            if (matchesCmdOrCtrlShortcut(event, "k")) {
                stopNativeShortcut(event);
                applySelectionTransform((text, start, end) => wrapSelection(text, start, end, "[", "](url)", "text"));
                return;
            }

            if (matchesCmdOrCtrlShortcut(event, "s")) {
                stopNativeShortcut(event);
                handleSave();
                return;
            }

            if (isBulletShortcut(event)) {
                stopNativeShortcut(event);
                applySelectionTransform(toggleBulletListSelection);
                return;
            }

            if (isHeadingShortcut(event, "up")) {
                if (event.repeat) return;
                stopNativeShortcut(event);
                applySelectionTransform((text, start, end) => adjustHeadingLevel(text, start, end, 1));
                return;
            }

            if (isHeadingShortcut(event, "down")) {
                if (event.repeat) return;
                stopNativeShortcut(event);
                applySelectionTransform((text, start, end) => adjustHeadingLevel(text, start, end, -1));
                return;
            }

            // Tabキーはtextareaにフォーカスがある時のみ処理
            if (event.key === "Tab" && activeElement === textarea) {
                stopNativeShortcut(event);
                applySelectionTransform((text, start, end) => (
                    event.shiftKey ? outdentSelection(text, start, end) : indentSelection(text, start, end)
                ));
                return;
            }

            if (event.key === "Enter" && !event.isComposing && activeElement === textarea) {
                stopNativeShortcut(event);
                applySelectionTransform(insertMarkdownNewline);
            }
        };

        window.addEventListener("keydown", handleDocumentKeyDown, true);

        return () => {
            window.removeEventListener("keydown", handleDocumentKeyDown, true);
        };
    }, [applySelectionTransform, handleSave, isBulletShortcut, isHeadingShortcut, isOpen, stopNativeShortcut]);

    useEffect(() => {
        if (!isOpen) {
            return;
        }

        const preview = previewRef.current;
        if (!preview) {
            return;
        }

        const handlePreviewChange = (event: Event) => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") {
                return;
            }

            handlePreviewCheckboxToggle(target);
        };

        preview.addEventListener("change", handlePreviewChange, true);
        return () => preview.removeEventListener("change", handlePreviewChange, true);
    }, [handlePreviewCheckboxToggle, isOpen]);

    const editorMatches = useMemo(() => {
        return findTextMatches(content, searchQuery, isRegex);
    }, [content, searchQuery, isRegex]);

    const { highlightedHtml, totalMatches: previewMatchCount } = useMemo(() => {
        const baseHtml = renderMarkdownToHtml(deferredContent, { baseDir: effectiveBaseDir });
        if (!searchQuery.trim()) {
            return { highlightedHtml: baseHtml, totalMatches: 0 };
        }
        return highlightHtmlText(baseHtml, searchQuery, searchIndex, isRegex);
    }, [deferredContent, searchQuery, searchIndex, isRegex, effectiveBaseDir]);


    const effectiveTotalMatches = mode === "preview" ? previewMatchCount : editorMatches.length;

    const scrollToMatch = useCallback((targetIndex: number, matches: TextMatch[]) => {
        if (targetIndex < 0 || targetIndex >= matches.length) {
            return;
        }

        const match = matches[targetIndex];

        // エディタ側 (textarea) の選択とスクロール
        const textarea = textareaRef.current;
        if (textarea && mode !== "preview") {
            textarea.setSelectionRange(match.start, match.end);

            // 該当位置が見えるようにスクロール
            const textBeforeMatch = content.slice(0, match.start);
            const lineIndex = textBeforeMatch.split("\n").length - 1;
            const totalLines = Math.max(1, content.split("\n").length);
            const scrollRatio = lineIndex / totalLines;
            const targetScrollTop = scrollRatio * (textarea.scrollHeight - textarea.clientHeight);
            textarea.scrollTo({ top: targetScrollTop, behavior: "smooth" });
        }

        // プレビュー側 (previewRef) のスクロール
        if (mode !== "edit") {
            requestAnimationFrame(() => {
                const activeEl = previewRef.current?.querySelector(`.md-search-highlight[data-match-index="${targetIndex}"]`);
                activeEl?.scrollIntoView({ block: "center", behavior: "smooth" });
            });
        }
    }, [content, mode]);

    const handleNavigateMatch = useCallback((direction: "next" | "prev") => {
        if (effectiveTotalMatches <= 0) return;
        const nextIdx = getNextMatchIndex(searchIndex, effectiveTotalMatches, direction);
        setSearchIndex(nextIdx);
        scrollToMatch(nextIdx, editorMatches);
    }, [effectiveTotalMatches, searchIndex, editorMatches, scrollToMatch]);

    // 検索クエリや正規表現モードが変更された時に先頭へ移動
    useEffect(() => {
        if (searchQuery.trim() && editorMatches.length > 0) {
            setSearchIndex(0);
            scrollToMatch(0, editorMatches);
        } else {
            setSearchIndex(0);
        }
    }, [searchQuery, isRegex]);

    const handleSearchInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setSearchQuery("");
            textareaRef.current?.focus();
        } else if (e.key === "Enter") {
            e.preventDefault();
            handleNavigateMatch(e.shiftKey ? "prev" : "next");
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            handleNavigateMatch("next");
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            handleNavigateMatch("prev");
        }
    }, [handleNavigateMatch]);

    const lineCount = useMemo(() => {
        return content === "" ? 1 : content.split("\n").length;
    }, [content]);

    const headerTitle = (
        <div className="md-modal-header-row">
            <span className="md-modal-title-text" title={`Markdown編集: ${fileName}`}>
                Markdown編集: {fileName}
            </span>

            {/* 検索バー */}
            <div className="md-header-search">
                <Search size={13} className="search-icon" />
                <input
                    ref={searchInputRef}
                    type="text"
                    placeholder={isRegex ? "正規表現... (Cmd/Ctrl+F)" : "検索... (Cmd/Ctrl+F)"}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={handleSearchInputKeyDown}
                />
                {searchQuery && (
                    <button
                        type="button"
                        className="search-clear-btn"
                        onClick={() => {
                            setSearchQuery("");
                            searchInputRef.current?.focus();
                        }}
                        title="検索をクリア (Esc)"
                    >
                        <X size={12} />
                    </button>
                )}
                {searchQuery.trim() && (
                    <span
                        className="search-count-badge"
                        title="現在ヒット位置 / 総ヒット件数 (Enter: 次へ / Shift+Enter: 前へ)"
                    >
                        {effectiveTotalMatches > 0 ? `${searchIndex + 1}/${effectiveTotalMatches}` : "0/0"}
                    </span>
                )}
                <button
                    type="button"
                    className="search-nav-btn"
                    onClick={() => handleNavigateMatch("prev")}
                    disabled={effectiveTotalMatches <= 0}
                    title="前のヒット (Shift+Enter / ↑)"
                >
                    <ChevronUp size={13} />
                </button>
                <button
                    type="button"
                    className="search-nav-btn"
                    onClick={() => handleNavigateMatch("next")}
                    disabled={effectiveTotalMatches <= 0}
                    title="次のヒット (Enter / ↓)"
                >
                    <ChevronDown size={13} />
                </button>
                <button
                    type="button"
                    className={`regex-toggle ${isRegex ? "active" : ""}`}
                    onClick={() => setIsRegex(!isRegex)}
                    title="正規表現 (Regex)"
                >
                    .*
                </button>
            </div>

            {/* モード切替 */}
            <div className="md-header-modes" role="tablist" aria-label="editor mode">
                <button className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")} type="button">
                    Edit
                </button>
                <button className={mode === "split" ? "active" : ""} onClick={() => setMode("split")} type="button">
                    Split
                </button>
                <button className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")} type="button">
                    Preview
                </button>
            </div>

            {/* ステータス情報 */}
            <div className="md-header-status">
                <span className="md-header-lines">{lineCount}行</span>
                <span className={`md-header-save-state ${hasChanges ? "unsaved" : "saved"}`}>
                    {hasChanges ? "未保存" : "保存済"}
                </span>
            </div>

            {/* 保存・キャンセル */}
            <div className="md-header-actions">
                <button
                    type="button"
                    className="btn-header-secondary"
                    onClick={handleClose}
                    disabled={isSaving}
                >
                    キャンセル
                </button>
                <button
                    type="button"
                    className="btn-header-primary"
                    onClick={handleSave}
                    disabled={isSaving}
                    title="保存 (Cmd/Ctrl+S)"
                >
                    {isSaving ? "保存中..." : "保存"}
                </button>
            </div>
        </div>
    );

    return (
        <Modal
            isOpen={isOpen}
            onClose={handleClose}
            title={headerTitle}
            width="95vw"
            height="92vh"
        >
            <div className="markdown-editor-shell">
                <div className={`markdown-editor-workspace mode-${mode}`}>
                    {mode !== "preview" && (
                        <section className="markdown-editor-pane markdown-editor-input-pane">
                            <textarea
                                ref={textareaRef}
                                className="markdown-editor-textarea"
                                value={content}
                                onChange={(e) => updateContent(e.target.value)}
                                spellCheck={false}
                            />
                        </section>
                    )}

                    {mode !== "edit" && (
                        <section className="markdown-editor-pane markdown-editor-preview-pane">
                            <div
                                ref={previewRef}
                                className="markdown-editor-preview markdown-preview-content"
                                dangerouslySetInnerHTML={{ __html: highlightedHtml }}
                            />
                        </section>
                    )}
                </div>
            </div>
        </Modal>
    );
}
