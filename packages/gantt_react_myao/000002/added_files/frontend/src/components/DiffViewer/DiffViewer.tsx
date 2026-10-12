/**
 * 差分ビューアコンポーネント
 * CSVファイルと現在のタスクを比較し、追加・削除・変更を視覚的に表示する
 */

import { useState, useCallback, useMemo } from 'react';
import type { Task } from '../../types/gantt';
import type { TaskDiff } from '../../types/diff';
import { compareTasks, parseFileToTasks } from '../../utils/diffUtils';
import './DiffViewer.css';

interface DiffViewerProps {
    currentTasks: Task[];
    onClose: () => void;
    onTaskUpdate?: (id: number, taskData: Partial<Task>) => Promise<unknown>;
    onTaskCreate?: (taskData: Partial<Task>) => Promise<Task | undefined>;
    onTaskDelete?: (id: number) => Promise<unknown>;
    onRefreshData?: () => Promise<void>;
}

type TabType = 'all' | 'added' | 'deleted' | 'modified';

export function DiffViewer({
    currentTasks,
    onClose,
    onTaskUpdate,
    onTaskCreate,
    onTaskDelete,
    onRefreshData
}: DiffViewerProps) {
    const [error, setError] = useState<string | null>(null);
    const [fileName, setFileName] = useState<string>('');
    const [activeTab, setActiveTab] = useState<TabType>('all');
    const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
    const [fileTasks, setFileTasks] = useState<Task[] | null>(null); // CSVから読み込んだタスク
    const [excludeDateFields, setExcludeDateFields] = useState<boolean>(true); // デフォルトで日付を除外
    const [searchText, setSearchText] = useState<string>(''); // 検索テキスト

    // コンテキストメニュー用ステート
    const [contextMenu, setContextMenu] = useState<{
        x: number;
        y: number;
        diff: TaskDiff;
        fieldKey?: keyof Task; // 個別フィールドの指定
    } | null>(null);

    const diffResult = useMemo(() => {
        if (!fileTasks) return null;
        return compareTasks(currentTasks, fileTasks, { excludeDateFields });
    }, [currentTasks, fileTasks, excludeDateFields]);

    // ファイル選択ハンドラ
    const handleFileSelect = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        setFileName(file.name);
        setError(null);

        try {
            const parsed = await parseFileToTasks(file);

            if (parsed.length === 0) {
                setError('ファイルからタスクを読み込めませんでした。フォーマットを確認してください。');
                return;
            }

            setFileTasks(parsed); // 読み込んだタスクを保持 (diffResultは自動計算される)
            setExpandedIds(new Set()); // リセット
        } catch (err) {
            setError(err instanceof Error ? err.message : 'ファイルの読み込みに失敗しました');
        }
    }, []);

    // 日付除外オプション変更時
    const handleExcludeDateChange = useCallback((checked: boolean) => {
        setExcludeDateFields(checked);
    }, []);

    /**
     * 検索キーワードによるフィルタリング
     * 半角・全角スペースで区切り、AND検索を実行
     */
    const filterBySearch = useCallback((tasks: TaskDiff[]) => {
        if (!searchText.trim()) return tasks;

        // 半角スペースと全角スペースで分割
        const keywords = searchText
            .split(/[\s\u3000]+/)
            .map(k => k.toLowerCase().trim())
            .filter(k => k.length > 0);

        if (keywords.length === 0) return tasks;

        return tasks.filter(diff => {
            const taskText = diff.task.text?.toLowerCase() || '';
            const taskId = String(diff.task.id);
            const taskMemo = diff.task.memo?.toLowerCase() || '';
            const searchTarget = `${taskText} ${taskId} ${taskMemo}`;

            // すべてのキーワードがマッチする場合のみtrue（AND検索）
            return keywords.every(keyword => searchTarget.includes(keyword));
        });
    }, [searchText]);

    // タブに応じた表示データ（検索フィルタ適用）
    const displayTasks = useMemo(() => {
        if (!diffResult) return [];

        let tasks;
        switch (activeTab) {
            case 'added':
                tasks = diffResult.added;
                break;
            case 'deleted':
                tasks = diffResult.deleted;
                break;
            case 'modified':
                tasks = diffResult.modified;
                break;
            case 'all':
            default:
                tasks = [
                    ...diffResult.added,
                    ...diffResult.deleted,
                    ...diffResult.modified,
                ];
        }

        return filterBySearch(tasks);
    }, [diffResult, activeTab, filterBySearch]);

    // 詳細展開トグル
    const toggleExpand = (id: number) => {
        setExpandedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    // 差分アイコン
    const getDiffIcon = (type: string) => {
        switch (type) {
            case 'added':
                return '➕';
            case 'deleted':
                return '➖';
            case 'modified':
                return '✏️';
            default:
                return '';
        }
    };

    // 差分タイプのラベル
    const getDiffLabel = (type: string) => {
        switch (type) {
            case 'added':
                return '追加';
            case 'deleted':
                return '削除';
            case 'modified':
                return '変更';
            default:
                return '';
        }
    };

    // コンテキストメニュー関連
    const handleContextMenu = (e: React.MouseEvent, diff: TaskDiff, fieldKey?: keyof Task) => {
        e.preventDefault();
        e.stopPropagation(); // 親要素（タスク全体）への伝播を防ぐ
        setContextMenu({ x: e.clientX, y: e.clientY, diff, fieldKey });
    };

    const handleCloseContextMenu = useCallback(() => {
        setContextMenu(null);
    }, []);

    const executeRevert = async (diff: TaskDiff, fieldKey?: keyof Task) => {
        if (!onTaskUpdate || !onTaskCreate || !onTaskDelete || !onRefreshData) {
            alert("元に戻す機能がサポートされていません。");
            return;
        }

        const confirmMsg = fieldKey 
            ? `この項目の変更をファイルの内容に戻しますか？` 
            : "タスク全体の変更を元に戻しますか？";

        if (!window.confirm(confirmMsg)) {
            return;
        }

        try {
            if (diff.type === 'added') {
                // ファイルにない(現在ある) -> ファイルの内容に戻す = 削除する
                await onTaskDelete(diff.task.id);
            } else if (diff.type === 'deleted') {
                // ファイルにある(現在ない) -> ファイルの内容に戻す = 追加する
                // バックエンドでidを指定して作成できない可能性があるため、元のIDが保持されるかはAPI仕様次第ですが、
                // 最低限の項目を渡して作成します
                const taskData = { ...diff.task };
                // idはフロントエンドで指定してもバックエンドで自動生成されるかもしれないので注意
                await onTaskCreate(taskData);
            } else if (diff.type === 'modified' && diff.originalTask) {
                // 内容が変わった -> ファイルの内容に戻す
                if (fieldKey) {
                    // 特定のフィールドのみ
                    const updateData: Partial<Task> = { [fieldKey]: diff.originalTask[fieldKey] };
                    
                    // 日付や期間のフィールドを戻す場合は、整合性を保つため3点（開始・終了・期間）をセットで戻す
                    if (['start_date', 'end_date', 'duration'].includes(fieldKey)) {
                        updateData.start_date = diff.originalTask.start_date;
                        updateData.end_date = diff.originalTask.end_date;
                        updateData.duration = diff.originalTask.duration;
                    }
                    
                    await onTaskUpdate(diff.task.id, updateData);
                } else {
                    // タスク全体の変更を戻す
                    const updateData: Partial<Task> = { ...diff.originalTask };
                    delete updateData.id; // idは更新対象外
                    await onTaskUpdate(diff.task.id, updateData);
                }
            }

            // 更新後、親のリストを再取得し、現在のファイルをもう一度パースして差分を再計算する
            await onRefreshData();
            // onRefreshData が currentTasks を更新し、diffResult が自動で再定義されるため
            // 画面を開いたまま最新の差分状態が反映される。
            
            // alert("元に戻しました。"); // 連続操作の妨げになるためアラートを削除
        } catch (e) {
            alert(`元に戻す処理に失敗しました: ${e}`);
        }
    };

    return (
        <div className="diff-viewer-overlay" onClick={() => { handleCloseContextMenu(); onClose(); }}>
            <div className="diff-viewer-modal" onClick={e => e.stopPropagation()}>
                <div className="diff-viewer-header" onClick={handleCloseContextMenu}>
                    <h2>📊 差分比較</h2>
                    <button className="close-btn" onClick={onClose}>✕</button>
                </div>

                <div className="diff-viewer-content">
                    {/* ファイル選択 */}
                    <div className="file-selector">
                        <label className="file-input-label">
                            <input
                                type="file"
                                accept=".csv,.zip"
                                onChange={handleFileSelect}
                                className="file-input"
                            />
                            <span className="file-btn">📂 CSV/ZIPファイルを選択</span>
                        </label>
                        {fileName && <span className="file-name">{fileName}</span>}
                    </div>

                    {/* 比較オプション */}
                    <div className="compare-options">
                        <label className="option-checkbox">
                            <input
                                type="checkbox"
                                checked={excludeDateFields}
                                onChange={(e) => handleExcludeDateChange(e.target.checked)}
                            />
                            <span>開始日・終了日を比較から除外</span>
                        </label>
                    </div>

                    {error && <div className="error-message">{error}</div>}

                    {/* 差分結果 */}
                    {diffResult && (
                        <>
                            {/* サマリー */}
                            <div className="diff-summary">
                                <div className="summary-item added">
                                    <span className="icon">➕</span>
                                    <span className="label">追加</span>
                                    <span className="count">{diffResult.summary.addedCount}</span>
                                </div>
                                <div className="summary-item deleted">
                                    <span className="icon">➖</span>
                                    <span className="label">削除</span>
                                    <span className="count">{diffResult.summary.deletedCount}</span>
                                </div>
                                <div className="summary-item modified">
                                    <span className="icon">✏️</span>
                                    <span className="label">変更</span>
                                    <span className="count">{diffResult.summary.modifiedCount}</span>
                                </div>
                                <div className="summary-item unchanged">
                                    <span className="icon">✓</span>
                                    <span className="label">変更なし</span>
                                    <span className="count">{diffResult.summary.unchangedCount}</span>
                                </div>
                            </div>

                            {/* タブ */}
                            <div className="diff-tabs">
                                <button
                                    className={`tab-btn ${activeTab === 'all' ? 'active' : ''}`}
                                    onClick={() => setActiveTab('all')}
                                >
                                    すべて ({diffResult.summary.addedCount + diffResult.summary.deletedCount + diffResult.summary.modifiedCount})
                                </button>
                                <button
                                    className={`tab-btn added ${activeTab === 'added' ? 'active' : ''}`}
                                    onClick={() => setActiveTab('added')}
                                >
                                    追加 ({diffResult.summary.addedCount})
                                </button>
                                <button
                                    className={`tab-btn deleted ${activeTab === 'deleted' ? 'active' : ''}`}
                                    onClick={() => setActiveTab('deleted')}
                                >
                                    削除 ({diffResult.summary.deletedCount})
                                </button>
                                <button
                                    className={`tab-btn modified ${activeTab === 'modified' ? 'active' : ''}`}
                                    onClick={() => setActiveTab('modified')}
                                >
                                    変更 ({diffResult.summary.modifiedCount})
                                </button>
                            </div>

                            {/* 検索ボックス */}
                            <div className="diff-search">
                                <span className="search-icon">🔍</span>
                                <input
                                    type="text"
                                    className="search-input"
                                    placeholder="タスク名・ID・メモで検索（スペース区切りでAND検索）"
                                    value={searchText}
                                    onChange={(e) => setSearchText(e.target.value)}
                                />
                                {searchText && (
                                    <button
                                        className="search-clear"
                                        onClick={() => setSearchText('')}
                                        title="検索をクリア"
                                    >
                                        ✕
                                    </button>
                                )}
                            </div>
                            {searchText && (
                                <div className="search-result-info">
                                    {displayTasks.length} 件の結果
                                </div>
                            )}

                            {/* 差分リスト */}
                            <div className="diff-list">
                                {displayTasks.length === 0 ? (
                                    <div className="no-diffs">該当する差分がありません</div>
                                ) : (
                                    displayTasks.map((diff) => (
                                        <div
                                            key={`${diff.type}-${diff.task.id}`}
                                            className={`diff-item ${diff.type}`}
                                            onContextMenu={(e) => handleContextMenu(e, diff)}
                                        >
                                            <div
                                                className="diff-item-header"
                                                onClick={() => diff.type === 'modified' && toggleExpand(diff.task.id)}
                                            >
                                                <span className="diff-icon">{getDiffIcon(diff.type)}</span>
                                                <span className="diff-type-label">{getDiffLabel(diff.type)}</span>
                                                <span className="task-id">ID: {diff.task.id}</span>
                                                <span className="task-name">{diff.task.text}</span>
                                                {diff.type === 'modified' && (
                                                    <span className="expand-icon">
                                                        {expandedIds.has(diff.task.id) ? '▼' : '▶'}
                                                    </span>
                                                )}
                                            </div>

                                            {/* 変更詳細（modifiedのみ） */}
                                            {diff.type === 'modified' && expandedIds.has(diff.task.id) && diff.changes && (
                                                <div className="diff-item-details">
                                                    <table className="changes-table">
                                                        <thead>
                                                            <tr>
                                                                <th>フィールド</th>
                                                                <th>旧値（ファイル）</th>
                                                                <th>新値（現在）</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {diff.changes.map((change, idx) => (
                                                                <tr 
                                                                    key={idx}
                                                                    onContextMenu={(e) => handleContextMenu(e, diff, change.fieldKey)}
                                                                >
                                                                    <td className="field-name">{change.field}</td>
                                                                    <td className="old-value">{change.oldValue || '-'}</td>
                                                                    <td className="new-value">{change.newValue || '-'}</td>
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            )}
                                        </div>
                                    ))
                                )}
                            </div>
                        </>
                    )}

                    {!diffResult && !error && (
                        <div className="initial-message">
                            <p>📋 CSVまたはZIPファイルを選択すると、現在のタスクとの差分を比較できます。</p>
                            <ul>
                                <li><span className="icon-added">➕</span> <strong>追加:</strong> 現在存在するが、ファイルにはないタスク</li>
                                <li><span className="icon-deleted">➖</span> <strong>削除:</strong> ファイルにはあるが、現在は存在しないタスク</li>
                                <li><span className="icon-modified">✏️</span> <strong>変更:</strong> 同じIDで内容が変わったタスク</li>
                            </ul>
                        </div>
                    )}
                </div>

                <div className="diff-viewer-footer">
                    <button className="btn-close" onClick={onClose}>閉じる</button>
                </div>
            </div>

            {/* コンテキストメニュー */}
            {contextMenu && (
                <div
                    className="diff-context-menu"
                    style={{ left: contextMenu.x, top: contextMenu.y }}
                    onClick={(e) => e.stopPropagation()}
                >
                    <button
                        className="diff-context-menu-item"
                        onClick={() => {
                            executeRevert(contextMenu.diff, contextMenu.fieldKey);
                            handleCloseContextMenu();
                        }}
                    >
                        元に戻す (Undo)
                    </button>
                </div>
            )}
        </div>
    );
}
