/**
 * ファイルを開く処理と画像プレビューの状態
 * - PDF: ブラウザの別タブ（await の後だとポップアップブロックされやすいので同期的に開く）
 * - 画像: 内蔵の画像プレビュー（フォルダ内の他の画像へ前後移動・グリッド表示）
 * - Markdown: 設定に応じて 外部アプリ / Obsidian（obsidian 配下のみ）/ 内蔵エディタ
 *   （.excalidraw.md は Markdown として扱わず、バックエンドの判定に任せる）
 * - テキスト・コード: 「VS Code で開く」設定なら VS Code、それ以外は内蔵エディタ
 * - その他: バックエンド /api/open/smart の判定（内蔵エディタ・URL・既定のアプリ）
 */
import { useState } from "react";
import { getPdfViewUrl, openInObsidian, openInVSCode, openSmart } from "../../api/files";
import type { FileItem } from "../../types/file";
import { isWebFileEditorTarget, type EditorLanguage } from "../../utils/codeEditorHighlight";
import type { MarkdownOpenMode, TextFileOpenMode } from "../../utils/editorPreferences";
import { errorMessage } from "../../utils/errorMessage";
import { isImageFile } from "../../utils/imageUtils";

interface FileOpenerOptions {
  /** 表示中の項目（画像を開いたときに FileItem を引くため） */
  visibleItems: FileItem[];
  /** 画像プレビューで前後移動する、フォルダ内の画像 */
  folderImages: FileItem[];
  textFileOpenMode: TextFileOpenMode;
  markdownOpenMode: MarkdownOpenMode;
  openMarkdownInExternalApp: (path: string) => Promise<void>;
  openMarkdownEditor: (fileName: string, path: string, content: string) => void;
  openFileEditor: (fileName: string, path: string, content: string, language: EditorLanguage) => void;
  showSuccess: (message: string) => void;
  showError: (message: string) => void;
}

function isExcalidrawMarkdownFile(fileName: string): boolean {
  const lowerFileName = fileName.toLowerCase();
  return lowerFileName.includes(".excalidraw") && lowerFileName.endsWith(".md");
}

export function useFileOpener({
  visibleItems,
  folderImages,
  textFileOpenMode,
  markdownOpenMode,
  openMarkdownInExternalApp,
  openMarkdownEditor,
  openFileEditor,
  showSuccess,
  showError,
}: FileOpenerOptions) {
  const [previewImage, setPreviewImage] = useState<FileItem | null>(null);
  const [imagePreviewMode, setImagePreviewMode] = useState<"single" | "grid">("single");

  const openImage = (item: FileItem) => {
    setPreviewImage(item);
    setImagePreviewMode("single");
  };

  // フォルダ内の画像をプレビューする（画像を指定したらその画像、なければグリッド表示）
  const openFolderImages = (initialTargetItem?: FileItem) => {
    if (folderImages.length === 0) {
      showError("このフォルダ内に画像ファイルはありません");
      return;
    }
    if (initialTargetItem && isImageFile(initialTargetItem.name)) {
      openImage(initialTargetItem);
    } else {
      setPreviewImage(folderImages[0]);
      setImagePreviewMode("grid");
    }
  };

  const openPath = async (path: string, fileName: string, options?: { forceWebEditor?: boolean }) => {
    try {
      const lowerFileName = fileName.toLowerCase();
      const forceWebEditor = options?.forceWebEditor === true;
      const isObsidianPath = path.toLowerCase().includes("obsidian");
      const isMarkdown = lowerFileName.endsWith(".md") && !isExcalidrawMarkdownFile(fileName);

      if (lowerFileName.endsWith(".pdf")) {
        window.open(getPdfViewUrl(path), "_blank", "noopener,noreferrer");
        return;
      }

      if (isImageFile(fileName)) {
        openImage(visibleItems.find((it) => it.path === path) ?? { name: fileName, path, type: "file" });
        return;
      }

      if (!forceWebEditor && isMarkdown) {
        if (markdownOpenMode === "external") {
          await openMarkdownInExternalApp(path);
          return;
        }
        if (markdownOpenMode === "obsidian_or_web" && isObsidianPath) {
          await openInObsidian(path);
          showSuccess("Obsidianを開きました");
          return;
        }
      } else if (!forceWebEditor && textFileOpenMode === "vscode" && isWebFileEditorTarget(fileName)) {
        await openInVSCode(path);
        showSuccess("VS Codeで開きました");
        return;
      }

      const isMarkdownForWebEditor = isMarkdown
        && (markdownOpenMode === "web" || (markdownOpenMode === "obsidian_or_web" && !isObsidianPath));
      const result = await openSmart(path, { preferEmbedded: forceWebEditor || isMarkdownForWebEditor });

      if (result.action === "open_modal") {
        if (result.editor_mode === "markdown") {
          openMarkdownEditor(fileName, path, result.content || "");
        } else {
          openFileEditor(fileName, path, result.content || "", result.language ?? "plaintext");
        }
      } else if (result.action === "open_url" && result.url) {
        window.open(result.url, "_blank", "noopener,noreferrer");
      } else {
        // 外部アプリで開いた
        showSuccess(result.message);
      }
    } catch (e) {
      showError(errorMessage(e) || "ファイルを開けませんでした");
    }
  };

  return {
    openPath,
    openImage,
    openFolderImages,
    imagePreview: {
      isOpen: previewImage !== null,
      image: previewImage,
      mode: imagePreviewMode,
      navigate: setPreviewImage,
      close: () => setPreviewImage(null),
    },
  };
}
