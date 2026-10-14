/**
 * SVGエクスポート
 *
 * 選択中の要素（未選択なら全要素）をSVGとして図面と同じフォルダに保存する。
 * 書き出したSVGをブラウザで開いたときにリンクがクリックしやすいよう、
 * 同じリンクを持つテキストのアンカーを結合し、透明な当たり判定矩形を追加する。
 */
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import { exportToSvg } from "@excalidraw/excalidraw";
import { saveSvgFile } from "./backendApi";
import { normalizePath } from "./pathUtils";

const SVG_NS = 'http://www.w3.org/2000/svg';

const isTransparentFill = (shape: SVGGraphicsElement): boolean => {
  const fill = shape.getAttribute('fill');
  if (!fill || fill === 'none') {
    return true;
  }

  const fillOpacityAttr = shape.getAttribute('fill-opacity');
  const opacityAttr = shape.getAttribute('opacity');

  let fillOpacity = fillOpacityAttr !== null ? parseFloat(fillOpacityAttr) : 1;
  let opacity = opacityAttr !== null ? parseFloat(opacityAttr) : 1;

  if (Number.isNaN(fillOpacity)) {
    fillOpacity = 1;
  }
  if (Number.isNaN(opacity)) {
    opacity = 1;
  }

  return fillOpacity * opacity === 0;
};

const mergeAdjacentTextAnchors = (svg: SVGSVGElement): void => {
  const anchors = Array.from(svg.querySelectorAll<SVGAElement>('a[href]'));

  const isTextGroup = (element: Element | null): element is SVGGElement => {
    return element instanceof SVGGElement && !!element.querySelector('text');
  };

  anchors.forEach(anchor => {
    if (anchor.querySelector('text')) {
      return;
    }

    const href = anchor.getAttribute('href');
    if (!href) {
      return;
    }

    let sibling = anchor.nextElementSibling;
    while (sibling) {
      if (sibling instanceof SVGAElement) {
        if (sibling.getAttribute('href') !== href) {
          break;
        }

        const textGroup = Array.from(sibling.children).find(child => child instanceof SVGGElement) as SVGGElement | undefined;
        if (textGroup && textGroup.querySelector('text')) {
          anchor.appendChild(textGroup);
        }

        const remainingChildren = sibling.childNodes.length;
        sibling.remove();

        if (remainingChildren === 0) {
          break;
        }

        sibling = anchor.nextElementSibling;
        continue;
      }

      if (isTextGroup(sibling)) {
        anchor.appendChild(sibling);
        sibling = anchor.nextElementSibling;
        continue;
      }

      break;
    }
  });
};

const addClickableOverlays = (svg: SVGSVGElement): void => {
  if (typeof document === 'undefined' || !document.body) {
    return;
  }

  const anchors = Array.from(svg.querySelectorAll<SVGAElement>('a[href]'));
  if (anchors.length === 0) {
    return;
  }

  const tempContainer = document.createElement('div');
  tempContainer.style.position = 'absolute';
  tempContainer.style.width = '0';
  tempContainer.style.height = '0';
  tempContainer.style.overflow = 'hidden';
  tempContainer.style.opacity = '0';
  tempContainer.style.pointerEvents = 'none';
  document.body.appendChild(tempContainer);

  const originalParent = svg.parentNode;
  tempContainer.appendChild(svg);

  anchors.forEach(anchor => {
    if (anchor.querySelector(':scope > rect[data-excalidraw-overlay="true"]')) {
      return;
    }

    const hasText = !!anchor.querySelector('text');
    const shapes = Array.from(anchor.querySelectorAll<SVGGraphicsElement>('path, rect, ellipse, circle, polygon, polyline'));
    const needsOverlay = hasText || shapes.some(isTransparentFill);

    if (!needsOverlay) {
      return;
    }

    let bbox: DOMRect;
    try {
      bbox = anchor.getBBox();
    } catch (error) {
      return;
    }

    if (!bbox.width || !bbox.height) {
      return;
    }

    const overlay = svg.ownerDocument.createElementNS(SVG_NS, 'rect');
    overlay.setAttribute('x', bbox.x.toString());
    overlay.setAttribute('y', bbox.y.toString());
    overlay.setAttribute('width', bbox.width.toString());
    overlay.setAttribute('height', bbox.height.toString());
    overlay.setAttribute('fill', '#ffffff');
    overlay.setAttribute('fill-opacity', '0');
    overlay.setAttribute('stroke', 'none');
    overlay.setAttribute('pointer-events', 'fill');
    overlay.setAttribute('data-excalidraw-overlay', 'true');

    const firstElementChild = anchor.firstElementChild;
    if (firstElementChild && firstElementChild.tagName.toLowerCase() === 'mask') {
      anchor.insertBefore(overlay, firstElementChild.nextSibling);
    } else {
      anchor.insertBefore(overlay, firstElementChild || null);
    }
  });

  tempContainer.removeChild(svg);
  if (originalParent instanceof Element) {
    originalParent.appendChild(svg);
  }
  tempContainer.remove();
};

