/**
 * タスクのハイパーリンク操作。
 * - Obsidianノートの作成（既にあれば再利用）とリンク設定、そのノートを開く
 * - ハイパーリンクを開く（Obsidianノートはリネーム・移動されていても、タスクIDで探し直してから開く）
 * 処理中の多重実行は無視する。
 */
import { useCallback, useRef } from 'react';
import { createObsidianNote, resolveTaskLink } from '../../services/api';
import { formatHyperlink, isObsidianLink, type GanttId } from './ganttTaskUtils';

interface UseTaskHyperlinksOptions {
  obsidianHome: string;
  /** gantt 上のタスクの項目を書き換える（保存は gantt のイベント経由で行われる） */
  updateTaskFields: (taskId: GanttId, fields: Record<string, unknown>) => void;
}

export function useTaskHyperlinks({ obsidianHome, updateTaskFields }: UseTaskHyperlinksOptions) {
  const isCreatingObsidianRef = useRef(false);
  const isResolvingHyperlinkRef = useRef(false);

  // タスクのObsidianノートを作成（既にあれば再利用）してリンクし、そのノートを開く
  const handleCreateObsidianNote = useCallback(async (taskId: number) => {
    if (isCreatingObsidianRef.current) return;
    isCreatingObsidianRef.current = true;
    try {
      const response = await createObsidianNote(taskId, obsidianHome);
      if (!response.success || !response.data) {
        console.error('Failed to create Obsidian note:', response.error);
        alert(`ファイル作成に失敗しました: ${response.error}`);
        return;
      }

      const hyperlink = response.data.hyperlink;
      updateTaskFields(taskId, { hyperlink });
      if (hyperlink) {
        window.open(formatHyperlink(hyperlink), '_blank');
      }
    } catch (error) {
      console.error(error);
      alert('エラーが発生しました');
    } finally {
      isCreatingObsidianRef.current = false;
    }
  }, [obsidianHome, updateTaskFields]);

  /**
   * タスクのハイパーリンクを開く。
   * Obsidianノートは、リネーム・移動されていてもタスクIDで探し直してから開く。
   */
  const openHyperlink = useCallback(async (taskId: number, hyperlink: string) => {
    if (!hyperlink) return;

    if (!isObsidianLink(hyperlink, obsidianHome)) {
      window.open(formatHyperlink(hyperlink), '_blank');
      return;
    }

    if (isResolvingHyperlinkRef.current) return;
    isResolvingHyperlinkRef.current = true;

    try {
      const response = await resolveTaskLink(taskId, obsidianHome);
      if (!response.success || !response.data?.hyperlink) {
        alert(response.error || 'Obsidianリンクの再解決に失敗しました');
        return;
      }

      const resolvedHyperlink = response.data.hyperlink;
      if (response.data.updated) {
        updateTaskFields(taskId, { hyperlink: resolvedHyperlink });
      }
      window.open(formatHyperlink(resolvedHyperlink), '_blank');
    } catch (error) {
      console.error(error);
      alert('Obsidianリンクを開けませんでした');
    } finally {
      isResolvingHyperlinkRef.current = false;
    }
  }, [obsidianHome, updateTaskFields]);

  return { createObsidianNote: handleCreateObsidianNote, openHyperlink };
}
