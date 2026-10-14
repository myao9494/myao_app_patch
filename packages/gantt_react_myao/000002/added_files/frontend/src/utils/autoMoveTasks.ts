/**
 * 「タスク自動移動」の移動計画を立てるユーティリティ
 *
 * 開始日が今日以前の未完了タスクを、期間（日数）を保ったまま前倒し/後ろ倒しする:
 * - タスク（kind 1）: 開始日を今日にする
 * - プロジェクト（kind 2）: 開始日を直近の月曜日にする
 * 完了済み・固定（ピン留め）・マイルストーン・開始日が未来のものは動かさない。
 */
import { formatDateString } from '../constants/gantt';
import type { Task } from '../types/gantt';

export interface TaskMove {
  id: number;
  start_date: string;
  end_date: string;
}

function startOfDay(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

/** 基準日を含む週の月曜日（基準日が月曜ならその日） */
export function getMostRecentMonday(baseDate: Date): Date {
  const result = startOfDay(baseDate);
  result.setDate(result.getDate() - ((result.getDay() + 6) % 7));
  return result;
}

export function planAutoMove(tasks: Task[], now: Date = new Date()): TaskMove[] {
  const today = startOfDay(now);
  const recentMonday = getMostRecentMonday(today);
  const moves: TaskMove[] = [];

  for (const task of tasks) {
    if (task.progress >= 1 || task.is_pinned || !task.start_date) continue;

    const currentStart = startOfDay(new Date(String(task.start_date).replace(' ', 'T')));
    if (currentStart.getTime() > today.getTime()) continue;

    let targetStart: Date;
    if (task.kind_task === 1) {
      targetStart = today;
    } else if (task.kind_task === 2) {
      targetStart = recentMonday;
    } else {
      continue;
    }
    if (currentStart.getTime() === targetStart.getTime()) continue;

    const targetEnd = new Date(targetStart);
    targetEnd.setDate(targetEnd.getDate() + (task.duration || 1));
    moves.push({
      id: task.id,
      start_date: formatDateString(targetStart),
      end_date: formatDateString(targetEnd),
    });
  }

  return moves;
}
