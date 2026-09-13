/**
 * Sidebar Explorerのビューコンポーネントを提供するモジュール。
 * 今日のフォルダ、開いている関連ファイル、開いているファイルのフォルダ、データビュー、
 * common prompt、最近開いたファイルなどの各セクションを表示し、フォルダのOS起動や
 * 最上部のアクションボタン群（エディタで開く、画像一覧の表示等）を提供します。
 **/
import { ItemView, WorkspaceLeaf, TFile, LinkCache, TAbstractFile, getAllTags, Menu, MenuItem, FileSystemAdapter, Modal, Notice, Setting, App, setIcon, TFolder, moment } from "obsidian";
import { getIconName, getIconNameFromFilename, getIconPath } from "./iconMap";
import { calculateFileImportanceScore, getOpenFolderCommandArgs, getDragText, setupObsidianFileDrag, getBacklinkPaths, buildExcalidrawWebUrl, collectLinkedFiles, isAttachmentFile, isImageFile, openFileInSplitTab, toggleFileView, openFileInMarkdownView, filterFolderFiles, buildFileManagerWebUrl, openInVsCode } from "./utils";

export const VIEW_TYPE_SIDEBAR_EXPLORER = "sidebar-explorer-view";

// アイコンSVGのキャッシュ
const iconCache: Map<string, string> = new Map();
const IMAGE_DIFF_API_BASE_URL = "http://127.0.0.1:8078/api";
const IMAGE_DIFF_APP_BASE_URL = "http://127.0.0.1:8078/";

interface TagNode {
    name: string;
    fullPath: string;
    count: number;
    totalCount: number;
    children: { [key: string]: TagNode };
}

