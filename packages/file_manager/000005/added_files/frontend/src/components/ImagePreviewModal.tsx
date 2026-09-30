/**
 * 画像プレビューモーダルコンポーネント (ImagePreviewModal)
 * - ダーク半透明オーバーレイで画像を表示
 * - 複数画像表示（グリッドモード）と単一画像プレビューの相互切り替え (Gキー / ツールバー)
 * - グリッド表示: 上下左右矢印キー(↑/↓/←/→)でサムネイルカードを選択移動、自動スクロール追従
 * - グリッド表示: Enter/Returnキーまたはクリックで選択画像を単一拡大プレビューとして瞬時に展開
 * - 単一プレビュー: 上矢印キー(↑)でフォルダ内ファイルのグリッド表示へ即時復帰
 * - 単一プレビュー: 左右矢印キー(←/→)で次々と連続画像切り替え
 * - 階層指定 (depth: 0〜10): サブフォルダ内の画像も高速再帰取得してグリッド・プレビューに一覧表示
 * - 高解像度レンダリング: 自然解像度(naturalSize)に基づく最適基準サイズ(baseFitSize)と高品質サンプリング
 * - サムネイル一覧表示（小・中・大サイズ切替、メタデータ表示、ワンクリック展開）
 * - マウスホイールによるスムーズなポインター中心ズーム（縮小・拡大）
 * - ポインターイベント（ドラッグ）による自由なパン移動（慣性・ドラッグ追従）
 * - 実寸（1:1 等倍）表示および画面フィット切り替え
 * - 画像ダブルクリックによるズーム切り替え（フィット ⇔ 拡大）
 * - 90度回転（時計回り・反時計回り）および水平/垂直反転
 * - ピクセル補間切り替え（image-rendering: pixelated / auto）
 * - 拡大時のミニマップ（ナビゲーターサムネイル）表示およびクリック移動
 * - 同一フォルダ内の前後ナビゲーション（矢印キー、ボタン）
 * - フルスクリーン表示（Fullscreen API）
 * - 詳細メタデータ表示（ファイル名、解像度、アスペクト比、ファイルサイズ、インデックス）
 * - ダウンロード、別タブ表示、キーボードショートカット対応
 */
import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  X,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Minimize2,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Download,
  RotateCw,
  RotateCcw,
  FlipHorizontal,
  FlipVertical,
  Maximize,
  Sparkles,
  MapPin,
  HelpCircle,
  Copy,
  Check,
  LayoutGrid,
  Eye,
} from "lucide-react";
import type { FileItem } from "../types/file";
import { getImageViewUrl, formatFileSize, copyImageToClipboard } from "../utils/imageUtils";
import { getFolderImages } from "../api/files";
import { useToast } from "../hooks/useToast";
import {
  calculateZoomScale,
  calculateZoomOffset,
  calculatePanOffset,
  calculateActualSizeScale,
  formatAspectRatio,
  calculateMinimapViewport,
  calculateOffsetFromMinimapClick,
  type Point,
} from "../utils/imageViewerCalculations";
import "./ImagePreviewModal.css";

interface ImagePreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentImage: FileItem | null;
  siblingImages?: FileItem[];
  folderPath?: string;
  onNavigate?: (image: FileItem) => void;
  initialMode?: "single" | "grid";
}

const ZOOM_PRESETS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 8.0];

