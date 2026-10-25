// =============================================================================
// 画像のリネーム・容量縮小・移動（モーダル）と、Rキーのショートカット
// =============================================================================

// 入力欄のテキストを全選択する。
const selectAllInputText = (inputEl) => {
    if (!inputEl) return;
    inputEl.select();
    if (typeof inputEl.setSelectionRange === "function" && inputEl.value) {
        inputEl.setSelectionRange(0, inputEl.value.length);
    }
};

/**
 * リネーム入力欄を、モーダルを開いたショートカットキー（r）の余波入力から守る。
 * - 開いてから0.6秒間は、r の keydown / keypress / beforeinput を入力欄へ通さない。
 * - その間に値が "r" または空に化けた場合は、元のファイル名へ戻して onRestore に通知する。
 * - フォーカス時と最初のクリック時は、テキストを全選択する。
 * getInitialValue: 元のファイル名（拡張子なし）を返す関数。
 **/
const guardRenameInputFromShortcutKey = (inputEl, getInitialValue, onRestore) => {
    let isShortcutResidualBlocked = true;
    let isFirstClick = true;

    const selectAll = () => selectAllInputText(inputEl);

    inputEl.addEventListener("focus", () => {
        selectAll();
    });
    inputEl.addEventListener("click", () => {
        if (isFirstClick) {
            selectAll();
            isFirstClick = false;
        }
    });

    // IME（日本語入力）開始時
    inputEl.addEventListener("compositionstart", () => {
        // IME開始時も、ショートカットキー単体での汚染を許容しないためガードは即時解除しない
    });

    // 直接文字入力（beforeinput）: ショートカットキー（r）の余波をブロック
    inputEl.addEventListener("beforeinput", (e) => {
        if (isShortcutResidualBlocked && e.data && e.data.toLowerCase() === "r") {
            if (typeof e.preventDefault === "function") e.preventDefault();
            if (typeof e.stopPropagation === "function") e.stopPropagation();
            selectAll();
            return;
        }
    });

    // キープレス時: ショートカットキー（r）の余波をブロック
    inputEl.addEventListener("keypress", (e) => {
        if (isShortcutResidualBlocked && e.key && e.key.toLowerCase() === "r") {
            if (typeof e.preventDefault === "function") e.preventDefault();
            if (typeof e.stopPropagation === "function") e.stopPropagation();
            selectAll();
        }
    });

    // キー入力時: ショートカットキー（r）の余波をブロック
    inputEl.addEventListener("keydown", (e) => {
        if (isShortcutResidualBlocked && e.key && e.key.toLowerCase() === "r" && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (typeof e.preventDefault === "function") e.preventDefault();
            if (typeof e.stopPropagation === "function") e.stopPropagation();
            selectAll();
            return;
        }
    });

    // 入力値変更時: もしショートカット余波ガード期間中に値が "r" または空文字に化けた場合、
    // 即座に元の初期値（例: IMG_0710）に復元して全選択する
    inputEl.addEventListener("input", () => {
        if (isShortcutResidualBlocked) {
            const val = inputEl.value;
            if (val === "r" || val === "R" || !val) {
                const initialValue = getInitialValue();
                inputEl.value = initialValue;
                onRestore(initialValue);
                selectAll();
                return;
            }
        }
    });

    setTimeout(() => {
        isShortcutResidualBlocked = false;
    }, 600);
};

// ドラッグ後のモーダル位置を、画面内（端から margin 以上内側）に収める。
const clampModalPosition = (position, modalSize, viewportSize, margin) => {
    const maxLeft = Math.max(margin, viewportSize.width - modalSize.width - margin);
    const maxTop = Math.max(margin, viewportSize.height - modalSize.height - margin);
    return {
        left: Math.max(margin, Math.min(position.left, maxLeft)),
        top: Math.max(margin, Math.min(position.top, maxTop)),
    };
};

/**
 * モーダルを、タイトル（h2）をつかんでドラッグ移動できるようにする。
 * 背景の暗転も薄くして、後ろのノートや画像を見ながら操作できるようにする。
 * - tooltip: タイトルに表示する説明
 * - margin: 画面端から空ける幅（px）
 * - fallbackWidth / fallbackHeight: 画面サイズを取得できないときに使う値
 **/
const makeModalDraggableByTitle = (modal, { tooltip, margin = 0, fallbackWidth = 0, fallbackHeight = 0 }) => {
    const modalEl = modal.modalEl || modal.contentEl?.closest?.(".modal");
    const titleEl = modal.contentEl?.querySelector?.("h2");
    if (!modalEl || !titleEl) return;

    titleEl.style.cursor = "grab";
    titleEl.style.userSelect = "none";
    titleEl.title = tooltip;

    const modalBg = modalEl.parentElement?.querySelector?.(".modal-bg");
    if (modalBg) {
        modalBg.style.opacity = "0.2";
    }

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    const onMouseDown = (e) => {
        if (e.button !== 0) return;
        if (e.target.tagName === "INPUT" || e.target.tagName === "BUTTON") return;

        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;

        const rect = modalEl.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

        modalEl.style.position = "fixed";
        modalEl.style.left = `${initialLeft}px`;
        modalEl.style.top = `${initialTop}px`;
        modalEl.style.margin = "0";
        modalEl.style.transform = "none";

        titleEl.style.cursor = "grabbing";
        document.body.style.userSelect = "none";

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
        e.preventDefault();
    };

    const onMouseMove = (e) => {
        if (!isDragging) return;

        const position = clampModalPosition(
            { left: initialLeft + (e.clientX - startX), top: initialTop + (e.clientY - startY) },
            { width: modalEl.offsetWidth, height: modalEl.offsetHeight },
            { width: window.innerWidth || fallbackWidth, height: window.innerHeight || fallbackHeight },
            margin,
        );

        modalEl.style.left = `${position.left}px`;
        modalEl.style.top = `${position.top}px`;
    };

    const onMouseUp = () => {
        if (!isDragging) return;
        isDragging = false;
        titleEl.style.cursor = "grab";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
    };

    titleEl.addEventListener("mousedown", onMouseDown);
};

