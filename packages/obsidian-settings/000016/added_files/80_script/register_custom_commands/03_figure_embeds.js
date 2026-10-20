// =============================================================================
// 図の埋め込み（キャプション、幅の追従、右下ドラッグのリサイズ、DOM監視の判定）
// =============================================================================

const FIGURE_EMBED_EXTENSIONS = /\.(?:png|jpe?g|gif|bmp|svg|webp|avif|tiff?|ico|excalidraw(?:\.md)?|drawio(?:\.svg)?|dio(?:\.svg)?)(?:[|#].*)?$/i;

const cleanFigureEmbedSource = (source) => String(source || "").split("|")[0].split("#")[0].trim();

const getExcalidrawBackedFileFromSource = (source, sourcePath = "") => {
    const cleanSource = cleanFigureEmbedSource(source);
    if (!cleanSource) return null;

    const linkCandidates = Array.from(new Set([
        cleanSource,
        cleanSource.replace(/\.md$/i, ""),
    ].filter(Boolean)));
    for (const candidate of linkCandidates) {
        try {
            const file = app.metadataCache?.getFirstLinkpathDest?.(candidate, sourcePath || "");
            if (file && isExcalidrawBackedMarkdown(file)) return file;
        } catch {
            // 解決できないリンクは、通常の画像・リンクとして扱う。
        }
    }
    return null;
};

const isFigureEmbedSource = (source, sourcePath = "") => {
    const cleanSource = cleanFigureEmbedSource(source);
    return FIGURE_EMBED_EXTENSIONS.test(cleanSource)
        || Boolean(getExcalidrawBackedFileFromSource(cleanSource, sourcePath));
};

const isExcalidrawEmbedSource = (source, sourcePath = "") => {
    const cleanSource = cleanFigureEmbedSource(source);
    return /\.excalidraw(?:\.md)?$/i.test(cleanSource)
        || Boolean(getExcalidrawBackedFileFromSource(cleanSource, sourcePath));
};

const getFigureEmbedDisplayName = (source, sourcePath = "") => {
    const resolvedFile = getExcalidrawBackedFileFromSource(source, sourcePath);
    let value = cleanFigureEmbedSource(source);
    if (resolvedFile?.name) {
        value = resolvedFile.name;
    }
    try {
        value = decodeURIComponent(value);
    } catch {
        // URIエンコードされていないVaultパスは、そのまま扱う。
    }

    const fileName = value.replace(/\\/g, "/").split("/").pop() || value;
    return fileName.replace(
        /\.(?:excalidraw\.md|excalidraw|drawio\.svg|dio\.svg|drawio|dio|png|jpe?g|gif|bmp|svg|webp|avif|tiff?|ico|md)$/i,
        "",
    );
};

const getFigureEmbedSourcePath = (element) => {
    const markdownLeaves = app.workspace.getLeavesOfType?.("markdown") || [];
    const ownerView = markdownLeaves
        .map((leaf) => leaf?.view)
        .find((view) => view?.containerEl?.contains?.(element));
    return ownerView?.file?.path || app.workspace.getActiveFile?.()?.path || "";
};

const getFigureEmbedSource = (element, sourcePath = getFigureEmbedSourcePath(element)) => {
    if (!element) return "";
    for (const attribute of ["src", "fileSource", "data-excalidraw-source", "data-src", "data-path"]) {
        const value = element.getAttribute?.(attribute);
        if (value && isFigureEmbedSource(value, sourcePath)) return value;
    }
    // Reading viewのExcalidrawは外枠からsrcが消えるため、生成画像のfileSourceを参照する。
    const sourceElement = element.querySelector?.("[filesource], [fileSource]");
    if (sourceElement && sourceElement !== element) {
        for (const attribute of ["fileSource", "src", "data-src", "data-path"]) {
            const value = sourceElement.getAttribute?.(attribute);
            if (value && isFigureEmbedSource(value, sourcePath)) return value;
        }
    }
    return "";
};

const getFigureEmbedLabelTarget = (element) => {
    if (!element) return null;
    if (element.matches?.(".excalidraw-embedded-img, [fileSource]")) {
        // Excalidrawは画像本体と外枠の両方に `.excalidraw-svg` を付ける。
        // 画像本体ではなく、必ず一段外側をキャプションの親にする。
        return element.parentElement?.closest?.(
            ".excalidraw-svg, .media-embed, .internal-embed, .markdown-embed",
        )
            || element.parentElement
            || element;
    }
    return element;
};

/**
 * 正規表現の一致のうち、hintOffset（本文中の文字オフセット）を含む、または最も近いものを返す
 * 同じファイルを複数回埋め込んだノートで、操作した埋め込みのリンクを選ぶために使う。
 * hintOffset 未指定時は先頭の一致を返す。
 **/
const pickEmbedMatchNearOffset = (matches, hintOffset) => {
    if (!matches.length) return null;
    if (typeof hintOffset !== "number" || !Number.isFinite(hintOffset)) return matches[0];
    const containing = matches.find((match) =>
        hintOffset >= match.index && hintOffset <= match.index + match[0].length,
    );
    if (containing) return containing;
    return matches.reduce((best, match) =>
        Math.abs(match.index - hintOffset) < Math.abs(best.index - hintOffset) ? match : best,
    );
};

/**
 * Markdown本文内で、特定の画像埋め込みのサイズ指定を書き換える編集位置を求める
 * - Wikilink（![[名前]] / ![[名前|サイズ]]、拡張子省略名を含む）を優先し、
 *   見つからない場合のみ標準Markdown記法（![alt](path)）を対象にする。
 * - 同じ画像が複数回埋め込まれている場合は、hintOffset（本文中の文字オフセット）を含む、
 *   または最も近い埋め込みを対象にする。hintOffset 未指定時は先頭の埋め込みを対象にする。
 * @param {string} content Markdown本文テキスト
 * @param {string} imageName 対象の画像ファイル名（またはパス）
 * @param {number|null} newWidth 新しい幅（px）。null または 0 の場合はサイズ指定を削除してリセット
 * @param {number|null} [hintOffset] 対象の埋め込みが書かれている本文中の文字オフセット
 * @returns {{from: number, to: number, text: string}|null} 置換範囲と置換後のテキスト
 **/
const findMarkdownImageSizeEdit = (content, imageName, newWidth, hintOffset = null) => {
    if (!content || !imageName) return null;

    // ファイル名の正規化とエスケープ
    const cleanName = imageName.split("|")[0].split("#")[0].trim();
    const baseName = cleanName.substring(cleanName.lastIndexOf("/") + 1);
    if (!baseName) return null;

    // 候補リスト（例: "自分用のobsidianに関して.excalidraw.md" -> ["自分用のobsidianに関して.excalidraw.md", "自分用のobsidianに関して.excalidraw", "自分用のobsidianに関して"]）
    // "自分用のobsidianに関して.md" -> ["自分用のobsidianに関して.md", "自分用のobsidianに関して"]
    const nameCandidates = [baseName];
    if (baseName.endsWith(".excalidraw.md")) {
        nameCandidates.push(baseName.slice(0, -".excalidraw.md".length));
        nameCandidates.push(baseName.slice(0, -".md".length));
    } else if (baseName.endsWith(".excalidraw")) {
        nameCandidates.push(baseName.slice(0, -".excalidraw".length));
    } else if (baseName.endsWith(".md")) {
        nameCandidates.push(baseName.slice(0, -".md".length));
    }
    const toPattern = (names) => Array.from(new Set(names.filter(Boolean)))
        .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|");

    const hasWidth = Boolean(newWidth) && Number(newWidth) > 0;
    const width = hasWidth ? Math.round(Number(newWidth)) : 0;

    const pickMatch = (matches) => pickEmbedMatchNearOffset(matches, hintOffset);

    // ![[パス/画像名.png]] または ![[画像名.png|200]] または ![[パス/画像名.png|200x100]] にマッチ
    const wikilinkRegex = new RegExp(
        `(!\\[\\[(?:[^\\]|#]*\\/)?(?:${toPattern(nameCandidates)})(?:#[^\\]|]*)?)(?:\\|([^\\]]*))?(\\]\\])`,
        "g",
    );
    const wikilink = pickMatch(Array.from(content.matchAll(wikilinkRegex)));
    if (wikilink) {
        const [, prefix, , suffix] = wikilink;
        return {
            from: wikilink.index,
            to: wikilink.index + wikilink[0].length,
            text: hasWidth ? `${prefix}|${width}${suffix}` : `${prefix}${suffix}`,
        };
    }

    // Wikilinkで見つからなかった場合、標準Markdown画像リンク: ![alt|200](path) または ![alt](path)
    // 標準記法のパスは空白などがパーセントエンコードされていることがあるため、その表記も候補に含める。
    const encodedCandidates = nameCandidates.map((name) => {
        try {
            return encodeURI(name);
        } catch {
            return name;
        }
    });
    const mdLinkRegex = new RegExp(
        `!\\[([^\\]]*)\\]\\(((?:[^)]*\\/)?(?:${toPattern([...nameCandidates, ...encodedCandidates])})(?:\\?[^)]*)?)\\)`,
        "g",
    );
    const mdLink = pickMatch(Array.from(content.matchAll(mdLinkRegex)));
    if (!mdLink) return null;

    const [, alt, url] = mdLink;
    const cleanAlt = alt.split("|")[0].trim();
    return {
        from: mdLink.index,
        to: mdLink.index + mdLink[0].length,
        text: hasWidth ? `![${cleanAlt}|${width}](${url})` : `![${cleanAlt}](${url})`,
    };
};

/**
 * Markdown本文内の特定の画像埋め込みのサイズ指定を更新またはリセットする
 * @param {string} content Markdown本文テキスト
 * @param {string} imageName 対象の画像ファイル名（またはパス）
 * @param {number|null} newWidth 新しい幅（px）。null または 0 の場合はサイズ指定を削除してリセット
 * @param {number|null} [hintOffset] 同じ画像が複数ある場合に対象を特定するための本文中オフセット
 * @returns {string} 更新後のMarkdownテキスト
 **/
const updateMarkdownImageSize = (content, imageName, newWidth, hintOffset = null) => {
    const edit = findMarkdownImageSizeEdit(content, imageName, newWidth, hintOffset);
    if (!edit) return content;
    return content.slice(0, edit.from) + edit.text + content.slice(edit.to);
};

/**
 * 要素を表示している Markdown ビューを返す
 * リサイズハンドルの操作はペインをアクティブにしないため、アクティブビューではなく
 * 要素を実際に含んでいるビューを優先する（ホバープレビュー等はアクティブビューへフォールバック）。
 **/
const findMarkdownViewForElement = (element) => {
    const leaves = app.workspace.getLeavesOfType?.("markdown") || [];
    const owner = leaves.find((leaf) => leaf?.view?.containerEl?.contains?.(element));
    if (owner?.view) return owner.view;
    return app.workspace.getActiveViewOfType?.(obsidianLib?.View || window?.obsidian?.View) || null;
};

/**
 * 埋め込み要素が本文のどこに書かれているかを求める
 * 同じ画像を複数回埋め込んだノートで、操作した埋め込みだけを書き換えるために使う。
 * @returns {{offset: number}|{line: number}|null} 本文中の文字オフセット（取得できない環境では開始行）
 **/
const getEmbedSourceLocation = (view, element) => {
    try {
        const editorView = view?.editor?.cm;
        if (typeof editorView?.posAtDOM === "function" && editorView.dom?.contains?.(element)) {
            return { offset: editorView.posAtDOM(element) };
        }
        // 閲覧ビューは、埋め込みを含むセクションの開始位置（フロントマターを含む本文全体でのオフセット）を使う。
        const sections = view?.previewMode?.renderer?.sections;
        if (Array.isArray(sections)) {
            const section = sections.find((candidate) => candidate?.el?.contains?.(element));
            if (typeof section?.start?.offset === "number") return { offset: section.start.offset };
            if (typeof section?.start?.line === "number") return { line: section.start.line };
            if (typeof section?.lineStart === "number") return { line: section.lineStart };
        }
    } catch (error) {
        console.warn("Failed to locate embed source position:", error);
    }
    return null;
};

const getLineStartOffset = (content, line) => {
    let offset = 0;
    for (let current = 0; current < line; current++) {
        const next = content.indexOf("\n", offset);
        if (next === -1) return content.length;
        offset = next + 1;
    }
    return offset;
};

// 書き換え後の再描画のあいだ、表示位置を保つ時間（ms）。PDF は読み込み後にも表示位置を動かすため長めにとる。
const EMBED_REWRITE_SCROLL_HOLD_MS = 3000;

/**
 * ビューの表示位置を、しばらくのあいだ今の位置に保つ
 * 埋め込みのリンクを書き換えると、Obsidian が埋め込みを描き直す。閲覧モードでは描き直した部分の
 * 先頭へスクロールし直し、描き直しの途中で本文が一時的に短くなると位置が切り詰められるため、
 * 書き換え前のスクロール位置へ戻し続ける。利用者がホイール・キー・クリックで操作したら、その時点でやめる。
 * @param {object} view Markdown ビュー
 * @param {number} [duration] 位置を保つ時間（ms）
 * @returns {() => void} 位置を保つのをやめる関数
 **/
const keepViewScrollPosition = (view, duration = EMBED_REWRITE_SCROLL_HOLD_MS) => {
    const scroller = view?.getMode?.() === "preview"
        ? view.previewMode?.containerEl?.querySelector?.(".markdown-preview-view") || view.previewMode?.containerEl
        : view?.editor?.cm?.scrollDOM;
    if (!scroller || typeof scroller.addEventListener !== "function") return () => {};

    const win = scroller.ownerDocument?.defaultView || window;
    const top = scroller.scrollTop;
    const end = Date.now() + duration;
    const userEvents = ["wheel", "keydown", "mousedown", "touchstart"];
    let stopped = false;
    const restore = () => {
        if (!stopped && Math.abs(scroller.scrollTop - top) > 1) scroller.scrollTop = top;
    };
    const stop = () => {
        if (stopped) return;
        stopped = true;
        scroller.removeEventListener("scroll", restore);
        userEvents.forEach((type) => scroller.removeEventListener(type, stop, true));
    };
    // 再描画で本文の高さが変わってもスクロールイベントが起きない場合があるため、毎フレームも確かめる。
    const tick = () => {
        if (stopped) return;
        if (Date.now() >= end) {
            stop();
            return;
        }
        restore();
        win.requestAnimationFrame(tick);
    };
    scroller.addEventListener("scroll", restore);
    userEvents.forEach((type) => scroller.addEventListener(type, stop, true));
    win.requestAnimationFrame(tick);
    return stop;
};

/**
 * 埋め込みを表示しているノートの本文のうち、その埋め込みのリンクだけを書き換える
 * - 書き換えるのは、埋め込みを実際に表示しているビューのノート（アクティブなペインとは限らない）。
 * - 同じファイルを複数回埋め込んでいる場合に備え、操作した埋め込みの本文中の位置を findEdit へ渡す。
 * @param {Element} container 埋め込み要素
 * @param {(content: string, hintOffset: number|null, noteFile: object) => {from: number, to: number, text: string}|null} findEdit
 *   本文から置換範囲と置換後のテキストを求める関数。書き換え不要なら null
 * @returns {Promise<boolean>} 書き換え先のノートが見つかったか
 **/
const rewriteEmbedLinkInNote = async (container, findEdit) => {
    const targetView = findMarkdownViewForElement(container);
    const noteFile = targetView?.file || app.workspace.getActiveFile();
    if (!noteFile || noteFile.extension !== "md") return false;

    const location = getEmbedSourceLocation(targetView, container);
    const resolveHintOffset = (content) => {
        if (typeof location?.offset === "number") return location.offset;
        if (typeof location?.line === "number") return getLineStartOffset(content, location.line);
        return null;
    };
    const editFor = (content) => findEdit(content, resolveHintOffset(content), noteFile);

    // 閲覧モードでは、非表示のエディタを書き換えてもファイルへ保存されず表示にも反映されないため、
    // ファイルを直接書き換える（Obsidian がビューを読み直して再描画する）。
    const isReadingMode = targetView?.getMode?.() === "preview";
    const editor = isReadingMode ? null : targetView?.editor;
    if (editor && typeof editor.getValue === "function" && typeof editor.setValue === "function") {
        const currentContent = editor.getValue();
        const edit = editFor(currentContent);
        if (edit && currentContent.slice(edit.from, edit.to) !== edit.text) {
            keepViewScrollPosition(targetView);
            // 該当リンクだけを書き換え、カーソル・スクロール位置・Undo履歴の粒度を保つ。
            const cm = editor.cm;
            if (typeof cm?.dispatch === "function") {
                // editor.replaceRange はカーソルが見える位置へスクロールする指定付きで書き換えるため、
                // カーソルから離れた埋め込みを操作すると、表示がカーソル位置（多くはノートの先頭）へ飛ぶ。
                const spec = { changes: { from: edit.from, to: edit.to, insert: edit.text } };
                // 書き換えた行の高さは、CodeMirror が見積もり直す（Obsidian の埋め込みは一律 100px）。
                // 画面の上へはみ出している大きな埋め込みは、見積もりの高さでは画面外と判断されて描画されず、
                // 埋め込みが消えて下の本文が見える。書き換えた位置を今と同じ画面位置に保つよう頼むと、
                // CodeMirror はその位置を描画・計測してからスクロールするため、埋め込みが描画されたまま残る。
                const scrollIntoView = cm.constructor?.scrollIntoView;
                if (typeof scrollIntoView === "function" && typeof cm.lineBlockAt === "function") {
                    const blockTop = cm.documentTop + cm.lineBlockAt(edit.from).top;
                    const yMargin = blockTop - cm.scrollDOM.getBoundingClientRect().top;
                    spec.effects = scrollIntoView(edit.from, { y: "start", yMargin });
                }
                cm.dispatch(spec);
            } else if (typeof editor.replaceRange === "function" && typeof editor.offsetToPos === "function") {
                editor.replaceRange(edit.text, editor.offsetToPos(edit.from), editor.offsetToPos(edit.to));
            } else {
                const cursor = editor.getCursor();
                editor.setValue(currentContent.slice(0, edit.from) + edit.text + currentContent.slice(edit.to));
                editor.setCursor(cursor);
            }
        }
    } else {
        const stopKeepingScroll = keepViewScrollPosition(targetView);
        let changed = false;
        await app.vault.process(noteFile, (content) => {
            const edit = editFor(content);
            if (!edit || content.slice(edit.from, edit.to) === edit.text) return content;
            changed = true;
            return content.slice(0, edit.from) + edit.text + content.slice(edit.to);
        });
        if (!changed) stopKeepingScroll();
    }
    return true;
};

/**
 * リサイズ後の画像サイズを、その画像を表示しているノートへ保存する
 **/
const saveNewImageWidth = async (container, visual, newWidth) => {
    try {
        const file = (typeof getFileFromImageElement === "function" ? getFileFromImageElement(visual) : null)
            || (typeof getFileFromImageElement === "function" ? getFileFromImageElement(container) : null);

        let hasTarget = false;
        const saved = await rewriteEmbedLinkInNote(container, (content, hintOffset, noteFile) => {
            const targetFileName = file?.name
                || container.getAttribute?.("data-figure-name")
                || visual.getAttribute?.("alt")
                || (typeof getFigureEmbedSource === "function" ? getFigureEmbedSource(container, noteFile.path) : "")
                || "";
            if (!targetFileName) return null;
            hasTarget = true;
            return findMarkdownImageSizeEdit(content, targetFileName, newWidth, hintOffset);
        });
        if (!saved || !hasTarget) return;

        if (newWidth) {
            new Notice(`画像サイズを ${newWidth}px に変更しました`, 1500);
        } else {
            new Notice("画像サイズを初期状態にリセットしました", 1500);
        }
    } catch (err) {
        console.error("Failed to save image width:", err);
    }
};

/**
 * 画像およびExcalidraw埋め込みコンテナの右下にドラッグリサイズ用ハンドルを付与・設定する
 **/
const setupImageResizeHandle = (container, visual) => {
    if (!container || !visual) return;

    // 既にハンドルが存在する場合はスキップ
    if (container.querySelector(":scope > .custom-image-resizer-handle")) return;

    const handle = container.ownerDocument.createElement("div");
    handle.className = "custom-image-resizer-handle";
    handle.title = "ドラッグして拡大縮小 / ダブルクリックで元のサイズにリセット";
    container.appendChild(handle);

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;
    let tooltipEl = null;

    const updateTooltipPos = (clientX, clientY) => {
        if (!tooltipEl) return;
        tooltipEl.style.left = `${clientX + 12}px`;
        tooltipEl.style.top = `${clientY - 28}px`;
    };

    const onMouseDown = (e) => {
        if (e.button !== 0) return; // 左クリックのみ
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === "function") {
            e.stopImmediatePropagation();
        }

        isResizing = true;
        startX = e.clientX;
        startWidth = visual.getBoundingClientRect().width || visual.offsetWidth || container.getBoundingClientRect().width || 200;

        handle.classList.add("is-dragging");
        document.body.style.cursor = "nwse-resize";
        document.body.style.userSelect = "none";

        // HUDツールチップを作成
        tooltipEl = container.ownerDocument.createElement("div");
        tooltipEl.className = "custom-image-resize-tooltip";
        tooltipEl.textContent = `${Math.round(startWidth)}px`;
        container.ownerDocument.body.appendChild(tooltipEl);
        updateTooltipPos(e.clientX, e.clientY);

        document.addEventListener("mousemove", onMouseMove, true);
        document.addEventListener("mouseup", onMouseUp, true);
    };

    const onMouseMove = (e) => {
        if (!isResizing) return;
        e.preventDefault();
        e.stopPropagation();

        const deltaX = e.clientX - startX;
        const newWidth = Math.max(50, Math.round(startWidth + deltaX));

        visual.style.width = `${newWidth}px`;
        visual.style.height = "auto";
        const svg = visual.querySelector?.("svg") || (visual.tagName === "svg" ? visual : null);
        if (svg) {
            // 親の幅が内容で決まる（循環する）ため、%ではなくpxで指定する。
            // %のままだと環境によって幅0に潰れて図が消える。
            svg.style.width = `${newWidth}px`;
            svg.style.height = "auto";
        }
        visual.setAttribute("width", `${newWidth}`);
        container.style.setProperty("--figure-width", `${newWidth}px`);

        if (tooltipEl) {
            tooltipEl.textContent = `${newWidth}px`;
            updateTooltipPos(e.clientX, e.clientY);
        }
    };

    const onMouseUp = async (e) => {
        if (!isResizing) return;
        isResizing = false;
        handle.classList.remove("is-dragging");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";

        if (tooltipEl) {
            tooltipEl.remove();
            tooltipEl = null;
        }

        document.removeEventListener("mousemove", onMouseMove, true);
        document.removeEventListener("mouseup", onMouseUp, true);

        // 新しい幅をMarkdownノート本文へ反映・保存
        const deltaX = e.clientX - startX;
        const newWidth = Math.max(50, Math.round(startWidth + deltaX));

        await saveNewImageWidth(container, visual, newWidth);
    };

    const onDblClick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === "function") {
            e.stopImmediatePropagation();
        }

        // スタイルリセット
        visual.style.width = "";
        visual.style.height = "";
        const svg = visual.querySelector?.("svg") || (visual.tagName === "svg" ? visual : null);
        if (svg) {
            svg.style.width = "";
            svg.style.height = "";
        }
        visual.removeAttribute("width");
        container.style.removeProperty("--figure-width");

        await saveNewImageWidth(container, visual, null);
    };

    handle.addEventListener("mousedown", onMouseDown, true);
    handle.addEventListener("dblclick", onDblClick, true);
};

