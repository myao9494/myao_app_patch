// =============================================================================
// モーダル（サマリーの設定、HTML出力の設定、タグの一括変換）
// =============================================================================

const obsidianLibForSummary = getObsidianModule();
const SummaryModal = obsidianLibForSummary?.Modal;
const SummarySetting = obsidianLibForSummary?.Setting;

const getCommonPromptFiles = (vault) => {
    if (!vault?.getMarkdownFiles) return [];
    const promptFiles = vault.getMarkdownFiles().filter(file =>
        file.path.startsWith("11_common_prompt/") && !file.name.endsWith(".excalidraw.md")
    );
    promptFiles.sort((a, b) => {
        if (a.name === "common_prompt.md") return -1;
        if (b.name === "common_prompt.md") return 1;
        return a.name.localeCompare(b.name);
    });
    return promptFiles;
};

const addCommonPromptToggles = (contentEl, selectedPrompts, vault = app.vault) => {
    const promptFiles = getCommonPromptFiles(vault);
    promptFiles.forEach((file) => {
        const isDefaultOn = file.name === "common_prompt.md";
        selectedPrompts[file.path] = isDefaultOn;

        new SummarySetting(contentEl)
            .setName(file.name)
            .setDesc(file.path)
            .addToggle((toggle) => {
                toggle
                    .setValue(isDefaultOn)
                    .onChange((value) => {
                        selectedPrompts[file.path] = value;
                    });
            });
    });
};

class SummaryDepthModal extends (SummaryModal || class {}) {
    constructor(app, callback) {
        super(app);
        this.callback = callback;
        this.depth = "2";
        this.selectedPrompts = {};
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "サマリー作成の設定" });

        let inputEl = null;

        new SummarySetting(contentEl)
            .setName("最大深さ")
            .setDesc("再帰的に探索するリンクの最大深さを入力してください")
            .addText((text) => {
                inputEl = text.inputEl;
                text
                    .setValue(this.depth)
                    .onChange((value) => {
                        this.depth = value;
                    });
                if (inputEl) {
                    inputEl.type = "number";
                    inputEl.min = "0";
                }
            });

        contentEl.createEl("h3", { text: "共通プロンプトの選択" });

        // サマリーとHTML出力で同じ common prompt の選択肢を使う。
        addCommonPromptToggles(contentEl, this.selectedPrompts, this.app.vault);

        new SummarySetting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText("作成")
                    .setCta()
                    .onClick(() => {
                        this.close();
                        const selectedPaths = Object.keys(this.selectedPrompts).filter(
                            (path) => this.selectedPrompts[path]
                        );
                        this.callback({ depth: this.depth, selectedPrompts: selectedPaths });
                    })
            )
            .addButton((btn) =>
                btn
                    .setButtonText("キャンセル")
                    .onClick(() => {
                        this.close();
                        this.callback(null);
                    })
            );

        // 自動フォーカス ＋ 全選択（onOpenのタイミングで確実に実行する）
        if (inputEl) {
            setTimeout(() => {
                inputEl.focus();
                inputEl.select();
            }, 50);
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class AiHtmlExportOptionsModal extends (SummaryModal || class {}) {
    constructor(app, callback) {
        super(app);
        this.callback = callback;
        this.selectedPrompts = {};
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "AIコンテキスト用HTMLの設定" });
        contentEl.createEl("p", { text: "HTMLに含める共通プロンプトを選択してください。" });
        contentEl.createEl("h3", { text: "共通プロンプトの選択" });

        addCommonPromptToggles(contentEl, this.selectedPrompts, this.app.vault);

        new SummarySetting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText("出力")
                    .setCta()
                    .onClick(() => {
                        const callback = this.callback;
                        this.callback = null;
                        this.close();
                        callback?.({
                            selectedPrompts: Object.keys(this.selectedPrompts).filter(
                                (path) => this.selectedPrompts[path]
                            )
                        });
                    })
            )
            .addButton((btn) =>
                btn
                    .setButtonText("キャンセル")
                    .onClick(() => {
                        const callback = this.callback;
                        this.callback = null;
                        this.close();
                        callback?.(null);
                    })
            );
    }

    onClose() {
        if (this.callback) {
            const callback = this.callback;
            this.callback = null;
            callback(null);
        }
    }
}

class TagRenameModal extends (SummaryModal || class {}) {
    constructor(app, defaultVal, callback) {
        super(app);
        this.defaultVal = defaultVal;
        this.callback = callback;
        this.value = defaultVal;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "タグの一括変換" });

        new SummarySetting(contentEl)
            .setName("新しいタグ名")
            .setDesc("置換後のタグ名を入力してください（結合またはリネーム）")
            .addText((text) => {
                text
                    .setValue(this.value)
                    .onChange((value) => {
                        this.value = value;
                    });
            });

        new SummarySetting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText("変換")
                    .setCta()
                    .onClick(() => {
                        this.close();
                        this.callback(this.value);
                    })
            )
            .addButton((btn) =>
                btn
                    .setButtonText("キャンセル")
                    .onClick(() => {
                        this.close();
                        this.callback(null);
                    })
            );

        // Enterキーで変換を実行できるようにする
        contentEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                if (e.isComposing) return; // IME変換中のEnterを無視
                e.preventDefault();
                this.close();
                this.callback(this.value);
            }
        });

        // 確実にフォーカスと全選択を行うための遅延処理
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