export class SidebarExplorerView extends ItemView {
    private static readonly RELATED_FILES_REFRESH_DEBOUNCE_MS = 750;
    private static readonly TOP_ACCESS_REFRESH_DEBOUNCE_MS = 1500;
    private relatedFilesRefreshTimer: number | null = null;
    private topAccessRefreshTimer: number | null = null;
    private relatedFilesRevision = 0;
    private lastRenderedRelatedKey: string | null = null;
    // 本文の変更だけでは関連ファイルの表示内容は変わらないため、
    // ファイルごとのリンク集合だけを覚えて不要な Vault 全体走査を避ける。
    private relatedLinkSignatureByPath = new Map<string, string | null>();

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
    }

    getViewType() {
        return VIEW_TYPE_SIDEBAR_EXPLORER;
    }

    getDisplayText() {
        return "Sidebar Explorer";
    }

    getIcon() {
        return "layout-dashboard";
    }

    async onOpen() {
        const container = this.contentEl;
        container.empty();
        container.addClass("sidebar-explorer-container");

        this.renderAll(container);

        // Event Listeners
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
            this.scheduleRelatedFilesRefresh();
            this.refreshActiveFolderFiles();
        }));

        // ファイルを開いたときに最近開いたファイルとアクセス数を更新
        this.registerEvent(this.app.workspace.on('file-open', () => {
            this.refreshRecentFiles();
            this.scheduleTopAccessRefresh();
        }));

        this.registerEvent(this.app.vault.on('create', (file) => {
            this.refreshFolderSectionsForFileChange(file);
            this.bumpRelatedFilesRevision();
            this.scheduleTopAccessRefresh();
            this.scheduleRelatedFilesRefresh();
        }));

        this.registerEvent(this.app.vault.on('delete', (file) => {
            this.relatedLinkSignatureByPath.delete(file.path);
            this.refreshFolderSectionsForFileChange(file);
            this.bumpRelatedFilesRevision();
            this.scheduleTopAccessRefresh();
            this.scheduleRelatedFilesRefresh();
        }));

        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            this.relatedLinkSignatureByPath.delete(oldPath);
            this.relatedLinkSignatureByPath.delete(file.path);
            this.refreshFolderSectionsForFileChange(file, oldPath);
            this.bumpRelatedFilesRevision();
            this.scheduleTopAccessRefresh();
            this.scheduleRelatedFilesRefresh();
        }));

        this.registerEvent(this.app.metadataCache.on('changed', (changedFile) => {
            if (!(changedFile instanceof TFile)) {
                this.bumpRelatedFilesRevision();
                this.scheduleRelatedFilesRefresh();
                return;
            }

            const signature = this.getRelatedLinkSignature(changedFile);
            const previousSignature = this.relatedLinkSignatureByPath.get(changedFile.path);
            this.relatedLinkSignatureByPath.set(changedFile.path, signature);

            // 同じリンク集合であれば、本文・タグ・プロパティだけの変更なので
            // 関連ファイル表示を再構築する必要はない。
            if (previousSignature === signature) {
                return;
            }

            this.bumpRelatedFilesRevision();
            // 別ノートから現在のノートへのリンク追加・削除も反映する。
            this.scheduleRelatedFilesRefresh();
        }));

        this.registerEvent(this.app.metadataCache.on('deleted', () => {
            this.bumpRelatedFilesRevision();
        }));

        this.registerEvent(this.app.metadataCache.on('resolved', () => {
            this.bumpRelatedFilesRevision();
        }));

        // Enable focus
        container.setAttr("tabindex", "0");

        // Keyboard Events
        this.registerDomEvent(container, "keydown", (e: KeyboardEvent) => {
            if (this.handleKeyDown(e)) {
                e.preventDefault();
            }
        });

        // Update selectables when clicking manually to reset or partial logic
        this.registerDomEvent(container, "click", (e: MouseEvent) => {
            // Find closest sidebar-item
            const target = e.target as HTMLElement;
            const item = target.closest(".sidebar-item");
            if (item && item instanceof HTMLElement) {
                this.selectItem(item);
            }
        });
    }

    async onClose() {
        this.clearRelatedFilesRefreshTimer();
        this.clearTopAccessRefreshTimer();
        this.relatedLinkSignatureByPath.clear();
        // Events are automatically cleaned up by registerEvent
    }

    private todaysFolderSectionContent: HTMLElement | null = null;
    private relatedSectionContent: HTMLElement | null = null;
    private activeFolderSectionContent: HTMLElement | null = null;
    private dataviewSectionContent: HTMLElement | null = null;
    private commonPromptSectionContent: HTMLElement | null = null;
    private recentFilesSectionContent: HTMLElement | null = null;
    private topAccessSectionContent: HTMLElement | null = null;
    private activeFolderSearchQuery: string = "";
    private dataviewSearchQuery: string = "";
    private commonPromptSearchQuery: string = "";
    private recentFilesSearchQuery: string = "";
    private topAccessSearchQuery: string = "";

    // Keyboard Navigation Properties
    private selectedItem: HTMLElement | null = null;
    private selectableItems: HTMLElement[] = [];

    private bumpRelatedFilesRevision() {
        this.relatedFilesRevision += 1;
    }

    private getRelatedLinkSignature(file: TFile): string | null {
        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache) {
            return null;
        }
        const references = [...(cache?.links || []), ...(cache?.embeds || [])];
        const linkpaths = new Set<string>();

        for (const reference of references) {
            if (typeof reference.link === "string" && reference.link.length > 0) {
                linkpaths.add(reference.link);
            }
        }

        return Array.from(linkpaths).sort().join("\u001f");
    }

    private refreshFolderSectionsForFileChange(file: TAbstractFile, oldPath?: string) {
        const paths = [file.path, oldPath].filter((path): path is string => Boolean(path));
        const affectsFolderListing = (folderPath: string) => paths.some(path =>
            this.pathAffectsDirectFolderListing(path, folderPath)
        );

        const todayPath = `01_data/${moment().format("YYYY/MM/DD")}`;
        if (affectsFolderListing(todayPath)) {
            this.refreshTodaysFolder();
        }
        if (affectsFolderListing("03_Dataview")) {
            this.refreshDataviewFiles();
        }
        if (affectsFolderListing("11_common_prompt")) {
            this.refreshCommonPromptFiles();
        }

        const activeFile = this.app.workspace.getActiveFile();
        const activeFolderPath = activeFile?.parent?.path ?? "";
        if (activeFile && affectsFolderListing(activeFolderPath)) {
            this.refreshActiveFolderFiles();
        }
    }

    private pathAffectsDirectFolderListing(path: string, folderPath: string): boolean {
        const normalizedPath = path.replace(/\\/g, "/");
        if (normalizedPath === folderPath) {
            return true;
        }

        const prefix = `${folderPath}/`;
        if (!normalizedPath.startsWith(prefix)) {
            return false;
        }

        return !normalizedPath.slice(prefix.length).includes("/");
    }

    private clearRelatedFilesRefreshTimer() {
        if (this.relatedFilesRefreshTimer !== null) {
            window.clearTimeout(this.relatedFilesRefreshTimer);
            this.relatedFilesRefreshTimer = null;
        }
    }

    private clearTopAccessRefreshTimer() {
        if (this.topAccessRefreshTimer !== null) {
            window.clearTimeout(this.topAccessRefreshTimer);
            this.topAccessRefreshTimer = null;
        }
    }

    private scheduleRelatedFilesRefresh(immediate = false) {
        this.clearRelatedFilesRefreshTimer();

        if (immediate) {
            this.refreshRelatedFiles();
            return;
        }

        this.relatedFilesRefreshTimer = window.setTimeout(() => {
            this.relatedFilesRefreshTimer = null;
            this.refreshRelatedFiles();
        }, SidebarExplorerView.RELATED_FILES_REFRESH_DEBOUNCE_MS);
    }

    private scheduleTopAccessRefresh(immediate = false) {
        this.clearTopAccessRefreshTimer();

        if (immediate) {
            this.refreshTopAccessFiles();
            return;
        }

        this.topAccessRefreshTimer = window.setTimeout(() => {
            this.topAccessRefreshTimer = null;
            this.refreshTopAccessFiles();
        }, SidebarExplorerView.TOP_ACCESS_REFRESH_DEBOUNCE_MS);
    }

    renderAll(container: HTMLElement) {
        // Create Sections once

        // 0. 画像一覧の表示ボタン (最上部)
        const buttonContainer = container.createDiv({ cls: "sidebar-action-button-container" });
        buttonContainer.style.padding = "6px 8px";
        buttonContainer.style.borderBottom = "1px solid var(--background-modifier-border)";

        // ボタン: 画像一覧の表示
        const openImagesBtn = buttonContainer.createEl("button", {
            text: "🖼️ 画像一覧の表示",
            cls: "sidebar-action-button"
        });
        openImagesBtn.style.width = "100%";
        openImagesBtn.style.padding = "4px 8px";
        openImagesBtn.style.backgroundColor = "transparent";
        openImagesBtn.style.color = "var(--text-muted)";
        openImagesBtn.style.border = "1px solid var(--background-modifier-border)";
        openImagesBtn.style.borderRadius = "4px";
        openImagesBtn.style.cursor = "pointer";
        openImagesBtn.style.fontSize = "0.85em";
        openImagesBtn.style.display = "flex";
        openImagesBtn.style.justifyContent = "center";
        openImagesBtn.style.alignItems = "center";
        openImagesBtn.style.gap = "4px";
        openImagesBtn.style.transition = "background-color 0.15s ease, color 0.15s ease, transform 0.1s ease";

        // 地味で大人しいホバーエフェクトとクリック時の微細アニメーション
        openImagesBtn.addEventListener("mouseenter", () => {
            openImagesBtn.style.backgroundColor = "var(--background-modifier-hover)";
            openImagesBtn.style.color = "var(--text-normal)";
        });
        openImagesBtn.addEventListener("mouseleave", () => {
            openImagesBtn.style.backgroundColor = "transparent";
            openImagesBtn.style.color = "var(--text-muted)";
        });
        openImagesBtn.addEventListener("mousedown", () => {
            openImagesBtn.style.transform = "scale(0.98)";
        });
        openImagesBtn.addEventListener("mouseup", () => {
            openImagesBtn.style.transform = "scale(1)";
        });

        openImagesBtn.onclick = async () => {
            const hasPlugin = (this.app as any).plugins.enabledPlugins.has("obsidian-excalidraw-cards");
            if (hasPlugin) {
                (this.app as any).commands.executeCommandById("obsidian-excalidraw-cards:excalidraw_open_close");
            } else {
                new Notice("obsidian-excalidraw-cards プラグインが有効化されていません。");
            }
        };

        // ボタン: サマリフォルダをOSのファイルマネージャーで開く
        const openSummaryFolderBtn = buttonContainer.createEl("button", {
            text: "📁 サマリフォルダを開く",
            cls: "sidebar-action-button"
        });
        openSummaryFolderBtn.style.cssText = openImagesBtn.style.cssText;
        openSummaryFolderBtn.style.marginTop = "6px";

        openSummaryFolderBtn.addEventListener("mouseenter", () => {
            openSummaryFolderBtn.style.backgroundColor = "var(--background-modifier-hover)";
            openSummaryFolderBtn.style.color = "var(--text-normal)";
        });
        openSummaryFolderBtn.addEventListener("mouseleave", () => {
            openSummaryFolderBtn.style.backgroundColor = "transparent";
            openSummaryFolderBtn.style.color = "var(--text-muted)";
        });
        openSummaryFolderBtn.addEventListener("mousedown", () => {
            openSummaryFolderBtn.style.transform = "scale(0.98)";
        });
        openSummaryFolderBtn.addEventListener("mouseup", () => {
            openSummaryFolderBtn.style.transform = "scale(1)";
        });

        openSummaryFolderBtn.onclick = () => {
            const summaryPath = "10_summary";
            const fullPath = this.app.vault.adapter instanceof FileSystemAdapter
                ? this.app.vault.adapter.getFullPath(summaryPath)
                : summaryPath;
            const fs = require("fs");
            const os = require("os");
            const { execFile } = require("child_process");

            if (!fs.existsSync(fullPath)) {
                new Notice("サマリフォルダがまだ作成されていません。");
                return;
            }

            const openCommand = getOpenFolderCommandArgs(os.platform(), fullPath);
            if (!openCommand) {
                new Notice("このOSではフォルダを開けません。");
                return;
            }

            execFile(openCommand.command, openCommand.args, (error: any) => {
                if (error) {
                    new Notice("サマリフォルダを開けませんでした。");
                    console.error("Failed to open summary folder:", error);
                }
            });
        };

        // フォルダを開く共通ヘルパー関数
        const createFolderOpenButton = (text: string, folderPath: string, notCreatedMsg: string, failedMsg: string) => {
            const btn = buttonContainer.createEl("button", {
                text: text,
                cls: "sidebar-action-button"
            });
            btn.style.cssText = openImagesBtn.style.cssText;
            btn.style.marginTop = "6px";

            btn.addEventListener("mouseenter", () => {
                btn.style.backgroundColor = "var(--background-modifier-hover)";
                btn.style.color = "var(--text-normal)";
            });
            btn.addEventListener("mouseleave", () => {
                btn.style.backgroundColor = "transparent";
                btn.style.color = "var(--text-muted)";
            });
            btn.addEventListener("mousedown", () => {
                btn.style.transform = "scale(0.98)";
            });
            btn.addEventListener("mouseup", () => {
                btn.style.transform = "scale(1)";
            });

            btn.onclick = () => {
                const fullPath = this.app.vault.adapter instanceof FileSystemAdapter
                    ? this.app.vault.adapter.getFullPath(folderPath)
                    : folderPath;
                const fs = require("fs");
                const os = require("os");
                const { execFile } = require("child_process");

                if (!fs.existsSync(fullPath)) {
                    new Notice(notCreatedMsg);
                    return;
                }

                const openCommand = getOpenFolderCommandArgs(os.platform(), fullPath);
                if (!openCommand) {
                    new Notice("このOSではフォルダを開けません。");
                    return;
                }

                execFile(openCommand.command, openCommand.args, (error: any) => {
                    if (error) {
                        new Notice(failedMsg);
                        console.error(`Failed to open ${folderPath} folder:`, error);
                    }
                });
            };
            return btn;
        };



        // ボタン: temp フォルダを開く
        createFolderOpenButton("📁 temp フォルダを開く", "temp", "temp フォルダがまだ作成されていません。", "temp フォルダを開けませんでした。");

        // ボタン: 設定したパスをAntigravity（未導入時はVS Code）で開く
        const openInEditorBtn = buttonContainer.createEl("button", {
            text: "🚀 エディタで開く",
            cls: "sidebar-action-button"
        });
        openInEditorBtn.style.cssText = openImagesBtn.style.cssText;
        openInEditorBtn.style.marginTop = "6px";

        openInEditorBtn.addEventListener("mouseenter", () => {
            openInEditorBtn.style.backgroundColor = "var(--background-modifier-hover)";
            openInEditorBtn.style.color = "var(--text-normal)";
        });
        openInEditorBtn.addEventListener("mouseleave", () => {
            openInEditorBtn.style.backgroundColor = "transparent";
            openInEditorBtn.style.color = "var(--text-muted)";
        });
        openInEditorBtn.addEventListener("mousedown", () => {
            openInEditorBtn.style.transform = "scale(0.98)";
        });
        openInEditorBtn.addEventListener("mouseup", () => {
            openInEditorBtn.style.transform = "scale(1)";
        });

        openInEditorBtn.onclick = async () => {
            const plugin = (this.app as any).plugins.getPlugin("obsidian-sidebar-explorer");
            const configuredPath = plugin?.settings?.editorPath || "10_summary";
            const path = require("path");
            const fs = require("fs");
            const os = require("os");
            const { execFile } = require("child_process");
            const targetPath = path.isAbsolute(configuredPath)
                ? configuredPath
                : (this.app.vault.adapter instanceof FileSystemAdapter
                    ? this.app.vault.adapter.getFullPath(configuredPath)
                    : configuredPath);

            if (!fs.existsSync(targetPath)) {
                new Notice(`設定されたパスが見つかりません: ${configuredPath}`);
                return;
            }

            const run = (command: string, args: string[]) => new Promise<boolean>(resolve => {
                execFile(command, args, (error: any) => resolve(!error));
            });
            const platform = os.platform();
            let opened = false;
            const antigravityExecutable = plugin?.settings?.antigravityExecutablePath?.trim();
            const vscodeExecutable = plugin?.settings?.vscodeExecutablePath?.trim();

            if (antigravityExecutable && fs.existsSync(antigravityExecutable)) {
                opened = await run(antigravityExecutable, [targetPath]);
            }

            if (!opened && platform === "darwin" && !antigravityExecutable) {
                if (await run("open", ["-Ra", "Antigravity"])) {
                    opened = await run("open", ["-a", "Antigravity", targetPath]);
                }
            } else if (!opened && platform === "win32" && !antigravityExecutable) {
                const env = process.env;
                const antigravityCandidates = [
                    path.join(env.LOCALAPPDATA || "", "Programs", "Antigravity", "Antigravity.exe"),
                    path.join(env.ProgramFiles || "", "Antigravity", "Antigravity.exe"),
                    path.join(env["ProgramFiles(x86)"] || "", "Antigravity", "Antigravity.exe")
                ].filter((candidate: string) => fs.existsSync(candidate));
                if (antigravityCandidates.length > 0) {
                    opened = await run(antigravityCandidates[0], [targetPath]);
                } else {
                    opened = await run("antigravity", [targetPath]);
                }
            }

            if (!opened && vscodeExecutable && fs.existsSync(vscodeExecutable)) {
                opened = await run(vscodeExecutable, [targetPath]);
            }

            if (!opened && !vscodeExecutable) {
                if (platform === "darwin") {
                    opened = await run("open", ["-a", "Visual Studio Code", targetPath]);
                } else if (platform === "win32") {
                    const env = process.env;
                    const codeCandidates = [
                        path.join(env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "Code.exe"),
                        path.join(env.ProgramFiles || "", "Microsoft VS Code", "Code.exe"),
                        path.join(env["ProgramFiles(x86)"] || "", "Microsoft VS Code", "Code.exe")
                    ].filter((candidate: string) => fs.existsSync(candidate));
                    opened = codeCandidates.length > 0
                        ? await run(codeCandidates[0], [targetPath])
                        : await run("code", [targetPath]);
                }
            }

            if (!opened) {
                new Notice("Antigravity または VS Code を起動できませんでした。");
            }
        };

        // ボタン: ゴミ箱を開く
        const openTrashBtn = buttonContainer.createEl("button", {
            text: "🗑️ ゴミ箱を開く",
            cls: "sidebar-action-button"
        });
        openTrashBtn.style.cssText = openImagesBtn.style.cssText;
        openTrashBtn.style.marginTop = "6px";

        openTrashBtn.addEventListener("mouseenter", () => {
            openTrashBtn.style.backgroundColor = "var(--background-modifier-hover)";
            openTrashBtn.style.color = "var(--text-normal)";
        });
        openTrashBtn.addEventListener("mouseleave", () => {
            openTrashBtn.style.backgroundColor = "transparent";
            openTrashBtn.style.color = "var(--text-muted)";
        });
        openTrashBtn.addEventListener("mousedown", () => {
            openTrashBtn.style.transform = "scale(0.98)";
        });
        openTrashBtn.addEventListener("mouseup", () => {
            openTrashBtn.style.transform = "scale(1)";
        });

        openTrashBtn.onclick = () => {
            const os = require("os");
            const path = require("path");
            const { execFile } = require("child_process");
            const platform = os.platform();

            if (platform === "darwin") {
                const trashPath = path.join(os.homedir(), ".Trash");
                execFile("open", [trashPath], (error: any) => {
                    if (error) {
                        new Notice("ゴミ箱を開けませんでした。");
                        console.error("Failed to open Mac Trash:", error);
                    }
                });
            } else if (platform === "win32") {
                execFile("explorer.exe", ["shell:RecycleBinFolder"], (error: any) => {
                    if (error) {
                        console.log("Explorer RecycleBinFolder execution error:", error);
                    }
                });
            } else {
                new Notice("このOSではゴミ箱を開けません。");
            }
        };

        // 1. Today's Folder
        this.todaysFolderSectionContent = this.createSection(container, `今日のフォルダ (${moment().format("YYYY-MM-DD")})`, "📅", (header) => {
            const titleWrapper = header.querySelector('.sidebar-header-title') as HTMLElement;
            if (titleWrapper) {
                titleWrapper.style.cursor = "pointer";
                titleWrapper.title = "クリックでフォルダをOSで開く";
                titleWrapper.onclick = (e) => {
                    e.stopPropagation(); // ヘッダーの開閉イベントをフック

                    const todayPath = `01_data/${moment().format("YYYY/MM/DD")}`;
                    let fullPath = todayPath;
                    if (this.app.vault.adapter instanceof FileSystemAdapter) {
                        fullPath = this.app.vault.adapter.getFullPath(todayPath);
                    }

                    const fs = require("fs");
                    const os = require("os");
                    const { execFile } = require("child_process");

                    if (!fs.existsSync(fullPath)) {
                        new Notice("今日のフォルダがまだ作成されていません。");
                        return;
                    }

                    const platform = os.platform();
                    const openCommand = getOpenFolderCommandArgs(platform, fullPath);
                    if (openCommand) {
                        execFile(openCommand.command, openCommand.args, (error: any) => {
                            if (error) {
                                new Notice("フォルダを開けませんでした。");
                                console.error("Failed to open folder:", error);
                            }
                        });
                    }
                };
                titleWrapper.oncontextmenu = (e) => {
                    this.showFolderHeaderContextMenu(e, () => {
                        const todayPath = `01_data/${moment().format("YYYY/MM/DD")}`;
                        return this.app.vault.adapter instanceof FileSystemAdapter
                            ? this.app.vault.adapter.getFullPath(todayPath)
                            : null;
                    }, "今日のフォルダがまだ作成されていません。");
                };
            }
        });
        this.refreshTodaysFolder();

        // 2. Related Files
        this.relatedSectionContent = this.createSection(container, "開いている関連ファイル", "🔗", (header) => {
            const titleWrapper = header.querySelector('.sidebar-header-title') as HTMLElement;
            if (titleWrapper) {
                titleWrapper.style.cursor = "pointer";
                titleWrapper.title = "クリックで現在のMarkdownファイルのフォルダをOSで開く";
                titleWrapper.onclick = (e) => {
                    e.stopPropagation(); // ヘッダーの開閉イベントをフック

                    const activeFile = this.app.workspace.getActiveFile();
                    if (!(activeFile instanceof TFile) || activeFile.extension.toLowerCase() !== "md") {
                        new Notice("現在開いているMarkdownファイルがありません。");
                        return;
                    }

                    const folderPath = activeFile.parent?.path ?? "";
                    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
                        new Notice("この環境ではファイルのフォルダを表示できません。");
                        return;
                    }

                    const fullPath = this.app.vault.adapter.getFullPath(folderPath);
                    const fs = require("fs");
                    const os = require("os");
                    const { execFile } = require("child_process");

                    if (!fs.existsSync(fullPath)) {
                        new Notice("ファイルのフォルダが見つかりません。");
                        return;
                    }

                    const openCommand = getOpenFolderCommandArgs(os.platform(), fullPath);
                    if (!openCommand) {
                        new Notice("このOSではフォルダを開けません。");
                        return;
                    }

                    execFile(openCommand.command, openCommand.args, (error: any) => {
                        if (error) {
                            new Notice("ファイルのフォルダを開けませんでした。");
                            console.error("Failed to open active file folder:", error);
                        }
                    });
                };
            }
        });
        this.scheduleRelatedFilesRefresh(true);

        // 2.1 Active File's Folder - 検索ボックス付き・クリックでフォルダ起動
        this.activeFolderSectionContent = this.createSection(container, "開いているファイルのフォルダ", "📁", (header) => {
            const titleWrapper = header.querySelector('.sidebar-header-title') as HTMLElement;
            if (titleWrapper) {
                titleWrapper.style.cursor = "pointer";
                titleWrapper.title = "クリックでフォルダをOSで開く";
                titleWrapper.onclick = (e) => {
                    e.stopPropagation();

                    const activeFile = this.app.workspace.getActiveFile();
                    if (!activeFile) {
                        new Notice("現在開いているファイルがありません。");
                        return;
                    }

                    const folderPath = activeFile.parent?.path ?? "";
                    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
                        new Notice("この環境ではファイルのフォルダを表示できません。");
                        return;
                    }

                    const fullPath = this.app.vault.adapter.getFullPath(folderPath);
                    const fs = require("fs");
                    const os = require("os");
                    const { execFile } = require("child_process");

                    if (!fs.existsSync(fullPath)) {
                        new Notice("ファイルのフォルダが見つかりません。");
                        return;
                    }

                    const openCommand = getOpenFolderCommandArgs(os.platform(), fullPath);
                    if (!openCommand) {
                        new Notice("このOSではフォルダを開けません。");
                        return;
                    }

                    execFile(openCommand.command, openCommand.args, (error: any) => {
                        if (error) {
                            new Notice("ファイルのフォルダを開けませんでした。");
                            console.error("Failed to open active file folder:", error);
                        }
                    });
                };
                titleWrapper.oncontextmenu = (e) => {
                    this.showFolderHeaderContextMenu(e, () => {
                        const activeFile = this.app.workspace.getActiveFile();
                        if (!activeFile) return null;
                        const folderPath = activeFile.parent?.path ?? "";
                        return this.app.vault.adapter instanceof FileSystemAdapter
                            ? this.app.vault.adapter.getFullPath(folderPath)
                            : null;
                    }, "現在開いているファイルがありません。");
                };
            }

            const searchContainer = header.createDiv({ cls: "sidebar-search-container" });
            searchContainer.style.display = "flex";
            searchContainer.style.marginLeft = "auto";
            searchContainer.style.marginRight = "10px";
            searchContainer.onclick = (e) => e.stopPropagation();

            const input = searchContainer.createEl("input", {
                type: "text",
                attr: { placeholder: "検索..." }
            });
            input.style.width = "100px";
            input.style.fontSize = "0.8em";
            input.style.padding = "2px 4px";
            input.style.borderRadius = "4px";
            input.style.border = "1px solid var(--background-modifier-border)";

            input.oninput = (e) => {
                this.activeFolderSearchQuery = (e.target as HTMLInputElement).value;
                this.refreshActiveFolderFiles();
            };
        });
        this.refreshActiveFolderFiles();

        // 2.5 Dataview - 検索ボックス付き・クリックでフォルダ起動
        this.dataviewSectionContent = this.createSection(container, "データビュー", "📊", (header) => {
            const titleWrapper = header.querySelector('.sidebar-header-title') as HTMLElement;
            if (titleWrapper) {
                titleWrapper.style.cursor = "pointer";
                titleWrapper.title = "クリックでフォルダをOSで開く";
                titleWrapper.onclick = (e) => {
                    e.stopPropagation();
                    const folderPath = "03_Dataview";
                    let fullPath = folderPath;
                    if (this.app.vault.adapter instanceof FileSystemAdapter) {
                        fullPath = this.app.vault.adapter.getFullPath(folderPath);
                    }
                    const fs = require("fs");
                    const os = require("os");
                    const { execFile } = require("child_process");

                    if (!fs.existsSync(fullPath)) {
                        new Notice("データビューフォルダがまだ作成されていません。");
                        return;
                    }

                    const platform = os.platform();
                    const openCommand = getOpenFolderCommandArgs(platform, fullPath);
                    if (openCommand) {
                        execFile(openCommand.command, openCommand.args, (error: any) => {
                            if (error) {
                                new Notice("フォルダを開けませんでした。");
                                console.error("Failed to open folder:", error);
                            }
                        });
                    }
                };
                titleWrapper.oncontextmenu = (e) => {
                    this.showFolderHeaderContextMenu(e, () => {
                        const folderPath = "03_Dataview";
                        return this.app.vault.adapter instanceof FileSystemAdapter
                            ? this.app.vault.adapter.getFullPath(folderPath)
                            : null;
                    }, "データビューフォルダがまだ作成されていません。");
                };
            }

            const searchContainer = header.createDiv({ cls: "sidebar-search-container" });
            searchContainer.style.display = "flex";
            searchContainer.style.marginLeft = "auto";
            searchContainer.style.marginRight = "10px";
            searchContainer.onclick = (e) => e.stopPropagation();

            const input = searchContainer.createEl("input", {
                type: "text",
                attr: { placeholder: "検索..." }
            });
            input.style.width = "100px";
            input.style.fontSize = "0.8em";
            input.style.padding = "2px 4px";
            input.style.borderRadius = "4px";
            input.style.border = "1px solid var(--background-modifier-border)";

            input.oninput = (e) => {
                this.dataviewSearchQuery = (e.target as HTMLInputElement).value;
                this.refreshDataviewFiles();
            };
        });
        this.refreshDataviewFiles();

        // 2.6 Common Prompt - 検索ボックス付き・クリックでフォルダ起動
        this.commonPromptSectionContent = this.createSection(container, "common prompt", "💡", (header) => {
            const titleWrapper = header.querySelector('.sidebar-header-title') as HTMLElement;
            if (titleWrapper) {
                titleWrapper.style.cursor = "pointer";
                titleWrapper.title = "クリックでフォルダをOSで開く";
                titleWrapper.onclick = (e) => {
                    e.stopPropagation();
                    const folderPath = "11_common_prompt";
                    let fullPath = folderPath;
                    if (this.app.vault.adapter instanceof FileSystemAdapter) {
                        fullPath = this.app.vault.adapter.getFullPath(folderPath);
                    }
                    const fs = require("fs");
                    const os = require("os");
                    const { execFile } = require("child_process");

                    if (!fs.existsSync(fullPath)) {
                        new Notice("common prompt フォルダがまだ作成されていません。");
                        return;
                    }

                    const platform = os.platform();
                    const openCommand = getOpenFolderCommandArgs(platform, fullPath);
                    if (openCommand) {
                        execFile(openCommand.command, openCommand.args, (error: any) => {
                            if (error) {
                                new Notice("フォルダを開けませんでした。");
                                console.error("Failed to open folder:", error);
                            }
                        });
                    }
                };
                titleWrapper.oncontextmenu = (e) => {
                    this.showFolderHeaderContextMenu(e, () => {
                        const folderPath = "11_common_prompt";
                        return this.app.vault.adapter instanceof FileSystemAdapter
                            ? this.app.vault.adapter.getFullPath(folderPath)
                            : null;
                    }, "common prompt フォルダがまだ作成されていません。");
                };
            }

            const searchContainer = header.createDiv({ cls: "sidebar-search-container" });
            searchContainer.style.display = "flex";
            searchContainer.style.marginLeft = "auto";
            searchContainer.style.marginRight = "10px";
            searchContainer.onclick = (e) => e.stopPropagation();

            const input = searchContainer.createEl("input", {
                type: "text",
                attr: { placeholder: "検索..." }
            });
            input.style.width = "100px";
            input.style.fontSize = "0.8em";
            input.style.padding = "2px 4px";
            input.style.borderRadius = "4px";
            input.style.border = "1px solid var(--background-modifier-border)";

            input.oninput = (e) => {
                this.commonPromptSearchQuery = (e.target as HTMLInputElement).value;
                this.refreshCommonPromptFiles();
            };
        });
        this.refreshCommonPromptFiles();

        // 3. Recently Opened Files (8件) - 検索ボックス付き
        this.recentFilesSectionContent = this.createSection(container, "最近開いたファイル", "🕐", (header) => {
            const searchContainer = header.createDiv({ cls: "sidebar-search-container" });
            searchContainer.style.display = "flex";
            searchContainer.style.marginLeft = "auto";
            searchContainer.style.marginRight = "10px";
            searchContainer.onclick = (e) => e.stopPropagation();

            const input = searchContainer.createEl("input", {
                type: "text",
                attr: { placeholder: "検索..." }
            });
            input.style.width = "100px";
            input.style.fontSize = "0.8em";
            input.style.padding = "2px 4px";
            input.style.borderRadius = "4px";
            input.style.border = "1px solid var(--background-modifier-border)";

            input.oninput = (e) => {
                this.recentFilesSearchQuery = (e.target as HTMLInputElement).value;
                this.refreshRecentFiles();
            };
        });
        this.refreshRecentFiles();

        // Initial update of selectables
        requestAnimationFrame(() => this.updateSelectables());
    }

    // --- Component: Active File's Folder ---
    refreshActiveFolderFiles() {
        if (!this.activeFolderSectionContent) return;
        const container = this.activeFolderSectionContent;
        container.empty();

        const activeFile = this.app.workspace.getActiveFile();
        const list = container.createDiv({ cls: "sidebar-list" });

        if (!activeFile) {
            list.createDiv({ text: "ファイルが開かれていません", cls: "sidebar-item", attr: { style: "opacity: 0.5; font-size: 0.8em; padding: 4px 8px;" } });
            return;
        }

        const folder = activeFile.parent;
        if (!folder || !(folder instanceof TFolder)) {
            list.createDiv({ text: "フォルダが見つかりません", attr: { style: "font-style:italic; opacity:0.5; font-size:0.8em; padding: 4px 8px;" } });
            return;
        }

        const folderDisplayPath = folder.path === "" ? "/" : folder.path;
        list.createDiv({ text: `Folder: ${folderDisplayPath}`, attr: { style: "font-size: 0.8em; opacity: 0.7; margin-bottom: 5px; padding-left: 8px;" } });

        const children = folder.children.filter(f => f instanceof TFile) as TFile[];
        const filteredFiles = filterFolderFiles(children, this.activeFolderSearchQuery);

        if (filteredFiles.length === 0) {
            list.createDiv({ text: "ファイルがありません", attr: { style: "font-style:italic; opacity:0.5; font-size:0.8em; padding: 4px 8px;" } });
        } else {
            for (const file of filteredFiles) {
                this.createFileItem(list, file);
            }
        }
    }

    // --- Component: Dataview Files ---
    refreshDataviewFiles() {
        if (!this.dataviewSectionContent) return;
        const container = this.dataviewSectionContent;
        container.empty();

        const folderPath = "03_Dataview";
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        const list = container.createDiv({ cls: "sidebar-list" });

        const keywords = this.dataviewSearchQuery.trim().split(/[\s\u3000]+/).filter(k => k.length > 0).map(k => k.toLowerCase());

        if (folder && folder instanceof TFolder) {
            let children = folder.children.filter(f => f instanceof TFile) as TFile[];
            children.sort((a, b) => b.stat.mtime - a.stat.mtime);

            if (keywords.length > 0) {
                children = children.filter(file => {
                    const filename = file.name.toLowerCase();
                    return keywords.every(keyword => filename.includes(keyword));
                });
            }

            if (children.length === 0) {
                const message = keywords.length > 0 ? "該当するファイルがありません" : "ファイルがありません";
                list.createDiv({ text: message, attr: { style: "font-style:italic; opacity:0.5; font-size:0.8em; padding: 4px 8px;" } });
            } else {
                for (const file of children) {
                    this.createFileItem(list, file);
                }
            }
        } else {
            list.createDiv({ text: "フォルダがありません", attr: { style: "font-style:italic; opacity:0.5; font-size:0.8em; padding: 4px 8px;" } });
        }

        requestAnimationFrame(() => this.updateSelectables());
    }

    // --- Component: Common Prompt Files ---
    refreshCommonPromptFiles() {
        if (!this.commonPromptSectionContent) return;
        const container = this.commonPromptSectionContent;
        container.empty();

        const folderPath = "11_common_prompt";
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        const list = container.createDiv({ cls: "sidebar-list" });

        const keywords = this.commonPromptSearchQuery.trim().split(/[\s\u3000]+/).filter(k => k.length > 0).map(k => k.toLowerCase());

        if (folder && folder instanceof TFolder) {
            let children = folder.children.filter(f => f instanceof TFile) as TFile[];
            children.sort((a, b) => b.stat.mtime - a.stat.mtime);

            if (keywords.length > 0) {
                children = children.filter(file => {
                    const filename = file.name.toLowerCase();
                    return keywords.every(keyword => filename.includes(keyword));
                });
            }

            if (children.length === 0) {
                const message = keywords.length > 0 ? "該当するファイルがありません" : "ファイルがありません";
                list.createDiv({ text: message, attr: { style: "font-style:italic; opacity:0.5; font-size:0.8em; padding: 4px 8px;" } });
            } else {
                for (const file of children) {
                    this.createFileItem(list, file);
                }
            }
        } else {
            list.createDiv({ text: "フォルダがありません", attr: { style: "font-style:italic; opacity:0.5; font-size:0.8em; padding: 4px 8px;" } });
        }

        requestAnimationFrame(() => this.updateSelectables());
    }

    // --- Component: Today's Folder ---
    refreshTodaysFolder() {
        if (!this.todaysFolderSectionContent) return;
        const container = this.todaysFolderSectionContent;
        container.empty();

        const todayPath = `01_data/${moment().format("YYYY/MM/DD")}`;
        const folder = this.app.vault.getAbstractFileByPath(todayPath);

        const list = container.createDiv({ cls: "sidebar-list" });

        if (folder && folder instanceof TFolder) {
            const children = folder.children.filter(f => f instanceof TFile) as TFile[];
            // Sort by modified time desc? or created?
            // Usually created file name has timestamp, so name sort is good if format YYYY-MM-DD...
            // Or sort by mtime
            children.sort((a, b) => b.stat.mtime - a.stat.mtime);

            if (children.length === 0) {
                list.createDiv({ text: "No files today", attr: { style: "font-style:italic; opacity:0.5; font-size:0.8em; padding: 4px 8px;" } });
            } else {
                for (const file of children) {
                    this.createFileItem(list, file);
                }
            }
        } else {
            list.createDiv({ text: "フォルダがありません", attr: { style: "font-style:italic; opacity:0.5; font-size:0.8em; padding: 4px 8px;" } });
        }
    }

    // --- Component: Recently Opened Files ---
    // 最近開いたファイルを表示（最後に開いた日時順、TOP8）
    // 上位300件からフィルタリングし、結果の上位8件を表示
    // 検索ボックスによるアンド検索に対応（半角・全角スペース区切り）
    refreshRecentFiles() {
        if (!this.recentFilesSectionContent) return;
        const container = this.recentFilesSectionContent;
        container.empty();

        const list = container.createDiv({ cls: "sidebar-list" });

        // プラグインの設定からlastOpenedを取得
        // @ts-ignore - プラグインインスタンスへのアクセス
        const plugin = this.app.plugins?.plugins?.["obsidian-sidebar-explorer"];
        const lastOpened: Record<string, number> = plugin?.settings?.lastOpened || {};

        // 検索キーワードを半角・全角スペースで分割
        const keywords = this.recentFilesSearchQuery.trim().split(/[\s\u3000]+/).filter(k => k.length > 0).map(k => k.toLowerCase());

        // lastOpenedでソートし、上位300件を取得
        let sortedPaths = Object.entries(lastOpened)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 300);

        // 検索キーワードがある場合はフィルタリング
        if (keywords.length > 0) {
            sortedPaths = sortedPaths.filter(([path]) => {
                const file = this.app.vault.getAbstractFileByPath(path);
                if (file && file instanceof TFile) {
                    const filename = file.basename.toLowerCase();
                    // すべてのキーワードにマッチするかチェック（AND検索）
                    return keywords.every(keyword => filename.includes(keyword));
                }
                return false;
            });
        }

        // フィルタリング後、上位8件を表示
        sortedPaths = sortedPaths.slice(0, 8);

        if (sortedPaths.length === 0) {
            const message = keywords.length > 0 ? "該当するファイルがありません" : "履歴がありません";
            list.createDiv({ text: message, attr: { style: "font-style:italic; opacity:0.5; font-size:0.8em; padding: 4px 8px;" } });
        } else {
            for (const [path] of sortedPaths) {
                const file = this.app.vault.getAbstractFileByPath(path);
                if (file && file instanceof TFile) {
                    this.createFileItem(list, file);
                }
            }
        }

        // キーボードナビゲーション用のselectables更新
        requestAnimationFrame(() => this.updateSelectables());
    }

    // --- Component: Importance Ranking Files ---
    // 被リンク数・アクセス数・最近の利用/更新などを加味した重要度順で表示（TOP8）
    // 上位300件からフィルタリングし、結果の上位8件を表示
    // 検索ボックスによるアンド検索に対応（半角・全角スペース区切り）
    refreshTopAccessFiles() {
        if (!this.topAccessSectionContent) return;
        const container = this.topAccessSectionContent;
        container.empty();

        const list = container.createDiv({ cls: "sidebar-list" });

        // プラグインの設定からaccessCountsを取得
        // @ts-ignore - プラグインインスタンスへのアクセス
        const plugin = this.app.plugins?.plugins?.["obsidian-sidebar-explorer"];
        const accessCounts: Record<string, number> = plugin?.settings?.accessCounts || {};
        const lastOpened: Record<string, number> = plugin?.settings?.lastOpened || {};
        const backlinkCounts: Record<string, number> = plugin?.settings?.backlinkCounts || {};
        const importanceScores: Record<string, number> = plugin?.settings?.importanceScores || {};
        const fileMetrics: Record<string, {
            accessCount: number;
            backlinkCount: number;
            lastOpenedAt: number;
            modifiedAt: number;
            outgoingLinkCount: number;
            attachmentCount: number;
            headingCount: number;
            tagCount: number;
            importanceScore: number;
        }> = plugin?.settings?.fileMetrics || {};

        // 検索キーワードを半角・全角スペースで分割
        const keywords = this.topAccessSearchQuery.trim().split(/[\s\u3000]+/).filter(k => k.length > 0).map(k => k.toLowerCase());

        const now = Date.now();
        const metricEntries = Object.entries(fileMetrics);
        let rankedFiles = (metricEntries.length > 0
            ? metricEntries
                .map(([path, metrics]) => {
                    const file = this.app.vault.getAbstractFileByPath(path);
                    if (!(file instanceof TFile) || this.shouldIgnoreForImportance(file.path)) return null;

                    return {
                        file,
                        score: metrics.importanceScore,
                        accessCount: metrics.accessCount,
                        backlinkCount: metrics.backlinkCount,
                    };
                })
                .filter((item): item is { file: TFile; score: number; accessCount: number; backlinkCount: number } => item !== null)
            : this.app.vault.getMarkdownFiles()
                .filter((file) => !this.shouldIgnoreForImportance(file.path))
                .map((file) => {
                    const accessCount = accessCounts[file.path] ?? 0;
                    const backlinkCount = backlinkCounts[file.path] ?? 0;
                    const score = importanceScores[file.path] ?? calculateFileImportanceScore({
                        accessCount,
                        backlinkCount,
                        lastOpenedAt: lastOpened[file.path],
                        modifiedAt: file.stat.mtime,
                    }, now);

                    return {
                        file,
                        score,
                        accessCount,
                        backlinkCount,
                    };
                }))
            .sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                if (b.backlinkCount !== a.backlinkCount) return b.backlinkCount - a.backlinkCount;
                return b.accessCount - a.accessCount;
            })
            .slice(0, 300);

        // 検索キーワードがある場合はフィルタリング
        if (keywords.length > 0) {
            rankedFiles = rankedFiles.filter(({ file }) => {
                const target = `${file.basename} ${file.path}`.toLowerCase();
                // すべてのキーワードにマッチするかチェック（AND検索）
                return keywords.every(keyword => target.includes(keyword));
            });
        }

        // フィルタリング後、上位8件を表示
        rankedFiles = rankedFiles.slice(0, 8);

        if (rankedFiles.length === 0) {
            const message = keywords.length > 0 ? "該当するファイルがありません" : "対象ファイルがありません";
            list.createDiv({ text: message, attr: { style: "font-style:italic; opacity:0.5; font-size:0.8em; padding: 4px 8px;" } });
        } else {
            for (const { file, score, accessCount, backlinkCount } of rankedFiles) {
                    // ファイルアイテムを作成（アクセス数バッジ付き）
                    const item = list.createDiv({ cls: "sidebar-item" });
                    item.style.display = "flex";
                    item.style.alignItems = "center";

                    // アイコンを表示
                    const iconEl = item.createSpan({ cls: "file-icon" });
                    const iconName = this.getIconForFile(file);
                    this.loadAndDisplayIcon(iconEl, iconName);

                    const nameSpan = item.createSpan({ cls: "file-name", text: file.basename });
                    nameSpan.style.flex = "1";
                    nameSpan.style.overflow = "hidden";
                    nameSpan.style.textOverflow = "ellipsis";
                    nameSpan.style.whiteSpace = "nowrap";

                    const meta = item.createSpan({ text: `🔗${backlinkCount} 👁${accessCount}`, cls: "sidebar-access-badge" });
                    meta.style.marginLeft = "8px";
                    meta.style.fontSize = "0.7em";
                    meta.style.opacity = "0.65";
                    meta.style.flexShrink = "0";

                    // 重要度スコアバッジ
                    const badge = item.createSpan({ text: score.toFixed(2), cls: "sidebar-access-badge" });
                    badge.title = `重要度 ${score.toFixed(3)} / 被リンク ${backlinkCount} / アクセス ${accessCount}`;
                    badge.style.marginLeft = "auto";
                    badge.style.fontSize = "0.7em";
                    badge.style.opacity = "0.6";
                    badge.style.padding = "1px 4px";
                    badge.style.borderRadius = "4px";
                    badge.style.backgroundColor = "var(--background-modifier-hover)";
                    badge.style.flexShrink = "0";

                    item.onclick = (e) => this.openInMain(file, e);

                    // ドラッグ処理の追加
                    item.setAttribute("draggable", "true");
                    item.addEventListener("dragstart", (e: DragEvent) => {
                        this.setupDragData(e, file);
                    });

                    // コンテキストメニュー
                    item.addEventListener("contextmenu", (event: MouseEvent) => {
                        event.preventDefault();
                        const menu = new Menu();
                        menu.addItem((menuItem: MenuItem) => {
                            menuItem
                                .setTitle("Copy full path")
                                .setIcon("link")
                                .onClick(async () => {
                                    let fullPath = file.path;
                                    if (this.app.vault.adapter instanceof FileSystemAdapter) {
                                        fullPath = this.app.vault.adapter.getFullPath(file.path);
                                    }
                                    await navigator.clipboard.writeText(fullPath);
                                });
                        });
                        this.app.workspace.trigger("file-menu", menu, file, "file-explorer-context-menu");
                        menu.showAtMouseEvent(event);
                    });
            }
        }

        // キーボードナビゲーション用のselectables更新
        requestAnimationFrame(() => this.updateSelectables());
    }

    private shouldIgnoreForImportance(path: string): boolean {
        return path.includes('/node_modules/') || path.startsWith('node_modules/');
    }

    // --- Component: Related Files ---
    refreshRelatedFiles() {
        if (!this.relatedSectionContent) return;
        const activeFile = this.app.workspace.getActiveFile();
        const renderKey = `${activeFile?.path ?? ''}::${this.relatedFilesRevision}`;
        if (this.lastRenderedRelatedKey === renderKey) {
            return;
        }

        const container = this.relatedSectionContent;
        container.empty();

        const list = container.createDiv({ cls: "sidebar-list" });
        if (!activeFile) {
            this.lastRenderedRelatedKey = renderKey;
            list.createDiv({ text: "No active file", cls: "sidebar-item", attr: { style: "opacity: 0.5;" } });
            return;
        }

        // 画面を開いた直後から、リンクを伴わない通常入力を差分なしとして扱えるようにする。
        this.relatedLinkSignatureByPath.set(activeFile.path, this.getRelatedLinkSignature(activeFile));

        list.createDiv({ text: `Target: ${activeFile.basename}`, attr: { style: "font-size: 0.8em; opacity: 0.7; margin-bottom: 5px; padding-left: 8px;" } });

        let hasRelated = false;

        // Helper to render a group of files
        const renderGroup = (title: string, mdFiles: TFile[], otherFiles: TFile[]) => {
            if (mdFiles.length === 0 && otherFiles.length === 0) return;
            hasRelated = true;

            const groupDiv = list.createDiv({ text: title, attr: { style: "font-size:0.75em; font-weight:bold; margin-top:4px; padding-left:4px;" } });

            // 1. Markdown Files (Always visible)
            mdFiles.forEach(file => this.createFileItem(list, file, title.includes("to") ? "→" : "←"));

            // 2. Other Files (Collapsible)
            if (otherFiles.length > 0) {
                const toggleItem = list.createDiv({ cls: "sidebar-item", attr: { style: "font-size: 0.9em; color: var(--text-muted);" } });
                toggleItem.innerHTML = `<span class="tree-arrow" style="margin-right: 5px;">▶</span> Attachments / Others (${otherFiles.length})`;

                const otherContainer = list.createDiv({ cls: "sidebar-sublist" });
                otherContainer.style.display = "none";
                otherContainer.style.paddingLeft = "10px";
                otherContainer.style.borderLeft = "1px solid var(--background-modifier-border)";
                otherContainer.style.marginLeft = "6px";

                let isExpanded = false;
                toggleItem.onclick = (e) => {
                    e.stopPropagation();
                    isExpanded = !isExpanded;
                    const arrow = toggleItem.querySelector(".tree-arrow") as HTMLElement;
                    if (isExpanded) {
                        arrow.style.transform = "rotate(90deg)";
                        otherContainer.style.display = "block";
                    } else {
                        arrow.style.transform = "rotate(0deg)";
                        otherContainer.style.display = "none";
                    }
                };

                otherFiles.forEach(file => this.createFileItem(otherContainer, file, "•"));
            }
        };

        // 1. Outlinks
        const outMd: TFile[] = [];
        const outOthers: TFile[] = [];
        const cache = this.app.metadataCache.getFileCache(activeFile);
        if (cache) {
            const { markdownFiles, attachmentFiles } = collectLinkedFiles(
                this.app.metadataCache,
                activeFile,
                [...(cache.links || []), ...(cache.embeds || [])],
            );

            markdownFiles.forEach((path) => {
                const file = this.app.vault.getAbstractFileByPath(path);
                if (file instanceof TFile) {
                    outMd.push(file);
                }
            });

            attachmentFiles.forEach((path) => {
                const file = this.app.vault.getAbstractFileByPath(path);
                if (file instanceof TFile) {
                    outOthers.push(file);
                }
            });
        }
        renderGroup("Links to:", outMd, outOthers);

        // 2. Backlinks
        const backMd: TFile[] = [];
        const backOthers: TFile[] = [];
        const backlinkPaths = getBacklinkPaths(this.app.metadataCache, activeFile.path, this.relatedFilesRevision);

        for (const sourcePath of backlinkPaths) {
            const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
            if (sourceFile && sourceFile instanceof TFile) {
                if (sourceFile.extension === 'md') {
                    backMd.push(sourceFile);
                } else {
                    const ext = sourceFile.extension.toLowerCase();
                    const allowedExts = ['canvas', 'excalidraw', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'msg', 'pdf', 'zip'];
                    if (allowedExts.includes(ext)) {
                        backOthers.push(sourceFile);
                    }
                }
            }
        }
        renderGroup("Linked from:", backMd, backOthers);

        if (!hasRelated) {
            list.createDiv({ text: "No related files", cls: "sidebar-item", attr: { style: "opacity: 0.5;" } });
        }

        this.lastRenderedRelatedKey = renderKey;
    }



    /**
     * フォルダヘッダータイトルの右クリックメニュー（コンテキストメニュー）を表示する
     * - web アプリで開く (http://localhost:8001/?path=...)
     * - codeで開く (VS Code)
     */
    private showFolderHeaderContextMenu(
        e: MouseEvent,
        getFolderFullPath: () => string | null,
        errorMessage: string = "フォルダが見つかりません。"
    ) {
        e.preventDefault();
        e.stopPropagation();

        const fullPath = getFolderFullPath();
        const fs = require("fs");
        if (!fullPath || !fs.existsSync(fullPath)) {
            new Notice(errorMessage);
            return;
        }

        const plugin = (this.app as any).plugins.getPlugin("obsidian-sidebar-explorer");
        const vscodeExecutable = plugin?.settings?.vscodeExecutablePath?.trim();

        const menu = new Menu();

        // 1. web アプリで開く
        menu.addItem((item: MenuItem) => {
            item
                .setTitle("web アプリで開く")
                .setIcon("globe")
                .onClick(() => {
                    const url = buildFileManagerWebUrl(fullPath);
                    window.open(url, "_blank");
                });
        });

        // 2. codeで開く
        menu.addItem((item: MenuItem) => {
            item
                .setTitle("codeで開く")
                .setIcon("code")
                .onClick(async () => {
                    const opened = await openInVsCode(fullPath, vscodeExecutable);
                    if (!opened) {
                        new Notice("VS Code を起動できませんでした。");
                    }
                });
        });

        menu.showAtMouseEvent(e);
    }

    // --- Helpers ---
    createSection(parent: HTMLElement, title: string, icon: string, customUI?: (header: HTMLElement) => void) {
        const section = parent.createDiv({ cls: "sidebar-section" });
        const header = section.createDiv({ cls: "sidebar-header" });
        header.style.display = "flex";
        header.style.alignItems = "center";

        // Title wrapper
        const titleWrapper = header.createDiv({ cls: "sidebar-header-title" });
        titleWrapper.innerHTML = `<span class="icon">${icon}</span> ${title}`; // Remove arrow from here
        titleWrapper.style.flexGrow = "1";

        if (customUI) {
            customUI(header);
        }

        const arrow = header.createSpan({ text: "▼", cls: "arrow" });
        arrow.style.marginLeft = "8px";

        const content = section.createDiv({ cls: "sidebar-content" });

        header.onclick = () => {
            if (content.classList.contains("collapsed")) {
                content.classList.remove("collapsed");
                header.classList.remove("collapsed");
            } else {
                content.classList.add("collapsed");
                header.classList.add("collapsed");
            }
        };

        return content;
    }

    createFileItem(parent: HTMLElement, file: TFile, prefix?: string) {
        const item = parent.createDiv({ cls: "sidebar-item" });

        // アイコンを表示（非同期で読み込み）
        const iconEl = item.createSpan({ cls: "file-icon" });
        const iconName = this.getIconForFile(file);
        this.loadAndDisplayIcon(iconEl, iconName);

        const nameText = prefix ? `${prefix} ${file.basename}` : file.basename;
        item.createSpan({ cls: "file-name", text: nameText });

        // Store file path for keyboard navigation
        item.dataset.path = file.path;

        item.onclick = (e) => this.openInMain(file, e);

        // ドラッグ処理の追加
        item.setAttribute("draggable", "true");
        item.addEventListener("dragstart", (e: DragEvent) => {
            this.setupDragData(e, file);
        });

        item.addEventListener("contextmenu", (event: MouseEvent) => {
            event.preventDefault();
            const menu = new Menu();

            if (file.path.endsWith(".excalidraw.md")) {
                menu.addItem((item: MenuItem) => {
                    item
                        .setTitle("web app urlをコピー")
                        .setIcon("link")
                        .onClick(async () => {
                            let fullPath = file.path;
                            if (this.app.vault.adapter instanceof FileSystemAdapter) {
                                fullPath = this.app.vault.adapter.getFullPath(file.path);
                            }
                            const url = buildExcalidrawWebUrl(fullPath);
                            await navigator.clipboard.writeText(url);
                            new Notice("URL copied to clipboard");
                        });
                });
                menu.addSeparator();
            }

            if (isImageFile(file)) {
                this.addClipboardImageMenuItems(menu, file);
                menu.addSeparator();
            }

            menu.addItem((item: MenuItem) => {
                item
                    .setTitle("Copy full path")
                    .setIcon("link")
                    .onClick(async () => {
                        let fullPath = file.path;
                        if (this.app.vault.adapter instanceof FileSystemAdapter) {
                            fullPath = this.app.vault.adapter.getFullPath(file.path);
                        }
                        await navigator.clipboard.writeText(fullPath);
                        // new Notice("Copied path to clipboard"); // Optional
                    });
            });

            menu.addItem((item: MenuItem) => {
                item
                    .setTitle("Rename")
                    .setIcon("pencil")
                    .onClick(() => {
                        const customPromptForFileRename = (window as any)._customPromptForFileRename;
                        if (typeof customPromptForFileRename === "function") {
                            customPromptForFileRename(file);
                            return;
                        }
                        // @ts-ignore: promptForFileRename exists in API but may be missing in types
                        if (this.app.fileManager.promptForFileRename) {
                            // @ts-ignore
                            this.app.fileManager.promptForFileRename(file);
                        } else {
                            // Fallback or notice?
                            console.warn("promptForFileRename not available");
                        }
                    });
            });

            menu.addSeparator();

            menu.addItem((item: MenuItem) => {
                item
                    .setTitle("Delete")
                    .setIcon("trash")
                    .setWarning(true)
                    .onClick(() => {
                        this.promptDelete(file);
                    });
            });

            this.app.workspace.trigger("file-menu", menu, file, "file-explorer-context-menu");
            menu.showAtMouseEvent(event);
        });
    }

    private addClipboardImageMenuItems(menu: Menu, file: TFile) {
        menu.addItem((item: MenuItem) => {
            item
                .setTitle("クリップボードの画像との比較")
                .setIcon("image")
                .onClick(() => {
                    this.compareWithClipboardImage(file);
                });
        });

        menu.addItem((item: MenuItem) => {
            item
                .setTitle("クリップボードの画像と差し替え")
                .setIcon("replace")
                .setWarning(true)
                .onClick(() => {
                    this.replaceWithClipboardImage(file);
                });
        });
    }

    private async getClipboardImageBlob(): Promise<Blob | null> {
        if (!navigator.clipboard?.read) {
            new Notice("Clipboard image read is not available.");
            return null;
        }

        try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
                const imageType = item.types.find((type) => type.startsWith("image/"));
                if (imageType) {
                    return await item.getType(imageType);
                }
            }
        } catch (error) {
            console.error("Failed to read clipboard image:", error);
            new Notice("Failed to read clipboard image.");
            return null;
        }

        new Notice("Clipboard does not contain an image.");
        return null;
    }

    private async assertImageDiffApiReady(): Promise<boolean> {
        try {
            const response = await fetch(`${IMAGE_DIFF_API_BASE_URL}/health`);
            if (response.ok) return true;
            new Notice(`Image diff API is not ready (${response.status}).`);
        } catch (error) {
            console.error("Image diff API health check failed:", error);
            new Notice("Image diff API is not running.");
        }
        return false;
    }

    private async compareWithClipboardImage(file: TFile) {
        const clipboardBlob = await this.getClipboardImageBlob();
        if (!clipboardBlob) return;

        if (!(await this.assertImageDiffApiReady())) return;

        try {
            const selectedBytes = await this.app.vault.readBinary(file);
            const selectedBlob = new Blob([selectedBytes], { type: this.getMimeTypeForFile(file) });
            const formData = new FormData();
            formData.append("file_a", selectedBlob, file.name);
            formData.append("file_b", clipboardBlob, this.getClipboardFilename(clipboardBlob));
            formData.append("category", "汎用");
            formData.append("diff_threshold", "0.1");

            const response = await fetch(`${IMAGE_DIFF_API_BASE_URL}/diff`, {
                method: "POST",
                body: formData,
            });

            if (!response.ok) {
                new Notice(`Image diff failed: ${await this.getApiErrorMessage(response)}`);
                return;
            }

            const result = await response.json();
            const resultUrl = new URL(IMAGE_DIFF_APP_BASE_URL);
            if (result.result_id) {
                resultUrl.searchParams.set("result_id", result.result_id);
            }
            window.open(resultUrl.toString(), "_blank");
            new Notice("Opened image diff.");
        } catch (error) {
            console.error("Failed to compare clipboard image:", error);
            new Notice("Failed to compare clipboard image.");
        }
    }

    private async replaceWithClipboardImage(file: TFile) {
        const clipboardBlob = await this.getClipboardImageBlob();
        if (!clipboardBlob) return;

        if (!window.confirm(`本当に "${file.name}" をクリップボードの画像で差し替えますか?`)) {
            return;
        }

        try {
            const replacementBlob = await this.convertClipboardBlobForFile(clipboardBlob, file);
            const bytes = await replacementBlob.arrayBuffer();
            await this.app.vault.modifyBinary(file, bytes);
            await this.refreshImageDisplays(file);
            new Notice(`Replaced "${file.name}" with clipboard image.`);
        } catch (error) {
            console.error("Failed to replace image with clipboard image:", error);
            new Notice("Failed to replace image.");
        }
    }

    private async convertClipboardBlobForFile(blob: Blob, file: TFile): Promise<Blob> {
        const targetMimeType = this.getMimeTypeForFile(file);
        const canvasConvertibleMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
        if (!canvasConvertibleMimeTypes.has(targetMimeType) || blob.type === targetMimeType) {
            return blob;
        }

        const imageUrl = URL.createObjectURL(blob);
        try {
            const image = new Image();
            image.decoding = "async";
            const loaded = new Promise<void>((resolve, reject) => {
                image.onload = () => resolve();
                image.onerror = reject;
            });
            image.src = imageUrl;
            await loaded;

            const canvas = document.createElement("canvas");
            canvas.width = image.naturalWidth || image.width;
            canvas.height = image.naturalHeight || image.height;
            const context = canvas.getContext("2d");
            if (!context) return blob;

            if (targetMimeType === "image/jpeg") {
                context.fillStyle = "#ffffff";
                context.fillRect(0, 0, canvas.width, canvas.height);
            }
            context.drawImage(image, 0, 0);

            const convertedBlob = await new Promise<Blob | null>((resolve) => {
                canvas.toBlob(resolve, targetMimeType, 0.95);
            });
            return convertedBlob ?? blob;
        } catch (error) {
            console.warn("Failed to convert clipboard image. Using original blob.", error);
            return blob;
        } finally {
            URL.revokeObjectURL(imageUrl);
        }
    }

    private async refreshImageDisplays(file: TFile) {
        document.querySelectorAll("img").forEach((imgEl) => {
            const imageFile = this.getFileFromImageElement(imgEl);
            if (imageFile?.path === file.path) {
                this.refreshImageElement(imgEl);
            }
        });

        const leavesToReload: WorkspaceLeaf[] = [];
        this.app.workspace.iterateAllLeaves((leaf) => {
            if ((leaf.view as any)?.file?.path === file.path) {
                leavesToReload.push(leaf);
            }
        });

        for (const leaf of leavesToReload) {
            try {
                await openFileInMarkdownView(this.app, leaf, file);
            } catch (error) {
                console.warn("Failed to reload image leaf.", error);
            }
        }
    }

    private getFileFromImageElement(imgEl: HTMLImageElement): TFile | null {
        const activeFile = this.app.workspace.getActiveFile();
        const embedEl = imgEl.closest(".internal-embed, span[src], div[src]");
        const candidates = [
            embedEl?.getAttribute("src"),
            embedEl?.getAttribute("alt"),
            imgEl.getAttribute("alt"),
            imgEl.getAttribute("aria-label"),
            imgEl.getAttribute("src"),
            imgEl.currentSrc,
        ].filter((value): value is string => Boolean(value));

        for (const candidate of candidates) {
            let value = candidate.trim();
            if (!value) continue;

            if (value.startsWith("app://")) {
                try {
                    value = decodeURIComponent(new URL(value).pathname);
                } catch {
                    value = decodeURIComponent(value.replace(/^app:\/\/[^/]+\/?/, ""));
                }
            }

            value = value
                .replace(/^!?\[\[/, "")
                .replace(/\]\]$/, "")
                .split("|")[0]
                .split("#")[0]
                .split("?")[0]
                .trim();

            const relativePath = this.getVaultRelativePath(value);
            const directFile = relativePath ? this.app.vault.getAbstractFileByPath(relativePath) : null;
            if (directFile instanceof TFile) return directFile;

            if (activeFile) {
                const linkedFile = this.app.metadataCache.getFirstLinkpathDest(value, activeFile.path);
                if (linkedFile instanceof TFile) return linkedFile;
            }
        }

        return null;
    }

    private getVaultRelativePath(path: string): string | null {
        if (!path) return null;
        const normalizedPath = decodeURIComponent(path).replace(/\\/g, "/");
        let basePath = "";
        if (this.app.vault.adapter instanceof FileSystemAdapter) {
            basePath = this.app.vault.adapter.getBasePath().replace(/\\/g, "/").replace(/\/+$/g, "");
        }

        if (basePath && normalizedPath.startsWith(`${basePath}/`)) {
            return normalizedPath.slice(basePath.length + 1);
        }
        return normalizedPath.replace(/^\/+/, "");
    }

    private refreshImageElement(imgEl: HTMLImageElement) {
        const src = imgEl.getAttribute("src") || imgEl.currentSrc;
        if (!src) return;

        try {
            const url = new URL(src, window.location.href);
            url.searchParams.set("_customImageReload", Date.now().toString());
            imgEl.setAttribute("src", url.toString());
        } catch {
            const separator = src.includes("?") ? "&" : "?";
            imgEl.setAttribute("src", `${src}${separator}_customImageReload=${Date.now()}`);
        }
    }

    private getClipboardFilename(blob: Blob): string {
        const extensionByMime: Record<string, string> = {
            "image/png": "png",
            "image/jpeg": "jpg",
            "image/webp": "webp",
            "image/gif": "gif",
            "image/bmp": "bmp",
            "image/svg+xml": "svg",
            "image/tiff": "tiff",
        };
        const extension = extensionByMime[blob.type] ?? "png";
        return `clipboard.${extension}`;
    }

    private getMimeTypeForFile(file: TFile): string {
        const mimeByExtension: Record<string, string> = {
            png: "image/png",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            webp: "image/webp",
            gif: "image/gif",
            bmp: "image/bmp",
            svg: "image/svg+xml",
            tif: "image/tiff",
            tiff: "image/tiff",
        };
        return mimeByExtension[file.extension.toLowerCase()] ?? "application/octet-stream";
    }

    private async getApiErrorMessage(response: Response): Promise<string> {
        try {
            const body = await response.json();
            return `${response.status} ${body.detail ?? response.statusText}`;
        } catch {
            return `${response.status} ${response.statusText}`;
        }
    }

    async openInMain(file: TFile, event: MouseEvent) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }

        let leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
        if (!leaf) {
            const leaves: WorkspaceLeaf[] = [];
            this.app.workspace.iterateRootLeaves(l => leaves.push(l));
            if (leaves.length > 0) leaf = leaves[0];
            else leaf = this.app.workspace.getLeaf('tab');
        }
        await openFileInMarkdownView(this.app, leaf, file);
    }

    setupDragData(e: DragEvent, file: TFile) {
        if (!e.dataTransfer) return;

        // ExcalidrawのShift+ドロップなどが認識できるよう、
        // Obsidian標準のドラッグ情報を先に登録する。
        if (setupObsidianFileDrag(this.app, e, file)) return;

        const dragInfo = {
            extension: file.extension,
            name: file.name,
            basename: file.basename,
            path: file.path
        };

        // basePathを取得 (FileSystemAdapter の場合)
        let basePath: string | undefined;
        if (this.app.vault.adapter instanceof FileSystemAdapter) {
            basePath = this.app.vault.adapter.getBasePath();
        }

        const dropText = getDragText(dragInfo, basePath);

        // Markdownエディタへドロップされたときのテキスト
        e.dataTransfer.setData("text/plain", dropText);
    }



    // --- Keyboard Navigation ---

    updateSelectables() {
        // Collect all visible sidebar-items
        // We only want items that are not in a collapsed container
        const allItems = Array.from(this.contentEl.querySelectorAll(".sidebar-item")) as HTMLElement[];
        this.selectableItems = allItems.filter(item => {
            // Check if it is visible (offsetParent is null if hidden)
            return item.offsetParent !== null;
        });

        // Verify selectedItem is still valid
        if (this.selectedItem && !this.selectableItems.includes(this.selectedItem)) {
            this.selectedItem = null;
        }
    }

    selectItem(item: HTMLElement | null) {
        if (this.selectedItem) {
            this.selectedItem.classList.remove("is-selected");
        }
        this.selectedItem = item;
        if (this.selectedItem) {
            this.selectedItem.classList.add("is-selected");

            // Scroll into view if needed
            this.selectedItem.scrollIntoView({
                behavior: "smooth",
                block: "nearest"
            });
        }
    }

    moveSelection(direction: 1 | -1) {
        this.updateSelectables();
        if (this.selectableItems.length === 0) return;

        let index = -1;
        if (this.selectedItem) {
            index = this.selectableItems.indexOf(this.selectedItem);
        }

        let newIndex = index + direction;

        // Bounds check
        if (newIndex < 0) newIndex = 0;
        if (newIndex >= this.selectableItems.length) newIndex = this.selectableItems.length - 1;

        this.selectItem(this.selectableItems[newIndex]);
    }

    handleKeyDown(e: KeyboardEvent): boolean {
        // 入力フィールド（検索ボックスなど）にフォーカスがある場合は無視
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
            return false;
        }

        if (e.key === "ArrowDown") {
            this.moveSelection(1);
            return true;
        }
        if (e.key === "ArrowUp") {
            this.moveSelection(-1);
            return true;
        }
        if (e.key === "Enter") {
            if (this.selectedItem) {
                this.selectedItem.click();
                return true;
            }
        }
        // Right/Left for expand/collapse
        if (e.key === "ArrowRight") {
            if (this.selectedItem && this.selectedItem.classList.contains("tree-row")) {
                const arrow = this.selectedItem.querySelector(".tree-arrow") as HTMLElement;
                if (arrow && arrow.style.transform !== "rotate(90deg)" && arrow.style.visibility !== "hidden") {
                    this.selectedItem.click();
                    setTimeout(() => this.updateSelectables(), 50);
                    return true;
                }
            }
        }
        if (e.key === "ArrowLeft") {
            if (this.selectedItem && this.selectedItem.classList.contains("tree-row")) {
                const arrow = this.selectedItem.querySelector(".tree-arrow") as HTMLElement;
                if (arrow && arrow.style.transform === "rotate(90deg)") {
                    this.selectedItem.click();
                    setTimeout(() => this.updateSelectables(), 50);
                    return true;
                } else {
                    // Move to parent if collapsed
                    const treeNode = this.selectedItem.closest(".tree-node");
                    if (treeNode && treeNode.parentElement && treeNode.parentElement.classList.contains("tree-children")) {
                        const parentNode = treeNode.parentElement.parentElement; // .tree-node (parent)
                        if (parentNode) {
                            const parentRow = parentNode.querySelector(".tree-row");
                            if (parentRow instanceof HTMLElement) {
                                this.selectItem(parentRow);
                                return true;
                            }
                        }
                    }
                }
            }
        }

        // 'R' or 'r' to Rename (No modifiers)
        if (e.key.toLowerCase() === "r" && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
            if (this.selectedItem && this.selectedItem.dataset.path) {
                const file = this.app.vault.getAbstractFileByPath(this.selectedItem.dataset.path);
                if (file && file instanceof TFile) {
                    const customPromptForFileRename = (window as any)._customPromptForFileRename;
                    if (typeof customPromptForFileRename === "function") {
                        customPromptForFileRename(file);
                        return true;
                    }
                    // @ts-ignore
                    if (this.app.fileManager.promptForFileRename) {
                        // @ts-ignore
                        this.app.fileManager.promptForFileRename(file);
                        return true;
                    }
                }
            }
        }

        if (e.key === "Delete" || (e.key === "Backspace" && e.metaKey)) { // Mac: Cmd+Backspace usually trashes
            if (this.selectedItem && this.selectedItem.dataset.path) {
                const file = this.app.vault.getAbstractFileByPath(this.selectedItem.dataset.path);
                if (file && file instanceof TFile) {
                    this.promptDelete(file);
                    return true;
                }
            }
        }

        return false;
    }

    // --- Deletion Logic ---

    promptDelete(file: TFile) {
        const attachments = this.getRelatedAttachments(file);

        new DeleteFileModal(this.app, file, attachments, async (deleteMain, attachmentsToDelete) => {
            if (deleteMain) {
                for (const att of attachmentsToDelete) {
                    await this.app.vault.trash(att, true);
                }
                await this.app.vault.trash(file, true);
                new Notice(`Deleted "${file.basename}" and ${attachmentsToDelete.length} attachments.`);
            }
        }).open();
    }

    getRelatedAttachments(file: TFile): TFile[] {
        const cache = this.app.metadataCache.getFileCache(file);

        if (!cache) return [];

        const { attachmentFiles } = collectLinkedFiles(
            this.app.metadataCache,
            file,
            [...(cache.links || []), ...(cache.embeds || [])],
        );

        return attachmentFiles
            .map((path) => this.app.vault.getAbstractFileByPath(path))
            .filter((linkedFile): linkedFile is TFile =>
                linkedFile instanceof TFile &&
                isAttachmentFile(linkedFile) &&
                !this.isInCommonImage(linkedFile) &&
                !this.isReferencedByAnotherNote(linkedFile, file)
            );
    }

    private isInCommonImage(file: TFile): boolean {
        const normalizedPath = file.path.replace(/\\/g, "/");
        return normalizedPath.startsWith("01_data/common_image/");
    }

    private isReferencedByAnotherNote(attachment: TFile, deletingFile: TFile): boolean {
        return this.app.vault.getMarkdownFiles().some(sourceFile => {
            if (sourceFile.path === deletingFile.path) return false;

            const cache = this.app.metadataCache.getFileCache(sourceFile);
            if (!cache) return false;

            const references = [...(cache.links || []), ...(cache.embeds || [])];
            return references.some(reference => {
                const linkedFile = this.app.metadataCache.getFirstLinkpathDest(reference.link, sourceFile.path);
                return linkedFile?.path === attachment.path;
            });
        });
    }

    // ファイルに適したアイコン名を取得
    private getIconForFile(file: TFile): string {
        // まずファイル名パターンをチェック
        const specialIcon = getIconNameFromFilename(file.name);
        if (specialIcon) {
            return specialIcon;
        }
        // 拡張子からアイコンを取得
        return getIconName(file.extension);
    }

    // アイコンを読み込んで表示
    private async loadAndDisplayIcon(iconEl: HTMLElement, iconName: string): Promise<void> {
        try {
            // キャッシュをチェック
            if (iconCache.has(iconName)) {
                iconEl.innerHTML = iconCache.get(iconName)!;
                return;
            }

            // SVGファイルを読み込み
            const svgContent = await this.loadIconSvg(iconName);
            if (svgContent) {
                iconCache.set(iconName, svgContent);
                iconEl.innerHTML = svgContent;
            } else {
                // フォールバック: デフォルトアイコン
                const defaultSvg = await this.loadIconSvg('file');
                if (defaultSvg) {
                    iconCache.set(iconName, defaultSvg);
                    iconEl.innerHTML = defaultSvg;
                }
            }
        } catch (e) {
            console.error('Failed to load icon:', iconName, e);
        }
    }

    // SVGファイルを読み込み
    private async loadIconSvg(iconName: string): Promise<string | null> {
        try {
            if (this.app.vault.adapter instanceof FileSystemAdapter) {
                const basePath = this.app.vault.adapter.getBasePath();
                const iconPath = `.obsidian/plugins/obsidian-sidebar-explorer/icons/${iconName}.svg`;
                const fullPath = `${basePath}/${iconPath}`;

                // Node.js fsを使用（Electron環境では利用可能）
                const nodeRequire = (window as any).require;
                if (nodeRequire) {
                    const fs = nodeRequire('fs');
                    if (fs.existsSync(fullPath)) {
                        return fs.readFileSync(fullPath, 'utf8');
                    }
                }
            }
            return null;
        } catch (e) {
            console.error('Failed to read icon file:', iconName, e);
            return null;
        }
    }
}

