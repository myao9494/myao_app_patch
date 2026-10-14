/**
 * ファイル一覧のパス入力欄
 * - フルパス・リンクのコピーボタン
 * - パス入力（Enter で移動、Shift+Enter で改行。矢印キーはテキスト内の移動を優先し、
 *   Ctrl/Cmd+↓ でフィルタバー、Ctrl/Cmd+↑ でツールバー、先頭での Ctrl/Cmd+← でコピーボタンへ移る）
 */
import type { FormEvent, RefObject } from "react";
import { Copy, Link } from "lucide-react";

interface FileListPathBarProps {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (e: FormEvent) => void;
  onCopyPath: () => void;
  onCopyLink: () => void;
  onFocusFilterBar: () => void;
  onFocusToolbar: () => void;
  onFocusPathButtons: () => void;
}

export function FileListPathBar({
  inputRef,
  value,
  onChange,
  onSubmit,
  onCopyPath,
  onCopyLink,
  onFocusFilterBar,
  onFocusToolbar,
  onFocusPathButtons,
}: FileListPathBarProps) {
  return (
    <div className="path-input-container">
      <button onClick={onCopyPath} title="フルパスをコピー" className="path-button">
        <Copy size={14} />
      </button>
      <button onClick={onCopyLink} title="リンクをコピー" className="path-button">
        <Link size={14} />
      </button>
      <form onSubmit={onSubmit} className="path-form">
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="フルパスを入力"
          className="path-input"
          rows={1}
          style={{ height: 'auto' }}
          onKeyDown={(e) => {
            const withModifier = e.ctrlKey || e.metaKey;
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit(e);
            } else if (e.key === 'ArrowDown' && withModifier) {
              e.preventDefault();
              onFocusFilterBar();
            } else if (e.key === 'ArrowUp' && withModifier) {
              e.preventDefault();
              onFocusToolbar();
            } else if (e.key === 'ArrowLeft' && withModifier && e.currentTarget.selectionStart === 0) {
              e.preventDefault();
              onFocusPathButtons();
            }
          }}
        />
      </form>
    </div>
  );
}
