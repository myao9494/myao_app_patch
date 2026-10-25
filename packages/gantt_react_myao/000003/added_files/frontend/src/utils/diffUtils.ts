/**
 * タスク差分比較ユーティリティ
 * CSVファイルと現在のタスクを比較して差分を計算する
 */

import type { Task } from '../types/gantt';
import type { DiffResult, TaskDiff, FieldChange } from '../types/diff';
import JSZip from 'jszip';

/** 比較対象のフィールド一覧 */
const COMPARE_FIELDS: (keyof Task)[] = [
    'text',
    'start_date',
    'end_date',
    'duration',
    'progress',
    'parent',
    'kind_task',
    'owner_id',
    'color',
    'memo',
    'hyperlink',
    'task_schedule',
    // 'sortorder' は差分比較の対象外
];

/** フィールド名の日本語ラベル */
export const FIELD_LABELS: Record<string, string> = {
    text: 'タスク名',
    start_date: '開始日',
    end_date: '終了日',
    duration: '期間',
    progress: '進捗',
    parent: '親タスク',
    kind_task: '種類',
    owner_id: 'オーナー',
    color: '色',
    memo: 'メモ',
    hyperlink: 'リンク',
    task_schedule: 'スケジュール',
    // sortorder は差分比較対象外のため省略
};

/**
 * フィールド値を正規化する
 * null, undefined, 空文字, 数値の0や0.0を統一的に扱う
 */
