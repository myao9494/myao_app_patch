/**
 * ファイル一覧の Git 列の表示（G キーで確認したフォルダの状態）
 * - ラベル: "-"（Git管理外・差分なし）/ "G"（作業ツリーに変更）/ "Push"（未Push）/ "Pull"（未Pull）/ "C"（両方）
 * - ツールチップ: 未Push/未Pull件数・変更ファイル一覧・クリック時の動作
 * - クリック時の動作: 未Push/未Pullがあればターミナル用 Git コマンドのコピー、なければ VS Code で開く
 */
import type { GitSyncAction } from "./gitCommands";

export interface FolderGitStatus {
  changedFiles: string[];
  hasMoreChanges: boolean;
  aheadCount: number;
  behindCount: number;
}

export type GitStatusLabel = "-" | "G" | "Push" | "Pull" | "C";

export function getGitStatusLabel(status: FolderGitStatus | undefined): GitStatusLabel {
  if (!status || (!status.hasMoreChanges && status.changedFiles.length === 0 && status.aheadCount === 0 && status.behindCount === 0)) {
    return "-";
  }
  if (status.aheadCount > 0 && status.behindCount > 0) return "C";
  if (status.aheadCount > 0) return "Push";
  if (status.behindCount > 0) return "Pull";
  return "G";
}

/** クリック時に実行する Git 同期操作（なければ null = VS Code で開く） */
export function getGitSyncAction(status: FolderGitStatus | undefined): GitSyncAction | null {
  if (!status || (status.aheadCount === 0 && status.behindCount === 0)) return null;
  if (status.aheadCount > 0 && status.behindCount > 0) return "sync";
  return status.aheadCount > 0 ? "push" : "pull";
}

export function getGitStatusTitle(status: FolderGitStatus | undefined): string {
  if (!status) return "";
  const lines: string[] = [];
  if (status.aheadCount > 0) lines.push(`未Push: ${status.aheadCount}件`);
  if (status.behindCount > 0) lines.push(`未Pull: ${status.behindCount}件`);
  if (status.changedFiles.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("変更ファイル:", ...status.changedFiles);
    if (status.hasMoreChanges) lines.push("…");
  }
  const clickHint = getGitSyncAction(status)
    ? "クリックしてターミナル用Gitコマンドをコピー"
    : "クリックしてVS Codeで開く";
  return [...lines, "", clickHint].join("\n");
}
