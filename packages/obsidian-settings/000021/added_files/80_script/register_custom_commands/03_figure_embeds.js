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
// - 幅は style.width へ書かず、CSS 変数と excalidraw-embed-width.css の !important で当てる。
//   heading-level-indent が文字入力のたびに style.width を上書きするため、style.width で
//   張り合うと、打鍵のたびに幅が行き来して表示がちらつく。
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
 * PDF埋め込みの表示幅を固定する、または固定を外す
 * 他のプラグインが書き換える style.width には触らず、CSS 変数と !important の CSS で幅を当てる。
 **/
const setPdfEmbedFixedWidth = (container, width) => {
    const value = width ? `${width}px` : "";
    if (container.style.getPropertyValue("--pdf-embed-width") === value) return;
    if (value) {
        container.style.setProperty("--pdf-embed-width", value);
        container.classList.add("is-pdf-width-fixed");
    } else {
        container.style.removeProperty("--pdf-embed-width");
        container.classList.remove("is-pdf-width-fixed");
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
        if (width !== null) setPdfEmbedFixedWidth(container, width);
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
        setPdfEmbedFixedWidth(container, null);
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
            setPdfEmbedFixedWidth(container, width ? Math.max(PDF_EMBED_MIN_WIDTH, Math.round(width)) : null);
            setPdfEmbedFixedHeight(container, height ? Math.max(PDF_EMBED_MIN_HEIGHT, Math.round(height)) : null);
        }
        setupPdfResizeHandles(container);
    });
};

// =============================================================================
// iframe の埋め込み（ノートに書いた <iframe>）のドラッグリサイズと Option + ホイールの拡大縮小
// =============================================================================
// - 枠の大きさ: 右下のハンドルを自由にドラッグ（Shift を押すと縦横比を保つ）。ノート本文の <iframe> の width / height 属性へ保存する。
// - Option + ホイール: src が画像（png / jpg など）の iframe は、枠ではなく画像を拡大縮小する（data-zoom 属性へ保存）。
//   それ以外（地図など）は、枠を縦横比を保ったまま拡大縮小する。
// iframe の中ではホイールもマウス操作も iframe 自身が受け取りノートへ届かないため、
// 枠の拡大縮小は Option を押している間と、ドラッグ中だけ、iframe のマウス操作を無効にして外側で受け取る。
// 画像の iframe は、画像だけを表示する自前の文書（srcdoc）に差し替え、その中でホイールを受け取る。

const IFRAME_MIN_WIDTH = 200;
const IFRAME_MIN_HEIGHT = 100;
// 初期状態（<iframe> を挿入するときの大きさ）。ダブルクリックでここへ戻す。
const IFRAME_DEFAULT_WIDTH = "100%";
const IFRAME_DEFAULT_HEIGHT = "600";
const IFRAME_SELECTOR = ".markdown-source-view iframe, .markdown-preview-view iframe";
// 別のノートの内容やプラグインの画面にある iframe は、このノートに書かれたものではないため対象外
const IFRAME_IGNORED_SELECTOR =
    ".internal-embed, .markdown-embed, .popover, .canvas-node-content, " +
    ".step-viewer-embed-wrapper, .workspace-leaf-content[data-type='excalidraw']";
