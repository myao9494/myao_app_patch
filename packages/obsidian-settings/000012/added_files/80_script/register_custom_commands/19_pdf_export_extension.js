// =============================================================================
// PDFエクスポートの拡張（保存先、モーダルの追加項目、Excalidrawデータを持つノートの出力）
// =============================================================================

// Add PDF export option for code block background
const PDF_CODE_BLOCK_BG_KEY = "customPdfCodeBlockBackgroundEnabled";
const PDF_PATH_CLIPBOARD_KEY = "customPdfExportPathToClipboardEnabled";

const isPdfCodeBlockBackgroundEnabled = () => {
    const stored = localStorage.getItem(PDF_CODE_BLOCK_BG_KEY);
    return stored === null ? true : stored === "true";
};

const isPdfPathToClipboardEnabled = () => {
    const stored = localStorage.getItem(PDF_PATH_CLIPBOARD_KEY);
    return stored === null ? true : stored === "true";
};

const applyPdfCodeBlockBackgroundPreference = () => {
    document.body.classList.toggle("pdf-code-block-bg-disabled", !isPdfCodeBlockBackgroundEnabled());
};

/**
 * Obsidian直下の「temp」フォルダのパスを取得し、存在しない場合は作成する
 **/
const ensureTempDirExists = () => {
    try {
        const path = require("path");
        const fs = require("fs");
        const basePath = app.vault.adapter.basePath;
        const tempDirPath = path.join(basePath, "temp");
        if (!fs.existsSync(tempDirPath)) {
            fs.mkdirSync(tempDirPath, { recursive: true });
        }
        return tempDirPath;
    } catch (e) {
        console.error("Failed to create temp directory:", e);
        return null;
    }
};

/**
 * 保存ダイアログの引数(options)をチェックし、HTMLまたはPDFの出力パスを「temp」フォルダ配下に変更する
 **/
const rewriteDialogDefaultPath = (options) => {
    if (!options || typeof options !== "object") return;
    
    const path = require("path");
    const tempDirPath = ensureTempDirExists();
    if (!tempDirPath) return;

    if (typeof options.defaultPath === "string") {
        const fileName = path.basename(options.defaultPath);
        const ext = path.extname(fileName).toLowerCase();
        if (ext === ".pdf" || ext === ".html") {
            options.defaultPath = path.join(tempDirPath, fileName);
        }
    } else {
        const isPdfOrHtmlFilter = options.filters?.some(f => 
            f.extensions?.some(ext => {
                const lower = ext.toLowerCase();
                return lower === "pdf" || lower === "html";
            })
        );
        if (isPdfOrHtmlFilter) {
            options.defaultPath = path.join(tempDirPath, "Untitled");
        }
    }
};

// Hook Electron ipcRenderer to intercept PDF save dialog path
let ipcRenderer;
let remoteDialog;
try {
    const electron = require("electron");
    ipcRenderer = electron.ipcRenderer;
    if (electron.remote && electron.remote.dialog) {
        remoteDialog = electron.remote.dialog;
    }
} catch (e) {
    try {
        const electron = window.require("electron");
        ipcRenderer = electron.ipcRenderer;
        if (electron.remote && electron.remote.dialog) {
            remoteDialog = electron.remote.dialog;
        }
    } catch (err) {}
}

// Check for @electron/remote
if (!remoteDialog) {
    try {
        remoteDialog = require("@electron/remote").dialog;
    } catch (e) {
        try {
            remoteDialog = window.require("@electron/remote").dialog;
        } catch (err) {}
    }
}

const handleSaveDialogResult = (result) => {
    if (!result) return;
    let filePath = null;
    if (typeof result === "object") {
        if (result.canceled === false && typeof result.filePath === "string") {
            filePath = result.filePath;
        } else if (typeof result.filePath === "string" && !result.canceled) {
            filePath = result.filePath;
        }
    } else if (typeof result === "string") {
        filePath = result;
    }

    if (filePath && filePath.toLowerCase().endsWith(".pdf")) {
        if (isPdfPathToClipboardEnabled()) {
            navigator.clipboard.writeText(filePath)
                .then(() => {
                    new Notice("PDFの絶対パスをクリップボードにコピーしました: " + filePath);
                })
                .catch((err) => {
                    console.error("Failed to copy PDF path:", err);
                });
        }
    }
};

