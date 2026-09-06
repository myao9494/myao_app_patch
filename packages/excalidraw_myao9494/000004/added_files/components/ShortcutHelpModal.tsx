/**
 * キーボードショートカット一覧モーダルコンポーネント
 * 
 * 仕様:
 * 1. ショートカットキー「.」またはヘッダーのボタンから起動。
 * 2. カテゴリ切り替えタブ（すべて、独自機能、描画ツール、編集・操作）を提供。
 * 3. キー名・説明・詳細を対象にしたリアルタイム検索バーを提供。
 * 4. キーボードバッジ（<kbd>）を用いた視認性の高いUI。
 * 5. ESCキー、外側クリック、または閉じるボタンでクローズ。
 * 6. WAI-ARIA（role="dialog", aria-modal="true"）に準拠。
 **/

import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  SHORTCUT_CATEGORIES,
  SHORTCUT_LIST,
  filterShortcuts,
  type ShortcutCategory,
} from '../utils/shortcutList';

interface ShortcutHelpModalProps {
  /** モーダルの開閉状態 */
  isOpen: boolean;
  /** モーダルを閉じるハンドラ */
  onClose: () => void;
}

export const ShortcutHelpModal: React.FC<ShortcutHelpModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [selectedCategory, setSelectedCategory] = useState<ShortcutCategory>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const modalRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // モーダルが開かれたら検索欄にフォーカスを当てる
  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    } else {
      // 閉じる際に検索クエリをリセット
      setSearchQuery('');
      setSelectedCategory('all');
    }
  }, [isOpen]);

  // ESCキーで閉じる
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // 外側クリックで閉じる
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 50);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose]);

  // フィルタリングされたショートカット一覧
  const filteredList = useMemo(() => {
    return filterShortcuts(SHORTCUT_LIST, selectedCategory, searchQuery);
  }, [selectedCategory, searchQuery]);

  if (!isOpen) return null;

  return (
    <div
      className="shortcut-help-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="キーボードショートカット一覧"
    >
      <div className="shortcut-help-window" ref={modalRef}>
        {/* ヘッダー */}
        <div className="shortcut-help-header">
          <div className="title-area">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M6 8h.001" />
              <path d="M10 8h.001" />
              <path d="M14 8h.001" />
              <path d="M18 8h.001" />
              <path d="M6 12h.001" />
              <path d="M10 12h.001" />
              <path d="M14 12h.001" />
              <path d="M18 12h.001" />
              <path d="M7 16h10" />
            </svg>
            <h3>ショートカット一覧</h3>
            <span className="shortcut-key-badge">.</span>
          </div>
          <button
            type="button"
            className="close-btn"
            onClick={onClose}
            title="閉じる (Esc)"
            aria-label="閉じる"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        {/* コントロール（検索バー + カテゴリタブ） */}
        <div className="shortcut-help-toolbar">
          <div className="search-box">
            <svg
              className="search-icon"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input
              ref={searchInputRef}
              type="text"
              className="search-input"
              placeholder="ショートカットや機能を検索..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="search-clear-btn"
                onClick={() => setSearchQuery('')}
                title="検索をクリア"
              >
                ×
              </button>
            )}
          </div>

          <div className="category-tabs">
            {SHORTCUT_CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                type="button"
                className={`category-tab ${selectedCategory === cat.id ? 'active' : ''}`}
                onClick={() => setSelectedCategory(cat.id)}
                title={cat.description}
              >
                {cat.label}
              </button>
            ))}
          </div>
        </div>

        {/* リスト本体 */}
        <div className="shortcut-help-body">
          {filteredList.length === 0 ? (
            <div className="shortcut-empty">
              <p>「{searchQuery}」に一致するショートカットは見つかりませんでした。</p>
            </div>
          ) : (
            <div className="shortcut-grid">
              {filteredList.map((item, index) => (
                <div key={`${item.key}-${index}`} className="shortcut-card">
                  <div className="shortcut-keys">
                    {formatKeys(item.key)}
                    {item.badge && (
                      <span className="shortcut-item-badge">{item.badge}</span>
                    )}
                  </div>
                  <div className="shortcut-info">
                    <div className="shortcut-desc">{item.description}</div>
                    {item.detail && (
                      <div className="shortcut-detail">{item.detail}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* フッター */}
        <div className="shortcut-help-footer">
          <span className="footer-hint">
            ヒント: キャンバス操作中に <kbd>.</kbd> キーでいつでもこの画面を開閉できます
          </span>
          <button type="button" className="confirm-btn" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * キー表記文字列を <kbd> タグの並びに整形するヘルパー関数
 * 例: "Cmd / Ctrl + S" -> [<kbd>Cmd</kbd>, " / ", <kbd>Ctrl</kbd>, " + ", <kbd>S</kbd>]
 */
function formatKeys(keyStr: string): React.ReactNode {
  // スラッシュやプラスなどの区切り文字で分割して整形
  const tokens = keyStr.split(/(\s*[\/\+]\s*)/);

  return (
    <span className="kbd-wrapper">
      {tokens.map((token, i) => {
        const trimmed = token.trim();
        if (trimmed === '/' || trimmed === '+') {
          return (
            <span key={i} className="kbd-sep">
              {trimmed}
            </span>
          );
        }
        if (trimmed.length === 0) {
          return null;
        }
        return (
          <kbd key={i} className="shortcut-kbd">
            {trimmed}
          </kbd>
        );
      })}
    </span>
  );
}