// -----------------------------------------------------------------------------
// PDF埋め込みのドラッグリサイズ
// Obsidian の PDF 埋め込みは、既定で「幅100%・高さ1ページ分」で表示される。
// 右端（幅）・下端（高さ）・右下隅（幅と高さ）のハンドルで大きさを変え、画像と同じ記法でリンクへ保存する。
// - `![[資料.pdf|600]]`（幅だけ）、`![[資料.pdf|600x400]]`（幅と、ツールバーを含む枠全体の高さ）。
// - Obsidian はこの指定を埋め込み要素の width / height 属性にするだけで表示には使わないため、
//   このスクリプトが属性の値を表示の大きさとして当てる。高さの指定が無い場合は、Obsidian が
//   幅に合わせて1ページ分の高さへ自動で合わせる。
// - Obsidian 標準の `#height=400` は使わない。`#` 以降を変えると Obsidian が埋め込みを作り直して
//   PDF を読み込み直し、編集モードでは作り直した埋め込みが描画されず消えたように見えるため。
//   別名（`|600x400`）だけの変更なら、Obsidian は埋め込みを作り直さずに属性だけを更新する。
//   以前の版が書いた `#height=` は、高さを変えたときに取り除いて別名の高さへ置き換える。
// -----------------------------------------------------------------------------