function normalizeValue(value: unknown, fieldName: string): string {
    // null/undefined は空文字として扱う
    if (value === null || value === undefined) {
        return '';
    }

    const strValue = String(value).trim();

    // 空文字はそのまま
    if (strValue === '') {
        return '';
    }

    // スケジュールなどの複数行テキストは改行コード(CRLF->LF)や末尾の空白を揃える
    if (fieldName === 'task_schedule' || fieldName === 'memo') {
        return strValue.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    }

    // 数値フィールドの正規化（sortorderは差分比較対象外のため除く）
    const numericFields = ['duration', 'progress', 'parent', 'kind_task', 'owner_id'];
    if (numericFields.includes(fieldName)) {
        const num = parseFloat(strValue);
        if (!isNaN(num)) {
            // 整数として表示可能なら整数で、そうでなければ小数
            return Number.isInteger(num) ? String(Math.floor(num)) : String(num);
        }
    }

    // 日付フィールドの正規化（時刻部分を除去して比較）
    const dateFields = ['start_date', 'end_date'];
    if (dateFields.includes(fieldName)) {
        // "YYYY-MM-DD HH:mm:ss" -> "YYYY-MM-DD" に正規化
        const dateMatch = strValue.match(/^(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
            return dateMatch[1];
        }
    }

    return strValue;
}

/**
 * 2つのタスクを比較し、変更されたフィールドを返す
 * @param excludeFields 比較から除外するフィールド名の配列
 */
function compareTaskFields(oldTask: Task, newTask: Task, excludeFields: string[] = []): FieldChange[] {
    const changes: FieldChange[] = [];

    for (const field of COMPARE_FIELDS) {
        // 除外フィールドはスキップ
        if (excludeFields.includes(field)) {
            continue;
        }

        const oldValue = normalizeValue(oldTask[field], field);
        const newValue = normalizeValue(newTask[field], field);

        if (oldValue !== newValue) {
            changes.push({
                field: FIELD_LABELS[field] || field,
                fieldKey: field,
                oldValue: oldValue || '(空)',
                newValue: newValue || '(空)',
            });
        }
    }

    return changes;
}

/** 比較オプション */
export interface CompareOptions {
    excludeDateFields?: boolean;  // 日付フィールド（開始日・終了日）を除外
}

/**
 * 現在のタスクとCSVファイルのタスクを比較して差分を計算
 * @param currentTasks 現在のタスク一覧
 * @param fileTasks CSVから読み込んだタスク一覧
 * @param options 比較オプション
 * @returns 差分結果
 */
export function compareTasks(currentTasks: Task[], fileTasks: Task[], options: CompareOptions = {}): DiffResult {
    // 除外するフィールドを決定
    const excludeFields: string[] = [];
    if (options.excludeDateFields) {
        excludeFields.push('start_date', 'end_date');
    }
    const added: TaskDiff[] = [];
    const deleted: TaskDiff[] = [];
    const modified: TaskDiff[] = [];
    const unchanged: TaskDiff[] = [];

    // 現在のタスクをIDでマップ化
    const currentMap = new Map<number, Task>();
    for (const task of currentTasks) {
        currentMap.set(task.id, task);
    }

    // ファイルのタスクをIDでマップ化
    const fileMap = new Map<number, Task>();
    for (const task of fileTasks) {
        fileMap.set(task.id, task);
    }

    // ファイルにあるタスクを処理
    for (const fileTask of fileTasks) {
        const currentTask = currentMap.get(fileTask.id);

        if (!currentTask) {
            // 現在のデータにない = 削除された（ファイルにはあるが現在はない）
            // 実際は逆: ファイルは過去のデータ、現在のデータにない = 過去にはあったが現在削除された
            // 注意: 差分の解釈を明確に
            // ファイル（旧）にあり、現在にない = 過去からの削除
            deleted.push({ type: 'deleted', task: fileTask });
        } else {
            // 両方にある - 変更チェック
            const changes = compareTaskFields(fileTask, currentTask, excludeFields);
            if (changes.length > 0) {
                modified.push({
                    type: 'modified',
                    task: currentTask,
                    originalTask: fileTask,
                    changes,
                });
            } else {
                unchanged.push({ type: 'unchanged', task: currentTask });
            }
        }
    }

    // 現在のタスクでファイルにないもの = 新規追加された
    for (const currentTask of currentTasks) {
        if (!fileMap.has(currentTask.id)) {
            added.push({ type: 'added', task: currentTask });
        }
    }

    return {
        added,
        deleted,
        modified,
        unchanged,
        summary: {
            addedCount: added.length,
            deletedCount: deleted.length,
            modifiedCount: modified.length,
            unchangedCount: unchanged.length,
        },
    };
}

/**
 * CSVテキストをタスク配列にパースする
 * バックエンドのCSVフォーマットに合わせる
 * 複数行フィールドにも対応
 */
export function parseCSVToTasks(csvText: string): Task[] {
    // BOMを削除
    let cleanText = csvText;
    if (cleanText.charCodeAt(0) === 0xFEFF) {
        cleanText = cleanText.slice(1);
    }

    // CRLF を LF に統一
    cleanText = cleanText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // CSVをレコード単位でパース（引用符内の改行に対応）
    const records = parseCSVRecords(cleanText);
    if (records.length < 2) return []; // ヘッダー行と最低1行のデータが必要

    const headers = records[0].map(h => h.trim());
    const tasks: Task[] = [];

    for (let i = 1; i < records.length; i++) {
        const values = records[i];
        if (values.length === 0) continue;

        const row: Record<string, string> = {};
        headers.forEach((h, idx) => {
            row[h] = (values[idx] || '').trim();
        });

        // 必須フィールドのチェック（IDがNaNの場合はスキップ）
        const idStr = row['id'] || row['ID'] || '';
        const id = parseInt(idStr, 10);
        if (isNaN(id)) {
            continue;
        }

        const task: Task = {
            id,
            text: row['text'] || row['タスク名'] || '',
            start_date: row['start_date'] || row['開始日'] || '',
            end_date: row['end_date'] || row['終了日'] || '',
            duration: parseInt(row['duration'] || row['期間'] || '1', 10) || 1,
            progress: parseFloat(row['progress'] || row['進捗'] || '0') || 0,
            parent: parseInt(row['parent'] || row['親タスク'] || '0', 10) || 0,
            kind_task: (parseInt(row['kind_task'] || row['種類'] || '1', 10) || 1) as 1 | 2 | 3,
            owner_id: (parseInt(row['owner_id'] || row['オーナー'] || '0', 10) || 0) as 0 | 10 | 20 | 30,
            sortorder: parseInt(row['sortorder'] || row['並び順'] || '0', 10) || 0,
            color: row['color'] || row['色'] || undefined,
            memo: row['memo'] || row['メモ'] || undefined,
            hyperlink: row['hyperlink'] || row['リンク'] || undefined,
            task_schedule: row['task_schedule'] || row['スケジュール'] || undefined,
        };

        tasks.push(task);
    }

    return tasks;
}

/**
 * ファイルオブジェクト（CSVまたはZIP）を読み込んでタスク配列にパースする
 * ZIPの場合は内部の tasks.csv を取り出してパースする
 */
export async function parseFileToTasks(file: File): Promise<Task[]> {
    const fileName = file.name.toLowerCase();

    if (fileName.endsWith('.csv')) {
        const text = await file.text();
        return parseCSVToTasks(text);
    } else if (fileName.endsWith('.zip')) {
        const arrayBuffer = await file.arrayBuffer();
        const zip = await JSZip.loadAsync(arrayBuffer);
        
        let tasksCsvFile: JSZip.JSZipObject | null = null;
        
        // ファイル名を検索（"task"が含まれ、かつ".csv"で終わるものを探す）
        const filePaths = Object.keys(zip.files);
        const tasksCsvPath = filePaths.find(p => p.toLowerCase().includes('task') && p.toLowerCase().endsWith('.csv'));
        if (tasksCsvPath) {
            tasksCsvFile = zip.file(tasksCsvPath);
        }

        if (!tasksCsvFile) {
            throw new Error('ZIPファイル内にタスクデータ(CSV)が見つかりません。');
        }

        const text = await tasksCsvFile.async('text');
        return parseCSVToTasks(text);
    }

    throw new Error('未対応のファイル形式です。CSVまたはZIPファイルを選択してください。');
}

/**
 * CSVテキストをレコード配列にパースする
 * 引用符で囲まれた複数行フィールドに対応
 */
function parseCSVRecords(csvText: string): string[][] {
    const records: string[][] = [];
    let currentRecord: string[] = [];
    let currentField = '';
    let inQuotes = false;

    for (let i = 0; i < csvText.length; i++) {
        const char = csvText[i];

        if (inQuotes) {
            if (char === '"') {
                // 次の文字も引用符なら、エスケープされた引用符
                if (csvText[i + 1] === '"') {
                    currentField += '"';
                    i++;
                } else {
                    // 引用符の終了
                    inQuotes = false;
                }
            } else {
                // 引用符内の文字（改行を含む）
                currentField += char;
            }
        } else {
            if (char === '"') {
                // 引用符の開始
                inQuotes = true;
            } else if (char === ',') {
                // フィールドの区切り
                currentRecord.push(currentField);
                currentField = '';
            } else if (char === '\n') {
                // レコードの区切り
                currentRecord.push(currentField);
                if (currentRecord.length > 0 && currentRecord.some(f => f.trim() !== '')) {
                    records.push(currentRecord);
                }
                currentRecord = [];
                currentField = '';
            } else {
                currentField += char;
            }
        }
    }

    // 最後のフィールドとレコードを追加
    if (currentField !== '' || currentRecord.length > 0) {
        currentRecord.push(currentField);
        if (currentRecord.length > 0 && currentRecord.some(f => f.trim() !== '')) {
            records.push(currentRecord);
        }
    }

    return records;
}