/**
 * 画像リネーム用のモーダルダイアログ
 * - 拡張子は表示せず、ベース名（元のファイル名）をデフォルト入力値として設定
 * - ユーザーがファイル名をそのまま利用して編集（末尾への追加や変更）できるようにする
 * - ダイアログ表示時に入力ボックスのテキストを全選択
 * - 保存時に元の拡張子を再結合してリネーム実行
 **/
class ImageRenameModal extends Modal {
    constructor(app, file, title = "画像のリネーム") {
        super(app);
        this.file = file;
        this.title = title;
        this.extension = "";
        this.baseName = "";
        this.parseFileName(file.name);
    }

    parseFileName(fileName) {
        const parts = splitFileNameForRename(fileName);
        this.extension = parts.extension;
        this.baseName = parts.baseName;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("rename-modal");

        contentEl.createEl("h2", { text: this.title });

        let newName = this.baseName;
        let textInputEl = null;

        new Setting(contentEl)
            .setName("新しいファイル名")
            .addText((text) => {
                textInputEl = text.inputEl;
                text
                    .setValue(this.baseName)
                    .onChange((value) => {
                        newName = value;
                    });

                // ショートカット起動キー（r）自身の余波入力が届いた場合に元のファイル名を保護するガード
                guardRenameInputFromShortcutKey(textInputEl, () => this.baseName, (restoredName) => {
                    newName = restoredName;
                });
            });

        const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
        
        const saveButton = buttonContainer.createEl("button", { text: "保存", cls: "mod-cta" });
        saveButton.addEventListener("click", async () => {
            await this.renameFile(newName);
        });

        const cancelButton = buttonContainer.createEl("button", { text: "キャンセル" });
        cancelButton.style.setProperty("color", "#111111", "important");
        cancelButton.style.setProperty("-webkit-text-fill-color", "#111111", "important");
        cancelButton.addEventListener("click", () => {
            this.close();
        });

        // Enterキーで保存
        contentEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                if (e.isComposing) return; // IME変換中のリターンキーを無視
                e.preventDefault();
                this.renameFile(newName);
            }
        });

        // Inputにフォーカスし全選択 & ドラッグ移動のセットアップ
        const triggerFocusAndSelect = () => {
            if (textInputEl) {
                textInputEl.focus();
                selectAllInputText(textInputEl);
            }
        };

        setTimeout(() => {
            this.setupDraggableModal();
            triggerFocusAndSelect();
        }, 80);
        setTimeout(triggerFocusAndSelect, 180);
    }

    setupDraggableModal() {
        makeModalDraggableByTitle(this, {
            tooltip: "ドラッグして移動（画像を見ながら名前を入力できます）",
            margin: 10,
            fallbackWidth: 1000,
            fallbackHeight: 800,
        });
    }

    async renameFile(newName) {
        if (!newName) {
            new Notice("ファイル名を入力してください");
            return;
        }
        
        const newPath = (this.file.parent ? this.file.parent.path + "/" : "") + newName + this.extension;
        
        try {
            const oldPath = this.file.path;

            // 共通画像フォルダ内で同名ファイルにリネームしようとしている場合、上書きマージする
            const isCommonImageDir = this.file.parent && this.file.parent.path === "01_data/common_image";
            if (isCommonImageDir) {
                const existingFile = app.vault.getAbstractFileByPath(newPath);
                if (existingFile && existingFile.path !== oldPath) {
                    const overwriteConfirmed = window.confirm(`既に共通画像フォルダに同名ファイル "${newName}${this.extension}" が存在します。\n上書きしてよろしいですか？（リンクはマージされます）`);
                    if (!overwriteConfirmed) {
                        return;
                    }
                    await app.vault.trash(existingFile, true);
                }
            }

            await app.fileManager.renameFile(this.file, newPath);
            
            // リネームに成功した場合、マークダウンプレビュー側の選択状態のパスも更新する
            if (window._selectedMarkdownImageFilePath === oldPath) {
                window._selectedMarkdownImageFilePath = newPath;
            }
            
            new Notice(`Renamed to ${newName}${this.extension}`);
            this.close();
        } catch (error) {
            new Notice(`Error: ${error.message}`);
            console.error(error);
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// Sidebar Explorer が呼ぶ Obsidian 標準の promptForFileRename を、
// 複合拡張子に対応したこのモーダルへ接続する。
window._customPromptForFileRename = (file) => {
    if (!file) return;
    new ImageRenameModal(app, file, "ファイル名").open();
};

// Sidebar Explorer以外（標準ファイルエクスプローラー等）からのRenameも同じ処理に統一する。
if (!window._customPromptForFileRenameOriginal && typeof app.fileManager?.promptForFileRename === "function") {
    window._customPromptForFileRenameOriginal = app.fileManager.promptForFileRename.bind(app.fileManager);
    app.fileManager.promptForFileRename = (file) => {
        if (typeof window._customPromptForFileRename === "function") {
            return window._customPromptForFileRename(file);
        }
        return window._customPromptForFileRenameOriginal(file);
    };
}

/**
 * 画像用リネームモーダルを開くヘルパー関数
 **/
const openImageRenameModal = (file) => {
    new ImageRenameModal(app, file, "ファイル名").open();
};

// 画像のURLを <img> 要素として読み込む。
const loadImageFromUrl = async (imageUrl) => {
    const img = new Image();
    img.decoding = "async";
    await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = imageUrl;
    });
    return img;
};