// Hook remote.dialog
if (remoteDialog) {
    if (!remoteDialog.originalShowSaveDialog) {
        remoteDialog.originalShowSaveDialog = remoteDialog.showSaveDialog;
        remoteDialog.showSaveDialog = async function(...args) {
            for (const arg of args) {
                if (arg && typeof arg === "object") {
                    rewriteDialogDefaultPath(arg);
                }
            }
            const result = await remoteDialog.originalShowSaveDialog.apply(this, args);
            try {
                handleSaveDialogResult(result);
            } catch (err) {
                console.error(err);
            }
            return result;
        };
    }
    if (!remoteDialog.originalShowSaveDialogSync) {
        remoteDialog.originalShowSaveDialogSync = remoteDialog.showSaveDialogSync;
        remoteDialog.showSaveDialogSync = function(...args) {
            for (const arg of args) {
                if (arg && typeof arg === "object") {
                    rewriteDialogDefaultPath(arg);
                }
            }
            const result = remoteDialog.originalShowSaveDialogSync.apply(this, args);
            try {
                handleSaveDialogResult(result);
            } catch (err) {
                console.error(err);
            }
            return result;
        };
    }
}

// Hook ipcRenderer
if (ipcRenderer) {
    if (!ipcRenderer.originalInvoke) {
        ipcRenderer.originalInvoke = ipcRenderer.invoke;
        ipcRenderer.invoke = async function(channel, ...args) {
            for (const arg of args) {
                if (arg && typeof arg === "object") {
                    rewriteDialogDefaultPath(arg);
                }
            }
            const result = await ipcRenderer.originalInvoke.apply(this, [channel, ...args]);
            try {
                handleSaveDialogResult(result);
            } catch (err) {
                console.error("Error in hookSaveDialog invoke handler:", err);
            }
            return result;
        };
    }
    if (!ipcRenderer.originalSendSync) {
        ipcRenderer.originalSendSync = ipcRenderer.sendSync;
        ipcRenderer.sendSync = function(channel, ...args) {
            for (const arg of args) {
                if (arg && typeof arg === "object") {
                    rewriteDialogDefaultPath(arg);
                }
            }
            const result = ipcRenderer.originalSendSync.apply(this, [channel, ...args]);
            try {
                handleSaveDialogResult(result);
            } catch (err) {
                console.error("Error in hookSaveDialog sendSync handler:", err);
            }
            return result;
        };
    }
    if (!ipcRenderer.originalSend) {
        ipcRenderer.originalSend = ipcRenderer.send;
        ipcRenderer.send = function(channel, ...args) {
            return ipcRenderer.originalSend.apply(this, [channel, ...args]);
        };
    }
    if (!ipcRenderer.originalOn) {
        ipcRenderer.originalOn = ipcRenderer.on;
        ipcRenderer.on = function(channel, listener) {
            const wrappedListener = function(event, ...args) {
                for (const arg of args) {
                    try {
                        handleSaveDialogResult(arg);
                    } catch (e) {}
                }
                return listener.apply(this, [event, ...args]);
            };
            wrappedListener.originalListener = listener;
            return ipcRenderer.originalOn.apply(this, [channel, wrappedListener]);
        };
    }
}

// Hook HTML5 showSaveFilePicker
if (window.showSaveFilePicker) {
    if (!window.originalShowSaveFilePicker) {
        window.originalShowSaveFilePicker = window.showSaveFilePicker;
        window.showSaveFilePicker = async function(options) {
            const handle = await window.originalShowSaveFilePicker.apply(this, [options]);
            try {
                if (handle && typeof handle.path === "string") {
                    handleSaveDialogResult(handle.path);
                } else if (handle && handle.getFile) {
                    const file = await handle.getFile();
                    if (file && typeof file.path === "string") {
                        handleSaveDialogResult(file.path);
                    }
                }
            } catch (err) {
                console.error("Error in showSaveFilePicker hook:", err);
            }
            return handle;
        };
    }
}

