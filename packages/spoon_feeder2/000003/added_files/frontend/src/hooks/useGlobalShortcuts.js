/**
 * 画面全体のショートカット (useGlobalShortcuts.js)
 *
 * 仕様:
 * 1. I: 無視リスト編集を開く / H: ショートカット説明の開閉 / Esc: プレビューまたは右クリックメニューを閉じる。
 * 2. 入力欄・テキストエリア・選択欄・ターミナル(xterm)にフォーカスがあるときは I/H を通常入力として扱う。
 * 3. 無視リスト編集・参照リポジトリ編集モーダルが開いている間は何もしない（モーダル側で処理）。
 * 4. 画面のクリックで右クリックメニューを閉じる。
 * ハンドラーは常に最新の props を参照する（再登録は1度だけ）。
 **/

import { useEffect, useRef } from 'react';

export function useGlobalShortcuts(handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const closeMenu = () => ref.current.onCloseContextMenu();
    const onKeyDown = event => {
      const { helpOpen, modalOpen, previewFile, onToggleHelp, onClosePreview, onCloseContextMenu, onOpenIgnoreEditor } = ref.current;
      if (event.defaultPrevented) return;
      const key = event.key.toLowerCase();
      if (helpOpen) {
        if (key === 'h' || event.key === 'Escape') { event.preventDefault(); onToggleHelp(false); }
        return;
      }
      if (modalOpen) return;
      if (event.key === 'Escape') { if (previewFile) onClosePreview(); else onCloseContextMenu(); return; }
      const target = event.target;
      if (target instanceof HTMLElement && (target.matches('input, textarea, select, [contenteditable="true"]') || target.closest('.xterm'))) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (key === 'i') { event.preventDefault(); onOpenIgnoreEditor(); }
      if (key === 'h') { event.preventDefault(); onToggleHelp(true); }
    };
    window.addEventListener('click', closeMenu); window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('click', closeMenu); window.removeEventListener('keydown', onKeyDown); };
  }, []);
}
