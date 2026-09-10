/**
 * ファイル閲覧コンポーネント
 * - Markdown / テキストのHTMLレンダリング（見出し、リスト、タスク、画像、コールアウト）
 * - 電話番号自動抽出＆ワンタップ発信（tel:）・コピー
 * - SVG / 画像 / drawio のインライン表示
 * - Excalidraw 連携リンク
 * - プレビュー / 生テキスト切替
 * - 編集モードへの切り替え
 */
import React, { useState, useMemo, useEffect, useRef } from 'react';
import mermaid from 'mermaid';
import { AppSettings, FileContentResponse } from '../types';
import { extractPhoneNumbers } from '../utils/phone';
import { getImageViewUrl } from '../api/client';
import { getExcalidrawUrl } from '../utils/config';
import { renderMarkdownToHtml } from '../utils/markdownPreview';
import { getParentDir, resolvePath } from '../utils/pathUtils';
import {
  ArrowLeft,
  Edit3,
  Phone,
  Copy,
  Check,
  ExternalLink,
  Eye,
  Code,
} from 'lucide-react';

interface FileViewerProps {
  file: FileContentResponse;
  settings: AppSettings;
  onBack: () => void;
  onEdit: () => void;
  onOpenFileByPath?: (path: string) => void;
  onSearchQuery?: (query: string) => void;
}

