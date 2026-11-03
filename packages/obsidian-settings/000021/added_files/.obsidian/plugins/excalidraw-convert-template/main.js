/**
 * 既存のノートを Excalidraw へ変換するときに、専用の空のテンプレートを使うプラグイン
 * - Excalidraw の変換コマンドを包み、変換の間だけ getBlankDrawing を差し替える
 * - 変換後のノートのタグに excalidraw を足す（文字列の tags: a, b はカンマで分ける）
 **/
const { Notice, Plugin, TFile } = require("obsidian");

const COMMAND_ID = "obsidian-excalidraw-plugin:convert-to-excalidraw";
const EXCALIDRAW_PLUGIN_ID = "obsidian-excalidraw-plugin";
const TEMPLATE_PATH = "00_templates/Excalidraw_Convert_Template.md";

module.exports = class ExcalidrawConvertTemplatePlugin extends Plugin {
    async onload() {
        this.patches = [];
        this.app.workspace.onLayoutReady(() => {
            this.installPatch();
            this.registerInterval(window.setInterval(() => this.installPatch(), 2000));
        });
    }

    installPatch() {
        const excalidrawPlugin = this.app.plugins.plugins[EXCALIDRAW_PLUGIN_ID];
        const command = this.app.commands?.commands?.[COMMAND_ID];
        if (!excalidrawPlugin || !command) return false;
        if (command.__excalidrawConvertTemplateOwner === this) return true;

        const callbackKey = typeof command.checkCallback === "function"
            ? "checkCallback"
            : typeof command.callback === "function"
                ? "callback"
                : null;
        if (!callbackKey) return false;

        const originalCallback = command[callbackKey];
        const wrappedCallback = callbackKey === "checkCallback"
            ? (checking) => checking
                ? originalCallback(true)
                : this.runWithConversionTemplate(excalidrawPlugin, () => {
                    const file = this.app.workspace.getActiveFile();
                    const result = originalCallback(false);
                    void this.ensureExcalidrawTag(file);
                    return result;
                })
            : (...args) => this.runWithConversionTemplate(
                excalidrawPlugin,
                () => originalCallback(...args),
            );

        command[callbackKey] = wrappedCallback;
        command.__excalidrawConvertTemplateOwner = this;
        this.patches.push({ command, callbackKey, originalCallback, wrappedCallback });
        console.log("Excalidraw conversion command patched with dedicated template");
        return true;
    }

    async ensureExcalidrawTag(file) {
        if (!(file instanceof TFile)) return;

        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            const currentFile = this.app.vault.getAbstractFileByPath(file.path);
            if (!(currentFile instanceof TFile)) return;

            const content = await this.app.vault.read(currentFile);
            if (content.includes("excalidraw-plugin: parsed")) {
                await this.app.fileManager.processFrontMatter(currentFile, (frontmatter) => {
                    const existingTags = Array.isArray(frontmatter.tags)
                        ? frontmatter.tags
                        : typeof frontmatter.tags === "string"
                            ? frontmatter.tags.split(",")
                            : [];
                    const tags = existingTags.map((tag) => String(tag).trim().replace(/^#/, "")).filter(Boolean);
                    if (!tags.includes("excalidraw")) tags.push("excalidraw");
                    frontmatter.tags = tags;
                });
                return;
            }

            await new Promise((resolve) => window.setTimeout(resolve, 100));
        }
    }

    runWithConversionTemplate(excalidrawPlugin, invokeCommand) {
        const templateFile = this.app.vault.getAbstractFileByPath(TEMPLATE_PATH);
        if (!(templateFile instanceof TFile)) {
            new Notice(`変換用Excalidrawテンプレートが見つかりません: ${TEMPLATE_PATH}`);
            return false;
        }

        const originalGetBlankDrawing = excalidrawPlugin.getBlankDrawing;
        let restored = false;
        let restoreTimer = null;

        const restore = () => {
            if (restored) return;
            restored = true;
            if (restoreTimer !== null) window.clearTimeout(restoreTimer);
            if (excalidrawPlugin.getBlankDrawing === temporaryGetBlankDrawing) {
                excalidrawPlugin.getBlankDrawing = originalGetBlankDrawing;
            }
        };

        const temporaryGetBlankDrawing = async () => {
            try {
                const template = await this.app.vault.read(templateFile);
                console.log(`Excalidraw conversion template applied: ${TEMPLATE_PATH}`);
                return template;
            } finally {
                restore();
            }
        };

        excalidrawPlugin.getBlankDrawing = temporaryGetBlankDrawing;
        restoreTimer = window.setTimeout(restore, 30000);

        try {
            return invokeCommand();
        } catch (error) {
            restore();
            throw error;
        }
    }

    onunload() {
        for (const patch of this.patches || []) {
            if (patch.command[patch.callbackKey] === patch.wrappedCallback) {
                patch.command[patch.callbackKey] = patch.originalCallback;
            }
            if (patch.command.__excalidrawConvertTemplateOwner === this) {
                delete patch.command.__excalidrawConvertTemplateOwner;
            }
        }
        this.patches = [];
    }
};
