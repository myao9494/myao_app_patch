/**
 * ガントチャート用のコンテキストメニュー（右クリックメニュー）コンポーネント
 * 表示する項目は contextMenuItems.ts の生成関数で組み立てる。
 */
import { useEffect, useRef } from 'react';
import type { ContextMenuItem } from './contextMenuItems';

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Adjust position to keep menu in viewport
  useEffect(() => {
    if (menuRef.current) {
      const menu = menuRef.current;
      const rect = menu.getBoundingClientRect();

      let adjustedX = x;
      let adjustedY = y;

      if (x + rect.width > window.innerWidth) {
        adjustedX = window.innerWidth - rect.width - 10;
      }
      if (y + rect.height > window.innerHeight) {
        adjustedY = window.innerHeight - rect.height - 10;
      }

      menu.style.left = `${adjustedX}px`;
      menu.style.top = `${adjustedY}px`;
    }
  }, [x, y]);

  // Close on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const handleItemClick = (e: React.MouseEvent, item: ContextMenuItem) => {
    e.stopPropagation();
    e.preventDefault();
    if (item.action && !item.submenu) {
      item.action();
      onClose();
    }
  };

  return (
    <div
      ref={menuRef}
      className="gantt-context-menu"
      style={{ left: x, top: y }}
    >
      {items.map((item, index) => {
        if (item.divider) {
          return <div key={index} className="gantt-context-menu-divider" />;
        }

        return (
          <div
            key={index}
            className={`gantt-context-menu-item ${item.danger ? 'danger' : ''} ${item.submenu ? 'gantt-context-menu-submenu' : ''}`}
            onClick={(e) => handleItemClick(e, item)}
          >
            {item.icon && <span className="icon">{item.icon}</span>}
            <span>{item.label}</span>
            {item.submenu && (
              <div className="gantt-context-menu-submenu-items">
                {item.submenu.map((subItem, subIndex) => (
                  <div
                    key={subIndex}
                    className={`gantt-context-menu-item ${subItem.danger ? 'danger' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (subItem.action) {
                        subItem.action();
                        onClose();
                      }
                    }}
                  >
                    {subItem.icon && <span className="icon">{subItem.icon}</span>}
                    <span>{subItem.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