// 縮小後の辺の長さ（最小 32px）。
const scaleImageDimension = (size, scale) => Math.max(32, Math.round(size * scale));

// キャンバスを指定サイズにして画像を描く。透過を持てない形式（JPEG）は、先に白で塗る。
const drawImageToCanvas = (canvas, ctx, img, width, height, fillWhite) => {
    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    if (fillWhite) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(img, 0, 0, width, height);
};

/**
 * JPEG / WebP: 解像度を大きい順に試し、品質を二分探索（0.15〜0.92）して、目標以下で最も高品質な結果を返す。
 * 目標以下になる解像度が見つかった時点で、それより小さい解像度は試さない。見つからなければ null。
 **/
const searchJpegOrWebpWithinTarget = async ({ canvas, ctx, img, origW, origH, mimeType, targetBytes }) => {
    // スケール候補（解像度低下を抑えつつ品質とのバランスを取る）
    const scales = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2];
    for (const s of scales) {
        const targetW = scaleImageDimension(origW, s);
        const targetH = scaleImageDimension(origH, s);
        drawImageToCanvas(canvas, ctx, img, targetW, targetH, mimeType === "image/jpeg");

        // 品質を二分探索 (0.15 〜 0.92)
        let lowQ = 0.15;
        let highQ = 0.92;
        let best = null;

        for (let iter = 0; iter < 6; iter++) {
            const midQ = (lowQ + highQ) / 2;
            const blob = await new Promise(res => canvas.toBlob(res, mimeType, midQ));
            if (!blob) break;

            if (blob.size <= targetBytes) {
                best = { blob, width: targetW, height: targetH };
                lowQ = midQ; // より高品質を試す
            } else {
                highQ = midQ;
            }
        }

        // 目標サイズ以下が見つかった場合はそれ以上の解像度縮小は行わない
        if (best) return best;
    }
    return null;
};

// PNG など（可逆圧縮）: 解像度だけを二分探索して、目標以下で最も大きい結果を返す。見つからなければ null。
const searchPngScaleWithinTarget = async ({ canvas, ctx, img, origW, origH, mimeType, targetBytes }) => {
    let lowScale = 0.05;
    let highScale = 1.0;
    let best = null;

    for (let iter = 0; iter < 8; iter++) {
        const midScale = (lowScale + highScale) / 2;
        const targetW = scaleImageDimension(origW, midScale);
        const targetH = scaleImageDimension(origH, midScale);
        drawImageToCanvas(canvas, ctx, img, targetW, targetH, false);

        const blob = await new Promise(res => canvas.toBlob(res, mimeType));
        if (!blob) break;

        if (blob.size <= targetBytes) {
            best = { blob, width: targetW, height: targetH };
            lowScale = midScale; // より高い解像度を試す
        } else {
            highScale = midScale;
        }
    }
    return best;
};

// フォールバック: 目標が極小で一度も達成できなかった場合に、最小サイズ（10%）の結果を生成する。
const compressImageToMinimumSize = async ({ canvas, ctx, img, origW, origH, mimeType }, isJpegOrWebp) => {
    const minScale = 0.1;
    const targetW = scaleImageDimension(origW, minScale);
    const targetH = scaleImageDimension(origH, minScale);
    drawImageToCanvas(canvas, ctx, img, targetW, targetH, mimeType === "image/jpeg");
    const blob = await new Promise(res => canvas.toBlob(res, mimeType, isJpegOrWebp ? 0.2 : undefined));
    return { blob, width: targetW, height: targetH };
};

/**
 * 画像ファイルを指定された容量（targetBytes）以下に圧縮する
 * 
 * 仕様:
 * - JPEG/WebP は品質（quality）および解像度（scale）を調整して目標サイズ以下にする
 * - PNG は解像度（scale）を調整して目標サイズ以下にする
 * - 透過情報を維持し、破損を防ぐ
 * - 探索により目標バイト数以下となる最も高品質な Blob を生成する
 **/
const compressImageBlobToTarget = async (file, targetBytes) => {
    const arrayBuffer = await app.vault.readBinary(file);
    const mimeType = getMimeTypeForFile(file);
    const originalBlob = new Blob([arrayBuffer], { type: mimeType });

    const imageUrl = URL.createObjectURL(originalBlob);
    try {
        const img = await loadImageFromUrl(imageUrl);

        const origW = img.naturalWidth || img.width;
        const origH = img.naturalHeight || img.height;
        const origBytes = arrayBuffer.byteLength;

        // 既に目標サイズ以下の場合はそのまま利用
        if (origBytes <= targetBytes) {
            const previewUrl = URL.createObjectURL(originalBlob);
            return {
                blob: originalBlob,
                arrayBuffer,
                width: origW,
                height: origH,
                actualBytes: origBytes,
                reductionPercent: 0,
                previewUrl,
            };
        }

        const isJpegOrWebp = mimeType === "image/jpeg" || mimeType === "image/webp";
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        const source = { canvas, ctx, img, origW, origH, mimeType, targetBytes };

        let best = isJpegOrWebp
            ? await searchJpegOrWebpWithinTarget(source)
            : await searchPngScaleWithinTarget(source);
        let bestBytes = best ? best.blob.size : Infinity;

        if (!best) {
            best = await compressImageToMinimumSize(source, isJpegOrWebp);
            bestBytes = best.blob?.size || origBytes;
        }

        const outBuffer = await best.blob.arrayBuffer();
        const reductionPercent = Math.max(0, Math.round((1 - bestBytes / origBytes) * 1000) / 10);
        const previewUrl = URL.createObjectURL(best.blob);

        return {
            blob: best.blob,
            arrayBuffer: outBuffer,
            width: best.width,
            height: best.height,
            actualBytes: bestBytes,
            reductionPercent,
            previewUrl,
        };
    } finally {
        URL.revokeObjectURL(imageUrl);
    }
};

