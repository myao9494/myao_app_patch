/**
 * ファイル一覧から外部アプリでフォルダ/ファイルを開く操作
 * - 現在のフォルダを VS Code / Finder・Explorer / Jupyter / Antigravity / Obsidian で開く（選択状態に関係なく現在のフォルダ）
 * - プログラムコードを VS Code / 内蔵エディタで開く・実行する（右クリックメニュー）
 * - HTML プレビュー・全文検索を新しいタブで開く、ゴミ箱を開く
 * - Markdown をパスに応じて Obsidian / VS Code で開く
 * 失敗時はトーストでエラーを表示する
 */
import {
  executeProgramCode,
  getFullTextSearchUrl,
  getHtmlViewUrl,
  openInAntigravity,
  openInEditor,
  openInExplorer,
  openInJupyter,
  openInObsidian,
  openInVSCode,
  openTrash,
} from "../../api/files";
import type { FileItem } from "../../types/file";
import { errorMessage } from "../../utils/errorMessage";

interface ExternalAppActionsOptions {
  currentPath: string | null;
  showError: (message: string) => void;
  showSuccess: (message: string) => void;
  /** 右クリックメニューを閉じる */
  closeContextMenu: () => void;
}

export function useExternalAppActions({ currentPath, showError, showSuccess, closeContextMenu }: ExternalAppActionsOptions) {
  const openMarkdownInExternalApp = async (path: string) => {
    if (path.toLowerCase().includes("obsidian")) {
      await openInObsidian(path);
      showSuccess("Obsidianを開きました");
      return;
    }

    await openInVSCode(path);
    showSuccess("VS Codeで開きました");
  };

  // VSCodeで開く
  const handleOpenVSCode = async () => {
    // 選択状態に関わらず、常にカレントディレクトリを開く
    const targetPath = currentPath;

    if (!targetPath) {
      showError("開く対象がありません");
      return;
    }

    try {
      await openInVSCode(targetPath);
      // VSCodeを開くのは「成功」メッセージを出さない方が一般的かもしれないが、
      // 既存の挙動に合わせておく（ただし複数件数表示はなくなる）
      // showSuccess("VSCodeを開きました");
    } catch (e) {
      console.error(`Error opening in VSCode: ${targetPath}`, e);
      showError(`VSCode起動エラー: ${errorMessage(e)}`);
    }
  };

  const handleOpenProgramCodeInVSCode = async (item: FileItem) => {
    try {
      await openInVSCode(item.path);
      closeContextMenu();
    } catch (e) {
      console.error(`Error opening program code in VSCode: ${item.path}`, e);
      showError(`コード起動エラー: ${errorMessage(e)}`);
    }
  };

  const handleOpenProgramCodeInEditor = async (item: FileItem) => {
    try {
      await openInEditor(item.path);
      closeContextMenu();
    } catch (e) {
      console.error(`Error opening program code in editor: ${item.path}`, e);
      showError(`エディター起動エラー: ${errorMessage(e)}`);
    }
  };

  const handleExecuteProgramCode = async (item: FileItem) => {
    try {
      await executeProgramCode(item.path);
      showSuccess(`実行を開始しました: ${item.name}`);
      closeContextMenu();
    } catch (e) {
      console.error(`Error executing program code: ${item.path}`, e);
      showError(`実行エラー: ${errorMessage(e)}`);
    }
  };

  const handleOpenHtmlPreview = (item: FileItem) => {
    window.open(getHtmlViewUrl(item.path), "_blank", "noopener,noreferrer");
    closeContextMenu();
  };

  // エクスプローラー/Finderで開く
  const handleOpenExplorer = async () => {
    // 選択状態に関わらず、常にカレントディレクトリを開く
    const targetPath = currentPath;

    if (!targetPath) {
      return;
    }

    try {
      await openInExplorer(targetPath);
      showSuccess("フォルダを開きました");
    } catch (e) {
      console.error("Failed to open explorer:", e);
      showError(`フォルダを開けませんでした: ${errorMessage(e)}`);
    }
  };

  // ゴミ箱を開く
  const handleOpenTrashFolder = async () => {
    const result = await openTrash();
    if (result.success) {
      showSuccess(result.message || "ゴミ箱を開きました");
    } else {
      showError(result.error || "ゴミ箱を開けませんでした");
    }
  };

  // 全文検索を開く
  const handleOpenFullTextSearch = () => {
    if (!currentPath) {
      showError("開く対象がありません");
      return;
    }

    window.open(getFullTextSearchUrl(currentPath), "_blank", "noopener,noreferrer");
  };

  // Jupyterを開く
  const handleOpenJupyter = async () => {
    // 選択状態に関わらず、常にカレントディレクトリを開く
    const targetPath = currentPath;

    if (!targetPath) return;

    try {
      await openInJupyter(targetPath);
      showSuccess("Jupyterを開きました");
    } catch (e) {
      console.error("Failed to open jupyter:", e);
      showError(`Jupyterを開けませんでした: ${errorMessage(e)}`);
    }
  };

  // Antigravityで開く
  const handleOpenAntigravity = async () => {
    // 選択状態に関わらず、常にカレントディレクトリを開く
    const targetPath = currentPath;

    if (!targetPath) {
      showError("開く対象がありません");
      return;
    }

    try {
      await openInAntigravity(targetPath);
      showSuccess("Antigravityを開きました");
    } catch (e) {
      console.error(`Error opening in Antigravity: ${targetPath}`, e);
      showError(`Antigravity起動エラー: ${errorMessage(e)}`);
    }
  };

  // Obsidianで開く
  const handleOpenObsidian = async () => {
    // 選択状態に関わらず、常にカレントディレクトリを開く
    const targetPath = currentPath;

    if (!targetPath) {
      showError("開く対象がありません");
      return;
    }

    try {
      await openInObsidian(targetPath);
      showSuccess("Obsidianを開きました");
    } catch (e) {
      console.error(`Error opening in Obsidian: ${targetPath}`, e);
      showError(`Obsidian起動エラー: ${errorMessage(e)}`);
    }
  };

  return {
    openMarkdownInExternalApp,
    handleOpenVSCode,
    handleOpenProgramCodeInVSCode,
    handleOpenProgramCodeInEditor,
    handleExecuteProgramCode,
    handleOpenHtmlPreview,
    handleOpenExplorer,
    handleOpenTrashFolder,
    handleOpenFullTextSearch,
    handleOpenJupyter,
    handleOpenAntigravity,
    handleOpenObsidian,
  };
}
