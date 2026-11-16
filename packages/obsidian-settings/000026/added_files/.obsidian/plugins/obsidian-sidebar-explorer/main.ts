/**
 * Sidebar Explorerのメインプラグインクラス。
 * アクセス履歴の集計、ファイルの重要度評価、グラフビュー連携、
 * 各種トグルコマンドや画像一覧連携の登録などを行います。
 **/
import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, Editor, MarkdownView, TFile, FileSystemAdapter, MarkdownFileInfo, Workspace, OpenViewState, PaneType, Modal, Notice, getAllTags } from 'obsidian';
import { SidebarExplorerView, VIEW_TYPE_SIDEBAR_EXPLORER } from './view';
import { buildBacklinkCountMap, calculateFileImportanceScore, collectLinkedFiles, getDragText, DragFileInfo, toggleFileView, isExcalidrawBackedMarkdown, switchToMarkdownViewIfExcalidraw, moveRecordKey } from './utils';
import { around } from 'monkey-around';

interface SidebarExplorerSettings {
    editorPath: string;
    antigravityExecutablePath: string;
    vscodeExecutablePath: string;
    accessCounts: Record<string, number>;
    lastOpened: Record<string, number>;  // ファイルパス -> 最後に開いた日時(timestamp)
    backlinkCounts: Record<string, number>;
    importanceScores: Record<string, number>;
    fileMetrics: Record<string, FileMetrics>;
}

// ファイルのパスをキーにしている記録（ファイルの移動・改名・削除に合わせて付け替える）
const PATH_KEYED_RECORDS = ['accessCounts', 'lastOpened', 'backlinkCounts', 'importanceScores', 'fileMetrics'] as const;

const DEFAULT_SETTINGS: SidebarExplorerSettings = {
    editorPath: "10_summary",
    antigravityExecutablePath: "",
    vscodeExecutablePath: "",
    accessCounts: {},
    lastOpened: {},
    backlinkCounts: {},
    importanceScores: {},
    fileMetrics: {}
}

interface FileMetrics {
    accessCount: number;
    backlinkCount: number;
    lastOpenedAt: number;
    modifiedAt: number;
    outgoingLinkCount: number;
    attachmentCount: number;
    headingCount: number;
    tagCount: number;
    importanceScore: number;
}


