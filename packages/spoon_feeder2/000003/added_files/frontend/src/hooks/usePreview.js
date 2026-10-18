/**
 * ファイルツリーのキーボード操作とプレビュー表示 (usePreview.js)
 *
 * 仕様:
 * 1. ツリー上で ↑/↓ でフォーカス移動、←/→ でフォルダ開閉、Enter でチェック反転・フォルダ開閉、Shift+Enter でプレビューを開く。
 * 2. プレビューを閉じたら、開く前にフォーカスしていたツリー項目へフォーカスを戻す。
 * 3. 参照ライブラリ配下のファイルは、そのリポジトリのパスでプレビューを取得する。
 **/

import { useRef, useState } from 'react';
import { api } from '../api';

export function usePreview({ activePath, path }) {
  const [previewFile, setPreviewFile] = useState('');
  const [previewContent, setPreviewContent] = useState('');
  const treeRef = useRef(null);
  const returnRef = useRef(null);

  const closePreview = () => {
    setPreviewFile('');
    const returnFocus = returnRef.current;
    setTimeout(() => {
      const items = Array.from(treeRef.current?.querySelectorAll('[data-tree-item="true"]') || []);
      const target = returnFocus && items.find(item => item.dataset.treePath === returnFocus.path && (item.dataset.treeRepository || activePath || path) === returnFocus.repository);
      (target || treeRef.current)?.focus();
    }, 0);
  };

  const openPreview = async (file, repositoryPath = activePath || path) => {
    const focused = treeRef.current?.querySelector('[data-tree-item="true"]:focus');
    if (focused) returnRef.current = { path: focused.dataset.treePath, repository: focused.dataset.treeRepository || activePath || path };
    setPreviewFile(file); setPreviewContent('読み込み中…');
    try { const data = await api('/api/file_content', { library_path: repositoryPath, file_path: file }); setPreviewContent(data.content); }
    catch (err) { setPreviewContent(err.message); }
  };

  const handleTreeKeyDown = event => {
    const tree = treeRef.current;
    if (!tree) return;
    const items = Array.from(tree.querySelectorAll('[data-tree-item="true"]'));
    const current = event.target.closest?.('[data-tree-item="true"]');
    const index = current ? items.indexOf(current) : -1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const nextIndex = index < 0
        ? (event.key === 'ArrowDown' ? 0 : items.length - 1)
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[nextIndex]?.focus();
      return;
    }
    if (!current) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      if (current.dataset.treeKind !== 'directory') return;
      const expanded = current.getAttribute('aria-expanded') === 'true';
      if ((event.key === 'ArrowRight' && !expanded) || (event.key === 'ArrowLeft' && expanded)) {
        event.preventDefault();
        current.querySelector('[data-tree-toggle="true"]')?.click();
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey && current.dataset.treeKind === 'file' && current.dataset.treeIgnored !== 'true') {
        openPreview(current.dataset.treePath, current.dataset.treeRepository || activePath || path);
        return;
      }
      if (current.dataset.treeKind === 'directory') {
        current.querySelector('[data-tree-toggle="true"]')?.click();
      } else if (current.dataset.treeIgnored !== 'true') {
        current.querySelector('input[type="checkbox"]:not(:disabled)')?.click();
      }
    }
  };

  return { treeRef, previewFile, previewContent, openPreview, closePreview, handleTreeKeyDown };
}
