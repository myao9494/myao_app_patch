/**
 * 一括操作（移動・コピー・削除）の結果を画面表示用に分類するユーティリティ
 *
 * - classifyBatchResults: 成功 / 同名衝突（上書き確認の対象） / ロック中 / その他のエラー に分ける
 * - collectLockingProcesses: ロック中の項目からプロセス一覧を重複なく集める
 * - formatLockingProcesses: 確認ダイアログ用に「・名前 (PID: n)」形式の文字列にする
 * - getTransferHistoryData: Undo履歴に記録する、実際に成功した項目だけのデータを作る
 * - toBatchOperationResult: 同期APIレスポンスを完了結果の形にそろえる
 */
import type { BatchItemResult, BatchOperationResponse, BatchOperationResult, LockingProcess } from "../types/file";

/** バックエンドが同名衝突時に返すメッセージ */
export const CONFLICT_MESSAGE = "同名のファイルが存在します";

export interface ClassifiedBatchResults {
  succeeded: BatchItemResult[];
  conflicts: BatchItemResult[];
  locked: BatchItemResult[];
  otherErrors: BatchItemResult[];
}

export function isConflictResult(item: BatchItemResult): boolean {
  return item.status === "error" && (item.message ?? "").includes("存在します");
}

export function classifyBatchResults(results: BatchItemResult[] = []): ClassifiedBatchResults {
  const succeeded: BatchItemResult[] = [];
  const conflicts: BatchItemResult[] = [];
  const locked: BatchItemResult[] = [];
  const otherErrors: BatchItemResult[] = [];

  for (const item of results) {
    if (item.status === "success") {
      succeeded.push(item);
    } else if (item.status === "error") {
      if (isConflictResult(item)) {
        conflicts.push(item);
      } else if (item.locked_by && item.locked_by.length > 0) {
        locked.push(item);
      } else {
        otherErrors.push(item);
      }
    }
  }
  return { succeeded, conflicts, locked, otherErrors };
}

export function collectLockingProcesses(items: BatchItemResult[]): LockingProcess[] {
  const byPid = new Map<number, LockingProcess>();
  for (const item of items) {
    for (const process of item.locked_by ?? []) {
      if (!byPid.has(process.pid)) {
        byPid.set(process.pid, process);
      }
    }
  }
  return Array.from(byPid.values());
}

export function formatLockingProcesses(processes: LockingProcess[]): string {
  return processes.map((p) => `・${p.name} (PID: ${p.pid})`).join("\n");
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

export type TransferHistoryData =
  | { type: "MOVE"; data: { srcPaths: string[]; destParentPath: string } }
  | { type: "COPY"; data: { copiedPaths: string[]; originalPaths: string[] } };

/**
 * Undo履歴に残すデータを作る。失敗・スキップした項目は含めない
 * （失敗した項目を含めると、Undoで移動先に元からあった別のファイルを動かしたり削除してしまうため）。
 */
export function getTransferHistoryData(
  op: "move" | "copy",
  results: BatchItemResult[],
  destPath: string,
): TransferHistoryData | null {
  const succeeded = results.filter((r) => r.status === "success");
  if (succeeded.length === 0) {
    return null;
  }
  if (op === "move") {
    return {
      type: "MOVE",
      data: { srcPaths: succeeded.map((r) => r.path), destParentPath: destPath },
    };
  }
  return {
    type: "COPY",
    data: {
      copiedPaths: succeeded.map((r) => r.dest ?? `${destPath}/${baseName(r.path)}`),
      originalPaths: succeeded.map((r) => r.path),
    },
  };
}

/** API レスポンス（同期モード）を完了結果の形にそろえる */
export function toBatchOperationResult(response: BatchOperationResponse): BatchOperationResult {
  return {
    success_count: response.success_count ?? 0,
    fail_count: response.fail_count ?? 0,
    results: response.results ?? [],
  };
}
