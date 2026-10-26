// =============================================================================
// 画像のクリップボードコピーと、画像向けメニュー項目
// =============================================================================

const dataUrlToBlob = async (dataUrl) => {
    const response = await fetch(dataUrl);
    return await response.blob();
};

const rasterImageFileToPngBlob = async (file) => {
    if (file.name.toLowerCase().endsWith(".excalidraw.md")) {
        const imageData = await renderExcalidrawFileToPngDataUrl(file);
        if (!imageData?.src) throw new Error("ExcalidrawのPNG生成結果が空です。");
        return await dataUrlToBlob(imageData.src);
    }

    if (file.extension.toLowerCase() === "svg") {
        const result = await rasterizeSvgFileToPngDataUrl(file.path);
        if (!result?.pngDataUrl) throw new Error("SVGのPNG変換に失敗しました。");
        return await dataUrlToBlob(result.pngDataUrl);
    }

    const bytes = await app.vault.readBinary(file);
    const sourceBlob = new Blob([bytes], { type: getMimeTypeForFile(file) });
    const imageUrl = URL.createObjectURL(sourceBlob);
    try {
        const image = new Image();
        image.decoding = "async";
        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = reject;
            image.src = imageUrl;
        });
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvasを初期化できません。");
        context.drawImage(image, 0, 0);
        const pngBlob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
        if (!pngBlob) throw new Error("PNG Blobを生成できません。");
        return pngBlob;
    } finally {
        URL.revokeObjectURL(imageUrl);
    }
};

const copyImageAsPngToClipboard = async (file) => {
    try {
        if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
            throw new Error("画像のクリップボード書き込みに対応していません。");
        }
        const pngBlob = await rasterImageFileToPngBlob(file);
        await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
        new Notice("画像をPNGとしてクリップボードにコピーしました");
    } catch (error) {
        console.error("Failed to copy image as PNG:", error);
        new Notice(`画像のコピーに失敗しました: ${error?.message || error}`);
    }
};

const addCopyImageAsPngMenuItem = (menu, file) => {
    menu.addItem((item) => {
        item
            .setTitle("画像をクリップボードにコピー")
            .setIcon("copy")
            .onClick(() => copyImageAsPngToClipboard(file));
    });
};

const addClipboardImageMenuItems = (menu, file, sourceFile = null) => {
    addCopyImageAsPngMenuItem(menu, file);
    if (isExcalidrawBackedMarkdown(file)) {
        menu.addItem((item) => {
            item
                .setTitle("Webアプリで編集")
                .setIcon("globe")
                .onClick(() => window.open(getEncodedExcalidrawUrl(file), "_blank"));
        });
        return;
    }
    menu.addItem((item) => {
        item
            .setTitle("画像の容量を縮小")
            .setIcon("minimize-2")
            .onClick(() => openImageCompressModal(file));
    });
    menu.addItem((item) => {
        item
            .setTitle("削除")
            .setIcon("trash")
            .setWarning(true)
            .onClick(() => deleteImageFile(file, sourceFile));
    });
    menu.addItem((item) => {
        item
            .setTitle("共通画像フォルダへ移動")
            .setIcon("folder")
            .onClick(() => moveToCommonImage(file));
    });
    menu.addItem((item) => {
        item
            .setTitle("クリップボードの画像との比較")
            .setIcon("image")
            .onClick(() => compareWithClipboardImage(file));
    });
    menu.addItem((item) => {
        item
            .setTitle("クリップボードの画像と差し替え")
            .setIcon("replace")
            .setWarning(true)
            .onClick(() => replaceWithClipboardImage(file));
    });
    if (isDrawioEditableFile(file)) {
        menu.addItem((item) => {
            item
                .setTitle("drawioで編集")
                .setIcon("shapes")
                .onClick(() => {
                    app.workspace.trigger("drawio:edit-diagram", file);
                });
        });
    }
    if (isDrawioConvertibleFile(file)) {
        menu.addItem((item) => {
            item
                .setTitle("Excalidrawに変換")
                .setIcon("pen-tool")
                .onClick(() => convertDrawioFileToExcalidraw(file, sourceFile));
        });
    }
};
