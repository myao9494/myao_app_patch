// =============================================================================
// ganttに追加（ノートを gantt アプリのタスクにし、ファイル名へタスクIDを付ける）
// =============================================================================

const GANTT_API_BASE_URL = "http://localhost:8000/api";
const GANTT_PARENT_KEY = "customGanttParentId";
// gantt アプリがノートを探し直すときの目印と同じ形式（タスク名【ID】.md）
const GANTT_TASK_ID_SUFFIX_RE = /【(\d+)】$/;

/**
 * 設定した親タスクIDを返す（未設定・不正な値は 0 = ルート）
 **/
const getGanttParentId = () => {
    const parent = Number.parseInt(String(localStorage.getItem(GANTT_PARENT_KEY) ?? "").trim(), 10);
    return Number.isInteger(parent) && parent >= 0 ? parent : 0;
};

/**
 * 親タスクIDの入力値を 0 以上の整数へ正規化する（不正な値は null）
 **/
const normalizeGanttParentId = (value) => {
    const text = String(value ?? "").trim();
    if (!/^\d+$/.test(text)) return null;
    return Number.parseInt(text, 10);
};

/**
 * ノートのファイル名（拡張子なし）から gantt のタスク作成 payload を組み立てる。
 * ランチャーの「ganttに追加」と同じく、開始日は今日・終了日は明日・進捗 0.1・メモは空。
 **/
const buildGanttTaskPayload = (title, parent = 0, today = new Date()) => {
    const pad = (n) => String(n).padStart(2, "0");
    const format = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 00:00:00`;
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    return {
        text: title.trim(),
        start_date: format(today),
        end_date: format(tomorrow),
        progress: 0.1,
        parent,
        kind_task: 1,
        memo: "",
    };
};

/**
 * ファイル名（拡張子なし）に付いている gantt のタスクIDを返す（なければ null）
 **/
const getGanttTaskIdFromBasename = (basename) => {
    const match = GANTT_TASK_ID_SUFFIX_RE.exec(basename);
    return match ? Number.parseInt(match[1], 10) : null;
};

/**
 * タスクIDを付けたファイル名（拡張子なし）を返す
 **/
const buildGanttNoteBasename = (basename, taskId) => `${basename}【${taskId}】`;

/**
 * gantt アプリの API を呼ぶ。失敗時は Error を投げる
 **/
const requestGanttApi = async (method, path, body) => {
    const response = await getObsidianModule().requestUrl({
        url: `${GANTT_API_BASE_URL}${path}`,
        method,
        contentType: "application/json",
        body: body === undefined ? undefined : JSON.stringify(body),
        throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`gantt API が ${response.status} を返しました`);
    }
    return response.json;
};

/**
 * ノートを gantt のタスクとして追加する。
 * 1. ファイル名をタスク名にして gantt にタスクを作る
 * 2. ノートのファイル名を「名前【ID】」へ変える（Obsidian が他ノートのリンクも更新する）
 * 3. タスクのリンクに、ノートの絶対パスを設定する（gantt の「O」で作るノートと同じ形）
 **/
const addNoteToGantt = async (file) => {
    if (getGanttTaskIdFromBasename(file.basename) !== null) {
        new Notice("すでにganttに追加済みです");
        return;
    }

    let task;
    try {
        task = await requestGanttApi("POST", "/tasks", buildGanttTaskPayload(file.basename, getGanttParentId()));
    } catch (e) {
        console.error("Failed to create gantt task:", e);
        new Notice(`ganttにタスクを追加できませんでした（ganttアプリが起動しているか確認してください）: ${e.message}`);
        return;
    }

    try {
        const newPath = `${file.parent?.path && file.parent.path !== "/" ? `${file.parent.path}/` : ""}${buildGanttNoteBasename(file.basename, task.id)}.${file.extension}`;
        await app.fileManager.renameFile(file, newPath);
        const absolutePath = `${app.vault.adapter.basePath}/${newPath}`;
        await requestGanttApi("PUT", `/tasks/${task.id}`, { hyperlink: absolutePath });
    } catch (e) {
        console.error("Failed to link gantt task:", e);
        new Notice(`ganttにタスク（ID: ${task.id}）は作成しましたが、ノートとの紐付けに失敗しました: ${e.message}`);
        return;
    }

    new Notice(`ganttに追加しました（ID: ${task.id}）`);
};

/**
 * gantt に追加するときの親タスクIDを入力するモーダル
 **/
class GanttParentModal extends (SummaryModal || class {}) {
    constructor(app, defaultVal) {
        super(app);
        this.value = String(defaultVal);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "ganttの親タスクID" });

        const save = () => {
            const parent = normalizeGanttParentId(this.value);
            if (parent === null) {
                new Notice("親タスクIDは0以上の整数で入力してください");
                return;
            }
            localStorage.setItem(GANTT_PARENT_KEY, String(parent));
            new Notice(`ganttの親タスクIDを ${parent} に設定しました`);
            this.close();
        };

        new SummarySetting(contentEl)
            .setName("親タスクID")
            .setDesc("「ganttに追加」で作るタスクの親。0 はルート直下")
            .addText((text) => {
                text.setValue(this.value).onChange((value) => {
                    this.value = value;
                });
            });

        new SummarySetting(contentEl)
            .addButton((btn) => btn.setButtonText("保存").setCta().onClick(save))
            .addButton((btn) => btn.setButtonText("キャンセル").onClick(() => this.close()));

        contentEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.isComposing) {
                e.preventDefault();
                save();
            }
        });

        setTimeout(() => {
            const input = contentEl.querySelector("input[type='text']");
            if (input) {
                input.focus();
                input.select();
            }
        }, 150);
    }

    onClose() {
        this.contentEl.empty();
    }
}

const openGanttParentModal = () => new GanttParentModal(app, getGanttParentId()).open();
