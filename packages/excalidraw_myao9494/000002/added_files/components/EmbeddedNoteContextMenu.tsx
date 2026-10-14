/**
 * 埋め込まれた Obsidian ノート（画像）の右クリックメニュー
 *
 * Markdown ノートを埋め込んだ画像を右クリックしたときだけ、Excalidraw 標準のメニューの
 * 代わりに「webアプリで編集」「obsidianで表示」を表示する。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { viewportCoordsToSceneCoords } from '@excalidraw/excalidraw';
import { openPathWithFallback } from '../utils/linkHandler';
import { openFileInNewTab } from '../utils/pathUtils';

interface MenuState {
  left: number;
  top: number;
  sourcePath: string;
}

type ImageElement = Extract<NonDeletedExcalidrawElement, { type: 'image' }>;

/** シーン座標の点が（回転を考慮して）画像要素の内側にあるか */
const isPointInsideElement = (element: ImageElement, point: { x: number; y: number }): boolean => {
  const deltaX = point.x - (element.x + element.width / 2);
  const deltaY = point.y - (element.y + element.height / 2);
  const cos = Math.cos(-element.angle);
  const sin = Math.sin(-element.angle);
  const localX = deltaX * cos - deltaY * sin + element.width / 2;
  const localY = deltaX * sin + deltaY * cos + element.height / 2;
  return localX >= 0 && localX <= element.width && localY >= 0 && localY <= element.height;
};

export const useEmbeddedNoteContextMenu = (
  excalidrawAPI: ExcalidrawImperativeAPI | null,
  embeddedFilePathsRef: React.MutableRefObject<Record<string, string>>,
) => {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const pointerDownSourcePathRef = useRef<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setMenu(null), []);

  // 右クリック時に Excalidraw が判定した要素から、埋め込み元ノートを取得する
  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    return excalidrawAPI.onPointerDown((_activeTool, pointerDownState, event) => {
      if (event.button !== 2) {
        return;
      }
      const hitElement = pointerDownState.hit.element;
      const fileId = hitElement?.type === 'image' ? hitElement.fileId : undefined;
      pointerDownSourcePathRef.current = fileId ? embeddedFilePathsRef.current[fileId] || null : null;
    });
  }, [excalidrawAPI, embeddedFilePathsRef]);

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenu(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenu(null);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  const findSourcePath = useCallback((event: React.MouseEvent): string | null => {
    const fromPointerDown = pointerDownSourcePathRef.current;
    pointerDownSourcePathRef.current = null;
    if (fromPointerDown || !excalidrawAPI) {
      return fromPointerDown;
    }

    const files = excalidrawAPI.getFiles() as Record<string, { sourcePath?: string } | undefined>;
    const sourcePathOf = (image: ImageElement) =>
      embeddedFilePathsRef.current[image.fileId ?? ''] || files[image.fileId ?? '']?.sourcePath || null;
    const elements = excalidrawAPI.getSceneElements();

    // pointerdown の判定が取れない場合は、右クリック位置にある最前面の画像から判定する
    const scenePoint = viewportCoordsToSceneCoords(
      { clientX: event.clientX, clientY: event.clientY },
      excalidrawAPI.getAppState(),
    );
    const imageAtPoint = [...elements].reverse().find(
      (element): element is ImageElement => element.type === 'image' && isPointInsideElement(element, scenePoint),
    );
    if (imageAtPoint && sourcePathOf(imageAtPoint)) {
      return sourcePathOf(imageAtPoint);
    }

    // 右クリックで先に選択された場合は、選択中の埋め込み画像から判定する
    const { selectedElementIds } = excalidrawAPI.getAppState();
    const selectedImage = elements.find(
      (element): element is ImageElement =>
        element.type === 'image' && Boolean(selectedElementIds[element.id]) && Boolean(sourcePathOf(element)),
    );
    return selectedImage ? sourcePathOf(selectedImage) : null;
  }, [excalidrawAPI, embeddedFilePathsRef]);

  /** キャンバスの onContextMenuCapture に渡すハンドラー */
  const handleContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const sourcePath = findSourcePath(event);
    if (!sourcePath) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setMenu({
      left: Math.min(event.clientX, Math.max(8, window.innerWidth - 228)),
      top: Math.min(event.clientY, Math.max(8, window.innerHeight - 100)),
      sourcePath,
    });
  }, [findSourcePath]);

  return { menu, menuRef, closeMenu, handleContextMenu };
};

export interface EmbeddedNoteContextMenuProps {
  menu: MenuState | null;
  menuRef: React.RefObject<HTMLDivElement>;
  onClose: () => void;
}

export const EmbeddedNoteContextMenu: React.FC<EmbeddedNoteContextMenuProps> = ({ menu, menuRef, onClose }) => {
  if (!menu) {
    return null;
  }

  const openInWebApp = () => {
    openFileInNewTab(menu.sourcePath);
    onClose();
  };

  const openInObsidian = () => {
    onClose();
    // port 8001 の open-path が、Vault 内の Markdown を obsidian://open?... に変換して起動する
    const redirectWindow = window.open('about:blank', '_blank');
    void openPathWithFallback(menu.sourcePath, redirectWindow).catch((error) => {
      console.error('Error opening embedded note in Obsidian:', error);
      if (redirectWindow && !redirectWindow.closed) {
        redirectWindow.close();
      }
      window.alert('Obsidianでノートを開けませんでした。');
    });
  };

  return (
    <div
      ref={menuRef}
      className="embedded-image-context-menu"
      style={{ left: menu.left, top: menu.top }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button type="button" onClick={openInWebApp}>webアプリで編集</button>
      <button type="button" onClick={openInObsidian}>obsidianで表示</button>
    </div>
  );
};
