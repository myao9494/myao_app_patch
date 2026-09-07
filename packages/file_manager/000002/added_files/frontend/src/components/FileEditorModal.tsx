/**
 * 汎用ファイルエディタモーダル
 * VS Code風の見た目でテキスト/コードファイルをシンタックスハイライト付きで編集する
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, FileCode2, Search, X } from "lucide-react";

import { Modal } from "./Modal";
import { matchesCmdOrCtrlShortcut } from "../utils/globalShortcuts";
import {
  detectEditorLanguage,
  renderCodeToHighlightedHtml,
  type EditorLanguage,
} from "../utils/codeEditorHighlight";
import { findTextMatches, getNextMatchIndex, type TextMatch } from "../utils/markdownSearch";
import "./FileEditorModal.css";

interface FileEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (content: string) => void;
  initialContent?: string;
  fileName: string;
  filePath?: string | null;
  isSaving?: boolean;
  initialLanguage?: EditorLanguage;
}

export function FileEditorModal({
  isOpen,
  onClose,
  onSave,
  initialContent = "",
  fileName,
  filePath,
  isSaving = false,
  initialLanguage,
}: FileEditorModalProps) {
  const [content, setContent] = useState(initialContent);
  const [hasChanges, setHasChanges] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  const [searchIndex, setSearchIndex] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const highlightRef = useRef<HTMLPreElement | null>(null);
  const lineNumbersRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const language = initialLanguage ?? detectEditorLanguage(fileName);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setContent(initialContent);
    setHasChanges(false);
    setSearchQuery("");
    setSearchIndex(0);

    const timerId = window.setTimeout(() => {
      textareaRef.current?.focus();
    }, 60);

    return () => window.clearTimeout(timerId);
  }, [initialContent, isOpen]);

  const lineCount = useMemo(() => Math.max(content.split("\n").length, 1), [content]);

  const matches = useMemo(() => {
    return findTextMatches(content, searchQuery, isRegex);
  }, [content, searchQuery, isRegex]);

  const highlightedHtml = useMemo(
    () =>
      renderCodeToHighlightedHtml(content, language, {
        query: searchQuery,
        activeIndex: searchIndex,
        isRegex,
      }),
    [content, language, searchQuery, searchIndex, isRegex]
  );

  const handleSave = useCallback(() => {
    onSave(content);
    setHasChanges(false);
  }, [content, onSave]);

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

  const handleScroll = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    if (highlightRef.current) {
      highlightRef.current.scrollTop = textarea.scrollTop;
      highlightRef.current.scrollLeft = textarea.scrollLeft;
    }

    if (lineNumbersRef.current) {
      lineNumbersRef.current.style.transform = `translateY(${-textarea.scrollTop}px)`;
    }
  }, []);

  const scrollToMatch = useCallback(
    (targetIndex: number, matchItems: TextMatch[]) => {
      if (targetIndex < 0 || targetIndex >= matchItems.length) {
        return;
      }

      const match = matchItems[targetIndex];
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.setSelectionRange(match.start, match.end);

        const textBeforeMatch = content.slice(0, match.start);
        const lineIndex = textBeforeMatch.split("\n").length - 1;
        const totalLines = Math.max(1, content.split("\n").length);
        const scrollRatio = lineIndex / totalLines;
        const targetScrollTop = scrollRatio * (textarea.scrollHeight - textarea.clientHeight);

        textarea.scrollTo({
          top: targetScrollTop,
          behavior: "smooth",
        });
      }
    },
    [content]
  );

  const handleNextMatch = useCallback(() => {
    if (matches.length === 0) return;
    const next = getNextMatchIndex(searchIndex, matches.length, "next");
    setSearchIndex(next);
    scrollToMatch(next, matches);
  }, [matches, searchIndex, scrollToMatch]);

  const handlePrevMatch = useCallback(() => {
    if (matches.length === 0) return;
    const prev = getNextMatchIndex(searchIndex, matches.length, "prev");
    setSearchIndex(prev);
    scrollToMatch(prev, matches);
  }, [matches, searchIndex, scrollToMatch]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (matchesCmdOrCtrlShortcut(event, "f")) {
        event.preventDefault();
        event.stopPropagation();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if (matchesCmdOrCtrlShortcut(event, "s")) {
        event.preventDefault();
        event.stopPropagation();
        handleSave();
        return;
      }

      if (event.key !== "Escape") {
        return;
      }

      // 検索入力欄にフォーカスがある場合は検索文字をクリアしてエディタに復帰
      if (document.activeElement === searchInputRef.current) {
        event.preventDefault();
        event.stopPropagation();
        setSearchQuery("");
        textareaRef.current?.focus();
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      handleClose();
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [handleClose, handleSave, isOpen]);

  // モーダル最上部ヘッダー（横1行集約レイアウト）
  const headerRow = (
    <div className="fe-modal-header-row">
      <div className="fe-modal-title-wrap" title={filePath || fileName}>
        <span className="fe-modal-title-icon">
          <FileCode2 size={16} />
        </span>
        <span className="fe-modal-title-text">{fileName}</span>
      </div>

      {/* スリム検索バー */}
      <div className="fe-header-search" role="search">
        <Search size={13} className="search-icon" />
        <input
          ref={searchInputRef}
          type="text"
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setSearchIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (e.shiftKey) {
                handlePrevMatch();
              } else {
                handleNextMatch();
              }
            }
          }}
          placeholder="検索... (Cmd/Ctrl+F)"
        />
        {searchQuery && (
          <button
            type="button"
            className="search-clear-btn"
            onClick={() => {
              setSearchQuery("");
              textareaRef.current?.focus();
            }}
            title="クリア"
          >
            <X size={12} />
          </button>
        )}
        {searchQuery && (
          <span className="search-count-badge">
            {matches.length > 0 ? `${searchIndex + 1} / ${matches.length}` : "0 / 0"}
          </span>
        )}
        <button
          type="button"
          className="search-nav-btn"
          onClick={handlePrevMatch}
          disabled={matches.length === 0}
          title="前へ (Shift+Enter)"
        >
          <ChevronUp size={13} />
        </button>
        <button
          type="button"
          className="search-nav-btn"
          onClick={handleNextMatch}
          disabled={matches.length === 0}
          title="次へ (Enter)"
        >
          <ChevronDown size={13} />
        </button>
        <button
          type="button"
          className={`regex-toggle${isRegex ? " active" : ""}`}
          onClick={() => {
            setIsRegex(!isRegex);
            setSearchIndex(0);
          }}
          title="正規表現"
        >
          .*
        </button>
      </div>

      {/* 言語バッジ */}
      <span className="fe-header-lang">{language}</span>

      {/* ステータス */}
      <div className="fe-header-status">
        <span className="fe-header-lines">{lineCount} 行</span>
        <span className={`fe-header-save-state ${hasChanges ? "unsaved" : "saved"}`}>
          {hasChanges ? "● 未保存" : "✓ 保存済"}
        </span>
      </div>

      {/* アクションボタン */}
      <div className="fe-header-actions">
        <button
          type="button"
          className="fe-btn-secondary"
          onClick={handleClose}
          disabled={isSaving}
        >
          キャンセル
        </button>
        <button
          type="button"
          className="fe-btn-primary"
          onClick={handleSave}
          disabled={isSaving}
        >
          {isSaving ? "保存中..." : "保存 (Cmd+S)"}
        </button>
      </div>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={headerRow}
      footer={undefined}
      width="min(1240px, 96vw)"
      height="min(92vh, 940px)"
    >
      <div className="code-editor-shell">
        <div className="code-editor-workspace">
          <div className="code-editor-gutter">
            <div ref={lineNumbersRef} className="code-editor-line-numbers">
              {Array.from({ length: lineCount }, (_, index) => (
                <div key={index + 1} className="code-editor-line-number">
                  {index + 1}
                </div>
              ))}
            </div>
          </div>

          <div className="code-editor-pane">
            <pre
              ref={highlightRef}
              className="code-editor-highlight"
              aria-hidden="true"
            >
              <code dangerouslySetInnerHTML={{ __html: highlightedHtml || " " }} />
            </pre>
            <textarea
              ref={textareaRef}
              className="code-editor-textarea"
              value={content}
              spellCheck={false}
              onChange={(event) => {
                const nextContent = event.target.value;
                setContent(nextContent);
                setHasChanges(nextContent !== initialContent);
              }}
              onScroll={handleScroll}
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}