// 容量（KB）の表示用文字列。1024KB 以上は MB も併記する。
const formatKilobytes = (kb) => (
    kb >= 1024 ? `${(kb / 1024).toFixed(2)} MB (${kb.toLocaleString()} KB)` : `${kb.toLocaleString()} KB`
);

/**
 * 画像容量縮小確認モーダル
 * 
 * 仕様:
 * - 指定したサイズ（KB）になるよう画像を縮小
 * - 縮小前後の容量・解像度・削減率を表示
 * - 縮小後の画像をプレビュー表示してユーザーに確認を促す
 * - タイトルバーをドラッグして画面内を自由に移動可能（背後の画像を確認可能）
 * - 「置き換える」ボタンで元画像ファイルを縮小後の画像データで上書き保存し、画面表示を最新化
 **/
class ImageCompressModal extends Modal {
    constructor(app, file) {
        super(app);
        this.file = file;
        this.originalSize = file.stat?.size || 0;
        // 初期目標容量: 元容量の約50%、または 300KB
        const halfKB = Math.round(this.originalSize / 1024 / 2);
        this.targetKB = Math.max(50, Math.min(2000, halfKB || 300));
        this.currentResult = null;
        this.originalObjectUrl = null;
        this.previewObjectUrl = null;
        this.updateTimeout = null;
        this.viewMode = "compressed"; // "compressed" | "original" | "side-by-side"
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("custom-image-compress-modal");

        // タイトルバー
        const titleEl = contentEl.createEl("h2", { text: "画像の容量を縮小" });
        titleEl.style.margin = "0 0 10px 0";

        this.applyModalLayout(contentEl);

        // ファイル情報・目標容量入力コンテナ
        const controlsContainer = contentEl.createDiv({ cls: "compress-controls-container" });
        controlsContainer.style.display = "flex";
        controlsContainer.style.flexDirection = "column";
        controlsContainer.style.gap = "8px";
        controlsContainer.style.marginBottom = "8px";

        this.renderFileInfoRow(controlsContainer);
        this.renderTargetSizeRow(controlsContainer);
        this.renderResultAndModeRow(controlsContainer);
        this.renderPreviewArea(contentEl);
        this.renderActionButtons(contentEl);

        // 元画像Blobのロード＆ドラッグ移動のセットアップ
        setTimeout(async () => {
            this.setupDraggableModal();
            try {
                const origBuffer = await app.vault.readBinary(this.file);
                const mimeType = getMimeTypeForFile(this.file);
                const origBlob = new Blob([origBuffer], { type: mimeType });
                this.originalObjectUrl = URL.createObjectURL(origBlob);
            } catch (err) {
                console.warn("Failed to load original image blob:", err);
            }
            this.debounceUpdate();
        }, 50);
    }

    // モーダル全体スタイル（全画面の3/4の大きさ）
    applyModalLayout(contentEl) {
        const modalEl = this.modalEl || contentEl.closest(".modal");
        if (modalEl) {
            modalEl.style.width = "75vw";
            modalEl.style.maxWidth = "85vw";
            modalEl.style.height = "75vh";
            modalEl.style.maxHeight = "85vh";
            modalEl.style.display = "flex";
            modalEl.style.flexDirection = "column";
        }

        contentEl.style.display = "flex";
        contentEl.style.flexDirection = "column";
        contentEl.style.height = "100%";
        contentEl.style.boxSizing = "border-box";
        contentEl.style.overflow = "hidden";
    }

    // 基本情報表示（ファイル名と元の容量）
    renderFileInfoRow(controlsContainer) {
        const origKB = Math.round(this.originalSize / 1024);
        const origSizeText = formatKilobytes(origKB);
        
        const infoRow = controlsContainer.createDiv({ cls: "compress-info-row" });
        infoRow.style.display = "flex";
        infoRow.style.justifyContent = "space-between";
        infoRow.style.fontSize = "0.9em";
        infoRow.style.padding = "6px 12px";
        infoRow.style.backgroundColor = "var(--background-secondary)";
        infoRow.style.borderRadius = "6px";

        infoRow.createDiv({ text: `ファイル名: ${this.file.name}` });
        this.origInfoEl = infoRow.createDiv({ text: `元の容量: ${origSizeText}`, cls: "mod-warning" });
    }

    // 目標容量設定行（入力欄とプリセットボタン）
    renderTargetSizeRow(controlsContainer) {
        const targetRow = controlsContainer.createDiv();
        targetRow.style.display = "flex";
        targetRow.style.alignItems = "center";
        targetRow.style.flexWrap = "wrap";
        targetRow.style.gap = "10px";

        const targetLabel = targetRow.createEl("label", { text: "目標容量 (KB):" });
        targetLabel.style.fontWeight = "bold";

        const targetInput = targetRow.createEl("input", { type: "number" });
        targetInput.value = this.targetKB;
        targetInput.min = "10";
        targetInput.max = "10000";
        targetInput.step = "50";
        targetInput.style.width = "100px";
        targetInput.style.padding = "4px 8px";

        targetInput.addEventListener("input", (e) => {
            const val = parseInt(e.target.value, 10);
            if (val > 0) {
                this.targetKB = val;
                this.debounceUpdate();
            }
        });

        // プリセットボタン
        const presetContainer = targetRow.createDiv();
        presetContainer.style.display = "flex";
        presetContainer.style.gap = "6px";

        const presets = [100, 200, 300, 500, 1000];
        presets.forEach(kb => {
            const btn = presetContainer.createEl("button", {
                text: kb >= 1000 ? "1 MB" : `${kb} KB`,
            });
            btn.style.fontSize = "0.8em";
            btn.style.padding = "2px 8px";
            btn.addEventListener("click", () => {
                this.targetKB = kb;
                targetInput.value = kb;
                this.debounceUpdate();
            });
        });
    }