const PDF_EMBED_MIN_WIDTH = 200;
const PDF_EMBED_MIN_HEIGHT = 200;
const PDF_EMBED_SELECTOR = ".internal-embed.pdf-embed";
// サイズ指定とみなすリンクの別名（`|600`、`|600x400`）
const PDF_SIZE_ALIAS_PATTERN = /^\s*(\d+)\s*(?:x\s*(\d+)\s*)?$/i;

/**
 * PDFリンクのサブパス（例: "#page=3&height=400"）から height 指定を読み取る
 * @returns {number|null}
 **/
const getPdfSubpathHeight = (subpath) => {
    const match = String(subpath || "").match(/(?:^#?|&)height=(\d+)/i);
    return match ? Number(match[1]) : null;
};

/**
 * PDFリンクのサブパスから height 指定だけを取り除く（page などの他の指定は残す）
 * @param {string} subpath "#page=3&height=400" など（空文字可）
 * @returns {string} 新しいサブパス（指定が残らない場合は空文字）
 **/
const removePdfSubpathHeight = (subpath) => {
    const params = String(subpath || "").replace(/^#/, "").split("&")
        .filter(Boolean)
        .filter((param) => !/^height=/i.test(param));
    return params.length ? `#${params.join("&")}` : "";
};

/**
 * Markdown本文内で、特定のPDF埋め込みの幅・高さ指定を書き換える編集位置を求める
 * - Wikilink（![[資料.pdf]]、![[資料.pdf#page=3|600x400]]）を優先し、見つからない場合のみ
 *   標準Markdown記法（![alt|600x400](資料.pdf)）を対象にする。
 * - 表示名の別名（`|資料`、`|資料|600`）は残す。高さを指定・リセットするときは `#height=` を取り除く。
 * @param {string} content Markdown本文テキスト
 * @param {string} pdfName 対象のPDFファイル名（またはパス）
 * @param {{width?: number|null, height?: number|null}} size 数値で指定、null で指定を取り除く、省略で現状維持
 * @param {number|null} [hintOffset] 同じPDFが複数ある場合に対象を特定するための本文中オフセット
 * @returns {{from: number, to: number, text: string}|null} 置換範囲と置換後のテキスト
 **/
const findPdfEmbedSizeEdit = (content, pdfName, size = {}, hintOffset = null) => {
    if (!content || !pdfName) return null;
    const cleanName = String(pdfName).split("|")[0].split("#")[0].trim();
    const baseName = cleanName.substring(cleanName.lastIndexOf("/") + 1);
    if (!baseName) return null;

    const toPattern = (names) => Array.from(new Set(names.filter(Boolean)))
        .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|");
    const nextSubpath = (subpath) =>
        size.height === undefined ? (subpath || "") : removePdfSubpathHeight(subpath);
    // Obsidian と同じく、別名の最後の `|` 以降がサイズ指定ならサイズ、それより前を表示名として扱う。
    const nextAlias = (alias) => {
        let label = alias;
        let width = 0;
        let height = 0;
        if (alias !== undefined) {
            const sep = alias.lastIndexOf("|");
            const sizeMatch = alias.slice(sep + 1).match(PDF_SIZE_ALIAS_PATTERN);
            if (sizeMatch) {
                label = sep >= 0 ? alias.slice(0, sep) : undefined;
                width = Number(sizeMatch[1]);
                height = Number(sizeMatch[2] || 0);
            }
        }
        if (size.width !== undefined) width = size.width ? Math.round(size.width) : 0;
        if (size.height !== undefined) height = size.height ? Math.round(size.height) : 0;
        const sizeText = width && height ? `${width}x${height}` : width ? `${width}` : height ? `0x${height}` : "";
        if (label !== undefined && sizeText) return `${label}|${sizeText}`;
        return label !== undefined ? label : sizeText || undefined;
    };

    // ![[パス/資料.pdf]]、![[資料.pdf#page=3|600x400]]
    const wikilinkRegex = new RegExp(
        `!\\[\\[((?:[^\\]|#]*\\/)?(?:${toPattern([baseName])}))(#[^\\]|]*)?(?:\\|([^\\]]*))?\\]\\]`,
        "g",
    );
    const wikilink = pickEmbedMatchNearOffset(Array.from(content.matchAll(wikilinkRegex)), hintOffset);
    if (wikilink) {
        const [, linkpath, subpath, alias] = wikilink;
        const newAlias = nextAlias(alias);
        return {
            from: wikilink.index,
            to: wikilink.index + wikilink[0].length,
            text: `![[${linkpath}${nextSubpath(subpath)}${newAlias !== undefined ? `|${newAlias}` : ""}]]`,
        };
    }

    // ![alt|600x400](資料.pdf)。パスの空白などはパーセントエンコードされていることがある。
    let encodedName = baseName;
    try {
        encodedName = encodeURI(baseName);
    } catch {
        // エンコードできない名前は、そのまま扱う。
    }
    const mdLinkRegex = new RegExp(
        `!\\[([^\\]]*)\\]\\(((?:[^)#]*\\/)?(?:${toPattern([baseName, encodedName])}))(#[^)]*)?\\)`,
        "g",
    );
    const mdLink = pickEmbedMatchNearOffset(Array.from(content.matchAll(mdLinkRegex)), hintOffset);
    if (!mdLink) return null;
    const [, alt, url, subpath] = mdLink;
    return {
        from: mdLink.index,
        to: mdLink.index + mdLink[0].length,
        text: `![${nextAlias(alt) || ""}](${url}${nextSubpath(subpath)})`,
    };
};

/**
 * PDF埋め込みのリンク先ファイル名と、リンクに書かれた大きさの指定を返す
 * - 埋め込み要素の src 属性には、別名を除いたリンク（"資料.pdf#page=3"）が入る。
 * - width / height 属性は、Obsidian がリンクの別名（`|600x400`）から付ける。
 * - legacyHeight は、以前の版が書いた `#height=` の値。
 **/
const getPdfEmbedLinkInfo = (container) => {
    const src = container?.getAttribute?.("src") || "";
    const hashIndex = src.indexOf("#");
    const toNumber = (value) => (parseFloat(value) > 0 ? parseFloat(value) : null);
    return {
        linkpath: hashIndex >= 0 ? src.slice(0, hashIndex) : src,
        width: toNumber(container?.getAttribute?.("width")),
        height: toNumber(container?.getAttribute?.("height")),
        legacyHeight: getPdfSubpathHeight(hashIndex >= 0 ? src.slice(hashIndex) : ""),
    };
};

/**
 * リサイズ後のPDFの大きさを、そのPDFを表示しているノートのリンクへ保存する
 * @param {Element} container PDF埋め込み要素
 * @param {{width?: number|null, height?: number|null}} size findPdfEmbedSizeEdit と同じ指定
 **/
const savePdfEmbedSize = async (container, size) => {
    try {
        const { linkpath } = getPdfEmbedLinkInfo(container);
        if (!linkpath) return;
        const saved = await rewriteEmbedLinkInNote(container, (content, hintOffset) =>
            findPdfEmbedSizeEdit(content, linkpath, size, hintOffset),
        );
        if (!saved) return;

        if (size.width === null && size.height === null) {
            new Notice("PDFの表示サイズを初期状態にリセットしました", 1500);
        } else {
            const parts = [];
            if (size.width !== undefined) parts.push(size.width ? `幅 ${Math.round(size.width)}px` : "幅 100%");
            if (size.height !== undefined) parts.push(size.height ? `高さ ${Math.round(size.height)}px` : "高さ 1ページ分");
            new Notice(`PDFの表示サイズを ${parts.join("・")} に変更しました`, 1500);
        }
    } catch (err) {
        console.error("Failed to save PDF embed size:", err);
    }
};

/**
 * PDF埋め込みの表示の高さを固定する、または固定を外す
 * Obsidian は高さの指定が無い PDF の高さを、枠の大きさが変わるたびに1ページ分へ戻すため、
 * min-height / max-height でも固定する。
 **/
const setPdfEmbedFixedHeight = (container, height) => {
    const value = height ? `${height}px` : "";
    for (const property of ["minHeight", "maxHeight"]) {
        if (container.style[property] !== value) container.style[property] = value;
    }
    if (height && container.style.height !== value) container.style.height = value;
};

/**
 * PDF埋め込みの右端・下端・右下隅に、ドラッグリサイズ用のハンドルを付与する
 **/
const setupPdfResizeHandles = (container) => {
    if (!container || container.querySelector(":scope > .custom-pdf-resizer-handle")) return;
    const doc = container.ownerDocument;

    let drag = null;
    let tooltipEl = null;
    let stopKeepingScroll = null;

    const getMaxWidth = () => {
        const parentWidth = container.parentElement?.getBoundingClientRect?.().width || 0;
        return parentWidth > 0 ? parentWidth : Infinity;
    };

    // ドラッグ量から、新しい表示幅・高さ（ツールバーを含む枠全体）を求める
    const measure = (e) => {
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        const width = drag.mode.includes("x")
            ? Math.round(Math.min(drag.maxWidth, Math.max(PDF_EMBED_MIN_WIDTH, drag.startWidth + dx)))
            : null;
        const height = drag.mode.includes("y")
            ? Math.round(Math.max(PDF_EMBED_MIN_HEIGHT, drag.startHeight + dy))
            : null;
        return { width, height, moved: Math.abs(dx) >= 3 || Math.abs(dy) >= 3 };
    };

    const describe = ({ width, height }) => [
        width !== null ? `幅 ${width}px` : null,
        height !== null ? `高さ ${height}px` : null,
    ].filter(Boolean).join(" × ");

    const onMouseMove = (e) => {
        if (!drag) return;
        e.preventDefault();
        e.stopPropagation();
        const { width, height } = measure(e);
        if (width !== null) container.style.width = `${width}px`;
        if (height !== null) setPdfEmbedFixedHeight(container, height);
        if (tooltipEl) {
            tooltipEl.textContent = describe({ width, height });
            tooltipEl.style.left = `${e.clientX + 12}px`;
            tooltipEl.style.top = `${e.clientY - 28}px`;
        }
    };

    const onMouseUp = async (e) => {
        if (!drag) return;
        const { width, height, moved } = measure(e);
        const { maxWidth, startWidth, linkInfo } = drag;
        drag = null;
        container.classList.remove("is-pdf-resizing");
        doc.body.style.cursor = "";
        doc.body.style.userSelect = "";
        tooltipEl?.remove();
        tooltipEl = null;
        doc.removeEventListener("mousemove", onMouseMove, true);
        doc.removeEventListener("mouseup", onMouseUp, true);
        // ここまで保っていた位置は、保存（rewriteEmbedLinkInNote）が引き継いで再描画のあいだも保つ。
        stopKeepingScroll?.();
        stopKeepingScroll = null;

        // 動かさずに離した場合（クリック・ダブルクリック）は保存しない。
        // 保存すると閲覧モードでは埋め込みが描画し直され、ダブルクリックの2回目が別の要素に当たってリセットできなくなる。
        if (!moved) return;
        const size = {};
        if (width !== null) {
            // 親の幅いっぱいまで広げた場合は、幅の指定を取り除いて既定の100%表示に戻す
            // （高さの指定がある場合は `|0x400` にならないよう、幅を数値で残す）。
            const keepsHeight = height === null && linkInfo.height;
            size.width = width >= maxWidth - 1 && !keepsHeight ? null : width;
        }
        if (height !== null) {
            size.height = height;
            // 記法の都合で高さだけは書けないため、幅の指定が無ければ今の表示幅を書く。
            if (width === null && !linkInfo.width) size.width = Math.round(startWidth);
        }
        await savePdfEmbedSize(container, size);
    };

    const startDrag = (e, mode, cursor) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();

        const rect = container.getBoundingClientRect();
        const linkInfo = getPdfEmbedLinkInfo(container);
        drag = {
            mode,
            startX: e.clientX,
            startY: e.clientY,
            startWidth: rect.width,
            startHeight: rect.height,
            maxWidth: getMaxWidth(),
            linkInfo,
        };
        // 高さの指定が無いPDFの幅だけを変える場合は、前回のドラッグで固定した高さを外し、1ページ分の高さへ追従させる。
        if (!mode.includes("y") && !linkInfo.height) setPdfEmbedFixedHeight(container, null);
        // PDF は幅が変わるとページを描き直し、そのついでにノート全体のスクロール位置まで
        // ページが見える位置へ動かすため、ドラッグ中もノートの表示位置を保つ。
        stopKeepingScroll?.();
        stopKeepingScroll = keepViewScrollPosition(findMarkdownViewForElement(container), Infinity);
        container.classList.add("is-pdf-resizing");
        doc.body.style.cursor = cursor;
        doc.body.style.userSelect = "none";

        tooltipEl = doc.createElement("div");
        tooltipEl.className = "custom-image-resize-tooltip";
        tooltipEl.textContent = describe({
            width: mode.includes("x") ? Math.round(rect.width) : null,
            height: mode.includes("y") ? Math.round(rect.height) : null,
        });
        doc.body.appendChild(tooltipEl);

        doc.addEventListener("mousemove", onMouseMove, true);
        doc.addEventListener("mouseup", onMouseUp, true);
    };

    const onDblClick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
        container.style.width = "";
        setPdfEmbedFixedHeight(container, null);
        await savePdfEmbedSize(container, { width: null, height: null });
    };

    [
        { cls: "mod-right", mode: "x", cursor: "ew-resize", title: "ドラッグして幅を変更" },
        { cls: "mod-bottom", mode: "y", cursor: "ns-resize", title: "ドラッグして高さを変更" },
        { cls: "mod-corner", mode: "xy", cursor: "nwse-resize", title: "ドラッグして幅と高さを変更" },
    ].forEach(({ cls, mode, cursor, title }) => {
        const handle = doc.createElement("div");
        handle.className = `custom-pdf-resizer-handle ${cls}`;
        handle.title = `${title} / ダブルクリックで元のサイズにリセット`;
        handle.addEventListener("mousedown", (e) => startDrag(e, mode, cursor), true);
        handle.addEventListener("dblclick", onDblClick, true);
        container.appendChild(handle);
    });
};

/**
 * Markdownビュー内のPDF埋め込みに、リンクの幅・高さの指定を当ててリサイズハンドルを付与する
 **/
const applyPdfEmbedSizes = (root = document) => {
    const containers = [];
    if (root.matches?.(PDF_EMBED_SELECTOR)) containers.push(root);
    root.querySelectorAll?.(PDF_EMBED_SELECTOR).forEach((element) => containers.push(element));

    containers.forEach((container) => {
        // ホバープレビューや Canvas のPDFは、それぞれの枠の大きさに従う。
        if (!container.closest?.(".markdown-source-view, .markdown-preview-view")) return;
        if (container.closest?.(".popover, .canvas-node-content")) return;

        if (!container.classList.contains("is-pdf-resizing")) {
            const { width, height } = getPdfEmbedLinkInfo(container);
            const desiredWidth = width ? `${Math.max(PDF_EMBED_MIN_WIDTH, Math.round(width))}px` : "";
            if (container.style.width !== desiredWidth) container.style.width = desiredWidth;
            setPdfEmbedFixedHeight(container, height ? Math.max(PDF_EMBED_MIN_HEIGHT, Math.round(height)) : null);
        }
        setupPdfResizeHandles(container);
    });
};

const updateFigureEmbedWidth = (target) => {
    if (!target?.isConnected) return;
    const visual = target.matches?.("img, svg, canvas")
        ? target
        : target.querySelector?.("img, svg, canvas, .excalidraw-embedded-img");
    // 幅指定の属性があるのに、表示幅が0に潰れた図は、属性の幅をpxで当て直して復旧する。
    if (visual && visual.getBoundingClientRect().width < 1) {
        const attrWidth = parseFloat(visual.getAttribute?.("width"));
        if (attrWidth > 0) {
            visual.style.width = `${attrWidth}px`;
            visual.style.height = "auto";
        }
    }
    const width = visual?.getBoundingClientRect?.().width
        || parseFloat(visual?.getAttribute?.("width"))
        || parseFloat(target?.getAttribute?.("width"))
        || 0;
    if (width > 0) target.style.setProperty("--figure-width", `${Math.ceil(width)}px`);
};

const ensureFigureEmbedCaption = (target, displayName) => {
    if (!target || !displayName) return;
    let caption = Array.from(target.children || []).find((child) =>
        child.classList?.contains("custom-figure-caption"),
    );
    // Excalidraw自身が内側の描画コンテナへキャプションを付けた場合は、
    // 外側へもう1つ作らず、そのキャプションを利用する。
    if (!caption) {
        const nestedCaption = target.querySelector?.(".custom-figure-caption");
        if (nestedCaption) {
            if (nestedCaption.textContent !== displayName) nestedCaption.textContent = displayName;
            return;
        }
    }
    if (!caption) {
        caption = target.ownerDocument.createElement("div");
        caption.className = "custom-figure-caption";
        target.appendChild(caption);
    }
    if (caption.textContent !== displayName) caption.textContent = displayName;
    // Excalidrawは画像を非同期で追加・差し替えるため、毎回キャプションを最後尾へ戻す。
    if (target.lastElementChild !== caption) target.appendChild(caption);
};

const removeDuplicateFigureCaptions = (root = document) => {
    const captions = Array.from(root.querySelectorAll?.(".custom-figure-caption") || []);
    const kept = new Map();
    captions.forEach((caption) => {
        const text = caption.textContent?.trim();
        if (!text) return;
        const target = caption.closest?.("[data-figure-name]");
        const previous = kept.get(text);
        if (!previous) {
            kept.set(text, { caption, target });
            return;
        }
        if (previous.target === target) {
            caption.remove();
            return;
        }
        const previousVisual = previous.target?.querySelector?.("img, svg, canvas, .excalidraw-embedded-img");
        const currentVisual = target?.querySelector?.("img, svg, canvas, .excalidraw-embedded-img");
        const a = previousVisual?.getBoundingClientRect?.();
        const b = currentVisual?.getBoundingClientRect?.();
        if (a && b && a.width > 0 && b.width > 0) {
            const intersectionWidth = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
            const intersectionHeight = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
            const intersection = intersectionWidth * intersectionHeight;
            const smaller = Math.min(a.width * a.height, b.width * b.height);
            if (intersection / smaller > 0.8) {
                caption.remove();
                return;
            }
        }
        kept.set(text, { caption, target });
    });
};

const applyExcalidrawFallbackCaptions = async () => {
    const markdownLeaves = app.workspace.getLeavesOfType?.("markdown") || [];
    for (const leaf of markdownLeaves) {
        const view = leaf?.view;
        const container = view?.containerEl;
        let markdownText = view?.getViewData?.() || view?.editor?.getValue?.() || "";
        if (!markdownText && view?.file) {
            try {
                markdownText = await app.vault.cachedRead(view.file);
            } catch (error) {
                console.warn("Failed to read Markdown for Excalidraw captions.", error);
            }
        }
        if (!container || !markdownText) continue;

        const sources = Array.from(markdownText.matchAll(
            /!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/gi,
        )).map((match) => match[1])
            .filter((source) => isExcalidrawEmbedSource(source, view?.file?.path || ""));
        if (!sources.length) continue;

        // 表示方式により外枠クラスが変わるため、必ず付与される画像本体から親を取得する。
        const embeddedTargets = Array.from(container.querySelectorAll(".excalidraw-embedded-img"))
            .map((element) => element.parentElement || element);
        const outerSvgTargets = Array.from(container.querySelectorAll(".excalidraw-svg")).filter((element) =>
            !element.parentElement?.closest?.(".excalidraw-svg"),
        );
        const unlabeledImageTargets = Array.from(container.querySelectorAll(
            ".markdown-preview-section img, .markdown-preview-section svg, " +
            ".markdown-preview-section [role='img'], " +
            ".markdown-source-view img, .markdown-source-view svg, " +
            ".markdown-source-view [role='img']",
        )).filter((image) => {
            if (image.closest?.("[data-figure-name]")) return false;
            const rect = image.getBoundingClientRect?.();
            if (!rect || rect.width < 50 || rect.height < 50) return false;
            const alt = image.getAttribute("alt") || "";
            const isExcalidrawVisual = Boolean(image.closest?.(
                ".excalidraw, .excalidraw-svg, .excalidraw-embedded-img, [data-excalidraw-source]",
            )) || sources.some((source) => getFigureEmbedDisplayName(source, view?.file?.path || "") === alt);
            return image.tagName === "svg" ||
                isExcalidrawVisual ||
                !image.getAttribute("alt") ||
                image.getAttribute("src")?.startsWith("blob:");
        }).map((image) => image.parentElement || image);
        const targets = Array.from(new Set([
            ...embeddedTargets,
            ...outerSvgTargets,
            ...unlabeledImageTargets,
        ]));
        targets.slice(0, sources.length).forEach((target, index) => {
            const source = sources[index];
            const displayName = getFigureEmbedDisplayName(source, view?.file?.path || "");
            if (!displayName) return;
            // 通常処理が既に同じ図へ名前を付けている場合は、フォールバック側で別名ラベルを増やさない。
            if (target.matches?.("[data-figure-name]") ||
                target.closest?.("[data-figure-name]") ||
                target.querySelector?.("[data-figure-name]")) return;
            target.setAttribute("data-figure-name", displayName);
            target.setAttribute("data-figure-kind", "excalidraw");
            ensureFigureEmbedCaption(target, displayName);
            updateFigureEmbedWidth(target);
            const visual = target.querySelector?.("img, svg, canvas, .excalidraw-embedded-img") || target;
            if (visual) {
                if (window._customFigureEmbedResizeObserver) {
                    window._customFigureEmbedResizeObserver.observe(visual);
                }
                setupImageResizeHandle(target, visual);
            }
        });
        removeDuplicateFigureCaptions(container);
    }
};

const applyFigureEmbedSpacing = async () => {
    const markdownLeaves = app.workspace.getLeavesOfType?.("markdown") || [];
    for (const leaf of markdownLeaves) {
        const view = leaf?.view;
        const container = view?.containerEl;
        let markdownText = view?.getViewData?.() || view?.editor?.getValue?.() || "";
        if (!markdownText && view?.file) {
            try {
                markdownText = await app.vault.cachedRead(view.file);
            } catch {
                continue;
            }
        }
        if (!container || !markdownText) continue;

        const sourcePath = view?.file?.path || "";
        const figures = Array.from(markdownText.matchAll(/!\[\[([^\]]+)\]\]/g))
            .filter((match) => isFigureEmbedSource(match[1], sourcePath))
            .map((match) => {
                const whitespace = markdownText.slice(match.index + match[0].length)
                    .match(/^(?:[ \t]*\r?\n)+/)?.[0] || "";
                const lineBreaks = Math.max(1, Math.min(8, (whitespace.match(/\n/g) || []).length));
                return {
                    displayName: getFigureEmbedDisplayName(match[1], sourcePath),
                    gap: `${lineBreaks * 1.15}em`,
                };
            });

        const usedTargets = new Set();
        figures.forEach(({ displayName, gap }) => {
            const candidates = Array.from(container.querySelectorAll("[data-figure-name]"))
                .filter((target) => target.getAttribute("data-figure-name") === displayName)
                .filter((target) => !usedTargets.has(target))
                .filter((target) => Array.from(target.children || []).some((child) =>
                    child.classList?.contains("custom-figure-caption"),
                ));
            // 入れ子の場合は、実際の図とキャプションを直接保持する一番内側を選ぶ。
            const target = candidates.find((candidate) =>
                !candidates.some((other) => other !== candidate && candidate.contains(other)),
            ) || candidates[0];
            if (!target) return;
            usedTargets.add(target);
            target.style.setProperty("--figure-after-gap", gap);
        });
    }
};