class ConfirmDeleteModal extends Modal {
    private title: string;
    private message: string;
    private confirmText: string;
    private resolve: ((result: boolean) => void) | null = null;
    private resolved = false;

    constructor(app: App, title: string, message: string, confirmText = "本当に消す") {
        super(app);
        this.title = title;
        this.message = message;
        this.confirmText = confirmText;
    }

    openAndWait(): Promise<boolean> {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }

    private finish(result: boolean) {
        if (this.resolved) return;
        this.resolved = true;
        this.resolve?.(result);
        this.close();
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: this.title });
        for (const line of this.message.split("\n")) {
            contentEl.createEl("p", { text: line });
        }

        const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
        buttonContainer.style.display = "flex";
        buttonContainer.style.justifyContent = "flex-end";
        buttonContainer.style.gap = "10px";

        const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
        cancelBtn.onclick = () => this.finish(false);

        const confirmBtn = buttonContainer.createEl("button", { text: this.confirmText, cls: "mod-warning" });
        confirmBtn.onclick = () => this.finish(true);
        cancelBtn.tabIndex = 0;
        confirmBtn.tabIndex = 0;

        contentEl.addEventListener("keydown", (e) => {
            const active = document.activeElement;
            if (e.key === "Tab" && (active === cancelBtn || active === confirmBtn)) {
                e.preventDefault();
                const next = active === cancelBtn ? confirmBtn : cancelBtn;
                next.focus();
            }
            if (e.key === "Escape") {
                e.preventDefault();
                this.finish(false);
            }
            if (e.key === "Enter") {
                if (active === cancelBtn || active === confirmBtn) {
                    e.preventDefault();
                    (active as HTMLButtonElement).click();
                }
            }
        });

        setTimeout(() => cancelBtn.focus(), 50);
    }

    onClose() {
        if (!this.resolved) {
            this.resolved = true;
            this.resolve?.(false);
        }
        this.contentEl.empty();
    }
}

