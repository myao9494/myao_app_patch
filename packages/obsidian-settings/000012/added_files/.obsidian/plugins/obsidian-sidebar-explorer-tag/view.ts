/**
 * サイドバーエクスプローラータグのビューコンポーネント
 * 
 * 仕様:
 * - 「tag_key」セクション: キーワードでタグを検索し、一致するファイルを表示する。検索クエリが空のときは、タグが何も入っていないファイルを表示する。
 * - 「タグ」セクション: Vault内のすべてのタグをツリー構造で表示する。キーワードによるタグ自体のフィルタリングに対応。
 * - キーボードナビゲーション（上下キーでの選択、左右キーでのツリー開閉、Enterでのファイルオープン、Deleteでのファイル削除）をサポート。
 * - ファイル一覧からのドラッグ＆ドロップおよびコンテキストメニュー（リネーム、削除、フルパスコピー、Excalidrawの場合はWebで開くなど）に対応。
 * - 設定「本文のタグを有効にする」のオン・オフ切り替えに対応（オフ時はフロントマターのタグのみが検索・ノート一覧対象となる）。
 **/
import { ItemView, WorkspaceLeaf, TFile, TFolder, Menu, MenuItem, FileSystemAdapter, Modal, Notice, Setting, App, moment, getAllTags } from "obsidian";
import type SidebarExplorerTagPlugin from "./main";
import { getIconName, getIconNameFromFilename } from "./iconMap";
import { getDragText, setupObsidianFileDrag, filterFilesByTagQuery, getMocFilename, extractTagsFromMetadata, openFileInMarkdownView } from "./utils";
import { parseMsgBinaryWithLibrary, parseMsgFileWithLibrary, type ParsedMsgFile } from "./msgParser";
import { NOTE_LIST_MARKER_START, NOTE_LIST_MARKER_END, replaceNoteListSection } from "./noteListSection";

export const VIEW_TYPE_SIDEBAR_EXPLORER_TAG = "sidebar-explorer-tag-view";

const iconCache: Map<string, string> = new Map();
interface TagNode {
    name: string;
    fullPath: string;
    count: number;
    totalCount: number;
    children: { [key: string]: TagNode };
}

export class SidebarExplorerTagView extends ItemView {
    private static readonly MAX_RENDERED_FILES = 200;
    private static readonly SEARCH_DEBOUNCE_MS = 1500;
    // タグに変更があった場合だけ使う短いデバウンス。
    // 通常の本文入力では再集計しないため、他プラグインのエディタ処理と競合しない。
    private static readonly TAG_REFRESH_DEBOUNCE_MS = 750;
    plugin: SidebarExplorerTagPlugin;
    private fileSearchSectionContent: HTMLElement | null = null;
    private tagsSectionContent: HTMLElement | null = null;
    private fileSearchQuery: string = "";
    private filterQuery: string = "";
    private selectedItem: HTMLElement | null = null;
    private selectedItems: Set<HTMLElement> = new Set();
    private selectionAnchor: HTMLElement | null = null;
    private selectableItems: HTMLElement[] = [];
    private fileSearchRefreshTimer: number | null = null;
    private fileSearchRefreshMode: "full" | "order" | null = null;
    private tagsRefreshTimer: number | null = null;
    private searchableFilesCache: TFile[] | null = null;
    private searchableFilesCacheKey: string | null = null;
    private tagCacheByPath: Map<string, { mtime: number; enableBodyTags: boolean; tags: string[] }> = new Map();
    private tagSignatureByPath: Map<string, string> = new Map();
    private lastFileSearchMatches: TFile[] | null = null;
    private lastFileSearchMatchesQuery: string | null = null;
    private lastFileSearchMatchesIncludeBodyTags: boolean | null = null;
    private lastRenderedFileSearchKey: string | null = null;
    private lastRenderedTagsKey: string | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: SidebarExplorerTagPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() {
        return VIEW_TYPE_SIDEBAR_EXPLORER_TAG;
    }

    getDisplayText() {
        return "Sidebar Explorer Tag";
    }

    getIcon() {
        return "tags";
    }

