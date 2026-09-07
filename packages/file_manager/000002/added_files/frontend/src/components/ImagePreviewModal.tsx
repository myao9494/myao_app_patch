/**
 * 画像プレビューモーダルコンポーネント
 * - ダーク半透明オーバーレイで画像を表示
 * - ズーム（拡大・縮小・100%・フィット）
 * - 前後ナビゲーション（同一フォルダ内の画像間移動、キーボード左右キー対応）
 * - 画像メタデータ表示（ファイル名、解像度、サイズ、インデックス）
 * - ダウンロード、別タブ表示、閉じる（Escapeキー対応）
 */
import { useState, useEffect, useCallback, useRef } from "react";
import {
  X,
  ZoomIn,
  ZoomOut,
  Maximize2,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Download,
  RotateCw,
} from "lucide-react";
import type { FileItem } from "../types/file";
import { getImageViewUrl, formatFileSize } from "../utils/imageUtils";
import "./ImagePreviewModal.css";

interface ImagePreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentImage: FileItem | null;
  siblingImages?: FileItem[];
  onNavigate?: (image: FileItem) => void;
}

export function ImagePreviewModal({
  isOpen,
  onClose,
  currentImage,
  siblingImages = [],
  onNavigate,
}: ImagePreviewModalProps) {
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // currentIndexの特定
  const currentIndex = currentImage
    ? siblingImages.findIndex((img) => img.path === currentImage.path)
    : -1;

  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < siblingImages.length - 1;

  // 画像変更時にズーム・回転・解像度をリセット
  useEffect(() => {
    setScale(1);
    setRotation(0);
    setNaturalSize(null);
  }, [currentImage?.path]);

  const handlePrev = useCallback(() => {
    if (hasPrev && onNavigate) {
      onNavigate(siblingImages[currentIndex - 1]);
    }
  }, [hasPrev, onNavigate, siblingImages, currentIndex]);

  const handleNext = useCallback(() => {
    if (hasNext && onNavigate) {
      onNavigate(siblingImages[currentIndex + 1]);
    }
  }, [hasNext, onNavigate, siblingImages, currentIndex]);

  // キーボードショートカット
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        handlePrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        handleNext();
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setScale((s) => Math.min(s + 0.25, 4));
      } else if (e.key === "-") {
        e.preventDefault();
        setScale((s) => Math.max(s - 0.25, 0.25));
      } else if (e.key === "0") {
        e.preventDefault();
        setScale(1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, handlePrev, handleNext]);

  if (!isOpen || !currentImage) return null;

  const imageUrl = getImageViewUrl(currentImage.path);

  const handleZoomIn = () => setScale((s) => Math.min(s + 0.25, 4));
  const handleZoomOut = () => setScale((s) => Math.max(s - 0.25, 0.25));
  const handleResetZoom = () => {
    setScale(1);
    setRotation(0);
  };
  const handleRotate = () => setRotation((r) => (r + 90) % 360);

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
  };

  const handleDownload = () => {
    const a = document.createElement("a");
    a.href = imageUrl;
    a.download = currentImage.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleOpenExternal = () => {
    window.open(imageUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="image-preview-overlay" onClick={onClose}>
      {/* ヘッダー */}
      <div className="image-preview-header" onClick={(e) => e.stopPropagation()}>
        <div className="image-preview-title">
          <span>{currentImage.name}</span>
          {siblingImages.length > 0 && currentIndex >= 0 && (
            <span className="image-preview-counter">
              {currentIndex + 1} / {siblingImages.length}
            </span>
          )}
        </div>

        <div className="image-preview-actions">
          <button
            className="image-preview-btn"
            onClick={handleRotate}
            title="90度回転"
          >
            <RotateCw size={16} />
          </button>
          <button
            className="image-preview-btn"
            onClick={handleDownload}
            title="ダウンロード"
          >
            <Download size={16} />
          </button>
          <button
            className="image-preview-btn"
            onClick={handleOpenExternal}
            title="ブラウザで開く"
          >
            <ExternalLink size={16} />
          </button>
          <button
            className="image-preview-btn close"
            onClick={onClose}
            title="閉じる (Esc)"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* メインプレビュー領域 */}
      <div className="image-preview-body" onClick={onClose}>
        {hasPrev && (
          <button
            className="image-preview-nav-btn prev"
            onClick={(e) => {
              e.stopPropagation();
              handlePrev();
            }}
            title="前の画像 (←)"
          >
            <ChevronLeft size={28} />
          </button>
        )}

        <div
          className="image-preview-container"
          style={{
            transform: `scale(${scale}) rotate(${rotation}deg)`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <img
            ref={imgRef}
            src={imageUrl}
            alt={currentImage.name}
            className="image-preview-img"
            onLoad={handleImageLoad}
          />
        </div>

        {hasNext && (
          <button
            className="image-preview-nav-btn next"
            onClick={(e) => {
              e.stopPropagation();
              handleNext();
            }}
            title="次の画像 (→)"
          >
            <ChevronRight size={28} />
          </button>
        )}
      </div>

      {/* フッター（メタデータ・ズーム操作） */}
      <div className="image-preview-footer" onClick={(e) => e.stopPropagation()}>
        <div className="image-preview-meta">
          {naturalSize && (
            <span>
              {naturalSize.width} × {naturalSize.height} px
            </span>
          )}
          <span>{formatFileSize(currentImage.size)}</span>
        </div>

        <div className="image-preview-controls">
          <button
            className="image-preview-btn"
            onClick={handleZoomOut}
            title="縮小 (-)"
          >
            <ZoomOut size={16} />
          </button>
          <span className="image-preview-zoom-label">
            {Math.round(scale * 100)}%
          </span>
          <button
            className="image-preview-btn"
            onClick={handleZoomIn}
            title="拡大 (+)"
          >
            <ZoomIn size={16} />
          </button>
          <button
            className="image-preview-btn"
            onClick={handleResetZoom}
            title="実寸/フィットにリセット (0)"
          >
            <Maximize2 size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