class DeleteFileModal extends Modal {
    file: TFile;
    attachments: TFile[];
    onSubmit: (deleteMain: boolean, attachmentsToDelete: TFile[]) => void | Promise<void>;
    selectedAttachments: Set<string>;

    constructor(app: App, file: TFile, attachments: TFile[], onSubmit: (deleteMain: boolean, attachmentsToDelete: TFile[]) => void | Promise<void>) {
        super(app);
        this.file = file;
        this.attachments = attachments;
        this.onSubmit = onSubmit;
        this.selectedAttachments = new Set(attachments.map(f => f.path)); // Default select all
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl("h2", { text: "Delete File" });

        contentEl.createEl("p", { text: `Are you sure you want to delete "${this.file.basename}"?` });

        if (this.attachments.length > 0) {
            contentEl.createEl("h3", { text: "Also delete attachments?" });

            const listContainer = contentEl.createDiv({ cls: "delete-attachment-list" });
            listContainer.style.maxHeight = "300px";
            listContainer.style.overflowY = "auto";
            listContainer.style.border = "1px solid var(--background-modifier-border)";
            listContainer.style.padding = "10px";
            listContainer.style.borderRadius = "4px";
            listContainer.style.marginBottom = "15px";

            // Select All Toggle
            const toggleAllContainer = listContainer.createDiv({ cls: "attachment-item" });
            toggleAllContainer.style.display = "flex";
            toggleAllContainer.style.alignItems = "center";
            toggleAllContainer.style.marginBottom = "8px";
            toggleAllContainer.style.borderBottom = "1px solid var(--background-modifier-border)";
            toggleAllContainer.style.paddingBottom = "4px";

            const toggleAll = toggleAllContainer.createEl("input", { type: "checkbox" });
            toggleAll.type = "checkbox";
            toggleAll.checked = true;
            toggleAllContainer.createSpan({ text: "Select All", attr: { style: "margin-left: 8px; font-weight: bold;" } });

            const checkBoxes: HTMLInputElement[] = [];

            toggleAll.onchange = () => {
                const checked = toggleAll.checked;
                checkBoxes.forEach(cb => {
                    cb.checked = checked;
                    const path = cb.getAttribute("data-path");
                    if (path) {
                        if (checked) this.selectedAttachments.add(path);
                        else this.selectedAttachments.delete(path);
                    }
                });
            };

            this.attachments.forEach(att => {
                const item = listContainer.createDiv({ cls: "attachment-item" });
                item.style.display = "flex";
                item.style.alignItems = "center";
                item.style.padding = "4px 0";

                const cb = item.createEl("input", { type: "checkbox" });
                cb.type = "checkbox";
                cb.checked = true;
                cb.setAttribute("data-path", att.path);
                checkBoxes.push(cb);

                cb.onchange = () => {
                    if (cb.checked) this.selectedAttachments.add(att.path);
                    else this.selectedAttachments.delete(att.path);

                    // Update Select All state
                    toggleAll.checked = checkBoxes.every(c => c.checked);
                    toggleAll.indeterminate = checkBoxes.some(c => c.checked) && !checkBoxes.every(c => c.checked);
                };

                const label = item.createSpan({ attr: { style: "margin-left: 8px; flex-grow: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" } });
                label.setText(att.name);

                // Show parent folder if different
                // item.createSpan({ text: `(${att.parent?.path})`, style: "margin-left: 8px; color:var(--text-muted); font-size: 0.8em;" });
            });
        }

        const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
        buttonContainer.style.display = "flex";
        buttonContainer.style.justifyContent = "flex-end";
        buttonContainer.style.gap = "10px";

        const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
        cancelBtn.onclick = () => {
            this.close();
        };

        const deleteBtn = buttonContainer.createEl("button", { text: "Delete", cls: "mod-warning" });
        deleteBtn.onclick = async () => {
            const confirmed = await new ConfirmDeleteModal(
                this.app,
                "最終確認",
                `本当に "${this.file.basename}" を消しますか？\nシステムのゴミ箱に移動します。`
            ).openAndWait();
            if (!confirmed) {
                this.close();
                return;
            }

            const toDelete: TFile[] = [];
            if (this.attachments.length > 0) {
                this.attachments.forEach(att => {
                    if (this.selectedAttachments.has(att.path)) {
                        toDelete.push(att);
                    }
                });
            }
            await this.onSubmit(true, toDelete);
            this.close();
        };
        cancelBtn.tabIndex = 0;
        deleteBtn.tabIndex = 0;

        contentEl.addEventListener("keydown", (e) => {
            const active = document.activeElement;
            if (e.key === "Tab" && (active === cancelBtn || active === deleteBtn)) {
                e.preventDefault();
                const next = active === cancelBtn ? deleteBtn : cancelBtn;
                next.focus();
            }
            if (e.key === "Escape") {
                e.preventDefault();
                this.close();
            }
            if (e.key === "Enter") {
                if (active === cancelBtn || active === deleteBtn) {
                    e.preventDefault();
                    (active as HTMLButtonElement).click();
                }
            }
        });

        setTimeout(() => cancelBtn.focus(), 50);
    }

    onClose() {
        this.contentEl.empty();
    }
}
