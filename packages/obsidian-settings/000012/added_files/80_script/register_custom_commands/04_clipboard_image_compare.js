// =============================================================================
// クリップボード画像との比較・差し替え、表示中の画像の更新
// =============================================================================

const getClipboardImageBlob = async () => {
    if (!navigator.clipboard?.read) {
        new Notice("Clipboard image read is not available.");
        return null;
    }

    try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
            const imageType = item.types.find((type) => type.startsWith("image/"));
            if (imageType) return await item.getType(imageType);
        }
    } catch (error) {
        console.error("Failed to read clipboard image:", error);
        new Notice("Failed to read clipboard image.");
        return null;
    }

    new Notice("Clipboard does not contain an image.");
    return null;
};

const assertImageDiffApiReady = async () => {
    try {
        const response = await fetch(`${IMAGE_DIFF_API_BASE_URL}/health`);
        if (response.ok) return true;
        new Notice(`Image diff API is not ready (${response.status}).`);
    } catch (error) {
        console.error("Image diff API health check failed:", error);
        new Notice("Image diff API is not running.");
    }
    return false;
};

const getClipboardFilename = (blob) => {
    const extensionByMime = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
        "image/bmp": "bmp",
        "image/svg+xml": "svg",
        "image/tiff": "tiff",
    };
    return `clipboard.${extensionByMime[blob.type] || "png"}`;
};

const getMimeTypeForFile = (file) => {
    const mimeByExtension = {
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
    return mimeByExtension[file.extension.toLowerCase()] || "application/octet-stream";
};

const getApiErrorMessage = async (response) => {
    try {
        const body = await response.json();
        return `${response.status} ${body.detail || response.statusText}`;
    } catch {
        return `${response.status} ${response.statusText}`;
    }
};

const canvasConvertibleMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

const convertClipboardBlobForFile = async (blob, file) => {
    const targetMimeType = getMimeTypeForFile(file);
    if (!canvasConvertibleMimeTypes.has(targetMimeType)) {
        return blob;
    }
    if (blob.type === targetMimeType) {
        return blob;
    }

    const imageUrl = URL.createObjectURL(blob);
    try {
        const image = new Image();
        image.decoding = "async";
        const loaded = new Promise((resolve, reject) => {
            image.onload = resolve;
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

        const convertedBlob = await new Promise((resolve) => canvas.toBlob(resolve, targetMimeType, 0.95));
        return convertedBlob || blob;
    } catch (error) {
        console.warn("Failed to convert clipboard image. Using original blob.", error);
        return blob;
    } finally {
        URL.revokeObjectURL(imageUrl);
    }
};

const getImageElementFile = (imgEl) => {
    try {
        return getFileFromImageElement(imgEl);
    } catch {
        return null;
    }
};

const refreshImageElement = (imgEl) => {
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
};

const refreshImageDisplays = async (file) => {
    document.querySelectorAll("img").forEach((imgEl) => {
        const imageFile = getImageElementFile(imgEl);
        if (imageFile?.path === file.path) {
            refreshImageElement(imgEl);
        }
    });

    const leavesToReload = [];
    app.workspace.iterateAllLeaves?.((leaf) => {
        if (leaf?.view?.file?.path === file.path) {
            leavesToReload.push(leaf);
        }
    });

    for (const leaf of leavesToReload) {
        try {
            await leaf.openFile(file);
        } catch (error) {
            console.warn("Failed to reload image leaf.", error);
        }
    }
};

const compareWithClipboardImage = async (file) => {
    const clipboardBlob = await getClipboardImageBlob();
    if (!clipboardBlob) return;
    if (!(await assertImageDiffApiReady())) return;

    try {
        const selectedBytes = await app.vault.readBinary(file);
        const selectedBlob = new Blob([selectedBytes], { type: getMimeTypeForFile(file) });
        const formData = new FormData();
        formData.append("file_a", selectedBlob, file.name);
        formData.append("file_b", clipboardBlob, getClipboardFilename(clipboardBlob));
        formData.append("category", "汎用");
        formData.append("diff_threshold", "0.1");

        const response = await fetch(`${IMAGE_DIFF_API_BASE_URL}/diff`, { method: "POST", body: formData });
        if (!response.ok) {
            new Notice(`Image diff failed: ${await getApiErrorMessage(response)}`);
            return;
        }

        const result = await response.json();
        const resultUrl = new URL(IMAGE_DIFF_APP_BASE_URL);
        if (result.result_id) resultUrl.searchParams.set("result_id", result.result_id);
        window.open(resultUrl.toString(), "_blank");
        new Notice("Opened image diff.");
    } catch (error) {
        console.error("Failed to compare clipboard image:", error);
        new Notice("Failed to compare clipboard image.");
    }
};

const replaceWithClipboardImage = async (file) => {
    const clipboardBlob = await getClipboardImageBlob();
    if (!clipboardBlob) return;

    if (!window.confirm(`本当に "${file.name}" をクリップボードの画像で差し替えますか?`)) return;

    try {
        const replacementBlob = await convertClipboardBlobForFile(clipboardBlob, file);
        await app.vault.modifyBinary(file, await replacementBlob.arrayBuffer());
        await refreshImageDisplays(file);
        new Notice(`Replaced "${file.name}" with clipboard image.`);
    } catch (error) {
        console.error("Failed to replace image with clipboard image:", error);
        new Notice("Failed to replace image.");
    }
};
