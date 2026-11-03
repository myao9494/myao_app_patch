/**
 * 画像およびExcalidrawの統合カードビュー (ExcalidrawCardsView) を提供するモジュール。
 * 01_data配下のすべての画像ファイルおよび .excalidraw.md ファイルを検出し、
 * タブ（すべて／Excalidraw／共有画像／画像／紐づきのない画像）切り替えによる効率的な一覧プレビューを実現します。
 * Excalidrawは動的プレビューをPNGキャッシュし、画像は直接高速描画します。
 * ファイル削除時は全体再読み込みを行わず、対象カードのみをDOMおよび内部リストから即時削除します。
 *
 * Obsidian Vault Adapter API のみを使用し、Node.js fs への依存を完全排除。
 * キーワード検索、タグ選択、カードサイズ変更（インラインCSSによる滑らかな調整）に対応しています。
 **/
import { ItemView, WorkspaceLeaf, MarkdownRenderer, FileSystemAdapter, Menu, TFolder } from "obsidian";
import { 
    extractUniqueTags, 
    buildBacklinkPathMap,
    type BacklinkPathMap,
    filterExcalidrawFiles, 
    getDragText, 
    getCacheFilePath, 
    getStringHash, 
    cleanOldCaches,
    CACHE_DIR,
    CACHE_INDEX_PATH,
    IMAGE_EXTENSIONS,
    filterFilesByTab,
    deduplicateFilesByPath,
    isDioFile,
    removeFileByPath,
    chooseCardOpenLeaf
} from "./utils";

export const VIEW_TYPE_EXCALIDRAW_CARDS = "excalidraw-cards-view";
const CARD_RENDER_BATCH_SIZE = 80;
const PREVIEW_PNG_SCALE = 0.35;
const SEARCH_RENDER_DEBOUNCE_MS = 120;
const IMAGE_EXTENSION_SET = new Set(IMAGE_EXTENSIONS);

function perfNow(): number {
    return typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
}

function perfElapsed(start: number): number {
    return Math.round((perfNow() - start) * 10) / 10;
}

function logPerf(_label: string, _details: Record<string, unknown> = {}) {
}

function waitForNextFrame(): Promise<void> {
    return new Promise(resolve => {
        if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => resolve());
        } else {
            window.setTimeout(resolve, 0);
        }
    });
}

function renderPreviewUnavailable(imgContainer: HTMLElement, message = "⚠️"): void {
    imgContainer.empty();
    imgContainer.createDiv({ text: message, cls: "excalidraw-card-error" });
}