export default class SidebarExplorerPlugin extends Plugin {
    settings!: SidebarExplorerSettings;
    statusBarItem!: HTMLElement;
    private uninstallOpenLinkTextPatch: (() => void) | null = null;
    private uninstallOpenFileMarkdownPatch: (() => void) | null = null;
    private markdownViewSwitchTimers = new Set<number>();
    private fileImportanceRefreshTimer: number | null = null;
    private settingsSaveTimer: number | null = null;
    private imagePathsExportTimer: number | null = null;
    private fileImportanceRefreshInProgress = false;
    private fileImportanceRefreshQueued = false;
    private imagePathsExportInProgress = false;
    private imagePathsExportQueued = false;

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new SidebarExplorerSettingTab(this.app, this));
        this.scheduleFileImportanceRefresh(60000);
        // UIレイアウト構築後に画像パス解決インデックスをエクスポート
        this.app.workspace.onLayoutReady(() => {
            this.scheduleImagePathsExport(30000);
        });

        // Register View
        this.registerView(
            VIEW_TYPE_SIDEBAR_EXPLORER,
            (leaf) => new SidebarExplorerView(leaf)
        );

        // --- Graph View Click Interception using monkey-around ---
        // グラフビューからリンクを開く際、左側のペインで開くようにする
        // 既存のペインがあればそれを使用、なければ左側に新規作成
        this.uninstallOpenLinkTextPatch = around(Workspace.prototype, {
            openLinkText(oldOpenLinkText) {
                return async function (
                    this: Workspace,
                    linktext: string,
                    sourcePath: string,
                    newLeaf?: PaneType | boolean,
                    openViewState?: OpenViewState
                ) {
                    // Check if the active view is a graph view
                    const activeLeaf = this.getLeaf(false);
                    const activeViewType = activeLeaf?.view?.getViewType();

                    // If coming from graph view and not explicitly requesting a new leaf
                    if ((activeViewType === 'graph' || activeViewType === 'localgraph') && !newLeaf) {
                        // Try to find an existing root leaf that is not the graph view
                        let targetLeaf: WorkspaceLeaf | null = null;
                        this.iterateRootLeaves((leaf: WorkspaceLeaf) => {
                            if (leaf !== activeLeaf && !targetLeaf) {
                                targetLeaf = leaf;
                            }
                        });

                        if (targetLeaf) {
                            // Use existing leaf
                            this.setActiveLeaf(targetLeaf, { focus: true });
                            return oldOpenLinkText?.apply(this, [linktext, sourcePath, false, openViewState]);
                        } else {
                            // No existing leaf, create a split to the LEFT
                            const newLeftLeaf = this.createLeafBySplit(activeLeaf, 'vertical', true);
                            this.setActiveLeaf(newLeftLeaf, { focus: true });
                            return oldOpenLinkText?.apply(this, [linktext, sourcePath, false, openViewState]);
                        }
                    }

                    // Default behavior for all other cases
                    return oldOpenLinkText?.apply(this, [linktext, sourcePath, newLeaf, openViewState]);
                };
            }
        });


        // Add Ribbon Icon to open view
        this.addRibbonIcon('layout-dashboard', 'Open Sidebar Explorer', () => {
            this.activateView();
        });

        // Add Command: Open Sidebar
        this.addCommand({
            id: 'open-sidebar-explorer',
            name: 'Open Sidebar Explorer',
            callback: () => {
                this.activateView();
            }
        });

        this.addCommand({
            id: 'refresh-sidebar-explorer-index',
            name: 'Refresh Sidebar Explorer Index',
            callback: async () => {
                await this.refreshFileImportanceData();
                await this.exportImagePathsJson();
            }
        });


        // Status Bar Item
        this.statusBarItem = this.addStatusBarItem();
        this.updateStatusBar();

        // File Open Event (Increment count)
        this.registerEvent(
            this.app.workspace.on('file-open', async (file) => {
                if (file) {
                    await this.incrementAccessCount(file.path);
                    this.updateStatusBar();
                } else {
                    this.statusBarItem.setText("");
                }
            })
        );

        // Excalidraw-backed Markdown（例: 通常の「りんご.md」に
        // excalidraw-plugin: parsed が付いたファイル）は、ファイルを開く入口だけ
        // Markdownへ戻す。WorkspaceLeaf.openFileを起点にすることで、同じファイルを
        // 手動でExcalidrawへ切り替えたときのsetViewStateには反応しない。
        const switchOpenedMarkdownBackToMarkdown = (file: TFile | null) => {
            if (!file || !isExcalidrawBackedMarkdown(this.app, file) || file.name?.toLowerCase().endsWith('.excalidraw.md')) return;

            const switchView = () => {
                this.app.workspace.iterateAllLeaves((leaf) => {
                    if ((leaf as any)?.view?.file?.path !== file.path) return;
                    if (leaf.view?.getViewType?.() === 'excalidraw') {
                        void switchToMarkdownViewIfExcalidraw(this.app, leaf, file).catch((error) => {
                            console.warn('Failed to switch Excalidraw-backed Markdown to Markdown view:', error);
                        });
                    }
                });
            };

            // Excalidrawが後からビューを確定・再設定する場合に備えて再確認する。
            [0, 100, 300, 700, 1500, 2500].forEach((delay) => {
                const timer = window.setTimeout(() => {
                    this.markdownViewSwitchTimers.delete(timer);
                    switchView();
                }, delay);
                this.markdownViewSwitchTimers.add(timer);
            });
        };

        this.uninstallOpenFileMarkdownPatch = around(WorkspaceLeaf.prototype, {
            openFile(oldOpenFile) {
                return async function (this: WorkspaceLeaf, file: TFile, openState?: OpenViewState) {
                    const result = await oldOpenFile.apply(this, [file, openState]);
                    switchOpenedMarkdownBackToMarkdown(file instanceof TFile ? file : null);
                    return result;
                };
            },
        });

        // ワークスペース復元は WorkspaceLeaf.openFile を通らないことがある。
        // 起動時のレイアウト確定後に既存Leafを一度だけ確認し、前回終了時の
        // Excalidraw表示が通常の裏面Markdownへ持ち越されるケースも戻す。
        this.app.workspace.onLayoutReady(() => {
            const inspectRestoredLeaves = () => {
                this.app.workspace.iterateAllLeaves((leaf) => {
                    const restoredFile = (leaf as any)?.view?.file;
                    if (restoredFile instanceof TFile) {
                        switchOpenedMarkdownBackToMarkdown(restoredFile);
                    }
                });
            };

            // ExcalidrawビューとmetadataCacheの復元順は環境によって前後するため、
            // 起動直後だけ段階的に再確認する。
            [0, 250, 1000, 2500, 5000].forEach((delay) => {
                const timer = window.setTimeout(() => {
                    this.markdownViewSwitchTimers.delete(timer);
                    inspectRestoredLeaves();
                }, delay);
                this.markdownViewSwitchTimers.add(timer);
            });
        });

        this.registerEvent(this.app.vault.on('create', async (file) => {
            this.scheduleFileImportanceRefresh(60000);
            if (file instanceof TFile && file.path.startsWith('01_data/') && this.IMAGE_EXTENSIONS.includes(file.extension.toLowerCase())) {
                this.scheduleImagePathsExport();
            }
        }));

        // Rename Event (Migrate count)
        this.registerEvent(
            this.app.vault.on('rename', async (file, oldPath) => {
                if (file instanceof TFile) {
                    await this.renameAccessCount(oldPath, file.path);
                    this.scheduleFileImportanceRefresh(60000);
                    if (this.IMAGE_EXTENSIONS.includes(file.extension.toLowerCase())) {
                        this.scheduleImagePathsExport();
                    }
                }
            })
        );

        // Delete Event (Remove count)
        this.registerEvent(
            this.app.vault.on('delete', async (file) => {
                if (file instanceof TFile) {
                    await this.deleteAccessCount(file.path);
                    this.scheduleFileImportanceRefresh(60000);
                    if (this.IMAGE_EXTENSIONS.includes(file.extension.toLowerCase())) {
                        this.scheduleImagePathsExport();
                    }
                }
            })
        );

        this.registerEvent(this.app.metadataCache.on('changed', () => {
            this.scheduleFileImportanceRefresh(1800000);
        }));

        this.registerEvent(this.app.metadataCache.on('deleted', () => {
            this.scheduleFileImportanceRefresh(1800000);
        }));

        this.registerEvent(this.app.metadataCache.on('resolved', () => {
            this.scheduleFileImportanceRefresh(1800000);
        }));
    }

    async onunload() {
        for (const timer of this.markdownViewSwitchTimers) {
            window.clearTimeout(timer);
        }
        this.markdownViewSwitchTimers.clear();

        if (this.fileImportanceRefreshTimer !== null) {
            window.clearTimeout(this.fileImportanceRefreshTimer);
            this.fileImportanceRefreshTimer = null;
        }

        // 予約済みの保存（アクセス数、移動・削除の反映）を、終了前に書き出す。
        if (this.settingsSaveTimer !== null) {
            await this.saveSettings();
        }

        if (this.imagePathsExportTimer !== null) {
            window.clearTimeout(this.imagePathsExportTimer);
            this.imagePathsExportTimer = null;
        }

        // Uninstall the monkey-patch
        if (this.uninstallOpenLinkTextPatch) {
            this.uninstallOpenLinkTextPatch();
            this.uninstallOpenLinkTextPatch = null;
        }

        if (this.uninstallOpenFileMarkdownPatch) {
            this.uninstallOpenFileMarkdownPatch();
            this.uninstallOpenFileMarkdownPatch = null;
        }
    }

    async activateView() {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR_EXPLORER);

        if (leaves.length > 0) {
            // A leaf with our view already exists, use that
            leaf = leaves[0];
        } else {
            // Our view could not be found in the workspace, create a new leaf
            // in the right sidebar for it
            leaf = workspace.getRightLeaf(false);
            if (leaf) await leaf.setViewState({ type: VIEW_TYPE_SIDEBAR_EXPLORER, active: true });
        }

        if (leaf) workspace.revealLeaf(leaf);
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        // 予約済みの保存があれば、この保存に含まれるので取り消す（続けて2回書かない）。
        if (this.settingsSaveTimer !== null) {
            window.clearTimeout(this.settingsSaveTimer);
            this.settingsSaveTimer = null;
        }
        await this.saveData(this.settings);
    }

    scheduleSettingsSave(delayMs = 3000) {
        if (this.settingsSaveTimer !== null) {
            window.clearTimeout(this.settingsSaveTimer);
        }

        this.settingsSaveTimer = window.setTimeout(async () => {
            this.settingsSaveTimer = null;
            await this.saveSettings();
        }, delayMs);
    }

    async incrementAccessCount(path: string) {
        if (!this.settings.accessCounts[path]) {
            this.settings.accessCounts[path] = 0;
        }
        this.settings.accessCounts[path]++;
        // 最後に開いた日時も記録
        this.settings.lastOpened[path] = Date.now();
        this.scheduleSettingsSave();
    }

    scheduleFileImportanceRefresh(delayMs = 10000) {
        if (this.fileImportanceRefreshTimer !== null) {
            window.clearTimeout(this.fileImportanceRefreshTimer);
        }

        this.fileImportanceRefreshTimer = window.setTimeout(async () => {
            this.fileImportanceRefreshTimer = null;
            await this.refreshFileImportanceData();
        }, delayMs);
    }

    scheduleImagePathsExport(delayMs = 5000) {
        if (this.imagePathsExportTimer !== null) {
            window.clearTimeout(this.imagePathsExportTimer);
        }

        this.imagePathsExportTimer = window.setTimeout(async () => {
            this.imagePathsExportTimer = null;
            await this.exportImagePathsJson();
        }, delayMs);
    }

    async refreshFileImportanceData() {
        if (this.fileImportanceRefreshInProgress) {
            this.fileImportanceRefreshQueued = true;
            return;
        }

        this.fileImportanceRefreshInProgress = true;

        const backlinkCounts: Record<string, number> = {};
        const importanceScores: Record<string, number> = {};
        const fileMetrics: Record<string, FileMetrics> = {};
        const now = Date.now();
        const computedBacklinkCounts = buildBacklinkCountMap(this.app.metadataCache);

        try {
            let processed = 0;
            for (const file of this.getRankableMarkdownFiles()) {
                const cache = this.app.metadataCache.getFileCache(file);
                const outgoingLinks = [...(cache?.links || []), ...(cache?.embeds || [])];
                const { attachmentFiles } = collectLinkedFiles(this.app.metadataCache, file, outgoingLinks);
                const tags = cache ? getAllTags(cache) || [] : [];
                const headingCount = cache?.headings?.length || 0;
                const accessCount = this.settings.accessCounts[file.path] || 0;
                const backlinkCount = computedBacklinkCounts[file.path] || 0;
                const lastOpenedAt = this.settings.lastOpened[file.path] || 0;
                const modifiedAt = file.stat.mtime;
                const outgoingLinkCount = outgoingLinks.length;
                const attachmentCount = attachmentFiles.length;
                const tagCount = tags.length;
                const importanceScore = calculateFileImportanceScore({
                    accessCount,
                    backlinkCount,
                    lastOpenedAt,
                    modifiedAt,
                    outgoingLinkCount,
                    attachmentCount,
                    headingCount,
                    tagCount,
                }, now);

                backlinkCounts[file.path] = backlinkCount;
                importanceScores[file.path] = importanceScore;
                fileMetrics[file.path] = {
                    accessCount,
                    backlinkCount,
                    lastOpenedAt,
                    modifiedAt,
                    outgoingLinkCount,
                    attachmentCount,
                    headingCount,
                    tagCount,
                    importanceScore,
                };

                processed += 1;
                if (processed % 200 === 0) {
                    await this.yieldToUi();
                }
            }

            this.settings.backlinkCounts = backlinkCounts;
            this.settings.importanceScores = importanceScores;
            this.settings.fileMetrics = fileMetrics;
            await this.saveSettings();
        } finally {
            this.fileImportanceRefreshInProgress = false;
        }

        if (this.fileImportanceRefreshQueued) {
            this.fileImportanceRefreshQueued = false;
            this.scheduleFileImportanceRefresh();
        }
    }

    getRankableMarkdownFiles(): TFile[] {
        return this.app.vault.getMarkdownFiles().filter((file) => !this.shouldIgnoreForImportance(file.path));
    }

    shouldIgnoreForImportance(path: string): boolean {
        return path.includes('/node_modules/') || path.startsWith('node_modules/');
    }

    async yieldToUi(): Promise<void> {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }

    /**
     * ファイルの移動・改名に合わせて、パスをキーにした記録（アクセス数、最後に開いた日時、重要度など）を付け替える。
     * フォルダごと移動するとファイルの数だけ続けて呼ばれるため、保存はまとめて1回にする。
     */
    async renameAccessCount(oldPath: string, newPath: string) {
        for (const key of PATH_KEYED_RECORDS) {
            moveRecordKey(this.settings[key] as Record<string, unknown>, oldPath, newPath);
        }
        this.scheduleSettingsSave();
    }

    async deleteAccessCount(path: string) {
        for (const key of PATH_KEYED_RECORDS) {
            delete this.settings[key][path];
        }
        this.scheduleSettingsSave();
    }

    updateStatusBar() {
        const file = this.app.workspace.getActiveFile();
        if (file) {
            const count = this.settings.accessCounts[file.path] || 0;
            this.statusBarItem.setText(`Access Count: ${count}`);
        } else {
            this.statusBarItem.setText("");
        }
    }

    // 画像解決用の拡張子リスト
    private readonly IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'ico'];

    /**
     * 保管庫内のすべての画像ファイルのObsidian解決用パスと絶対パスの対応マップを作成し、
     * plugins/obsidian-sidebar-explorer/image_paths.json に非同期で書き出します。
     **/
    async exportImagePathsJson() {
        if (this.imagePathsExportInProgress) {
            this.imagePathsExportQueued = true;
            return;
        }

        this.imagePathsExportInProgress = true;

        const files = this.app.vault.getFiles();
        
        // 1. 保管庫全体のすべての画像ファイルを抽出（競合チェック用）
        const allImageFiles = files.filter(file => this.IMAGE_EXTENSIONS.includes(file.extension.toLowerCase()));

        // 2. 保管庫全体の同名ファイルの出現回数をカウントして競合をチェック
        const nameCountMap: Record<string, number> = {};
        for (const file of allImageFiles) {
            nameCountMap[file.name] = (nameCountMap[file.name] || 0) + 1;
        }

        // 3. 部分パス（親フォルダ名 + ファイル名）の重複回数もカウント（二重競合の回避用）
        const partialPathCountMap: Record<string, number> = {};
        for (const file of allImageFiles) {
            const pathParts = file.path.split('/');
            if (pathParts.length > 1) {
                const partialPath = pathParts.slice(-2).join('/');
                partialPathCountMap[partialPath] = (partialPathCountMap[partialPath] || 0) + 1;
            }
        }

        // 4. エクスポート出力対象は 01_data/ 配下の画像に限定
        const imageFilesToExport = allImageFiles.filter(file => file.path.startsWith('01_data/'));

        const byObsidianPath: Record<string, string> = {};
        
        let basePath = "";
        if (this.app.vault.adapter instanceof FileSystemAdapter) {
            basePath = this.app.vault.adapter.getBasePath();
        }

        for (const file of imageFilesToExport) {
            const absolutePath = basePath ? `${basePath}/${file.path}` : file.path;

            // 5. Obsidianの「最短解決パス（Shortest Path）」をシミュレートした1対1マッピングのキーを決定
            let obsidianPath = file.path; // デフォルトは完全な相対パス

            if (nameCountMap[file.name] === 1) {
                // 保管庫全体で同名画像が一意であれば、最短の「ファイル名単体」
                obsidianPath = file.name;
            } else {
                // 重複がある場合は、親フォルダ名を含める
                const pathParts = file.path.split('/');
                if (pathParts.length > 1) {
                    const partialPath = pathParts.slice(-2).join('/');
                    
                    if (partialPathCountMap[partialPath] === 1) {
                        // 部分パスでも重複がなければ、部分パスを採用
                        obsidianPath = partialPath;
                    } else {
                        // 部分パスでも重複がある場合は、完全な相対パス
                        obsidianPath = file.path;
                    }
                }
            }

            byObsidianPath[obsidianPath] = absolutePath;
        }

        const outputData = {
            byObsidianPath
        };

        const manifestPath = this.manifest.dir;
        const cacheFilePath = manifestPath ? `${manifestPath}/image_paths.json` : '.obsidian/plugins/obsidian-sidebar-explorer/image_paths.json';

        try {
            await this.app.vault.adapter.write(cacheFilePath, JSON.stringify(outputData, null, 2));
        } catch (e) {
            console.error("Failed to export image paths json:", e);
        } finally {
            this.imagePathsExportInProgress = false;
        }

        if (this.imagePathsExportQueued) {
            this.imagePathsExportQueued = false;
            this.scheduleImagePathsExport();
        }
    }
}