    async onOpen() {
        const container = this.contentEl;
        container.empty();
        container.addClass("sidebar-explorer-container");

        this.renderAll(container);

        this.registerEvent(this.app.metadataCache.on('changed', (changedFile) => {
            // metadataCache は本文入力でも通知される。対象範囲内のタグ内容が変わった時だけ
            // タグツリー全体を再集計し、Grimoire 等のエディタ更新と競合しないようにする。
            if (!(changedFile instanceof TFile) || !this.isSearchableMarkdownFile(changedFile)) return;

            const previousSignature = this.tagSignatureByPath.get(changedFile.path);
            this.tagCacheByPath.delete(changedFile.path);
            const currentSignature = this.getTagSignatureForFile(changedFile);

            const tagsChanged = previousSignature === undefined || previousSignature !== currentSignature;
            if (tagsChanged) {
                this.scheduleTagsRefresh();
            }

            if (this.fileSearchQuery.trim()) {
                // タグの変化時だけ全件を再フィルタリングする。本文のみの更新では、
                // 既存の検索結果を並べ替えるだけで更新日時順の表示を維持する。
                if (tagsChanged) this.scheduleFileSearchRefresh();
                else this.scheduleFileSearchOrderRefresh();
            }
        }));

        this.registerEvent(this.app.vault.on('create', (file) => {
            if (!(file instanceof TFile) || !this.isSearchableMarkdownFile(file)) return;
            this.tagCacheByPath.delete(file.path);
            this.tagSignatureByPath.delete(file.path);
            this.invalidateSearchableFilesCache();
            this.lastRenderedFileSearchKey = null;
            this.lastRenderedTagsKey = null;
            this.scheduleTagsRefresh();
            this.scheduleFileSearchRefresh();
        }));

        this.registerEvent(this.app.vault.on('delete', (file) => {
            const affectsSearchableFiles =
                file instanceof TFile
                    ? this.isSearchableMarkdownFile(file)
                    : file instanceof TFolder && this.isSearchableMarkdownPath(file.path);
            if (!affectsSearchableFiles) return;

            if (file instanceof TFile) {
                this.tagCacheByPath.delete(file.path);
                this.tagSignatureByPath.delete(file.path);
            } else {
                // フォルダ削除では子ファイルごとのイベントが来ない環境もある。
                this.invalidateCaches();
            }
            this.invalidateSearchableFilesCache();
            this.scheduleTagsRefresh();
            this.scheduleFileSearchRefresh();
        }));

        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            const affectsSearchableFiles =
                file instanceof TFile
                    ? this.isSearchableMarkdownFile(file) || this.isSearchableMarkdownFilePath(oldPath)
                    : file instanceof TFolder && (this.isSearchableMarkdownPath(file.path) || this.isSearchableMarkdownPath(oldPath));
            if (!affectsSearchableFiles) return;

            if (file instanceof TFolder) {
                // フォルダ移動・リネームではキャッシュ済みの子パスを個別に追跡できないため、
                // このまれな操作時だけ全キャッシュを破棄する。
                this.invalidateCaches();
                this.scheduleTagsRefresh();
                this.scheduleFileSearchRefresh();
                return;
            }

            this.tagCacheByPath.delete(oldPath);
            this.tagSignatureByPath.delete(oldPath);
            this.tagCacheByPath.delete(file.path);
            this.tagSignatureByPath.delete(file.path);
            this.invalidateSearchableFilesCache();
            this.scheduleTagsRefresh();
            this.scheduleFileSearchRefresh();
        }));

        container.setAttr("tabindex", "0");

        this.registerDomEvent(container, "keydown", (e: KeyboardEvent) => {
            if (this.handleKeyDown(e)) {
                e.preventDefault();
                e.stopPropagation();
            }
        });

        this.registerDomEvent(container, "click", (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            const item = target.closest(".sidebar-item");
            if (item && item instanceof HTMLElement) {
                this.handleItemSelection(item, e);
            }
        });
    }

    async onClose() {
        this.clearFileSearchRefreshTimer();
        this.clearTagsRefreshTimer();
    }

    private invalidateSearchableFilesCache() {
        this.searchableFilesCache = null;
        this.searchableFilesCacheKey = null;
        this.invalidateFileSearchMatches();
    }

    private invalidateFileSearchMatches() {
        this.lastFileSearchMatches = null;
        this.lastFileSearchMatchesQuery = null;
        this.lastFileSearchMatchesIncludeBodyTags = null;
    }

    private invalidateCaches() {
        this.invalidateSearchableFilesCache();
        this.tagCacheByPath.clear();
        this.tagSignatureByPath.clear();
        this.lastRenderedFileSearchKey = null;
        this.lastRenderedTagsKey = null;
    }

    // Helper for main.ts to trigger search update
    public setFileSearchQuery(query: string, append: boolean = false) {
        if (append && this.fileSearchQuery) {
            // Check if query is already separated by space
            const existingQueries = this.fileSearchQuery.trim().split(/[\s\u3000]+/);
            if (!existingQueries.includes(query)) {
                this.fileSearchQuery = this.fileSearchQuery.trim() + " " + query;
            }
        } else {
            this.fileSearchQuery = query;
        }

        if (append && this.filterQuery) {
            const existingFilters = this.filterQuery.trim().split(/[\s\u3000]+/);
            if (!existingFilters.includes(query)) {
                this.filterQuery = this.filterQuery.trim() + " " + query;
            }
        } else {
            this.filterQuery = query;
        }

        // 1. Update File Search
        if (this.fileSearchSectionContent && this.fileSearchSectionContent.parentElement) {
            const header = this.fileSearchSectionContent.parentElement.querySelector('.sidebar-header');
            if (header) {
                const input = header.querySelector('input') as HTMLInputElement;
                if (input) {
                    input.value = this.fileSearchQuery;
                }
            }
        }
        this.scheduleFileSearchRefresh();

        // 2. Update Tag Filter
        if (this.tagsSectionContent && this.tagsSectionContent.parentElement) {
            const header = this.tagsSectionContent.parentElement.querySelector('.sidebar-header');
            if (header) {
                const input = header.querySelector('input') as HTMLInputElement;
                if (input) {
                    input.value = this.filterQuery;
                }
            }
        }
        this.scheduleTagsRefresh();
    }

    renderAll(container: HTMLElement) {
        // 「デフォルトに戻す」ボタンを上部に配置
        const resetContainer = container.createDiv();
        resetContainer.style.display = "flex";
        resetContainer.style.justifyContent = "flex-end";
        resetContainer.style.padding = "2px 8px";
        resetContainer.style.borderBottom = "1px solid var(--background-modifier-border)";

        const resetBtn = resetContainer.createEl("button", {
            text: "デフォルトに戻す"
        });
        resetBtn.style.fontSize = "0.7em";
        resetBtn.style.padding = "1px 4px";
        resetBtn.style.height = "auto";
        resetBtn.style.lineHeight = "1";
        resetBtn.style.cursor = "pointer";
        resetBtn.style.background = "none";
        resetBtn.style.border = "1px solid var(--background-modifier-border)";
        resetBtn.style.color = "var(--text-muted)";
        resetBtn.style.borderRadius = "3px";

        resetBtn.onmouseenter = () => {
            resetBtn.style.color = "var(--text-normal)";
            resetBtn.style.borderColor = "var(--text-muted)";
        };
        resetBtn.onmouseleave = () => {
            resetBtn.style.color = "var(--text-muted)";
            resetBtn.style.borderColor = "var(--background-modifier-border)";
        };

        resetBtn.onclick = () => {
            this.setFileSearchQuery("");
        };

        this.fileSearchSectionContent = this.createSection(container, "tag_key", "🔍", (header) => {
            // 右クリックでMOC作成メニューを表示
            header.addEventListener("contextmenu", (event: MouseEvent) => {
                event.preventDefault();
                event.stopPropagation();
                
                const menu = new Menu();
                menu.addItem((item) => {
                    item
                        .setTitle("更新する")
                        .setIcon("refresh-cw")
                        .onClick(() => {
                            void this.refreshTagKeyNow();
                        });
                });
                menu.addItem((item) => {
                    item
                        .setTitle("Search Queryをtag_keyへ読み込む")
                        .setIcon("search")
                        .onClick(() => {
                            this.loadSearchQueryIntoTagKey();
                        });
                });
                menu.addItem((item) => {
                    item
                        .setTitle("ノート一覧を追加")
                        .setIcon("bullet-list")
                        .onClick(() => {
                            this.addNoteListToActiveFile();
                        });
                });
                menu.addItem((item) => {
                    item
                        .setTitle("MOCを作成")
                        .setIcon("document")
                        .onClick(() => {
                            this.createMocFile(false);
                        });
                });
                menu.addItem((item) => {
                    item
                        .setTitle("MOCを作成してサマリーを作成")
                        .setIcon("document-glyph")
                        .onClick(() => {
                            this.createMocFile(true);
                        });
                });
                menu.showAtMouseEvent(event);
            });

            const searchContainer = header.createDiv({ cls: "sidebar-search-container" });
            searchContainer.style.display = "flex";
            searchContainer.style.marginLeft = "auto";
            searchContainer.style.marginRight = "10px";
            searchContainer.onclick = (e) => e.stopPropagation();

            const input = searchContainer.createEl("input", {
                type: "text",
                attr: { placeholder: "Keywords..." }
            });
            input.value = this.fileSearchQuery;
            input.style.width = "120px";
            input.style.fontSize = "0.8em";
            input.style.padding = "2px 4px";
            input.style.borderRadius = "4px";
            input.style.border = "1px solid var(--background-modifier-border)";

            input.oninput = (e) => {
                this.fileSearchQuery = (e.target as HTMLInputElement).value;
                this.scheduleFileSearchRefresh();
            };
        });
        this.refreshFileSearch();

        this.tagsSectionContent = this.createSection(container, "タグ", "🏷️", (header) => {
            const searchContainer = header.createDiv({ cls: "sidebar-search-container" });
            searchContainer.style.display = "flex";
            searchContainer.style.marginLeft = "auto";
            searchContainer.style.marginRight = "10px";
            searchContainer.onclick = (e) => e.stopPropagation();

            const input = searchContainer.createEl("input", {
                type: "text",
                attr: { placeholder: "Filter tags..." }
            });
            input.style.width = "100px";
            input.style.fontSize = "0.8em";
            input.style.padding = "2px 4px";
            input.style.borderRadius = "4px";
            input.style.border = "1px solid var(--background-modifier-border)";

            input.oninput = (e) => {
                this.filterQuery = (e.target as HTMLInputElement).value;
                this.scheduleTagsRefresh();
            };
        });
        this.refreshTags();

        requestAnimationFrame(() => this.updateSelectables());
    }

    private clearFileSearchRefreshTimer() {
        if (this.fileSearchRefreshTimer !== null) {
            window.clearTimeout(this.fileSearchRefreshTimer);
            this.fileSearchRefreshTimer = null;
        }
        this.fileSearchRefreshMode = null;
    }

    private clearTagsRefreshTimer() {
        if (this.tagsRefreshTimer !== null) {
            window.clearTimeout(this.tagsRefreshTimer);
            this.tagsRefreshTimer = null;
        }
    }

    private scheduleFileSearchRefresh() {
        this.clearFileSearchRefreshTimer();
        this.fileSearchRefreshMode = "full";
        this.fileSearchRefreshTimer = window.setTimeout(() => {
            this.fileSearchRefreshTimer = null;
            this.fileSearchRefreshMode = null;
            this.refreshFileSearch();
        }, SidebarExplorerTagView.SEARCH_DEBOUNCE_MS);
    }

    private scheduleFileSearchOrderRefresh() {
        if (!this.fileSearchQuery.trim() || this.fileSearchRefreshMode === "full") return;
        this.clearFileSearchRefreshTimer();
        this.fileSearchRefreshMode = "order";
        this.fileSearchRefreshTimer = window.setTimeout(() => {
            this.fileSearchRefreshTimer = null;
            this.fileSearchRefreshMode = null;
            this.refreshFileSearchOrder();
        }, SidebarExplorerTagView.SEARCH_DEBOUNCE_MS);
    }

    private scheduleTagsRefresh() {
        this.clearTagsRefreshTimer();
        this.tagsRefreshTimer = window.setTimeout(() => {
            this.tagsRefreshTimer = null;
            this.refreshTags();
        }, SidebarExplorerTagView.TAG_REFRESH_DEBOUNCE_MS);
    }

    async addNoteListToActiveFile(queryOverride?: string, silent = false): Promise<boolean> {
        const query = String(queryOverride ?? this.fileSearchQuery).trim();
        if (!query) {
            if (!silent) new Notice("検索キーワード（タグ）が空です。");
            return false;
        }

        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== "md" || activeFile.name.endsWith(".excalidraw.md")) {
            if (!silent) new Notice("開いているマークダウンノートがありません。");
            return false;
        }

        const files = this.getSearchableMarkdownFiles();
        const matches = filterFilesByTagQuery(files, query, (file) => {
            const cache = this.app.metadataCache.getFileCache(file);
            return extractTagsFromMetadata(cache, this.plugin.settings.enableBodyTags);
        }, {
            // MOC用のtopノートは、除外タグを持っていても一覧に残す。
            includeTopTaggedExcluded: true,
        }).filter(file => file.path !== activeFile.path);

        const extractPlainText = (content: string) => {
            let clean = content;
            // YAMLフロントマターを除去
            clean = clean.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
            // # note一覧 セクションを除去 (次の大見出し # まで、またはファイルの終わりまで)
            clean = clean.replace(/#\s+note一覧[\s\S]*?(?=\n#\s|$)/i, "");

            return clean
                .replace(/!\[\[[^\]]*\]\]/g, "")
                .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
                .replace(/<img\b[^>]*>/gi, "")
                .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
                .replace(/\[\[([^\]]+)\]\]/g, "$1")
                .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
                .replace(/<[^>]+>/g, " ")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 100)
                .replace(/#/g, "\\#");
        };
        const rows = await Promise.all(matches.map(async file => {
            const cache = this.app.metadataCache.getFileCache(file);
            // note一覧のタグ列は、ノート上部のプロパティに設定したタグだけを表示する。
            const rawTags = extractTagsFromMetadata(cache, false);
            
            const seen = new Set<string>();
            const uniqueTags: string[] = [];
            for (const t of rawTags) {
                const clean = t.startsWith("#") ? t.substring(1) : t;
                const normalized = "#" + clean.trim();
                const lower = normalized.toLowerCase();
                if (!seen.has(lower)) {
                    seen.add(lower);
                    uniqueTags.push(normalized);
                }
            }

            const content = await this.app.vault.cachedRead(file);
            const excerpt = extractPlainText(content);
            return {
                path: file.path,
                name: file.basename,
                // 文字列にまとめず配列のまま渡す。DataviewJS 側で Obsidian のタグ要素として
                // 描画することで、OS にかかわらずプロパティと同様のタグ表示・クリック動作にする。
                tags: uniqueTags,
                excerpt,
                ctime: moment(file.stat.ctime).format("YYYY-MM-DD HH:mm"),
                mtime: moment(file.stat.mtime).format("YYYY-MM-DD HH:mm"),
            };
        }));
        const noteListData = JSON.stringify(rows);
        const noteListContent = `# note一覧
${NOTE_LIST_MARKER_START}

\`\`\`dataviewjs
// Sidebar Explorer Tagの更新後も、検索ボックスを含む表を再生成する。
const noteListRows = ${noteListData};
const sourcePath = dv.current().file.path;
const searchInput = dv.el("input", "", {
    attr: {
        type: "search",
        placeholder: "ノート名で検索…",
        "aria-label": "ノート名で検索"
    }
});
searchInput.style.marginBottom = "0.75em";
searchInput.style.width = "min(100%, 28em)";

const tableContainer = dv.el("div", "");
const renderNoteList = () => {
    const keywords = searchInput.value.trim().toLocaleLowerCase()
        .split(/[\\s\\u3000]+/).filter(Boolean);
    const filteredRows = noteListRows.filter(row => {
        const name = row.name.toLocaleLowerCase();
        return keywords.every(keyword => name.includes(keyword));
    });

    tableContainer.empty();
    const table = tableContainer.createEl("table", { cls: "dataview table-view-table" });
    const headerRow = table.createEl("thead").createEl("tr");
    ["名称", "タグ", "冒頭", "作成日", "編集日"].forEach(title => headerRow.createEl("th", { text: title }));
    const body = table.createEl("tbody");

    if (filteredRows.length === 0) {
        const row = body.createEl("tr");
        row.createEl("td", { text: "該当するノートがありません", attr: { colspan: "5" } });
        return;
    }

    filteredRows.forEach(rowData => {
        const row = body.createEl("tr");
        const nameCell = row.createEl("td");
        const linkButton = nameCell.createEl("button", { text: rowData.name });
        linkButton.type = "button";
        linkButton.style.cssText = "padding:0;border:0;background:transparent;color:var(--link-color);cursor:pointer;text-decoration:var(--link-decoration);font:inherit;text-align:left;";
        linkButton.addEventListener("click", event => {
            event.preventDefault();
            event.stopImmediatePropagation();
            const targetFile = app.vault.getAbstractFileByPath(rowData.path);
            if (targetFile && typeof window._openNoteListLinkInRightPane === "function") {
                void window._openNoteListLinkInRightPane(targetFile, sourcePath);
            } else if (targetFile) {
                const targetLeaf = app.workspace.getLeaf("split", "vertical");
                if (targetLeaf) void targetLeaf.openFile(targetFile, { active: true });
            }
        });
        const tagCell = row.createEl("td");
        (Array.isArray(rowData.tags) ? rowData.tags : String(rowData.tags || "").split(/\\s+/))
            .filter(Boolean)
            .forEach(tag => {
                const tagName = String(tag).replace(/^#/, "");
                const tagLink = tagCell.createEl("a", {
                    cls: "tag",
                    text: "#" + tagName,
                    attr: { href: "#" + tagName, "data-href": tagName }
                });
                tagLink.style.marginRight = "0.35em";
            });
        row.createEl("td", { text: rowData.excerpt });
        row.createEl("td", { text: rowData.ctime });
        row.createEl("td", { text: rowData.mtime });
    });
};

searchInput.addEventListener("input", renderNoteList);
renderNoteList();
\`\`\`

${NOTE_LIST_MARKER_END}
`;

        try {
            const cachedFrontmatter = this.app.metadataCache.getFileCache(activeFile)?.frontmatter || {};
            const existingSearchKey = Object.keys(cachedFrontmatter).find(key =>
                key.toLowerCase().replace(/\s+/g, "") === "searchquery"
            );
            if (!existingSearchKey || String(cachedFrontmatter[existingSearchKey] ?? "") !== query) {
                await this.app.fileManager.processFrontMatter(activeFile, (frontmatter) => {
                    const frontmatterKey = Object.keys(frontmatter).find(key =>
                        key.toLowerCase().replace(/\s+/g, "") === "searchquery"
                    );
                    frontmatter[frontmatterKey || "Search Query"] = query;
                });
            }

            const originalFileContent = await this.app.vault.read(activeFile);
            let fileContent = originalFileContent;
            const replacedContent = replaceNoteListSection(fileContent, noteListContent);
            if (replacedContent !== null) {
                fileContent = replacedContent;
            } else {
                const hasFrontmatter = fileContent.startsWith("---\n") || fileContent.startsWith("---\r\n");
                let insertIndex = 0;
                if (hasFrontmatter) {
                    const secondTripleDash = fileContent.indexOf("\n---", 3);
                    if (secondTripleDash !== -1) {
                        const endOfLine = fileContent.indexOf("\n", secondTripleDash + 4);
                        if (endOfLine !== -1) {
                            insertIndex = endOfLine + 1;
                        } else {
                            insertIndex = secondTripleDash + 4;
                        }
                    }
                }
                fileContent = fileContent.slice(0, insertIndex) + noteListContent + "\n" + fileContent.slice(insertIndex);
            }

            if (fileContent !== originalFileContent) {
                await this.app.vault.modify(activeFile, fileContent);
            }
            if (!silent) {
                new Notice(matches.length > 0
                    ? "ノート一覧を追加・更新しました。"
                    : `該当ファイルがないため、ノート一覧を0件に更新しました。`);
            }
            return true;
        } catch (error: any) {
            if (!silent) new Notice(`ノート一覧の追加に失敗しました: ${error.message}`);
            console.error(error);
            return false;
        }
    }

    private requestMocDepth(): Promise<number | null> {
        return new MocDepthModal(this.app).openAndWait();
    }

    private getLinkedMarkdownFiles(file: TFile): TFile[] {
        const cache = this.app.metadataCache.getFileCache(file);
        const links = (cache?.links || []).concat(cache?.embeds || []);
        const seen = new Set<string>();
        return links.map(link => this.app.metadataCache.getFirstLinkpathDest(link.link, file.path))
            .filter((target): target is TFile => !!target && target.extension === "md" && !target.name.endsWith(".excalidraw.md"))
            .filter(target => !seen.has(target.path) && (seen.add(target.path), true));
    }

    private buildMocLinkTree(files: TFile[], maxDepth: number): string {
        const lines: string[] = [];
        const expandedAtDepth = new Map<string, number>();
        const walk = (file: TFile, depth: number, ancestors: Set<string>) => {
            const previousDepth = expandedAtDepth.get(file.path);
            const repeated = ancestors.has(file.path) || (previousDepth !== undefined && previousDepth <= depth);
            lines.push(`${"  ".repeat(depth)}- [[${file.path}|${file.basename}]]${repeated ? " ↩︎ 参照済み" : ""}`);
            if (!repeated) expandedAtDepth.set(file.path, depth);
            if (depth >= maxDepth || repeated) return;
            const next = new Set(ancestors);
            next.add(file.path);
            for (const child of this.getLinkedMarkdownFiles(file)) walk(child, depth + 1, next);
        };
        for (const file of files) walk(file, 0, new Set());
        return lines.join("\n") + (lines.length ? "\n" : "");
    }

    private isOfficeDocument(name: string): boolean {
        return /\.(doc|docx|docm|dot|dotx|dotm|ppt|pptx|pptm|pps|ppsx|ppsm|pot|potx|potm)$/i.test(name);
    }

    private getOfficeExtension(name: string, mimeType = ""): string {
        const extension = name.toLowerCase().match(/\.([^.]+)$/)?.[1] || "";
        if (this.isOfficeDocument(name)) return extension;
        const mime = mimeType.toLowerCase().split(";", 1)[0].trim();
        const byMime: Record<string, string> = {
            "application/msword": "doc",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
            "application/vnd.ms-word.document.macroenabled.12": "docm",
            "application/vnd.ms-powerpoint": "ppt",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
            "application/vnd.ms-powerpoint.presentation.macroenabled.12": "pptm",
            "application/vnd.openxmlformats-officedocument.presentationml.slideshow": "ppsx"
        };
        return byMime[mime] || "";
    }

    private sanitizeOfficeName(name: string): string {
        return (name.split(/[\\/]/).pop() || "document").replace(/[\x00-\x1f:*?"<>|#[\]]/g, "_") || "document";
    }

    private stableAssetHash(value: string): string {
        let hash = 2166136261;
        for (const char of value) {
            hash ^= char.charCodeAt(0);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16).padStart(8, "0");
    }

    private async collectOfficeDocuments(roots: TFile[], maxDepth: number): Promise<{
        assets: Array<{ sourceKey: string; name: string; data: ArrayBuffer }>;
        errors: string[];
        msgCount: number;
    }> {
        const office = new Map<string, TFile>();
        const msg = new Map<string, TFile>();
        const minimumDepth = new Map<string, number>();
        const visit = async (file: TFile, depth: number) => {
            const previousDepth = minimumDepth.get(file.path);
            if (previousDepth !== undefined && previousDepth <= depth) return;
            minimumDepth.set(file.path, depth);
            const cache = this.app.metadataCache.getFileCache(file);
            const links = (cache?.links || []).concat(cache?.embeds || []);
            for (const link of links) {
                const target = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
                if (!target) continue;
                if (this.isOfficeDocument(target.name)) office.set(target.path, target);
                else if (target.extension.toLowerCase() === "msg") msg.set(target.path, target);
                else if (target.extension === "md" && !target.name.endsWith(".excalidraw.md") && depth < maxDepth) await visit(target, depth + 1);
            }
        };
        for (const root of roots) await visit(root, 0);
        const result: Array<{ sourceKey: string; name: string; data: ArrayBuffer }> = [];
        const errors: string[] = [];
        let parsedMsgCount = 0;
        for (const file of office.values()) {
            try {
                const binary = await this.app.vault.readBinary(file);
                const bytes = new Uint8Array(binary);
                result.push({ sourceKey: file.path, name: this.sanitizeOfficeName(file.name), data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
            } catch (error) {
                errors.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        const collectParsedMsg = async (parsed: ParsedMsgFile, sourceKey: string, nesting: number): Promise<void> => {
            for (const warning of parsed.Warnings || []) errors.push(`${sourceKey}: ${warning}`);
            for (let index = 0; index < (parsed.Attachments || []).length; index++) {
                const attachment = parsed.Attachments[index];
                const attachmentName = String(attachment.FileName || "attachment");
                const attachmentKey = `${sourceKey}::${index}::${attachmentName}`;
                const bytes = attachment.Data;
                if (!bytes?.byteLength) continue;
                const officeExtension = this.getOfficeExtension(attachmentName, attachment.MimeType);
                if (officeExtension) {
                    const officeName = this.isOfficeDocument(attachmentName)
                        ? attachmentName
                        : `${attachmentName}.${officeExtension}`;
                    result.push({
                        sourceKey: attachmentKey,
                        name: this.sanitizeOfficeName(officeName),
                        data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
                    });
                    continue;
                }
                if (/\.msg$/i.test(attachmentName)) {
                    if (nesting >= 10) {
                        errors.push(`${attachmentKey}: 入れ子MSGが上限10階層を超えました`);
                        continue;
                    }
                    try {
                        parsedMsgCount++;
                        const nested = await parseMsgBinaryWithLibrary(
                            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
                            false
                        );
                        await collectParsedMsg(nested, attachmentKey, nesting + 1);
                    } catch (error) {
                        errors.push(`${attachmentKey}: 入れ子MSG解析失敗: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
            }
        };
        for (const file of msg.values()) {
            try {
                const parsed = await parseMsgFileWithLibrary(this.app, file, false);
                parsedMsgCount++;
                await collectParsedMsg(parsed, file.path, 0);
            } catch (error) {
                const message = `${file.path}: ${error instanceof Error ? error.message : String(error)}`;
                errors.push(message);
                console.warn(`Failed to extract Office attachments from ${file.path}:`, error);
            }
        }
        return { assets: result, errors, msgCount: parsedMsgCount };
    }

    private async hashOfficeAsset(data: ArrayBuffer): Promise<string> {
        try {
            const digest = await crypto.subtle.digest("SHA-256", data);
            return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
        } catch {
            return this.stableAssetHash(Array.from(new Uint8Array(data)).join(","));
        }
    }

    private async saveOfficeDocuments(mocFilename: string, roots: TFile[], maxDepth: number): Promise<{ path: string; count: number; errors: string[]; msgCount: number }> {
        const folderPath = `10_summary/${mocFilename}_summary_office_documents`;
        if (!this.app.vault.getAbstractFileByPath("10_summary")) await this.app.vault.createFolder("10_summary");
        const existingFolder = this.app.vault.getAbstractFileByPath(folderPath);
        if (existingFolder instanceof TFile) throw new Error(`保存先がファイルとして存在します: ${folderPath}`);
        if (!existingFolder) await this.app.vault.createFolder(folderPath);
        const { assets, errors, msgCount } = await this.collectOfficeDocuments(roots, maxDepth);
        const manifestPath = `${folderPath}/_office_documents_manifest.json`;
        const oldManifestFile = this.app.vault.getAbstractFileByPath(manifestPath);
        let oldManaged: string[] = [];
        if (oldManifestFile instanceof TFile) {
            try {
                const oldManifest = JSON.parse(await this.app.vault.read(oldManifestFile));
                if (Array.isArray(oldManifest?.files)) oldManaged = oldManifest.files.filter((name: unknown) => typeof name === "string" && !name.includes("/") && !name.includes("\\"));
            } catch (error) {
                errors.push(`既存マニフェストを読み取れません: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        const managed: string[] = [];
        const manifestEntries: Array<{ file: string; source: string; bytes: number; sha256: string }> = [];
        let count = 0;
        for (const asset of assets) {
            const name = `${this.stableAssetHash(asset.sourceKey)}_${asset.name}`;
            const path = `${folderPath}/${name}`;
            const existing = this.app.vault.getAbstractFileByPath(path);
            if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, asset.data);
            else if (existing) throw new Error(`Office保存先と同名のフォルダがあります: ${path}`);
            else await this.app.vault.createBinary(path, asset.data);
            managed.push(name);
            manifestEntries.push({ file: name, source: asset.sourceKey, bytes: asset.data.byteLength, sha256: await this.hashOfficeAsset(asset.data) });
            count++;
        }
        for (const staleName of oldManaged.filter(name => !managed.includes(name))) {
            const stale = this.app.vault.getAbstractFileByPath(`${folderPath}/${staleName}`);
            if (stale instanceof TFile) await this.app.vault.trash(stale, true);
        }
        const manifest = JSON.stringify({
            version: 2,
            generatedAt: new Date().toISOString(),
            files: managed,
            documents: manifestEntries,
            parsedMsgCount: msgCount,
            errors
        }, null, 2) + "\n";
        if (oldManifestFile instanceof TFile) await this.app.vault.modify(oldManifestFile, manifest);
        else await this.app.vault.create(manifestPath, manifest);
        return { path: folderPath, count, errors, msgCount };
    }

    async createMocFile(createSummaryAfter: boolean = false) {
        const maxDepth = await this.requestMocDepth();
        if (maxDepth === null) return;
        const query = this.fileSearchQuery;
        const mocDir = "02_MOC";
        
        // 1. 02_MOC フォルダが存在するか確認し、なければ作成
        const folder = this.app.vault.getAbstractFileByPath(mocDir);
        if (!folder) {
            try {
                await this.app.vault.createFolder(mocDir);
            } catch (e) {
                new Notice("MOCフォルダの作成に失敗しました。");
                console.error(e);
                return;
            }
        }

        // 2. MOCファイル名を生成
        const filename = getMocFilename(query);
        const relativePath = `${mocDir}/${filename}.md`;

        // 3. 現在マッチしているファイル群を取得
        const files = this.getSearchableMarkdownFiles();
        const matches = filterFilesByTagQuery(files, query, (file) => {
            return this.getCachedTagsForFile(file);
        });

        // 4. MOCファイルの中身を作成
        const dateStr = moment().format("YYYY-MM-DD");
        let content = `---
tags:
  - MOC
search_query: "${query.replace(/"/g, '\\"')}"
created: ${dateStr}
---
# MOC: ${filename}

`;
        if (matches.length === 0) {
            content += "該当するファイルはありませんでした。\n";
        } else {
            content += `<!-- link-depth: ${maxDepth} -->\n\n`;
            content += this.buildMocLinkTree(matches, maxDepth);
        }

        // 5. 作成または上書き
        try {
            const existingFile = this.app.vault.getAbstractFileByPath(relativePath);
            let targetFile: TFile;
            if (existingFile instanceof TFile) {
                await this.app.vault.modify(existingFile, content);
                targetFile = existingFile;
                new Notice(`MOCファイルを更新しました: ${filename}`);
            } else {
                targetFile = await this.app.vault.create(relativePath, content) as TFile;
                new Notice(`MOCファイルを作成しました: ${filename}`);
            }

            // 6. 作成したMOCファイルを開く
            let leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
            if (!leaf) {
                const leaves: WorkspaceLeaf[] = [];
                this.app.workspace.iterateRootLeaves(l => leaves.push(l));
                if (leaves.length > 0) leaf = leaves[0];
                else leaf = this.app.workspace.getLeaf('tab');
            }
            if (leaf) {
                await openFileInMarkdownView(this.app, leaf, targetFile);
            }

            try {
                const office = await this.saveOfficeDocuments(filename, matches, maxDepth);
                if (office.errors.length > 0) {
                    new Notice(`Officeファイルを${office.count}件保存、${office.errors.length}件の解析・読込に失敗しました。コンソールを確認してください。`, 10000);
                    console.error("Office document collection errors:", office.errors);
                } else {
                    new Notice(office.count > 0
                        ? `Officeファイルを${office.count}件保存しました: ${office.path}`
                        : `Officeファイルはありませんでした（MSG確認: ${office.msgCount}件、保存先: ${office.path}）`);
                }
            } catch (officeError) {
                new Notice("Officeファイルの収集に失敗しました。");
                console.error(officeError);
            }

            // 7. 連動してサマリーを作成する
            if (createSummaryAfter) {
                const globalSummary = (window as any).createSummary;
                if (typeof globalSummary === "function") {
                    setTimeout(async () => {
                        try {
                            await globalSummary(targetFile);
                        } catch (summaryErr) {
                            new Notice("サマリーの作成中にエラーが発生しました。");
                            console.error(summaryErr);
                        }
                    }, 100);
                } else {
                    new Notice("サマリー作成機能（RegisterCustomCommands）がロードされていません。");
                }
            }
        } catch (e) {
            new Notice("MOCファイルの作成/更新に失敗しました。");
            console.error(e);
        }
    }

    private getSearchableMarkdownFiles(): TFile[] {
        const targetFolders = this.plugin.settings.tagTargetFolders ?? ["01_data", "02_MOC"];
        const cacheKey = JSON.stringify(targetFolders);
        if (this.searchableFilesCache && this.searchableFilesCacheKey === cacheKey) {
            return this.searchableFilesCache;
        }

        this.searchableFilesCacheKey = cacheKey;
        this.searchableFilesCache = this.app.vault.getMarkdownFiles()
            .filter((file) => this.isSearchableMarkdownFile(file));
        return this.searchableFilesCache;
    }

    refreshConfiguredScope() {
        this.invalidateCaches();
        this.refreshFileSearch();
        this.refreshTags();
    }

    /** タグツリーの右クリックメニューから呼ぶ即時更新。 */
    private refreshTagsNow() {
        this.clearTagsRefreshTimer();
        this.clearFileSearchRefreshTimer();
        this.invalidateCaches();
        this.refreshFileSearch();
        this.refreshTags();
        new Notice("タグを更新しました");
    }

    /** tag_key ヘッダーの「更新する」から、サイドバーと現在のノート一覧を更新する。 */
    private async refreshTagKeyNow() {
        this.clearTagsRefreshTimer();
        this.clearFileSearchRefreshTimer();
        this.invalidateCaches();
        this.refreshFileSearch();
        this.refreshTags();

        const activeFile = this.app.workspace.getActiveFile();
        const savedQuery = activeFile ? this.getSavedSearchQuery(activeFile) : null;
        if (savedQuery) {
            const updated = await this.addNoteListToActiveFile(savedQuery, true);
            new Notice(updated ? "タグとノート一覧を更新しました" : "タグを更新しました");
            return;
        }

        new Notice("タグを更新しました（現在のノートにSearch Queryはありません）");
    }

    /** 現在のノートの Search Query を、既存の tag_key 値を無視して上書きする。 */
    private loadSearchQueryIntoTagKey() {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== "md" || activeFile.name.endsWith(".excalidraw.md")) {
            new Notice("開いているマークダウンノートがありません。");
            return;
        }

        const savedQuery = this.getSavedSearchQuery(activeFile);
        if (!savedQuery) {
            new Notice("現在のノートにSearch Queryがありません。");
            return;
        }

        this.setFileSearchQuery(savedQuery, false);
        new Notice(`Search Query「${savedQuery}」をtag_keyへ読み込みました`);
    }

    private getSavedSearchQuery(file: TFile): string | null {
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (!frontmatter) return null;

        const searchKey = Object.keys(frontmatter).find(key =>
            key.toLowerCase().replace(/\s+/g, "") === "searchquery"
        );
        if (!searchKey) return null;

        const value = String(frontmatter[searchKey] ?? "").trim();
        return value || null;
    }

    private shouldIgnoreFile(path: string): boolean {
        return path.includes("/node_modules/") || path.startsWith("node_modules/");
    }

    private isSearchableMarkdownPath(path: string): boolean {
        if (this.shouldIgnoreFile(path)) return false;
        const targetFolders = this.plugin.settings.tagTargetFolders ?? ["01_data", "02_MOC"];
        return targetFolders.length === 0 || targetFolders.some(folder => path === folder || path.startsWith(`${folder}/`));
    }

    private isSearchableMarkdownFile(file: TFile): boolean {
        return file.extension === "md" && this.isSearchableMarkdownPath(file.path);
    }

    private isSearchableMarkdownFilePath(path: string): boolean {
        return path.toLowerCase().endsWith(".md") && this.isSearchableMarkdownPath(path);
    }

    private getCachedTagsForFile(file: TFile): string[] {
        const enableBodyTags = this.plugin.settings.enableBodyTags;
        const cached = this.tagCacheByPath.get(file.path);
        if (cached && cached.mtime === file.stat.mtime && cached.enableBodyTags === enableBodyTags) {
            return cached.tags;
        }

        const cache = this.app.metadataCache.getFileCache(file);
        const tags = extractTagsFromMetadata(cache, enableBodyTags);
        this.tagCacheByPath.set(file.path, { mtime: file.stat.mtime, enableBodyTags, tags });
        this.tagSignatureByPath.set(file.path, this.makeTagSignature(tags));
        return tags;
    }

    private getTagSignatureForFile(file: TFile): string {
        return this.makeTagSignature(this.getCachedTagsForFile(file));
    }

    private makeTagSignature(tags: string[]): string {
        // タグの並び順はツリー表示に影響しないため、順序だけが変わった場合は再描画しない。
        return tags.slice().sort((a, b) => a.localeCompare(b)).join("\u0001");
    }

    private getFilesSignature(files: TFile[]): string {
        return files.map(file => `${file.path}:${file.stat.mtime}`).join("|");
    }

    refreshFileSearch() {
        if (!this.fileSearchSectionContent) return;

        const files = this.getSearchableMarkdownFiles();
        const matches = filterFilesByTagQuery(files, this.fileSearchQuery, (file) => {
            return this.getCachedTagsForFile(file);
        });
        this.lastFileSearchMatches = matches;
        this.lastFileSearchMatchesQuery = this.fileSearchQuery;
        this.lastFileSearchMatchesIncludeBodyTags = this.plugin.settings.enableBodyTags;

        this.renderFileSearchMatches(matches);
    }

    private refreshFileSearchOrder() {
        const cachedMatches = this.lastFileSearchMatches;
        const cachedMatchesAreCurrent =
            cachedMatches !== null &&
            this.lastFileSearchMatchesQuery === this.fileSearchQuery &&
            this.lastFileSearchMatchesIncludeBodyTags === this.plugin.settings.enableBodyTags;
        if (!cachedMatchesAreCurrent) {
            this.refreshFileSearch();
            return;
        }

        cachedMatches.sort((a, b) => b.stat.mtime - a.stat.mtime);
        this.renderFileSearchMatches(cachedMatches);
    }

    private renderFileSearchMatches(matches: TFile[]) {
        if (!this.fileSearchSectionContent) return;

        const isQueryEmpty = !this.fileSearchQuery.trim();
        const renderedMatches = matches.slice(0, SidebarExplorerTagView.MAX_RENDERED_FILES);
        const renderKey = [
            this.fileSearchQuery,
            this.plugin.settings.enableBodyTags ? "body" : "frontmatter",
            matches.length,
            this.getFilesSignature(renderedMatches)
        ].join("::");
        if (this.lastRenderedFileSearchKey === renderKey) return;
        this.lastRenderedFileSearchKey = renderKey;

        const container = this.fileSearchSectionContent;
        container.empty();

        const list = container.createDiv({ cls: "sidebar-list" });

        if (matches.length === 0) {
            list.createDiv({ text: "No files found", attr: { style: "font-style:italic; opacity:0.5; font-size:0.8em; padding: 4px 8px;" } });
        } else {
            const suffix = matches.length > renderedMatches.length ? ` (${renderedMatches.length} shown)` : "";
            const titleText = isQueryEmpty 
                ? `${matches.length} files with no tags found${suffix}`
                : `${matches.length} files found${suffix}`;
            list.createDiv({ text: titleText, attr: { style: "opacity:0.7; font-size:0.75em; margin-bottom:4px; padding-left:8px;" } });

            for (const file of renderedMatches) {
                this.createFileItem(list, file);
            }
        }

        requestAnimationFrame(() => this.updateSelectables());
    }

    refreshTags() {
        if (!this.tagsSectionContent) return;
        const container = this.tagsSectionContent;

        // 表示対象フォルダ(01_data, 02_MOC)配下のファイルからのみタグと件数を集計する
        const tagCache: { [key: string]: number } = {};
        const files = this.getSearchableMarkdownFiles();
        for (const file of files) {
            const tags = this.getCachedTagsForFile(file);
            for (const tag of tags) {
                const hashTag = "#" + tag;
                tagCache[hashTag] = (tagCache[hashTag] || 0) + 1;
            }
        }
        const sortedTagEntries = Object.entries(tagCache).sort(([a], [b]) => a.localeCompare(b));
        const renderKey = [
            this.filterQuery,
            this.plugin.settings.enableBodyTags ? "body" : "frontmatter",
            sortedTagEntries.map(([tag, count]) => `${tag}:${count}`).join("|")
        ].join("::");
        if (this.lastRenderedTagsKey === renderKey) return;
        this.lastRenderedTagsKey = renderKey;

        container.empty();

        const treeContainer = container.createDiv({ cls: "tag-tree-container" });

        const root: TagNode = { name: "root", fullPath: "", count: 0, totalCount: 0, children: {} };

        const terms = this.filterQuery.trim().split(/[\s　]+/);

        sortedTagEntries.forEach(([tag, count]) => {
            if (this.filterQuery) {
                const match = terms.some(term => tag.toLowerCase().includes(term.toLowerCase()));
                if (!match) return;
            }

            const parts = tag.substring(1).split("/");
            let current = root;

            parts.forEach((part, index) => {
                if (!current.children[part]) {
                    current.children[part] = {
                        name: part,
                        fullPath: "#" + parts.slice(0, index + 1).join("/"),
                        count: 0,
                        totalCount: 0,
                        children: {}
                    };
                }
                current = current.children[part];
            });
            current.count = count;
        });

        this.calcTotalCount(root);
        this.renderTree(root, treeContainer);

        setTimeout(() => this.updateSelectables(), 0);
    }

    calcTotalCount(node: TagNode): number {
        let sum = node.count || 0;
        Object.keys(node.children).forEach(key => {
            sum += this.calcTotalCount(node.children[key]);
        });
        node.totalCount = sum;
        return sum;
    }

    renderTree(node: TagNode, container: HTMLElement) {
        const childrenKeys = Object.keys(node.children).sort((a, b) => {
            return node.children[b].totalCount - node.children[a].totalCount;
        });

        childrenKeys.forEach(key => {
            const child = node.children[key];

            const nodeDiv = container.createDiv({ cls: "tree-node" });
            const row = nodeDiv.createDiv({ cls: "tree-row sidebar-item" });
            row.dataset.tag = child.fullPath;

            const hasChildren = Object.keys(child.children).length > 0;

            const arrow = row.createSpan({ text: "▶", cls: "tree-arrow" });
            if (!hasChildren) arrow.style.visibility = "hidden";

            row.createSpan({ text: child.name, cls: "tree-label" });

            if (child.count > 0) {
                row.createSpan({ text: String(child.count), attr: { style: "font-size: 0.8em; color: var(--text-muted); margin-left: 6px;" } });
            }

            const childrenContainer = nodeDiv.createDiv({ cls: "tree-children" });
            const fileContainer = nodeDiv.createDiv({ cls: "tree-files" });

            let isExpanded = false;
            let filesLoaded = false;

            const toggle = () => {
                isExpanded = !isExpanded;
                if (isExpanded) {
                    arrow.style.transform = "rotate(90deg)";
                    childrenContainer.style.display = "block";
                    fileContainer.style.display = "block";

                    if (child.count > 0 && !filesLoaded) {
                        filesLoaded = true;
                        this.loadTagFiles(child.fullPath, fileContainer);
                    }
                } else {
                    arrow.style.transform = "rotate(0deg)";
                    childrenContainer.style.display = "none";
                    fileContainer.style.display = "none";
                }
                requestAnimationFrame(() => this.updateSelectables());
            };

            row.onclick = (e) => {
                e.stopPropagation();
                this.handleItemSelection(row, e);
                if (e.shiftKey || e.metaKey || e.ctrlKey) return;
                toggle();
            };

            row.addEventListener("contextmenu", (event: MouseEvent) => {
                event.preventDefault();
                const menu = new Menu();

                menu.addItem((item: MenuItem) => {
                    item
                        .setTitle("更新する")
                        .setIcon("refresh-cw")
                        .onClick(() => this.refreshTagsNow());
                });

                menu.addSeparator();

                menu.addItem((item: MenuItem) => {
                    item
                        .setTitle("Rename")
                        .setIcon("pencil")
                        .onClick(() => {
                            new RenameTagModal(this.app, child.fullPath, (newTag) => {
                                this.renameTag(child.fullPath, newTag);
                            }).open();
                        });
                });

                menu.showAtMouseEvent(event);
            });

            if (hasChildren) {
                this.renderTree(child, childrenContainer);
            }
        });
    }

    loadTagFiles(tag: string, container: HTMLElement) {
        const matches: TFile[] = [];
        const files = this.getSearchableMarkdownFiles();

        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            const tags = extractTagsFromMetadata(cache, this.plugin.settings.enableBodyTags);
            const cleanTag = tag.startsWith("#") ? tag.slice(1) : tag;
            if (tags.some(t => t.toLowerCase() === cleanTag.toLowerCase())) {
                matches.push(file);
            }
        }

        matches.sort((a, b) => b.stat.mtime - a.stat.mtime);

        if (matches.length === 0) {
            container.createDiv({ text: "No files visible", attr: { style: "font-style:italic; opacity:0.5; font-size:0.8em; margin-bottom:4px;" } });
        } else {
            for (const file of matches.slice(0, SidebarExplorerTagView.MAX_RENDERED_FILES)) {
                this.createFileItem(container, file);
            }
        }
    }

    createSection(parent: HTMLElement, title: string, icon: string, customUI?: (header: HTMLElement) => void) {
        const section = parent.createDiv({ cls: "sidebar-section" });
        const header = section.createDiv({ cls: "sidebar-header" });
        header.style.display = "flex";
        header.style.alignItems = "center";

        const titleWrapper = header.createDiv({ cls: "sidebar-header-title" });
        titleWrapper.innerHTML = `<span class="icon">${icon}</span> ${title}`;
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

        const iconEl = item.createSpan({ cls: "file-icon" });
        const iconName = this.getIconForFile(file);
        this.loadAndDisplayIcon(iconEl, iconName);

        const nameText = prefix ? `${prefix} ${file.basename}` : file.basename;
        item.createSpan({ cls: "file-name", text: nameText });

        item.dataset.path = file.path;

        item.onclick = (e) => {
            if (e.shiftKey || e.metaKey || e.ctrlKey) {
                e.preventDefault();
                return;
            }
            this.openInMain(file, e);
        };

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
                            const encodedPath = fullPath.split('/').map(p => encodeURIComponent(p)).join('/');
                            const url = `http://localhost:3001/?filepath=${encodedPath}`;
                            await navigator.clipboard.writeText(url);
                            new Notice("URL copied to clipboard");
                        });
                });
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
                        // @ts-ignore
                        if (this.app.fileManager.promptForFileRename) {
                            // @ts-ignore
                            this.app.fileManager.promptForFileRename(file);
                        } else {
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

            // 標準の file-menu 拡張ポイントに委譲し、Webアプリ項目などを一重に追加する。
            this.app.workspace.trigger("file-menu", menu, file, "file-explorer-context-menu");
            menu.showAtMouseEvent(event);
        });
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

        let basePath: string | undefined;
        if (this.app.vault.adapter instanceof FileSystemAdapter) {
            basePath = this.app.vault.adapter.getBasePath();
        }

        const dropText = getDragText(dragInfo, basePath);
        e.dataTransfer.setData("text/plain", dropText);
    }

    async renameTag(oldTag: string, newTag: string) {
        const oldTagText = oldTag.startsWith("#") ? oldTag.substring(1) : oldTag;
        const newTagText = newTag.startsWith("#") ? newTag.substring(1) : newTag;

        if (oldTagText === newTagText) return;

        const files = this.app.vault.getMarkdownFiles();
        let updatedFilesCount = 0;

        const escapeRegExp = (string: string) => {
            return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        };

        const escapedOld = escapeRegExp(oldTagText);
        const regex = new RegExp(`#${escapedOld}(?=[\\/\\s\\\\^\\[\\](){}<>|\`*~:;="',.?!\u3001\u3002]|$)`, 'gi');

        for (const file of files) {
            let fileUpdated = false;

            const cache = this.app.metadataCache.getFileCache(file);
            if (!cache) continue;

            const tags = getAllTags(cache);
            const lowerOldTag = "#" + oldTagText.toLowerCase();
            const lowerOldTagSlash = lowerOldTag + "/";

            if (!tags || !tags.some(t => {
                const lowerT = t.toLowerCase();
                return lowerT === lowerOldTag || lowerT.startsWith(lowerOldTagSlash);
            })) {
                continue;
            }

            try {
                await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
                    const processField = (fieldName: string) => {
                        if (frontmatter[fieldName]) {
                            let val = frontmatter[fieldName];
                            let modified = false;

                            const replaceInArray = (arr: string[]) => {
                                const newArr = arr.map(item => {
                                    if (item.toLowerCase() === oldTagText.toLowerCase()) {
                                        modified = true;
                                        return newTagText;
                                    }
                                    if (item.toLowerCase().startsWith(oldTagText.toLowerCase() + "/")) {
                                        modified = true;
                                        return newTagText + item.substring(oldTagText.length);
                                    }
                                    return item;
                                });
                                // 大文字小文字を区別せずに重複を排除
                                const seen = new Set<string>();
                                const uniqueArr: string[] = [];
                                for (const item of newArr) {
                                    const lower = item.toLowerCase();
                                    if (!seen.has(lower)) {
                                        seen.add(lower);
                                        uniqueArr.push(item);
                                    } else {
                                        modified = true;
                                    }
                                }
                                return uniqueArr;
                            };

                            if (Array.isArray(val)) {
                                frontmatter[fieldName] = replaceInArray(val);
                            } else if (typeof val === 'string') {
                                const split = val.split(',').map(v => v.trim());
                                const replaced = replaceInArray(split);
                                if (modified) {
                                    frontmatter[fieldName] = replaced.join(', ');
                                }
                            }

                            if (modified) fileUpdated = true;
                        }
                    };

                    processField('tags');
                    processField('tag');
                });
            } catch (e) {
                console.error(`Failed to process frontmatter for ${file.path}`, e);
            }

            const content = await this.app.vault.read(file);

            if (regex.test(content)) {
                const newContent = content.replace(regex, `#${newTagText}`);
                if (newContent !== content) {
                    await this.app.vault.modify(file, newContent);
                    fileUpdated = true;
                }
            }

            if (fileUpdated) {
                updatedFilesCount++;
            }
        }

        if (updatedFilesCount > 0) {
            new Notice(`Renamed tag "${oldTagText}" to "${newTagText}" in ${updatedFilesCount} files.`);
        } else {
            new Notice(`No files updated. (Searched for #${oldTagText})`);
        }
    }

    updateSelectables() {
        const allItems = Array.from(this.contentEl.querySelectorAll(".sidebar-item")) as HTMLElement[];
        this.selectableItems = allItems.filter(item => {
            return item.offsetParent !== null;
        });

        for (const item of Array.from(this.selectedItems)) {
            if (!this.selectableItems.includes(item)) {
                item.classList.remove("is-selected");
                this.selectedItems.delete(item);
            }
        }

        if (this.selectedItem && !this.selectableItems.includes(this.selectedItem)) {
            const remaining = Array.from(this.selectedItems);
            this.selectedItem = remaining[remaining.length - 1] ?? null;
        }
    }

    private clearSelection() {
        for (const item of this.selectedItems) item.classList.remove("is-selected");
        this.selectedItems.clear();
        this.selectedItem = null;
    }

    selectItem(item: HTMLElement | null, preserveAnchor: boolean = false) {
        this.clearSelection();
        if (item) {
            this.selectedItems.add(item);
            this.selectedItem = item;
            item.classList.add("is-selected");
            if (!preserveAnchor) this.selectionAnchor = item;
            item.scrollIntoView({
                behavior: "smooth",
                block: "nearest"
            });
        }
    }

    private handleItemSelection(item: HTMLElement, e: MouseEvent) {
        this.updateSelectables();
        if (e.shiftKey && this.selectionAnchor) {
            const anchorIndex = this.selectableItems.indexOf(this.selectionAnchor);
            const itemIndex = this.selectableItems.indexOf(item);
            if (anchorIndex >= 0 && itemIndex >= 0) {
                this.clearSelection();
                const [start, end] = anchorIndex < itemIndex ? [anchorIndex, itemIndex] : [itemIndex, anchorIndex];
                for (const selected of this.selectableItems.slice(start, end + 1)) {
                    selected.classList.add("is-selected");
                    this.selectedItems.add(selected);
                }
                this.selectedItem = item;
                return;
            }
        }
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
            if (this.selectedItems.has(item)) {
                item.classList.remove("is-selected");
                this.selectedItems.delete(item);
            const remaining = Array.from(this.selectedItems);
            this.selectedItem = remaining[remaining.length - 1] ?? null;
            } else {
                item.classList.add("is-selected");
                this.selectedItems.add(item);
                this.selectedItem = item;
                this.selectionAnchor = item;
            }
            return;
        }
        this.selectItem(item);
    }

    moveSelection(direction: 1 | -1, extend: boolean = false) {
        this.updateSelectables();
        if (this.selectableItems.length === 0) return;

        let index = -1;
        if (this.selectedItem) {
            index = this.selectableItems.indexOf(this.selectedItem);
        }

        let newIndex = index + direction;

        if (newIndex < 0) newIndex = 0;
        if (newIndex >= this.selectableItems.length) newIndex = this.selectableItems.length - 1;

        const next = this.selectableItems[newIndex];
        if (extend) {
            const anchor = this.selectionAnchor ?? this.selectedItem ?? next;
            const anchorIndex = this.selectableItems.indexOf(anchor);
            this.clearSelection();
            const [start, end] = anchorIndex < newIndex ? [anchorIndex, newIndex] : [newIndex, anchorIndex];
            for (const item of this.selectableItems.slice(start, end + 1)) {
                item.classList.add("is-selected");
                this.selectedItems.add(item);
            }
            this.selectedItem = next;
            this.selectionAnchor = anchor;
            next.scrollIntoView({ behavior: "smooth", block: "nearest" });
        } else {
            this.selectItem(next);
        }
    }

    handleKeyDown(e: KeyboardEvent): boolean {
        if (e.key === "ArrowDown") {
            this.moveSelection(1, e.shiftKey);
            return true;
        }
        if (e.key === "ArrowUp") {
            this.moveSelection(-1, e.shiftKey);
            return true;
        }
        if (e.key === "Enter") {
            if (this.selectedItem) {
                this.selectedItem.click();
                return true;
            }
        }
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
                    const treeNode = this.selectedItem.closest(".tree-node");
                    if (treeNode && treeNode.parentElement && treeNode.parentElement.classList.contains("tree-children")) {
                        const parentNode = treeNode.parentElement.parentElement;
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
        const commandKey = e.metaKey || e.ctrlKey;
        if (commandKey && e.key.toLowerCase() === "a") {
            this.selectAllMatchingItems();
            return true;
        }
        if (commandKey && e.key.toLowerCase() === "c") {
            void this.copySelectedTags();
            return true;
        }
        if (commandKey && e.key.toLowerCase() === "v") {
            void this.pasteTagsToSelectedFiles();
            return true;
        }
        if (e.key === "Delete" || (e.key === "Backspace" && e.metaKey)) {
            const selectedTags = this.getSelectedTagNames();
            if (selectedTags.length > 0) {
                setTimeout(() => void this.deleteSelectedTagsFromActiveFile(selectedTags), 0);
                return true;
            }
            const files = this.getSelectedFiles();
            if (files.length > 0) {
                setTimeout(() => void this.promptDeleteFiles(files), 0);
                return true;
            }
        }

        return false;
    }

    private selectAllMatchingItems() {
        this.updateSelectables();
        const preferTags = this.selectedItem?.dataset.tag !== undefined;
        const candidates = this.selectableItems.filter(item => preferTags ? !!item.dataset.tag : !!item.dataset.path);
        this.clearSelection();
        for (const item of candidates) {
            item.classList.add("is-selected");
            this.selectedItems.add(item);
        }
        this.selectedItem = candidates[candidates.length - 1] ?? null;
        this.selectionAnchor = candidates[0] ?? null;
    }

    private getSelectedFiles(): TFile[] {
        const paths = new Set(Array.from(this.selectedItems).map(item => item.dataset.path).filter(Boolean) as string[]);
        return Array.from(paths).map(path => this.app.vault.getAbstractFileByPath(path)).filter((file): file is TFile => file instanceof TFile);
    }

    private getSelectedTagNames(): string[] {
        return Array.from(new Set(Array.from(this.selectedItems)
            .map(item => item.dataset.tag?.replace(/^#/, ""))
            .filter((tag): tag is string => !!tag)));
    }

    private getTagsForFile(file: TFile): string[] {
        const cache = this.app.metadataCache.getFileCache(file);
        return ((cache ? getAllTags(cache) : null) ?? []).map(tag => tag.replace(/^#/, ""));
    }

    private async copySelectedTags() {
        const tags = new Set<string>();
        for (const item of this.selectedItems) {
            if (item.dataset.tag) tags.add(item.dataset.tag.replace(/^#/, ""));
        }
        for (const file of this.getSelectedFiles()) {
            for (const tag of this.getTagsForFile(file)) tags.add(tag);
        }
        if (tags.size === 0) return;
        await navigator.clipboard.writeText(Array.from(tags).map(tag => `#${tag}`).join(", "));
        new Notice(`${tags.size}個のタグをコピーしました`);
    }

    private extractTagsFromText(text: string): string[] {
        const hashTags = text.match(/#[^\s,\[\]]+/g);
        const values = hashTags ?? text.replace(/^\s*tags\s*:/i, "").split(/[\s,\[\]]+/);
        return Array.from(new Set(values.map(value => value.replace(/^#/, "").trim()).filter(value => value && !/[:*?"<>|#\[\]]/.test(value))));
    }

    private async pasteTagsToSelectedFiles() {
        let files = this.getSelectedFiles();
        if (files.length === 0) {
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile) files = [activeFile];
        }
        if (files.length === 0) return;
        const tags = this.extractTagsFromText(await navigator.clipboard.readText());
        if (tags.length === 0) {
            new Notice("クリップボードに有効なタグがありません");
            return;
        }
        for (const file of files) {
            await this.app.fileManager.processFrontMatter(file, frontmatter => {
                const current = Array.isArray(frontmatter.tags) ? frontmatter.tags : frontmatter.tags ? [frontmatter.tags] : [];
                const merged = new Map<string, string>();
                for (const tag of [...current, ...tags]) {
                    const clean = String(tag).replace(/^#/, "");
                    merged.set(clean.toLowerCase(), clean);
                }
                frontmatter.tags = Array.from(merged.values());
            });
        }
        new Notice(`${files.length}件のノートに${tags.length}個のタグを貼り付けました`);
    }

    private async deleteSelectedTagsFromActiveFile(tags: string[]) {
        const file = this.app.workspace.getActiveFile();
        if (!file) return;
        if (!window.confirm(`「${file.basename}」から${tags.length}個のタグを削除しますか？`)) return;
        const removing = new Set(tags.map(tag => tag.toLowerCase()));
        await this.app.fileManager.processFrontMatter(file, frontmatter => {
            const current = Array.isArray(frontmatter.tags) ? frontmatter.tags : frontmatter.tags ? [frontmatter.tags] : [];
            frontmatter.tags = current.filter((tag: unknown) => !removing.has(String(tag).replace(/^#/, "").toLowerCase()));
        });
        new Notice(`${tags.length}個のタグを削除しました`);
    }

    private async promptDeleteFiles(files: TFile[]) {
        if (files.length === 1) {
            this.promptDelete(files[0]);
            return;
        }
        const firstConfirmed = await new ConfirmDeleteModal(
            this.app,
            "ファイルの削除",
            `${files.length}件のファイルをゴミ箱へ移動しますか？`,
            "削除"
        ).openAndWait();
        if (!firstConfirmed) return;

        const finalConfirmed = await new ConfirmDeleteModal(
            this.app,
            "最終確認",
            `本当に${files.length}件のファイルを消しますか？\nシステムのゴミ箱に移動します。`
        ).openAndWait();
        if (!finalConfirmed) return;

        for (const file of files) await this.app.vault.trash(file, true);
        this.clearSelection();
        new Notice(`${files.length}件のファイルを削除しました`);
    }

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
        const attachments: TFile[] = [];
        const seenPaths = new Set<string>();
        const cache = this.app.metadataCache.getFileCache(file);

        if (!cache) return [];

        const processLink = (linkPath: string) => {
            const linkedFile = this.app.metadataCache.getFirstLinkpathDest(linkPath, file.path);
            if (linkedFile && linkedFile instanceof TFile) {
                if (seenPaths.has(linkedFile.path)) return;
                seenPaths.add(linkedFile.path);

                if (linkedFile.extension.toLowerCase() !== 'md' &&
                    !this.isInCommonImage(linkedFile) &&
                    !this.isReferencedByAnotherNote(linkedFile, file)) {
                    attachments.push(linkedFile);
                }
            }
        };

        if (cache.links) cache.links.forEach(l => processLink(l.link));
        if (cache.embeds) cache.embeds.forEach(e => processLink(e.link));

        return attachments;
    }

    private isInCommonImage(file: TFile): boolean {
        const normalizedPath = file.path.replace(/\\/g, '/');
        return normalizedPath.startsWith('01_data/common_image/');
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

    private getIconForFile(file: TFile): string {
        const specialIcon = getIconNameFromFilename(file.name);
        if (specialIcon) {
            return specialIcon;
        }
        return getIconName(file.extension);
    }

    private async loadAndDisplayIcon(iconEl: HTMLElement, iconName: string): Promise<void> {
        try {
            if (iconCache.has(iconName)) {
                iconEl.innerHTML = iconCache.get(iconName)!;
                return;
            }

            const svgContent = await this.loadIconSvg(iconName);
            if (svgContent) {
                iconCache.set(iconName, svgContent);
                iconEl.innerHTML = svgContent;
            } else {
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

    private async loadIconSvg(iconName: string): Promise<string | null> {
        try {
            if (this.app.vault.adapter instanceof FileSystemAdapter) {
                const basePath = this.app.vault.adapter.getBasePath();
                // Change path to current plugin
                const iconPath = `.obsidian/plugins/obsidian-sidebar-explorer-tag/icons/${iconName}.svg`;
                const fullPath = `${basePath}/${iconPath}`;

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

export class MocDepthModal extends Modal {
    private resolve: ((depth: number | null) => void) | null = null;
    private settled = false;
    private rawDepth = "1";

    openAndWait(): Promise<number | null> {
        return new Promise(resolve => {
            this.resolve = resolve;
            this.open();
        });
    }

    private submit() {
        const depth = Number(this.rawDepth);
        if (!Number.isInteger(depth) || depth < 0) {
            new Notice("階層数には0以上の整数を入力してください。");
            return;
        }
        this.settled = true;
        this.resolve?.(depth);
        this.close();
    }

    private cancel() {
        this.settled = true;
        this.resolve?.(null);
        this.close();
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "MOCのリンク階層" });

        new Setting(contentEl)
            .setName("リンクをたどる階層数")
            .setDesc("0はタグ一致ノートのみ、1以上はリンク先を指定階層まで含めます。")
            .addText(text => {
                text.setValue(this.rawDepth).onChange(value => { this.rawDepth = value.trim(); });
                text.inputEl.type = "number";
                text.inputEl.min = "0";
                text.inputEl.step = "1";
            });

        new Setting(contentEl)
            .addButton(button => button
                .setButtonText("キャンセル")
                .onClick(() => this.cancel()))
            .addButton(button => button
                .setButtonText("MOCを作成")
                .setCta()
                .onClick(() => this.submit()));

        contentEl.addEventListener("keydown", (event: KeyboardEvent) => {
            if (event.key !== "Enter" || event.isComposing) return;
            event.preventDefault();
            this.submit();
        });

        setTimeout(() => {
            const input = contentEl.querySelector("input[type='number']") as HTMLInputElement | null;
            input?.focus();
            input?.select();
        }, 100);
    }

    onClose() {
        if (!this.settled) {
            this.settled = true;
            this.resolve?.(null);
        }
        this.contentEl.empty();
    }
}

class RenameTagModal extends Modal {
    oldTag: string;
    onSubmit: (newTag: string) => void;

    constructor(app: App, oldTag: string, onSubmit: (newTag: string) => void) {
        super(app);
        this.oldTag = oldTag;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "Rename Tag" });

        const defaultVal = this.oldTag.startsWith("#") ? this.oldTag.substring(1) : this.oldTag;
        let newTag = defaultVal;

        new Setting(contentEl)
            .setName("New Tag Name")
            .setDesc("Enter the new name for the tag")
            .addText((text) =>
                text
                    .setValue(defaultVal)
                    .onChange((value) => {
                        newTag = value;
                    })
            );

        new Setting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText("Rename")
                    .setCta()
                    .onClick(() => {
                        this.close();
                        this.onSubmit(newTag);
                    })
            );

        // Enterキーでリネームを実行できるようにする
        contentEl.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "Enter") {
                if (e.isComposing) return; // IME変換中のEnterを無視
                e.preventDefault();
                this.close();
                this.onSubmit(newTag);
            }
        });

        // 確実にフォーカスと全選択を行うための遅延処理
        setTimeout(() => {
            const input = contentEl.querySelector("input[type='text']") as HTMLInputElement;
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
        this.selectedAttachments = new Set(attachments.map(f => f.path));
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

                    toggleAll.checked = checkBoxes.every(c => c.checked);
                    toggleAll.indeterminate = checkBoxes.some(c => c.checked) && !checkBoxes.every(c => c.checked);
                };

                const label = item.createSpan({ attr: { style: "margin-left: 8px; flex-grow: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" } });
                label.setText(att.name);
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
                `本当に「${this.file.basename}」を消しますか？\nシステムのゴミ箱に移動します。`
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