    // 圧縮結果情報行 ＆ 表示切替タブ行
    renderResultAndModeRow(controlsContainer) {
        const resultAndModeRow = controlsContainer.createDiv();
        resultAndModeRow.style.display = "flex";
        resultAndModeRow.style.justifyContent = "space-between";
        resultAndModeRow.style.alignItems = "center";
        resultAndModeRow.style.flexWrap = "wrap";
        resultAndModeRow.style.gap = "8px";

        this.resultInfoEl = resultAndModeRow.createDiv({ cls: "compress-result-info" });
        this.resultInfoEl.style.flex = "1";
        this.resultInfoEl.style.padding = "6px 12px";
        this.resultInfoEl.style.backgroundColor = "var(--background-secondary-alt)";
        this.resultInfoEl.style.borderRadius = "6px";
        this.resultInfoEl.style.fontSize = "0.9em";
        this.resultInfoEl.textContent = "圧縮を計算中...";

        // 比較表示モード切替ボタン群
        const modeBtnContainer = resultAndModeRow.createDiv({ cls: "compress-mode-buttons" });
        modeBtnContainer.style.display = "flex";
        modeBtnContainer.style.gap = "4px";

        this.modeButtons = {};
        const modeList = [
            { id: "compressed", label: "縮小後プレビュー" },
            { id: "original", label: "元画像" },
            { id: "side-by-side", label: "左右並べて比較" },
        ];

        modeList.forEach(m => {
            const btn = modeBtnContainer.createEl("button", { text: m.label });
            btn.style.fontSize = "0.8em";
            btn.style.padding = "4px 8px";
            if (m.id === this.viewMode) {
                btn.addClass("mod-cta");
            }
            btn.addEventListener("click", () => {
                this.setViewMode(m.id);
            });
            this.modeButtons[m.id] = btn;
        });
    }

    // プレビューコンテナ（モーダル拡大に合わせて大きく表示）
    renderPreviewArea(contentEl) {
        this.previewWrapper = contentEl.createDiv({ cls: "compress-preview-wrapper" });
        this.previewWrapper.style.flex = "1";
        this.previewWrapper.style.minHeight = "0";
        this.previewWrapper.style.border = "1px solid var(--background-modifier-border)";
        this.previewWrapper.style.borderRadius = "8px";
        this.previewWrapper.style.padding = "10px";
        this.previewWrapper.style.backgroundColor = "var(--background-primary-alt)";
        this.previewWrapper.style.display = "flex";
        this.previewWrapper.style.justifyContent = "center";
        this.previewWrapper.style.alignItems = "center";
        this.previewWrapper.style.overflow = "auto";
        this.previewWrapper.style.marginBottom = "10px";

        this.loadingText = this.previewWrapper.createDiv({ text: "画像を圧縮・プレビュー生成中..." });
        this.loadingText.style.color = "var(--text-muted)";
    }

    // 下部ボタングループ（置き換える / キャンセル）
    renderActionButtons(contentEl) {
        const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
        buttonContainer.style.display = "flex";
        buttonContainer.style.justifyContent = "flex-end";
        buttonContainer.style.gap = "10px";
        buttonContainer.style.marginTop = "auto";

        this.applyButton = buttonContainer.createEl("button", { text: "置き換える", cls: "mod-cta" });
        this.applyButton.disabled = true;
        this.applyButton.addEventListener("click", async () => {
            await this.applyReplacement();
        });

        const cancelButton = buttonContainer.createEl("button", { text: "キャンセル" });
        cancelButton.style.setProperty("color", "#111111", "important");
        cancelButton.style.setProperty("-webkit-text-fill-color", "#111111", "important");
        cancelButton.addEventListener("click", () => {
            this.close();
        });
    }

    setViewMode(mode) {
        this.viewMode = mode;
        Object.entries(this.modeButtons || {}).forEach(([id, btn]) => {
            if (id === mode) {
                btn.addClass("mod-cta");
            } else {
                btn.removeClass("mod-cta");
            }
        });
        this.renderPreviewView();
    }

    renderPreviewView() {
        if (!this.previewWrapper) return;
        this.previewWrapper.empty();

        if (!this.currentResult) {
            this.previewWrapper.appendChild(this.loadingText);
            return;
        }

        const origUrl = this.originalObjectUrl || this.currentResult.previewUrl;
        const compUrl = this.currentResult.previewUrl;

        if (this.viewMode === "side-by-side") {
            // 左右並べて比較
            this.previewWrapper.style.flexDirection = "row";
            this.previewWrapper.style.gap = "12px";

            // 左側: 元画像
            this.renderComparisonColumn(`【元画像】 ${Math.round(this.originalSize / 1024)} KB`, origUrl, null);

            // 右側: 縮小後
            const resKB = Math.round(this.currentResult.actualBytes / 1024);
            this.renderComparisonColumn(
                `【縮小後】 ${resKB} KB (-${this.currentResult.reductionPercent}%)`, compUrl, "var(--text-success)",
            );
        } else {
            // 単一画像表示（全幅・全高）
            this.previewWrapper.style.flexDirection = "column";

            const displayUrl = this.viewMode === "original" ? origUrl : compUrl;
            const singleImg = this.previewWrapper.createEl("img");
            singleImg.src = displayUrl;
            singleImg.style.maxWidth = "100%";
            singleImg.style.maxHeight = "100%";
            singleImg.style.objectFit = "contain";
        }
    }