export const enhanceSvgLinks = (svg: SVGSVGElement | null): void => {
  if (!svg) {
    return;
  }

  mergeAdjacentTextAnchors(svg);
  addClickableOverlays(svg);
};

/** SVG書き出し時に足りない描画設定を補う（テキストが表示されないことを防ぐ） */
export const withSvgExportDefaults = (appState: Partial<AppState>): Partial<AppState> => ({
  ...appState,
  exportBackground: true,
  exportWithDarkMode: false,
  exportEmbedScene: false,
  currentItemFontFamily: appState.currentItemFontFamily || 1,
  currentItemFontSize: appState.currentItemFontSize || 20,
  currentItemStrokeColor: appState.currentItemStrokeColor || '#000000',
  currentItemOpacity: appState.currentItemOpacity || 100,
});

/**
 * エクスポート対象の要素を決める。
 * 選択がある場合は、選択した図形に結び付いたテキスト（付箋の文字など）も含める。
 * 図形にリンクがあれば、結び付いたテキストにも同じリンクを付ける（SVG上でクリック可能にするため）。
 * 元の要素は変更せず、複製を返す。
 */
export const collectElementsForSvgExport = (
  elements: readonly NonDeletedExcalidrawElement[],
  selectedElements: readonly NonDeletedExcalidrawElement[] | null,
): NonDeletedExcalidrawElement[] => {
  let targets: readonly NonDeletedExcalidrawElement[] = elements;
  if (selectedElements && selectedElements.length > 0) {
    const selectedIds = new Set(selectedElements.map((element) => element.id));
    const boundTexts = elements.filter((element) =>
      element.type === 'text'
      && element.containerId
      && selectedIds.has(element.containerId)
      && !selectedIds.has(element.id),
    );
    targets = [...selectedElements, ...boundTexts];
  }

  const clones = targets.map((element) => ({ ...element })) as NonDeletedExcalidrawElement[];
  const cloneById = new Map(clones.map((element) => [element.id, element]));

  for (const clone of clones) {
    if (!clone.link) {
      continue;
    }
    for (const element of elements) {
      if (element.type === 'text' && element.containerId === clone.id) {
        const textClone = cloneById.get(element.id) as { link: string | null } | undefined;
        if (textClone && !textClone.link) {
          textClone.link = clone.link;
        }
      }
    }
  }

  return clones;
};

/**
 * ファイル名を入力させてSVGを保存する。
 * @returns 保存した場合 true（キャンセル・失敗時は false）
 */
export const exportToSvgFile = async (
  elements: readonly NonDeletedExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
  currentFolder: string | null,
  selectedElements: readonly NonDeletedExcalidrawElement[] | null = null,
): Promise<boolean> => {
  try {
    const fileName = prompt('SVGファイル名を入力してください（拡張子なし）:');
    if (!fileName || !fileName.trim()) {
      return false;
    }

    const svg = await exportToSvg({
      elements: collectElementsForSvgExport(elements, selectedElements),
      appState: withSvgExportDefaults(appState),
      files,
      exportPadding: 10,
      metadata: '',
    });
    enhanceSvgLinks(svg);

    const folder = currentFolder ? normalizePath(currentFolder) : '.';
    await saveSvgFile(`${folder}/${fileName.trim()}.svg`, new XMLSerializer().serializeToString(svg));
    return true;
  } catch (error) {
    console.error('Error saving SVG file:', error);
    return false;
  }
};
