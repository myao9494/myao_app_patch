// =============================================================================
// Excalidraw / MarkMind 編集中のコマンド抑止と、Deleteキーによるノート削除
// =============================================================================

/**
 * Excalidraw編集中にObsidianのコマンドが優先実行されるのを防ぐ
 * 
 * 方針: DOMイベントの stopPropagation ではなく、Obsidianのコマンドコールバック自体を
 * モンキーパッチして Excalidraw 編集中は実行しないようにする。
 * こうすることでキーイベントは正常に Excalidraw まで伝播し、
 * Excalidraw のショートカットが確実に動作する。
 **/
const isExcalidrawActive = () => {
    const activeFile = app.workspace.getActiveFile();
    if (activeFile && activeFile.name.endsWith(".excalidraw.md")) return true;
    const activeLeaf = app.workspace.activeLeaf;
    if (activeLeaf?.view?.getViewType?.() === "excalidraw") return true;
    return false;
};

/**
 * MarkMind (マインドマップ) がアクティブかどうかを判定する
 **/
const isMarkMindActive = () => {
    const activeLeaf = app.workspace.activeLeaf;
    if (activeLeaf?.view?.getViewType?.() === "mindmapview") return true;
    const activeEl = document.activeElement;
    if (activeEl && (
        activeEl.closest(".mindmapview") ||
        activeEl.closest(".markmind-container") ||
        activeEl.closest(".cm-mindmap-container") ||
        activeEl.closest(".cm-mindmap") ||
        activeEl.closest("[data-type='mindmapview']")
    )) return true;
    return false;
};

/**
 * CAD Viewer 内の要素（注記・寸法バッジなど）にフォーカスがあるかどうかを判定する
 * CAD Viewer は選択中の注記・寸法を Delete / Backspace で削除するため、
 * グローバルの Delete（ノート削除）を発動させず、キー操作をビューア側へ渡す。
 **/
const isCadViewerFocused = () => {
    const activeEl = document.activeElement;
    return Boolean(activeEl?.closest?.(".step-viewer-embed, [data-type='step-viewer-view']"));
};

const patchCommandForExcalidraw = (commandId) => {
    const cmd = app.commands.commands[commandId];
    if (!cmd || cmd._excalidrawPatched) return;

    const origCallback = cmd.callback;
    const origCheckCallback = cmd.checkCallback;
    const origEditorCallback = cmd.editorCallback;

    if (origCallback) {
        cmd.callback = () => {
            if (isExcalidrawActive() || isMarkMindActive()) return;
            return origCallback();
        };
    }
    if (origCheckCallback) {
        cmd.checkCallback = (checking) => {
            if (isExcalidrawActive() || isMarkMindActive()) return false;
            return origCheckCallback(checking);
        };
    }
    if (origEditorCallback) {
        cmd.editorCallback = (editor, view) => {
            if (isExcalidrawActive() || isMarkMindActive()) return;
            return origEditorCallback(editor, view);
        };
    }

    cmd._excalidrawPatched = true;
    console.log(`Patched command for Excalidraw: ${commandId}`);
};

// Excalidraw と競合する Obsidian コマンドをパッチする
const excalidrawConflictingCommands = [
    "workspace:previous-tab",       // Cmd+ArrowLeft
    "workspace:next-tab",           // Cmd+ArrowRight
    "file-explorer:delete-file",    // Delete
    "app:delete-file",              // Cmd+Delete
    "custom:delete-active-file",    // カスタム削除
    "custom:smart-focus-right",     // Cmd+Shift+ArrowRight
    "custom:smart-focus-left",      // Cmd+Shift+ArrowLeft
    "custom:rename-active-file",    // Cmd+R
];

// コマンドの登録完了を待ってからパッチを適用する
setTimeout(() => {
    excalidrawConflictingCommands.forEach(patchCommandForExcalidraw);
    console.log("Excalidraw command patches applied");
}, 500);

/**
 * サイドバーで押された Delete を、まずサイドバーの画面に処理させ、画面が処理しなかったときだけ
 * 開いているノートを削除する。
 * Sidebar Explorer（選択項目の削除）、タグの一覧（選択タグ・選択ファイルの削除）、Notebook Navigator などは
 * Delete を自前で処理する（処理したら preventDefault か伝播の停止をする）。先に横取りすると、選んだ項目ではなく
 * 開いているノートの削除になってしまう。一方 Sidebar Explorer はクリックでは項目を選択状態にしないため、
 * 画面が処理しなかったときは、従来どおり開いているノート（クリックして開いたファイル）を削除する。
 **/
const deleteActiveFileUnlessHandled = (event) => {
    const onBubble = (bubbled) => {
        window.removeEventListener("keydown", onBubble);
        if (bubbled !== event || bubbled.defaultPrevented) return;
        bubbled.preventDefault();
        app.commands.executeCommandById("custom:delete-active-file");
    };
    // window のバブリング段階は、サイドバーの画面の keydown より後に呼ばれる。
    window.addEventListener("keydown", onBubble);
    // 画面が伝播を止めた場合は onBubble が呼ばれないため、イベントの処理が終わったら待ち受けを外す。
    setTimeout(() => window.removeEventListener("keydown", onBubble), 0);
};

// Setup Global Key Listener for Delete
const handleDeleteKey = (e) => {
    // Intercept "Delete" (Fn+Backspace) ONLY. Removed "Backspace" support.
    if (e.key === "Delete") {
        // ExcalidrawまたはMarkMind編集中はDeleteキーをプラグイン側に渡す
        if (isExcalidrawActive() || isMarkMindActive()) return;
        // CAD Viewer で注記・寸法を選択中のDeleteキーは、ビューア側の削除処理へ渡す
        if (isCadViewerFocused()) return;
        // 1. Check if user is typing in an input
        const activeEl = document.activeElement;
        if (!activeEl) return;
        const isInput = activeEl.tagName === "INPUT" || 
                        activeEl.tagName === "TEXTAREA" || 
                        activeEl.isContentEditable;
        
        if (isInput) return; // Allow normal text deletion

        // Safety: Don't run in Modals (Settings, etc.) or Prompts
        if (activeEl.closest(".modal") || activeEl.closest(".prompt")) return;

        // Safety: Don't run in Tag Pane
        // Tag pane usually has data-type="tag" on the workspace leaf
        const leaf = activeEl.closest(".workspace-leaf");
        if (leaf && leaf.getAttribute("data-type") === "tag") return;

        // 2. ファイルエクスプローラーにフォーカスがある場合は発動しない
        //    （エクスプローラー側の Delete（選択項目の削除）と二重に動かさないため）
        if (activeEl.closest(".nav-files-container")) return;

        // 3. Ensure we have an active file
        const activeFile = app.workspace.getActiveFile();
        if (!activeFile) return;

        // 左右のサイドバーでは、その画面の Delete を先に動かす（後述の deleteActiveFileUnlessHandled）。
        if (activeEl.closest(".mod-left-split, .mod-right-split")) {
            deleteActiveFileUnlessHandled(e);
            return;
        }

        // 4. Perform the deletion command
        e.preventDefault();
        e.stopPropagation();
        app.commands.executeCommandById("custom:delete-active-file");
    }
};

registerDocumentListener("_customDeleteListener", "keydown", handleDeleteKey);
console.log("Global Delete key listener registered");