export const FileViewer: React.FC<FileViewerProps> = ({
  file,
  settings,
  onBack,
  onEdit,
  onOpenFileByPath,
  onSearchQuery,
}) => {
  const [copiedPhone, setCopiedPhone] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'rendered' | 'raw'>('rendered');
  const previewContainerRef = useRef<HTMLDivElement>(null);

  // テキスト中から電話番号を検出
  const phoneNumbers = extractPhoneNumbers(file.content);

  // ファイル種別の判定
  const ext = file.extension;
  const isImageOrSvg =
    ['svg', 'png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext) ||
    file.name.endsWith('.drawio.svg');
  const isExcalidraw =
    ext === 'excalidraw' ||
    file.name.endsWith('.excalidraw') ||
    file.name.endsWith('.excalidraw.md');

  // Markdown レンダリング対象（.md, .txt 等、ただし .excalidraw.md は除く）
  const isMarkdownDoc =
    !isExcalidraw &&
    (['md', 'txt'].includes(ext) ||
      file.name.endsWith('.md') ||
      file.name.endsWith('.txt'));

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedPhone(text);
    setTimeout(() => setCopiedPhone(null), 2000);
  };

  // プレビュー内のリンククリックをハンドリング
  const handlePreviewClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;

    // 1. Wikilink [[note]] のクリック
    const wikilinkEl = target.closest('.markdown-wikilink');
    if (wikilinkEl) {
      e.preventDefault();
      const noteName = wikilinkEl.getAttribute('data-target');
      if (noteName && onSearchQuery) {
        onSearchQuery(noteName);
      }
      return;
    }

    // 2. <a> タグのクリック
    const anchor = target.closest('a');
    if (anchor) {
      const href = anchor.getAttribute('href');
      if (!href) return;

      // localhost や 127.0.0.1 の場合、Tailscaleホスト名に強制書き換え
      if (href.includes('localhost') || href.includes('127.0.0.1')) {
        e.preventDefault();
        const fixedUrl = href.replace(/localhost|127\.0\.0\.1/g, settings.serverHost);
        window.open(fixedUrl, '_blank', 'noreferrer');
        return;
      }

      // 相対Markdownファイルリンク（.md, .txt 等）
      if (!/^https?:\/\//i.test(href) && (href.endsWith('.md') || href.endsWith('.txt'))) {
        e.preventDefault();
        const baseDir = getParentDir(file.path);
        const resolved = resolvePath(baseDir, href);
        if (onOpenFileByPath) {
          onOpenFileByPath(resolved);
        }
      }
    }
  };

  // Markdown HTML の生成
  const renderedHtml = useMemo(() => {
    if (!isMarkdownDoc) return '';
    const baseDir = getParentDir(file.path);
    return renderMarkdownToHtml(file.content, { baseDir, settings });
  }, [file.content, file.path, isMarkdownDoc, settings]);

  // Mermaid ダイアグラムの動的レンダリング
  useEffect(() => {
    if (isMarkdownDoc && viewMode === 'rendered' && previewContainerRef.current) {
      const mermaidElements = previewContainerRef.current.querySelectorAll('.mermaid');
      if (mermaidElements.length > 0) {
        try {
          mermaid.initialize({
            startOnLoad: false,
            theme: settings.theme === 'dark' ? 'dark' : 'default',
            securityLevel: 'loose',
            fontFamily: 'inherit',
          });
          mermaid.run({
            nodes: mermaidElements as unknown as ArrayLike<HTMLElement>,
          }).catch((err) => {
            console.warn('Mermaid rendering error:', err);
          });
        } catch (err) {
          console.warn('Mermaid init error:', err);
        }
      }
    }
  }, [renderedHtml, isMarkdownDoc, viewMode, settings.theme]);

  return (
    <div className="quick-viewer-container">
      {/* ビューワーヘッダー */}
      <div className="quick-viewer-header">
        <button className="quick-btn-back" onClick={onBack} aria-label="戻る">
          <ArrowLeft size={22} />
        </button>
        <div className="quick-viewer-title-box">
          <h2 className="quick-viewer-filename">{file.name}</h2>
          <span className="quick-viewer-path">{file.path}</span>
        </div>
        <div className="quick-viewer-actions">
          {/* プレビュー / 生テキスト 切替トグル */}
          {(isMarkdownDoc || isExcalidraw) && (
            <button
              className="quick-btn-toggle-view"
              onClick={() => setViewMode(viewMode === 'rendered' ? 'raw' : 'rendered')}
              title={viewMode === 'rendered' ? 'テキスト表示に切替' : 'プレビュー表示に切替'}
            >
              {viewMode === 'rendered' ? <Code size={18} /> : <Eye size={18} />}
            </button>
          )}

          {file.is_editable && (
            <button
              className="quick-btn-edit"
              onClick={onEdit}
              title="編集"
              aria-label="編集する"
            >
              <Edit3 size={18} />
              <span>編集</span>
            </button>
          )}
        </div>
      </div>

      {/* 連絡先クイックアクションバー（電話番号が検出された場合） */}
      {phoneNumbers.length > 0 && (
        <div className="quick-contacts-panel">
          <div className="quick-contacts-header">
            <Phone size={16} className="text-emerald-400" />
            <span>検出された連絡先・電話番号:</span>
          </div>
          <div className="quick-contacts-list">
            {phoneNumbers.map((phone) => (
              <div key={phone.raw} className="quick-contact-card">
                <span className="quick-contact-num">{phone.raw}</span>
                <div className="quick-contact-btns">
                  <a
                    href={`tel:${phone.normalized}`}
                    className="quick-btn-tel"
                    title="電話をかける"
                  >
                    <Phone size={16} />
                    <span>発信</span>
                  </a>
                  <button
                    className="quick-btn-copy"
                    onClick={() => handleCopy(phone.raw)}
                    title="番号をコピー"
                  >
                    {copiedPhone === phone.raw ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* コンテンツ本体 */}
      <div className="quick-viewer-body">
        {isImageOrSvg ? (
          <div className="quick-image-preview-wrapper">
            <img
              src={getImageViewUrl(file.path, settings)}
              alt={file.name}
              className="quick-preview-img"
            />
          </div>
        ) : isExcalidraw ? (
          <div className="quick-excalidraw-wrapper">
            <div className="quick-excalidraw-banner">
              <div className="quick-excalidraw-badge-group">
                <span className="quick-badge">Excalidraw 図面</span>
              </div>
              <a
                href={getExcalidrawUrl(settings, file.path)}
                target="_blank"
                rel="noreferrer"
                className="quick-btn-external"
                title="Excalidrawエディタ（3001番ポート）で開く"
              >
                <ExternalLink size={18} />
                <span>Excalidraw で開く</span>
              </a>
            </div>

            {viewMode === 'rendered' ? (
              <div className="quick-excalidraw-image-box">
                <img
                  src={getImageViewUrl(file.path, settings, getParentDir(file.path))}
                  alt={file.name}
                  className="quick-preview-img quick-excalidraw-img"
                  loading="lazy"
                />
              </div>
            ) : (
              <div className="quick-text-preview-wrapper">
                <pre className="quick-text-preview">{file.content}</pre>
              </div>
            )}
          </div>
        ) : isMarkdownDoc && viewMode === 'rendered' ? (
          /* レンダリング済み Markdown ビュー */
          <div
            ref={previewContainerRef}
            className="quick-markdown-rendered-content markdown-preview-content"
            onClick={handlePreviewClick}
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        ) : (
          /* 生テキストプレビュー */
          <div className="quick-text-preview-wrapper">
            <pre className="quick-text-preview">{file.content}</pre>
          </div>
        )}
      </div>
    </div>
  );
};