    // 左右比較の1列（見出しと画像）を描画する。
    renderComparisonColumn(headerText, imageUrl, headerColor) {
        const column = this.previewWrapper.createDiv();
        column.style.flex = "1";
        column.style.height = "100%";
        column.style.display = "flex";
        column.style.flexDirection = "column";
        column.style.alignItems = "center";
        column.style.minWidth = "0";

        const header = column.createDiv({ text: headerText });
        header.style.fontSize = "0.85em";
        header.style.fontWeight = "bold";
        if (headerColor) header.style.color = headerColor;
        header.style.marginBottom = "4px";

        const img = column.createEl("img");
        img.src = imageUrl;
        img.style.maxWidth = "100%";
        img.style.maxHeight = "calc(100% - 24px)";
        img.style.objectFit = "contain";
        img.style.border = "1px solid var(--background-modifier-border)";
        img.style.borderRadius = "4px";
    }

    debounceUpdate() {
        if (this.updateTimeout) clearTimeout(this.updateTimeout);
        if (this.loadingText) {
            this.loadingText.style.display = "block";
            this.loadingText.textContent = `目標 ${this.targetKB} KB に向けて圧縮中...`;
        }
        if (this.applyButton) {
            this.applyButton.disabled = true;
        }

        this.updateTimeout = setTimeout(() => {
            this.runCompression();
        }, 250);
    }

    async runCompression() {
        try {
            const targetBytes = this.targetKB * 1024;
            const res = await compressImageBlobToTarget(this.file, targetBytes);

            if (this.previewObjectUrl) {
                URL.revokeObjectURL(this.previewObjectUrl);
            }

            this.currentResult = res;
            this.previewObjectUrl = res.previewUrl;
            this.applyButton.disabled = false;

            const resKB = Math.round(res.actualBytes / 1024);
            const resSizeText = formatKilobytes(resKB);

            this.resultInfoEl.innerHTML = `
                <div><strong>縮小後:</strong> ${resSizeText} (解像度: ${res.width} × ${res.height} px)</div>
                <div style="color: var(--text-success); font-weight: bold;">削減率: -${res.reductionPercent}%</div>
            `;

            this.renderPreviewView();
        } catch (error) {
            console.error("画像の圧縮に失敗しました:", error);
            if (this.previewWrapper) {
                this.previewWrapper.empty();
                this.previewWrapper.createDiv({ text: "画像の圧縮に失敗しました。別の目標容量をお試しください。" });
            }
            this.applyButton.disabled = true;
        }
    }

    async applyReplacement() {
        if (!this.currentResult?.arrayBuffer) return;

        try {
            this.applyButton.disabled = true;
            this.applyButton.textContent = "置き換え中...";

            await app.vault.modifyBinary(this.file, this.currentResult.arrayBuffer);
            await refreshImageDisplays(this.file);

            const origKB = Math.round(this.originalSize / 1024);
            const newKB = Math.round(this.currentResult.actualBytes / 1024);
            new Notice(`画像を縮小して置き換えました: ${origKB}KB → ${newKB}KB (-${this.currentResult.reductionPercent}%)`);

            this.close();
        } catch (error) {
            console.error("画像の置き換え保存に失敗しました:", error);
            new Notice("画像の置き換え保存に失敗しました。");
            this.applyButton.disabled = false;
            this.applyButton.textContent = "置き換える";
        }
    }

    setupDraggableModal() {
        makeModalDraggableByTitle(this, {
            tooltip: "ドラッグして移動（背後の画像やノートを確認できます）",
        });
    }

    onClose() {
        if (this.originalObjectUrl) {
            URL.revokeObjectURL(this.originalObjectUrl);
            this.originalObjectUrl = null;
        }
        if (this.previewObjectUrl) {
            URL.revokeObjectURL(this.previewObjectUrl);
            this.previewObjectUrl = null;
        }
        if (this.updateTimeout) {
            clearTimeout(this.updateTimeout);
            this.updateTimeout = null;
        }
        const { contentEl } = this;
        contentEl.empty();
    }
}

/**
 * 画像容量縮小モーダルを開くヘルパー関数
 **/
const openImageCompressModal = (file) => {
    if (!file) return;
    new ImageCompressModal(app, file).open();
};

/**
 * 画像ファイルを共通画像フォルダ（01_data/common_image）へ移動する
 * - ユーザーに最終確認を行う
 * - 移動先フォルダがない場合は自動作成
 * - app.fileManager.renameFile を使って移動（リンクも自動修正）
 **/
const moveToCommonImage = async (file) => {
    if (!file) return;

    const targetDir = "01_data/common_image";
    const newPath = `${targetDir}/${file.name}`;

    const confirmed = window.confirm(`本当に画像 "${file.name}" を共通画像フォルダへ移動しますか？\nこの画像を参照しているリンクも自動的に修正されます。`);
    if (!confirmed) return;

    try {
        // 移動先フォルダが存在しない場合は作成
        const folder = app.vault.getAbstractFileByPath(targetDir);
        if (!folder) {
            await app.vault.createFolder(targetDir);
        }

        const oldPath = file.path;

        // 同名ファイルが移動先にすでに存在するかチェックし、上書きマージする
        const existingFile = app.vault.getAbstractFileByPath(newPath);
        if (existingFile) {
            const overwriteConfirmed = window.confirm(`既に共通画像フォルダに同名ファイル "${file.name}" が存在します。\n上書きしてよろしいですか？（リンクはマージされます）`);
            if (!overwriteConfirmed) {
                return;
            }
            await app.vault.trash(existingFile, true);
        }

        await app.fileManager.renameFile(file, newPath);

        // プレビュー選択中画像パスの同期
        if (window._selectedMarkdownImageFilePath === oldPath) {
            window._selectedMarkdownImageFilePath = newPath;
        }

        new Notice(`"${file.name}" を共通画像フォルダへ移動しました（リンク自動更新）`);
    } catch (error) {
        new Notice(`移動エラー: ${error.message}`);
        console.error(error);
    }
};