class SidebarExplorerSettingTab extends PluginSettingTab {
    constructor(app: App, private plugin: SidebarExplorerPlugin) {
        super(app, plugin);
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName("エディタで開くパス")
            .setDesc("Vaultルートからの相対パス、または絶対パスを指定します。")
            .addText(text => text
                .setPlaceholder("10_summary")
                .setValue(this.plugin.settings.editorPath)
                .onChange(async value => {
                    this.plugin.settings.editorPath = value.trim() || "10_summary";
                    await this.plugin.saveSettings();
                }));

        this.addExecutablePathSetting(
            "Antigravity IDEのパス",
            "Antigravity IDE本体の実行ファイルを指定します。",
            "antigravityExecutablePath",
            this.detectAntigravityExecutable.bind(this),
        );
        this.addExecutablePathSetting(
            "VS Codeのパス",
            "Antigravityを利用できない場合に起動するVS Code本体の実行ファイルを指定します。",
            "vscodeExecutablePath",
            this.detectVsCodeExecutable.bind(this),
        );
    }

    private addExecutablePathSetting(
        name: string,
        description: string,
        key: "antigravityExecutablePath" | "vscodeExecutablePath",
        detect: () => Promise<string | null>,
    ): void {
        const setting = new Setting(this.containerEl).setName(name).setDesc(description);
        setting.addText(text => {
            text.inputEl.style.width = "360px";
            text.setPlaceholder("実行ファイルの絶対パス")
                .setValue(this.plugin.settings[key])
                .onChange(async value => {
                    this.plugin.settings[key] = value.trim();
                    await this.plugin.saveSettings();
                });
        });
        setting.addButton(button => button
            .setButtonText("自動取得")
            .onClick(async () => {
                const detected = await detect();
                if (!detected) {
                    new Notice(`${name}を自動取得できませんでした。手動で入力してください。`);
                    return;
                }
                this.plugin.settings[key] = detected;
                await this.plugin.saveSettings();
                new Notice(`${name}を取得しました。`);
                this.display();
            }));
    }

