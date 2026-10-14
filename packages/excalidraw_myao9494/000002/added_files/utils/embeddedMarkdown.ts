/**
 * Obsidian の Excalidraw ノート(Markdown)を画像として埋め込んだ図面の表示サポート
 *
 * Obsidian では別の Excalidraw ノートを `[[ノート名]]` で画像として埋め込める。
 * バックエンドは Embedded Files のリンク先を解決して `embeddedFilePaths` で返すので、
 * フロントエンドでリンク先ノートを読み込み、SVGスナップショットに変換して表示する。
 *
 * - 生成したSVGには `isEmbeddedMarkdownSnapshot: true` を付ける。
 *   バックエンドは保存時にこのフラグを見て、外部SVGとして書き出さない。
 * - Obsidian が保存したSVGスナップショットしか残っていない場合は、
 *   同じフォルダの候補ノートを描画して形状を比較し、元ノートを特定する。
 */
import { exportToSvg } from "@excalidraw/excalidraw";
import { loadExcalidrawFile, type ExcalidrawFileData, type LoadFileResponse } from "./backendApi";
import { withSvgExportDefaults } from "./svgExport";

export const svgToDataUrl = (svg: SVGSVGElement): string => {
  const utf8 = new TextEncoder().encode(new XMLSerializer().serializeToString(svg));
  let binary = '';
  // 大きなSVGで引数の上限を超えないよう分割して変換する
  for (let index = 0; index < utf8.length; index += 0x8000) {
    binary += String.fromCharCode(...Array.from(utf8.subarray(index, index + 0x8000)));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
};

export const svgDataUrlToText = (dataUrl: string): string | null => {
  const separator = dataUrl.indexOf(',');
  if (separator < 0) {
    return null;
  }

  const encoded = dataUrl.slice(separator + 1);
  if (dataUrl.slice(0, separator).endsWith(';base64')) {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  return decodeURIComponent(encoded);
};

const SHAPE_ATTRIBUTES = [
  'd', 'x', 'y', 'width', 'height', 'rx', 'ry', 'points', 'transform',
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'fill-opacity', 'stroke-opacity',
];

/** SVGのサイズやメタデータを除き、描画形状だけを比較できる署名を返す */
export const svgShapeSignature = (svg: string | SVGSVGElement): string | null => {
  const svgText = typeof svg === 'string' ? svg : new XMLSerializer().serializeToString(svg);
  const root = new DOMParser().parseFromString(svgText, 'image/svg+xml').documentElement;
  if (!root || root.tagName.toLowerCase() !== 'svg') {
    return null;
  }

  const shapes = Array.from(root.querySelectorAll('path, rect, ellipse, circle, polygon, polyline, line'))
    .map((element) => [
      element.tagName.toLowerCase(),
      ...SHAPE_ATTRIBUTES.map((attribute) => element.getAttribute(attribute) || ''),
    ]);

  return JSON.stringify({ viewBox: root.getAttribute('viewBox') || '', shapes });
};

/** 読み込んだノートを、埋め込み表示用のSVGに描画する */
const renderNoteToSvg = async (
  note: LoadFileResponse,
  visitedPaths: Set<string>,
): Promise<SVGSVGElement | null> => {
  if (!note?.data || !Array.isArray(note.data.elements)) {
    return null;
  }

  const childVisitedPaths = new Set(visitedPaths);
  if (note.resolvedPath) {
    childVisitedPaths.add(note.resolvedPath);
  }
  const childFiles = await hydrateEmbeddedMarkdownFiles(
    note.data,
    note.embeddedFilePaths,
    childVisitedPaths,
  );

  const appState = note.data.appState || {};
  return exportToSvg({
    elements: note.data.elements.filter((element) => !element.isDeleted),
    appState: withSvgExportDefaults({
      ...appState,
      viewBackgroundColor: appState.viewBackgroundColor || '#ffffff',
    }),
    files: childFiles,
    exportPadding: 10,
    metadata: '',
  });
};

/**
 * Markdownノートの埋め込みを、Excalidrawが表示できるSVG画像に変換した files を返す。
 * 入れ子の埋め込みも再帰的に描画する（循環参照は visitedPaths で防ぐ）。
 */
export const hydrateEmbeddedMarkdownFiles = async (
  fileData: ExcalidrawFileData,
  embeddedFilePaths: Record<string, string> = {},
  visitedPaths: Set<string> = new Set(),
): Promise<Record<string, any>> => {
  const files: Record<string, any> = { ...(fileData.files || {}) };

  for (const [fileId, sourcePath] of Object.entries(embeddedFilePaths)) {
    if (files[fileId]) {
      files[fileId] = { ...files[fileId], sourcePath };
    }

    if (!sourcePath.toLowerCase().endsWith('.md') || visitedPaths.has(sourcePath)) {
      continue;
    }

    try {
      const note = await loadExcalidrawFile(sourcePath);
      if (!note) {
        continue;
      }
      const svg = await renderNoteToSvg({ ...note, resolvedPath: sourcePath }, visitedPaths);
      if (!svg) {
        continue;
      }

      files[fileId] = {
        ...(files[fileId] || {}),
        id: fileId,
        mimeType: 'image/svg+xml',
        dataURL: svgToDataUrl(svg),
        created: Date.now(),
        sourcePath,
        // ブラウザ内で生成した表示用スナップショット。保存時に外部SVGとして書き出さない。
        isEmbeddedMarkdownSnapshot: true,
      };
    } catch (error) {
      console.warn(`Failed to render embedded Markdown note: ${sourcePath}`, error);
    }
  }

  return files;
};

/**
 * Embedded Files が .svg を指している埋め込みについて、元の Markdown ノートを特定する。
 * 候補が1つならそれを採用し、複数あれば描画結果の形状が一致するものを採用する。
 */
export const resolveEmbeddedMarkdownSources = async (
  fileData: ExcalidrawFileData,
  embeddedFilePaths: Record<string, string> = {},
  candidates: string[] = [],
): Promise<Record<string, string>> => {
  const resolvedPaths = { ...embeddedFilePaths };
  if (candidates.length === 0) {
    return resolvedPaths;
  }

  const files = fileData.files || {};
  // 候補ノートの描画は重いので、同じ候補を複数の埋め込みで使い回す
  const candidateSignatures = new Map<string, Promise<string | null>>();
  const getCandidateSignature = (candidatePath: string): Promise<string | null> => {
    let signature = candidateSignatures.get(candidatePath);
    if (!signature) {
      signature = (async () => {
        try {
          const note = await loadExcalidrawFile(candidatePath);
          const svg = note ? await renderNoteToSvg(note, new Set()) : null;
          return svg ? svgShapeSignature(svg) : null;
        } catch (error) {
          console.warn(`Failed to compare embedded Markdown candidate: ${candidatePath}`, error);
          return null;
        }
      })();
      candidateSignatures.set(candidatePath, signature);
    }
    return signature;
  };

  for (const [fileId, sourcePath] of Object.entries(embeddedFilePaths)) {
    if (!sourcePath.toLowerCase().endsWith('.svg')) {
      continue;
    }

    if (candidates.length === 1) {
      resolvedPaths[fileId] = candidates[0];
      continue;
    }

    const dataUrl = files[fileId]?.dataURL;
    const sourceSvg = typeof dataUrl === 'string' ? svgDataUrlToText(dataUrl) : null;
    const sourceSignature = sourceSvg ? svgShapeSignature(sourceSvg) : null;
    if (!sourceSignature) {
      continue;
    }

    for (const candidatePath of candidates) {
      if ((await getCandidateSignature(candidatePath)) === sourceSignature) {
        resolvedPaths[fileId] = candidatePath;
        break;
      }
    }
  }

  return resolvedPaths;
};
