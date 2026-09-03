/**
 * ペイン背景・テーブルヘッダー用の右クリックメニュー
 * - リスト取得(check_box): Markdownチェックボックス形式（- [ ] {name}）でコピー
 * - リスト取得(箇条書き): Markdown箇条書き形式（- {name}）でコピー
 * - 隣のペインで開く: 左ペインなら真ん中ペイン、真ん中ペインなら左ペインで現在フォルダを開く
 */
import { useEffect, useRef } from "react";
import { ListTodo, List, ArrowRightLeft } from "lucide-react";
import "./ContextMenu.css";

interface PaneContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onCopyChecklist: () => void;
  onCopyBulletList?: () => void;
  onOpenInAdjacentPane?: () => void;
}

export function PaneContextMenu({
  x,
  y,
  onClose,
  onCopyChecklist,
  onCopyBulletList,
  onOpenInAdjacentPane,
}: PaneContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const adjustedX = Math.min(x, window.innerWidth - 220);
  const adjustedY = Math.min(y, window.innerHeight - 180);

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: adjustedX, top: adjustedY }}
    >
      <div className="menu-item" onClick={onCopyChecklist}>
        <ListTodo size={16} />
        <span>リスト取得(check_box)</span>
      </div>
      {onCopyBulletList && (
        <div className="menu-item" onClick={onCopyBulletList}>
          <List size={16} />
          <span>リスト取得(箇条書き)</span>
        </div>
      )}
      {onOpenInAdjacentPane && (
        <>
          <div className="menu-divider" />
          <div className="menu-item" onClick={onOpenInAdjacentPane}>
            <ArrowRightLeft size={16} />
            <span>隣のペインで開く</span>
          </div>
        </>
      )}
    </div>
  );
}