const applyFigureEmbedDisplayNames = (root = document) => {
    const selector = [
        ".media-embed[src]",
        ".internal-embed[src]",
        ".markdown-embed[src]",
        ".excalidraw-svg[data-excalidraw-source]",
        ".excalidraw-svg",
        ".excalidraw-embedded-img[filesource]",
        "[filesource]",
    ].join(", ");
    const elements = [];
    if (root.matches?.(selector)) elements.push(root);
    root.querySelectorAll?.(selector).forEach((element) => elements.push(element));

    const targets = new Set();
    elements.forEach((element) => {
        const sourcePath = getFigureEmbedSourcePath(element);
        const source = getFigureEmbedSource(element, sourcePath);
        if (!source) return;
        const target = getFigureEmbedLabelTarget(element);
        const displayName = getFigureEmbedDisplayName(source, sourcePath);
        if (!target || !displayName) return;
        target.setAttribute("data-figure-name", displayName);
        target.setAttribute("data-figure-kind", isExcalidrawEmbedSource(source, sourcePath) ? "excalidraw" : "image");
        ensureFigureEmbedCaption(target, displayName);
        targets.add(target);
        updateFigureEmbedWidth(target);
        const visual = target.querySelector?.("img, svg, canvas, .excalidraw-embedded-img") || target;
        setupImageResizeHandle(target, visual);
    });

    // data-figure-name 未設定の画像・埋め込みに対してもリサイズハンドルを付与
    root.querySelectorAll?.(".image-embed, .media-embed").forEach((container) => {
        if (container.matches?.(".pdf-embed")) return;
        const visual = container.querySelector?.("img, svg, canvas, .excalidraw-embedded-img") || container;
        if (visual) setupImageResizeHandle(container, visual);
    });

    if (window._customFigureEmbedResizeObserver) {
        targets.forEach((target) => {
            const visual = target.querySelector?.("img, svg, canvas, .excalidraw-embedded-img") || target;
            if (visual) window._customFigureEmbedResizeObserver.observe(visual);
            if (visual) {
                setupImageResizeHandle(target, visual);
            }
        });
    }
    removeDuplicateFigureCaptions(root);
    applyPdfEmbedSizes(root);
    void (async () => {
        await applyExcalidrawFallbackCaptions();
        await applyFigureEmbedSpacing();
    })();
};