/**
 * ファイルを今日のフォルダ（01_data/YYYY/MM/DD）へ移動する
 * - すでに同じ親フォルダにあるかチェック
 * - 移動先フォルダがない場合は自動作成
 * - 同名ファイルが移動先にすでに存在するかチェックし、上書きマージする
 * - app.fileManager.renameFile を使って移動（リンクも自動修正）
 **/
const moveToTodayFolder = async (file) => {
    if (!file) return;

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const targetDir = `01_data/${yyyy}/${mm}/${dd}`;
    const newPath = `${targetDir}/${file.name}`;

    if (file.parent && file.parent.path === targetDir) {
        new Notice("このファイルは既に今日のフォルダにあります");
        return;
    }

    try {
        // 移動先フォルダが存在しない場合は作成
        const folder = app.vault.getAbstractFileByPath(targetDir);
        if (!folder) {
            await app.vault.createFolder(targetDir);
        }

        const oldPath = file.path;

        // 同名ファイルが移動先にすでに存在するかチェックし、上書きマージする
        const existingFile = app.vault.getAbstractFileByPath(newPath);
        if (existingFile) {
            const overwriteConfirmed = window.confirm(`既に今日のフォルダに同名ファイル "${file.name}" が存在します。\n上書きしてよろしいですか？（リンクはマージされます）`);
            if (!overwriteConfirmed) {
                return;
            }
            await app.vault.trash(existingFile, true);
        }

        await app.fileManager.renameFile(file, newPath);

        // プレビュー選択中画像パスの同期
        if (window._selectedMarkdownImageFilePath === oldPath) {
            window._selectedMarkdownImageFilePath = newPath;
        }

        new Notice(`"${file.name}" を今日のフォルダへ移動しました（リンク自動更新）`);
    } catch (error) {
        new Notice(`移動エラー: ${error.message}`);
        console.error(error);
    }
};

/**
 * 指定されたメニュー項目を "Rename" (または "名前を変更") 項目の直後に移動する。
 * "Rename" 項目が存在しない場合は、最上部に配置 (prepend) する。
 **/
const insertAfterRenameOrPrepend = (menu, targetItemText) => {
    const menuEl = menu.menuEl || menu.dom || document.querySelector(".menu");
    if (!menuEl) {
        console.log(`Menu element not found for '${targetItemText}'`);
        return;
    }

    const items = Array.from(menuEl.querySelectorAll(".menu-item"));
    const myItem = items.find(el => el.textContent.includes(targetItemText));
    if (!myItem) {
        console.log(`Target item '${targetItemText}' not found in menu items`);
        return;
    }

    const renameItem = items.find(el => el.textContent.includes("Rename") || el.textContent.includes("名前を変更"));
    if (renameItem) {
        renameItem.parentNode.insertBefore(myItem, renameItem.nextSibling);
        console.log(`Moved '${targetItemText}' after Rename`);
    } else {
        menuEl.prepend(myItem);
        console.log(`Moved '${targetItemText}' to top (Rename not found)`);
    }
};

const handleMarkdownImageRenameKey = (e) => {
    // IMEや自動入力が発行する keydown には key が無いものがあるため、存在を確認してから判定する。
    if (e.key?.toLowerCase() !== "r" || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;

    const activeEl = document.activeElement;
    if (activeEl?.closest?.(".modal, .prompt")) return;

    // INPUT や TEXTAREA などの真の入力フィールドにフォーカスがある場合は常にスキップ
    if (activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA")) return;

    // Excalidraw編集中の場合はショートカットを無効化
    const activeFile = app.workspace.getActiveFile();
    if (activeFile && activeFile.name.endsWith(".excalidraw.md")) return;

    const activeView = app.workspace.getActiveViewOfType(obsidianLib?.View || window?.obsidian?.View);
    if (activeView && activeView.getViewType() === "excalidraw") return;

    let file = null;

    if (activeFile && isImageFile(activeFile)) {
        if (isTypingTarget(activeEl)) return;
        file = activeFile;
    } else {
        // マークダウン上で画像が選択されているかチェック
        const selectedPath = window._selectedMarkdownImageFilePath;
        // 画像の選択は、別の画面へ移っても残る。選んだ画像が画面から消えたときと、その画像のノート以外
        // （マインドマップのノード、サイドバーの入力欄など）で文字を入力しているときは、r をそのまま入力させる。
        const selectedEl = window._selectedMarkdownImageEl;
        const selectedView = selectedEl?.closest?.(".markdown-preview-view, .markdown-source-view");
        const isStaleSelection = Boolean(selectedEl) && (
            selectedEl.isConnected === false ||
            (isTypingTarget(activeEl) && !selectedView?.contains?.(activeEl))
        );
        if (isStaleSelection) return;
        if (selectedPath) {
            file = app.vault.getAbstractFileByPath(selectedPath);
        } else {
            // 画像が選択されていない通常のエディタ編集中の場合は、通常のrキー入力を妨げない
            if (isTypingTarget(activeEl)) return;
        }
    }

    if (!file?.path) return;

    // ショートカットキー自身のイベントを完全消費
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === "function") {
        e.stopImmediatePropagation();
    }

    // エディタ（CodeMirror 6等）へのr文字挿入を完全阻止するため、即座にフォーカスを解除
    if (activeEl && typeof activeEl.blur === "function") {
        activeEl.blur();
    }
    const sel = window.getSelection?.();
    if (sel && typeof sel.removeAllRanges === "function") {
        sel.removeAllRanges();
    }

    // キーストローク完了（keyup）または遅延タイマーで安全にモーダルを開く
    // これによりキー押下中の余波テキストイベントが入力欄やエディタに吸い込まれるのを100%防止する
    let opened = false;

    function cleanupListeners() {
        if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
            document.removeEventListener("keyup", onKeyUp, true);
            document.removeEventListener("beforeinput", onBeforeInput, true);
        }
    }

    function triggerOpen() {
        if (opened) return;
        opened = true;
        cleanupListeners();
        openImageRenameModal(file);
    }

    function onKeyUp(upEvent) {
        if (upEvent.key && upEvent.key.toLowerCase() === "r") {
            if (typeof upEvent.preventDefault === "function") upEvent.preventDefault();
            if (typeof upEvent.stopPropagation === "function") upEvent.stopPropagation();
            triggerOpen();
        }
    }

    function onBeforeInput(inputEvent) {
        if (inputEvent.data && inputEvent.data.toLowerCase() === "r") {
            if (typeof inputEvent.preventDefault === "function") inputEvent.preventDefault();
            if (typeof inputEvent.stopPropagation === "function") inputEvent.stopPropagation();
        }
    }

    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
        document.addEventListener("keyup", onKeyUp, true);
        document.addEventListener("beforeinput", onBeforeInput, true);

        setTimeout(() => {
            triggerOpen();
        }, 120);
    } else {
        triggerOpen();
    }
};

