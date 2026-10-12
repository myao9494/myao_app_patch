// =============================================================================
// MarkMind プラグイン連携機能（非侵襲拡張）
// =============================================================================

/**
 * MarkdownテキストからExcalidrawの内部データセクションを除外する
 * @param {string} mdText
 * @returns {string}
 */
const stripExcalidrawSection = (mdText) => {
    if (!mdText || typeof mdText !== "string") return mdText;
    let result = mdText;
    // 1. '# Excalidraw Data' 以降を丸ごと除去
    const excalidrawHeaderRegex = /(?:^|\n)#{1,6}\s+Excalidraw\s+Data\b[\s\S]*$/i;
    result = result.replace(excalidrawHeaderRegex, "");
    // 2. 警告バナー等を除去
    result = result.replace(/==⚠[\s\S]*?⚠==[^\n]*/g, "");
    // 3. %% コメントブロック内の Drawing 等を除去
    result = result.replace(/%%[\s\S]*?## Drawing[\s\S]*?%%/gi, "");
    return result.trim();
};

/**
 * MarkMind の View クラス（またはプロトタイプ）に対してパッチを適用し、
 * Excalidrawデータがマインドマップに展開されるのを防ぎ、かつ保存時にExcalidrawデータを復元・保護する
 */
const patchMarkMindViewForExcalidraw = (targetProto) => {
    let viewProto = targetProto;
    if (!viewProto) {
        const leaves = app.workspace?.getLeavesOfType?.("mindmapview") || [];
        if (leaves.length > 0 && leaves[0].view) {
            viewProto = Object.getPrototypeOf(leaves[0].view);
        } else if (app.viewRegistry?.viewByType?.["mindmapview"]) {
            try {
                const creator = app.viewRegistry.viewByType["mindmapview"];
                const dummyLeaf = { id: "_patch_dummy", app };
                const dummyView = creator(dummyLeaf);
                if (dummyView) {
                    viewProto = Object.getPrototypeOf(dummyView);
                }
            } catch (e) {
                // 無視
            }
        }
    }

    if (viewProto && !viewProto._excalidrawPatched) {
        if (typeof viewProto.getMdText === "function") {
            const origGetMdText = viewProto.getMdText;
            viewProto.getMdText = function(t) {
                const raw = origGetMdText.apply(this, arguments);
                return stripExcalidrawSection(raw);
            };
        }

        if (typeof viewProto.setViewData === "function") {
            const origSetViewData = viewProto.setViewData;
            viewProto.setViewData = function(t) {
                if (typeof t === "string") {
                    const match = t.match(/(?:^|\n)(#{1,6}\s+Excalidraw\s+Data\b[\s\S]*)$/i);
                    this._excalidrawBackup = match ? match[1].trim() : null;
                }
                return origSetViewData.apply(this, arguments);
            };
        }

        if (typeof viewProto.mindMapChange === "function") {
            const origMindMapChange = viewProto.mindMapChange;
            viewProto.mindMapChange = function(t) {
                const res = origMindMapChange.apply(this, arguments);
                if (this._excalidrawBackup && typeof this.data === "string") {
                    if (!this.data.includes("Excalidraw Data")) {
                        this.data = this.data.trimEnd() + "\n\n" + this._excalidrawBackup + "\n";
                    }
                }
                return res;
            };
        }

        viewProto._excalidrawPatched = true;
        console.log("Patched MarkMind View for Excalidraw compatibility");
    }

    // すでに開いている mindmapview の leaf インスタンスがあれば、_excalidrawBackup を同期
    const openLeaves = app.workspace?.getLeavesOfType?.("mindmapview") || [];
    for (const leaf of openLeaves) {
        const view = leaf.view;
        if (view && view.data && !view._excalidrawBackup) {
            const match = view.data.match(/(?:^|\n)(#{1,6}\s+Excalidraw\s+Data\b[\s\S]*)$/i);
            if (match) {
                view._excalidrawBackup = match[1].trim();
            }
        }
    }
};

// グローバル・外部からも参照可能に公開
window.stripExcalidrawSection = stripExcalidrawSection;
window.patchMarkMindViewForExcalidraw = patchMarkMindViewForExcalidraw;

/**
 * Option (Alt) + M で MarkMind プラグインを有効化（mindmap-plugin: basic を付与）して
 * マインドマップ画面と Markdown 画面をトグル切り替えする
 **/
const toggleMindmapBasic = async () => {
    const activeLeaf = app.workspace.activeLeaf;
    if (!activeLeaf) return;
    const viewType = activeLeaf.view?.getViewType?.();

    if (viewType === "mindmapview") {
        // マインドマップ画面なら Markdown に戻す
        const markmind = app.plugins?.plugins?.["obsidian-markmind"];
        if (markmind?.mindmapFileModes) {
            markmind.mindmapFileModes[activeLeaf.id || activeLeaf.view.file?.path] = "markdown";
        }
        await activeLeaf.setViewState({
            type: "markdown",
            state: activeLeaf.view.getState(),
            popstate: true
        }, { focus: true });
    } else {
        // Markdown画面などの場合
        let activeFile = activeLeaf.view?.file;
        if (!activeFile && activeLeaf.view?.getState) {
            const st = activeLeaf.view.getState();
            if (st && st.file) activeFile = app.vault.getAbstractFileByPath(st.file);
        }
        if (!activeFile) activeFile = app.workspace.getActiveFile();
        if (!activeFile) return;

        // フロントマターに mindmap-plugin がなければ basic を追加
        const cache = app.metadataCache.getFileCache(activeFile);
        if (!cache?.frontmatter || !cache.frontmatter["mindmap-plugin"]) {
            try {
                await app.fileManager.processFrontMatter(activeFile, (fm) => {
                    if (!fm["mindmap-plugin"]) {
                        fm["mindmap-plugin"] = "basic";
                    }
                });
            } catch (err) {
                console.error("Failed to update frontmatter for mindmap:", err);
            }
        }

        const markmind = app.plugins?.plugins?.["obsidian-markmind"];
        if (markmind?.mindmapFileModes) {
            markmind.mindmapFileModes[activeLeaf.id || activeFile.path] = "mindmapview";
        }

        patchMarkMindViewForExcalidraw();

        await activeLeaf.setViewState({
            type: "mindmapview",
            state: activeLeaf.view.getState(),
            popstate: true
        });

        if (activeLeaf.view) {
            patchMarkMindViewForExcalidraw(Object.getPrototypeOf(activeLeaf.view));
        }
    }
};

// 外部からも呼び出せるよう公開
window.toggleMindmapBasic = toggleMindmapBasic;

/**
 * Option + M (Win/Linux: Alt + M) のキーイベントハンドラー
 **/
const handleMindmapShortcutKey = (e) => {
    // Option (Mac) または Alt (Win/Linux) + M
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
        // MacのOption+M入力値 (µ など) や e.code === "KeyM" に対応
        const isM = e.code === "KeyM" || (e.key && e.key.toLowerCase() === "m") || e.key === "µ";
        if (isM) {
            e.preventDefault();
            e.stopPropagation();
            toggleMindmapBasic();
        }
    }
};

registerDocumentListener("_customMindmapShortcutListener", "keydown", handleMindmapShortcutKey);
console.log("Global Option+M (Alt+M) Mindmap shortcut registered");

/**
 * マウスホイール中ボタン (button === 1) 押し込みドラッグによるマインドマップの掴んで移動 (パン操作)
 **/
let isMiddleButtonPanning = false;
let panStartPageX = 0;
let panStartPageY = 0;
let activeMindmapEvent = null;
let activePanContainer = null;
let startContainerScrollLeft = 0;
let startContainerScrollTop = 0;

const handleMiddleMouseDown = (e) => {
    if (e.button !== 1) return; // ホイール中ボタン (中央ボタン)

    const target = e.target;
    if (!(target instanceof Element)) return;

    const mmContainer = target.closest(".mm-app-container") ||
                        target.closest(".markmind-container") ||
                        target.closest(".cm-mindmap-container") ||
                        target.closest(".cm-mindmap") ||
                        target.closest("[data-type='mindmapview']");
    if (!mmContainer) return;

    // ブラウザ標準のオートスクロールアイコン表示を完全抑止
    e.preventDefault();
    e.stopPropagation();

    isMiddleButtonPanning = true;
    panStartPageX = e.pageX;
    panStartPageY = e.pageY;

    const activeLeaf = app.workspace.activeLeaf;
    const mindmap = activeLeaf?.view?.mindmap;

    if (mindmap?.event && typeof mindmap.event.transform === "function") {
        // Basic モード (uc クラス)
        activeMindmapEvent = mindmap.event;
        activeMindmapEvent.pageX = e.pageX;
        activeMindmapEvent.pageY = e.pageY;
        activeMindmapEvent.sx = activeMindmapEvent.x;
        activeMindmapEvent.sy = activeMindmapEvent.y;
        activeMindmapEvent.drag = true;
    } else if (mindmap && mindmap.containerEL) {
        // Rich モード
        activePanContainer = mindmap.containerEL;
        startContainerScrollLeft = activePanContainer.scrollLeft;
        startContainerScrollTop = activePanContainer.scrollTop;
    } else {
        // フォールバック
        activePanContainer = mmContainer.querySelector(".mm-mindmap-container") || mmContainer;
        startContainerScrollLeft = activePanContainer.scrollLeft;
        startContainerScrollTop = activePanContainer.scrollTop;
    }

    const onMouseMove = (me) => {
        if (!isMiddleButtonPanning) return;
        me.preventDefault();
        me.stopPropagation();

        const dx = me.pageX - panStartPageX;
        const dy = me.pageY - panStartPageY;

        if (activeMindmapEvent) {
            activeMindmapEvent.dx = dx;
            activeMindmapEvent.dy = dy;
            activeMindmapEvent.x = activeMindmapEvent.sx + dx;
            activeMindmapEvent.y = activeMindmapEvent.sy + dy;
            activeMindmapEvent.transform();
        } else if (activePanContainer) {
            activePanContainer.scrollLeft = startContainerScrollLeft - dx;
            activePanContainer.scrollTop = startContainerScrollTop - dy;
        }
    };

    const onMouseUp = (ue) => {
        if (ue.button === 1) {
            ue.preventDefault();
            ue.stopPropagation();
        }
        isMiddleButtonPanning = false;
        if (activeMindmapEvent) {
            activeMindmapEvent.drag = false;
            activeMindmapEvent = null;
        }
        activePanContainer = null;
        document.removeEventListener("mousemove", onMouseMove, true);
        document.removeEventListener("mouseup", onMouseUp, true);
    };

    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("mouseup", onMouseUp, true);
};

registerDocumentListener("_customMiddleButtonPanListener", "mousedown", handleMiddleMouseDown);
console.log("Global Middle-click Pan listener registered for Mindmap");

/**
 * Excalidraw埋め込み時にMarkMindが二重描画して競合するのを防止するパッチ
 **/
const patchMarkMindPostProcessor = () => {
    const obsidianLib = getObsidianModule();
    const postProcessors = obsidianLib?.MarkdownPreviewRenderer?.postProcessors;
    if (!Array.isArray(postProcessors)) return;

    for (let i = 0; i < postProcessors.length; i++) {
        const fn = postProcessors[i];
        if (!fn || fn._markmindExcalidrawPatched) continue;

        const fnStr = fn.toString();
        if (fnStr.includes("mindmap-plugin") && fnStr.includes("internal-embed")) {
            const originalFn = fn;
            const wrappedFn = async function(el, ctx) {
                if (ctx) {
                    if (ctx.frontmatter && ctx.frontmatter["excalidraw-plugin"]) return;
                    if (ctx.sourcePath && ctx.sourcePath.toLowerCase().endsWith(".excalidraw.md")) return;
                    if (ctx.sourcePath) {
                        const file = app.vault?.getAbstractFileByPath?.(ctx.sourcePath);
                        if (file) {
                            const cache = app.metadataCache?.getFileCache?.(file);
                            if (cache?.frontmatter && cache.frontmatter["excalidraw-plugin"]) return;
                        }
                    }
                }
                return originalFn.apply(this, arguments);
            };
            wrappedFn._markmindExcalidrawPatched = true;
            postProcessors[i] = wrappedFn;
            console.log("Patched MarkMind MarkdownPostProcessor for Excalidraw compatibility");
        }
    }
};

patchMarkMindPostProcessor();
setTimeout(patchMarkMindPostProcessor, 1000);
setTimeout(patchMarkMindPostProcessor, 3000);

patchMarkMindViewForExcalidraw();
setTimeout(patchMarkMindViewForExcalidraw, 1000);
setTimeout(patchMarkMindViewForExcalidraw, 3000);
if (app.workspace?.on) {
    // スクリプトを再実行しても同じハンドラが積み重ならないよう、前回の登録を解除してから登録する。
    (window._customMarkMindPatchEventRefs || []).forEach((ref) => app.workspace.offref?.(ref));
    window._customMarkMindPatchEventRefs = [
        app.workspace.on("layout-change", () => patchMarkMindViewForExcalidraw()),
        app.workspace.on("active-leaf-change", (leaf) => {
            if (leaf?.view?.getViewType?.() === "mindmapview") {
                patchMarkMindViewForExcalidraw(Object.getPrototypeOf(leaf.view));
            }
        }),
    ].filter(Boolean);
}

// 外部から利用できるようにグローバルに公開
window.createSummary = createSummary;
// Sidebar Explorer TagからMSG添付ファイルを再利用できるように公開する。
window.parseMsgFile = window._sidebarExplorerParseMsgFile || parseMsgFile;
window.SummaryDepthModal = SummaryDepthModal;