// 1回のホイール操作で拡大縮小する割合（deltaY 100 で約14%）
const IFRAME_WHEEL_ZOOM_SPEED = 0.0015;
// ホイールが止まってから、ノートへ保存するまでの待ち時間（保存すると iframe が読み込み直されるため、まとめて1回にする）
const IFRAME_WHEEL_SAVE_DELAY_MS = 600;
// 画像の拡大倍率（1 = 画像の実寸）を保存する属性と、その範囲
const IFRAME_ZOOM_ATTRIBUTE = "data-zoom";
const IFRAME_IMAGE_MIN_ZOOM = 0.05;
const IFRAME_IMAGE_MAX_ZOOM = 8;
const IFRAME_IMAGE_SRC_PATTERN = /^https?:\/\/[^?#\s]*\.(?:png|jpe?g|gif|webp|bmp|avif|svg)(?:[?#]\S*)?$/i;
const IFRAME_IMAGE_VIEWER_CLASS = "custom-iframe-image-viewer";
const IFRAME_ALT_HELD_CLASS = "custom-iframe-alt-held";
const IFRAME_DRAGGING_CLASS = "custom-iframe-dragging";

const IFRAME_TAG_PATTERN = /<iframe\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi;
const IFRAME_ATTRIBUTE_PATTERN = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

const decodeIframeAttributeValue = (value) => String(value ?? "")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");

/**
 * <iframe …> のタグ文字列から、属性の一覧（名前・値・タグ内での範囲）を求める
 **/
const parseIframeTagAttributes = (tag) => {
    const start = "<iframe".length;
    const end = tag.endsWith(">") ? tag.length - 1 : tag.length;
    const body = tag.slice(start, end);
    return Array.from(body.matchAll(IFRAME_ATTRIBUTE_PATTERN), (match) => ({
        name: match[1].toLowerCase(),
        value: decodeIframeAttributeValue(match[2] ?? match[3] ?? match[4] ?? ""),
        from: start + match.index,
        to: start + match.index + match[0].length,
    }));
};

/**
 * <iframe …> のタグ文字列の属性を、値を指定して書き換える（無ければ <iframe の直後に足す）
 * style="max-width:…" のような他の属性の中の文字は、属性名として扱わない。
 **/
const setIframeTagAttribute = (tag, name, value) => {
    const attribute = parseIframeTagAttributes(tag).find((candidate) => candidate.name === name);
    const text = `${name}="${value}"`;
    if (attribute) return tag.slice(0, attribute.from) + text + tag.slice(attribute.to);
    return `${tag.slice(0, "<iframe".length)} ${text}${tag.slice("<iframe".length)}`;
};

/**
 * Markdown本文内で、特定の <iframe> の width / height 属性を書き換える編集位置を求める
 * - src が一致する <iframe> を対象にする。同じ src が複数ある場合は、hintOffset（本文中の文字オフセット）を
 *   含む、または最も近いものを対象にする。
 * - size.width / size.height / size["data-zoom"] は属性へ書く値（数値または "100%"）。省略・null の属性はそのまま残す。
 * @param {string} content Markdown本文テキスト
 * @param {string} src 対象の iframe の src（HTML属性の値。&amp; などは展開済み）
 * @param {{width?: number|string|null, height?: number|string|null}} size
 * @param {number|null} [hintOffset]
 * @returns {{from: number, to: number, text: string}|null} 置換範囲と置換後のテキスト
 **/
const findIframeSizeEdit = (content, src, size = {}, hintOffset = null) => {
    const matches = Array.from(content.matchAll(IFRAME_TAG_PATTERN)).filter((match) =>
        parseIframeTagAttributes(match[0]).some((attribute) => attribute.name === "src" && attribute.value === src),
    );
    const match = pickEmbedMatchNearOffset(matches, hintOffset);
    if (!match) return null;
    let text = match[0];
    // 属性が無い場合は <iframe の直後に足すため、width・height・data-zoom の順に並ぶよう逆順で書き込む
    for (const name of [IFRAME_ZOOM_ATTRIBUTE, "height", "width"]) {
        if (size[name] === undefined || size[name] === null) continue;
        text = setIframeTagAttribute(text, name, String(size[name]));
    }
    return { from: match.index, to: match.index + match[0].length, text };
};

/**
 * 縦横比を保ったまま、幅から iframe の大きさを求める（幅は最小幅〜親の幅に収める）
 * @param {number} width 希望の幅（px）
 * @param {number} ratio 幅 ÷ 高さ
 * @param {number} maxWidth 親の幅（px）。不明なら Infinity
 * @returns {{width: number, height: number, full: boolean}} full は親の幅いっぱいか
 **/
const computeIframeSize = (width, ratio, maxWidth = Infinity) => {
    const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
    const clamped = Math.round(Math.min(maxWidth, Math.max(IFRAME_MIN_WIDTH, width)));
    return { width: clamped, height: Math.round(clamped / safeRatio), full: clamped >= maxWidth - 1 };
};

/**
 * 枠の幅と高さを自由に決める（縦横比は保たない）。幅は最小幅〜親の幅、高さは最小の高さ以上に収める。
 * @returns {{width: number, height: number, full: boolean}} full は親の幅いっぱいか
 **/
const computeFreeIframeSize = (width, height, maxWidth = Infinity) => {
    const clamped = Math.round(Math.min(maxWidth, Math.max(IFRAME_MIN_WIDTH, width)));
    return { width: clamped, height: Math.round(Math.max(IFRAME_MIN_HEIGHT, height)), full: clamped >= maxWidth - 1 };
};

/**
 * ノートへ保存する属性の値にする（親の幅いっぱいなら "100%" として、ペインの幅に追従させる）
 **/
const toIframeSizeAttributes = ({ width, height, full }) => ({ width: full ? "100%" : width, height });

// 表示の高さの基準になる親の幅。iframe が <p> など行内要素の中にあっても、幅のある祖先まで遡る。
const getIframeMaxWidth = (iframe) => {
    for (let parent = iframe.parentElement; parent; parent = parent.parentElement) {
        if (parent.clientWidth > 0) return parent.clientWidth;
    }
    return Infinity;
};

const getIframeRatio = (iframe) => {
    const rect = iframe.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect.width / rect.height : 1;
};

// ドラッグ・ホイール中の見た目だけの変更（保存すると iframe が読み込み直されるため、保存は操作が終わってから）
const applyIframeLiveSize = (iframe, size) => {
    iframe.style.width = `${size.width}px`;
    iframe.style.height = `${size.height}px`;
    iframe.style.maxWidth = "100%";
};

const clearIframeLiveSize = (iframe) => {
    iframe.style.removeProperty("width");
    iframe.style.removeProperty("height");
    iframe.style.removeProperty("max-width");
};

/**
 * iframe の大きさを、その iframe を書いているノートの <iframe> タグへ保存する
 * @returns {Promise<boolean>} 書き換えられたか
 **/
const saveIframeSize = async (iframe, size) => {
    const src = iframe.getAttribute("src");
    if (!src) return false;
    let found = false;
    try {
        const saved = await rewriteEmbedLinkInNote(iframe, (content, hintOffset) => {
            const edit = findIframeSizeEdit(content, src, size, hintOffset);
            if (edit) found = true;
            return edit;
        });
        if (saved && !found) new Notice("ノート本文にこの iframe が見つからないため、大きさを保存できませんでした", 3000);
        return saved && found;
    } catch (error) {
        console.error("Failed to save iframe size:", error);
        return false;
    }
};

let iframeResizeObserver = null;
const iframeHandlePositioners = new WeakMap();

// 右下のハンドルの位置を、iframe の右下隅へ合わせる
const getIframeResizeObserver = () => {
    if (iframeResizeObserver || typeof ResizeObserver !== "function") return iframeResizeObserver;
    window._customIframeResizeObserver?.disconnect?.();
    iframeResizeObserver = new ResizeObserver((entries) => {
        entries.forEach((entry) => iframeHandlePositioners.get(entry.target)?.());
    });
    window._customIframeResizeObserver = iframeResizeObserver;
    return iframeResizeObserver;
};

/**
 * iframe の右下に、縦横比を保ったままドラッグで大きさを変えるハンドルを付ける
 **/
const setupIframeResizeHandle = (iframe) => {
    const host = iframe?.parentElement;
    if (!host || iframeHandlePositioners.has(iframe)) return;
    const doc = iframe.ownerDocument;

    const handle = doc.createElement("div");
    handle.className = "custom-iframe-resizer-handle";
    handle.title = "ドラッグして枠の大きさを変更（Shift で縦横比を固定） / ダブルクリックで元のサイズにリセット";
    host.classList.add("custom-iframe-resize-host");
    host.appendChild(handle);

    const positionHandle = () => {
        if (!iframe.isConnected || !handle.isConnected) return;
        handle.style.left = `${iframe.offsetLeft + iframe.offsetWidth - handle.offsetWidth}px`;
        handle.style.top = `${iframe.offsetTop + iframe.offsetHeight - handle.offsetHeight}px`;
    };
    iframeHandlePositioners.set(iframe, positionHandle);
    getIframeResizeObserver()?.observe(iframe);
    positionHandle();

    let drag = null;
    let tooltipEl = null;

    const measure = (e) => {
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        // 幅と高さは別々に変える。Shift を押している間は、対角方向の移動量を幅の増減にして縦横比を保つ。
        const size = e.shiftKey
            ? computeIframeSize(drag.startWidth + (dx + dy * drag.ratio) / 2, drag.ratio, drag.maxWidth)
            : computeFreeIframeSize(drag.startWidth + dx, drag.startHeight + dy, drag.maxWidth);
        return { size, moved: Math.abs(dx) >= 3 || Math.abs(dy) >= 3 };
    };

    const onMouseMove = (e) => {
        if (!drag) return;
        e.preventDefault();
        e.stopPropagation();
        const { size } = measure(e);
        applyIframeLiveSize(iframe, size);
        positionHandle();
        if (tooltipEl) {
            tooltipEl.textContent = `${size.width} × ${size.height}px`;
            tooltipEl.style.left = `${e.clientX + 12}px`;
            tooltipEl.style.top = `${e.clientY - 28}px`;
        }
    };

    const onMouseUp = async (e) => {
        if (!drag) return;
        const { size, moved } = measure(e);
        drag = null;
        handle.classList.remove("is-resizing");
        doc.body.classList.remove(IFRAME_DRAGGING_CLASS);
        doc.body.style.cursor = "";
        doc.body.style.userSelect = "";
        tooltipEl?.remove();
        tooltipEl = null;
        doc.removeEventListener("mousemove", onMouseMove, true);
        doc.removeEventListener("mouseup", onMouseUp, true);
        // 動かさずに離した場合（クリック・ダブルクリック）は保存しない。保存すると iframe が読み込み直されるため。
        if (!moved) return;
        if (await saveIframeSize(iframe, toIframeSizeAttributes(size))) {
            new Notice(`iframe の大きさを ${size.width} × ${size.height}px に変更しました`, 1500);
        }
    };

    handle.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();

        const rect = iframe.getBoundingClientRect();
        drag = {
            startX: e.clientX,
            startY: e.clientY,
            startWidth: rect.width,
            startHeight: rect.height,
            ratio: getIframeRatio(iframe),
            maxWidth: getIframeMaxWidth(iframe),
        };
        handle.classList.add("is-resizing");
        // ドラッグ中にマウスが iframe の上へ出ても、iframe に操作を奪われないようにする
        doc.body.classList.add(IFRAME_DRAGGING_CLASS);
        doc.body.style.cursor = "nwse-resize";
        doc.body.style.userSelect = "none";

        tooltipEl = doc.createElement("div");
        tooltipEl.className = "custom-image-resize-tooltip";
        tooltipEl.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}px`;
        doc.body.appendChild(tooltipEl);

        doc.addEventListener("mousemove", onMouseMove, true);
        doc.addEventListener("mouseup", onMouseUp, true);
    }, true);

    handle.addEventListener("dblclick", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
        clearIframeLiveSize(iframe);
        if (await saveIframeSize(iframe, { width: IFRAME_DEFAULT_WIDTH, height: IFRAME_DEFAULT_HEIGHT })) {
            new Notice("iframe の大きさを初期状態にリセットしました", 1500);
        }
    }, true);
};

/**
 * Markdownビュー内の <iframe> にリサイズハンドルを付ける
 **/
const applyIframeEmbeds = (root = document) => {
    const iframes = [];
    if (root.matches?.("iframe")) iframes.push(root);
    root.querySelectorAll?.("iframe").forEach((element) => iframes.push(element));
    iframes.forEach((iframe) => {
        if (!iframe.closest?.(".markdown-source-view, .markdown-preview-view")) return;
        if (iframe.closest?.(IFRAME_IGNORED_SELECTOR)) return;
        if (!iframe.getAttribute?.("src")) return;
        applyImageIframeViewer(iframe);
        setupIframeResizeHandle(iframe);
    });
};

// =============================================================================
// 画像の iframe（src が画像）: Option + ホイールで画像を拡大縮小する
// =============================================================================
// iframe の src が画像の場合、ブラウザの画像表示は枠に合わせて縮小して表示するだけで、倍率を変えられない。
// そこで iframe の中を、画像だけを置いた自前の文書（srcdoc）に差し替える。srcdoc の文書は親と同じ
// オリジンのため、ノート側から中のホイールを受け取り、画像の倍率（CSS の zoom）を変えられる。
// ノート本文の src は変えず、倍率は <iframe> の data-zoom 属性へ保存する。

const isImageIframeSrc = (src) => IFRAME_IMAGE_SRC_PATTERN.test(String(src ?? "").trim());

const escapeIframeSrcdocAttribute = (value) => String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// 画像だけを実寸で置いた文書。referrer を送らないのは、画像の配信元が外部サイトからの表示を拒否することがあるため
const buildImageViewerSrcdoc = (src) =>
    '<!doctype html><html data-custom-image-viewer><head><meta charset="utf-8">' +
    "<style>html,body{margin:0;}img{display:block;max-width:none;}</style></head>" +
    `<body><img src="${escapeIframeSrcdocAttribute(src)}" referrerpolicy="no-referrer"></body></html>`;

const clampIframeImageZoom = (zoom) => Math.min(IFRAME_IMAGE_MAX_ZOOM, Math.max(IFRAME_IMAGE_MIN_ZOOM, zoom));

const readIframeImageZoom = (iframe) => {
    const zoom = parseFloat(iframe.getAttribute(IFRAME_ZOOM_ATTRIBUTE));
    return Number.isFinite(zoom) && zoom > 0 ? clampIframeImageZoom(zoom) : 1;
};

const getWheelDelta = (event) => (event.deltaY || event.deltaX || 0) * (event.deltaMode === 1 ? 16 : 1);

// 画像の iframe ごとの状態（倍率、中の画像、保存の予約）
const iframeImageViewerStates = new WeakMap();

/**
 * 画像の iframe の倍率を変える（ポインターの下の画像上の点が動かないよう、スクロール位置も合わせる）
 * 見た目はすぐ変え、ホイールが止まってからノートへ保存する。
 * @param {number} delta ホイールの移動量（マイナスで拡大）
 * @param {number} x ポインターの位置（iframe の表示領域の左上が原点）
 * @param {number} y
 **/
const zoomIframeImage = (iframe, delta, x, y) => {
    const state = iframeImageViewerStates.get(iframe);
    if (!state?.img || !delta) return;
    const zoom = clampIframeImageZoom(state.zoom * Math.exp(-delta * IFRAME_WHEEL_ZOOM_SPEED));
    if (zoom === state.zoom) return;

    const scroller = state.img.ownerDocument.scrollingElement || state.img.ownerDocument.documentElement;
    const pointX = (scroller.scrollLeft + x) / state.zoom;
    const pointY = (scroller.scrollTop + y) / state.zoom;
    state.img.style.zoom = String(zoom);
    state.zoom = zoom;
    scroller.scrollLeft = pointX * zoom - x;
    scroller.scrollTop = pointY * zoom - y;

    if (state.timer) globalThis.clearTimeout(state.timer);
    state.timer = globalThis.setTimeout(async () => {
        state.timer = null;
        await saveIframeSize(iframe, { [IFRAME_ZOOM_ATTRIBUTE]: Number(state.zoom.toFixed(2)) });
    }, IFRAME_WHEEL_SAVE_DELAY_MS);
};

/**
 * src が画像の iframe を、画像だけを表示する文書に差し替え、Option + ホイールでの拡大縮小を有効にする
 **/
const applyImageIframeViewer = (iframe) => {
    if (iframeImageViewerStates.has(iframe) || !isImageIframeSrc(iframe.getAttribute("src"))) return;
    const state = { zoom: readIframeImageZoom(iframe), img: null, timer: null };
    iframeImageViewerStates.set(iframe, state);
    iframe.classList.add(IFRAME_IMAGE_VIEWER_CLASS);

    iframe.addEventListener("load", () => {
        try {
            const doc = iframe.contentDocument;
            // 差し替える前の画像表示の文書（これも img を持つ）は対象にしない
            if (!doc?.documentElement?.hasAttribute("data-custom-image-viewer")) return;
            const img = doc.querySelector("img");
            if (!img) return;
            state.img = img;
            img.style.zoom = String(state.zoom);
            doc.addEventListener("wheel", (event) => {
                if (!event.altKey || event.ctrlKey || event.metaKey) return;
                event.preventDefault();
                zoomIframeImage(iframe, getWheelDelta(event), event.clientX, event.clientY);
            }, { passive: false });
        } catch (error) {
            console.warn("Failed to set up the image iframe viewer:", error);
        }
    });
    iframe.srcdoc = buildImageViewerSrcdoc(iframe.getAttribute("src"));
};

// ホイール操作の途中経過（iframe ごと）。保存するまで、操作を始めたときの縦横比と幅を持ち続ける。
const iframeWheelZoomStates = new WeakMap();

// ポインターの位置にある、このノートの <iframe> を探す（Option を押している間は iframe のマウス操作が無効のため、
// イベントの対象は iframe の外側の要素になる）
const findIframeAtPoint = (event) => {
    const doc = event.target?.ownerDocument || document;
    return Array.from(doc.querySelectorAll(IFRAME_SELECTOR)).find((iframe) => {
        if (iframe.closest(IFRAME_IGNORED_SELECTOR) || !iframe.getAttribute("src")) return false;
        const rect = iframe.getBoundingClientRect();
        return event.clientX >= rect.left && event.clientX <= rect.right
            && event.clientY >= rect.top && event.clientY <= rect.bottom;
    }) || null;
};

/**
 * Option + ホイールで iframe の枠を拡大縮小する（縦横比は固定。画像の iframe は画像側で拡大縮小する）
 * 見た目はすぐ変え、ホイールが止まってからノートへ保存する。
 **/
const handleIframeWheelZoom = (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    const iframe = findIframeAtPoint(event);
    // 画像の iframe は、中の文書がホイールを受け取って画像を拡大縮小する（枠は変えない）
    if (!iframe || iframe.classList.contains(IFRAME_IMAGE_VIEWER_CLASS)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

    const delta = getWheelDelta(event);
    if (!delta) return;

    let state = iframeWheelZoomStates.get(iframe);
    if (!state) {
        state = { ratio: getIframeRatio(iframe), width: iframe.getBoundingClientRect().width, size: null, timer: null };
        iframeWheelZoomStates.set(iframe, state);
    }
    state.width = Math.max(1, state.width * Math.exp(-delta * IFRAME_WHEEL_ZOOM_SPEED));
    const size = computeIframeSize(state.width, state.ratio, getIframeMaxWidth(iframe));
    // 最小幅・親の幅で止まったあとに逆向きへ回したとき、すぐ戻り始めるよう、基準も収める
    state.width = size.width;
    state.size = size;
    applyIframeLiveSize(iframe, size);

    if (state.timer) globalThis.clearTimeout(state.timer);
    state.timer = globalThis.setTimeout(async () => {
        iframeWheelZoomStates.delete(iframe);
        await saveIframeSize(iframe, toIframeSizeAttributes(state.size));
    }, IFRAME_WHEEL_SAVE_DELAY_MS);
};

// Option を押している間だけ、iframe のマウス操作を無効にする（ホイールをノート側で受け取るため）。
// キー操作が iframe の中にフォーカスがあるときは届かないため、マウスの動きに付く Option の状態でも切り替える。
const syncIframeAltHeldClass = (event) => {
    const body = (event.target?.ownerDocument || document).body;
    if (!body) return;
    const held = Boolean(event.altKey);
    if (body.classList.contains(IFRAME_ALT_HELD_CLASS) !== held) body.classList.toggle(IFRAME_ALT_HELD_CLASS, held);
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
        if (element.closest?.(FIGURE_IGNORED_REGION_SELECTOR)) return;
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
        if (container.matches?.(".pdf-embed") || container.closest?.(FIGURE_IGNORED_REGION_SELECTOR)) return;
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
    applyIframeEmbeds(root);
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
    ".custom-figure-caption, .custom-image-resizer-handle, .custom-pdf-resizer-handle, .custom-iframe-resizer-handle, .custom-image-resize-tooltip";
// 図が現れる領域: Markdownの編集・閲覧ビュー、埋め込み、ホバープレビュー
const FIGURE_REGION_SELECTOR =
    `.markdown-source-view, .markdown-preview-view, .popover, ${FIGURE_CONTAINER_SELECTOR}`;
// 自前で描画・リサイズを管理しており、図のキャプション処理の対象外の領域
// （CAD Viewer の埋め込み、Excalidraw の描画画面。描画画面の中のノート埋め込みにハンドルを付けない）
const FIGURE_IGNORED_REGION_SELECTOR = ".step-viewer-embed-wrapper, .workspace-leaf-content[data-type='excalidraw']";

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

// =============================================================================
// Excalidraw 図の変更をノート内の埋め込みへ反映する
// =============================================================================
// Excalidraw プラグインは、自身の描画画面で保存したとき・その画面を離れたときにしか埋め込みを描き直さない。
// Web アプリ（localhost:3001）など Obsidian の外で図のファイルを書き換えた場合も表示へ反映されるよう、
// ファイルの変更（vault の modify）を契機に、プラグインと同じ再描画イベントを埋め込みへ送る。

// Excalidraw プラグインが埋め込み画像（.excalidraw-embedded-img）で受け取る再描画イベント（プラグイン内の RERENDER_EVENT）
const EXCALIDRAW_EMBED_RERENDER_EVENT = "excalidraw-embed-rerender";
// 保存が続けて起きた場合に、まとめて1回だけ描き直すための待ち時間
const EXCALIDRAW_EMBED_REFRESH_DELAY_MS = 300;

const isExcalidrawDrawingFile = (file) =>
    file?.extension === "excalidraw" || isExcalidrawBackedMarkdown(file);

// 図のデータ部分（`# Excalidraw Data` 以降）。Excalidraw データを持つノートで本文だけを書き換えた場合に、描き直さないための比較用。
const getExcalidrawDrawingData = (text) => {
    const index = text.indexOf("# Excalidraw Data");
    return index >= 0 ? text.slice(index) : text;
};

// 開いている全ウィンドウ（メインとポップアウト）の document
const getOpenWindowDocuments = () => {
    const documents = new Set([document]);
    app.workspace.iterateAllLeaves?.((leaf) => {
        const ownerDocument = leaf?.view?.containerEl?.ownerDocument;
        if (ownerDocument) documents.add(ownerDocument);
    });
    return Array.from(documents);
};

// 指定した図の埋め込みへ再描画イベントを送り、送った数を返す。
const rerenderExcalidrawEmbeds = (filePath) => {
    let count = 0;
    getOpenWindowDocuments().forEach((ownerDocument) => {
        ownerDocument.querySelectorAll(".excalidraw-embedded-img[filesource]").forEach((element) => {
            // fileSource は「パス#見出し」の形のことがある。
            const source = (element.getAttribute("fileSource") || "").split("#")[0];
            if (source !== filePath) return;
            const EventClass = ownerDocument.defaultView?.CustomEvent || CustomEvent;
            element.dispatchEvent(new EventClass(EXCALIDRAW_EMBED_RERENDER_EVENT, { bubbles: true, cancelable: false }));
            count++;
        });
    });
    return count;
};

// 図のファイルが変更されたら、図のデータが前回と変わっている場合だけ埋め込みを描き直す。
const handleExcalidrawFileModify = (file) => {
    if (!isExcalidrawDrawingFile(file)) return;
    const timers = window._customExcalidrawEmbedRefreshTimers ||= new Map();
    globalThis.clearTimeout(timers.get(file.path));
    timers.set(file.path, globalThis.setTimeout(async () => {
        timers.delete(file.path);
        const drawingData = window._customExcalidrawDrawingData ||= new Map();
        try {
            const data = getExcalidrawDrawingData(await app.vault.cachedRead(file));
            if (drawingData.get(file.path) === data) return;
            drawingData.set(file.path, data);
        } catch (error) {
            console.warn("Failed to read Excalidraw drawing for embed refresh.", error);
        }
        rerenderExcalidrawEmbeds(file.path);
    }, EXCALIDRAW_EMBED_REFRESH_DELAY_MS));
};
