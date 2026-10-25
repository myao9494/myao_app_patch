/**
 * 差分比較（DiffViewer）の純粋な処理。
 * - 検索語による差分の絞り込み
 * - 「ファイルの内容に戻す」ときに、バックエンドへ何をするかの決定
 */
import type { Task } from '../types/gantt';
import type { TaskDiff } from '../types/diff';

/**
 * タスク名・ID・メモに対する検索で差分を絞り込む。
 * 半角・全角スペースで区切ったすべての語を含むものだけを残す（AND検索、大文字小文字は区別しない）。
 */
export function filterDiffsBySearch(diffs: TaskDiff[], searchText: string): TaskDiff[] {
  const keywords = searchText
    .split(/[\s\u3000]+/)
    .map((keyword) => keyword.toLowerCase().trim())
    .filter((keyword) => keyword.length > 0);
  if (keywords.length === 0) return diffs;

  return diffs.filter(({ task }) => {
    const target = `${task.text?.toLowerCase() || ''} ${task.id} ${task.memo?.toLowerCase() || ''}`;
    return keywords.every((keyword) => target.includes(keyword));
  });
}

/** 差分1件を「ファイルの内容」へ戻すための操作 */
export type RevertAction =
  | { kind: 'delete'; id: number }
  | { kind: 'create'; data: Partial<Task> }
  | { kind: 'update'; id: number; data: Partial<Task> };

/** 日付・期間は互いに依存するので、どれか1つを戻すときは3つをセットで戻す */
const DATE_FIELDS: ReadonlyArray<keyof Task> = ['start_date', 'end_date', 'duration'];

/**
 * 差分をファイルの内容に戻す操作を決める。
 * - 追加（現在だけにある）→ 削除、削除（ファイルだけにある）→ 作成、変更 → ファイルの値で更新
 * - fieldKey を指定すると、変更のうち1項目だけを戻す
 * 戻せない差分（変更前の値がないなど）は null。
 */
export function planRevert(diff: TaskDiff, fieldKey?: keyof Task): RevertAction | null {
  if (diff.type === 'added') {
    return { kind: 'delete', id: diff.task.id };
  }
  if (diff.type === 'deleted') {
    return { kind: 'create', data: { ...diff.task } };
  }
  if (diff.type !== 'modified' || !diff.originalTask) {
    return null;
  }

  const original = diff.originalTask;
  if (fieldKey) {
    const data: Partial<Task> = { [fieldKey]: original[fieldKey] };
    if (DATE_FIELDS.includes(fieldKey)) {
      data.start_date = original.start_date;
      data.end_date = original.end_date;
      data.duration = original.duration;
    }
    return { kind: 'update', id: diff.task.id, data };
  }

  const { id: _id, ...data } = original;
  void _id; // id は更新対象外
  return { kind: 'update', id: diff.task.id, data };
}
