/**
 * フォルダの Git 状態（G キー）と最新更新日（D キー）
 * - どちらも重い処理のため、利用者がキーを押したときだけ取得する（一覧表示のたびには走査しない）
 * - Git: ペイン内の全フォルダの変更・ahead / behind を取得する。
 *   Push / Pull 待ちのボタンは git コマンドをクリップボードにコピーし、それ以外は VS Code で開く
 * - 最新更新日: 選択中のフォルダ1件、または（未選択なら）カーソル行のフォルダの配下を集計する。
 *   打ち切られた（項目数上限・タイムアウト）場合は表示を更新しない
 * - フォルダを移動したら結果を消す
 */
import { logError } from "../../utils/errorLog";
import { useEffect, useState } from "react";
import { getFolderGitStatuses, getFolderLatestModified, openInVSCode } from "../../api/files";
import type { FileItem } from "../../types/file";
import { buildGitSyncCommand } from "../../utils/gitCommands";
import { getGitSyncAction, type FolderGitStatus } from "../../utils/gitStatusDisplay";
import { errorMessage } from "../../utils/errorMessage";

interface FolderInsightsOptions {
  currentPath: string | null;
  /** 絞り込み前のフォルダ内の全項目（Git 状態はフィルタに関係なく全フォルダを調べる） */
  allItems: FileItem[];
  selectedItems: Set<string>;
  showSuccess: (message: string) => void;
  showError: (message: string) => void;
}

export function useFolderInsights({
  currentPath,
  allItems,
  selectedItems,
  showSuccess,
  showError,
}: FolderInsightsOptions) {
  const [folderLatestModified, setFolderLatestModified] = useState<Record<string, string>>({});
  const [folderLatestModifiedLoading, setFolderLatestModifiedLoading] = useState<Set<string>>(new Set());
  const [gitStatuses, setGitStatuses] = useState<Record<string, FolderGitStatus>>({});
  const [isGitStatusLoading, setIsGitStatusLoading] = useState(false);

  useEffect(() => {
    setFolderLatestModified({});
    setFolderLatestModifiedLoading(new Set());
    setGitStatuses({});
    setIsGitStatusLoading(false);
  }, [currentPath]);

  /** visibleItems / focusedIndex: 表示中の項目とカーソル位置（集計結果は並べ替えに使うため、呼び出し時に受け取る） */
  const calculateFolderLatestModified = async (visibleItems: FileItem[], focusedIndex: number) => {
    const selectedFolders = visibleItems.filter(
      (item) => item.type === "directory" && selectedItems.has(item.path)
    );
    const focusedItem = visibleItems[focusedIndex];
    const target = selectedFolders.length === 1
      ? selectedFolders[0]
      : selectedFolders.length === 0 && selectedItems.size === 0 && focusedItem?.type === "directory"
        ? focusedItem
        : null;

    if (!target) {
      showError("フォルダを1件選択するか、フォルダ行にカーソルを置いてください");
      return;
    }
    if (folderLatestModifiedLoading.has(target.path)) return;

    setFolderLatestModifiedLoading((previous) => new Set(previous).add(target.path));
    try {
      const result = await getFolderLatestModified(target.path);
      if (result.truncated) {
        showError(`「${target.name}」は項目数上限またはタイムアウトのため、Dateを更新しませんでした`);
        return;
      }
      setFolderLatestModified((previous) => ({ ...previous, [target.path]: result.modified }));
      showSuccess(`「${target.name}」の最新更新日を取得しました`);
    } catch (err) {
      showError(`最新更新日の取得に失敗しました: ${errorMessage(err)}`);
    } finally {
      setFolderLatestModifiedLoading((previous) => {
        const next = new Set(previous);
        next.delete(target.path);
        return next;
      });
    }
  };

  const checkGitStatuses = async () => {
    const folderPaths = allItems.filter((item) => item.type === "directory").map((item) => item.path);
    if (folderPaths.length === 0 || isGitStatusLoading) return;

    setIsGitStatusLoading(true);
    try {
      const statuses = await getFolderGitStatuses(folderPaths);
      setGitStatuses(Object.fromEntries(
        statuses.map((item) => [item.path, {
          changedFiles: item.changed_files,
          hasMoreChanges: item.has_more_changes,
          aheadCount: item.ahead_count,
          behindCount: item.behind_count,
        }])
      ));
    } catch (err) {
      showError(`Git状態の取得に失敗しました: ${errorMessage(err)}`);
    } finally {
      setIsGitStatusLoading(false);
    }
  };

  const openGitFolderInVSCode = async (item: FileItem) => {
    try {
      await openInVSCode(item.path);
    } catch (err) {
      showError(`VS Code起動エラー: ${errorMessage(err)}`);
    }
  };

  const handleGitStatusAction = async (item: FileItem) => {
    const action = getGitSyncAction(gitStatuses[item.path]);
    if (!action) {
      await openGitFolderInVSCode(item);
      return;
    }
    try {
      await navigator.clipboard.writeText(buildGitSyncCommand(item.path, action));
      showSuccess(`git ${action === "sync" ? "pull --rebase && git push" : action} コマンドをコピーしました`);
    } catch (err) {
      logError("Gitコマンドのコピーに失敗しました", err);
      showError("Gitコマンドのコピーに失敗しました");
    }
  };

  return {
    folderLatestModified,
    folderLatestModifiedLoading,
    gitStatuses,
    isGitStatusLoading,
    calculateFolderLatestModified,
    checkGitStatuses,
    handleGitStatusAction,
  };
}