// 図の再走査のきっかけにする属性（図の参照先の変更と、リサイズ・ホイール拡大による幅の変更）。
const FIGURE_OBSERVER_ATTRIBUTE_FILTER = [
    "src",
    "filesource",
    "fileSource",
    "data-excalidraw-source",
    "data-src",
    "data-path",
    "width",
    "alt",
    "style",
];

// 図の再走査（applyFigureEmbedDisplayNames）が必要なDOM変更かを判定する。
// 監視対象は document.body 全体のため、サイドバーや他プラグインの描画、スタイルだけの更新、
// このスクリプト自身が追加したキャプション・ハンドルでは再走査しない。
const FIGURE_CONTAINER_SELECTOR =
    ".internal-embed, .media-embed, .image-embed, .markdown-embed, .excalidraw-svg, [filesource], [data-figure-name]";
const FIGURE_VISUAL_SELECTOR = "img, svg, canvas, .excalidraw-embedded-img";
const FIGURE_OWN_ELEMENT_SELECTOR =
    ".custom-figure-caption, .custom-image-resizer-handle, .custom-pdf-resizer-handle, .custom-image-resize-tooltip";
// 図が現れる領域: Markdownの編集・閲覧ビュー、埋め込み、ホバープレビュー
const FIGURE_REGION_SELECTOR =
    `.markdown-source-view, .markdown-preview-view, .popover, ${FIGURE_CONTAINER_SELECTOR}`;