export function ImagePreviewModal({
  isOpen,
  onClose,
  currentImage,
  siblingImages = [],
  folderPath = "",
  onNavigate,
  initialMode,
}: ImagePreviewModalProps) {
  const { showSuccess, showError } = useToast();
  const [scale, setScale] = useState<number>(1);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [rotation, setRotation] = useState<number>(0);
  const [flipH, setFlipH] = useState<boolean>(false);
  const [flipV, setFlipV] = useState<boolean>(false);
  const [isPixelated, setIsPixelated] = useState<boolean>(false);
  const [showMinimap, setShowMinimap] = useState<boolean>(true);
  const [showPresets, setShowPresets] = useState<boolean>(false);
  const [showShortcuts, setShowShortcuts] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<"single" | "grid">(
    initialMode || (currentImage ? "single" : "grid")
  );
  const [gridThumbnailSize, setGridThumbnailSize] = useState<"small" | "medium" | "large">("medium");

  // 階層指定（depth: 0=直下のみ、1=1階層下まで、2=2階層下まで...）
  const [depth, setDepth] = useState<number>(0);
  const [customImages, setCustomImages] = useState<FileItem[] | null>(null);
  const [isLoadingImages, setIsLoadingImages] = useState<boolean>(false);

  // 実効画像リスト（階層指定で取得した画像があればそれを優先、なければ直下のsiblingImages）
  const effectiveImages = customImages ?? siblingImages;

  // グリッド選択インデックス（ローカルステートで即時反映）
  const [selectedGridIndex, setSelectedGridIndex] = useState<number>(() => {
    if (currentImage) {
      const idx = effectiveImages.findIndex((img) => img.path === currentImage.path);
      return idx >= 0 ? idx : 0;
    }
    return 0;
  });

  const gridContainerRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);

  // アクティブ画像の特定（selectedGridIndexを優先参照）
  const activeImage =
    effectiveImages[selectedGridIndex] ||
    currentImage ||
    (effectiveImages.length > 0 ? effectiveImages[0] : null);

  // activeImage基準でcurrentIndexを計算（フォールバック時も正しく算出）
  const currentIndex = activeImage
    ? effectiveImages.findIndex((img) => img.path === activeImage.path)
    : selectedGridIndex;

  const hasPrev = selectedGridIndex > 0;
  const hasNext = selectedGridIndex < effectiveImages.length - 1;

  // 階層（depth）変更時の画像再取得ハンドラー
  const handleDepthChange = useCallback(
    async (newDepth: number) => {
      if (newDepth < 0 || newDepth > 5) return;
      setDepth(newDepth);

      if (newDepth === 0) {
        setCustomImages(null);
        return;
      }

      // 対象フォルダのパスを特定
      let targetDir = folderPath;
      if (!targetDir && currentImage) {
        const parts = currentImage.path.replace(/\\/g, "/").split("/");
        parts.pop();
        targetDir = parts.join("/");
      }

      if (!targetDir) return;

      setIsLoadingImages(true);
      try {
        const res = await getFolderImages(targetDir, newDepth);
        setCustomImages(res.images);
        // 現在選択中の画像があればそのインデックスを維持、なければ先頭を選択
        if (activeImage) {
          const matchedIdx = res.images.findIndex((img) => img.path === activeImage.path);
          const nextIdx = matchedIdx >= 0 ? matchedIdx : 0;
          setSelectedGridIndex(nextIdx);
          selectedGridIndexRef.current = nextIdx;
        }
      } catch (e: any) {
        showError(`画像一覧の取得に失敗しました: ${e.message}`);
      } finally {
        setIsLoadingImages(false);
      }
    },
    [folderPath, currentImage, activeImage, showError]
  );

  // モーダルが新しく開かれた瞬間のみ初期状態を設定
  const prevIsOpenRef = useRef<boolean>(false);
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      if (initialMode) {
        setViewMode(initialMode);
      } else if (currentImage) {
        setViewMode("single");
      } else {
        setViewMode("grid");
      }
      setDepth(0);
      setCustomImages(null);
      const initialIdx = currentImage
        ? siblingImages.findIndex((img) => img.path === currentImage.path)
        : 0;
      const validIdx = initialIdx >= 0 ? initialIdx : 0;
      setSelectedGridIndex(validIdx);
      selectedGridIndexRef.current = validIdx;
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, initialMode, currentImage, siblingImages]);

  // グリッドの現在の列数をコンテナ幅とサムネイルサイズから動的計算（上下キー移動用）
  const getGridColumns = useCallback(() => {
    if (!gridContainerRef.current) return 4;
    const containerWidth = gridContainerRef.current.clientWidth;
    const minWidth = gridThumbnailSize === "small" ? 140 : gridThumbnailSize === "large" ? 240 : 180;
    const gap = 16;
    const cols = Math.floor((containerWidth + gap) / (minWidth + gap));
    return Math.max(1, cols);
  }, [gridThumbnailSize]);

  // グリッド選択インデックスが変わった時にカードを視界内に即時スクロール追従（スムーズキュー遅延防止）
  useEffect(() => {
    if (viewMode === "grid" && cardRefs.current[selectedGridIndex]) {
      cardRefs.current[selectedGridIndex]?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: "auto",
      });
    }
  }, [selectedGridIndex, viewMode]);

  // 単一プレビュー時の前後画像の自動プリロード（キャッシュによる超高速切り替え）
  useEffect(() => {
    if (!isOpen || effectiveImages.length === 0) return;
    const preloadIndices = [
      selectedGridIndex - 1,
      selectedGridIndex + 1,
      selectedGridIndex + 2,
    ];
    preloadIndices.forEach((idx) => {
      if (idx >= 0 && idx < effectiveImages.length) {
        const preloadImg = new Image();
        preloadImg.src = getImageViewUrl(effectiveImages[idx].path);
      }
    });
  }, [isOpen, selectedGridIndex, effectiveImages]);

  // グリッドで画像を選択したときのハンドラー
  const handleSelectImage = useCallback((image: FileItem, index?: number) => {
    const idx = index !== undefined ? index : effectiveImages.findIndex((img) => img.path === image.path);
    if (idx >= 0) {
      setSelectedGridIndex(idx);
      selectedGridIndexRef.current = idx;
    }
    if (onNavigate) {
      onNavigate(image);
    }
    setViewMode("single");
  }, [onNavigate, effectiveImages]);

  const overlayRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);

  // 最新ステートを追従するRef（イベントリスナーでの古いクロージャ参照による遅延・無反応を完全防止）
  const selectedGridIndexRef = useRef<number>(selectedGridIndex);
  selectedGridIndexRef.current = selectedGridIndex;

  const siblingImagesRef = useRef<FileItem[]>(effectiveImages);
  siblingImagesRef.current = effectiveImages;

  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  // モーダルオープン時に背後要素のフォーカスを解除し、モーダルコンテナ自身へフォーカスを確保
  useEffect(() => {
    if (isOpen) {
      (document.activeElement as HTMLElement)?.blur?.();
      requestAnimationFrame(() => {
        overlayRef.current?.focus();
      });
    }
  }, [isOpen]);

  // ドラッグ追跡用のRef
  const dragStartRef = useRef<Point>({ x: 0, y: 0 });
  const startOffsetRef = useRef<Point>({ x: 0, y: 0 });
  const isPointerDownRef = useRef<boolean>(false);
  const hasMovedRef = useRef<boolean>(false);

  // 画像変更時にズーム・回転・パン位置・解像度をリセット（キャッシュ完了時は即座に解像度設定）
  useEffect(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
    setRotation(0);
    setFlipH(false);
    setFlipV(false);
    setShowPresets(false);
    if (imgRef.current && imgRef.current.complete && imgRef.current.naturalWidth > 0) {
      setNaturalSize({
        width: imgRef.current.naturalWidth,
        height: imgRef.current.naturalHeight,
      });
    } else {
      setNaturalSize(null);
    }
  }, [activeImage?.path]);

  // 前後のナビゲーション（1回のキー入力で即座にインデックスを進め、リバウンドを防止）
  const handlePrev = useCallback(() => {
    const cur = selectedGridIndexRef.current;
    if (cur > 0) {
      const nextIdx = cur - 1;
      selectedGridIndexRef.current = nextIdx;
      setSelectedGridIndex(nextIdx);
      const targetImg = siblingImagesRef.current[nextIdx];
      if (targetImg && onNavigateRef.current) {
        onNavigateRef.current(targetImg);
      }
    }
  }, []);

  const handleNext = useCallback(() => {
    const cur = selectedGridIndexRef.current;
    if (cur < siblingImagesRef.current.length - 1) {
      const nextIdx = cur + 1;
      selectedGridIndexRef.current = nextIdx;
      setSelectedGridIndex(nextIdx);
      const targetImg = siblingImagesRef.current[nextIdx];
      if (targetImg && onNavigateRef.current) {
        onNavigateRef.current(targetImg);
      }
    }
  }, []);

  // 画面フィット表示にリセット
  const handleFit = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // ビューポートサイズと画像本来の解像度（naturalSize）から基準フィットサイズを算出（高解像度レンダリング対応）
  const getBaseFitSize = useCallback((): { width: number; height: number } => {
    if (!naturalSize) return { width: 0, height: 0 };
    const viewportWidth = bodyRef.current?.clientWidth || (typeof window !== "undefined" ? window.innerWidth * 0.9 : 800);
    const viewportHeight = bodyRef.current?.clientHeight || (typeof window !== "undefined" ? window.innerHeight * 0.82 : 600);

    const scaleRatio = Math.min(
      viewportWidth / naturalSize.width,
      viewportHeight / naturalSize.height,
      1
    );
    return {
      width: Math.round(naturalSize.width * scaleRatio),
      height: Math.round(naturalSize.height * scaleRatio),
    };
  }, [naturalSize]);

  const baseFitSize = getBaseFitSize();

  // 実寸（1:1 等倍）表示
  const handleActualSize = useCallback(() => {
    if (!naturalSize) {
      setScale(1);
      setOffset({ x: 0, y: 0 });
      return;
    }
    const fit = getBaseFitSize();
    const targetScale = calculateActualSizeScale(naturalSize, fit.width > 0 ? fit : naturalSize);
    setScale(targetScale);
    setOffset({ x: 0, y: 0 });
  }, [naturalSize, getBaseFitSize]);

  // 全てリセット
  const handleResetAll = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
    setRotation(0);
    setFlipH(false);
    setFlipV(false);
  }, []);

  // ズームイン/ズームアウト
  const handleZoomIn = useCallback(() => {
    setScale((s) => calculateZoomScale(s, "in"));
  }, []);

  const handleZoomOut = useCallback(() => {
    setScale((s) => calculateZoomScale(s, "out"));
  }, []);

  // 回転操作
  const handleRotateCw = useCallback(() => setRotation((r) => (r + 90) % 360), []);
  const handleRotateCcw = useCallback(() => setRotation((r) => (r - 90 + 360) % 360), []);

  // 反転操作
  const handleToggleFlipH = useCallback(() => setFlipH((f) => !f), []);
  const handleToggleFlipV = useCallback(() => setFlipV((f) => !f), []);

  // ピクセル補間トグル
  const handleTogglePixelated = useCallback(() => setIsPixelated((p) => !p), []);

  // フルスクリーン切り替え
  const handleToggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      overlayRef.current?.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  }, []);

  // 画像をクリップボードにコピー（保存）
  const handleCopyImage = useCallback(async () => {
    if (!currentImage) return;
    const url = getImageViewUrl(currentImage.path);
    const success = await copyImageToClipboard(url);
    if (success) {
      setCopied(true);
      showSuccess("画像をクリップボードにコピーしました");
      setTimeout(() => setCopied(false), 2000);
    } else {
      showError("クリップボードへのコピーに失敗しました");
    }
  }, [currentImage, showSuccess, showError]);

  // 全画面イベント監視
  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  // マウスホイールによるポインター中心ズーム処理 (passive: false)
  useEffect(() => {
    if (!isOpen) return;
    const bodyEl = bodyRef.current;
    if (!bodyEl) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();

      const rect = bodyEl.getBoundingClientRect();
      const cursor: Point = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
      const containerSize = {
        width: rect.width,
        height: rect.height,
      };

      setScale((prevScale) => {
        const nextScale = calculateZoomScale(prevScale, e.deltaY);
        setOffset((prevOffset) =>
          calculateZoomOffset({
            cursor,
            containerSize,
            currentOffset: prevOffset,
            currentScale: prevScale,
            nextScale,
          })
        );
        return nextScale;
      });
    };

    bodyEl.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      bodyEl.removeEventListener("wheel", handleWheel);
    };
  }, [isOpen]);

  // ポインターによるドラッグ（パン）操作
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // 左クリックのみ
    if (e.button !== 0) return;

    isPointerDownRef.current = true;
    hasMovedRef.current = false;
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    startOffsetRef.current = { ...offset };

    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isPointerDownRef.current) return;

    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;

    if (!hasMovedRef.current && Math.hypot(dx, dy) > 4) {
      hasMovedRef.current = true;
      setIsDragging(true);
    }

    if (hasMovedRef.current) {
      setOffset(calculatePanOffset(startOffsetRef.current, { dx, dy }));
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isPointerDownRef.current) return;

    isPointerDownRef.current = false;
    setIsDragging(false);

    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ポインターキャプチャ解除時の例外は無視
    }
  };

  // 背景クリックによる閉じる制御（画像表示エリアの操作時はイベント伝播を遮断し勝手に閉じない）
  const handleBodyClick = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    hasMovedRef.current = false;
  };

  // オーバーレイ背景（モーダル外側）をクリックした時のみ閉じる
  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === overlayRef.current) {
      onClose();
    }
  };

  // ダブルクリックによるズーム切り替え（フィット ⇔ 実寸/拡大）
  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();

    if (scale !== 1 || offset.x !== 0 || offset.y !== 0) {
      handleFit();
    } else {
      // ダブルクリック位置を中心に拡大
      if (bodyRef.current) {
        const rect = bodyRef.current.getBoundingClientRect();
        const cursor: Point = {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        };
        const containerSize = {
          width: rect.width,
          height: rect.height,
        };
        const nextScale = 2.0;
        setScale(nextScale);
        setOffset(
          calculateZoomOffset({
            cursor,
            containerSize,
            currentOffset: offset,
            currentScale: scale,
            nextScale,
          })
        );
      } else {
        setScale(2.0);
      }
    }
  };

  // ミニマップ内のクリック/ドラッグによる視点移動
  const handleMinimapPointer = (
    e: React.MouseEvent<HTMLDivElement> | React.PointerEvent<HTMLDivElement>
  ) => {
    if (!minimapRef.current || !imgRef.current) return;
    const rect = minimapRef.current.getBoundingClientRect();
    const clickPct: Point = {
      x: Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100)),
      y: Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100)),
    };
    const contentSize = {
      width: imgRef.current.clientWidth,
      height: imgRef.current.clientHeight,
    };
    const nextOffset = calculateOffsetFromMinimapClick({
      clickPct,
      contentSize,
      scale,
    });
    setOffset(nextOffset);
  };

  // キーボードショートカット
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // モーダル外部（背後）の要素にフォーカスが残っていた場合はフォーカスを解除し、モーダルのキーボード操作として処理する
      if (overlayRef.current && !overlayRef.current.contains(e.target as Node)) {
        (document.activeElement as HTMLElement)?.blur?.();
      } else if (["INPUT", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName)) {
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key.toLowerCase() === "g") {
        e.preventDefault();
        e.stopPropagation();
        setViewMode((prev) => (prev === "single" ? "grid" : "single"));
      } else if (viewMode === "single") {
        // 単一プレビュー（拡大プレビュー）時：
        // 上キー（ArrowUp）でフォルダ内ファイルのグリッド表示に戻る
        if (e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          setViewMode("grid");
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          e.stopPropagation();
          handlePrev();
        } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          e.stopPropagation();
          handleNext();
        } else if (e.key === "+" || e.key === "=") {
          e.preventDefault();
          e.stopPropagation();
          handleZoomIn();
        } else if (e.key === "-") {
          e.preventDefault();
          e.stopPropagation();
          handleZoomOut();
        } else if (e.key === "0") {
          e.preventDefault();
          e.stopPropagation();
          handleFit();
        } else if (e.key === "1") {
          e.preventDefault();
          e.stopPropagation();
          handleActualSize();
        } else if (e.key.toLowerCase() === "r") {
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) handleRotateCcw();
          else handleRotateCw();
        } else if (e.key.toLowerCase() === "h") {
          e.preventDefault();
          e.stopPropagation();
          handleToggleFlipH();
        } else if (e.key.toLowerCase() === "v") {
          e.preventDefault();
          e.stopPropagation();
          handleToggleFlipV();
        } else if (e.key.toLowerCase() === "p") {
          e.preventDefault();
          e.stopPropagation();
          handleTogglePixelated();
        } else if (e.key.toLowerCase() === "f") {
          e.preventDefault();
          e.stopPropagation();
          handleToggleFullscreen();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
          e.preventDefault();
          e.stopPropagation();
          handleCopyImage();
        }
      } else if (viewMode === "grid") {
        // グリッド表示時：矢印キー（左右・上下）でカード選択移動、Enter/Returnで単一プレビュー展開
        // ※selectedGridIndexRef.current を即時更新し、1回のキー入力で確実に1歩移動
        const cols = getGridColumns();
        const total = siblingImagesRef.current.length;
        const cur = selectedGridIndexRef.current;
        let nextIdx = cur;

        if (e.key === "ArrowLeft") {
          e.preventDefault();
          e.stopPropagation();
          if (cur > 0) nextIdx = cur - 1;
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          e.stopPropagation();
          if (cur < total - 1) nextIdx = cur + 1;
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          if (cur - cols >= 0) nextIdx = cur - cols;
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          e.stopPropagation();
          if (cur + cols < total) nextIdx = cur + cols;
        } else if (e.key === "Enter" || e.key === "Return") {
          e.preventDefault();
          e.stopPropagation();
          const target = siblingImagesRef.current[cur];
          if (target) {
            if (onNavigateRef.current) onNavigateRef.current(target);
            setViewMode("single");
          }
          return;
        }

        if (nextIdx !== cur) {
          selectedGridIndexRef.current = nextIdx;
          setSelectedGridIndex(nextIdx);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [
    isOpen,
    onClose,
    handlePrev,
    handleNext,
    selectedGridIndex,
    siblingImages,
    getGridColumns,
    onNavigate,
    activeImage,
    handleZoomIn,
    handleZoomOut,
    handleFit,
    handleActualSize,
    handleRotateCw,
    handleRotateCcw,
    handleToggleFlipH,
    handleToggleFlipV,
    handleTogglePixelated,
    handleToggleFullscreen,
    handleCopyImage,
    viewMode,
  ]);

  if (!isOpen) return null;

  // 単一表示モードで表示対象の画像がない場合、かつ画像が1件もなければ閉じる
  if (viewMode === "single" && !activeImage) {
    if (siblingImages.length === 0) return null;
  }

  const imageUrl = activeImage ? getImageViewUrl(activeImage.path) : "";

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
  };

  const handleDownload = () => {
    if (!activeImage) return;
    const a = document.createElement("a");
    a.href = imageUrl;
    a.download = activeImage.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleOpenExternal = () => {
    if (!activeImage) return;
    window.open(imageUrl, "_blank", "noopener,noreferrer");
  };

  // ミニマップの矩形計算
  const minimapRect =
    scale > 1.05 && imgRef.current && bodyRef.current
      ? calculateMinimapViewport({
          viewportSize: {
            width: bodyRef.current.clientWidth,
            height: bodyRef.current.clientHeight,
          },
          contentSize: {
            width: imgRef.current.clientWidth,
            height: imgRef.current.clientHeight,
          },
          scale,
          offset,
        })
      : null;

  const transformStyle = `translate(${offset.x}px, ${offset.y}px) scale(${scale * (flipH ? -1 : 1)}, ${scale * (flipV ? -1 : 1)}) rotate(${rotation}deg)`;

  // 高解像度レンダリング用スタイル: 自然解像度(naturalSize)に基づく最適基準サイズ(baseFitSize)を適用し文字ボケを防止
  const dynamicImgStyle: React.CSSProperties = baseFitSize.width > 0 ? {
    width: `${baseFitSize.width}px`,
    height: `${baseFitSize.height}px`,
    maxWidth: "none",
    maxHeight: "none",
  } : {};

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      className={`image-preview-overlay ${isFullscreen ? "fullscreen" : ""}`}
      onClick={handleOverlayClick}
    >
      {viewMode === "grid" ? (
        <>
          {/* グリッドヘッダー */}
          <div className="image-preview-header" onClick={(e) => e.stopPropagation()}>
            <div className="image-preview-title">
              <span className="image-preview-filename">
                画像一覧
              </span>
              <span className="image-preview-counter">
                全 {effectiveImages.length} 件の画像
                {depth > 0 && <span className="depth-badge">（{depth}階層下まで）</span>}
              </span>
            </div>

            <div className="image-preview-actions">
              {/* 階層指定コントローラー */}
              <div className="image-preview-depth-stepper" title="階層数を指定（0=直下のみ、1以上=サブフォルダの画像も含める）">
                <span className="depth-label">階層:</span>
                <button
                  type="button"
                  className="image-preview-step-btn"
                  disabled={depth <= 0 || isLoadingImages}
                  onClick={() => handleDepthChange(depth - 1)}
                  title="階層を減らす"
                >
                  -
                </button>
                <span className="depth-value">{isLoadingImages ? "..." : depth}</span>
                <button
                  type="button"
                  className="image-preview-step-btn"
                  disabled={depth >= 5 || isLoadingImages}
                  onClick={() => handleDepthChange(depth + 1)}
                  title="階層を増やす"
                >
                  +
                </button>
              </div>

              {/* サムネイルサイズ切替 */}
              <div className="image-preview-size-selector">
                <button
                  className={`image-preview-pill-btn ${gridThumbnailSize === "small" ? "active" : ""}`}
                  onClick={() => setGridThumbnailSize("small")}
                  title="小サムネイル"
                >
                  小
                </button>
                <button
                  className={`image-preview-pill-btn ${gridThumbnailSize === "medium" ? "active" : ""}`}
                  onClick={() => setGridThumbnailSize("medium")}
                  title="中サムネイル"
                >
                  中
                </button>
                <button
                  className={`image-preview-pill-btn ${gridThumbnailSize === "large" ? "active" : ""}`}
                  onClick={() => setGridThumbnailSize("large")}
                  title="大サムネイル"
                >
                  大
                </button>
              </div>

              {/* 単一表示に戻る（activeImageがある場合） */}
              {activeImage && (
                <button
                  className="image-preview-btn"
                  onClick={() => setViewMode("single")}
                  title="詳細プレビュー表示 (G)"
                >
                  <Eye size={16} />
                </button>
              )}

              {/* フルスクリーン */}
              <button
                className="image-preview-btn"
                onClick={handleToggleFullscreen}
                title={isFullscreen ? "フルスクリーン解除 (F)" : "フルスクリーン表示 (F)"}
              >
                {isFullscreen ? <Minimize2 size={16} /> : <Maximize size={16} />}
              </button>

              {/* ショートカットヘルプ */}
              <button
                className={`image-preview-btn ${showShortcuts ? "active" : ""}`}
                onClick={() => setShowShortcuts((s) => !s)}
                title="操作ヘルプ"
              >
                <HelpCircle size={16} />
              </button>

              {/* 閉じる */}
              <button
                className="image-preview-btn close"
                onClick={onClose}
                title="閉じる (Esc)"
              >
                <X size={18} />
              </button>
            </div>
          </div>

          {/* ショートカットヘルプ */}
          {showShortcuts && (
            <div
              className="image-preview-shortcuts-panel"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="shortcuts-title">操作ガイド & ショートカット</div>
              <div className="shortcuts-grid">
                <span className="key">↑ / ↓ / ← / →</span>
                <span className="desc">画像カードを選択移動</span>
                <span className="key">Enter / Return</span>
                <span className="desc">選択した画像を単一プレビューで開く</span>
                <span className="key">サムネイルクリック</span>
                <span className="desc">画像を単一プレビューで開く</span>
                <span className="key">G</span>
                <span className="desc">グリッド表示 ⇔ 単一表示の切替</span>
                <span className="key">F</span>
                <span className="desc">フルスクリーントグル</span>
                <span className="key">Esc</span>
                <span className="desc">プレビューを閉じる</span>
              </div>
            </div>
          )}

          {/* グリッドボディ */}
          <div
            ref={gridContainerRef}
            className="image-preview-grid-body"
            onClick={handleBodyClick}
          >
            {effectiveImages.length === 0 ? (
              <div className="image-preview-empty">
                <p>{isLoadingImages ? "画像を検索中..." : "このフォルダ内に画像はありません"}</p>
              </div>
            ) : (
              <div className={`image-preview-grid size-${gridThumbnailSize}`}>
                {effectiveImages.map((img, index) => {
                  const isSelected = index === selectedGridIndex;
                  const thumbUrl = getImageViewUrl(img.path);
                  const hasSubfolder = img.relativePath && img.relativePath !== img.name;
                  return (
                    <div
                      key={img.path}
                      ref={(el) => {
                        cardRefs.current[index] = el;
                      }}
                      className={`grid-card ${isSelected ? "selected" : ""}`}
                      onClick={() => handleSelectImage(img, index)}
                      title={`${img.relativePath || img.name} (${formatFileSize(img.size)}) - クリックまたはEnterで拡大プレビュー`}
                    >
                      <div className="grid-thumbnail-wrapper">
                        <img
                          src={thumbUrl}
                          alt={img.name}
                          className="grid-thumbnail"
                          loading="lazy"
                        />
                      </div>
                      <div className="grid-info">
                        <span className="grid-filename" title={img.name}>{img.name}</span>
                        {hasSubfolder && (
                          <span className="grid-subfolder" title={img.relativePath}>
                            📁 {img.relativePath?.split("/").slice(0, -1).join("/")}
                          </span>
                        )}
                        <span className="grid-filesize">{formatFileSize(img.size)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* グリッドフッター */}
          <div className="image-preview-footer" onClick={(e) => e.stopPropagation()}>
            <div className="image-preview-meta">
              <span className="meta-item">全 {effectiveImages.length} 枚の画像</span>
              {depth > 0 && <span className="meta-item">（階層: {depth}）</span>}
            </div>
            <div className="image-preview-controls">
              <button
                className="image-preview-pill-btn active"
                onClick={() => setViewMode("grid")}
              >
                グリッド表示
              </button>
              {activeImage && (
                <button
                  className="image-preview-pill-btn"
                  onClick={() => setViewMode("single")}
                >
                  単一表示
                </button>
              )}
            </div>
          </div>
        </>
      ) : (
        <>
          {/* ヘッダーツールバー */}
          <div className="image-preview-header" onClick={(e) => e.stopPropagation()}>
            <div className="image-preview-title">
              <span className="image-preview-filename" title={activeImage?.relativePath || activeImage?.name || ""}>
                {activeImage?.name || ""}
                {activeImage?.relativePath && activeImage.relativePath !== activeImage.name && (
                  <span className="preview-subfolder-badge">（{activeImage.relativePath}）</span>
                )}
              </span>
              {effectiveImages.length > 0 && currentIndex >= 0 && (
                <span className="image-preview-counter">
                  {currentIndex + 1} / {effectiveImages.length}
                </span>
              )}
            </div>

            <div className="image-preview-actions">
              {/* グリッド表示切替ボタン（上キーでも戻れる） */}
              {effectiveImages.length > 0 && (
                <button
                  className="image-preview-btn"
                  onClick={() => setViewMode("grid")}
                  title="グリッド表示に戻る (↑ / G)"
                >
                  <LayoutGrid size={16} />
                </button>
              )}

              {/* 反転（水平・垂直） */}
              <button
                className={`image-preview-btn ${flipH ? "active" : ""}`}
                onClick={handleToggleFlipH}
                title="左右反転 (H)"
              >
                <FlipHorizontal size={16} />
              </button>
              <button
                className={`image-preview-btn ${flipV ? "active" : ""}`}
                onClick={handleToggleFlipV}
                title="上下反転 (V)"
              >
                <FlipVertical size={16} />
              </button>

              {/* 回転（反時計・時計） */}
              <button
                className="image-preview-btn"
                onClick={handleRotateCcw}
                title="反時計回りに90°回転 (Shift+R)"
              >
                <RotateCcw size={16} />
              </button>
              <button
                className="image-preview-btn"
                onClick={handleRotateCw}
                title="時計回りに90°回転 (R)"
              >
                <RotateCw size={16} />
              </button>

              {/* ピクセル補間切り替え */}
              <button
                className={`image-preview-btn ${isPixelated ? "active" : ""}`}
                onClick={handleTogglePixelated}
                title={`ピクセル補間: ${isPixelated ? "ドット強調 (ON)" : "スムーズ (OFF)"} (P)`}
              >
                <Sparkles size={16} />
              </button>

              {/* ミニマップトグル */}
              {scale > 1.05 && (
                <button
                  className={`image-preview-btn ${showMinimap ? "active" : ""}`}
                  onClick={() => setShowMinimap((s) => !s)}
                  title="ミニマップ表示切替"
                >
                  <MapPin size={16} />
                </button>
              )}

              {/* フルスクリーン */}
              <button
                className="image-preview-btn"
                onClick={handleToggleFullscreen}
                title={isFullscreen ? "フルスクリーン解除 (F)" : "フルスクリーン表示 (F)"}
              >
                {isFullscreen ? <Minimize2 size={16} /> : <Maximize size={16} />}
              </button>

              {/* クリップボードに保存 */}
              <button
                className={`image-preview-btn ${copied ? "copied" : ""}`}
                onClick={handleCopyImage}
                title={copied ? "クリップボードにコピー完了" : "クリップボードに保存 (Ctrl+C / Cmd+C)"}
              >
                {copied ? <Check size={16} color="#10b981" /> : <Copy size={16} />}
              </button>

              {/* ダウンロード */}
              <button
                className="image-preview-btn"
                onClick={handleDownload}
                title="ダウンロード"
              >
                <Download size={16} />
              </button>

              {/* 別タブで開く */}
              <button
                className="image-preview-btn"
                onClick={handleOpenExternal}
                title="ブラウザの別タブで開く"
              >
                <ExternalLink size={16} />
              </button>

              {/* ショートカットヘルプ */}
              <button
                className={`image-preview-btn ${showShortcuts ? "active" : ""}`}
                onClick={() => setShowShortcuts((s) => !s)}
                title="操作ヘルプ"
              >
                <HelpCircle size={16} />
              </button>

              {/* 閉じる */}
              <button
                className="image-preview-btn close"
                onClick={onClose}
                title="閉じる (Esc)"
              >
                <X size={18} />
              </button>
            </div>
          </div>

      {/* ショートカットヘルプポップアップ */}
      {showShortcuts && (
        <div
          className="image-preview-shortcuts-panel"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="shortcuts-title">操作ガイド & ショートカット</div>
          <div className="shortcuts-grid">
            <span className="key">ホイール</span>
            <span className="desc">カーソル位置を中心に拡大/縮小</span>
            <span className="key">ドラッグ</span>
            <span className="desc">画像を自由にパン移動</span>
            <span className="key">ダブルクリック</span>
            <span className="desc">フィット ⇔ 拡大をトグル</span>
            <span className="key">+ / -</span>
            <span className="desc">ズームイン / ズームアウト</span>
            <span className="key">0</span>
            <span className="desc">画面にフィット (リセット)</span>
            <span className="key">1</span>
            <span className="desc">実寸等倍 (1:1 100%)</span>
            <span className="key">Ctrl+C / ⌘C</span>
            <span className="desc">クリップボードに保存（コピー）</span>
            <span className="key">R / Shift+R</span>
            <span className="desc">時計回り / 反時計回りに90°回転</span>
            <span className="key">H / V</span>
            <span className="desc">左右反転 / 上下反転</span>
            <span className="key">P</span>
            <span className="desc">ピクセル補間（ドット強調）切替</span>
            <span className="key">↑ / G</span>
            <span className="desc">フォルダ内ファイルのグリッド表示に戻る</span>
            <span className="key">← / →</span>
            <span className="desc">前後の画像へ移動</span>
            <span className="key">Esc</span>
            <span className="desc">ビューワーを閉じる</span>
          </div>
        </div>
      )}

      {/* メインプレビュー領域 */}
      <div
        ref={bodyRef}
        className={`image-preview-body ${isDragging ? "dragging" : ""}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={handleBodyClick}
      >
        {/* 前へナビゲーションボタン */}
        {hasPrev && (
          <button
            className="image-preview-nav-btn prev"
            onClick={(e) => {
              e.stopPropagation();
              handlePrev();
            }}
            title="前の画像 (←)"
          >
            <ChevronLeft size={32} />
          </button>
        )}

        {/* 画像コンテナ */}
        <div
          className="image-preview-container"
          style={{
            transform: transformStyle,
            transition: isDragging ? "none" : "transform 0.12s ease-out",
          }}
          onDoubleClick={handleDoubleClick}
        >
          <img
            ref={imgRef}
            src={imageUrl}
            alt={activeImage?.name || ""}
            className={`image-preview-img ${isPixelated ? "pixelated" : ""}`}
            style={dynamicImgStyle}
            onLoad={handleImageLoad}
            draggable={false}
          />
        </div>

        {/* 次へナビゲーションボタン */}
        {hasNext && (
          <button
            className="image-preview-nav-btn next"
            onClick={(e) => {
              e.stopPropagation();
              handleNext();
            }}
            title="次の画像 (→)"
          >
            <ChevronRight size={32} />
          </button>
        )}

        {/* ミニマップ（拡大時ナビゲーター） */}
        {showMinimap && minimapRect && (
          <div
            ref={minimapRef}
            className="image-preview-minimap"
            onClick={(e) => {
              e.stopPropagation();
              handleMinimapPointer(e);
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              handleMinimapPointer(e);
            }}
            title="クリックまたはドラッグで視点移動"
          >
            <img
              src={imageUrl}
              alt="Minimap"
              className="image-preview-minimap-img"
              draggable={false}
            />
            <div
              className="image-preview-minimap-rect"
              style={{
                left: `${minimapRect.leftPct}%`,
                top: `${minimapRect.topPct}%`,
                width: `${minimapRect.widthPct}%`,
                height: `${minimapRect.heightPct}%`,
              }}
            />
          </div>
        )}
      </div>

      {/* フッター（メタデータ・ズーム操作） */}
      <div className="image-preview-footer" onClick={(e) => e.stopPropagation()}>
        {/* メタデータ */}
        <div className="image-preview-meta">
          {naturalSize && (
            <>
              <span className="meta-item">
                {naturalSize.width} × {naturalSize.height} px
              </span>
              {formatAspectRatio(naturalSize.width, naturalSize.height) && (
                <span className="meta-item aspect">
                  {formatAspectRatio(naturalSize.width, naturalSize.height)}
                </span>
              )}
            </>
          )}
          <span className="meta-item">{formatFileSize(activeImage?.size)}</span>
        </div>

        {/* コントロール群 */}
        <div className="image-preview-controls">
          <button
            className="image-preview-btn"
            onClick={handleZoomOut}
            title="縮小 (-)"
          >
            <ZoomOut size={16} />
          </button>

          {/* ズーム倍率ボタン＆ポップアップ */}
          <div className="image-preview-zoom-wrapper">
            <button
              className="image-preview-zoom-btn"
              onClick={() => setShowPresets((p) => !p)}
              title="ズームプリセット"
            >
              {Math.round(scale * 100)}%
            </button>
            {showPresets && (
              <div className="image-preview-presets-dropdown">
                <button
                  className="preset-item"
                  onClick={() => {
                    handleFit();
                    setShowPresets(false);
                  }}
                >
                  フィット (Fit)
                </button>
                <button
                  className="preset-item"
                  onClick={() => {
                    handleActualSize();
                    setShowPresets(false);
                  }}
                >
                  実寸 (1:1 100%)
                </button>
                <div className="preset-divider" />
                {ZOOM_PRESETS.map((p) => (
                  <button
                    key={p}
                    className={`preset-item ${Math.abs(scale - p) < 0.05 ? "active" : ""}`}
                    onClick={() => {
                      setScale(p);
                      setShowPresets(false);
                    }}
                  >
                    {Math.round(p * 100)}%
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            className="image-preview-btn"
            onClick={handleZoomIn}
            title="拡大 (+)"
          >
            <ZoomIn size={16} />
          </button>

          <div className="control-separator" />

          {/* 実寸ボタン */}
          <button
            className="image-preview-pill-btn"
            onClick={handleActualSize}
            title="100% 等倍実寸で表示 (1)"
          >
            1:1
          </button>

          {/* フィットボタン */}
          <button
            className="image-preview-pill-btn"
            onClick={handleFit}
            title="画面全体に収まるようフィット (0)"
          >
            フィット
          </button>

          {/* 全リセットボタン */}
          <button
            className="image-preview-btn"
            onClick={handleResetAll}
            title="表示・回転・反転を初期化"
          >
            <Maximize2 size={16} />
          </button>
        </div>
      </div>
        </>
      )}
    </div>
  );
}
