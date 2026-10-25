// =============================================================================
// ファイルメニュー（file-menu）
// =============================================================================

// Add File Menu Item for Excalidraw
const handleFileMenu = (menu, file, source, leaf) => {
    if (!file?.name) return;

    const obsidianLib = getObsidianModule();

    if (file && obsidianLib && file instanceof obsidianLib.TFile) {
        menu.addItem((item) => {
            item
                .setTitle("今日のフォルダに移動")
                .setIcon("folder")
                .onClick(() => moveToTodayFolder(file));
        });

        reorderMenuItemsLater(menu, 120, { afterRename: ["今日のフォルダに移動"] });
    }

    if (file.name.endsWith(".excalidraw.md")) {
        addCopyImageAsPngMenuItem(menu, file);
        menu.addItem((item) => {
            item
                .setTitle("Webアプリで開く")
                .setIcon("globe")
                .onClick(() => {
                    const url = getEncodedExcalidrawUrl(file);
                    window.open(url, "_blank");
                });
        });

        // Move the added item to the top
        // Finding the item by text content is more robust than lastElementChild
        reorderMenuItemsLater(menu, 50, { prepend: [
            "Webアプリで開く",
            "画像をクリップボードにコピー",
        ] });
    }

    if (isExcalidrawBackedMarkdown(file) && !file.name.toLowerCase().endsWith(".excalidraw.md")) {
        menu.addItem((item) => {
            item
                .setTitle("Webアプリで編集")
                .setIcon("globe")
                .onClick(() => {
                    const url = getEncodedExcalidrawUrl(file);
                    window.open(url, "_blank");
                });
        });

        reorderMenuItemsLater(menu, 50, { prepend: ["Webアプリで編集"] });
    }

    if (file.extension === "md" && !file.name.endsWith(".excalidraw.md")) {
        menu.addItem((item) => {
            item
                .setTitle("フォルダを開く")
                .setIcon("folder")
                .onClick(() => openContainingFolder(file));
        });

        menu.addItem((item) => {
            item
                .setTitle("VS Codeで開く")
                .setIcon("code")
                .onClick(() => openInVsCode(file));
        });

        menu.addItem((item) => {
            item
                .setTitle("ganttに追加")
                .setIcon("calendar-plus")
                .onClick(() => addNoteToGantt(file));
        });

        menu.addItem((item) => {
            item
                .setTitle("差分を表示")
                .setIcon("git-compare")
                .onClick(() => openMarkdownDiff(file));
        });

        menu.addItem((item) => {
            item
                .setTitle("HTMLで出力(AIコンテキスト用)")
                .setIcon("html")
                .onClick(() => exportHtml(file, "ai"));
        });

        menu.addItem((item) => {
            item
                .setTitle("HTMLで出力(人間用)")
                .setIcon("layout-template")
                .onClick(() => exportHtml(file, "human"));
        });

        menu.addItem((item) => {
            item
                .setTitle("PDFで出力(人間用)")
                .setIcon("file-text")
                .onClick(() => exportPdf(file));
        });

        menu.addItem((item) => {
            item
                .setTitle("サマリーを作成")
                .setIcon("document")
                .onClick(() => createSummary(file));
        });

        reorderMenuItemsLater(menu, 100, {
            afterRename: [
                "差分を表示",
                "ganttに追加",
                "サマリーを作成",
                "PDFで出力(人間用)",
                "HTMLで出力(人間用)",
                "HTMLで出力(AIコンテキスト用)",
                "VS Codeで開く",
                "フォルダを開く",
            ],
        });

        setTimeout(() => {
            // タブの右クリックメニューにあるObsidian標準のPDF項目は、
            // Excalidraw-backed Markdownでも同じ見た目で表示されるため、
            // クリック直前に対象タブをMarkdownビューへ戻せるよう紐付ける。
            if (menu.dom && isExcalidrawBackedMarkdown(file)) {
                const pdfItem = Array.from(menu.dom.querySelectorAll(".menu-item"))
                    .find((el) => /PDFにエクスポート/.test(el.textContent || ""));
                if (pdfItem) {
                    window._customPdfMenuContexts ||= new WeakMap();
                    window._customPdfMenuContexts.set(pdfItem, { file, leaf });
                }
            }
        }, 100);
    }

    // メール、Office 文書、PDF 等の添付ファイルを、ファイルエクスプローラー上で
    // 差し替え前に単体削除できるようにする。画像と drawio は下の専用メニューで
    // 同じ削除機能を提供しているため、ここでは重複して追加しない。
    if (isNonMarkdownAttachmentFile(file) && !isImageFile(file) && !isDrawioEditableFile(file)) {
        menu.addItem((item) => {
            item
                .setTitle("添付ファイルを削除")
                .setIcon("trash")
                .setWarning(true)
                .onClick(() => deleteAttachmentFile(file));
        });

        reorderMenuItemsLater(menu, 50, { prepend: ["添付ファイルを削除"] });
    }

    if (isImageFile(file) || isDrawioEditableFile(file)) {
        // 「保管庫からのパスをコピー」メニュー項目を追加
        menu.addItem((item) => {
            item
                .setTitle("保管庫からのパスをコピー")
                .setIcon("link")
                .onClick(async () => {
                    await navigator.clipboard.writeText(file.path);
                    new Notice("保管庫からのパスをコピーしました");
                });
        });

        addClipboardImageMenuItems(menu, file);

        reorderMenuItemsLater(menu, 50, { prepend: [
            "削除",
            "クリップボードの画像と差し替え",
            "クリップボードの画像との比較",
            "共通画像フォルダへ移動",
            "画像の容量を縮小",
            "drawioで編集",
            "保管庫からのパスをコピー",
            "画像をクリップボードにコピー",
        ] });
    }
};

registerWorkspaceEvent("_customFileMenuListener", "file-menu", withNativeMenuReorder(handleFileMenu));
console.log("File menu listener registered for Excalidraw (Absolute Path)");