const createPdfCodeBlockBackgroundRow = (modalEl) => {
    if (modalEl.querySelector(".custom-pdf-code-block-bg-row")) return;

    const contentEl = modalEl.querySelector(".modal-content") || modalEl;
    const referenceRow = Array.from(contentEl.querySelectorAll(".setting-item"))
        .find((row) => row.textContent?.includes("倍率"));

    const row = document.createElement("div");
    row.className = "setting-item custom-pdf-code-block-bg-row";

    const info = document.createElement("div");
    info.className = "setting-item-info";
    const name = document.createElement("div");
    name.className = "setting-item-name";
    name.textContent = "コードブロックの薄いグレー背景";
    info.appendChild(name);

    const control = document.createElement("div");
    control.className = "setting-item-control";

    const toggle = document.createElement("div");
    toggle.className = "checkbox-container";
    toggle.setAttribute("role", "checkbox");
    toggle.setAttribute("tabindex", "0");

    const updateToggle = () => {
        const enabled = isPdfCodeBlockBackgroundEnabled();
        toggle.classList.toggle("is-enabled", enabled);
        toggle.setAttribute("aria-checked", String(enabled));
        applyPdfCodeBlockBackgroundPreference();
    };

    const toggleValue = () => {
        localStorage.setItem(PDF_CODE_BLOCK_BG_KEY, String(!isPdfCodeBlockBackgroundEnabled()));
        updateToggle();
    };

    toggle.addEventListener("click", toggleValue);
    toggle.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        toggleValue();
    });

    control.appendChild(toggle);
    row.appendChild(info);
    row.appendChild(control);

    if (referenceRow?.parentElement) {
        referenceRow.parentElement.insertBefore(row, referenceRow.nextSibling);
    } else {
        contentEl.appendChild(row);
    }

    updateToggle();
};

const createPdfExportPathToClipboardRow = (modalEl) => {
    if (modalEl.querySelector(".custom-pdf-export-path-to-clipboard-row")) return;

    const contentEl = modalEl.querySelector(".modal-content") || modalEl;
    const referenceRow = modalEl.querySelector(".custom-pdf-code-block-bg-row") || 
        Array.from(contentEl.querySelectorAll(".setting-item"))
            .find((row) => row.textContent?.includes("倍率"));

    const row = document.createElement("div");
    row.className = "setting-item custom-pdf-export-path-to-clipboard-row";

    const info = document.createElement("div");
    info.className = "setting-item-info";
    const name = document.createElement("div");
    name.className = "setting-item-name";
    name.textContent = "パスをクリップボードに入れる";
    info.appendChild(name);

    const control = document.createElement("div");
    control.className = "setting-item-control";

    const toggle = document.createElement("div");
    toggle.className = "checkbox-container";
    toggle.setAttribute("role", "checkbox");
    toggle.setAttribute("tabindex", "0");

    const updateToggle = () => {
        const enabled = isPdfPathToClipboardEnabled();
        toggle.classList.toggle("is-enabled", enabled);
        toggle.setAttribute("aria-checked", String(enabled));
    };

    const toggleValue = () => {
        localStorage.setItem(PDF_PATH_CLIPBOARD_KEY, String(!isPdfPathToClipboardEnabled()));
        updateToggle();
    };

    toggle.addEventListener("click", toggleValue);
    toggle.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        toggleValue();
    });

    control.appendChild(toggle);
    row.appendChild(info);
    row.appendChild(control);

    if (referenceRow?.parentElement) {
        referenceRow.parentElement.insertBefore(row, referenceRow.nextSibling);
    } else {
        contentEl.appendChild(row);
    }

    updateToggle();
};

const findPdfExportModal = () => Array.from(document.querySelectorAll(".modal"))
    .find((el) => el.textContent?.includes("PDFにエクスポート"));