// 自前で描画・リサイズを管理しており、図のキャプション処理の対象外の領域（CAD Viewer の埋め込み）
const FIGURE_IGNORED_REGION_SELECTOR = ".step-viewer-embed-wrapper";

const isFigureRelevantMutation = (mutation) => {
    const target = mutation?.target;
    if (!target || target.nodeType !== 1) return false;
    if (target.closest?.(FIGURE_IGNORED_REGION_SELECTOR)) return false;

    if (mutation.type === "attributes") {
        // style 以外の監視属性（src, width, alt など）は図の差し替え・サイズ変更を表す。
        if (mutation.attributeName !== "style") return true;
        return Boolean(target.matches?.(`${FIGURE_VISUAL_SELECTOR}, ${FIGURE_CONTAINER_SELECTOR}`));
    }

    const isElement = (node) => node?.nodeType === 1;
    const changedElements = [
        ...Array.from(mutation.addedNodes || []),
        ...Array.from(mutation.removedNodes || []),
    ].filter(isElement);
    // キャプションやリサイズハンドルの追加・移動は、この処理自身が起こした変更。
    if (changedElements.length > 0 &&
        changedElements.every((node) => node.matches?.(FIGURE_OWN_ELEMENT_SELECTOR))) return false;

    // 本文の編集（図の後ろの空行数など）や、図の中身の非同期差し替え。
    if (target.closest?.(FIGURE_REGION_SELECTOR)) return true;
    // 上記の領域外（Canvas など）に図の埋め込みが新しく追加された場合。
    return Array.from(mutation.addedNodes || []).filter(isElement).some((node) =>
        node.matches?.(FIGURE_CONTAINER_SELECTOR) || Boolean(node.querySelector?.(FIGURE_CONTAINER_SELECTOR)),
    );
};