async function svgContentToPngArrayBuffer(svgContent: string, scale = 3): Promise<ArrayBuffer | null> {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                let width = img.naturalWidth || img.width;
                let height = img.naturalHeight || img.height;
                if (!width || !height) {
                    const widthMatch = svgContent.match(/<svg[^>]*\bwidth=["']?(\d+(?:\.\d+)?)(?:px)?["']/i);
                    const heightMatch = svgContent.match(/<svg[^>]*\bheight=["']?(\d+(?:\.\d+)?)(?:px)?["']/i);
                    const viewBoxMatch = svgContent.match(/<svg[^>]*\bviewBox=["']?[-\d.]+\s+[-\d.]+\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/i);
                    if (widthMatch && heightMatch) {
                        width = parseFloat(widthMatch[1]);
                        height = parseFloat(heightMatch[1]);
                    } else if (viewBoxMatch) {
                        width = parseFloat(viewBoxMatch[1]);
                        height = parseFloat(viewBoxMatch[2]);
                    } else {
                        width = 800;
                        height = 600;
                    }
                }

                const canvas = document.createElement("canvas");
                canvas.width = Math.max(1, Math.ceil(width * scale));
                canvas.height = Math.max(1, Math.ceil(height * scale));
                const ctx = canvas.getContext("2d");
                if (!ctx) {
                    resolve(null);
                    return;
                }
                ctx.fillStyle = "#ffffff";
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.scale(scale, scale);
                ctx.drawImage(img, 0, 0, width, height);
                canvas.toBlob((blob) => {
                    if (!blob) {
                        resolve(null);
                        return;
                    }
                    blob.arrayBuffer().then(resolve).catch(() => resolve(null));
                }, "image/png");
            } catch (e) {
                console.error("[ExcalidrawCache] PNG変換失敗:", e);
                resolve(null);
            }
        };
        img.onerror = () => resolve(null);

        let base64: string;
        try {
            base64 = btoa(unescape(encodeURIComponent(svgContent)));
        } catch (e) {
            base64 = Buffer.from(svgContent).toString("base64");
        }
        img.src = `data:image/svg+xml;base64,${base64}`;
    });
}

type CacheIndexEntry = {
    hash: string;
    cachefile?: string;
    format: "png";
    mtime: number;
};

type PreviewCacheState = {
    index: Record<string, CacheIndexEntry>;
};

type PreviewCard = {
    file: any;
    imgContainer: HTMLElement;
    cachePath: string | null;
};

function isExcalidrawFile(file: any): boolean {
    const lowerName = file.name.toLowerCase();
    return lowerName.endsWith(".excalidraw.md") || lowerName.endsWith("_excalidraw.md");
}

function countFileKinds(files: any[]) {
    let excalidraw = 0;
    let image = 0;
    let dio = 0;

    for (const file of files) {
        if (isExcalidrawFile(file)) {
            excalidraw += 1;
        } else if (isDioFile(file.name)) {
            dio += 1;
        } else if (IMAGE_EXTENSIONS.includes(file.extension?.toLowerCase?.() || "")) {
            image += 1;
        }
    }

    return { excalidraw, image, dio };
}

async function readCacheIndex(adapter: any): Promise<Record<string, CacheIndexEntry>> {
    let index: Record<string, CacheIndexEntry> = {};
    try {
        if (await adapter.exists(CACHE_INDEX_PATH)) {
            index = JSON.parse(await adapter.read(CACHE_INDEX_PATH));
        }
    } catch (e) {
        console.warn("[ExcalidrawCache] index.json読み込み失敗。再作成します:", e);
    }
    return index;
}

async function updateCacheIndex(adapter: any, filePath: string, entry: CacheIndexEntry): Promise<void> {
    const index = await readCacheIndex(adapter);
    index[filePath.replace(/\\/g, "/")] = {
        ...entry,
        cachefile: entry.cachefile?.split("/").pop() || entry.cachefile,
    };

    await adapter.write(CACHE_INDEX_PATH, JSON.stringify(index, null, 2));
}

export class ExcalidrawCardsView extends ItemView {
    private searchQuery: string = "";
    private selectedTag: string = "";
    private cardSize: number = 130;
    private allFiles: any[] = [];
    private gridEl: HTMLElement | null = null;
    private activeTab: "all" | "excalidraw" | "common" | "image" | "unlinked" | "dio" = "all";
    private previewObserver: IntersectionObserver | null = null;
    private previewByElement = new WeakMap<Element, PreviewCard>();
    private refreshTimer: number | null = null;
    private searchRenderTimer: number | null = null;
    private renderRevision = 0;
    private previewGenerationInProgress = new Set<string>();
    private previewCacheState: PreviewCacheState | null = null;
    private previewCachePathByKey = new Map<string, string>();
    private tagOptionsHydrated = false;

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
    }

    getViewType(): string {
        return VIEW_TYPE_EXCALIDRAW_CARDS;
    }

    getDisplayText(): string {
        return "画像一覧の表示";
    }

    getIcon(): string {
        return "images";
    }

    private updateFileList() {
        const start = perfNow();
        const allVaultFiles = this.app.vault.getFiles();
        // ファイルリスト of 取得 (画像ファイルとExcalidrawファイル of 両方)
        const files = allVaultFiles.filter(file => {
            const lowerName = file.name.toLowerCase();
            const isExcalidraw = lowerName.endsWith(".excalidraw.md") || lowerName.endsWith("_excalidraw.md");
            const isImage = IMAGE_EXTENSION_SET.has(file.extension.toLowerCase());
            const isDio = isDioFile(file.name);
            const normalizedPath = file.path.replace(/\\/g, "/");
            return normalizedPath.startsWith("01_data") && (isExcalidraw || isImage || isDio);
        });

        // パスによる重複除去
        const uniqueFiles = deduplicateFilesByPath(files);

        // 更新日時 of 降順ソート
        uniqueFiles.sort((a, b) => b.stat.mtime - a.stat.mtime);
        this.allFiles = uniqueFiles;
        logPerf("updateFileList", {
            totalVaultFiles: allVaultFiles.length,
            matchedFiles: files.length,
            uniqueFiles: uniqueFiles.length,
            ...countFileKinds(uniqueFiles),
            ms: perfElapsed(start),
        });
    }

    private refreshView() {
        this.clearSearchRenderTimer();
        this.updateFileList();
        void this.renderCards();
    }

    private scheduleRefreshView(delayMs = 500) {
        if (this.refreshTimer !== null) {
            window.clearTimeout(this.refreshTimer);
        }

        this.refreshTimer = window.setTimeout(() => {
            this.refreshTimer = null;
            this.refreshView();
        }, delayMs);
    }

    private clearSearchRenderTimer() {
        if (this.searchRenderTimer !== null) {
            window.clearTimeout(this.searchRenderTimer);
            this.searchRenderTimer = null;
        }
    }

    private scheduleSearchRender() {
        this.clearSearchRenderTimer();
        this.searchRenderTimer = window.setTimeout(() => {
            this.searchRenderTimer = null;
            void this.renderCards();
        }, SEARCH_RENDER_DEBOUNCE_MS);
    }

    private handleVaultFileChange(file: any, oldPath?: string) {
        if (!this.shouldRefreshForVaultFileChange(file, oldPath)) {
            return;
        }

        this.scheduleRefreshView();
    }

    /**
     * ファイル削除イベントのハンドラ。
     * 画像一覧のカード対象ファイル自身が削除された場合は、画面全体の再読み込み（キャッシュ・プレビュー再生成等）を行わず、
     * 対象カードDOM要素および内部リストからのみ即時削除することで、高速でチラつきのない操作性を実現します。
     **/
    private handleVaultFileDelete(file: any) {
        if (!file?.path) return;

        const normalizedPath = file.path.replace(/\\/g, "/");

        // 1. フォルダが削除された場合：配下の複数ファイルが影響を受けるため通常リフレッシュ
        if (file instanceof TFolder || (!file.extension && !normalizedPath.includes("."))) {
            if (this.shouldRefreshForVaultFileChange(file)) {
                this.scheduleRefreshView();
            }
            return;
        }

        // 2. 通常のMarkdownノートが削除された場合（画像一覧のカード対象ではない場合）：
        // 「紐づきのない画像」タブやタグ絞り込み中であれば、バックリンク構造の変化を反映するためリフレッシュ
        const isCard = this.isCardOrCardFolderPath(file, file.path);
        if (!isCard) {
            const dependsOnRelationshipData = this.activeTab === "unlinked" || Boolean(this.selectedTag);
            if (dependsOnRelationshipData && normalizedPath.endsWith(".md")) {
                this.scheduleRefreshView();
            }
            return;
        }

        // 3. 画像一覧に表示されるカードファイル自身が削除された場合：
        // 全体再読み込みを行わず、該当するカードDOMおよび内部データのみを即座に削除する。

        // (a) this.allFiles から該当ファイルを除外
        this.allFiles = removeFileByPath(this.allFiles, file.path);

        // (b) キャッシュMapやインデックスステートのクリーンアップ
        const cacheKey = this.getPreviewCacheKey(file);
        this.previewCachePathByKey.delete(cacheKey);
        if (this.previewCacheState) {
            delete this.previewCacheState.index[normalizedPath];
        }

        // (c) DOM上のカード要素を探して削除
        if (this.gridEl) {
            const cards = this.gridEl.querySelectorAll<HTMLElement>(".excalidraw-card");
            cards.forEach(cardEl => {
                const cardPath = (cardEl.dataset.filePath || cardEl.getAttribute("data-path") || "").replace(/\\/g, "/");
                if (cardPath === normalizedPath) {
                    if (this.previewObserver) {
                        const imgContainer = cardEl.querySelector(".excalidraw-card-image");
                        if (imgContainer) {
                            this.previewObserver.unobserve(imgContainer);
                        }
                    }
                    cardEl.remove();
                }
            });

            // もしグリッド内のカードが0件になった場合は、空メッセージを表示
            const remainingCards = this.gridEl.querySelectorAll(".excalidraw-card");
            if (remainingCards.length === 0) {
                const emptyEl = this.gridEl.querySelector(".excalidraw-cards-empty");
                if (!emptyEl) {
                    this.gridEl.createDiv({
                        text: "該当するファイルが見つかりません。",
                        cls: "excalidraw-cards-empty"
                    });
                }
            }
        }
    }

    private shouldRefreshForVaultFileChange(file: any, oldPath?: string): boolean {
        const paths = [file?.path, oldPath].filter((path): path is string => typeof path === "string");
        if (paths.some(path => this.isCardOrCardFolderPath(file, path))) {
            return true;
        }

        // 「紐づきのない画像」とタグ絞り込みは、Vault 内の任意の Markdown が
        // カードへのリンク元になり得るため、その表示中だけ変更を反映する。
        const dependsOnRelationshipData = this.activeTab === "unlinked" || Boolean(this.selectedTag);
        return dependsOnRelationshipData && paths.some(path => path.toLowerCase().endsWith(".md"));
    }

    private isCardOrCardFolderPath(file: any, path: string): boolean {
        const normalizedPath = path.replace(/\\/g, "/");
        const isInDataFolder = normalizedPath === "01_data" || normalizedPath.startsWith("01_data/");
        if (!isInDataFolder) {
            return false;
        }

        if (file instanceof TFolder) {
            return true;
        }

        const lowerName = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1).toLowerCase();
        const extension = lowerName.slice(lowerName.lastIndexOf(".") + 1);
        return lowerName.endsWith(".excalidraw.md") ||
            lowerName.endsWith("_excalidraw.md") ||
            IMAGE_EXTENSION_SET.has(extension) ||
            isDioFile(lowerName);
    }

    private getPreviewCacheKey(file: any): string {
        return `${file.path}:${file.stat.mtime}`;
    }

    async onOpen() {
        const container = this.contentEl;
        container.empty();
        container.addClass("excalidraw-cards-container");

        // タイトルヘッダーの描画
        const header = container.createDiv({ cls: "excalidraw-cards-header" });
        header.createEl("h3", { text: "🖼️ 画像一覧" });

        // ファイル変更イベントの監視登録
        this.registerEvent(this.app.vault.on("create", (file) => this.handleVaultFileChange(file)));
        this.registerEvent(this.app.vault.on("delete", (file) => this.handleVaultFileDelete(file)));
        this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handleVaultFileChange(file, oldPath)));

        // ワークスペースのレイアウト準備が完了した段階で初期化を行う
        this.app.workspace.onLayoutReady(async () => {
            try {
                await this.initializeView(header, container);
            } catch (e) {
                console.error("Failed to initialize Excalidraw Cards View:", e);
                container.createDiv({
                    text: "⚠️ ビューの初期化中にエラーが発生しました。詳細はコンソールログを確認してください。",
                    cls: "excalidraw-cards-empty"
                });
            }
        });
    }

    private async initializeView(header: HTMLElement, container: HTMLElement) {
        const start = perfNow();
        this.updateFileList();

        // タブ切り替えUIの作成
        const tabsContainer = header.createDiv({ cls: "excalidraw-cards-tabs" });
        const tabSpecs = [
            { id: "all", label: "すべて" },
            { id: "excalidraw", label: "Excalidraw" },
            { id: "common", label: "共有画像" },
            { id: "image", label: "画像" },
            { id: "dio", label: "dio" },
            { id: "unlinked", label: "紐づきのない画像" }
        ];

        const tabButtons: HTMLButtonElement[] = [];
        tabSpecs.forEach(spec => {
            const btn = tabsContainer.createEl("button", {
                text: spec.label,
                cls: `excalidraw-tab-button${this.activeTab === spec.id ? " is-active" : ""}`
            }) as HTMLButtonElement;
            
            btn.onclick = () => {
                tabButtons.forEach(b => b.classList.remove("is-active"));
                btn.classList.add("is-active");
                this.activeTab = spec.id as any;
                this.renderCards();
            };
            tabButtons.push(btn);
        });

        // コントロールUIの作成
        const controls = header.createDiv({ cls: "excalidraw-cards-controls" });

        // 1. キーワードフィルター
        const searchGroup = controls.createDiv({ cls: "excalidraw-control-group" });
        searchGroup.createEl("label", { text: "🔍 検索:" });
        const searchInput = searchGroup.createEl("input", {
            type: "text",
            placeholder: "キーワードを入力..."
        });
        searchInput.value = this.searchQuery;
        searchInput.oninput = (e) => {
            this.searchQuery = (e.target as HTMLInputElement).value;
            this.scheduleSearchRender();
        };

        // 2. タグフィルター
        const tagGroup = controls.createDiv({ cls: "excalidraw-control-group" });
        tagGroup.createEl("label", { text: "🏷️ タグ:" });
        const tagSelect = tagGroup.createEl("select");
        
        // デフォルトの「すべて」オプション
        const defaultOption = tagSelect.createEl("option", { text: "タグ (All)" });
        defaultOption.value = "";

        // 初期表示を速くするため、ここではExcalidrawファイル自身のタグだけを同期的に読む。
        // 親Markdown由来のタグはタグ欄を操作したタイミングで補完する。
        const excalidrawFilesOnly = this.allFiles.filter(file => {
            const lowerName = file.name.toLowerCase();
            return lowerName.endsWith(".excalidraw.md") || lowerName.endsWith("_excalidraw.md");
        });
        const tagStart = perfNow();
        const uniqueTags = extractUniqueTags(
            excalidrawFilesOnly,
            this.app.metadataCache,
            undefined,
            { includeParentTags: false }
        );
        logPerf("initialize tags", {
            excalidrawFiles: excalidrawFilesOnly.length,
            tags: uniqueTags.length,
            includeParentTags: false,
            ms: perfElapsed(tagStart),
        });
        for (const tag of uniqueTags) {
            const opt = tagSelect.createEl("option", { text: tag });
            opt.value = tag;
        }
        tagSelect.value = this.selectedTag;
        tagSelect.onfocus = () => {
            void this.hydrateParentTagOptions(tagSelect);
        };
        tagSelect.onchange = (e) => {
            this.selectedTag = (e.target as HTMLSelectElement).value;
            this.renderCards();
        };

        // 3. サイズ変更スライダー
        const sizeGroup = controls.createDiv({ cls: "excalidraw-control-group" });
        sizeGroup.createEl("label", { text: "📐 サイズ:" });
        const sizeSlider = sizeGroup.createEl("input", {
            type: "range"
        });
        sizeSlider.min = "80";
        sizeSlider.max = "675";
        sizeSlider.value = String(this.cardSize);
        sizeSlider.oninput = (e) => {
            this.cardSize = parseInt((e.target as HTMLInputElement).value);
            this.updateGridSize();
        };

        // キャッシュディレクトリの存在確認・作成
        try {
            if (!await this.app.vault.adapter.exists(CACHE_DIR)) {
                await this.app.vault.adapter.mkdir(CACHE_DIR);
            }
        } catch (e) {
            console.error("Failed to create cache directory:", e);
        }

        // グリッドコンテナの作成
        this.gridEl = container.createDiv({ cls: "excalidraw-card-grid" });
        this.updateGridSize();

        // カードのレンダリング
        await this.renderCards();
        logPerf("initializeView complete", { ms: perfElapsed(start) });
    }

    private updateGridSize() {
        if (this.gridEl) {
            this.gridEl.style.gridTemplateColumns = `repeat(auto-fill, minmax(${this.cardSize}px, 1fr))`;
        }
    }

    private async hydrateParentTagOptions(tagSelect: HTMLSelectElement) {
        if (this.tagOptionsHydrated) return;
        this.tagOptionsHydrated = true;
        const start = perfNow();

        const selectedValue = tagSelect.value;
        const existingTags = new Set(
            Array.from(tagSelect.options)
                .map(option => option.value)
                .filter(Boolean)
        );
        const excalidrawFilesOnly = this.allFiles.filter(file => {
            const lowerName = file.name.toLowerCase();
            return lowerName.endsWith(".excalidraw.md") || lowerName.endsWith("_excalidraw.md");
        });

        const tagBacklinkMap = buildBacklinkPathMap(
            this.app.metadataCache,
            excalidrawFilesOnly.map(file => file.path)
        );
        const uniqueTags = extractUniqueTags(excalidrawFilesOnly, this.app.metadataCache, tagBacklinkMap);
        for (const tag of uniqueTags) {
            if (existingTags.has(tag)) continue;
            existingTags.add(tag);
            const opt = tagSelect.createEl("option", { text: tag });
            opt.value = tag;
        }
        tagSelect.value = selectedValue;
        logPerf("hydrateParentTagOptions", {
            excalidrawFiles: excalidrawFilesOnly.length,
            tags: uniqueTags.length,
            ms: perfElapsed(start),
        });
    }

    private async renderCards() {
        if (!this.gridEl) return;

        this.clearSearchRenderTimer();
        
        const totalStart = perfNow();
        const grid = this.gridEl;
        const renderRevision = ++this.renderRevision;
        const renderContext = {
            revision: renderRevision,
            tab: this.activeTab,
            query: this.searchQuery,
            selectedTag: this.selectedTag,
        };
        logPerf("renderCards start", {
            ...renderContext,
            allFiles: this.allFiles.length,
            ...countFileKinds(this.allFiles),
        });

        const clearStart = perfNow();
        this.disconnectPreviewObserver();
        this.previewByElement = new WeakMap<Element, PreviewCard>();
        grid.empty();
        logPerf("renderCards clear", { ...renderContext, ms: perfElapsed(clearStart) });

        const filterStart = perfNow();
        const needsBacklinks = this.activeTab === "unlinked" || Boolean(this.selectedTag);
        const backlinkMap: BacklinkPathMap | undefined = needsBacklinks
            ? buildBacklinkPathMap(this.app.metadataCache, this.allFiles.map(file => file.path))
            : undefined;
        const backlinkMs = perfElapsed(filterStart);

        // 1. タブに応じたフィルタリングの適用
        const tabFilterStart = perfNow();
        const tabFiltered = filterFilesByTab(this.allFiles, this.activeTab, this.app.metadataCache, backlinkMap);
        const tabFilterMs = perfElapsed(tabFilterStart);

        // 2. キーワードおよびタグでのフィルタリングの適用
        const textFilterStart = perfNow();
        const filteredFiles = filterExcalidrawFiles(
            tabFiltered,
            this.app.metadataCache,
            this.searchQuery,
            this.selectedTag,
            backlinkMap
        );
        const textFilterMs = perfElapsed(textFilterStart);
        logPerf("renderCards filters", {
            ...renderContext,
            needsBacklinks,
            backlinkMs,
            tabFiltered: tabFiltered.length,
            filteredFiles: filteredFiles.length,
            tabFilterMs,
            textFilterMs,
        });

        if (filteredFiles.length === 0) {
            grid.createDiv({
                text: "該当するファイルが見つかりません。",
                cls: "excalidraw-cards-empty"
            });
            return;
        }

        // TFileの型を維持するために元のallFilesからフィルタ結果を取得
        const prepareStart = perfNow();
        const filteredPathSet = new Set(filteredFiles.map(f => f.path));
        const filesToRender = this.allFiles.filter(file => filteredPathSet.has(file.path));
        logPerf("renderCards prepare files", {
            ...renderContext,
            filesToRender: filesToRender.length,
            ...countFileKinds(filesToRender),
            ms: perfElapsed(prepareStart),
        });

        const cacheStateStart = perfNow();
        const cacheState = await this.loadPreviewCacheState();
        logPerf("renderCards load cache index", {
            ...renderContext,
            indexEntries: Object.keys(cacheState.index).length,
            ms: perfElapsed(cacheStateStart),
        });

        const resolveStart = perfNow();
        const cachePathByFilePath = await this.resolvePreviewCachePaths(filesToRender, cacheState);
        const excalidrawToRender = filesToRender.filter(isExcalidrawFile).length;
        logPerf("renderCards resolve cache paths", {
            ...renderContext,
            excalidrawToRender,
            cacheHits: cachePathByFilePath.size,
            cacheMisses: excalidrawToRender - cachePathByFilePath.size,
            ms: perfElapsed(resolveStart),
        });

        const previewCards: PreviewCard[] = [];
        const domStart = perfNow();
        let batchCount = 0;

        for (let start = 0; start < filesToRender.length; start += CARD_RENDER_BATCH_SIZE) {
            if (renderRevision !== this.renderRevision) return;
            const batchStart = perfNow();
            const batch = filesToRender.slice(start, start + CARD_RENDER_BATCH_SIZE);
            const batchPreviewCards: PreviewCard[] = [];

            for (const file of batch) {
                const card = grid.createDiv({ cls: "excalidraw-card" });
                card.dataset.filePath = file.path;
                card.setAttribute("data-path", file.path);

                // ドラッグ＆ドロップ機能の実装
                card.setAttribute("draggable", "true");
                card.addEventListener("dragstart", (e: DragEvent) => {
                    if (!e.dataTransfer) return;

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
                });

                // プレビュー画像エリア
                const imgContainer = card.createDiv({ cls: "excalidraw-card-image" });

                const isImage = IMAGE_EXTENSIONS.includes(file.extension.toLowerCase());
                const isDioXml = file.name.endsWith(".dio") || file.name.endsWith(".drawio");

                if (isImage) {
                    // 画像ファイルの場合は直接プレビューを描画
                    const resourceUrl = this.app.vault.getResourcePath(file);
                    imgContainer.createEl("img", {
                        attr: {
                            src: resourceUrl,
                            alt: file.name,
                            loading: "lazy"
                        }
                    });
                } else if (isDioXml) {
                    // Draw.io XMLファイル（非画像）の場合はプレースホルダーを表示
                    imgContainer.createDiv({ 
                        text: "📊", 
                        cls: "excalidraw-card-dio-placeholder" 
                    });
                } else {
                    // Excalidrawの場合はキャッシュの存在チェック
                    const cachePath = cachePathByFilePath.get(file.path) || null;
                    if (cachePath) {
                        imgContainer.createDiv({ 
                            cls: "excalidraw-card-loading" 
                        });
                    } else {
                        imgContainer.createDiv({ 
                            text: "⏳", 
                            cls: "excalidraw-card-loading" 
                        });
                    }
                    const previewCard = { file, imgContainer, cachePath };
                    previewCards.push(previewCard);
                    batchPreviewCards.push(previewCard);
                }

                // タイトルエリア（拡張子を除いたファイル名を表示）
                let displayName = file.name;
                if (file.name.endsWith(".excalidraw.md")) {
                    displayName = file.name.replace(".excalidraw.md", "");
                } else if (file.name.endsWith("_excalidraw.md")) {
                    displayName = file.name.replace("_excalidraw.md", "");
                } else if (file.name.endsWith(".dio.svg")) {
                    displayName = file.name.replace(".dio.svg", "");
                } else if (file.name.endsWith(".drawio.svg")) {
                    displayName = file.name.replace(".drawio.svg", "");
                } else if (file.name.endsWith(".dio")) {
                    displayName = file.name.replace(".dio", "");
                } else if (file.name.endsWith(".drawio")) {
                    displayName = file.name.replace(".drawio", "");
                } else {
                    const dotIdx = file.name.lastIndexOf('.');
                    if (dotIdx !== -1) {
                        displayName = file.name.substring(0, dotIdx);
                    }
                }
                card.createDiv({ cls: "excalidraw-card-title", text: displayName });

                // 右クリックコンテキストメニュー（ドラッグ＆ドロップ後も確実に動作させるための堅牢化）
                card.addEventListener("contextmenu", (e: MouseEvent) => {
                    e.preventDefault();
                    const menu = new Menu();
                    this.app.workspace.trigger("file-menu", menu, file, "excalidraw-cards-gallery");
                    menu.showAtPosition({ x: e.clientX, y: e.clientY });
                });

                // クリックイベント：メインエディタでファイルを開く
                card.onclick = async (e) => {
                    e.preventDefault();
                    const rootLeaves: WorkspaceLeaf[] = [];
                    this.app.workspace.iterateRootLeaves((leaf) => { rootLeaves.push(leaf); });
                    const targetLeaf = chooseCardOpenLeaf(this.app.workspace.getLeaf(false), this.leaf, rootLeaves)
                        ?? this.app.workspace.createLeafBySplit(this.leaf, "horizontal", true);
                    await targetLeaf.openFile(file);
                };

                // ホバー時のツールチップ表示用タイトル
                card.title = `${displayName}\n最終更新: ${new Date(file.stat.mtime).toLocaleString()}`;
            }

            this.observePreviewCards(batchPreviewCards, renderRevision);
            batchCount += 1;
            logPerf("renderCards DOM batch", {
                ...renderContext,
                batch: batchCount,
                batchSize: batch.length,
                renderedSoFar: Math.min(start + CARD_RENDER_BATCH_SIZE, filesToRender.length),
                previewCardsSoFar: previewCards.length,
                ms: perfElapsed(batchStart),
            });

            if (start + CARD_RENDER_BATCH_SIZE < filesToRender.length) {
                await waitForNextFrame();
            }
        }

        logPerf("renderCards complete", {
            ...renderContext,
            filesRendered: filesToRender.length,
            previewCards: previewCards.length,
            domMs: perfElapsed(domStart),
            totalMs: perfElapsed(totalStart),
        });
    }

    private disconnectPreviewObserver() {
        if (this.previewObserver) {
            this.previewObserver.disconnect();
            this.previewObserver = null;
        }
        this.previewByElement = new WeakMap<Element, PreviewCard>();
    }

    private observePreviewCards(
        previewCards: PreviewCard[],
        renderRevision: number
    ) {
        if (previewCards.length === 0 || !this.gridEl) return;
        const start = perfNow();

        if (typeof IntersectionObserver === "undefined") {
            previewCards.slice(0, 24).forEach(({ file, imgContainer, cachePath }) => {
                if (cachePath) {
                    imgContainer.empty();
                    void this.renderPreviewFromCache(imgContainer, file, cachePath);
                } else {
                    void this.runPreviewGeneration(file, imgContainer, renderRevision);
                }
            });
            logPerf("observePreviewCards fallback", {
                revision: renderRevision,
                previewCards: previewCards.length,
                ms: perfElapsed(start),
            });
            return;
        }

        if (!this.previewObserver) {
            this.previewObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;

                const target = entry.target;
                const preview = this.previewByElement.get(target);
                if (!preview) continue;

                this.previewObserver?.unobserve(target);
                if (preview.cachePath) {
                    const cachePath = preview.cachePath;
                    if (renderRevision !== this.renderRevision || !this.gridEl?.contains(preview.imgContainer)) {
                        continue;
                    }
                    preview.imgContainer.empty();
                    void this.renderPreviewFromCache(preview.imgContainer, preview.file, cachePath);
                } else {
                    void this.runPreviewGeneration(preview.file, preview.imgContainer, renderRevision);
                }
            }
        }, {
            root: null,
            rootMargin: "600px 0px",
            threshold: 0.01,
        });
        }

        previewCards.forEach((preview) => {
            this.previewByElement.set(preview.imgContainer, preview);
            this.previewObserver?.observe(preview.imgContainer);
        });
        logPerf("observePreviewCards", {
            revision: renderRevision,
            observed: previewCards.length,
            ms: perfElapsed(start),
        });
    }

    private async loadPreviewCacheState(): Promise<PreviewCacheState> {
        if (this.previewCacheState) {
            return this.previewCacheState;
        }

        const start = perfNow();
        const index = await readCacheIndex(this.app.vault.adapter);
        this.previewCacheState = { index };
        logPerf("loadPreviewCacheState", {
            indexEntries: Object.keys(index).length,
            ms: perfElapsed(start),
        });
        return this.previewCacheState;
    }

    private async resolvePreviewCachePaths(files: any[], cacheState: PreviewCacheState): Promise<Map<string, string>> {
        const start = perfNow();
        const result = new Map<string, string>();
        const excalidrawFiles = files.filter(isExcalidrawFile);

        await Promise.all(excalidrawFiles.map(async (file) => {
            const cacheKey = this.getPreviewCacheKey(file);
            let cachePath: string | null | undefined = this.previewCachePathByKey.get(cacheKey);
            if (!cachePath) {
                cachePath = await this.findExistingPreviewCachePath(file, cacheState);
                if (cachePath) {
                    this.previewCachePathByKey.set(cacheKey, cachePath);
                }
            }

            if (cachePath) {
                result.set(file.path, cachePath);
            }
        }));

        logPerf("resolvePreviewCachePaths", {
            excalidrawFiles: excalidrawFiles.length,
            cacheHits: result.size,
            cacheMisses: excalidrawFiles.length - result.size,
            ms: perfElapsed(start),
        });
        return result;
    }

    private async cacheFileExists(cachePath: string, cacheState?: PreviewCacheState): Promise<boolean> {
        return await this.app.vault.adapter.exists(cachePath);
    }

    private async findExistingPreviewCachePath(file: any, cacheState?: PreviewCacheState): Promise<string | null> {
        const mtime = file.stat.mtime;
        const normalizedFilePath = file.path.replace(/\\/g, "/");
        const cacheFilePath = getCacheFilePath(file.path, mtime);

        try {
            const index = cacheState?.index || await readCacheIndex(this.app.vault.adapter);
            const entry = index[normalizedFilePath];
            if (entry && Number(entry.mtime) === Number(mtime) && entry.cachefile) {
                const indexedCachePath = `${CACHE_DIR}/${entry.cachefile.split("/").pop()}`;
                if (indexedCachePath === cacheFilePath && await this.cacheFileExists(indexedCachePath, cacheState)) {
                    return indexedCachePath;
                }
            }

            if (await this.cacheFileExists(cacheFilePath, cacheState)) {
                return cacheFilePath;
            }
        } catch (e) {
            console.error("Failed to check cache for:", file.path, e);
        }

        return null;
    }

    private async renderPreviewFromCache(imgContainer: HTMLElement, file: any, cachePath: string): Promise<void> {
        const start = perfNow();
        const resourceUrl = this.app.vault.adapter.getResourcePath(cachePath);
        const img = imgContainer.createEl("img", {
            attr: {
                alt: file.name,
                loading: "lazy",
                decoding: "async"
            }
        });
        img.addEventListener("load", () => {
            logPerf("preview image load", {
                file: file.path,
                cachePath,
                naturalWidth: img.naturalWidth,
                naturalHeight: img.naturalHeight,
                ms: perfElapsed(start),
            });
        }, { once: true });
        img.addEventListener("error", () => {
            this.previewCachePathByKey.delete(this.getPreviewCacheKey(file));
            if (this.previewCacheState) {
                delete this.previewCacheState.index[file.path.replace(/\\/g, "/")];
            }
            logPerf("preview image error", {
                file: file.path,
                cachePath,
                ms: perfElapsed(start),
            });
        }, { once: true });
        img.src = resourceUrl;

        if (typeof img.decode === "function") {
            const decodeStart = perfNow();
            try {
                await img.decode();
                logPerf("preview image decode", {
                    file: file.path,
                    cachePath,
                    naturalWidth: img.naturalWidth,
                    naturalHeight: img.naturalHeight,
                    decodeMs: perfElapsed(decodeStart),
                    totalMs: perfElapsed(start),
                });
            } catch (e) {
                logPerf("preview image decode failed", {
                    file: file.path,
                    cachePath,
                    decodeMs: perfElapsed(decodeStart),
                    totalMs: perfElapsed(start),
                });
            }
        }
    }

    private async runPreviewGeneration(file: any, imgContainer: HTMLElement, renderRevision: number) {
        if (!this.gridEl || renderRevision !== this.renderRevision || !this.gridEl.contains(imgContainer)) {
            return;
        }

        const start = perfNow();
        const cacheKey = this.getPreviewCacheKey(file);
        let existingCachePath: string | null | undefined = this.previewCachePathByKey.get(cacheKey);
        if (!existingCachePath) {
            existingCachePath = await this.findExistingPreviewCachePath(file, this.previewCacheState || undefined);
            if (existingCachePath) {
                this.previewCachePathByKey.set(cacheKey, existingCachePath);
            }
        }
        if (existingCachePath) {
            imgContainer.empty();
            await this.renderPreviewFromCache(imgContainer, file, existingCachePath);
            logPerf("runPreviewGeneration cache-hit", {
                file: file.path,
                ms: perfElapsed(start),
            });
            return;
        }

        const generationKey = `${file.path}:${file.stat.mtime}`;
        if (this.previewGenerationInProgress.has(generationKey)) {
            return;
        }

        this.previewGenerationInProgress.add(generationKey);
        try {
            await this.generateAndCachePreview(file, imgContainer);
            logPerf("runPreviewGeneration generated", {
                file: file.path,
                ms: perfElapsed(start),
            });
        } catch (e) {
            console.error("Failed to generate preview for:", file.path, e);
            if (this.gridEl && renderRevision === this.renderRevision && this.gridEl.contains(imgContainer)) {
                renderPreviewUnavailable(imgContainer);
            }
        } finally {
            this.previewGenerationInProgress.delete(generationKey);
        }
    }

    /**
     * SVGプレビューを生成してPNGキャッシュに保存し、カードに描画する。
     * ExcalidrawAutomate APIを優先的に使用し、利用不可の場合はMarkdownRendererにフォールバック。
     * Excalidrawプラグインは embed を <img> 要素（blob:URL）として描画するため、
     * <svg> と <img> の両方を検出対象とする。
     **/
    private async generateAndCachePreview(file: any, imgContainer: HTMLElement): Promise<void> {
        const totalStart = perfNow();
        const mtime = file.stat.mtime;
        const hash = getStringHash(file.path);
        const cacheFilePath = getCacheFilePath(file.path, mtime);

        // 古いキャッシュを削除
        const cleanStart = perfNow();
        await cleanOldCaches(this.app.vault.adapter, hash, mtime);
        logPerf("generate cleanOldCaches", {
            file: file.path,
            ms: perfElapsed(cleanStart),
        });

        let svgContent: string | null = null;

        // 方法1: ExcalidrawAutomate API（余白なし高精細SVG生成）
        // EA APIはバージョンによりファイル読み込みメソッドが異なる。利用可能な場合のみ使用
        const ea = (window as any).ExcalidrawAutomate;
        if (ea) {
            const loadMethod = typeof ea.loadFromFile === 'function' ? 'loadFromFile'
                             : typeof ea.setFile === 'function' ? 'setFile'
                             : null;

            if (loadMethod) {
                const eaStart = perfNow();
                try {
                    ea.reset();
                    await ea[loadMethod](file);
                    const svgEl = await ea.createSVG(undefined, false, undefined, undefined, undefined, 5);
                    if (svgEl) {
                        svgEl.removeAttribute("width");
                        svgEl.removeAttribute("height");
                        svgContent = svgEl.outerHTML;
                    }
                } catch (e) {
                    // EA APIが失敗した場合はMarkdownRendererにフォールバック（想定内）
                    logPerf("generate ExcalidrawAutomate failed", {
                        file: file.path,
                        method: loadMethod,
                        ms: perfElapsed(eaStart),
                    });
                }
                logPerf("generate ExcalidrawAutomate", {
                    file: file.path,
                    method: loadMethod,
                    foundSvg: Boolean(svgContent),
                    ms: perfElapsed(eaStart),
                });
            }
        }

        // 方法2: MarkdownRenderer（Excalidrawプラグインが <img> 要素として描画）
        if (!svgContent) {
            const markdownStart = perfNow();
            const offscreenDiv = document.createElement("div");
            offscreenDiv.style.position = "absolute";
            offscreenDiv.style.visibility = "hidden";
            offscreenDiv.style.width = "1200px";
            offscreenDiv.style.height = "800px";
            document.body.appendChild(offscreenDiv);

            try {
                const renderMarkdownStart = perfNow();
                await MarkdownRenderer.renderMarkdown(
                    `![[${file.path}]]`,
                    offscreenDiv,
                    file.path,
                    this
                );
                logPerf("generate MarkdownRenderer.renderMarkdown", {
                    file: file.path,
                    ms: perfElapsed(renderMarkdownStart),
                });

                // Excalidrawプラグインは非同期で <img> を生成する（IndexedDB経由）
                // <svg> と <img> の両方を探す（最大5000ms待機）
                let foundEl: Element | null = null;
                let waitIterations = 0;
                for (let i = 0; i < 500; i++) {
                    waitIterations = i + 1;
                    // 直接のSVG要素を探す
                    foundEl = offscreenDiv.querySelector("svg");
                    if (foundEl) break;

                    // Excalidrawプラグインが生成する <img src="..."> を探す
                    const imgEl = offscreenDiv.querySelector("img[src]") as HTMLImageElement | null;
                    if (imgEl && imgEl.src && imgEl.src.length > 0) {
                        foundEl = imgEl;
                        break;
                    }

                    await new Promise(resolve => setTimeout(resolve, 10));
                }

                if (foundEl) {
                    const tagName = foundEl.tagName.toLowerCase();
                    const extractStart = perfNow();

                    if (tagName === "svg") {
                        // 直接のSVG要素
                        (foundEl as SVGElement).removeAttribute("width");
                        (foundEl as SVGElement).removeAttribute("height");
                        svgContent = foundEl.outerHTML;

                    } else if (tagName === "img") {
                        // Excalidrawプラグインが生成した <img> → srcからSVGコンテンツを取得
                        const imgSrc = (foundEl as HTMLImageElement).src;
                        try {
                            if (imgSrc.startsWith("data:image/svg+xml")) {
                                // data:URL（base64 or plain）のデコード
                                if (imgSrc.includes(";base64,")) {
                                    svgContent = atob(imgSrc.split(";base64,")[1]);
                                } else {
                                    svgContent = decodeURIComponent(imgSrc.split(",")[1]);
                                }
                            } else if (imgSrc.startsWith("blob:")) {
                                // blob:URL → fetch してテキストとして取得
                                const response = await fetch(imgSrc);
                                const text = await response.text();
                                if (text.includes("<svg")) {
                                    svgContent = text;
                                }
                            } else if (imgSrc.startsWith("data:image/")) {
                                // PNG等の画像形式 → SVGでラップして保存
                                const imgWidth = (foundEl as HTMLImageElement).naturalWidth || 800;
                                const imgHeight = (foundEl as HTMLImageElement).naturalHeight || 600;
                                svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${imgWidth} ${imgHeight}"><image href="${imgSrc}" width="${imgWidth}" height="${imgHeight}"/></svg>`;
                            }
                        } catch (fetchErr) {
                            console.error("[ExcalidrawCache] img src取得失敗:", file.path, fetchErr);
                        }
                    }
                    logPerf("generate preview element extracted", {
                        file: file.path,
                        tagName,
                        waitIterations,
                        hasSvgContent: Boolean(svgContent),
                        ms: perfElapsed(extractStart),
                    });
                } else {
                    console.warn(`[ExcalidrawCache] プレビュー要素未検出 (5000ms): ${file.path}`);
                }
            } finally {
                if (offscreenDiv.parentNode) {
                    document.body.removeChild(offscreenDiv);
                }
                logPerf("generate MarkdownRenderer total", {
                    file: file.path,
                    hasSvgContent: Boolean(svgContent),
                    ms: perfElapsed(markdownStart),
                });
            }
        }

        // キャッシュ保存と描画
        if (svgContent) {
            const saveStart = perfNow();
            if (!await this.app.vault.adapter.exists(CACHE_DIR)) {
                await this.app.vault.adapter.mkdir(CACHE_DIR);
            }

            let renderedCachePath: string | null = null;
            try {
                const pngStart = perfNow();
                const pngBuffer = await svgContentToPngArrayBuffer(svgContent, PREVIEW_PNG_SCALE);
                logPerf("generate svgToPng", {
                    file: file.path,
                    ok: Boolean(pngBuffer),
                    ms: perfElapsed(pngStart),
                });
                if (pngBuffer) {
                    const writeStart = perfNow();
                    await this.app.vault.adapter.writeBinary(cacheFilePath, pngBuffer);
                    await updateCacheIndex(this.app.vault.adapter, file.path, {
                        hash,
                        cachefile: cacheFilePath,
                        format: "png",
                        mtime,
                    });
                    if (this.previewCacheState) {
                        this.previewCacheState.index[file.path.replace(/\\/g, "/")] = {
                            hash,
                            cachefile: cacheFilePath.split("/").pop(),
                            format: "png",
                            mtime,
                        };
                    }
                    this.previewCachePathByKey.set(this.getPreviewCacheKey(file), cacheFilePath);
                    logPerf("generate write png cache", {
                        file: file.path,
                        cacheFilePath,
                        bytes: pngBuffer.byteLength,
                        ms: perfElapsed(writeStart),
                    });
                    renderedCachePath = cacheFilePath;
                } else {
                    console.warn("[ExcalidrawCache] PNG変換に失敗したためキャッシュ保存をスキップしました:", file.path);
                }
            } catch (writeErr) {
                console.error("[ExcalidrawCache] キャッシュ書き込み失敗:", cacheFilePath, writeErr);
            }
            logPerf("generate save cache total", {
                file: file.path,
                renderedCachePath,
                ms: perfElapsed(saveStart),
            });

            if (renderedCachePath) {
                // 描画（ローディング表示を置換）
                imgContainer.empty();
                const resourceUrl = this.app.vault.adapter.getResourcePath(renderedCachePath);
                imgContainer.createEl("img", {
                    attr: {
                        src: resourceUrl,
                        alt: file.name,
                        loading: "lazy"
                    }
                });
            } else {
                renderPreviewUnavailable(imgContainer);
            }
        } else {
            // 直接Markdown描画するとExcalidraw側の欠落画像警告がカード上に出るため、一覧では出さない。
            renderPreviewUnavailable(imgContainer);
        }
        logPerf("generateAndCachePreview complete", {
            file: file.path,
            hasSvgContent: Boolean(svgContent),
            ms: perfElapsed(totalStart),
        });
    }

    async onClose() {
        this.renderRevision += 1;
        this.disconnectPreviewObserver();
        if (this.refreshTimer !== null) {
            window.clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        this.clearSearchRenderTimer();
        this.previewCachePathByKey.clear();
        this.previewCacheState = null;
        this.contentEl.empty();
        this.gridEl = null;
    }
}