let activePdfExportModal = null;
const enhancePdfExportModal = (modalEl = findPdfExportModal()) => {
    if (!modalEl) return;
    activePdfExportModal = modalEl;
    createPdfCodeBlockBackgroundRow(modalEl);
    createPdfExportPathToClipboardRow(modalEl);
};

let pdfExportModalEnhancementScheduled = false;
const schedulePdfExportModalEnhancement = (modalEl) => {
    if (pdfExportModalEnhancementScheduled) return;
    pdfExportModalEnhancementScheduled = true;
    requestAnimationFrame(() => {
        pdfExportModalEnhancementScheduled = false;
        const currentModal = modalEl?.isConnected && modalEl.textContent?.includes("PDFにエクスポート")
            ? modalEl
            : findPdfExportModal();
        if (currentModal) enhancePdfExportModal(currentModal);
    });
};

let pdfExportModalDiscoveryScheduled = false;
const schedulePdfExportModalDiscovery = (attempt = 0) => {
    if (pdfExportModalDiscoveryScheduled) return;
    pdfExportModalDiscoveryScheduled = true;
    requestAnimationFrame(() => {
        pdfExportModalDiscoveryScheduled = false;
        const modalEl = findPdfExportModal();
        if (modalEl) {
            schedulePdfExportModalEnhancement(modalEl);
        } else if (attempt < 2) {
            // モーダルの骨組みと本文が別フレームで追加される場合だけ、短く再確認する。
            setTimeout(() => schedulePdfExportModalDiscovery(attempt + 1), 50);
        }
    });
};

const isModalContainerNode = (node) => {
    if (!(node instanceof Element)) return false;
    return node.matches(".modal, .modal-container") || !!node.querySelector(".modal");
};

const handlePdfExportModalMutations = (mutations) => {
    // PDFモーダルが開いていない通常時は、Grimoire の入力に伴うDOM変更を祖先探索せずに無視する。
    if (activePdfExportModal?.isConnected) {
        for (const mutation of mutations) {
            if (activePdfExportModal.contains(mutation.target)) {
                schedulePdfExportModalEnhancement(activePdfExportModal);
                return;
            }
        }
        return;
    }

    activePdfExportModal = null;
    for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
            if (isModalContainerNode(node)) {
                schedulePdfExportModalDiscovery();
                return;
            }
        }
    }
};

if (typeof MutationObserver !== "undefined") {
    if (window._customPdfExportModalObserver) {
        window._customPdfExportModalObserver.disconnect();
    }
    applyPdfCodeBlockBackgroundPreference();
    window._customPdfExportModalObserver = new MutationObserver(handlePdfExportModalMutations);
    window._customPdfExportModalObserver.observe(document.body, { childList: true, subtree: true });
}
enhancePdfExportModal();

// Excalidraw-backed Markdownを表示中にObsidian標準のPDF出力を実行すると、
// Excalidrawビュー（キャンバス）を印刷して空白PDFになることがある。PDF出力直前だけ
// Markdownビューへ戻し、本文と図のプレビューを印刷対象にする。
const findLeafForPdfFile = (file, preferredLeaf = null) => {
    if (preferredLeaf?.view?.file?.path === file?.path) return preferredLeaf;
    if (app.workspace.activeLeaf?.view?.file?.path === file?.path) return app.workspace.activeLeaf;
    let found = null;
    app.workspace.iterateAllLeaves?.((candidate) => {
        if (!found && candidate?.view?.file?.path === file?.path) found = candidate;
    });
    return found;
};