// 登録順がそのまま document（キャプチャ段階）での実行順になるため、順序を変えないこと。
registerDocumentListener("_customMarkdownImageClickListener", "click", handleMarkdownImageClick);
registerDocumentListener("_customMarkdownImageDblClickListener", "dblclick", handleMarkdownImageDblClick);
registerDocumentListener("_customMarkdownImageMouseDownListener", "mousedown", handleMarkdownImageMouseDown);
registerDocumentListener("_customExcalidrawPointerDownListener", "pointerdown", blockExcalidrawPointerDown);
registerDocumentListener("_customExcalidrawMouseDownListener", "mousedown", blockExcalidrawRightButtonEdit);
registerDocumentListener(
    "_customExcalidrawRightButtonEndListener", ["pointerup", "mouseup", "auxclick"], blockExcalidrawRightButtonEdit,
);
registerDocumentListener("_customMarkdownImageContextMenuListener", "contextmenu", handleMarkdownImageContextMenu);
registerDocumentListener(
    "_customMarkdownAttachmentContextMenuListener", "contextmenu", handleMarkdownAttachmentContextMenu,
);
registerDocumentListener("_customMarkdownImageRenameListener", "keydown", handleMarkdownImageRenameKey);
registerDocumentListener("_customLinkModifierClickListener", ["mousedown", "click"], handleLinkModifierClick);
console.log("Markdown image rename shortcut registered");

// 図の埋め込みラベルは、拡張子を除いた図の名前だけを表示する。
if (window._customFigureEmbedLabelObserver) {
    window._customFigureEmbedLabelObserver.disconnect();
}
if (window._customFigureEmbedLabelTimer) {
    globalThis.clearTimeout(window._customFigureEmbedLabelTimer);
    window._customFigureEmbedLabelTimer = null;
}
if (window._customFigureEmbedResizeObserver) {
    window._customFigureEmbedResizeObserver.disconnect();
}
window._customFigureEmbedResizeObserver = null;
// スクリプトを再実行した場合、表示中の図に残っているリサイズハンドルは前回の実行時の処理に結び付いている。
// 取り除いておき、下の applyFigureEmbedDisplayNames で今回の処理に結び付いたハンドルを付け直す。
if (typeof document !== "undefined" && typeof document.querySelectorAll === "function") {
    Array.from(document.querySelectorAll(".custom-image-resizer-handle, .custom-pdf-resizer-handle") || []).forEach((handle) => handle.remove());
}
if (typeof ResizeObserver === "function") {
    window._customFigureEmbedResizeObserver = new ResizeObserver((entries) => {
        entries.forEach((entry) => {
            const target = entry.target.closest?.(
                ".excalidraw-svg[data-figure-name], .media-embed[data-figure-name], " +
                ".internal-embed[data-figure-name], .markdown-embed[data-figure-name]",
            );
            if (target) updateFigureEmbedWidth(target);
        });
    });
}
applyFigureEmbedDisplayNames();
if (typeof MutationObserver !== "undefined" && document.body) {
    window._customFigureEmbedLabelObserver = new MutationObserver((mutations) => {
        if (!mutations.some(isFigureRelevantMutation)) return;
        if (window._customFigureEmbedLabelTimer) {
            globalThis.clearTimeout(window._customFigureEmbedLabelTimer);
        }
        window._customFigureEmbedLabelTimer = globalThis.setTimeout(() => {
            window._customFigureEmbedLabelTimer = null;
            applyFigureEmbedDisplayNames();
        }, 50);
    });
    window._customFigureEmbedLabelObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: FIGURE_OBSERVER_ATTRIBUTE_FILTER,
    });

    // Excalidrawが非同期で画像を生成するため、生成直後にも幅を再計測する。
    [0, 50, 250, 800].forEach((delay) => {
        globalThis.setTimeout(() => applyFigureEmbedDisplayNames(), delay);
    });
}

// Excalidraw 図のファイルが変更されたら（Web アプリでの編集を含む）、ノート内の埋め込みを描き直す。
registerVaultEvent("_customExcalidrawEmbedModifyListener", "modify", handleExcalidrawFileModify);