    private async detectAntigravityExecutable(): Promise<string | null> {
        return this.detectExecutable(
            process.platform === "darwin"
                ? [
                    "/Applications/Antigravity.app/Contents/MacOS/Antigravity",
                    `${process.env.HOME || ""}/Applications/Antigravity.app/Contents/MacOS/Antigravity`,
                ]
                : [
                    `${process.env.LOCALAPPDATA || ""}\\Programs\\Antigravity\\Antigravity.exe`,
                    `${process.env.ProgramFiles || ""}\\Antigravity\\Antigravity.exe`,
                    `${process.env["ProgramFiles(x86)"] || ""}\\Antigravity\\Antigravity.exe`,
                ],
            "antigravity",
        );
    }

    private async detectVsCodeExecutable(): Promise<string | null> {
        return this.detectExecutable(
            process.platform === "darwin"
                ? [
                    "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
                    `${process.env.HOME || ""}/Applications/Visual Studio Code.app/Contents/MacOS/Electron`,
                ]
                : [
                    `${process.env.LOCALAPPDATA || ""}\\Programs\\Microsoft VS Code\\Code.exe`,
                    `${process.env.ProgramFiles || ""}\\Microsoft VS Code\\Code.exe`,
                    `${process.env["ProgramFiles(x86)"] || ""}\\Microsoft VS Code\\Code.exe`,
                ],
            "code",
        );
    }

    private async detectExecutable(candidates: string[], commandName: string): Promise<string | null> {
        const fs = require("fs");
        const existing = candidates.find(candidate => candidate && fs.existsSync(candidate));
        if (existing) return existing;

        const { execFile } = require("child_process");
        const lookupCommand = process.platform === "win32" ? "where.exe" : "which";
        return new Promise(resolve => {
            execFile(lookupCommand, [commandName], (error: any, stdout: string) => {
                if (error) return resolve(null);
                const detected = stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean);
                resolve(detected || null);
            });
        });
    }
}