const prepareExcalidrawBackedMarkdownForPdfExport = async (targetFile = null, targetLeaf = null) => {
    const file = targetFile || app.workspace.getActiveFile?.();
    const leaf = findLeafForPdfFile(file, targetLeaf);
    if (!file || !leaf || !isExcalidrawBackedMarkdown(file) || file.name.toLowerCase().endsWith(".excalidraw.md")) {
        return;
    }

    // Obsidian標準PDFは現在のDOMではなく、後段で vault.cachedRead(file) した
    // Markdownを別ウィンドウへ再描画する。対象を記録して、その読み込み時に
    // Excalidraw埋め込みをPNGへ置き換える。
    window._customExcalidrawPdfCachedReadTarget = {
        file,
        expiresAt: Date.now() + 120000,
    };

    if (leaf.view?.getViewType?.() === "excalidraw") {
        if (typeof leaf.view?.setMarkdownView === "function") {
            await leaf.view.setMarkdownView();
        } else {
            const excalidrawPlugin = app.plugins?.plugins?.["obsidian-excalidraw-plugin"];
            if (typeof excalidrawPlugin?.setMarkdownView === "function") {
                await excalidrawPlugin.setMarkdownView(leaf);
            }
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
};

const installExcalidrawPdfCachedReadBridge = () => {
    const vault = app.vault;
    if (!vault || typeof vault.cachedRead !== "function") return;

    const previous = window._customExcalidrawPdfCachedReadBridge;
    if (previous?.vault === vault && previous.wrapped && vault.cachedRead === previous.wrapped) {
        return;
    }
    if (previous?.vault === vault && previous.original) {
        vault.cachedRead = previous.original;
    }

    const original = vault.cachedRead;
    const wrapped = async function(file, ...args) {
        const target = window._customExcalidrawPdfCachedReadTarget;
        const shouldTransform = target
            && target.expiresAt > Date.now()
            && target.file?.path === file?.path
            && isExcalidrawBackedMarkdown(file)
            && !window._customExcalidrawPdfCachedReadTransforming;

        const content = await original.apply(this, [file, ...args]);
        if (!shouldTransform) return content;

        window._customExcalidrawPdfCachedReadTransforming = true;
        try {
            const withoutInternalData = stripExcalidrawDataSectionForExport(content, file);
            // 標準PDF側のMarkdownRendererが解釈できるよう、HTMLのimg要素を返す。
            // これにより ![[りんご|75]] が自己ノート埋め込みとして再帰せず、
            // ExcalidrawのPNGだけが印刷対象になる。
            return await replaceExcalidrawEmbedsForHtmlExport(withoutInternalData, file);
        } catch (error) {
            console.error("Failed to prepare Excalidraw content for native PDF:", error);
            return content;
        } finally {
            window._customExcalidrawPdfCachedReadTransforming = false;
        }
    };

    vault.cachedRead = wrapped;
    window._customExcalidrawPdfCachedReadBridge = { vault, original, wrapped };
};

// file-menu の標準項目は command.callback を経由せず、メニュー項目に保持した
// コールバックを直接呼ぶ場合がある。その経路では上の command ラッパーが届かない
// ため、対象ファイルを紐付けたPDF項目だけをキャプチャし、Markdownビューへ戻して
// から同じ項目を再クリックする。
const installExcalidrawPdfMenuGuard = () => {
    if (window._customExcalidrawPdfMenuGuard) {
        document.removeEventListener("click", window._customExcalidrawPdfMenuGuard, true);
    }

    const guard = (event) => {
        if (window._customPdfMenuBypassClick) return;
        const item = event.target?.closest?.(".menu-item");
        const button = event.target?.closest?.("button");
        const isPdfMenuItem = item && /PDFにエクスポート/.test(item.textContent || "");
        const isPdfDialogButton = button && /^PDFにエクスポート$/.test((button.textContent || "").trim());
        if (!isPdfMenuItem && !isPdfDialogButton) return;

        const context = isPdfMenuItem ? window._customPdfMenuContexts?.get(item) : null;
        const file = context?.file || app.workspace.getActiveFile?.();
        if (!file || !isExcalidrawBackedMarkdown(file)) return;

        installExcalidrawPdfCachedReadBridge();
        window._customExcalidrawPdfCachedReadTarget = { file, expiresAt: Date.now() + 120000 };

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        window._customPdfMenuBypassClick = true;
        Promise.resolve()
            .then(async () => {
                const targetLeaf = findLeafForPdfFile(file, context?.leaf);
                if (targetLeaf && app.workspace.activeLeaf !== targetLeaf) {
                    await app.workspace.setActiveLeaf?.(targetLeaf, true);
                    await new Promise(resolve => setTimeout(resolve, 80));
                }
                await prepareExcalidrawBackedMarkdownForPdfExport(file, targetLeaf);
                await new Promise(resolve => setTimeout(resolve, 180));
                (isPdfMenuItem ? item : button).click();
            })
            .catch((error) => {
                console.error("Excalidraw-backed Markdown PDF export failed:", error);
                new Notice(`PDF出力の準備に失敗しました: ${error?.message || error}`);
            })
            .finally(() => {
                setTimeout(() => { window._customPdfMenuBypassClick = false; }, 0);
            });
    };

    window._customExcalidrawPdfMenuGuard = guard;
    document.addEventListener("click", guard, true);
};

const ensureExcalidrawDataPrintStyle = () => {
    if (typeof document === "undefined" || typeof document.getElementById !== "function") return;
    if (document.getElementById("custom-excalidraw-data-print-style")) return;
    const style = document.createElement("style");
    style.id = "custom-excalidraw-data-print-style";
    style.textContent = `
@media print {
    .markdown-preview-view h1[data-heading="Excalidraw Data"] ~ *,
    .markdown-preview-view h1[data-heading="Excalidraw"] ~ *,
    .markdown-preview-view h1[data-heading="Excalidraw Data"],
    .markdown-preview-view h1[data-heading="Excalidraw"] {
        display: none !important;
    }
}`;
    document.head.appendChild(style);
};

const installExcalidrawPdfExportGuard = () => {
    const previous = window._customExcalidrawPdfExportGuard;
    if (previous?.command && previous.originalCallback) {
        previous.command.callback = previous.originalCallback;
    }
    delete window._customExcalidrawPdfExportGuard;

    const commands = app.commands?.commands || {};
    const entry = Object.entries(commands).find(([id, command]) =>
        /(?:^|:)export-pdf$/i.test(id) && typeof command?.callback === "function"
    );
    if (!entry) return;

    const [id, command] = entry;
    const originalCallback = command.callback;
    command.callback = async function(...args) {
        await prepareExcalidrawBackedMarkdownForPdfExport();
        return originalCallback.apply(this, args);
    };
    window._customExcalidrawPdfExportGuard = { id, command, originalCallback };
};

// UIや他プラグインが command.callback を直接参照せず、executeCommandById を
// 経由してPDF出力する場合にも、出力直前のMarkdownビュー切り替えを保証する。
const installExcalidrawExecuteCommandPdfGuard = () => {
    const commandsApi = app.commands;
    if (!commandsApi || typeof commandsApi.executeCommandById !== "function") return;

    const previous = window._customExcalidrawExecuteCommandPdfGuard;
    if (previous?.api === commandsApi && previous.wrapped && commandsApi.executeCommandById === previous.wrapped) {
        return;
    }

    const original = previous?.api === commandsApi && previous.original
        ? previous.original
        : commandsApi.executeCommandById;
    const wrapped = async function(commandId, ...args) {
        if (/(?:^|:)export-pdf$/i.test(String(commandId))) {
            await prepareExcalidrawBackedMarkdownForPdfExport();
        }
        return original.apply(this, [commandId, ...args]);
    };
    commandsApi.executeCommandById = wrapped;
    window._customExcalidrawExecuteCommandPdfGuard = { api: commandsApi, original, wrapped };
};

ensureExcalidrawDataPrintStyle();
installExcalidrawPdfCachedReadBridge();
installExcalidrawPdfMenuGuard();
installExcalidrawPdfExportGuard();
installExcalidrawExecuteCommandPdfGuard();
// Templaterの起動タイミングによってコマンド登録が後になる場合に備えて再確認する。
[500, 1500, 3000, 5000, 8000].forEach((delay) => {
    setTimeout(() => {
        installExcalidrawPdfExportGuard();
        installExcalidrawExecuteCommandPdfGuard();
    }, delay);
});
console.log("PDF export code block background & path clipboard option registered");

// Remove existing listener to prevent duplicates
if (window._customBaseFileSearchListener) {
    document.removeEventListener("keydown", window._customBaseFileSearchListener, true);
    window._customBaseFileSearchListener = null;
}
