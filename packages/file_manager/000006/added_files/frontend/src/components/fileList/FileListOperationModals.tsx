/**
 * ファイル一覧の削除確認モーダルと進捗モーダル
 * - 状態と処理は useBatchFileOperations が持ち、ここでは表示だけを行う
 * - 削除確認には「ネットワークドライブ上の項目はゴミ箱に入らず完全に削除される」旨を必ず表示する
 */
import { ConfirmationModal } from "../ConfirmationModal";
import { ProgressModal } from "../ProgressModal";
import type { BatchFileOperations } from "./useBatchFileOperations";

interface Props {
  operations: BatchFileOperations;
}

export function FileListProgressModal({ operations }: Props) {
  const { progress } = operations;
  return (
    <ProgressModal
      isOpen={progress.isOpen}
      taskId={progress.taskId}
      operationType={progress.operationType}
      onClose={progress.onClose}
      onComplete={progress.onComplete}
    />
  );
}

export function FileListDeleteConfirmModal({ operations }: Props) {
  const { deleteConfirm } = operations;
  const { items } = deleteConfirm;
  return (
    <ConfirmationModal
      isOpen={deleteConfirm.isOpen}
      title="削除の確認"
      message={
        (items.size > 1
          ? `${items.size}件のアイテムを削除しますか？`
          : `「${Array.from(items)[0]?.split('/').pop()}」を削除しますか？`) +
        "\nゴミ箱に移動します（ネットワークドライブ上の項目はゴミ箱に入らず完全に削除されます）。"
      }
      onConfirm={deleteConfirm.onConfirm}
      confirmLabel="削除"
      confirmButtonClass="btn-danger"
      onClose={deleteConfirm.onClose}
    />
  );
}
